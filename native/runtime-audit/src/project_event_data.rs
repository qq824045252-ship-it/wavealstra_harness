use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TriageStatus {
    Open,
    Dismissed,
}

impl TriageStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Dismissed => "dismissed",
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Read {
        event_id: String,
    },
    Document {
        project_id: String,
        event_id: String,
        title: String,
        body: String,
        r#ref: String,
        created_at: i64,
    },
    Triage {
        project_id: String,
        event_id: String,
        triage_status: TriageStatus,
    },
}

impl Request {
    pub fn is_read(&self) -> bool {
        matches!(self, Self::Read { .. })
    }
}

#[derive(Serialize)]
pub struct EventRow {
    id: String,
    project_id: String,
    source: String,
    kind: String,
    title: String,
    body: Option<String>,
    r#ref: Option<String>,
    payload_json: String,
    triage_status: String,
    created_at: f64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Found { event: EventRow, created: bool },
    MissingProject,
    MissingEvent,
    Archived,
    Rejected { message: String },
}

pub fn run(db: &mut Connection, request: Request) -> Reply {
    apply(db, request).unwrap_or_else(|error| Reply::Rejected {
        message: error.to_string(),
    })
}

fn apply(db: &mut Connection, request: Request) -> duckdb::Result<Reply> {
    match request {
        Request::Read { event_id } => match read_event(db, &event_id)? {
            Some(event) => Ok(Reply::Found {
                event,
                created: false,
            }),
            None => Ok(Reply::MissingEvent),
        },
        Request::Document {
            project_id,
            event_id,
            title,
            body,
            r#ref,
            created_at,
        } => {
            if title.trim().is_empty()
                || title.encode_utf16().count() > 200
                || body.trim().is_empty()
                || body.encode_utf16().count() > 4000
                || r#ref.trim().is_empty()
                || r#ref.encode_utf16().count() > 200
            {
                return Ok(Reply::Rejected {
                    message: "文档内容或引用无效".into(),
                });
            }
            let tx = db.transaction()?;
            match tx
                .query_row(
                    "SELECT archived!=0 FROM projects WHERE id=?",
                    [&project_id],
                    |r| r.get::<_, bool>(0),
                )
                .optional()?
            {
                None => return Ok(Reply::MissingProject),
                Some(true) => return Ok(Reply::Archived),
                Some(false) => {}
            }
            let existing:Option<String>=tx.query_row("SELECT id FROM project_events WHERE project_id=? AND source='document' AND ref=? ORDER BY created_at,id LIMIT 1",
                params![project_id,r#ref],|r| r.get(0)).optional()?;
            let created = existing.is_none();
            let id = existing.unwrap_or(event_id);
            if created {
                tx.execute("INSERT INTO project_events(id,project_id,source,kind,title,body,ref,created_at)
                    VALUES(?,?,'document','note',?,?,?,?)",params![id,project_id,title,body,r#ref,created_at])?;
                tx.execute("DELETE FROM project_events WHERE project_id=?1 AND id<>?2 AND id NOT IN (
                    SELECT id FROM project_events WHERE project_id=?1 ORDER BY created_at DESC,id DESC LIMIT 1000)",
                    params![project_id,id])?;
            }
            let event = read_event(&tx, &id)?.ok_or(duckdb::Error::QueryReturnedNoRows)?;
            tx.commit()?;
            Ok(Reply::Found { event, created })
        }
        Request::Triage {
            project_id,
            event_id,
            triage_status,
        } => {
            let tx = db.transaction()?;
            let archived = tx
                .query_row(
                    "SELECT archived!=0 FROM projects WHERE id = ?1",
                    [&project_id],
                    |row| row.get::<_, bool>(0),
                )
                .optional()?;
            match archived {
                Some(false) => {}
                Some(true) => return Ok(Reply::Archived),
                None => return Ok(Reply::MissingProject),
            }
            let changed = tx.execute(
                "UPDATE project_events SET triage_status = ?1 WHERE id = ?2 AND project_id = ?3",
                params![triage_status.as_str(), event_id, project_id],
            )?;
            if changed == 0 {
                return Ok(Reply::MissingEvent);
            }
            let Some(event) = read_event(&tx, &event_id)? else {
                return Ok(Reply::MissingEvent);
            };
            tx.commit()?;
            Ok(Reply::Found {
                event,
                created: false,
            })
        }
    }
}

fn read_event(db: &Connection, event_id: &str) -> duckdb::Result<Option<EventRow>> {
    db.prepare(
        "SELECT id, project_id, source, kind, title, body, ref, payload_json, triage_status, created_at
         FROM project_events WHERE id = ?1",
    )?
    .query_row([event_id], |row| {
        Ok(EventRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            source: row.get(2)?,
            kind: row.get(3)?,
            title: row.get(4)?,
            body: row.get(5)?,
            r#ref: row.get(6)?,
            payload_json: row.get(7)?,
            triage_status: row.get(8)?,
            created_at: row.get(9)?,
        })
    })
    .optional()
}
