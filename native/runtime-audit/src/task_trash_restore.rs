use crate::Result;
use duckdb::{Connection, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restore {
    task_id: String,
    directory_name: String,
    expected_updated_at: f64,
    expected_trashed_at: Option<f64>,
    expected_trash_path: Option<String>,
    cwd: Option<String>,
    at: i64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Saved,
    Rejected { message: String },
}

pub fn restore(db: &mut Connection, request: Restore) -> Reply {
    match apply(db, request) {
        Ok(()) => Reply::Saved,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, request: Restore) -> Result<()> {
    let id = &request.task_id;
    if id.trim().is_empty()
        || id == crate::DOTS_TASK_ID
        || id.strip_prefix("gateway-chat-").is_some_and(|suffix| {
            suffix.len() == 64
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
    {
        return Err("任务不支持普通回收恢复".into());
    }

    let tx = db.transaction()?;
    let restored = tx.execute(
        "UPDATE task_execution_workspace_state SET directory_name=?2,state='active',updated_at=?6,
             trashed_at=NULL,purge_after=NULL,trash_path=NULL
         WHERE task_id=?1 AND state='trashed' AND updated_at IS NOT DISTINCT FROM ?3 AND trashed_at IS NOT DISTINCT FROM ?4 AND trash_path IS NOT DISTINCT FROM ?5",
        params![id, request.directory_name, request.expected_updated_at, request.expected_trashed_at, request.expected_trash_path, request.at],
    )?;
    if restored != 1 {
        return Err(format!("恢复中止：回收站条目已变化：{id}").into());
    }

    if let Some(cwd) = request.cwd {
        let title = if id.starts_with("gw-") {
            "助理消息"
        } else if id.starts_with("cron-") {
            "定时任务"
        } else {
            "新任务"
        };
        tx.execute(
            "INSERT INTO tasks (id,title,updated_at,cwd) VALUES (?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET archived=0,updated_at=GREATEST(tasks.updated_at, excluded.updated_at),cwd=excluded.cwd",
            params![id, title, request.at, cwd],
        )?;
    } else {
        tx.execute(
            "UPDATE tasks SET archived=0,updated_at=GREATEST(updated_at, ?2) WHERE id=?1",
            params![id, request.at],
        )?;
    }

    tx.commit()?;
    Ok(())
}
