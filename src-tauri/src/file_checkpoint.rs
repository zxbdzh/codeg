//! 与代理无关的工作区检查点：显式启用、内容寻址、预览后恢复与可校验的撤销。

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::db::service::{folder_service, research_branch_service};
use crate::db::AppDatabase;

const MAX_FILES: usize = 5_000;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_BYTES: u64 = 100 * 1024 * 1024;
const MAX_CHECKPOINTS: usize = 50;
const MAX_STORE_BYTES: u64 = 500 * 1024 * 1024;

type Result<T> = std::result::Result<T, AppCommandError>;

pub fn admission_gate() -> &'static Arc<RwLock<()>> {
    static GATE: OnceLock<Arc<RwLock<()>>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(RwLock::new(())))
}

fn invalid(message: impl Into<String>) -> AppCommandError {
    AppCommandError::invalid_input(message)
}

fn conflict(message: impl Into<String>) -> AppCommandError {
    AppCommandError::already_exists(message)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn id(value: &str) -> Result<&str> {
    uuid::Uuid::parse_str(value).map_err(|_| invalid("Invalid checkpoint identifier"))?;
    Ok(value)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct FileState {
    hash: String,
    executable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    pub id: String,
    pub created_at: String,
    pub label: String,
    pub conversation_id: i32,
    pub file_count: usize,
    pub bytes: u64,
}

#[derive(Deserialize, Serialize)]
struct Checkpoint {
    info: CheckpointInfo,
    files: BTreeMap<String, FileState>,
}

#[derive(Default, Deserialize, Serialize)]
struct Config {
    enabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct Change {
    path: String,
    before: Option<FileState>,
    after: Option<FileState>,
}

#[derive(Deserialize, Serialize)]
struct Plan {
    id: String,
    checkpoint_id: String,
    created_at: i64,
    changes: Vec<Change>,
}

#[derive(Deserialize, Serialize)]
struct Journal {
    id: String,
    status: String,
    changes: Vec<Change>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEntry {
    path: String,
    change: &'static str,
    before_text: Option<String>,
    after_text: Option<String>,
    binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    id: String,
    checkpoint_id: String,
    entries: Vec<PreviewEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    enabled: bool,
    root: String,
    checkpoints: Vec<CheckpointInfo>,
    last_restore_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plan: Option<Preview>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub conversation_id: i32,
    pub action: String,
    pub checkpoint_id: Option<String>,
    pub plan_id: Option<String>,
    pub paths: Option<Vec<String>>,
}

struct Store {
    root: PathBuf,
    path: PathBuf,
    _lock: File,
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn executable(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    }
}

fn root_path(root: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(root).map_err(AppCommandError::io)?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(invalid("Checkpoint root must be a real directory"));
    }
    let root = root.canonicalize().map_err(AppCommandError::io)?;
    if root.parent().is_none() {
        return Err(invalid("A filesystem root cannot be checkpointed"));
    }
    Ok(root)
}

fn storage_path(data_dir: &Path, root: &Path) -> PathBuf {
    let name = root.to_string_lossy();
    let normalized = if cfg!(windows) {
        name.to_lowercase()
    } else {
        name.into_owned()
    };
    data_dir
        .join("file-checkpoints")
        .join(digest(normalized.as_bytes()))
}

fn relative_path(root: &Path, value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.contains(['\\', ':', '\0']) {
        return Err(invalid("Unsafe checkpoint path"));
    }
    let path = Path::new(value);
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err(invalid("Checkpoint path must stay inside its workspace"));
        };
        let text = name.to_string_lossy();
        if text.starts_with('.') || text.ends_with(['.', ' ']) {
            return Err(invalid(
                "Hidden and special paths are outside checkpoint scope",
            ));
        }
        let stem = text
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err(invalid(
                "Reserved device names are outside checkpoint scope",
            ));
        }
    }
    let destination = root.join(path);
    let mut cursor = root.to_path_buf();
    for component in path.components() {
        cursor.push(component);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if is_link(&metadata) => {
                return Err(invalid(format!(
                    "Checkpoint path traverses a link: {value}"
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(AppCommandError::io(error)),
        }
    }
    Ok(destination)
}

fn json_read<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let file = File::open(path).map_err(AppCommandError::io)?;
    if file.metadata().map_err(AppCommandError::io)?.len() > 8 * 1024 * 1024 {
        return Err(invalid("Checkpoint metadata exceeds its size limit"));
    }
    serde_json::from_reader(file).map_err(|error| invalid(error.to_string()))
}

fn json_write(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Missing metadata parent"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(AppCommandError::io)?;
    serde_json::to_writer(temporary.as_file_mut(), value)
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(AppCommandError::io)?;
    temporary
        .persist(path)
        .map_err(|error| AppCommandError::io(error.error))?;
    Ok(())
}

impl Store {
    fn open(data_dir: &Path, root: &Path) -> Result<Self> {
        let root = root_path(root)?;
        let data_dir = data_dir.canonicalize().map_err(AppCommandError::io)?;
        let path = storage_path(&data_dir, &root);
        if path.starts_with(&root) {
            return Err(invalid("Checkpoint storage must be outside the workspace"));
        }
        for directory in [data_dir.join("file-checkpoints"), path.clone()] {
            if let Ok(metadata) = fs::symlink_metadata(directory) {
                if is_link(&metadata) {
                    return Err(invalid("Checkpoint storage cannot traverse a link"));
                }
            }
        }
        for directory in ["blobs", "snapshots", "plans"] {
            fs::create_dir_all(path.join(directory)).map_err(AppCommandError::io)?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.join("operation.lock"))
            .map_err(AppCommandError::io)?;
        lock.try_lock()
            .map_err(|_| conflict("Another checkpoint operation is running"))?;
        let recorded = path.join("root.json");
        if recorded.exists() {
            let existing: String = json_read(&recorded)?;
            if existing != root.to_string_lossy() {
                return Err(invalid("Checkpoint workspace identity changed"));
            }
        } else {
            json_write(&recorded, &root.to_string_lossy())?;
        }
        Ok(Self {
            root,
            path,
            _lock: lock,
        })
    }

    fn config(&self) -> Result<Config> {
        let path = self.path.join("config.json");
        if path.exists() {
            json_read(&path)
        } else {
            Ok(Config::default())
        }
    }

    fn checkpoint_path(&self, value: &str) -> Result<PathBuf> {
        Ok(self
            .path
            .join("snapshots")
            .join(format!("{}.json", id(value)?)))
    }

    fn plan_path(&self, value: &str) -> Result<PathBuf> {
        Ok(self.path.join("plans").join(format!("{}.json", id(value)?)))
    }

    fn blob(&self, hash: &str) -> Result<PathBuf> {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid("Invalid checkpoint content hash"));
        }
        Ok(self.path.join("blobs").join(hash))
    }

    fn content(&self, state: &FileState) -> Result<Vec<u8>> {
        let file = File::open(self.blob(&state.hash)?).map_err(AppCommandError::io)?;
        let mut bytes = Vec::new();
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(AppCommandError::io)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid("Checkpoint content exceeds its size limit"));
        }
        if digest(&bytes) != state.hash {
            return Err(invalid(
                "Checkpoint content is damaged; refusing to restore",
            ));
        }
        Ok(bytes)
    }

    fn save_content(&self, bytes: &[u8]) -> Result<String> {
        let hash = digest(bytes);
        let path = self.blob(&hash)?;
        if !path.exists() {
            let mut temporary = tempfile::NamedTempFile::new_in(self.path.join("blobs"))
                .map_err(AppCommandError::io)?;
            temporary.write_all(bytes).map_err(AppCommandError::io)?;
            temporary
                .as_file()
                .sync_all()
                .map_err(AppCommandError::io)?;
            temporary
                .persist(path)
                .map_err(|error| AppCommandError::io(error.error))?;
        }
        Ok(hash)
    }

    fn read_file(&self, name: &str, save: bool) -> Result<Option<FileState>> {
        let path = relative_path(&self.root, name)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(AppCommandError::io(error)),
        };
        if !metadata.is_file() || is_link(&metadata) || metadata.len() > MAX_FILE_BYTES {
            return Err(invalid(format!("Not a supported checkpoint file: {name}")));
        }
        let mut file = File::open(&path).map_err(AppCommandError::io)?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(AppCommandError::io)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid(format!(
                "File grew beyond checkpoint limit: {name}"
            )));
        }
        let hash = if save {
            self.save_content(&bytes)?
        } else {
            digest(&bytes)
        };
        Ok(Some(FileState {
            hash,
            executable: executable(&metadata),
        }))
    }

    fn scan(&self) -> Result<(BTreeMap<String, FileState>, u64)> {
        let started = Instant::now();
        let mut files = BTreeMap::new();
        let mut bytes = 0;
        // 单线程、限时、保留忽略规则；生成目录和链接不进入快照，避免复制依赖与秘密目录。
        let mut builder = ignore::WalkBuilder::new(&self.root);
        builder
            .hidden(true)
            .parents(false)
            .require_git(false)
            .follow_links(false)
            .filter_entry(|entry| {
                !matches!(
                    entry.file_name().to_str(),
                    Some(
                        "node_modules"
                            | "vendor"
                            | "venv"
                            | "__pycache__"
                            | "dist"
                            | "build"
                            | "target"
                            | "coverage"
                    )
                )
            });
        let mut visited = 0;
        for entry in builder.build() {
            visited += 1;
            if started.elapsed() > Duration::from_secs(10) || visited > 20_000 {
                return Err(invalid(
                    "Checkpoint scan exceeded its limit; reduce workspace scope",
                ));
            }
            let entry = entry.map_err(|error| invalid(error.to_string()))?;
            if entry.depth() == 0 {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(AppCommandError::io)?;
            if is_link(&metadata) || !metadata.is_file() {
                continue;
            }
            if metadata.len() > MAX_FILE_BYTES {
                return Err(invalid(
                    "A file exceeds 5 MiB; exclude it with .gitignore before enabling checkpoints",
                ));
            }
            bytes += metadata.len();
            if files.len() >= MAX_FILES || bytes > MAX_BYTES {
                return Err(invalid(
                    "Checkpoint exceeds 5000 files / 100 MiB; reduce workspace scope",
                ));
            }
            let name = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|_| invalid("Checkpoint path escaped its workspace"))?
                .to_str()
                .ok_or_else(|| invalid("Checkpoint paths must be UTF-8"))?
                .replace('\\', "/");
            let state = self.read_file(&name, true)?.ok_or_else(|| {
                conflict("A file disappeared during checkpoint capture; retry when idle")
            })?;
            files.insert(name, state);
        }
        Ok((files, bytes))
    }

    fn infos(&self) -> Result<Vec<CheckpointInfo>> {
        let mut checkpoints = Vec::new();
        for entry in fs::read_dir(self.path.join("snapshots")).map_err(AppCommandError::io)? {
            let entry = entry.map_err(AppCommandError::io)?;
            if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let checkpoint: Checkpoint = json_read(&entry.path())?;
            checkpoints.push(checkpoint.info);
        }
        checkpoints.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(checkpoints)
    }

    fn journal(&self) -> Result<Option<Journal>> {
        let path = self.path.join("last-restore.json");
        if path.exists() {
            Ok(Some(json_read(&path)?))
        } else {
            Ok(None)
        }
    }

    fn no_pending_restore(&self) -> Result<()> {
        if self
            .journal()?
            .is_some_and(|journal| journal.status != "applied")
        {
            return Err(conflict(
                "An interrupted restore needs undo/recovery before another operation",
            ));
        }
        Ok(())
    }

    fn collect_unused(&self) -> Result<()> {
        let mut referenced = BTreeSet::new();
        for entry in fs::read_dir(self.path.join("snapshots")).map_err(AppCommandError::io)? {
            let entry = entry.map_err(AppCommandError::io)?;
            if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let checkpoint: Checkpoint = json_read(&entry.path())?;
            referenced.extend(checkpoint.files.values().map(|state| state.hash.clone()));
        }
        let now = chrono::Utc::now().timestamp();
        for entry in fs::read_dir(self.path.join("plans")).map_err(AppCommandError::io)? {
            let entry = entry.map_err(AppCommandError::io)?;
            if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let plan: Plan = json_read(&entry.path())?;
            if now - plan.created_at > 15 * 60 {
                fs::remove_file(entry.path()).map_err(AppCommandError::io)?;
                continue;
            }
            for change in plan.changes {
                referenced.extend(
                    [change.before, change.after]
                        .into_iter()
                        .flatten()
                        .map(|state| state.hash),
                );
            }
        }
        if let Some(journal) = self.journal()? {
            for change in journal.changes {
                referenced.extend(
                    [change.before, change.after]
                        .into_iter()
                        .flatten()
                        .map(|state| state.hash),
                );
            }
        }
        for entry in fs::read_dir(self.path.join("blobs")).map_err(AppCommandError::io)? {
            let entry = entry.map_err(AppCommandError::io)?;
            if !referenced.contains(entry.file_name().to_string_lossy().as_ref()) {
                fs::remove_file(entry.path()).map_err(AppCommandError::io)?;
            }
        }
        Ok(())
    }

    fn capture(&self, conversation_id: i32, label: String) -> Result<()> {
        self.no_pending_restore()?;
        if self.infos()?.len() >= MAX_CHECKPOINTS {
            return Err(invalid(
                "50 checkpoints retained; delete an older checkpoint to continue",
            ));
        }
        let stored = fs::read_dir(self.path.join("blobs"))
            .map_err(AppCommandError::io)?
            .try_fold(0u64, |total, entry| {
                Ok::<_, std::io::Error>(total + entry?.metadata()?.len())
            })
            .map_err(AppCommandError::io)?;
        if stored >= MAX_STORE_BYTES {
            return Err(invalid(
                "Checkpoint storage reached 500 MiB; delete older checkpoints",
            ));
        }
        let (files, bytes) = self.scan()?;
        let stored = fs::read_dir(self.path.join("blobs"))
            .map_err(AppCommandError::io)?
            .try_fold(0u64, |total, entry| {
                Ok::<_, std::io::Error>(total + entry?.metadata()?.len())
            })
            .map_err(AppCommandError::io)?;
        if stored > MAX_STORE_BYTES {
            return Err(invalid(
                "Checkpoint would exceed 500 MiB; delete older checkpoints",
            ));
        }
        // 再读一次全部纳入文件，避免把扫描过程中的半成品错误标记为某个发送边界。
        for (name, state) in &files {
            if self.read_file(name, false)?.as_ref() != Some(state) {
                return Err(conflict(
                    "Workspace changed during checkpoint capture; retry when idle",
                ));
            }
        }
        let checkpoint = Checkpoint {
            info: CheckpointInfo {
                id: uuid::Uuid::new_v4().to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                label,
                conversation_id,
                file_count: files.len(),
                bytes,
            },
            files,
        };
        json_write(&self.checkpoint_path(&checkpoint.info.id)?, &checkpoint)
    }

    fn preview(&self, checkpoint_id: &str) -> Result<Plan> {
        self.no_pending_restore()?;
        let checkpoint: Checkpoint = json_read(&self.checkpoint_path(checkpoint_id)?)?;
        let (current, _) = self.scan()?;
        let names: BTreeSet<_> = current
            .keys()
            .chain(checkpoint.files.keys())
            .cloned()
            .collect();
        let mut changes = Vec::new();
        for name in names {
            let before = current.get(&name).cloned();
            let after = checkpoint.files.get(&name).cloned();
            // 忽略规则变更可能让原快照文件离开范围，不能把“未扫描”误当作“已删除”。
            if self.read_file(&name, true)? != before {
                return Err(conflict(
                    "Workspace scope changed; refresh the preview before restoring",
                ));
            }
            if before != after {
                changes.push(Change {
                    path: name,
                    before,
                    after,
                });
            }
        }
        Ok(Plan {
            id: uuid::Uuid::new_v4().to_string(),
            checkpoint_id: checkpoint_id.into(),
            created_at: chrono::Utc::now().timestamp(),
            changes,
        })
    }

    fn undo(&self, journal_id: &str) -> Result<Plan> {
        let journal = self
            .journal()?
            .ok_or_else(|| invalid("No restore to undo"))?;
        if journal.id != journal_id {
            return Err(conflict("The latest restore changed; refresh"));
        }
        let mut changes = Vec::new();
        for change in journal.changes {
            let current = self.read_file(&change.path, true)?;
            if current == change.before {
                continue;
            }
            if current != change.after {
                return Err(conflict(format!(
                    "File changed after restore: {}; undo would overwrite newer work",
                    change.path
                )));
            }
            changes.push(Change {
                path: change.path,
                before: change.after,
                after: change.before,
            });
        }
        if changes.is_empty() && journal.status != "applied" {
            json_write(
                &self.path.join("last-restore.json"),
                &Journal {
                    id: journal_id.into(),
                    status: "applied".into(),
                    changes: Vec::new(),
                },
            )?;
        }
        Ok(Plan {
            id: uuid::Uuid::new_v4().to_string(),
            checkpoint_id: journal_id.into(),
            created_at: chrono::Utc::now().timestamp(),
            changes,
        })
    }

    fn plan_view(&self, plan: &Plan) -> Result<Preview> {
        let mut entries = Vec::new();
        for change in &plan.changes {
            let before = change
                .before
                .as_ref()
                .map(|state| self.content(state))
                .transpose()?;
            let after = change
                .after
                .as_ref()
                .map(|state| self.content(state))
                .transpose()?;
            let text = |bytes: &Option<Vec<u8>>| {
                bytes.as_ref().and_then(|bytes| {
                    if bytes.len() > 32_000 || bytes.contains(&0) {
                        return None;
                    }
                    std::str::from_utf8(bytes).ok().map(str::to_owned)
                })
            };
            let before_text = text(&before);
            let after_text = text(&after);
            let binary = (before.is_some() && before_text.is_none())
                || (after.is_some() && after_text.is_none());
            entries.push(PreviewEntry {
                path: change.path.clone(),
                change: if change.before.is_none() {
                    "added"
                } else if change.after.is_none() {
                    "deleted"
                } else {
                    "modified"
                },
                before_text,
                after_text,
                binary,
            });
        }
        Ok(Preview {
            id: plan.id.clone(),
            checkpoint_id: plan.checkpoint_id.clone(),
            entries,
        })
    }

    fn replace(&self, change: &Change) -> Result<()> {
        let destination = relative_path(&self.root, &change.path)?;
        if self.read_file(&change.path, false)? != change.before {
            return Err(conflict(format!(
                "File changed since preview: {}",
                change.path
            )));
        }
        if let Some(after) = &change.after {
            let bytes = self.content(after)?;
            let parent = destination
                .parent()
                .ok_or_else(|| invalid("Invalid target"))?;
            fs::create_dir_all(parent).map_err(AppCommandError::io)?;
            relative_path(&self.root, &change.path)?;
            let mut temporary =
                tempfile::NamedTempFile::new_in(parent).map_err(AppCommandError::io)?;
            temporary.write_all(&bytes).map_err(AppCommandError::io)?;
            if let Ok(metadata) = fs::metadata(&destination) {
                temporary
                    .as_file()
                    .set_permissions(metadata.permissions())
                    .map_err(AppCommandError::io)?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut permissions = temporary
                    .as_file()
                    .metadata()
                    .map_err(AppCommandError::io)?
                    .permissions();
                let mode = permissions.mode() & !0o111;
                permissions.set_mode(if after.executable { mode | 0o111 } else { mode });
                temporary
                    .as_file()
                    .set_permissions(permissions)
                    .map_err(AppCommandError::io)?;
            }
            temporary
                .as_file()
                .sync_all()
                .map_err(AppCommandError::io)?;
            if self.read_file(&change.path, false)? != change.before {
                return Err(conflict(format!(
                    "File changed during restore: {}",
                    change.path
                )));
            }
            temporary
                .persist(destination)
                .map_err(|error| AppCommandError::io(error.error))?;
        } else {
            fs::remove_file(destination).map_err(AppCommandError::io)?;
        }
        Ok(())
    }

    fn apply(&self, plan_id: &str, paths: &[String]) -> Result<()> {
        let plan: Plan = json_read(&self.plan_path(plan_id)?)?;
        if let Some(journal) = self.journal()? {
            if journal.status != "applied" {
                if plan.checkpoint_id != journal.id {
                    return Err(conflict(
                        "Recover the interrupted restore before applying another preview",
                    ));
                }
                // 中断恢复必须覆盖反向计划的全部文件，否则会丢失未选文件的恢复日志。
                if paths.len() != plan.changes.len() {
                    return Err(invalid(
                        "Select every file to recover an interrupted restore",
                    ));
                }
            }
        }
        if chrono::Utc::now().timestamp() - plan.created_at > 15 * 60 {
            return Err(conflict("Restore preview expired; generate it again"));
        }
        let selected: BTreeSet<_> = paths.iter().collect();
        if selected.is_empty()
            || selected.len() != paths.len()
            || selected
                .iter()
                .any(|path| !plan.changes.iter().any(|change| &change.path == *path))
        {
            return Err(invalid(
                "Choose a nonempty set of files from this restore preview",
            ));
        }
        let changes: Vec<_> = plan
            .changes
            .into_iter()
            .filter(|change| selected.contains(&change.path))
            .collect();
        // 先校验所有文件并验证备份，再动第一个文件，避免陈旧预览造成一半覆盖。
        for change in &changes {
            if self.read_file(&change.path, false)? != change.before {
                return Err(conflict(format!(
                    "File changed since preview: {}",
                    change.path
                )));
            }
            for state in [&change.before, &change.after].into_iter().flatten() {
                self.content(state)?;
            }
        }
        let mut journal = Journal {
            id: plan.id,
            status: "applying".into(),
            changes,
        };
        let journal_path = self.path.join("last-restore.json");
        json_write(&journal_path, &journal)?;
        for change in &journal.changes {
            if let Err(error) = self.replace(change) {
                journal.status = "interrupted".into();
                let _ = json_write(&journal_path, &journal);
                return Err(error);
            }
        }
        journal.status = "applied".into();
        json_write(&journal_path, &journal)?;
        let _ = fs::remove_file(self.plan_path(plan_id)?);
        Ok(())
    }

    fn response(&self, plan: Option<&Plan>) -> Result<Response> {
        Ok(Response {
            enabled: self.config()?.enabled,
            root: self.root.to_string_lossy().into_owned(),
            checkpoints: self.infos()?,
            last_restore_id: self.journal()?.map(|journal| journal.id),
            plan: plan.map(|plan| self.plan_view(plan)).transpose()?,
        })
    }
}

pub async fn ensure_idle(manager: &ConnectionManager, root: &Path) -> Result<()> {
    let states: Vec<_> = manager
        .connections
        .lock()
        .await
        .values()
        .map(|connection| connection.state.clone())
        .collect();
    for state in states {
        let state = state.read().await;
        let overlaps = state.working_dir.as_ref().is_some_and(|cwd| {
            let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.clone());
            cwd.starts_with(root) || root.starts_with(cwd)
        });
        if overlaps
            && (state.turn_in_flight
                || state.agent_initiated_turn
                || !state.active_tool_calls.is_empty()
                || state.background_outstanding > 0
                || !state.active_delegations.is_empty()
                || state
                    .async_tasks
                    .values()
                    .any(|task| !crate::acp::types::async_task_state_is_terminal(&task.state)))
        {
            return Err(AppCommandError::new(crate::app_error::AppErrorCode::TurnInProgress,
                "A conversation sharing this workspace is busy; wait before checkpointing or restoring"));
        }
    }
    Ok(())
}

pub async fn automatic(
    data_dir: PathBuf,
    root: PathBuf,
    conversation_id: i32,
    label: String,
    manager: &ConnectionManager,
) -> Result<()> {
    // 默认关闭时不限制现有发送路径；只有曾显式启用的目录才进入严格快照校验。
    let workspace = match root.canonicalize() {
        Ok(workspace) => workspace,
        Err(_) => return Ok(()),
    };
    let directory = data_dir.clone();
    let enabled = tokio::task::spawn_blocking(move || {
        let path = storage_path(&directory, &workspace).join("config.json");
        if path.exists() {
            json_read::<Config>(&path)
        } else {
            Ok(Config::default())
        }
    })
    .await
    .map_err(|error| invalid(error.to_string()))??
    .enabled;
    if !enabled {
        return Ok(());
    }
    let root = root_path(&root)?;
    ensure_idle(manager, &root).await?;
    tokio::task::spawn_blocking(move || {
        let store = Store::open(&data_dir, &root)?;
        store.collect_unused()?;
        store.capture(conversation_id, label)
    })
    .await
    .map_err(|error| invalid(error.to_string()))?
}

pub async fn run(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: Request,
) -> Result<Response> {
    let source = research_branch_service::live_conversation(&db.conn, request.conversation_id)
        .await
        .map_err(crate::research_branch::db_error)?;
    let folder = folder_service::get_folder_by_id(&db.conn, source.folder_id)
        .await
        .map_err(crate::research_branch::db_error)?
        .ok_or_else(|| invalid("Workspace folder no longer exists"))?;
    let root = root_path(Path::new(
        source.origin_cwd.as_deref().unwrap_or(&folder.path),
    ))?;
    let gate = admission_gate().clone();
    let _guard = gate.write_owned().await;
    if request.action != "list" && request.action != "disable" {
        ensure_idle(manager, &root).await?;
    }
    let data_dir = data_dir.to_path_buf();
    // 调用方断线后，恢复任务继续持有 gate，直至 journal 和文件状态一致。
    tokio::spawn(async move {
        let _guard = _guard;
        tokio::task::spawn_blocking(move || {
            let store = Store::open(&data_dir, &root)?;
            store.collect_unused()?;
            let mut plan = None;
            match request.action.as_str() {
                "list" => {}
                "enable" => {
                    store.capture(
                        request.conversation_id,
                        "Enabled: initial workspace baseline".into(),
                    )?;
                    json_write(&store.path.join("config.json"), &Config { enabled: true })?;
                }
                "disable" => {
                    json_write(&store.path.join("config.json"), &Config { enabled: false })?
                }
                "capture" => store.capture(request.conversation_id, "Manual checkpoint".into())?,
                "preview" => {
                    plan = Some(
                        store.preview(
                            request
                                .checkpoint_id
                                .as_deref()
                                .ok_or_else(|| invalid("Missing checkpointId"))?,
                        )?,
                    );
                }
                "undo" => {
                    plan = Some(
                        store.undo(
                            request
                                .plan_id
                                .as_deref()
                                .ok_or_else(|| invalid("Missing restore identifier"))?,
                        )?,
                    );
                }
                "apply" => store.apply(
                    request
                        .plan_id
                        .as_deref()
                        .ok_or_else(|| invalid("Missing planId"))?,
                    request
                        .paths
                        .as_deref()
                        .ok_or_else(|| invalid("Missing selected paths"))?,
                )?,
                "delete" => {
                    store.no_pending_restore()?;
                    fs::remove_file(
                        store.checkpoint_path(
                            request
                                .checkpoint_id
                                .as_deref()
                                .ok_or_else(|| invalid("Missing checkpointId"))?,
                        )?,
                    )
                    .map_err(AppCommandError::io)?;
                    store.collect_unused()?;
                }
                _ => return Err(invalid("Unknown checkpoint action")),
            }
            if let Some(plan) = &plan {
                let plans = fs::read_dir(store.path.join("plans"))
                    .map_err(AppCommandError::io)?
                    .try_fold(0usize, |count, entry| {
                        let entry = entry?;
                        Ok::<_, std::io::Error>(
                            count
                                + usize::from(
                                    entry.path().extension().and_then(|ext| ext.to_str())
                                        == Some("json"),
                                ),
                        )
                    })
                    .map_err(AppCommandError::io)?;
                if request.action == "preview" && plans >= 50 {
                    return Err(conflict(
                        "Too many active restore previews; wait for older previews to expire",
                    ));
                }
                json_write(&store.plan_path(&plan.id)?, plan)?;
            }
            store.response(plan.as_ref())
        })
        .await
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?
    })
    .await
    .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AgentType;
    use crate::web::event_bridge::EventEmitter;

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Store) {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(data.path(), root.path()).unwrap();
        (data, root, store)
    }

    fn save_plan(store: &Store, plan: &Plan) -> Vec<String> {
        json_write(&store.plan_path(&plan.id).unwrap(), plan).unwrap();
        plan.changes
            .iter()
            .map(|change| change.path.clone())
            .collect()
    }

    #[test]
    fn checkpoint_restores_modified_deleted_new_and_binary_files_then_undoes() {
        let (_data, root, store) = fixture();
        fs::write(root.path().join("existing.txt"), "original").unwrap();
        fs::write(root.path().join("removed.txt"), "return me").unwrap();
        fs::write(root.path().join("image.bin"), [0, 255, 12]).unwrap();
        store.capture(1, "baseline".into()).unwrap();
        let checkpoint = &store.infos().unwrap()[0].id;
        fs::write(root.path().join("existing.txt"), "newer").unwrap();
        fs::remove_file(root.path().join("removed.txt")).unwrap();
        fs::write(root.path().join("added.txt"), "created later").unwrap();
        fs::write(root.path().join("image.bin"), [0, 12]).unwrap();
        let plan = store.preview(checkpoint).unwrap();
        let view = store.plan_view(&plan).unwrap();
        assert_eq!(view.entries.len(), 4);
        assert!(view
            .entries
            .iter()
            .any(|entry| entry.path == "image.bin" && entry.binary));
        assert!(view
            .entries
            .iter()
            .any(|entry| entry.path == "added.txt" && entry.change == "deleted"));
        let paths = save_plan(&store, &plan);
        store.apply(&plan.id, &paths).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("existing.txt")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("removed.txt")).unwrap(),
            "return me"
        );
        assert_eq!(
            fs::read(root.path().join("image.bin")).unwrap(),
            [0, 255, 12]
        );
        assert!(!root.path().join("added.txt").exists());
        let undo = store.undo(&plan.id).unwrap();
        let paths = save_plan(&store, &undo);
        store.apply(&undo.id, &paths).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("existing.txt")).unwrap(),
            "newer"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("added.txt")).unwrap(),
            "created later"
        );
        assert!(!root.path().join("removed.txt").exists());
        assert_eq!(fs::read(root.path().join("image.bin")).unwrap(), [0, 12]);
    }

    #[test]
    fn checkpoint_stale_preview_rejects_before_any_file_is_overwritten() {
        let (_data, root, store) = fixture();
        for name in ["a.txt", "b.txt"] {
            fs::write(root.path().join(name), "original").unwrap();
        }
        store.capture(1, "before".into()).unwrap();
        let checkpoint = store.infos().unwrap()[0].id.clone();
        for name in ["a.txt", "b.txt"] {
            fs::write(root.path().join(name), "modified").unwrap();
        }
        let plan = store.preview(&checkpoint).unwrap();
        let paths = save_plan(&store, &plan);
        fs::write(root.path().join("b.txt"), "concurrent edit").unwrap();
        assert!(store.apply(&plan.id, &paths).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "modified"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("b.txt")).unwrap(),
            "concurrent edit"
        );
        assert!(store.journal().unwrap().is_none());
    }

    #[test]
    fn checkpoint_partial_selection_does_not_touch_other_changes_and_undo_checks_new_work() {
        let (_data, root, store) = fixture();
        for name in ["a.txt", "b.txt"] {
            fs::write(root.path().join(name), "original").unwrap();
        }
        store.capture(1, "before".into()).unwrap();
        let checkpoint = store.infos().unwrap()[0].id.clone();
        for name in ["a.txt", "b.txt"] {
            fs::write(root.path().join(name), "modified").unwrap();
        }
        let plan = store.preview(&checkpoint).unwrap();
        save_plan(&store, &plan);
        store.apply(&plan.id, &["a.txt".into()]).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("b.txt")).unwrap(),
            "modified"
        );
        fs::write(root.path().join("a.txt"), "newer work").unwrap();
        assert!(store.undo(&plan.id).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "newer work"
        );
    }

    #[test]
    fn checkpoint_ignored_hidden_and_generated_files_are_not_captured_or_restored() {
        let (_data, root, store) = fixture();
        fs::write(root.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.path().join("ignored.txt"), "private").unwrap();
        fs::write(root.path().join(".env"), "secret").unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(root.path().join("node_modules/dependency.js"), "generated").unwrap();
        fs::write(root.path().join("main.txt"), "saved").unwrap();
        store.capture(1, "before".into()).unwrap();
        let checkpoint = store.infos().unwrap()[0].id.clone();
        let saved: Checkpoint = json_read(&store.checkpoint_path(&checkpoint).unwrap()).unwrap();
        assert_eq!(saved.files.keys().collect::<Vec<_>>(), vec!["main.txt"]);
        fs::write(root.path().join("ignored.txt"), "changed ignored").unwrap();
        fs::write(root.path().join("main.txt"), "changed").unwrap();
        let plan = store.preview(&checkpoint).unwrap();
        let paths = save_plan(&store, &plan);
        store.apply(&plan.id, &paths).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("ignored.txt")).unwrap(),
            "changed ignored"
        );
        assert_eq!(
            fs::read_to_string(root.path().join(".env")).unwrap(),
            "secret"
        );
    }

    #[test]
    fn checkpoint_new_ignore_rule_is_not_mistaken_for_a_deleted_file() {
        let (_data, root, store) = fixture();
        fs::write(root.path().join("main.txt"), "saved").unwrap();
        store.capture(1, "before".into()).unwrap();
        let checkpoint = store.infos().unwrap()[0].id.clone();
        fs::write(root.path().join(".gitignore"), "main.txt\n").unwrap();
        assert!(store.preview(&checkpoint).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("main.txt")).unwrap(),
            "saved"
        );
    }

    #[test]
    fn checkpoint_invalid_paths_ids_content_and_oversized_files_fail_closed() {
        let (_data, root, store) = fixture();
        for path in [
            "../outside",
            "/outside",
            ".git/config",
            "dir/../file",
            "C:/outside",
            "dir\\file",
            "NUL",
        ] {
            assert!(relative_path(&store.root, path).is_err(), "{path}");
        }
        assert!(store.checkpoint_path("../outside").is_err());
        fs::write(root.path().join("main.txt"), "saved").unwrap();
        store.capture(1, "before".into()).unwrap();
        let checkpoint = store.infos().unwrap()[0].id.clone();
        fs::write(root.path().join("main.txt"), "changed").unwrap();
        let plan = store.preview(&checkpoint).unwrap();
        let paths = save_plan(&store, &plan);
        let state = plan.changes[0].after.as_ref().unwrap();
        fs::write(store.blob(&state.hash).unwrap(), "corrupted").unwrap();
        assert!(store.apply(&plan.id, &paths).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("main.txt")).unwrap(),
            "changed"
        );
        let large = File::create(root.path().join("large.dat")).unwrap();
        large.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(store.capture(1, "oversized".into()).is_err());
    }

    #[test]
    fn checkpoint_interrupted_restore_survives_reopen_and_only_undoes_applied_files() {
        let (data, root, store) = fixture();
        for name in ["a.txt", "b.txt"] {
            fs::write(root.path().join(name), "original").unwrap();
        }
        store.capture(1, "before".into()).unwrap();
        let checkpoint = store.infos().unwrap()[0].id.clone();
        for name in ["a.txt", "b.txt"] {
            fs::write(root.path().join(name), "modified").unwrap();
        }
        let plan = store.preview(&checkpoint).unwrap();
        json_write(
            &store.path.join("last-restore.json"),
            &Journal {
                id: plan.id.clone(),
                status: "applying".into(),
                changes: plan.changes.clone(),
            },
        )
        .unwrap();
        store.replace(&plan.changes[0]).unwrap();
        drop(store);
        let store = Store::open(data.path(), root.path()).unwrap();
        assert!(store.capture(1, "unsafe".into()).is_err());
        let undo = store.undo(&plan.id).unwrap();
        assert_eq!(undo.changes.len(), 1);
        let paths = save_plan(&store, &undo);
        store.apply(&undo.id, &paths).unwrap();
        for name in ["a.txt", "b.txt"] {
            assert_eq!(
                fs::read_to_string(root.path().join(name)).unwrap(),
                "modified"
            );
        }
        assert!(store.no_pending_restore().is_ok());
    }

    #[test]
    fn checkpoint_file_lock_and_gc_protect_live_snapshots_and_undo() {
        let (data, root, store) = fixture();
        assert!(Store::open(data.path(), root.path()).is_err());
        fs::write(root.path().join("main.txt"), "saved").unwrap();
        store.capture(1, "before".into()).unwrap();
        let checkpoint = store.infos().unwrap()[0].id.clone();
        fs::write(root.path().join("main.txt"), "changed").unwrap();
        let plan = store.preview(&checkpoint).unwrap();
        let paths = save_plan(&store, &plan);
        store.apply(&plan.id, &paths).unwrap();
        fs::remove_file(store.checkpoint_path(&checkpoint).unwrap()).unwrap();
        store.collect_unused().unwrap();
        let undo = store.undo(&plan.id).unwrap();
        let paths = save_plan(&store, &undo);
        store.apply(&undo.id, &paths).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("main.txt")).unwrap(),
            "changed"
        );
    }

    #[test]
    fn checkpoint_storage_is_outside_workspace_and_gc_ignores_incomplete_metadata() {
        let (_data, root, store) = fixture();
        let nested_data = root.path().join("app-data");
        fs::create_dir(&nested_data).unwrap();
        assert!(Store::open(&nested_data, root.path()).is_err());
        fs::write(store.path.join("plans/.tmp-incomplete"), "{").unwrap();
        store.collect_unused().unwrap();
        let state = FileState {
            hash: digest(b"original"),
            executable: false,
        };
        let blob = File::create(store.blob(&state.hash).unwrap()).unwrap();
        blob.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(store.content(&state).is_err());
    }

    #[test]
    fn checkpoint_interrupted_recovery_keeps_journal_until_every_applied_file_is_selected() {
        let (_data, root, store) = fixture();
        for name in ["a.txt", "b.txt"] {
            fs::write(root.path().join(name), "original").unwrap();
        }
        store.capture(1, "before".into()).unwrap();
        let checkpoint = store.infos().unwrap()[0].id.clone();
        for name in ["a.txt", "b.txt"] {
            fs::write(root.path().join(name), "modified").unwrap();
        }
        let plan = store.preview(&checkpoint).unwrap();
        json_write(
            &store.path.join("last-restore.json"),
            &Journal {
                id: plan.id.clone(),
                status: "interrupted".into(),
                changes: plan.changes.clone(),
            },
        )
        .unwrap();
        for change in &plan.changes {
            store.replace(change).unwrap();
        }
        let undo = store.undo(&plan.id).unwrap();
        let paths = save_plan(&store, &undo);
        assert!(store.apply(&undo.id, &paths[..1]).is_err());
        assert_eq!(store.journal().unwrap().unwrap().id, plan.id);
        store.apply(&undo.id, &paths).unwrap();
        for name in ["a.txt", "b.txt"] {
            assert_eq!(
                fs::read_to_string(root.path().join(name)).unwrap(),
                "modified"
            );
        }
    }

    #[tokio::test]
    async fn checkpoint_disabled_does_not_restrict_existing_send_directories() {
        let data = tempfile::tempdir().unwrap();
        let manager = ConnectionManager::new();
        automatic(
            data.path().to_path_buf(),
            data.path().ancestors().last().unwrap().to_path_buf(),
            1,
            "disabled".into(),
            &manager,
        )
        .await
        .unwrap();
        assert!(!data.path().join("file-checkpoints").exists());
    }

    #[cfg(unix)]
    #[test]
    fn checkpoint_symlink_swaps_cannot_escape_the_workspace() {
        let (_data, root, store) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/main.txt"), "saved").unwrap();
        fs::write(outside.path().join("main.txt"), "outside").unwrap();
        store.capture(1, "before".into()).unwrap();
        fs::write(root.path().join("src/main.txt"), "changed").unwrap();
        let plan = store.preview(&store.infos().unwrap()[0].id).unwrap();
        let paths = save_plan(&store, &plan);
        fs::remove_dir_all(root.path().join("src")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("src")).unwrap();
        assert!(store.apply(&plan.id, &paths).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("main.txt")).unwrap(),
            "outside"
        );
    }

    #[tokio::test]
    async fn checkpoint_busy_shared_directory_blocks_restore_and_unrelated_work_does_not() {
        let (_data, root, _store) = fixture();
        let manager = ConnectionManager::new();
        manager
            .insert_test_connection(
                "busy",
                AgentType::Codex,
                Some(root.path().to_path_buf()),
                EventEmitter::Noop,
            )
            .await;
        let state = manager.get_state("busy").await.unwrap();
        state.write().await.turn_in_flight = true;
        assert!(ensure_idle(&manager, &root_path(root.path()).unwrap())
            .await
            .is_err());
        let other = tempfile::tempdir().unwrap();
        assert!(ensure_idle(&manager, &root_path(other.path()).unwrap())
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn checkpoint_automatic_capture_precedes_enqueue_and_blocks_on_snapshot_failure() {
        use crate::acp::types::PromptInputBlock;
        let (data, root, store) = fixture();
        fs::write(root.path().join("main.txt"), "before prompt").unwrap();
        json_write(&store.path.join("config.json"), &Config { enabled: true }).unwrap();
        drop(store);
        let manager = ConnectionManager::new();
        manager.install_checkpoint_directory(data.path().to_path_buf());
        let mut receiver = manager
            .insert_test_connection_live(
                "send",
                AgentType::Codex,
                Some(root.path().to_path_buf()),
                EventEmitter::Noop,
            )
            .await;
        let state = manager.get_state("send").await.unwrap();
        state.write().await.conversation_id = Some(1);
        manager
            .send_prompt(
                "send",
                vec![PromptInputBlock::Text {
                    text: "do work".into(),
                }],
            )
            .await
            .unwrap();
        assert!(matches!(
            receiver.recv().await,
            Some(crate::acp::connection::ConnectionCommand::Prompt { .. })
        ));
        let store = Store::open(data.path(), root.path()).unwrap();
        assert_eq!(store.infos().unwrap().len(), 1);
        assert!(store.infos().unwrap()[0].label.contains("do work"));
        let large = File::create(root.path().join("large.dat")).unwrap();
        large.set_len(MAX_FILE_BYTES + 1).unwrap();
        drop(store);
        state.write().await.turn_in_flight = false;
        assert!(manager
            .send_prompt(
                "send",
                vec![PromptInputBlock::Text {
                    text: "must not enqueue".into()
                }]
            )
            .await
            .is_err());
        assert!(!state.read().await.turn_in_flight);
        assert!(receiver.try_recv().is_err());
    }
}
