use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    task_id: String,
    conversation_id: String,
    generation_task_id: i64,
    tool_task_id: i64,
    path: String,
    digest: String,
    snapshot_path: String,
    manifest_path: Option<String>,
    registered_at: i64,
}

impl Source {
    pub(crate) fn task_id(&self) -> &str {
        &self.task_id
    }

    fn artifact_id(&self) -> Result<Option<String>> {
        if self.digest.len() != 64
            || !self.digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !Path::new(&self.path).is_absolute()
            || !Path::new(&self.snapshot_path).is_absolute()
            || self.generation_task_id <= 0
            || self.tool_task_id <= 0
            || self.registered_at < 0
        {
            return Ok(None);
        }
        let manifest = self.manifest_path.as_deref().map(Path::new);
        if manifest.is_some_and(|path| !path.is_absolute() || path.file_name().is_none()) {
            return Ok(None);
        }
        let filename = manifest.and_then(Path::file_name).and_then(|name| name.to_str());
        let identity = serde_json::to_vec(&json!([self.path, self.digest, filename]))?;
        Ok(Some(format!("{:x}", Sha256::digest(identity))))
    }

    fn matching_delivery(&self, record: &Value) -> Option<bool> {
        let evidence = &record["evidence"];
        if record["toolTaskId"].as_i64() != Some(self.tool_task_id)
            || evidence["kind"] != "delivery"
            || evidence["path"].as_str() != Some(self.path.as_str())
            || evidence["digest"].as_str() != Some(self.digest.as_str())
        {
            return None;
        }
        let saved = &evidence["saved"];
        if saved.is_null() {
            return Some(true);
        }
        (saved["snapshotPath"].as_str() == Some(self.snapshot_path.as_str())
            && saved["manifestPath"].as_str() == self.manifest_path.as_deref()
            && saved["registeredAt"].as_i64() == Some(self.registered_at))
            .then_some(false)
    }
}

pub(super) fn confirm(
    tx: &Connection,
    work_id: &str,
    task_id: &str,
    user_id: &str,
    artifact_id: &str,
    expected_intent_revision: i64,
    source: &Source,
) -> Result<Value> {
    let missing = || json!({"status":"missing"});
    let revision: Option<i64> = tx.query_row(
        "SELECT w.intent_revision FROM works w JOIN work_conversations c ON c.work_id=w.work_id
         JOIN tasks t ON t.id=c.conversation_id WHERE w.work_id=?1 AND w.user_id=?2 AND t.id=?3
         AND NOT EXISTS (SELECT 1 FROM task_execution_workspace_state s WHERE s.task_id=t.id AND s.state='trashed')",
        params![work_id, user_id, task_id], |row| row.get(0),
    ).optional()?;
    let Some(revision) = revision else { return Ok(missing()); };
    if revision != expected_intent_revision {
        return Ok(json!({"status":"stale"}));
    }
    if source.artifact_id()?.as_deref() != Some(artifact_id) {
        return Ok(missing());
    }
    let scoped_tasks = crate::conversation_runtime_data::SCOPED_TASKS;
    let directory: Option<String> = tx.query_row(
        &format!("{scoped_tasks} SELECT b.directory FROM conversation_goal_generations g
         JOIN work_conversations c ON c.work_id=g.work_id AND c.conversation_id=g.task_id
         JOIN scoped_tasks t ON t.id=g.task_id
         JOIN durable_bot_bindings b ON b.task_id=t.id AND b.backend='pi-durable'
         WHERE g.work_id=?2 AND g.task_id=?3 AND g.conversation_id=?4 AND g.generation_id=?5"),
        params![task_id, work_id, source.task_id, source.conversation_id, source.generation_task_id], |row| row.get(0),
    ).optional()?;
    let Some(directory) = directory else { return Ok(missing()); };
    let store = crate::durable::store_id_for_path(Path::new(&directory));
    if crate::pi_storage::live_incarnation_key(tx, &store)?.is_none() {
        return Ok(missing());
    }
    let key = serde_json::to_string(&json!([source.conversation_id, source.generation_task_id]))?;
    let Some(document) = crate::pi_storage::current_session_document(tx, &store, "mybuddy.pstack-goal-evidence", &key)? else {
        return Ok(missing());
    };
    let Some(legacy) = document["events"].as_array().into_iter().flatten()
        .filter_map(|record| source.matching_delivery(record)).min() else {
        return Ok(missing());
    };
    let registered: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM durable_entries e WHERE e.store_id=?1 AND e.kind='mybuddy.artifact-registered'
           AND json_extract_string(e.record_json,'$.data.path')=?2
           AND json_extract_string(e.record_json,'$.data.digest')=?3
           AND json_extract_string(e.record_json,'$.data.snapshotPath')=?4
           AND json_extract_string(e.record_json,'$.data.previewManifestPath') IS NOT DISTINCT FROM ?5
           AND TRY_CAST(json_extract(e.record_json,'$.data.toolTaskId') AS BIGINT)=?6
           AND TRY_CAST(json_extract(e.record_json,'$.data.registeredAt') AS BIGINT)=?7
           AND (NOT ?8 OR NOT contains(json_extract_string(e.record_json,'$.data.toolCallId'),'#web-bundle:')))",
        params![store, source.path, source.digest, source.snapshot_path, source.manifest_path,
            source.tool_task_id, source.registered_at, legacy], |row| row.get(0),
    )?;
    if !registered {
        return Ok(missing());
    }
    let now = i64::try_from(crate::request_control::now_ms())?;
    tx.execute(
        "INSERT INTO conversation_goal_saved_artifact_verification(work_id,artifact_id,verified_at)
         VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
        params![work_id, artifact_id, now],
    )?;
    let verified_at: i64 = tx.query_row(
        "SELECT verified_at FROM conversation_goal_saved_artifact_verification WHERE work_id=?1 AND artifact_id=?2",
        params![work_id, artifact_id], |row| row.get(0),
    )?;
    Ok(json!({"status":"confirmed","verifiedAt":verified_at}))
}
