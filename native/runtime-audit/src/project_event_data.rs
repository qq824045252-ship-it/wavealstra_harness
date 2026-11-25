use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
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
    Found { event: EventRow },
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

fn apply(db: &mut Connection, request: Request) -> rusqlite::Result<Reply> {
    match request {
        Request::Read { event_id } => match read_event(db, &event_id)? {
            Some(event) => Ok(Reply::Found { event }),
            None => Ok(Reply::MissingEvent),
        },
        Request::Triage {
            project_id,
            event_id,
            triage_status,
        } => {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let archived = tx
                .query_row(
                    "SELECT archived FROM projects WHERE id = ?1",
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
            Ok(Reply::Found { event })
        }
    }
}

fn read_event(db: &Connection, event_id: &str) -> rusqlite::Result<Option<EventRow>> {
    db.prepare_cached(
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
