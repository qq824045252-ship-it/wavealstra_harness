use crate::{Result, sqlite_rows::records};
use rusqlite::{
    Connection, OptionalExtension, Params, TransactionBehavior, params, params_from_iter,
    types::Value as SqlValue,
};
use serde::Deserialize;
use serde_json::{Map, Value};

const COLUMNS: &[&str] = &[
    "id",
    "name",
    "prompt",
    "schedule_type",
    "schedule_expr",
    "timezone",
    "space_id",
    "cwd",
    "enabled",
    "created_at",
    "updated_at",
    "last_run_at",
    "permission_mode",
    "welcome_mode",
    "model_id",
    "expert_id",
    "skill_ids_json",
    "connector_ids_json",
    "effective_from",
    "effective_to",
    "project_id",
    "execution_json",
];

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Save {
        row: Map<String, Value>,
        expected: Option<Value>,
        guard: Option<Guard>,
        provenance: Option<Provenance>,
        manual_hold: Option<ManualHold>,
    },
    Remove {
        id: String,
        expected: Option<Value>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Guard {
    tasks: Vec<String>,
    projects: Vec<String>,
    enabled_limit_for_task: Option<String>,
    dots: Option<DotsGuard>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DotsGuard {
    space_id: Option<String>,
    task_id: Option<String>,
    ignore_manual_hold: bool,
}

#[derive(Deserialize)]
pub struct Provenance {
    source: String,
    origin: Origin,
    owner: Option<Owner>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Origin {
    conversation_id: i64,
    entry_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    task_id: Option<String>,
    space_id: Option<String>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ManualHold {
    Add,
    Remove,
}

fn exists(db: &Connection, sql: &str, values: impl Params) -> Result<bool> {
    Ok(db.query_row(sql, values, |_| Ok(())).optional()?.is_some())
}

fn guard_allows(db: &Connection, id: &str, guard: &Guard) -> Result<bool> {
    for task in &guard.tasks {
        if !exists(db, "SELECT 1 FROM tasks WHERE id=? AND archived=0", [task])? {
            return Ok(false);
        }
    }
    for project in &guard.projects {
        if !exists(
            db,
            "SELECT 1 FROM projects WHERE id=? AND archived=0",
            [project],
        )? {
            return Ok(false);
        }
    }
    if let Some(task) = &guard.enabled_limit_for_task {
        let count = db.query_row(
            "SELECT COUNT(*) FROM cron_jobs WHERE enabled=1 AND id<>?
             AND json_extract(execution_json,'$.sourceTaskId')=? AND json_extract(execution_json,'$.reminder.kind') IS NOT 'bot-reminder'",
            params![id, task],
            |row| row.get::<_, i64>(0),
        )?;
        if count >= 20 {
            return Ok(false);
        }
    }
    let Some(dots) = &guard.dots else {
        return Ok(true);
    };
    if exists(
        db,
        "SELECT 1 FROM dots_schedule_holds WHERE job_id=? AND (holder<>'manual' OR ?=0)",
        params![id, dots.ignore_manual_hold],
    )? {
        return Ok(false);
    }
    let has_table = |name| exists(db, "SELECT 1 FROM sqlite_master WHERE name=?", [name]);
    if has_table("dots_proactive_pauses")?
        && exists(
            db,
            "SELECT 1 FROM dots_proactive_pauses WHERE scope IN ('',?)",
            [dots.space_id.as_deref().unwrap_or("")],
        )?
    {
        return Ok(false);
    }
    if let Some(space) = &dots.space_id {
        if !exists(db, "SELECT 1 FROM spaces WHERE id=?", [space])? {
            return Ok(false);
        }
    }
    if let Some(task) = &dots.task_id {
        if has_table("dots_target_controls")?
            && exists(
                db,
                "SELECT 1 FROM dots_target_controls WHERE task_id=?",
                [task],
            )?
        {
            return Ok(false);
        }
        return exists(
            db,
            "WITH RECURSIVE parents(id, parent_id, archived) AS (
                SELECT id, parent_id, archived FROM spaces WHERE id=?1
                UNION SELECT s.id, s.parent_id, s.archived FROM spaces s JOIN parents p ON p.parent_id=s.id
             ) SELECT 1 FROM tasks WHERE id=?2 AND space_id IS ?1 AND archived=0
               AND NOT EXISTS (SELECT 1 FROM parents WHERE archived<>0)
               AND NOT EXISTS (SELECT 1 FROM task_execution_workspace_state WHERE task_id=?2 AND state='trashed')",
            params![dots.space_id, task],
        );
    }
    Ok(true)
}

fn same_provenance(db: &Connection, id: &str, provenance: &Provenance) -> Result<bool> {
    if !exists(
        db,
        "SELECT 1 FROM dots_schedule_origins WHERE job_id=? AND source=? AND conversation=? AND entry=?",
        params![
            id,
            provenance.source,
            provenance.origin.conversation_id,
            provenance.origin.entry_id
        ],
    )? {
        return Ok(false);
    }
    match &provenance.owner {
        Some(owner) => exists(
            db,
            "SELECT 1 FROM dots_schedule_scopes WHERE job_id=? AND task_id IS ? AND space_id IS ?",
            params![id, owner.task_id, owner.space_id],
        ),
        None => Ok(!exists(
            db,
            "SELECT 1 FROM dots_schedule_scopes WHERE job_id=?",
            [id],
        )?),
    }
}

fn save(
    db: &Connection,
    row: Map<String, Value>,
    expected: Option<Value>,
    guard: Option<&Guard>,
    provenance: Option<&Provenance>,
    manual_hold: Option<ManualHold>,
) -> Result<bool> {
    let id = row
        .get("id")
        .and_then(Value::as_str)
        .ok_or("missing automation plan ID")?;
    let current = records(db, "SELECT * FROM cron_jobs WHERE id=?", [id])?.pop();
    if let Some(current) = &current {
        if row
            .iter()
            .all(|(key, value)| current.get(key) == Some(value))
        {
            let same_origin = match provenance {
                Some(p) => same_provenance(db, id, p)?,
                None => true,
            };
            let same_hold = match manual_hold {
                Some(action) => {
                    exists(
                        db,
                        "SELECT 1 FROM dots_schedule_holds WHERE job_id=? AND holder='manual'",
                        [id],
                    )? == matches!(action, ManualHold::Add)
                }
                None => true,
            };
            if same_origin && same_hold {
                return Ok(true);
            }
        }
    }
    if current != expected {
        return Ok(false);
    }
    if let Some(guard) = guard {
        if !guard_allows(db, id, guard)? {
            return Ok(false);
        }
    }
    let columns = COLUMNS.join(", ");
    let inputs = vec!["?"; COLUMNS.len()].join(", ");
    let changes = COLUMNS
        .iter()
        .copied()
        .filter(|name| !matches!(*name, "id" | "created_at"))
        .map(|name| format!("{name}=excluded.{name}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut values = Vec::with_capacity(COLUMNS.len());
    for column in COLUMNS {
        let value = match row.get(*column) {
            Some(Value::Null) => SqlValue::Null,
            Some(Value::String(text)) => SqlValue::Text(text.clone()),
            Some(Value::Number(number)) => match number.as_i64() {
                Some(integer) => SqlValue::Integer(integer),
                None => SqlValue::Real(number.as_f64().ok_or("invalid automation plan number")?),
            },
            _ => return Err("invalid automation plan column".into()),
        };
        values.push(value);
    }
    db.prepare_cached(&format!("INSERT INTO cron_jobs ({columns}) VALUES ({inputs}) ON CONFLICT(id) DO UPDATE SET {changes}"))?
        .execute(params_from_iter(values))?;
    if let Some(p) = provenance {
        db.execute(
            "INSERT INTO dots_schedule_origins VALUES(?,?,?,?)",
            params![id, p.source, p.origin.conversation_id, p.origin.entry_id],
        )?;
        if let Some(owner) = &p.owner {
            db.execute(
                "INSERT INTO dots_schedule_scopes VALUES(?,?,?)",
                params![id, owner.task_id, owner.space_id],
            )?;
        }
    }
    match manual_hold {
        Some(ManualHold::Add) => {
            db.execute(
                "INSERT OR IGNORE INTO dots_schedule_holds VALUES(?,'manual')",
                [id],
            )?;
        }
        Some(ManualHold::Remove) => {
            db.execute(
                "DELETE FROM dots_schedule_holds WHERE job_id=? AND holder='manual'",
                [id],
            )?;
        }
        None => {}
    }
    Ok(true)
}

pub fn write(db: &mut Connection, mutation: Mutation) -> Result<bool> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let applied = match mutation {
        Mutation::Save {
            row,
            expected,
            guard,
            provenance,
            manual_hold,
        } => save(
            &tx,
            row,
            expected,
            guard.as_ref(),
            provenance.as_ref(),
            manual_hold,
        )?,
        Mutation::Remove { id, expected } => {
            let current = records(&tx, "SELECT * FROM cron_jobs WHERE id=?", [&id])?.pop();
            if current.is_none() {
                true
            } else if current != expected {
                false
            } else {
                tx.execute("DELETE FROM cron_runs WHERE job_id=?", [&id])?;
                tx.execute("DELETE FROM cron_jobs WHERE id=?", [&id])?;
                true
            }
        }
    };
    tx.commit()?;
    Ok(applied)
}
