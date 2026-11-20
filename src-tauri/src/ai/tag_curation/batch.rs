use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{
    sea_query::Expr, ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection,
    DatabaseTransaction, EntityTrait, FromQueryResult, QueryFilter, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};

use super::{
    catalog::{Catalog, Conversation, Ignored},
    decode, encode, make_item, sql, Change, Dimension, Item, Job, JobRow, Payload,
    TAGS_PER_DIMENSION,
};
use crate::db::{
    entities::{conversation_tag as tag, conversation_tag_link as link},
    error::DbError,
    service::conversation_tag_service::{self as tags, TagError, TagSource},
};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub index: usize,
    pub name: Option<String>,
    pub color: Option<String>,
    pub dimension: Option<Dimension>,
    pub target_id: Option<i32>,
    #[serde(default)]
    pub confirm_manual: bool,
    #[serde(default)]
    pub confirm_delete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub id: String,
    pub tag_ids: BTreeSet<i32>,
    pub conversation_ids: BTreeSet<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Delta<Row> {
    before: Option<Row>,
    after: Option<Row>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    outcome: Outcome,
    tags: Vec<Delta<tag::Model>>,
    links: Vec<Delta<link::Model>>,
    ignored: Vec<Delta<Ignored>>,
    sessions: BTreeMap<i32, Option<Conversation>>,
}

impl<Row> Delta<Row> {
    fn row(&self) -> &Row {
        self.before
            .as_ref()
            .or(self.after.as_ref())
            .expect("change has a row")
    }
}

fn diff<Key: Ord, Row: Clone + Eq>(
    before: impl Iterator<Item = (Key, Row)>,
    after: impl Iterator<Item = (Key, Row)>,
) -> Vec<Delta<Row>> {
    let mut old: BTreeMap<_, _> = before.collect();
    let mut result = Vec::new();
    for (key, after) in after {
        let before = old.remove(&key);
        if before.as_ref() != Some(&after) {
            result.push(Delta {
                before,
                after: Some(after),
            });
        }
    }
    result.extend(old.into_values().map(|before| Delta {
        before: Some(before),
        after: None,
    }));
    result
}

fn journal(id: &str, before: &Catalog, after: &Catalog) -> Journal {
    let tags = diff(
        before.tags.iter().map(|(&id, tag)| (id, tag.clone())),
        after.tags.iter().map(|(&id, tag)| (id, tag.clone())),
    );
    let links = diff(
        before
            .links
            .iter()
            .map(|link| ((link.conversation_id, link.tag_id), link.clone())),
        after
            .links
            .iter()
            .map(|link| ((link.conversation_id, link.tag_id), link.clone())),
    );
    let ignored = diff(
        before
            .ignored
            .iter()
            .map(|item| ((item.conversation_id, item.identity.clone()), item.clone())),
        after
            .ignored
            .iter()
            .map(|item| ((item.conversation_id, item.identity.clone()), item.clone())),
    );
    let outcome = Outcome {
        id: id.to_string(),
        tag_ids: tags.iter().map(|delta| delta.row().id).collect(),
        conversation_ids: links
            .iter()
            .map(|delta| delta.row().conversation_id)
            .chain(ignored.iter().map(|delta| delta.row().conversation_id))
            .collect(),
    };
    let sessions = outcome
        .conversation_ids
        .iter()
        .map(|&id| (id, before.conversations.get(&id).cloned()))
        .collect();
    Journal {
        outcome,
        tags,
        links,
        ignored,
        sessions,
    }
}

async fn lock_batch(conn: &DatabaseConnection, id: &str) -> Result<DatabaseTransaction, DbError> {
    let txn = conn.begin().await?;
    // SQLite 先保留写入权，再读取比较快照，阻止其他窗口在校验和提交之间写入。
    let claimed = txn
        .execute(sql(
            "UPDATE ai_tag_curation SET state = state WHERE id = ?",
            [id.into()],
        ))
        .await?;
    if claimed.rows_affected() == 0 {
        return Err(DbError::NotFound("Tag curation batch".into()));
    }
    Ok(txn)
}

fn from_tag_error(error: TagError) -> DbError {
    match error {
        TagError::Db(error) => error,
        TagError::DuplicateName(name) => {
            DbError::Conflict(format!("Tag name already exists: {name}"))
        }
        other => DbError::Validation(other.to_string()),
    }
}

fn edited_change(change: &Change, choice: &Choice) -> Change {
    let mut change = change.clone();
    match &mut change {
        Change::Create {
            name,
            color,
            dimension,
            ..
        } => {
            if let Some(value) = &choice.name {
                name.clone_from(value);
            }
            if let Some(value) = &choice.color {
                color.clone_from(value);
            }
            if let Some(value) = choice.dimension {
                *dimension = value;
            }
        }
        Change::Update {
            name,
            color,
            dimension,
            ..
        } => {
            if choice.name.is_some() {
                name.clone_from(&choice.name);
            }
            if choice.color.is_some() {
                color.clone_from(&choice.color);
            }
            if choice.dimension.is_some() {
                *dimension = choice.dimension;
            }
        }
        Change::Merge { target_id, .. } => {
            if let Some(value) = choice.target_id {
                *target_id = value;
            }
        }
        _ => {}
    }
    change
}

fn tag_current(baseline: &Catalog, current: &Catalog, id: i32) -> bool {
    baseline.tags.contains_key(&id) && baseline.tags.get(&id) == current.tags.get(&id)
}

fn session_scope(catalog: &Catalog, id: i32) -> Option<Option<i32>> {
    catalog.conversations.get(&id).map(|session| session.scope)
}

fn check_current(baseline: &Catalog, current: &Catalog, change: &Change) -> bool {
    let id = change.tag_id();
    let same_session = |id| session_scope(baseline, id) == session_scope(current, id);
    let same_links = |id| {
        baseline.tag_links(id).eq(current.tag_links(id))
            && baseline
                .tag_links(id)
                .all(|link| same_session(link.conversation_id))
    };
    match *change {
        Change::Create { folder_id, .. } => {
            folder_id.is_none_or(|scope| current.scopes.contains(&scope))
        }
        Change::Add {
            conversation_id, ..
        }
        | Change::Remove {
            conversation_id, ..
        } => {
            (id < 0 || tag_current(baseline, current, id))
                && same_session(conversation_id)
                && baseline.link(conversation_id, id) == current.link(conversation_id, id)
        }
        Change::Merge { target_id, .. } => {
            tag_current(baseline, current, id)
                && same_links(id)
                && tag_current(baseline, current, target_id)
                && same_links(target_id)
        }
        _ => tag_current(baseline, current, id) && same_links(id),
    }
}

fn change_order(change: &Change) -> u8 {
    match change {
        Change::Remove { .. } => 0,
        Change::Merge { .. } | Change::Delete { .. } => 1,
        Change::Create { .. } | Change::Update { .. } => 2,
        Change::Add { .. } => 3,
    }
}

fn selected_changes(
    payload: &Payload,
    baseline: &Catalog,
    current: &Catalog,
    choices: Vec<Choice>,
) -> Result<Vec<Change>, DbError> {
    let mut seen = BTreeSet::new();
    let mut selected = Vec::new();
    for choice in choices {
        let item = payload
            .items
            .get(choice.index)
            .filter(|_| seen.insert(choice.index))
            .ok_or_else(|| DbError::Validation("Select each preview item at most once".into()))?;
        let change = edited_change(&item.change, &choice);
        let name = item
            .before
            .as_ref()
            .or(item.target.as_ref())
            .map(|tag| tag.name.as_str())
            .unwrap_or("new tag");
        if !check_current(baseline, current, &change) {
            return Err(DbError::Conflict(format!(
                "Preview item {} changed: {name}",
                choice.index + 1
            )));
        }
        if matches!(
            change,
            Change::Delete { .. } | Change::Merge { .. } | Change::Remove { .. }
        ) && item.affected.iter().any(|session| session.manual)
            && !choice.confirm_manual
        {
            return Err(DbError::Validation(format!(
                "Confirm removing manual links: {name}"
            )));
        }
        if matches!(change, Change::Delete { .. })
            && !item.affected.is_empty()
            && !choice.confirm_delete
        {
            return Err(DbError::Validation(format!(
                "Confirm deleting a tag in use: {name}"
            )));
        }
        selected.push(change);
    }
    if selected.is_empty() {
        return Err(DbError::Validation(
            "Select at least one preview item".into(),
        ));
    }
    selected.sort_by_key(change_order);
    Ok(selected)
}

async fn merge(
    txn: &DatabaseTransaction,
    current: &Catalog,
    tag_id: i32,
    target_id: i32,
) -> Result<(), DbError> {
    let source = &current.tags[&tag_id];
    let target = tag::Entity::find_by_id(target_id)
        .one(txn)
        .await?
        .ok_or_else(|| DbError::Conflict("Merge target no longer exists".into()))?;
    if tag_id == target_id || source.folder_id != target.folder_id {
        return Err(DbError::Validation(
            "Merge targets must share the same tag scope".into(),
        ));
    }
    let mut aliases: Vec<String> = decode(&target.aliases_json)?;
    let source_names: Vec<String> = decode(&source.aliases_json)?;
    for alias in
        std::iter::once(source.name.as_str()).chain(source_names.iter().map(String::as_str))
    {
        if !aliases
            .iter()
            .any(|name| name.to_lowercase() == alias.to_lowercase())
            && target.name.to_lowercase() != alias.to_lowercase()
        {
            aliases.push(alias.to_string());
        }
    }
    let mut update: tag::ActiveModel = target.clone().into();
    update.aliases_json = Set(encode(&aliases)?);
    update.updated_at = Set(chrono::Utc::now());
    update.update(txn).await?;
    // 重叠时保留人工来源。迁移保留原关联时间，以便批次可精确恢复。
    txn.execute(sql(
        "INSERT INTO conversation_tag_link(conversation_id, tag_id, source, created_at)
         SELECT conversation_id, ?, source, created_at FROM conversation_tag_link WHERE tag_id = ?
         ON CONFLICT(conversation_id, tag_id) DO UPDATE SET source = excluded.source, created_at = excluded.created_at
         WHERE conversation_tag_link.source = 'ai' AND excluded.source != 'ai'",
        [target_id.into(), tag_id.into()],
    )).await?;
    txn.execute(sql(
        "INSERT INTO ai_tag_ignored(conversation_id, identity, tag_id, name, folder_id)
         SELECT conversation_id, ?, ?, ?, ? FROM ai_tag_ignored WHERE tag_id = ?
         ON CONFLICT(conversation_id, identity) DO NOTHING",
        [
            format!("tag:{target_id}").into(),
            target_id.into(),
            target.name.clone().into(),
            target.folder_id.into(),
            tag_id.into(),
        ],
    ))
    .await?;
    tags::delete_tag(txn, tag_id).await?;
    Ok(())
}

async fn write_changes(
    txn: &DatabaseTransaction,
    current: &Catalog,
    changes: &[Change],
) -> Result<Vec<Change>, DbError> {
    let retired: BTreeSet<i32> = changes
        .iter()
        .filter_map(|change| match change {
            Change::Delete { tag_id } | Change::Merge { tag_id, .. } => Some(*tag_id),
            _ => None,
        })
        .collect();
    let mut created_ids = BTreeMap::new();
    let mut actual = Vec::new();
    for change in changes {
        let tag_id = change.tag_id();
        let mut saved = change.clone();
        match change {
            Change::Create {
                folder_id,
                name,
                color,
                dimension,
                ..
            } => {
                let tag =
                    tags::create_tag_with_policy(txn, *folder_id, name, color, *dimension, false)
                        .await
                        .map_err(from_tag_error)?;
                created_ids.insert(tag_id, tag.id);
                saved = Change::Create {
                    tag_id: tag.id,
                    folder_id: tag.folder_id,
                    name: tag.name,
                    color: tag.color,
                    dimension: *dimension,
                };
            }
            Change::Update {
                name,
                color,
                dimension,
                ..
            } => {
                let tag = &current.tags[&tag_id];
                if tag.is_protected && (name.is_some() || color.is_some()) {
                    return Err(DbError::Validation(format!(
                        "Tag is protected: {}",
                        tag.name
                    )));
                }
                tags::update_tag_definition(
                    txn,
                    tag_id,
                    name.as_deref(),
                    color.as_deref(),
                    *dimension,
                    false,
                )
                .await
                .map_err(from_tag_error)?;
            }
            Change::Merge { target_id, .. } => {
                if current.tags[&tag_id].is_protected || retired.contains(target_id) {
                    return Err(DbError::Validation(
                        "The merge source must be unprotected and its target must be kept".into(),
                    ));
                }
                merge(txn, current, tag_id, *target_id).await?;
            }
            Change::Delete { .. } => {
                if current.tags[&tag_id].is_protected {
                    return Err(DbError::Validation(format!(
                        "Tag is protected: {}",
                        current.tags[&tag_id].name
                    )));
                }
                tags::delete_tag(txn, tag_id).await?;
            }
            Change::Add {
                conversation_id, ..
            } => {
                let id = if tag_id < 0 {
                    *created_ids.get(&tag_id).ok_or_else(|| {
                        DbError::Validation("Select the new tag before adding its link".into())
                    })?
                } else {
                    tag_id
                };
                let tag = tag::Entity::find_by_id(id)
                    .one(txn)
                    .await?
                    .ok_or_else(|| DbError::Validation("A selected tag will be removed".into()))?;
                if tag.dimension.is_none() || !current.can_tag(*conversation_id, tag.folder_id) {
                    return Err(DbError::Validation(format!(
                        "Tag {} is not available for this conversation",
                        tag.name
                    )));
                }
                if crate::ai::tag_store::tag_is_ignored(
                    &crate::ai::tag_store::list_ignored(txn, *conversation_id).await?,
                    id,
                    &tag.name,
                    tag.folder_id,
                ) {
                    return Err(DbError::Conflict(format!(
                        "The conversation ignores tag {}",
                        tag.name
                    )));
                }
                tags::update_conversation_tags_with_source(
                    txn,
                    *conversation_id,
                    &[id],
                    &[],
                    TagSource::Ai,
                )
                .await
                .map_err(from_tag_error)?;
                saved = Change::Add {
                    tag_id: id,
                    conversation_id: *conversation_id,
                };
            }
            Change::Remove {
                conversation_id, ..
            } => {
                tags::update_conversation_tags_with_source(
                    txn,
                    *conversation_id,
                    &[],
                    &[tag_id],
                    TagSource::Ai,
                )
                .await
                .map_err(from_tag_error)?;
            }
        }
        actual.push(saved);
    }
    Ok(actual)
}

fn validate_limits(before: &Catalog, after: &Catalog, added: &[Change]) -> Result<(), DbError> {
    for change in added {
        let Change::Add {
            tag_id,
            conversation_id,
        } = *change
        else {
            continue;
        };
        let Some(dimension) = after.tags[&tag_id].dimension else {
            continue;
        };
        let old_manual = before
            .links
            .iter()
            .filter(|link| {
                link.conversation_id == conversation_id
                    && link.source != "ai"
                    && after
                        .tags
                        .get(&link.tag_id)
                        .or_else(|| before.tags.get(&link.tag_id))
                        .and_then(|tag| tag.dimension)
                        == Some(dimension)
            })
            .count();
        if old_manual > TAGS_PER_DIMENSION
            || after.dimension_links(conversation_id, dimension).count() > TAGS_PER_DIMENSION
        {
            return Err(DbError::Validation(format!(
                "Conversation {conversation_id} exceeds the limit of {TAGS_PER_DIMENSION} tags for {dimension:?}"
            )));
        }
    }
    Ok(())
}

pub async fn apply(
    conn: &DatabaseConnection,
    id: &str,
    choices: Vec<Choice>,
) -> Result<Outcome, DbError> {
    let txn = lock_batch(conn, id).await?;
    let row = txn
        .query_one(sql(
            "SELECT state, payload, journal FROM ai_tag_curation WHERE id = ?",
            [id.into()],
        ))
        .await?
        .ok_or_else(|| DbError::NotFound("Tag curation batch".into()))?;
    let state: String = row.try_get("", "state")?;
    if state == "applied" {
        return Ok(decode::<Journal>(&row.try_get::<String>("", "journal")?)?.outcome);
    }
    if state != "review" {
        return Err(DbError::Conflict(
            "Tag curation no longer has a preview to apply".into(),
        ));
    }
    let payload: Payload = decode(&row.try_get::<String>("", "payload")?)?;
    let baseline = payload
        .baseline
        .as_ref()
        .ok_or_else(|| DbError::Validation("Missing tag curation baseline".into()))?;
    let before = Catalog::read(&txn).await?;
    let selected = selected_changes(&payload, baseline, &before, choices)?;
    let actual = write_changes(&txn, &before, &selected).await?;
    let after = Catalog::read(&txn).await?;
    validate_limits(&before, &after, &actual)?;
    let journal = journal(id, &before, &after);
    let items: Vec<Item> = actual
        .into_iter()
        .map(|change| {
            let mut item = make_item(&before, &[], change.clone());
            if matches!(change, Change::Add { .. }) && item.before.is_none() {
                item.target = after
                    .tags
                    .get(&change.tag_id())
                    .cloned()
                    .map(tags::to_detail);
            }
            item
        })
        .collect();
    let applied = Payload {
        items,
        notices: payload.notices,
        baseline: None,
    };
    txn.execute(sql(
        "UPDATE ai_tag_curation SET state = 'applied', payload = ?, journal = ? WHERE id = ?",
        [
            encode(&applied)?.into(),
            encode(&journal)?.into(),
            id.into(),
        ],
    ))
    .await?;
    txn.commit().await?;
    Ok(journal.outcome)
}

pub async fn history(conn: &DatabaseConnection) -> Result<Vec<Job>, DbError> {
    JobRow::find_by_statement(sql(
        "SELECT * FROM ai_tag_curation WHERE state IN ('applied', 'undone') ORDER BY created_at DESC, rowid DESC",
        [],
    )).all(conn).await?.into_iter().map(JobRow::into_job).collect()
}

pub async fn purge(conn: &DatabaseConnection, id: &str) -> Result<(), DbError> {
    let removed = conn
        .execute(sql(
            "DELETE FROM ai_tag_curation WHERE id = ? AND state IN ('applied', 'undone')",
            [id.into()],
        ))
        .await?;
    if removed.rows_affected() == 0 {
        return Err(DbError::NotFound("Completed tag curation batch".into()));
    }
    Ok(())
}

pub async fn set_protection(
    conn: &DatabaseConnection,
    ids: Vec<i32>,
    value: bool,
) -> Result<(), DbError> {
    let ids: BTreeSet<_> = ids.into_iter().collect();
    if ids.is_empty() {
        return Err(DbError::Validation(
            "Select tags to change their protection".into(),
        ));
    }
    let txn = conn.begin().await?;
    let updated = tag::Entity::update_many()
        .col_expr(tag::Column::IsProtected, Expr::value(value))
        .col_expr(tag::Column::UpdatedAt, Expr::value(chrono::Utc::now()))
        .filter(tag::Column::Id.is_in(ids.iter().copied()))
        .exec(&txn)
        .await?;
    if updated.rows_affected != ids.len() as u64 {
        return Err(DbError::Conflict("A tag no longer exists".into()));
    }
    txn.commit().await?;
    Ok(())
}

fn check_undo(current: &Catalog, journal: &Journal) -> Result<(), DbError> {
    let conflict = |name: &str| {
        DbError::Conflict(format!(
            "Tag curation undo conflicts with a later change: {name}"
        ))
    };
    let patched_ids = &journal.outcome.tag_ids;
    for delta in &journal.tags {
        let tag = delta.row();
        if current.tags.get(&tag.id) != delta.after.as_ref() {
            return Err(conflict(&tag.name));
        }
        if let Some(original) = &delta.before {
            if current.tags.values().any(|other| {
                !patched_ids.contains(&other.id)
                    && other.folder_id == original.folder_id
                    && other.name.to_lowercase() == original.name.to_lowercase()
            }) {
                return Err(conflict(&tag.name));
            }
        } else {
            // 撤回新增定义会级联删关联，因此也要识别后来新增的关联或忽略记录。
            if current.tag_links(tag.id).any(|link| {
                !journal
                    .links
                    .iter()
                    .any(|delta| delta.after.as_ref() == Some(link))
            }) || current
                .ignored
                .iter()
                .filter(|row| row.tag_id == Some(tag.id))
                .any(|row| {
                    !journal
                        .ignored
                        .iter()
                        .any(|delta| delta.after.as_ref() == Some(row))
                })
            {
                return Err(conflict(&tag.name));
            }
        }
    }
    for delta in &journal.links {
        let row = delta.row();
        if current.link(row.conversation_id, row.tag_id) != delta.after.as_ref() {
            return Err(conflict(&format!(
                "conversation {} / tag {}",
                row.conversation_id, row.tag_id
            )));
        }
        if let Some(original) = &delta.before {
            let restored = journal
                .tags
                .iter()
                .find_map(|delta| {
                    delta
                        .before
                        .as_ref()
                        .filter(|tag| tag.id == original.tag_id)
                })
                .or_else(|| current.tags.get(&original.tag_id));
            let Some(tag) = restored else {
                return Err(conflict(&format!("tag {}", original.tag_id)));
            };
            if current.conversations.contains_key(&row.conversation_id)
                && !current.can_tag(row.conversation_id, tag.folder_id)
            {
                return Err(conflict(&format!("conversation {}", row.conversation_id)));
            }
        }
    }
    for (id, session) in &journal.sessions {
        if session_scope(current, *id) != session.as_ref().map(|session| session.scope) {
            return Err(conflict(&format!("conversation {id}")));
        }
    }
    for delta in &journal.ignored {
        let item = delta.row();
        if current.ignored.iter().find(|other| {
            other.conversation_id == item.conversation_id && other.identity == item.identity
        }) != delta.after.as_ref()
        {
            return Err(conflict(&format!(
                "conversation {} / {}",
                item.conversation_id, item.name
            )));
        }
    }
    Ok(())
}

pub async fn undo(conn: &DatabaseConnection, id: &str) -> Result<Outcome, DbError> {
    let txn = lock_batch(conn, id).await?;
    let row = txn.query_one(sql("SELECT state, journal FROM ai_tag_curation WHERE id = ? AND state IN ('applied', 'undone')", [id.into()]))
        .await?.ok_or_else(|| DbError::NotFound("Completed tag curation batch".into()))?;
    let journal: Journal = decode(&row.try_get::<String>("", "journal")?)?;
    if row.try_get::<String>("", "state")? == "undone" {
        return Ok(journal.outcome);
    }
    let current = Catalog::read(&txn).await?;
    check_undo(&current, &journal)?;

    for delta in &journal.tags {
        if let (None, Some(tag)) = (&delta.before, &delta.after) {
            tags::delete_tag(&txn, tag.id).await?;
        }
    }
    // 一批可能包含 A→C、B→A。先腾出改过的名字，避免撤销受执行顺序影响。
    for delta in &journal.tags {
        if let (Some(before), Some(after)) = (&delta.before, &delta.after) {
            if before.name != after.name {
                txn.execute(sql(
                    "UPDATE conversation_tag SET name = ? WHERE id = ?",
                    [
                        format!("curation-{id}-{}", before.id).into(),
                        before.id.into(),
                    ],
                ))
                .await?;
            }
        }
    }
    for delta in &journal.tags {
        if let Some(tag) = &delta.before {
            let restored: tag::ActiveModel = tag.clone().into();
            if delta.after.is_some() {
                restored.reset_all().update(&txn).await?;
            } else {
                restored.insert(&txn).await?;
            }
        }
    }
    for delta in &journal.links {
        let row = delta.row();
        link::Entity::delete_by_id((row.conversation_id, row.tag_id))
            .exec(&txn)
            .await?;
        if let Some(original) = &delta.before {
            let restored: link::ActiveModel = original.clone().into();
            restored.insert(&txn).await?;
        }
    }
    for delta in &journal.ignored {
        let row = delta.row();
        txn.execute(sql(
            "DELETE FROM ai_tag_ignored WHERE conversation_id = ? AND identity = ?",
            [row.conversation_id.into(), row.identity.clone().into()],
        ))
        .await?;
        if let Some(original) = &delta.before {
            txn.execute(sql(
                "INSERT INTO ai_tag_ignored(conversation_id, identity, tag_id, name, folder_id) VALUES (?, ?, ?, ?, ?)",
                [original.conversation_id.into(), original.identity.clone().into(), original.tag_id.into(), original.name.clone().into(), original.folder_id.into()],
            )).await?;
        }
    }
    txn.execute(sql(
        "UPDATE ai_tag_curation SET state = 'undone' WHERE id = ?",
        [id.into()],
    ))
    .await?;
    txn.commit().await?;
    Ok(journal.outcome)
}
