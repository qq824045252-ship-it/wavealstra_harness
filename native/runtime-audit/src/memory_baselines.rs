use crate::{Result, SqlScope};
use rusqlite::{Connection, params_from_iter, types::Value as Param};
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
    let selective_kinds = if let Some(kinds) = &query.kinds
        && !kinds.is_empty()
    {
        db.query_row(
            "SELECT count(*) FROM (SELECT 1 FROM memory_records INDEXED BY idx_memory_records_kind_updated
                WHERE kind IN (SELECT value FROM json_each(?1)) LIMIT 1025)",
            [serde_json::to_string(kinds)?],
            |row| row.get::<_, i64>(0),
        )? <= 1024
    } else {
        false
    };
    let join = if selective_kinds {
        "memory_records m INDEXED BY idx_memory_records_kind_updated CROSS JOIN memory_scopes s"
    } else {
        "memory_records m JOIN memory_scopes s"
    };
    let sql = format!(
        "SELECT m.id,m.kind,m.status,m.importance,m.confidence,m.explicit,m.updated_at,s.scope_type,s.scope_id,s.binding
         FROM {join} ON s.memory_id=m.id WHERE {}
         ORDER BY m.importance DESC,m.explicit DESC,m.updated_at DESC LIMIT ?",
        query.scope.sql,
    );
    let mut statement = db.prepare_cached(&sql)?;
    let parameters = query
        .scope
        .parameters()
        .chain([Param::Integer(query.limit.clamp(1, 2000))]);
    let candidates = statement
        .query_map(params_from_iter(parameters), |row| {
            Ok(Candidate {
                id: row.get(0)?,
                kind: row.get(1)?,
                status: row.get(2)?,
                importance: row.get(3)?,
                confidence: row.get(4)?,
                explicit: row.get(5)?,
                updated_at: row.get(6)?,
                scope_type: row.get(7)?,
                scope_id: row.get(8)?,
                binding: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(candidates)
}
