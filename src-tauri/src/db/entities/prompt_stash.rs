use sea_orm::entity::prelude::*;

/// 输入框收藏的一条记录。跨会话、跨项目共享，不属于任何会话或文件夹。
///
/// `fingerprint` 唯一：正文与附件的指纹相同就是同一条，收藏时会把它置顶而
/// 不是再插一条。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "prompt_stash")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
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
