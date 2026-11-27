use crate::{Result, SqlScope};
use duckdb::{Connection, params_from_iter, types::Value as Param};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    scope: SqlScope,
    kinds: Option<Vec<String>>,
    limit: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    id: String,
    kind: String,
    status: String,
    importance: f64,
    confidence: f64,
    explicit: bool,
    updated_at: f64,
    scope_type: String,
    scope_id: Option<String>,
    binding: String,
}

pub fn read(db: &Connection, queries: Vec<Query>) -> Result<Vec<Vec<Candidate>>> {
    queries
        .into_iter()
        .map(|query| candidates(db, query))
        .collect()
}

fn candidates(db: &Connection, query: Query) -> Result<Vec<Candidate>> {
    let _ = &query.kinds;
    let sql = format!(
        "SELECT m.id,m.kind,m.status,m.importance,m.confidence,m.explicit,CAST(m.updated_at AS DOUBLE),s.scope_type,s.scope_id,s.binding
         FROM memory_records m JOIN memory_scopes s ON s.memory_id=m.id WHERE {}
         ORDER BY m.importance DESC,m.explicit DESC,m.updated_at DESC LIMIT ?",
        query.scope.sql,
    );
    let mut statement = db.prepare(&sql)?;
    let parameters = query
        .scope
        .parameters()
        .chain([Param::BigInt(query.limit.clamp(1, 2000))]);
    let candidates = statement
        .query_map(params_from_iter(parameters), |row| {
            Ok(Candidate {
                id: row.get(0)?,
                kind: row.get(1)?,
                status: row.get(2)?,
                importance: row.get(3)?,
                confidence: row.get(4)?,
                explicit: crate::database::row_bool(row, 5)?,
                updated_at: row.get(6)?,
                scope_type: row.get(7)?,
                scope_id: row.get(8)?,
                binding: row.get(9)?,
            })
        })?
        .collect::<duckdb::Result<Vec<_>>>()?;
    Ok(candidates)
}
