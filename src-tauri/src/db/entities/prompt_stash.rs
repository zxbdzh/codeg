use sea_orm::entity::prelude::*;

/// 输入框收藏按对话/新对话草稿隔离；旧版无归属记录仅在设置里管理。
/// 相同内容只在同一个 scope_key 内去重，附件内容指纹仍可共享磁盘副本。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "prompt_stash")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub scope_key: Option<String>,
    /// 正文纯文本影子，供列表预览与搜索。
    pub text: String,
    /// 输入框文档快照（富文本），恢复时原样回填。
    pub doc_json: String,
    /// 附件元数据数组，路径指向 Codeg 数据目录下的副本。
    pub attachments_json: String,
    /// 首行预览，保存时算好。
    pub preview: String,
    /// 正文 + 附件的内容指纹。
    pub fingerprint: String,
    /// 随附附件副本的总字节数，容量淘汰按它算。
    pub asset_bytes: i64,
    pub created_at: DateTimeUtc,
    /// 最近一次保存或恢复的时间。列表排序与淘汰都用它。
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
