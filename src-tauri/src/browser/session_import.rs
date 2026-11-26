use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgoImportOutcome {
    pub tab_id: String,
    pub status: String,
    pub cookies_imported: usize,
    pub storage_imported: usize,
    pub skipped_expired: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl EgoImportOutcome {
    pub fn refused(tab_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            status: "refused".to_string(),
            cookies_imported: 0,
            storage_imported: 0,
            skipped_expired: 0,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgoImportSettings {
    pub source_profile_id: Option<String>,
    pub source_profile_name: Option<String>,
    // Agent 导入必须由用户显式开启，默认不能替用户搬运登录态。
    pub allow_agent_import: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgoSourceProfile {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}
