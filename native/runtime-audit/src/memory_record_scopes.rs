use super::{DOTS_TASK_ID, Reply, Scope, assert_scope, forget};
use crate::{Result, memory_records_data};
use duckdb::{Connection, params};

pub(super) fn promote(
    db: &mut Connection,
    id: &str,
    scope: Scope,
    user_id: &str,
    now: i64,
) -> Result<Reply> {
    let tx = db.transaction()?;
    if !tx
        .prepare("SELECT 1 FROM memory_records WHERE id=?1")?
        .exists([id])?
    {
        return Err(format!("记忆不存在：{id}").into());
    }
    assert_scope(&tx, &scope, user_id)?;
    tx.prepare(
        "INSERT INTO memory_scopes(id,memory_id,scope_type,scope_id,binding,created_at)
         VALUES (?1,?2,?3,?4,'promoted',?5)
         ON CONFLICT DO NOTHING",
    )?
    .execute(params![scope.id, id, scope.scope_type, scope.scope_id, now])?;
    invalidate_scope(&tx, &scope.scope_type, scope.scope_id.as_deref(), now)?;
    forget::invalidate_skills(&tx, id, now)?;
    let mut detail = memory_records_data::detail(&tx, id)?;
    if detail.is_null() {
        return Ok(Reply::NeedsHost);
    }
    let record = detail["record"].take();
    if record.is_null() {
        return Err(format!("记忆保存后不可读取：{id}").into());
    }
    tx.commit()?;
    Ok(Reply::Applied { record })
}

pub(super) fn detach(
    db: &mut Connection,
    id: &str,
    scope_type: &str,
    scope_id: Option<&str>,
    withdrawal: forget::Withdrawal,
) -> Result<Reply> {
    let tx = db.transaction()?;
    if scope_type == "project"
        && tx
            .prepare("SELECT 1 FROM projects WHERE id=?1 AND archived=1")?
            .exists([scope_id])?
    {
        return Err("项目已归档（只读），不能修改其关联记忆".into());
    }
    if !forget::matches_snapshot(&tx, id, &withdrawal)? {
        return Ok(Reply::Stale);
    }
    if !tx
        .prepare(
            "SELECT 1 FROM memory_scopes WHERE memory_id=?1 AND scope_type=?2 AND scope_id IS NOT DISTINCT FROM ?3",
        )?
        .exists(params![id, scope_type, scope_id])?
    {
        return Err("作用域绑定不存在".into());
    }
    forget::persist_targets(&tx, id, &withdrawal, Some((scope_type, scope_id)))?;
    if scope_type == "task" && scope_id == Some(DOTS_TASK_ID) {
        forget::delete_dots_projections(&tx, id)?;
    }
    tx.prepare(
        "DELETE FROM memory_scopes WHERE memory_id=?1 AND scope_type=?2 AND scope_id IS NOT DISTINCT FROM ?3",
    )?
    .execute(params![id, scope_type, scope_id])?;
    let forgotten = !tx
        .prepare("SELECT 1 FROM memory_scopes WHERE memory_id=?1")?
        .exists([id])?;
    invalidate_scope(&tx, scope_type, scope_id, withdrawal.cutoff_at)?;
    forget::invalidate_skills(&tx, id, withdrawal.cutoff_at)?;
    if forgotten {
        forget::hard_delete(&tx, id)?;
    }
    tx.commit()?;
    Ok(Reply::Detached { forgotten })
}

fn invalidate_scope(
    db: &Connection,
    scope_type: &str,
    scope_id: Option<&str>,
    now: i64,
) -> duckdb::Result<()> {
    if matches!(scope_type, "global" | "workspace" | "project") {
        for table in ["memory_scenarios", "memory_core_profiles"] {
            db.prepare(&format!(
                "UPDATE {table} SET status='stale',updated_at=?3
                 WHERE scope_type=?1 AND scope_id IS NOT DISTINCT FROM ?2 AND status='active'",
            ))?
            .execute(params![scope_type, scope_id, now])?;
        }
    }
    if scope_type == "project" {
        db.prepare("UPDATE projects SET updated_at=GREATEST(updated_at+1, ?2) WHERE id=?1")?
            .execute(params![scope_id, now])?;
    }
    Ok(())
}
