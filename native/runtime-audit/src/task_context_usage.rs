use crate::Result;
use duckdb::{Connection, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    task_id: String,
    used_tokens: Option<f64>,
    context_window: f64,
    cache_hit_rate: Option<f64>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Saved,
    Rejected { message: String },
}

pub fn write(db: &mut Connection, snapshots: &[Snapshot]) -> Reply {
    match apply(db, snapshots) {
        Ok(()) => Reply::Saved,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, snapshots: &[Snapshot]) -> Result<()> {
    let tx = db.transaction()?;
    {
        let mut statement = tx.prepare(
            "UPDATE tasks SET context_used_tokens=?2, context_window_tokens=?3,
             context_cache_hit_rate=?4 WHERE id=?1",
        )?;
        for snapshot in snapshots {
            statement.execute(params![
                snapshot.task_id,
                snapshot.used_tokens,
                snapshot.context_window,
                snapshot.cache_hit_rate,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}
