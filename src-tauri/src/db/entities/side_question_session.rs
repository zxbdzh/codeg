use sea_orm::entity::prelude::*;

/// 一条独立旁问的会话元数据。
///
/// `source_agent_type` + `source_session_id` 定位主会话，
/// `native_session_id` 定位旁问自己的原生 session。这里只放定位信息和用户
/// 可见标题，不放任何凭据或消息正文。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "side_question_session")]
pub struct Model {
    /// UUID 字符串；由调用方在发起创建时生成，重试必须复用同一个值。
    #[sea_orm(primary_key)]
    pub id: String,
    /// `AgentType::as_wire()` 的稳定存储形式。
    pub source_agent_type: String,
    /// 主会话的原生 session ID。
    pub source_session_id: String,
    /// 旁问自己的原生 session ID。
    pub native_session_id: String,
    /// 旁问启动时的工作目录。
    pub cwd: String,
    /// 仅 Pi 旁问可能有的独立 session 文件路径。
    pub pi_session_file: Option<String>,
    /// 用户在旁问列表里看到的标题。
    pub title: String,
    /// 手动关闭只把它置为 false，行和历史都保留。
    pub is_open: bool,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
