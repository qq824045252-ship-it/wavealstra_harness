use duckdb::{Connection, Row, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    Read,
    Update { patch: Patch },
}

impl Request {
    pub fn is_read(&self) -> bool {
        matches!(self, Self::Read)
    }
}

#[derive(Deserialize)]
pub struct Patch {
    name: Option<String>,
    alias: Option<String>,
    persona: Option<String>,
}

#[derive(Serialize)]
pub struct Profile {
    name: String,
    alias: String,
    persona: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Applied { profile: Profile },
    Rejected { message: String },
}

pub fn run(db: &mut Connection, request: Request) -> Reply {
    match apply(db, request) {
        Ok(profile) => Reply::Applied { profile },
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, request: Request) -> duckdb::Result<Profile> {
    let Request::Update { patch } = request else {
        return db.query_row(
            "SELECT name, alias, persona FROM soul WHERE id = 1",
            [],
            map,
        );
    };
    let tx = db.transaction()?;
    let profile = tx.query_row(
        "UPDATE soul SET name = COALESCE(?1, name), alias = COALESCE(?2, alias),
                         persona = COALESCE(?3, persona) WHERE id = 1
         RETURNING name, alias, persona",
        params![patch.name, patch.alias, patch.persona],
        map,
    )?;
    tx.commit()?;
    Ok(profile)
}

fn map(row: &Row<'_>) -> duckdb::Result<Profile> {
    Ok(Profile {
        name: row.get(0)?,
        alias: row.get(1)?,
        persona: row.get(2)?,
    })
}
