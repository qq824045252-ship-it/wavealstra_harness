use crate::{Result, sqlite_rows::records};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Query {
    Gadgets { scopes: Option<Vec<Scope>> },
    Gadget { id: String },
    Blueprints,
    Blueprint { id: String },
    WritesSupported,
    InstantiationSupported,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub(crate) scope_type: String,
    pub(crate) scope_id: Option<String>,
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    let rows = match query {
        Query::Gadgets { scopes: Some(scopes) } => records(
            db,
            "WITH requested AS (
                 SELECT CAST(key AS INTEGER) AS scope_index, json_extract(value, '$.scopeType') AS scope_type,
                     json_extract(value, '$.scopeId') AS scope_id FROM json_each(?1)
             )
             SELECT g.*, r.scope_index FROM requested r JOIN gadgets g
                ON g.scope_type = r.scope_type AND g.scope_id IS r.scope_id
             ORDER BY r.scope_index, g.updated_at DESC, g.id",
            [serde_json::to_string(&scopes)?],
        )?,
        Query::Gadgets { scopes: None } => records(
            db,
            "SELECT *, 0 AS scope_index FROM gadgets ORDER BY updated_at DESC, id",
            [],
        )?,
        Query::Gadget { id } => records(db, "SELECT * FROM gadgets WHERE id=?1", [id])?,
        Query::Blueprints => {
            return blueprint_rows(records(db, "SELECT * FROM blueprints ORDER BY updated_at DESC, id", [])?);
        }
        Query::Blueprint { id } => {
            return blueprint_rows(records(db, "SELECT * FROM blueprints WHERE id=?1", [id])?);
        }
        Query::WritesSupported | Query::InstantiationSupported => return Ok(true.into()),
    };
    Ok(rows.into())
}

fn blueprint_rows(rows: Vec<Value>) -> Result<Value> {
    // The line protocol has a 32 MiB limit. A large definition can expand
    // substantially when its JSON is escaped again inside a row.
    if serde_json::to_vec(&rows)?.len() > 31 * 1024 * 1024 {
        return Ok(Value::Null);
    }
    Ok(rows.into())
}
