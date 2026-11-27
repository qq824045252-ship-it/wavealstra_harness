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
    gateway: Option<Gateway>,
    at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Gateway {
    channel: String,
    version: String,
    destination: String,
    move_from: Option<String>,
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
    let gateway_id = id.strip_prefix("gateway-chat-").is_some_and(|suffix| {
        suffix.len() == 64 && suffix.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    });
    if id.trim().is_empty() || id == crate::DOTS_TASK_ID || gateway_id != request.gateway.is_some() {
        return Err("任务恢复类型错误".into());
    }
    let tx = db.transaction()?;
    if let Some(gateway) = &request.gateway {
        let owned: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks t JOIN gateway_sidebar_conversations g ON g.task_id=t.id
             WHERE t.id=? AND t.space_id=? AND g.channel_id=?)",
            params![id, format!("sp-gw-{}", gateway.channel), gateway.channel], |r| r.get(0))?;
        if !owned || !crate::task_workspace_authority::matches_version(&tx, id, &gateway.version)? {
            return Err("渠道任务归属或工作目录绑定已变化".into());
        }
        if let Some(from) = &gateway.move_from {
            tx.execute("INSERT INTO durable_bot_workspace_moves(task_id,from_cwd,to_cwd) VALUES (?,?,?)",
                params![id, from, gateway.destination])?;
        } else {
            tx.execute("UPDATE tasks SET cwd=? WHERE id=?", params![gateway.destination, id])?;
        }
    }
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
