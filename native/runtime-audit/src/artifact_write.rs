use crate::{
    Result,
    artifact_content::{self, Content, Pending},
    sqlite_rows::records,
};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Register {
        row: ArtifactRow,
    },
    RegisterWorkspaceOutput {
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

#[derive(Deserialize, Serialize)]
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
    let hash = request_hash(&("managed", &row, &content))?;
    let mut pending = None;
    let result = write_managed_inner(db, task_id, operation_id, &hash, row, content, &mut pending);
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
                let recovery = db.transaction()?;
                if let Some(value) = replay(&recovery, task_id, operation_id, &hash)? {
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
    hash: &str,
    row: ArtifactRow,
    content: Content,
    pending: &mut Option<Pending>,
) -> Result<i64> {
    let tx = db.transaction()?;
    if let Some(value) = replay(&tx, task_id, operation_id, hash)? {
        return registration_revision(&value);
    }
    if row.source_type != "managed-content" || row.task_id != task_id {
        return Err("成果受管内容与任务不一致".into());
    }
    require_active_task(&tx, task_id)?;
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
    store_receipt(&tx, task_id, operation_id, hash, &value)
        .map_err(|error| format!("metadata 写入失败: {error}"))?;
    let revision = registration_revision(&value)?;
    crate::request_control::commit(tx).map_err(|error| format!("metadata 写入失败: {error}"))?;
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
    crate::trigger_effects::on_artifact_board_event_in_tx(
        db,
        task_id,
        row.updated_at,
        row.title.as_deref(),
    )?;
    Ok(json!({ "revision": bump_revision(db, task_id)? }))
}

fn require_active_task(db: &Connection, task_id: &str) -> Result<()> {
    let exists = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.id=?1 AND NOT EXISTS (
            SELECT 1 FROM task_execution_workspace_state s WHERE s.task_id=t.id AND s.state='trashed'))",
        [task_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        return Err("成果所属任务不存在或已移至回收站".into());
    }
    Ok(())
}

fn register_workspace_output(db: &Connection, task_id: &str, row: ArtifactRow) -> Result<Value> {
    require_active_task(db, task_id)?;
    let entry_file = row
        .entry_file
        .as_deref()
        .filter(|path| !path.is_empty())
        .ok_or("工作区成果缺少入口文件")?;
    if row.task_id != task_id || row.source_type != "workspace-file" {
        return Err("工作区成果与任务不一致".into());
    }
    let mut matches = records(
        db,
        "SELECT * FROM artifacts WHERE task_id=?1 AND source_type='workspace-file'
         AND lower(replace(entry_file, chr(92), '/'))=lower(replace(?2, chr(92), '/'))
         ORDER BY created_at,rowid LIMIT 1",
        params![task_id, entry_file],
    )?;
    if let Some(existing) = matches.pop() {
        if let Some(message_id) = row.created_by_message_id {
            db.execute("INSERT INTO artifact_message_refs (task_id,message_id,artifact_id,relation,tool_call_id,created_at)
                VALUES (?,?,?,'updated',?,?) ON CONFLICT DO NOTHING",
                params![task_id, message_id, existing["id"].as_str(), row.created_by_tool_call_id, row.created_at])?;
        }
        return Ok(json!({ "status": "reused", "row": existing }));
    }
    let created = register(db, task_id, row)?;
    Ok(json!({ "status": "created", "revision": created["revision"] }))
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
    let mut update = db.prepare(
        "UPDATE artifacts SET version=version+1, updated_at=?3 WHERE id=?1 AND task_id=?2
         AND (?4 IS NULL OR created_by_message_id IS DISTINCT FROM ?4)",
    )?;
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id) || update.execute(params![id, task_id, at, message_id])? == 0 {
            continue;
        }
        if let Some(message_id) = message_id {
            db.execute("INSERT INTO artifact_message_refs (task_id,message_id,artifact_id,relation,tool_call_id,created_at)
                VALUES (?,?,?,'updated',?,?) ON CONFLICT DO NOTHING", params![task_id, message_id, id, tool_call_id, at])?;
        }
        let row = records(db, "SELECT * FROM artifacts WHERE id=?", [id])?
            .pop()
            .ok_or("artifact missing after refresh")?;
        crate::trigger_effects::on_artifact_board_event_in_tx(
            db,
            task_id,
            at,
            row["title"].as_str(),
        )?;
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
    delete_artifacts(db, task_id, id)?;
    Ok(json!({ "allowed": true, "revision": bump_revision(db, task_id)?, "items": items }))
}

pub(crate) fn delete_artifacts(db: &Connection, task_id: &str, id: Option<&str>) -> Result<()> {
    for sql in [
        "DELETE FROM artifact_file_dependencies WHERE artifact_id IN
            (SELECT id FROM artifacts WHERE task_id=?1 AND (?2 IS NULL OR id=?2))",
        "DELETE FROM artifact_message_refs WHERE task_id=?1 AND (?2 IS NULL OR artifact_id=?2)",
        "DELETE FROM artifacts WHERE task_id=?1 AND (?2 IS NULL OR id=?2)",
    ] {
        db.execute(sql, params![task_id, id])?;
    }
    Ok(())
}

pub fn write(
    db: &mut Connection,
    task_id: &str,
    operation_id: &str,
    mutation: Mutation,
) -> Result<Value> {
    let hash = request_hash(&("metadata", &mutation))?;
    let tx = db.transaction()?;
    if let Some(receipt) = replay(&tx, task_id, operation_id, &hash)? {
        return Ok(receipt);
    }
    let result = match mutation {
        Mutation::Register { row } => {
            require_active_task(&tx, task_id)?;
            if row.source_type != "workspace-file" {
                return Err("受管成果须通过内容写入登记".into());
            }
            register(&tx, task_id, row)?
        }
        Mutation::RegisterWorkspaceOutput { row } => register_workspace_output(&tx, task_id, row)?,
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
    store_receipt(&tx, task_id, operation_id, &hash, &result)?;
    crate::request_control::commit(tx)?;
    Ok(result)
}

fn request_hash(request: &impl Serialize) -> Result<String> {
    let mut digest = Sha256::new();
    serde_json::to_writer(&mut digest, request)?;
    Ok(format!("{:x}", digest.finalize()))
}

fn receipt(db: &Connection, task_id: &str, operation_id: &str) -> Result<Option<(String, String)>> {
    Ok(db
        .query_row(
            "SELECT request_hash,result_json FROM artifact_write_receipts WHERE task_id=? AND operation_id=?",
            params![task_id, operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

pub(crate) fn read_receipt(
    db: &Connection,
    task_id: &str,
    operation_id: &str,
) -> Result<Option<Value>> {
    receipt(db, task_id, operation_id)?
        .map(|(_, value)| Ok(serde_json::from_str(&value)?))
        .transpose()
}

fn replay(db: &Connection, task_id: &str, operation_id: &str, hash: &str) -> Result<Option<Value>> {
    let Some((saved_hash, value)) = receipt(db, task_id, operation_id)? else {
        return Ok(None);
    };
    if saved_hash != hash {
        return Err("成果操作 ID 已用于另一笔写入".into());
    }
    Ok(Some(serde_json::from_str(&value)?))
}

fn store_receipt(
    db: &Connection,
    task_id: &str,
    operation_id: &str,
    hash: &str,
    value: &Value,
) -> Result<()> {
    db.execute("INSERT INTO artifact_write_receipts (task_id,operation_id,request_hash,result_json) VALUES (?,?,?,?)",
        params![task_id, operation_id, hash, serde_json::to_string(value)?])?;
    Ok(())
}
