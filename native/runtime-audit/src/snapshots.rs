use crate::Result;
use crate::database::value_ref_to_json;
use duckdb::{Connection, OptionalExt, named_params, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const MAX_AGE: i64 = 90 * 24 * 60 * 60 * 1000;
const MAX_BYTES: i64 = 2 * 1024 * 1024;
const MAX_RECORDS: i64 = 50;

#[derive(Default)]
struct Payloads {
    indexes: HashMap<String, usize>,
    values: Vec<Value>,
    raw: Map<String, Value>,
}

impl Payloads {
    fn intern(&mut self, raw: &str) -> usize {
        if let Some(&index) = self.indexes.get(raw) {
            return index;
        }
        let index = self.values.len();
        let value = match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(_) => {
                // JavaScript also accepts escaped lone UTF-16 code units in excerpts.
                self.raw.insert(index.to_string(), raw.into());
                Value::Null
            }
        };
        self.values.push(value);
        self.indexes.insert(raw.to_owned(), index);
        index
    }
}

pub fn read(db: &Connection, task_id: &str, limit: u32) -> Result<Value> {
    let mut statement = db.prepare(
        "SELECT s.id, s.task_id, s.user_message_id, s.assistant_message_id, s.created_at, s.schema_version,
                s.welcome_mode, s.tag_id, s.project_id, s.project_updated_at, s.execution_id, s.status,
                s.started_at, s.completed_at, s.error, s.assembly_hash, s.model_id, s.permission_mode,
                s.working_directory, s.storage_bytes,
                COALESCE(instructions.body, s.resolved_instructions_json) AS resolved_instructions_json,
                COALESCE(capabilities.body, s.resolved_capabilities_json) AS resolved_capabilities_json,
                s.warnings_json, s.material_usage_json
         FROM task_runtime_context_snapshots s
         LEFT JOIN runtime_audit_payloads instructions ON instructions.hash = s.instructions_hash
         LEFT JOIN runtime_audit_payloads capabilities ON capabilities.hash = s.capabilities_hash
         WHERE s.task_id = ?1 ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?2",
    )?;
    let mut result = statement.query(params![task_id, limit.clamp(1, 200)])?;
    let columns: Vec<String> = result
        .as_ref()
        .map(|s| s.column_names())
        .unwrap_or_default();
    let mut rows = Vec::new();
    let mut payloads = Payloads::default();
    while let Some(row) = result.next()? {
        let mut metadata = Map::new();
        let mut bytes = 0;
        for (index, name) in columns.iter().enumerate() {
            let val_ref = row.get_ref(index)?;
            let value = match val_ref {
                duckdb::types::ValueRef::Text(text) if name.ends_with("_json") => {
                    if name != "material_usage_json" {
                        bytes += text.len();
                    }
                    payloads.intern(std::str::from_utf8(text)?).into()
                }
                other => value_ref_to_json(other)?,
            };
            metadata.insert(name.clone(), value);
        }
        metadata.entry("storage_bytes").and_modify(|stored| {
            if stored.is_null() {
                *stored = bytes.into();
            }
        });
        rows.push(Value::Object(metadata));
    }
    let mut page = json!({ "rows": rows, "payloads": payloads.values });
    if !payloads.raw.is_empty() {
        page["rawPayloads"] = Value::Object(payloads.raw);
    }
    Ok(page)
}

pub fn compact(db: &mut Connection, limit: u32) -> Result<usize> {
    let transaction = db.transaction()?;
    let migrated = {
        let mut select = transaction.prepare(
            "SELECT id, resolved_instructions_json, resolved_capabilities_json, instructions_hash, capabilities_hash
             FROM task_runtime_context_snapshots
             WHERE instructions_hash IS NULL OR capabilities_hash IS NULL ORDER BY created_at,id LIMIT ?1",
        )?;
        let mut insert = transaction.prepare(
            "INSERT INTO runtime_audit_payloads(hash, body) VALUES (?1, ?2) ON CONFLICT(hash) DO NOTHING",
        )?;
        let mut update = transaction.prepare(
            "UPDATE task_runtime_context_snapshots
             SET resolved_instructions_json = '[]', resolved_capabilities_json = '[]',
                 instructions_hash = ?1, capabilities_hash = ?2 WHERE id = ?3",
        )?;
        // Finish reading the index before updating rows that would disappear from it.
        let rows = select
            .query_map([limit.clamp(1, 32)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<duckdb::Result<Vec<_>>>()?;
        let mut store = |reference: Option<String>, content: String| -> duckdb::Result<String> {
            if let Some(hash) = reference {
                return Ok(hash);
            }
            let hash = hash_payload(&content);
            insert.execute(params![hash, content])?;
            Ok(hash)
        };
        let migrated = rows.len();
        for (id, instructions, capabilities, instructions_hash, capabilities_hash) in rows {
            let instructions_hash = store(instructions_hash, instructions)?;
            let capabilities_hash = store(capabilities_hash, capabilities)?;
            update.execute(params![instructions_hash, capabilities_hash, id])?;
        }
        migrated
    };
    cleanup_payloads(&transaction)?;
    crate::request_control::commit(transaction)?;
    Ok(migrated)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInsert {
    id: String,
    execution_id: String,
    task_id: String,
    user_message_id: String,
    assistant_message_id: String,
    created_at: i64,
    schema_version: i64,
    mode: String,
    tag_id: Option<String>,
    project_id: Option<String>,
    project_updated_at: Option<i64>,
    instructions: String,
    capabilities: String,
    warnings: String,
    material_usage: String,
    status: String,
    started_at: i64,
    completed_at: Option<i64>,
    error: Option<String>,
    assembly_hash: String,
    model_id: Option<String>,
    permission_mode: Option<String>,
    working_directory: Option<String>,
    storage_bytes: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    task_id: String,
    execution_id: String,
    assistant_message_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Insert {
        snapshot: Box<SnapshotInsert>,
    },
    AppendMaterials {
        identity: Identity,
        items: Vec<Value>,
        at: i64,
    },
    Finish {
        task_id: String,
        execution_id: String,
        status: String,
        error: Option<String>,
        at: i64,
    },
    FinishByMessage {
        task_id: String,
        assistant_message_id: String,
        status: String,
        error: Option<String>,
        at: i64,
    },
    BindMessage {
        identity: Identity,
    },
    Abort {
        task_id: String,
        at: i64,
    },
    Clear {
        task_id: Option<String>,
    },
}

impl Mutation {
    pub(crate) fn task_id(&self) -> Option<&str> {
        match self {
            Self::Insert { snapshot } => Some(&snapshot.task_id),
            Self::AppendMaterials { identity, .. } | Self::BindMessage { identity } => {
                Some(&identity.task_id)
            }
            Self::Finish { task_id, .. }
            | Self::FinishByMessage { task_id, .. }
            | Self::Abort { task_id, .. } => Some(task_id),
            Self::Clear { task_id } => task_id.as_deref(),
        }
    }

    pub(crate) fn insertion_keys(&self) -> Option<(&str, &str)> {
        let Self::Insert { snapshot } = self else {
            return None;
        };
        Some((&snapshot.id, &snapshot.execution_id))
    }
}

fn hash_payload(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

fn cleanup_payloads(db: &Connection) -> duckdb::Result<()> {
    db.execute("DELETE FROM runtime_audit_payloads WHERE hash NOT IN (
        SELECT instructions_hash FROM task_runtime_context_snapshots WHERE instructions_hash IS NOT NULL
        UNION SELECT capabilities_hash FROM task_runtime_context_snapshots WHERE capabilities_hash IS NOT NULL)", [])?;
    Ok(())
}

fn prune(db: &Connection, task_id: &str, at: i64) -> duckdb::Result<()> {
    let cutoff = at.saturating_sub(MAX_AGE);
    db.execute(
            "WITH ranked AS (
               SELECT id,
                      ROW_NUMBER() OVER (ORDER BY created_at DESC, rowid DESC) AS position,
                      SUM(COALESCE(storage_bytes,0)) OVER (ORDER BY created_at DESC, rowid DESC ROWS UNBOUNDED PRECEDING) AS bytes
               FROM task_runtime_context_snapshots WHERE task_id=?1
             )
             DELETE FROM task_runtime_context_snapshots WHERE task_id=?1 AND
               (created_at<?4 OR id IN (SELECT id FROM ranked WHERE position>?2 OR (position>1 AND bytes>?3)))",
        params![task_id, MAX_RECORDS, MAX_BYTES, cutoff],
    )?;
    Ok(())
}

fn insert_snapshot(db: &Connection, row: &SnapshotInsert) -> duckdb::Result<usize> {
    let insertable = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)
            AND NOT EXISTS(SELECT 1 FROM task_runtime_context_snapshots WHERE execution_id=?2)",
        params![row.task_id, row.execution_id],
        |record| record.get::<_, bool>(0),
    )?;
    if !insertable {
        return Ok(0);
    }
    // Compact shared payloads in maintenance so identical inputs cannot couple foreground tasks.
    let changed = db.execute(
        "INSERT INTO task_runtime_context_snapshots (
            id,task_id,user_message_id,assistant_message_id,created_at,schema_version,
            welcome_mode,tag_id,project_id,project_updated_at,
            resolved_instructions_json,resolved_capabilities_json,warnings_json,
            execution_id,status,started_at,completed_at,error,assembly_hash,model_id,permission_mode,
            working_directory,material_usage_json,storage_bytes
         ) VALUES (
            $id,$task,$user,$assistant,$created,$version,$mode,$tag,$project,$project_at,
            $instructions,$capabilities,$warnings,$execution,$status,$started,$completed,
            $error,$assembly,$model,$permission,$cwd,$materials,$bytes
         )",
        named_params! {
            "id": row.id, "task": row.task_id, "user": row.user_message_id, "assistant": row.assistant_message_id,
            "created": row.created_at, "version": row.schema_version, "mode": row.mode, "tag": row.tag_id,
            "project": row.project_id, "project_at": row.project_updated_at, "instructions": row.instructions,
            "capabilities": row.capabilities, "warnings": row.warnings, "execution": row.execution_id, "status": row.status,
            "started": row.started_at, "completed": row.completed_at, "error": row.error, "assembly": row.assembly_hash,
            "model": row.model_id, "permission": row.permission_mode, "cwd": row.working_directory,
            "materials": row.material_usage, "bytes": row.storage_bytes,
        },
    )?;
    prune(db, &row.task_id, row.created_at)?;
    Ok(changed)
}

fn material_usage(usage: Value) -> Option<(Value, u64)> {
    let items = usage["items"].as_array()?;
    let omitted = usage["omitted"].as_f64()?;
    if !(0.0..=9_007_199_254_740_991.0).contains(&omitted)
        || omitted.fract() != 0.0
        || items.len() > 100
    {
        return None;
    }
    let valid = items.iter().all(|item| {
        matches!(
            item["kind"].as_str(),
            Some(
                "file-content"
                    | "knowledge-content"
                    | "web-content"
                    | "search-snippet"
                    | "metadata"
            )
        ) && ["toolCallId", "toolName", "title", "target", "outputHash"]
            .iter()
            .all(|key| item[key].is_string())
            && ["at", "returnedChars", "images"].iter().all(|key| {
                item[key]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n >= 0.0)
            })
    });
    valid.then_some((usage, omitted as u64))
}

fn append_materials(
    db: &Connection,
    identity: Identity,
    added: Vec<Value>,
    at: i64,
) -> Result<usize> {
    let row = db
        .query_row(
            "SELECT id, material_usage_json FROM task_runtime_context_snapshots
         WHERE task_id=?1 AND execution_id=?2 AND assistant_message_id=?3 AND status='running'",
            params![
                identity.task_id,
                identity.execution_id,
                identity.assistant_message_id
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if let Some((id, Some(raw))) = row {
        if let Some((mut usage, mut omitted)) = material_usage(serde_json::from_str(&raw)?) {
            let items = usage["items"]
                .as_array_mut()
                .expect("validated material list");
            for item in added {
                if items.iter().any(|old| {
                    ["toolCallId", "target", "kind"]
                        .iter()
                        .all(|key| old[key] == item[key])
                }) {
                    continue;
                }
                if items.len() >= 100 {
                    omitted += 1;
                } else {
                    items.push(item);
                }
            }
            usage["omitted"] = omitted.into();
            let json = serde_json::to_string(&usage)?;
            db.execute(
                "UPDATE task_runtime_context_snapshots SET material_usage_json=?1,storage_bytes=storage_bytes+?2 WHERE id=?3",
                params![json, json.len() as i64 - raw.len() as i64, id],
            )?;
        }
    }
    prune(db, &identity.task_id, at)?;
    Ok(0)
}

pub(crate) fn receipt(db: &Connection, write_id: &str) -> duckdb::Result<Option<usize>> {
    db.query_row(
        "SELECT result FROM runtime_snapshot_receipts WHERE write_id=?",
        [write_id],
        |row| row.get(0),
    )
    .optional()
}

pub fn mutate(db: &mut Connection, write_id: &str, mutation: Mutation) -> Result<usize> {
    let mut digest = Sha256::new();
    serde_json::to_writer(&mut digest, &mutation)?;
    let request_hash = format!("{:x}", digest.finalize());
    let task_id = mutation.task_id().map(str::to_owned);
    let tx = db.transaction()?;
    let previous: Option<(String, usize)> = tx
        .query_row(
            "SELECT request_hash,result FROM runtime_snapshot_receipts WHERE write_id=?",
            [write_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((saved_hash, result)) = previous {
        if saved_hash != request_hash {
            return Err("快照操作 ID 已用于另一笔写入".into());
        }
        return Ok(result);
    }
    if let Some(id) = &task_id
        && !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?)",
            [id],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Ok(0);
    }
    let result = match mutation {
        Mutation::Insert { snapshot } => insert_snapshot(&tx, &snapshot)?,
        Mutation::AppendMaterials { identity, items, at } => append_materials(&tx, identity, items, at)?,
        Mutation::Finish { task_id, execution_id, status, error, at } => tx.execute(
            "UPDATE task_runtime_context_snapshots SET status=?1,completed_at=?2,error=?3
             WHERE execution_id=?4 AND task_id=?5 AND status='running'", params![status, at, error, execution_id, task_id],
        )?,
        Mutation::FinishByMessage { task_id, assistant_message_id, status, error, at } => tx.execute(
            "UPDATE task_runtime_context_snapshots SET status=?1,completed_at=?2,error=?3
             WHERE task_id=?4 AND assistant_message_id=?5 AND status='running'", params![status, at, error, task_id, assistant_message_id],
        )?,
        Mutation::BindMessage { identity } => tx.execute(
            "UPDATE task_runtime_context_snapshots SET assistant_message_id=?1 WHERE task_id=?2 AND execution_id=?3",
            params![identity.assistant_message_id, identity.task_id, identity.execution_id],
        )?,
        Mutation::Abort { task_id, at } => tx.execute(
            "UPDATE task_runtime_context_snapshots SET status='aborted',completed_at=?1 WHERE task_id=?2 AND status='running'",
            params![at, task_id],
        )?,
        Mutation::Clear { task_id: Some(task_id) } => tx.execute("DELETE FROM task_runtime_context_snapshots WHERE task_id=?1", [task_id])?,
        Mutation::Clear { task_id: None } => {
            let removed = tx.execute("DELETE FROM task_runtime_context_snapshots", [])?;
            cleanup_payloads(&tx)?;
            removed
        },
    };
    tx.execute(
        "INSERT INTO runtime_snapshot_receipts(write_id,task_id,request_hash,result) VALUES (?,?,?,?)",
        params![write_id, task_id, request_hash, result],
    )?;
    crate::request_control::commit(tx)?;
    Ok(result)
}
