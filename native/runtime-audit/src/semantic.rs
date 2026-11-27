use crate::{Result, SqlScope};
use duckdb::{Connection, params_from_iter, types::Value as Param};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    model_id: String,
    model_version: String,
    dimension: usize,
    query: Vec<f32>,
    threshold: f64,
    scope: SqlScope,
    #[serde(flatten)]
    target: Target,
}

#[derive(Deserialize)]
#[serde(tag = "target", rename_all = "camelCase")]
enum Target {
    Memory,
    Library { limit: usize },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    id: String,
    hash: String,
    score: f64,
}

fn score(query: &[f32], embedding: &[u8]) -> f64 {
    query
        .iter()
        .zip(embedding.chunks_exact(4))
        .fold(0.0, |sum, (&value, bytes)| {
            let component = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            sum + f64::from(value) * f64::from(component)
        })
}

pub fn search(db: &Connection, request: Search) -> Result<Vec<Hit>> {
    if request.dimension == 0
        || request.dimension > 4096
        || request.query.len() != request.dimension
    {
        return Err("invalid semantic search dimensions".into());
    }
    let (select, order) = match request.target {
        Target::Memory => (
            "SELECT e.memory_id, e.content_hash, e.embedding, NULL
             FROM memory_embeddings e CROSS JOIN memory_records m ON m.id=e.memory_id
             WHERE e.content_hash=m.content_hash",
            " ORDER BY e.memory_id",
        ),
        Target::Library { .. } => (
            "SELECT e.chunk_id, e.chunk_hash, e.embedding, c.item_id
             FROM library_chunk_embeddings e
             JOIN library_chunks c ON c.id=e.chunk_id
             JOIN library_items li ON li.id=c.item_id
             WHERE li.trashed_at IS NULL AND e.chunk_hash=c.hash",
            " ORDER BY e.chunk_id",
        ),
    };
    // The host supplies the same static predicate and bound scope values as its SQLite reader.
    let sql = format!(
        "{select} AND e.model_id=? AND e.model_version=? AND e.dimension=? AND octet_length(e.embedding)=?
         AND ({}){order}",
        request.scope.sql,
    );
    let mut parameters = vec![
        Param::Text(request.model_id),
        Param::Text(request.model_version),
        Param::BigInt(request.dimension as i64),
        Param::BigInt((request.dimension * 4) as i64),
    ];
    parameters.extend(request.scope.parameters());
    let mut statement = db.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(parameters))?;
    let mut memory = Vec::new();
    let mut library = HashMap::<String, (usize, Hit)>::new();
    let mut ordinal = 0;
    while let Some(row) = rows.next()? {
        ordinal += 1;
        let value = score(&request.query, row.get_ref(2)?.as_blob()?);
        if !value.is_finite() || value < request.threshold {
            continue;
        }
        let hit = || -> duckdb::Result<Hit> {
            Ok(Hit {
                id: row.get(0)?,
                hash: row.get(1)?,
                score: value,
            })
        };
        match request.target {
            Target::Memory => {
                // The host must see all matches before its current visibility checks and top-K.
                if memory.len() >= 100_000 {
                    return Err("memory semantic result exceeds the native reply budget".into());
                }
                memory.push(hit()?);
            }
            Target::Library { .. } => {
                let item: String = row.get(3)?;
                if library.get(&item).is_none_or(|(_, old)| value > old.score) {
                    library.insert(item, (ordinal, hit()?));
                }
            }
        }
    }
    if let Target::Library { limit } = request.target {
        let mut best: Vec<_> = library.into_values().collect();
        best.sort_by(|(index_a, a), (index_b, b)| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| index_a.cmp(index_b))
        });
        return Ok(best
            .into_iter()
            .take(limit.clamp(1, 50))
            .map(|(_, hit)| hit)
            .collect());
    }
    Ok(memory)
}
