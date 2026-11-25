use crate::{MAX_REPLY_BYTES, Result};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

const PAGE_SIZE: usize = 100;
const PAGE_SQL_LIMIT: usize = PAGE_SIZE + 1;
const MAX_ORDINAL: i64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    user_id: String,
    bot_id: String,
    team_id: Option<String>,
    conversation_id: Option<String>,
    before: Option<i64>,
    after: Option<i64>,
    message_ids: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Page {
    Ready {
        conversation_id: String,
        revision: i64,
        archived: bool,
        rows: Vec<Message>,
        before: Option<i64>,
    },
    Missing,
    ScopeMismatch,
    NeedsHost,
}

#[derive(Serialize)]
pub struct Message {
    message_id: String,
    conversation_id: String,
    bot_id: String,
    request_id: String,
    ordinal: i64,
    role: String,
    text: String,
    status: String,
    work_ids_json: String,
    error: Option<String>,
    created_at: i64,
    updated_at: i64,
    team_id: Option<String>,
    user_id: String,
    reference_message_id: Option<String>,
    revision: i64,
    attachments_json: Option<String>,
    metadata_json: Option<String>,
    activity_json: Option<String>,
    segments_json: Option<String>,
    tool_task_id: Option<String>,
    tools_json: Option<String>,
}

type Conversation = (String, Option<String>, i64, Option<i64>);
type Candidate = (String, i64);

pub fn read(db: &mut Connection, query: Query) -> Result<Page> {
    let tx = db.transaction()?;
    let Some((conversation_id, team, revision, archived_at)) = conversation(&tx, &query)? else {
        return Ok(Page::Missing);
    };
    if team != query.team_id {
        return Ok(Page::ScopeMismatch);
    }
    let ascending = query.after.is_some();
    let before = query.before.unwrap_or(MAX_ORDINAL);
    let after = query.after.unwrap_or(0);
    let ids = query
        .message_ids
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let order = if ascending { "ASC" } else { "DESC" };
    let source_sql = "SELECT m.message_id,m.ordinal FROM bot_messages m
       WHERE m.conversation_id=?1 AND m.ordinal<?2 AND m.ordinal>?3
       AND (?4 IS NULL OR m.message_id IN (SELECT value FROM json_each(?4)))";
    let mut primary = tx.prepare_cached(&format!(
        "{source_sql} ORDER BY m.ordinal {order} LIMIT {PAGE_SQL_LIMIT}"
    ))?;
    let mut candidates = primary
        .query_map(params![conversation_id, before, after, ids], candidate)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut inboxes = tx.prepare_cached(
        "SELECT conversation_id FROM bot_conversations
         WHERE user_id=?1 AND conversation_id LIKE 'bot-inbox-%' AND conversation_id<>?2
           AND EXISTS(SELECT 1 FROM bot_work_feedback)",
    )?;
    let mut linked = tx.prepare_cached(&format!(
        "{source_sql} AND EXISTS (
           SELECT 1 FROM bot_work_feedback f JOIN work_conversations t
             ON t.work_id=json_extract(f.metadata_json,'$.workId')
           WHERE f.message_id=m.message_id AND t.channel_type='bot-delivery' AND t.conversation_id=?5
         ) ORDER BY m.ordinal {order} LIMIT {PAGE_SQL_LIMIT}"
    ))?;
    for inbox in inboxes.query_map(params![query.user_id, conversation_id], |row| {
        row.get::<_, String>(0)
    })? {
        let edge = candidates.get(PAGE_SIZE).map(|(_, ordinal)| *ordinal);
        let linked_before = if ascending {
            before.min(edge.unwrap_or(before))
        } else {
            before
        };
        let linked_after = if ascending {
            after
        } else {
            after.max(edge.unwrap_or(after))
        };
        let rows = linked.query_map(
            params![inbox?, linked_before, linked_after, ids, conversation_id],
            candidate,
        )?;
        for row in rows {
            candidates.push(row?);
        }
        if ascending {
            candidates.sort_unstable_by_key(|(_, ordinal)| *ordinal);
        } else {
            candidates.sort_unstable_by(|(_, a), (_, b)| b.cmp(a));
        }
        candidates.truncate(PAGE_SQL_LIMIT);
    }
    let has_previous = query.message_ids.is_none() && (ascending || candidates.len() > PAGE_SIZE);
    candidates.truncate(PAGE_SIZE);
    if !ascending {
        candidates.reverse();
    }
    let cursor = if has_previous {
        candidates.first().map(|(_, ordinal)| *ordinal)
    } else {
        None
    };
    let selected = serde_json::to_string(&candidates.iter().map(|(id, _)| id).collect::<Vec<_>>())?;
    let mut details = tx.prepare_cached(
        "SELECT m.message_id,m.conversation_id,m.bot_id,m.request_id,m.ordinal,m.role,m.text,m.status,
                m.work_ids_json,m.error,m.created_at,m.updated_at,c.team_id,c.user_id,r.reference_message_id,
                COALESCE(v.revision,0),a.attachments_json,f.metadata_json,act.activity_json,
                s.segments_json,t.task_id,t.tools_json
         FROM json_each(?1) ids
         JOIN bot_messages m ON m.message_id=ids.value
         JOIN bot_conversations c ON c.conversation_id=m.conversation_id
         LEFT JOIN bot_send_receipts r
           ON r.user_id=c.user_id AND r.conversation_id=c.conversation_id AND r.bot_id=m.bot_id
           AND r.request_id=m.request_id AND r.assistant_message_id=m.message_id
         LEFT JOIN bot_message_revisions v ON v.message_id=m.message_id
         LEFT JOIN bot_message_attachments a ON a.message_id=m.message_id
         LEFT JOIN bot_work_feedback f ON f.message_id=m.message_id
         LEFT JOIN bot_message_activity act ON act.message_id=m.message_id AND m.status='running'
         LEFT JOIN bot_message_segments s ON s.message_id=m.message_id AND m.role='assistant'
         LEFT JOIN bot_message_tools t ON t.message_id=m.message_id AND m.role='assistant'
         ORDER BY ids.key",
    )?;
    let mut rows = Vec::with_capacity(candidates.len());
    let mut wire_bytes = 256 + conversation_id.len().saturating_mul(6);
    for row in details.query_map([selected], message)? {
        let row = row?;
        wire_bytes = wire_bytes.saturating_add(row.wire_bound());
        if wire_bytes >= MAX_REPLY_BYTES {
            return Ok(Page::NeedsHost);
        }
        rows.push(row);
    }
    Ok(Page::Ready {
        conversation_id,
        revision,
        archived: archived_at.is_some(),
        rows,
        before: cursor,
    })
}

fn candidate(row: &Row<'_>) -> rusqlite::Result<Candidate> {
    Ok((row.get(0)?, row.get(1)?))
}

fn conversation(db: &Connection, query: &Query) -> rusqlite::Result<Option<Conversation>> {
    let projection = "SELECT conversation_id,team_id,revision,archived_at FROM bot_conversations c WHERE user_id=?1";
    let map = |row: &Row<'_>| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?));
    if let Some(id) = &query.conversation_id {
        return db
            .prepare_cached(&format!(
                "{projection} AND conversation_id=?2
            AND (bot_id=?3 OR team_id IS NOT NULL)"
            ))?
            .query_row(params![query.user_id, id, query.bot_id], map)
            .optional();
    }
    if let Some(team_id) = &query.team_id {
        return db
            .prepare_cached(&format!(
                "{projection} AND team_id=?2 AND archived_at IS NULL"
            ))?
            .query_row(params![query.user_id, team_id], map)
            .optional();
    }
    db.prepare_cached(&format!("{projection} AND bot_id=?2 AND team_id IS NULL AND archived_at IS NULL
      AND ingress_kind='desktop' AND source_kind='user'
      AND NOT EXISTS(SELECT 1 FROM bot_gateway_conversations g WHERE g.conversation_id=c.conversation_id)"))?
        .query_row(params![query.user_id, query.bot_id], map)
        .optional()
}

fn message(row: &Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        message_id: row.get(0)?,
        conversation_id: row.get(1)?,
        bot_id: row.get(2)?,
        request_id: row.get(3)?,
        ordinal: row.get(4)?,
        role: row.get(5)?,
        text: row.get(6)?,
        status: row.get(7)?,
        work_ids_json: row.get(8)?,
        error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        team_id: row.get(12)?,
        user_id: row.get(13)?,
        reference_message_id: row.get(14)?,
        revision: row.get(15)?,
        attachments_json: row.get(16)?,
        metadata_json: row.get(17)?,
        activity_json: row.get(18)?,
        segments_json: row.get(19)?,
        tool_task_id: row.get(20)?,
        tools_json: row.get(21)?,
    })
}

impl Message {
    fn wire_bound(&self) -> usize {
        let fields = [
            Some(self.message_id.as_str()),
            Some(&self.conversation_id),
            Some(&self.bot_id),
            Some(&self.request_id),
            Some(&self.role),
            Some(&self.text),
            Some(&self.status),
            Some(&self.work_ids_json),
            self.error.as_deref(),
            self.team_id.as_deref(),
            Some(&self.user_id),
            self.reference_message_id.as_deref(),
            self.attachments_json.as_deref(),
            self.metadata_json.as_deref(),
            self.activity_json.as_deref(),
            self.segments_json.as_deref(),
            self.tool_task_id.as_deref(),
            self.tools_json.as_deref(),
        ];
        fields.into_iter().flatten().fold(512, |total, value| {
            total.saturating_add(value.len().saturating_mul(6))
        })
    }
}
