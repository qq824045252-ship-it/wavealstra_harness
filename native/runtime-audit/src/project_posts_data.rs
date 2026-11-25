use crate::Result;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    id: String,
    project_id: String,
    body: String,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    List { project_id: String },
    Create { post: Post },
    Delete { id: String },
}

impl Request {
    pub fn is_read(&self) -> bool {
        matches!(self, Self::List { .. })
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Listed { posts: Vec<Post> },
    Saved,
    Archived,
    Rejected { message: String },
}

pub fn run(db: &mut Connection, request: Request) -> Reply {
    match apply(db, request) {
        Ok(reply) => reply,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, request: Request) -> Result<Reply> {
    let mode = if request.is_read() {
        TransactionBehavior::Deferred
    } else {
        TransactionBehavior::Immediate
    };
    let tx = db.transaction_with_behavior(mode)?;
    let reply = match request {
        Request::List { project_id } => {
            project_archived(&tx, &project_id)?;
            Reply::Listed {
                posts: list_posts(&tx, &project_id)?,
            }
        }
        Request::Create { post } => {
            if project_archived(&tx, &post.project_id)? {
                return Ok(Reply::Archived);
            }
            if post.body.is_empty() {
                return Err("留言不能为空".into());
            }
            tx.execute(
                "INSERT INTO project_posts (id, project_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![post.id, post.project_id, post.body, post.created_at],
            )?;
            Reply::Saved
        }
        Request::Delete { id } => {
            let project_id: Option<String> = tx
                .query_row(
                    "SELECT project_id FROM project_posts WHERE id = ?1",
                    [&id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(project_id) = project_id {
                if project_archived(&tx, &project_id)? {
                    return Ok(Reply::Archived);
                }
                tx.execute("DELETE FROM project_posts WHERE id = ?1", [&id])?;
            }
            Reply::Saved
        }
    };
    tx.commit()?;
    Ok(reply)
}

fn project_archived(db: &Connection, project_id: &str) -> Result<bool> {
    db.query_row(
        "SELECT archived != 0 FROM projects WHERE id = ?1",
        [project_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| format!("项目不存在：{project_id}").into())
}

fn list_posts(db: &Connection, project_id: &str) -> Result<Vec<Post>> {
    let mut select = db.prepare_cached(
        "SELECT id, project_id, body, created_at FROM project_posts
         WHERE project_id = ?1 ORDER BY created_at DESC, id DESC",
    )?;
    let rows = select.query_map([project_id], |row| {
        Ok(Post {
            id: row.get(0)?,
            project_id: row.get(1)?,
            body: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
