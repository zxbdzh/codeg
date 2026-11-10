use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "research_branch")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub request_id: String,
    pub source_conversation_id: i32,
    pub branch_conversation_id: i32,
    pub source_session_id: String,
    pub branch_session_id: String,
    pub source_turn_id: Option<String>,
    pub boundary: String,
    pub summary: String,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
