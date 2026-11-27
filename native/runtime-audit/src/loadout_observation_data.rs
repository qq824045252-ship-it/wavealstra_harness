use crate::{Result, sqlite_rows::records};
use duckdb::{Connection, params};
use serde_json::Value;

pub fn read(db: &Connection, task_id: &str, limit: i64) -> Result<Value> {
    let rows = records(
        db,
        "SELECT id,task_id,user_message_id,assistant_message_id,query_hash,context_json,
                recommended_json,actual_json,matched_actual_json,not_selected_json,blocked_json,
                used_skill_ids_json,outcome,created_at,updated_at,completed_at
         FROM agent_loadout_observations WHERE task_id=?1
         ORDER BY created_at DESC,rowid DESC LIMIT ?2",
        params![task_id, limit.clamp(1, 200)],
    )?;
    Ok(Value::Array(rows))
}
