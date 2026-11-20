use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{ConnectionTrait, EntityTrait, FromQueryResult, QueryOrder};
use serde::{Deserialize, Serialize};

use super::{sql, Dimension};
use crate::db::{
    entities::{conversation_tag as tag, conversation_tag_link as link},
    error::DbError,
};

#[derive(Debug, Clone, Serialize, Deserialize, FromQueryResult)]
pub(super) struct Conversation {
    pub id: i32,
    pub title: Option<String>,
    pub scope: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromQueryResult)]
pub(super) struct Ignored {
    pub conversation_id: i32,
    pub identity: String,
    pub tag_id: Option<i32>,
    pub name: String,
    pub folder_id: Option<i32>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub(super) struct Catalog {
    pub tags: BTreeMap<i32, tag::Model>,
    pub links: Vec<link::Model>,
    pub conversations: BTreeMap<i32, Conversation>,
    #[serde(skip)]
    pub scopes: BTreeSet<i32>,
    #[serde(skip)]
    pub ignored: Vec<Ignored>,
}

impl Catalog {
    pub async fn read<C: ConnectionTrait>(conn: &C) -> Result<Self, DbError> {
        let tags = tag::Entity::find().all(conn).await?;
        let links = link::Entity::find()
            .order_by_asc(link::Column::ConversationId)
            .order_by_asc(link::Column::TagId)
            .all(conn)
            .await?;
        let conversations = Conversation::find_by_statement(sql(
            "SELECT c.id, c.title,
                    CASE WHEN c.kind = 'chat' OR f.kind != 'regular' THEN NULL
                         ELSE COALESCE(f.parent_id, f.id) END AS scope
             FROM conversation c JOIN folder f ON f.id = c.folder_id
             WHERE c.deleted_at IS NULL",
            [],
        ))
        .all(conn)
        .await?;
        let scopes = conn.query_all(sql(
            "SELECT id FROM folder WHERE kind = 'regular' AND parent_id IS NULL AND deleted_at IS NULL",
            [],
        )).await?;
        let ignored = Ignored::find_by_statement(sql(
            "SELECT conversation_id, identity, tag_id, name, folder_id FROM ai_tag_ignored
             ORDER BY conversation_id, identity",
            [],
        ))
        .all(conn)
        .await?;
        Ok(Self {
            tags: tags.into_iter().map(|tag| (tag.id, tag)).collect(),
            links,
            conversations: conversations
                .into_iter()
                .map(|session| (session.id, session))
                .collect(),
            scopes: scopes
                .into_iter()
                .map(|row| row.try_get("", "id"))
                .collect::<Result<_, _>>()?,
            ignored,
        })
    }

    pub fn link(&self, conversation_id: i32, tag_id: i32) -> Option<&link::Model> {
        self.links
            .binary_search_by_key(&(conversation_id, tag_id), |link| {
                (link.conversation_id, link.tag_id)
            })
            .ok()
            .map(|index| &self.links[index])
    }

    pub fn tag_links(&self, tag_id: i32) -> impl Iterator<Item = &link::Model> {
        self.links.iter().filter(move |link| link.tag_id == tag_id)
    }

    pub fn dimension_links(
        &self,
        conversation_id: i32,
        dimension: Dimension,
    ) -> impl Iterator<Item = &link::Model> {
        self.links.iter().filter(move |link| {
            link.conversation_id == conversation_id
                && self.tags.get(&link.tag_id).and_then(|tag| tag.dimension) == Some(dimension)
        })
    }

    pub fn can_tag(&self, conversation_id: i32, scope: Option<i32>) -> bool {
        self.conversations
            .get(&conversation_id)
            .is_some_and(|session| scope.is_none() || session.scope == scope)
    }
}
