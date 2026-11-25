use crate::{MAX_REPLY_BYTES, Result};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params, params_from_iter};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    List,
    Preview {
        project_id: Option<String>,
    },
    Versions {
        id: String,
    },
    History {
        task_id: Option<String>,
        input_ids: Vec<String>,
    },
    Save {
        draft: Draft,
    },
    Remove {
        id: String,
        revision: i64,
    },
}

impl Request {
    pub fn is_read(&self) -> bool {
        !matches!(self, Self::Save { .. } | Self::Remove { .. })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    id: String,
    expected_revision: Option<i64>,
    project_id: Option<String>,
    title: String,
    enabled: bool,
    config: String,
    at: i64,
    max_versions: u32,
    #[serde(default)]
    source: VersionSource,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
enum VersionSource {
    #[default]
    Save,
    Restore,
}

impl VersionSource {
    fn label(&self) -> &'static str {
        match self {
            Self::Save => "save",
            Self::Restore => "restore",
        }
    }
}

#[derive(Serialize)]
pub struct RuleRow {
    id: String,
    revision: i64,
    config: String,
}

#[derive(Serialize)]
pub struct VersionRow {
    revision: i64,
    at: i64,
    source: String,
    title: String,
    note: Option<String>,
    config: String,
    uses: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UseRow {
    task_id: String,
    task_title: String,
    input_id: String,
    rule_id: String,
    title: String,
    revision: i64,
    at: i64,
    detail: String,
    phrase: Option<String>,
    evidence: Option<String>,
    route_status: Option<String>,
    snapshot: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Rules { rows: Vec<RuleRow> },
    Versions { rows: Vec<VersionRow> },
    History { rows: Vec<UseRow> },
    Saved { revision: i64 },
    Removed,
    Conflict,
    NeedsHost,
    Rejected { message: String },
}

pub fn run(db: &mut Connection, request: Request) -> Reply {
    let reading = request.is_read();
    match apply(db, request) {
        Ok(reply) if reading => match serde_json::to_vec(&reply) {
            Ok(encoded) if encoded.len() + 256 < MAX_REPLY_BYTES => reply,
            _ => Reply::NeedsHost,
        },
        Ok(reply) => reply,
        Err(error) if reading => {
            eprintln!("read answer routing data: {error}");
            Reply::NeedsHost
        }
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn rule_row(row: &Row<'_>) -> rusqlite::Result<RuleRow> {
    Ok(RuleRow {
        id: row.get(0)?,
        revision: row.get(1)?,
        config: row.get(2)?,
    })
}

fn apply(db: &mut Connection, request: Request) -> Result<Reply> {
    match request {
        Request::List => {
            let mut stmt =
                db.prepare("SELECT id,revision,config FROM answer_rules ORDER BY rowid DESC")?;
            let rows = stmt
                .query_map([], rule_row)?
                .collect::<rusqlite::Result<_>>()?;
            Ok(Reply::Rules { rows })
        }
        Request::Preview { project_id } => {
            let mut stmt = db.prepare("SELECT id,revision,config FROM answer_rules WHERE enabled=1 AND (project_id IS NULL OR project_id=?1)")?;
            let rows = stmt
                .query_map([project_id], rule_row)?
                .collect::<rusqlite::Result<_>>()?;
            Ok(Reply::Rules { rows })
        }
        Request::Versions { id } => {
            let mut stmt = db.prepare(
                "SELECT v.revision,v.at,v.source,v.title,v.note,v.config,
                (SELECT COUNT(*) FROM answer_rule_turns t
                 WHERE t.rule_id=v.rule_id AND t.revision=v.revision AND t.status='applied')
                FROM answer_rule_versions v WHERE v.rule_id=?1 ORDER BY v.revision DESC LIMIT 200",
            )?;
            let rows = stmt
                .query_map([id], |row| {
                    Ok(VersionRow {
                        revision: row.get(0)?,
                        at: row.get(1)?,
                        source: row.get(2)?,
                        title: row.get(3)?,
                        note: row.get(4)?,
                        config: row.get(5)?,
                        uses: row.get(6)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(Reply::Versions { rows })
        }
        Request::History { task_id, input_ids } => {
            let rows = history(db, task_id, &input_ids)?;
            Ok(Reply::History { rows })
        }
        Request::Save { draft } => save(db, draft),
        Request::Remove { id, revision } => {
            let changed = db.execute(
                "DELETE FROM answer_rules WHERE id=?1 AND revision=?2",
                params![id, revision],
            )?;
            Ok(if changed == 1 {
                Reply::Removed
            } else {
                Reply::Conflict
            })
        }
    }
}

fn history(db: &Connection, task_id: Option<String>, input_ids: &[String]) -> Result<Vec<UseRow>> {
    if task_id.is_some() && input_ids.is_empty() {
        return Ok(Vec::new());
    }
    if input_ids.len() > 200 {
        return Err("Too many answer routing input IDs".into());
    }
    let (filter, limit) = if task_id.is_some() {
        let slots = std::iter::repeat_n("?", input_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        (format!("WHERE u.task_id=? AND u.input_id IN ({slots})"), "")
    } else {
        (String::new(), "LIMIT 50")
    };
    let sql = format!("WITH uses AS (
      SELECT task_id,input_id,rule_id,title,revision,at,detail,phrase,evidence,status,snapshot FROM answer_rule_turns
      UNION ALL
      SELECT task_id,input_id,rule_id,title,revision,at,detail,NULL,NULL,NULL,NULL FROM answer_rule_uses old
      WHERE NOT EXISTS (SELECT 1 FROM answer_rule_turns turn WHERE turn.task_id=old.task_id AND turn.input_id=old.input_id)
    ) SELECT u.task_id,t.title,u.input_id,u.rule_id,u.title,u.revision,u.at,u.detail,u.phrase,u.evidence,u.status,u.snapshot
      FROM uses u JOIN tasks t ON t.id=u.task_id {filter} ORDER BY u.at DESC {limit}");
    let mut stmt = db.prepare(&sql)?;
    let row = |row: &Row<'_>| {
        Ok(UseRow {
            task_id: row.get(0)?,
            task_title: row.get(1)?,
            input_id: row.get(2)?,
            rule_id: row.get(3)?,
            title: row.get(4)?,
            revision: row.get(5)?,
            at: row.get(6)?,
            detail: row.get(7)?,
            phrase: row.get(8)?,
            evidence: row.get(9)?,
            route_status: row.get(10)?,
            snapshot: row.get(11)?,
        })
    };
    let values = task_id.iter().chain(input_ids);
    let result = stmt
        .query_map(params_from_iter(values), row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

fn save(db: &mut Connection, draft: Draft) -> Result<Reply> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let revision = if let Some(expected) = draft.expected_revision {
        let current = tx
            .query_row(
                "SELECT revision,config,project_id,source_id,enabled FROM answer_rules WHERE id=?1",
                [&draft.id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((revision, config, project, source, enabled)) = current else {
            return Ok(Reply::Conflict);
        };
        if revision != expected {
            return Ok(Reply::Conflict);
        }
        if config == draft.config
            && project == draft.project_id
            && source.is_none()
            && enabled == i64::from(draft.enabled)
        {
            return Ok(Reply::Saved { revision });
        }
        tx.execute("UPDATE answer_rules SET project_id=?1,source_id=NULL,source_hash=NULL,enabled=?2,config=?3,
            revision=revision+1 WHERE id=?4", params![draft.project_id, draft.enabled, draft.config, draft.id])?;
        if !draft.enabled {
            tx.execute("UPDATE answer_rule_turns SET status='revoked' WHERE rule_id=?1 AND status='applied'", [&draft.id])?;
        }
        revision
            .checked_add(1)
            .ok_or("Answer routing rule revision overflow")?
    } else {
        tx.execute(
            "INSERT INTO answer_rules(project_id,source_id,source_hash,enabled,config,id,revision)
            VALUES(?1,NULL,NULL,?2,?3,?4,1)",
            params![draft.project_id, draft.enabled, draft.config, draft.id],
        )?;
        1
    };
    tx.execute(
        "INSERT OR REPLACE INTO answer_rule_versions(rule_id,revision,at,source,title,config)
        VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            draft.id,
            revision,
            draft.at,
            draft.source.label(),
            draft.title,
            draft.config
        ],
    )?;
    tx.execute("DELETE FROM answer_rule_versions WHERE rule_id=?1 AND revision NOT IN (
        SELECT revision FROM answer_rule_versions WHERE rule_id=?1 ORDER BY revision DESC LIMIT ?2)",
        params![draft.id, draft.max_versions])?;
    tx.commit()?;
    Ok(Reply::Saved { revision })
}
