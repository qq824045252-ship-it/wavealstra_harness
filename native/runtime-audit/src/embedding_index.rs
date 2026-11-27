use crate::{Result, javascript_whitespace, semantic_inference};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Mutex,
};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Source {
    Memory { id: String, hash: String },
    Library { id: String, hash: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRequest {
    token: String,
    model: semantic_inference::Model,
    model_id: String,
    model_version: String,
    source: Source,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StageStatus {
    Staged,
    Current,
    Skipped,
}

struct StagedVector {
    source: Source,
    model_id: String,
    model_version: String,
    dimension: usize,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct StagedVectors(Mutex<HashMap<String, StagedVector>>);

#[derive(Default, Serialize)]
pub struct Counts {
    indexed: usize,
    current: usize,
    skipped: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexModel {
    model_id: String,
    model_version: String,
    dimension: usize,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum IndexQuery {
    LibraryStats {
        model: IndexModel,
    },
    LibraryPage {
        model: IndexModel,
        after: Option<String>,
        limit: u32,
    },
    OpenMemoryQueue {
        model: IndexModel,
        queue_id: String,
        limit: Option<u64>,
    },
    MemoryPage {
        queue_id: String,
        limit: u32,
    },
    CloseMemoryQueue {
        queue_id: String,
    },
}

#[derive(Serialize)]
pub struct IndexStats {
    total: u64,
    completed: u64,
}

#[derive(Serialize)]
pub struct Candidate {
    id: String,
    hash: Option<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum QueryResult {
    Stats(IndexStats),
    Page(Vec<Candidate>),
    Closed(bool),
}

#[derive(Default)]
pub struct IndexQueues(HashMap<String, VecDeque<String>>);

fn library_index_join(space_placeholders: &str) -> String {
    format!(
        "FROM library_chunks c JOIN library_items i ON i.id=c.item_id
         LEFT JOIN library_chunk_embeddings e ON e.chunk_id=c.id AND e.chunk_hash=c.hash
             AND e.model_id=?1 AND e.model_version=?2 AND e.dimension=?3
             AND length(e.embedding)=?4
         WHERE i.trashed_at IS NULL AND i.space_id IN ({space_placeholders})"
    )
}

const MEMORY_INDEX_JOIN: &str = "FROM memory_records m
    LEFT JOIN memory_embeddings e ON e.memory_id=m.id AND e.content_hash=m.content_hash
        AND e.model_id=$model_id AND e.model_version=$model_version AND e.dimension=$dimension
        AND length(e.embedding)=$bytes
    WHERE m.status='active'";

impl IndexQueues {
    pub fn query(&mut self, db: &mut Connection, query: IndexQuery) -> Result<QueryResult> {
        let result = match query {
            IndexQuery::LibraryStats { model } => {
                let tx = db.transaction()?;
                let eligible: Vec<String> = hybrid_spaces(&tx)?.into_iter().collect();
                let stats = if eligible.is_empty() {
                    IndexStats {
                        total: 0,
                        completed: 0,
                    }
                } else {
                    let ph: Vec<String> = (0..eligible.len()).map(|i| format!("?{}", i + 5)).collect();
                    let join = library_index_join(&ph.join(","));
                    let mut values: Vec<duckdb::types::Value> = vec![
                        duckdb::types::Value::Text(model.model_id),
                        duckdb::types::Value::Text(model.model_version),
                        duckdb::types::Value::BigInt(model.dimension as i64),
                        duckdb::types::Value::BigInt((model.dimension as i64) * 4),
                    ];
                    values.extend(eligible.into_iter().map(duckdb::types::Value::Text));
                    tx.query_row(
                        &format!("SELECT COUNT(*), COUNT(e.chunk_id) {join}"),
                        duckdb::params_from_iter(values),
                        |row| Ok(IndexStats { total: row.get(0)?, completed: row.get(1)? }),
                    )?
                };
                tx.commit()?;
                QueryResult::Stats(stats)
            }
            IndexQuery::LibraryPage {
                model,
                after,
                limit,
            } => {
                let tx = db.transaction()?;
                let eligible: Vec<String> = hybrid_spaces(&tx)?.into_iter().collect();
                let rows = if eligible.is_empty() {
                    Vec::new()
                } else {
                    let ph: Vec<String> = (0..eligible.len()).map(|i| format!("?{}", i + 7)).collect();
                    let join = library_index_join(&ph.join(","));
                    let mut values: Vec<duckdb::types::Value> = vec![
                        duckdb::types::Value::Text(model.model_id),
                        duckdb::types::Value::Text(model.model_version),
                        duckdb::types::Value::BigInt(model.dimension as i64),
                        duckdb::types::Value::BigInt((model.dimension as i64) * 4),
                        after.map_or(duckdb::types::Value::Null, duckdb::types::Value::Text),
                        duckdb::types::Value::BigInt(i64::from(limit.clamp(1, 100))),
                    ];
                    values.extend(eligible.into_iter().map(duckdb::types::Value::Text));
                    let mut statement = tx.prepare(&format!(
                        "SELECT c.id,c.hash {join}
                         AND e.chunk_id IS NULL AND (?5 IS NULL OR c.id>?5)
                         ORDER BY c.id LIMIT ?6",
                    ))?;
                    statement.query_map(
                        duckdb::params_from_iter(values),
                        |row| Ok(Candidate { id: row.get(0)?, hash: row.get(1)? }),
                    )?.collect::<duckdb::Result<_>>()?
                };
                tx.commit()?;
                QueryResult::Page(rows)
            }
            IndexQuery::OpenMemoryQueue {
                model,
                queue_id,
                limit,
            } => {
                let tx = db.transaction()?;
                let stats = tx.query_row(
                    &format!("SELECT COUNT(*), COUNT(e.memory_id) {MEMORY_INDEX_JOIN}"),
                    duckdb::named_params! {
                        "model_id": model.model_id, "model_version": model.model_version,
                        "dimension": model.dimension, "bytes": model.dimension * 4,
                    },
                    |row| {
                        Ok(IndexStats {
                            total: row.get(0)?,
                            completed: row.get(1)?,
                        })
                    },
                )?;
                let pending = stats.total - stats.completed;
                let count = pending.min(limit.unwrap_or(pending));
                if count != 0 {
                    let mut statement = tx.prepare(&format!(
                        "SELECT m.id {MEMORY_INDEX_JOIN} AND e.memory_id IS NULL
                         ORDER BY m.updated_at DESC,m.id LIMIT $limit",
                    ))?;
                    let ids = statement.query_map(
                        duckdb::named_params! {
                            "model_id": model.model_id, "model_version": model.model_version,
                            "dimension": model.dimension, "bytes": model.dimension * 4, "limit": count,
                        },
                        |row| row.get(0),
                    )?.collect::<duckdb::Result<_>>()?;
                    self.0.insert(queue_id, ids);
                } else {
                    self.0.remove(&queue_id);
                }
                tx.commit()?;
                QueryResult::Stats(stats)
            }
            IndexQuery::MemoryPage { queue_id, limit } => {
                let queue = self
                    .0
                    .get_mut(&queue_id)
                    .ok_or("memory indexing queue expired")?;
                let tx = db.transaction()?;
                let candidates = {
                    let mut find = tx.prepare(
                        "SELECT content_hash FROM memory_records WHERE id=? AND status='active'",
                    )?;
                    queue
                        .iter()
                        .take(limit.clamp(1, 100) as usize)
                        .map(|id| {
                            let hash = find.query_row([id], |row| row.get(0)).optional()?;
                            Ok(Candidate {
                                id: id.clone(),
                                hash,
                            })
                        })
                        .collect::<duckdb::Result<Vec<_>>>()?
                };
                tx.commit()?;
                queue.drain(..candidates.len());
                QueryResult::Page(candidates)
            }
            IndexQuery::CloseMemoryQueue { queue_id } => {
                QueryResult::Closed(self.0.remove(&queue_id).is_some())
            }
        };
        Ok(result)
    }
}

pub fn stage(
    db: &Connection,
    inference: &mut semantic_inference::Inference,
    staged: &StagedVectors,
    request: StageRequest,
) -> Result<StageStatus> {
    let StageRequest {
        token,
        model,
        model_id,
        model_version,
        source,
    } = request;
    let dimension = model.dimension;
    let text = match &source {
        Source::Memory { id, hash } => {
            let row = db.query_row(
                "SELECT kind,title,content,EXISTS(
                    SELECT 1 FROM memory_embeddings e WHERE e.memory_id=m.id AND e.content_hash=m.content_hash
                    AND e.model_id=? AND e.model_version=? AND e.dimension=? AND length(e.embedding)=?
                 ) FROM memory_records m WHERE m.id=? AND m.content_hash=? AND m.status='active'",
                params![model_id, model_version, dimension, dimension * 4, id, hash],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, bool>(3)?)),
            ).optional()?;
            let Some((kind, title, content, current)) = row else {
                return Ok(StageStatus::Skipped);
            };
            if current {
                return Ok(StageStatus::Current);
            }
            format!("{kind}: {title}\n{content}")
                .trim_matches(javascript_whitespace)
                .to_owned()
        }
        Source::Library { id, hash } => {
            let text = db
                .query_row(
                    "SELECT c.content FROM library_chunks c JOIN library_items i ON i.id=c.item_id
                 WHERE c.id=? AND c.hash=? AND i.trashed_at IS NULL",
                    params![id, hash],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(text) = text else {
                return Ok(StageStatus::Skipped);
            };
            text
        }
    };
    let bytes = inference
        .embed_document(model, text)?
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    staged
        .0
        .lock()
        .map_err(|_| "semantic staging mutex poisoned")?
        .insert(
            token,
            StagedVector {
                source,
                model_id,
                model_version,
                dimension,
                bytes,
            },
        );
    Ok(StageStatus::Staged)
}

impl StagedVectors {
    pub fn discard(&self, tokens: &[String]) -> Result<()> {
        let mut vectors = self
            .0
            .lock()
            .map_err(|_| "semantic staging mutex poisoned")?;
        for id in tokens {
            vectors.remove(id);
        }
        Ok(())
    }

    pub fn publish(&self, db: &mut Connection, tokens: &[String], at: i64) -> Result<Counts> {
        let vectors = {
            let mut staged = self
                .0
                .lock()
                .map_err(|_| "semantic staging mutex poisoned")?;
            tokens
                .iter()
                .map(|token| staged.remove(token).ok_or("staged semantic vector missing"))
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let tx = db.transaction()?;
        let mut counts = Counts::default();
        let mut eligible_spaces = None;
        for vector in vectors {
            match &vector.source {
                Source::Memory { id, hash } => {
                    save_memory(&tx, &vector, id, hash, at, &mut counts)?;
                }
                Source::Library { id, hash } => {
                    if eligible_spaces.is_none() {
                        eligible_spaces = Some(hybrid_spaces(&tx)?);
                    }
                    save_library(
                        &tx,
                        &vector,
                        id,
                        hash,
                        at,
                        eligible_spaces.as_ref().unwrap(),
                        &mut counts,
                    )?;
                }
            }
        }
        tx.commit()?;
        Ok(counts)
    }
}

fn save_memory(
    db: &Connection,
    vector: &StagedVector,
    id: &str,
    hash: &str,
    at: i64,
    counts: &mut Counts,
) -> Result<()> {
    let valid: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_records WHERE id=? AND content_hash=? AND status='active')",
        params![id, hash], |row| row.get(0),
    )?;
    if !valid {
        counts.skipped += 1;
        return Ok(());
    }
    let saved = db.prepare(
        "INSERT INTO memory_embeddings(memory_id,model_id,model_version,content_hash,dimension,embedding,created_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(memory_id,model_id,model_version) DO UPDATE SET
           content_hash=excluded.content_hash,dimension=excluded.dimension,embedding=excluded.embedding,created_at=excluded.created_at
         WHERE content_hash<>excluded.content_hash OR dimension<>excluded.dimension OR length(embedding)<>length(excluded.embedding)",
    )?.execute(params![id, vector.model_id, vector.model_version, hash, vector.dimension, vector.bytes, at])?;
    counts.indexed += saved;
    counts.current += usize::from(saved == 0);
    Ok(())
}

fn save_library(
    db: &Connection,
    vector: &StagedVector,
    id: &str,
    hash: &str,
    at: i64,
    eligible: &HashSet<String>,
    counts: &mut Counts,
) -> Result<()> {
    let space = db
        .prepare(
            "SELECT i.space_id FROM library_chunks c JOIN library_items i ON i.id=c.item_id
         WHERE c.id=? AND c.hash=? AND i.trashed_at IS NULL",
        )?
        .query_row(params![id, hash], |row| row.get::<_, String>(0))
        .optional()?;
    if space.is_none_or(|space| !eligible.contains(&space)) {
        counts.skipped += 1;
        return Ok(());
    }
    let saved = db.prepare(
        "INSERT INTO library_chunk_embeddings(chunk_id,model_id,model_version,chunk_hash,dimension,embedding,created_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(chunk_id,model_id,model_version) DO UPDATE SET
           chunk_hash=excluded.chunk_hash,dimension=excluded.dimension,embedding=excluded.embedding,created_at=excluded.created_at
         WHERE chunk_hash<>excluded.chunk_hash OR dimension<>excluded.dimension OR length(embedding)<>length(excluded.embedding)",
    )?.execute(params![id, vector.model_id, vector.model_version, hash, vector.dimension, vector.bytes, at])?;
    counts.indexed += saved;
    counts.current += usize::from(saved == 0);
    Ok(())
}

type Policies = HashMap<String, (Option<String>, Option<String>)>;

fn index_policies(db: &Connection, sql: &str) -> duckdb::Result<Policies> {
    let mut query = db.prepare(sql)?;
    query
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?
        .collect()
}

fn hybrid_spaces(db: &Connection) -> Result<HashSet<String>> {
    let global = db
        .query_row(
            "SELECT mode FROM material_retrieval_settings WHERE singleton=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| "hybrid".to_owned());
    let spaces = index_policies(
        db,
        "SELECT s.id,s.parent_id,o.mode FROM spaces s LEFT JOIN material_retrieval_spaces o ON s.id=o.id",
    )?;
    let projects = index_policies(
        db,
        "SELECT p.id,p.default_space_id,o.mode FROM projects p LEFT JOIN material_retrieval_projects o ON p.id=o.id",
    )?;
    let mut owners = db.prepare("SELECT id,workspace_id,project_id FROM library_spaces")?;
    let owners = owners.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut eligible = HashSet::new();
    for owner in owners {
        let (id, workspace, project) = owner?;
        let project = project.as_ref().and_then(|id| projects.get(id));
        let mode = project
            .and_then(|(_, mode)| mode.as_deref())
            .unwrap_or_else(|| {
                let mut scope = project
                    .and_then(|(scope, _)| scope.as_deref())
                    .or(workspace.as_deref());
                let mut seen = HashSet::new();
                while let Some(id) = scope {
                    if !seen.insert(id) {
                        break;
                    }
                    let Some((parent, mode)) = spaces.get(id) else {
                        break;
                    };
                    if let Some(mode) = mode {
                        return mode;
                    }
                    scope = parent.as_deref();
                }
                &global
            });
        if mode == "hybrid" {
            eligible.insert(id);
        }
    }
    Ok(eligible)
}
