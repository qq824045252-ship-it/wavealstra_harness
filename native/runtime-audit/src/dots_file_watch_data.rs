use crate::{Result, dots_file_revision};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Watch {
        id: String,
    },
    Scope {
        task_id: String,
        space_id: String,
    },
    List {
        task_id: Option<String>,
        after_id: Option<String>,
        active_only: bool,
    },
    NoticePending {
        id: String,
        task_id: String,
        input_version: String,
        revision: String,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Create {
        watch: Draft,
    },
    Transition {
        id: String,
        task_id: String,
        expected_state: String,
        input_version: String,
        state: String,
        note: String,
    },
    Notice {
        id: String,
        task_id: String,
        input_version: String,
        revision: String,
    },
}

impl Command {
    pub fn task_id(&self) -> &str {
        match self {
            Self::Create { watch } => &watch.task_id,
            Self::Transition { task_id, .. } | Self::Notice { task_id, .. } => task_id,
        }
    }
}

#[derive(Deserialize)]
pub struct Draft {
    id: String,
    task_id: String,
    space_id: String,
    root: String,
    file: String,
    instruction: String,
    source: String,
    baseline: String,
    input_version: String,
}

#[derive(Serialize)]
struct Watch {
    id: String,
    task_id: String,
    space_id: String,
    root: String,
    file: String,
    instruction: String,
    source: String,
    baseline: String,
    input_version: String,
    state: String,
    note: String,
}

fn watch(row: &duckdb::Row<'_>) -> duckdb::Result<Watch> {
    Ok(Watch {
        id: row.get(0)?,
        task_id: row.get(1)?,
        space_id: row.get(2)?,
        root: row.get(3)?,
        file: row.get(4)?,
        instruction: row.get(5)?,
        source: row.get(6)?,
        baseline: row.get(7)?,
        input_version: row.get(8)?,
        state: row.get(9)?,
        note: row.get(10)?,
    })
}

fn load(db: &Connection, id: &str) -> Result<Option<Watch>> {
    Ok(db.query_row("SELECT id,task_id,space_id,root,file,instruction,source,baseline,input_version,state,note
        FROM dots_file_watches WHERE id=?1", [id], watch).optional()?)
}

#[derive(Serialize)]
struct Scope {
    root: String,
    held: bool,
    controlled: bool,
}

fn scope(db: &Connection, task: &str, space: &str) -> Result<Option<Scope>> {
    if task == "mybuddy-dots"
        || task.starts_with("gw-")
        || task.starts_with("gateway-chat-")
        || space.starts_with("sp-gw-")
    {
        return Ok(None);
    }
    let binding: Option<(Option<String>, bool, bool)> = db.query_row(
        "SELECT t.cwd,EXISTS(SELECT 1 FROM dots_proactive_pauses p WHERE p.scope IN ('',?2)),
            EXISTS(SELECT 1 FROM dots_target_controls c WHERE c.task_id=t.id)
         FROM tasks t WHERE t.id=?1 AND t.space_id=?2 AND t.archived=0 AND t.external_agent_pin_json IS NULL
          AND NOT EXISTS (SELECT 1 FROM work_execution_bindings b WHERE b.task_id=t.id)
          AND NOT EXISTS (SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')",
        params![task, space], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
    let Some((cwd, held, controlled)) = binding else {
        return Ok(None);
    };
    let mut seen = HashSet::new();
    let mut next = Some(space.to_owned());
    let mut root: Option<String> = None;
    while let Some(id) = next {
        if !seen.insert(id.clone()) || id.starts_with("sp-gw-") {
            return Ok(None);
        }
        let entry: Option<(Option<String>, Option<String>, i64)> = db
            .query_row(
                "SELECT path,parent_id,archived FROM spaces WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((path, parent, 0)) = entry else {
            return Ok(None);
        };
        if root.is_none() {
            root = path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_owned);
        }
        next = parent;
    }
    Ok(root
        .filter(|root| {
            Path::new(root).is_absolute() && cwd.as_deref().is_none_or(|cwd| same_root(cwd, root))
        })
        .map(|root| Scope {
            root,
            held: held || controlled,
            controlled,
        }))
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Watch { id } => Ok(json!({"watch":load(db,&id)?})),
        Query::Scope { task_id, space_id } => {
            let snapshot = db.unchecked_transaction()?;
            Ok(json!({"scope":scope(&snapshot,&task_id,&space_id)?}))
        }
        Query::NoticePending {
            id,
            task_id,
            input_version,
            revision,
        } => {
            let snapshot = db.unchecked_transaction()?;
            Ok(json!({"pending":notice_pending(&snapshot,&id,&task_id,&input_version,&revision)?}))
        }
        Query::List {
            task_id,
            after_id,
            active_only,
        } => {
            let mut stmt = db.prepare("SELECT id,task_id,space_id,root,file,instruction,source,baseline,input_version,state,note
                FROM dots_file_watches WHERE (?1 IS NULL OR task_id=?1) AND (?2 IS NULL OR id>?2)
                  AND (NOT ?3 OR state IN ('watching','sending')) ORDER BY id LIMIT 129")?;
            let mut rows = stmt
                .query_map(params![task_id, after_id, active_only], watch)?
                .collect::<duckdb::Result<Vec<_>>>()?;
            let next = if rows.len() > 128 {
                rows.pop();
                rows.last().map(|row| row.id.clone())
            } else {
                None
            };
            Ok(json!({"rows":rows,"next":next}))
        }
    }
}

fn notice_pending(
    db: &Connection,
    id: &str,
    task_id: &str,
    input_version: &str,
    revision: &str,
) -> Result<bool> {
    let Some(row) = load(db, id)?.filter(|row| {
        row.task_id == task_id
            && row.input_version == input_version
            && row.state == "watching"
            && row.baseline != revision
    }) else {
        return Ok(false);
    };
    if !current_scope(db, &row.task_id, &row.space_id, &row.root)?.is_some_and(|scope| !scope.held)
    {
        return Ok(false);
    }
    Ok(db.query_row("SELECT NOT EXISTS(SELECT 1 FROM dots_file_watch_notices WHERE watch_id=?1 AND revision=?2)",
        params![id,revision], |r| r.get(0))?)
}

fn current_scope(db: &Connection, task: &str, space: &str, root: &str) -> Result<Option<Scope>> {
    Ok(scope(db, task, space)?.filter(|scope| same_root(&scope.root, root)))
}

fn same_root(a: &str, b: &str) -> bool {
    let a: PathBuf = Path::new(a).components().collect();
    let b: PathBuf = Path::new(b).components().collect();
    dots_file_revision::same_path(&a, &b)
}

fn accepted(db: &Connection, task: &str, watch: &str) -> Result<bool> {
    let directory: Option<String> = db
        .query_row(
            "SELECT directory FROM durable_bot_bindings
        WHERE task_id=? AND backend='pi-durable'",
            [task],
            |r| r.get(0),
        )
        .optional()?;
    let Some(directory) = directory else {
        return Ok(false);
    };
    let store = crate::durable::store_id_for_path(Path::new(&directory));
    let request = format!("dots-input-file-{watch}");
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM durable_submissions r JOIN durable_stores s USING(store_id)
        WHERE s.store_id=?1 AND NOT s.retired AND r.request_id=?2
          AND r.status IN ('queued','placed','done','unanswered') AND json_extract_string(r.record_json,'$.type')='input'
          AND coalesce(json_extract_string(r.record_json,'$.reason'),'') NOT IN ('aborted','reset'))",
        params![store,request], |r| r.get(0))?)
}

pub fn write(db: &mut Connection, command: Command) -> Result<Value> {
    let tx = db.transaction()?;
    let reply = match command {
        Command::Create { watch } => {
            let valid = current_scope(&tx, &watch.task_id, &watch.space_id, &watch.root)?
                .is_some_and(|scope| !scope.controlled)
                && dots_file_revision::target(Path::new(&watch.root), Path::new(&watch.file))
                    .is_some();
            if !valid {
                json!({"status":"scopeChanged"})
            } else {
                tx.execute("INSERT INTO dots_file_watches(id,task_id,space_id,root,file,instruction,source,baseline,input_version,state)
                    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'watching') ON CONFLICT DO NOTHING",
                    params![watch.id,watch.task_id,watch.space_id,watch.root,watch.file,watch.instruction,watch.source,watch.baseline,watch.input_version])?;
                let saved = load(&tx, &watch.id)?.ok_or("Dots file watch was not recorded")?;
                if saved.task_id != watch.task_id
                    || saved.space_id != watch.space_id
                    || saved.file != watch.file
                    || saved.source != watch.source
                    || saved.instruction != watch.instruction
                    || !same_root(&saved.root, &watch.root)
                {
                    return Err("Dots file watch identity is already in use".into());
                }
                json!({"status":"saved","watch":saved})
            }
        }
        Command::Transition {
            id,
            task_id,
            expected_state,
            input_version,
            state,
            note,
        } => {
            let row = load(&tx, &id)?.filter(|row| {
                row.task_id == task_id
                    && row.input_version == input_version
                    && row.state == expected_state
            });
            let changed = if let Some(row) = row {
                let valid = match state.as_str() {
                    "sending" => {
                        expected_state == "watching"
                            && current_scope(&tx, &row.task_id, &row.space_id, &row.root)?
                                .is_some_and(|scope| !scope.held)
                    }
                    "dispatched" => {
                        matches!(expected_state.as_str(), "sending" | "cancelled" | "paused")
                            && accepted(&tx, &task_id, &id)?
                    }
                    "watching" | "expired" => {
                        matches!(expected_state.as_str(), "watching" | "sending")
                    }
                    "cancelled" => {
                        matches!(expected_state.as_str(), "watching" | "sending" | "paused")
                    }
                    _ => false,
                };
                if valid {
                    tx.execute("UPDATE dots_file_watches SET state=?1,note=?2 WHERE id=?3 AND task_id=?4 AND state=?5 AND input_version=?6",
                    params![state,note,id,task_id,expected_state,input_version])? != 0
                } else {
                    false
                }
            } else {
                false
            };
            json!({"changed":changed})
        }
        Command::Notice {
            id,
            task_id,
            input_version,
            revision,
        } => {
            let changed = if notice_pending(&tx, &id, &task_id, &input_version, &revision)? {
                tx.execute("INSERT INTO dots_file_watch_notices(watch_id,revision) VALUES(?1,?2) ON CONFLICT DO NOTHING", params![id,revision])? != 0
            } else {
                false
            };
            json!({"changed":changed})
        }
    };
    crate::request_control::commit(tx)?;
    Ok(reply)
}
