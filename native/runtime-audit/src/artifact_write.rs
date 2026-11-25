use crate::{
    Result,
    artifact_content::{self, Content, Pending},
    sqlite_rows::records,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Register {
        row: ArtifactRow,
    },
    Refresh {
        ids: Vec<String>,
        at: i64,
        message_id: Option<String>,
        tool_call_id: Option<String>,
    },
    Remove {
        id: Option<String>,
        require_trashed: bool,
    },
}

#[derive(Deserialize)]
pub struct ArtifactRow {
    id: String,
    task_id: String,
    space_id: Option<String>,
    kind: String,
    source_type: String,
    entry_file: Option<String>,
    root_dir: String,
    storage_path: Option<String>,
    version: i64,
    capabilities_json: String,
    title: Option<String>,
    mime_type: Option<String>,
    created_by_message_id: Option<String>,
    created_by_tool_call_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ManagedWrite {
    Saved { revision: i64 },
    Failed { message: String },
}

pub fn write_managed(
    db: &mut Connection,
    task_id: &str,
    operation_id: &str,
    row: ArtifactRow,
    content: Content,
) -> Result<ManagedWrite> {
    let mut pending = None;
    let result = write_managed_inner(db, task_id, operation_id, row, content, &mut pending);
    match result {
        Ok(revision) => {
            if let Some(pending) = pending {
                pending.finish();
            }
            Ok(ManagedWrite::Saved { revision })
        }
        Err(error) => {
            if let Some(pending) = pending {
                // Verify the receipt after the transaction drops before deleting anything.
                let recovery = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                if let Some(value) = receipt(&recovery, task_id, operation_id)? {
                    pending.finish();
                    return Ok(ManagedWrite::Saved {
                        revision: registration_revision(&value)?,
                    });
                }
                pending.discard();
            }
            Ok(ManagedWrite::Failed {
                message: error.to_string(),
            })
        }
    }
}

fn write_managed_inner(
    db: &mut Connection,
    task_id: &str,
    operation_id: &str,
    row: ArtifactRow,
    content: Content,
    pending: &mut Option<Pending>,
) -> Result<i64> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(value) = receipt(&tx, task_id, operation_id)? {
        return registration_revision(&value);
    }
    if row.source_type != "managed-content" || row.task_id != task_id {
        return Err("成果受管内容与任务不一致".into());
    }
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=?)",
        [&row.id],
        |row| row.get::<_, bool>(0),
    )? {
        return Err("Artifact ID 已存在（register 不做 upsert，请用 update）".into());
    }
    let bytes = content
        .bytes(&tx, task_id)
        .map_err(|error| format!("materialize 失败: {error}"))?;
    if bytes.is_empty() {
        return Err("managed-content 注册必须提供非空 content".into());
    }
    let storage = row.storage_path.as_deref().ok_or("成果缺少受管路径")?;
    let (draft, path) = Pending::prepare(
        std::path::Path::new(&row.root_dir),
        storage,
        task_id,
        &row.id,
        operation_id,
    )
    .map_err(|error| format!("materialize 失败: {error}"))?;
    *pending = Some(draft);
    artifact_content::write_new(&path, &bytes)
        .map_err(|error| format!("materialize 失败: {error}"))?;
    let value =
        register(&tx, task_id, row).map_err(|error| format!("metadata 写入失败: {error}"))?;
    store_receipt(&tx, task_id, operation_id, &value)
        .map_err(|error| format!("metadata 写入失败: {error}"))?;
    let revision = registration_revision(&value)?;
    tx.commit()
        .map_err(|error| format!("metadata 写入失败: {error}"))?;
    Ok(revision)
}

fn registration_revision(value: &Value) -> Result<i64> {
    value["revision"]
        .as_i64()
        .ok_or_else(|| "成果登记回执缺少版本".into())
}

fn bump_revision(db: &Connection, task_id: &str) -> Result<i64> {
    Ok(db.query_row(
        "INSERT INTO artifact_task_revisions(task_id,revision) VALUES(?1,1)
        ON CONFLICT(task_id) DO UPDATE SET revision=revision+1 RETURNING revision",
        [task_id],
        |row| row.get(0),
    )?)
}

fn register(db: &Connection, task_id: &str, row: ArtifactRow) -> Result<Value> {
    if row.task_id != task_id {
        return Err("artifact task mismatch".into());
    }
    db.execute("INSERT INTO artifacts (id,task_id,space_id,kind,source_type,entry_file,root_dir,
        storage_path,version,capabilities_json,title,mime_type,created_by_message_id,created_by_tool_call_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params![row.id, row.task_id, row.space_id, row.kind,
            row.source_type, row.entry_file, row.root_dir, row.storage_path, row.version, row.capabilities_json,
            row.title, row.mime_type, row.created_by_message_id, row.created_by_tool_call_id, row.created_at, row.updated_at])?;
    if let Some(message_id) = row.created_by_message_id {
        db.execute("INSERT INTO artifact_message_refs (task_id,message_id,artifact_id,relation,tool_call_id,created_at)
            VALUES (?,?,?,'created',?,?)", params![task_id, message_id, row.id, row.created_by_tool_call_id, row.created_at])?;
    }
    Ok(json!({ "revision": bump_revision(db, task_id)? }))
}

fn refresh(
    db: &Connection,
    task_id: &str,
    ids: &[String],
    at: i64,
    message_id: Option<&str>,
    tool_call_id: Option<&str>,
) -> Result<Value> {
    let mut items = Vec::new();
    let mut update = db.prepare_cached(
        "UPDATE artifacts SET version=version+1, updated_at=?3 WHERE id=?1 AND task_id=?2
         AND (?4 IS NULL OR created_by_message_id IS NOT ?4)",
    )?;
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id) || update.execute(params![id, task_id, at, message_id])? == 0 {
            continue;
        }
        if let Some(message_id) = message_id {
            db.execute("INSERT OR IGNORE INTO artifact_message_refs (task_id,message_id,artifact_id,relation,tool_call_id,created_at)
                VALUES (?,?,?,'updated',?,?)", params![task_id, message_id, id, tool_call_id, at])?;
        }
        let row = records(db, "SELECT * FROM artifacts WHERE id=?", [id])?
            .pop()
            .ok_or("artifact missing after refresh")?;
        items.push(json!({ "row": row, "revision": bump_revision(db, task_id)? }));
    }
    Ok(json!({ "items": items }))
}

fn remove(
    db: &Connection,
    task_id: &str,
    id: Option<&str>,
    require_trashed: bool,
) -> Result<Value> {
    if require_trashed
        && db
            .query_row(
                "SELECT 1 FROM task_execution_workspace_state WHERE task_id=? AND state='trashed'",
                [task_id],
                |_| Ok(()),
            )
            .optional()?
            .is_none()
    {
        return Ok(json!({ "allowed": false, "revision": null, "items": [] }));
    }
    let items = records(
        db,
        "SELECT id, CASE WHEN source_type='managed-content' THEN storage_path END AS storagePath
        FROM artifacts WHERE task_id=?1 AND (?2 IS NULL OR id=?2) ORDER BY created_at,rowid",
        params![task_id, id],
    )?;
    if id.is_some() && items.is_empty() {
        return Ok(json!({ "allowed": true, "revision": null, "items": items }));
    }
    db.execute(
        "DELETE FROM artifacts WHERE task_id=?1 AND (?2 IS NULL OR id=?2)",
        params![task_id, id],
    )?;
    Ok(json!({ "allowed": true, "revision": bump_revision(db, task_id)?, "items": items }))
}

pub fn write(
    db: &mut Connection,
    task_id: &str,
    operation_id: &str,
    mutation: Mutation,
) -> Result<Value> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(receipt) = receipt(&tx, task_id, operation_id)? {
        return Ok(receipt);
    }
    let result = match mutation {
        Mutation::Register { row } => register(&tx, task_id, row)?,
        Mutation::Refresh {
            ids,
            at,
            message_id,
            tool_call_id,
        } => refresh(
            &tx,
            task_id,
            &ids,
            at,
            message_id.as_deref(),
            tool_call_id.as_deref(),
        )?,
        Mutation::Remove {
            id,
            require_trashed,
        } => remove(&tx, task_id, id.as_deref(), require_trashed)?,
    };
    store_receipt(&tx, task_id, operation_id, &result)?;
    tx.commit()?;
    Ok(result)
}

fn receipt(db: &Connection, task_id: &str, operation_id: &str) -> Result<Option<Value>> {
    let value: Option<String> = db
        .query_row(
            "SELECT result_json FROM artifact_write_receipts WHERE task_id=? AND operation_id=?",
            params![task_id, operation_id],
            |row| row.get(0),
        )
        .optional()?;
    value
        .map(|value| Ok(serde_json::from_str(&value)?))
        .transpose()
}

fn store_receipt(db: &Connection, task_id: &str, operation_id: &str, value: &Value) -> Result<()> {
    db.execute("INSERT INTO artifact_write_receipts (task_id,operation_id,result_json) VALUES (?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET operation_id=excluded.operation_id,result_json=excluded.result_json",
        params![task_id, operation_id, serde_json::to_string(value)?])?;
    Ok(())
}
