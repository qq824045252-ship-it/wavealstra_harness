use crate::Result;
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Mutation {
    Rename {
        id: String,
        name: String,
        at: i64,
    },
    Icon {
        id: String,
        icon: Option<Appearance>,
    },
}

#[derive(Deserialize)]
pub struct Appearance {
    shape: String,
    color: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Saved,
    Rejected { message: String },
}

pub fn write(db: &mut Connection, request: Mutation) -> Reply {
    match apply(db, request) {
        Ok(()) => Reply::Saved,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, request: Mutation) -> Result<()> {
    match request {
        Mutation::Rename { id, name, at } => {
            db.execute(
                "UPDATE spaces SET name=?2, updated_at=max(updated_at,?3) WHERE id=?1",
                params![id, name, at],
            )?;
        }
        Mutation::Icon { id, icon } => {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let space_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM spaces WHERE id=?1)",
                [&id],
                |row| row.get(0),
            )?;
            if !space_exists {
                return Err(format!("空间不存在：{id}").into());
            }
            if let Some(icon) = icon {
                tx.execute(
                    "INSERT INTO workspace_icons(workspace_id,shape,color) VALUES(?1,?2,?3)
                     ON CONFLICT(workspace_id) DO UPDATE SET shape=excluded.shape,color=excluded.color",
                    params![id, icon.shape, icon.color],
                )?;
            } else {
                tx.execute("DELETE FROM workspace_icons WHERE workspace_id=?1", [&id])?;
            }
            tx.commit()?;
        }
    }
    Ok(())
}
