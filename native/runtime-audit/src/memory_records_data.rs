use crate::{MAX_REPLY_BYTES, Result};
use duckdb::{Connection, params_from_iter, types::Value};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[path = "memory_candidate_data.rs"]
pub(crate) mod candidates;
#[path = "memory_skill_grounding.rs"]
mod skill_grounding;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    List {
        record_kind: Option<String>,
        status: Option<String>,
        scope_type: Option<String>,
        scope_id: Option<String>,
        pattern: Option<String>,
        limit: i64,
        offset: i64,
    },
    Detail {
        id: String,
    },
    ForTurn {
        turn_id: String,
    },
    History {
        id: String,
    },
    ForgetSource {
        id: String,
    },
    ScopeMutationSupport,
    CandidateList {
        status: Option<String>,
        limit: i64,
    },
    CandidateReviewSupported,
    InstalledSkillGrounding {
        installed_skill_id: String,
        candidate_id: String,
        source_memory_ids: Vec<String>,
    },
    Stats,
}

pub fn read(db: &Connection, query: Query) -> Result<Json> {
    match query {
        Query::List {
            record_kind,
            status,
            scope_type,
            scope_id,
            pattern,
            limit,
            offset,
        } => {
            let mut conditions = Vec::new();
            let mut values = Vec::new();
            if let Some(kind) = record_kind {
                conditions.push("m.kind=?");
                values.push(Value::Text(kind));
            }
            if let Some(status) = status {
                conditions.push("m.status=?");
                values.push(Value::Text(status));
            }
            if let Some(scope_type) = scope_type {
                values.push(Value::Text(scope_type));
                if let Some(scope_id) = scope_id {
                    conditions.push("EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND s.scope_type=? AND s.scope_id=?)");
                    values.push(Value::Text(scope_id));
                } else {
                    conditions.push("EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND s.scope_type=?)");
                }
            }
            if let Some(pattern) = pattern {
                conditions.push("(m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')");
                values.extend([Value::Text(pattern.clone()), Value::Text(pattern)]);
            }
            let mut sql = String::from(
                "SELECT m.id,m.kind,m.title,m.content,m.status,m.importance,m.explicit,
                        m.source_type,m.source_id,m.source_task_id,m.content_hash,
                        m.created_at,m.updated_at,m.last_recalled_at,m.recall_count,m.metadata_json,
                        m.confidence,m.valid_from,m.valid_until
                 FROM memory_records m",
            );
            if !conditions.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&conditions.join(" AND "));
            }
            sql.push_str(" ORDER BY m.updated_at DESC, m.id DESC LIMIT ? OFFSET ?");
            values.extend([
                Value::BigInt(limit.clamp(1, 5000)),
                Value::BigInt(offset.max(0)),
            ]);
            Ok(match read_records(db, &sql, values)? {
                Some(records) => json!({"kind": "list", "records": records}),
                None => Json::Null,
            })
        }
        Query::Detail { id } => detail(db, &id),
        Query::ForTurn { turn_id } => {
            let sql = "SELECT m.id,m.kind,m.title,m.content,m.status,m.importance,m.explicit,
                              m.source_type,m.source_id,m.source_task_id,m.content_hash,
                              m.created_at,m.updated_at,m.last_recalled_at,m.recall_count,m.metadata_json,
                              m.confidence,m.valid_from,m.valid_until
                       FROM memory_records m WHERE m.id IN (
                           SELECT e.memory_id FROM memory_evidence e WHERE e.evidence_kind='conversation' AND e.ref_id=?
                       ) ORDER BY m.updated_at DESC,m.id DESC LIMIT 500";
            Ok(match read_records(db, sql, [Value::Text(turn_id)])? {
                Some(records) => json!({"kind": "forTurn", "records": records}),
                None => Json::Null,
            })
        }
        Query::Stats => read_stats(db),
        Query::History { id } => read_history(db, &id),
        Query::ForgetSource { id } => crate::memory_record_write::forget::snapshot(db, &id),
        Query::ScopeMutationSupport => Ok(json!({"kind": "scopeMutationSupport"})),
        Query::CandidateList { status, limit } => candidates::list(db, status, limit),
        Query::CandidateReviewSupported => Ok(json!({ "kind": "candidateReviewSupported" })),
        Query::InstalledSkillGrounding {
            installed_skill_id,
            candidate_id,
            source_memory_ids,
        } => skill_grounding::read(db, &installed_skill_id, &candidate_id, source_memory_ids),
    }
}

fn read_history(db: &Connection, id: &str) -> Result<Json> {
    let mut statement = db.prepare(
        "SELECT id,memory_id,revision,kind,title,content,status,importance,confidence,
            valid_from,valid_until,changed_by,change_reason,created_at
        FROM memory_revisions WHERE memory_id=? ORDER BY revision DESC",
    )?;
    let mut rows = statement.query([id])?;
    let mut revisions = Vec::new();
    let mut bytes = 128;
    while let Some(row) = rows.next()? {
        let revision = json!({
            "id": row.get::<_, String>(0)?,
            "memoryId": row.get::<_, String>(1)?,
            "revision": row.get::<_, i64>(2)?,
            "kind": row.get::<_, String>(3)?,
            "title": row.get::<_, String>(4)?,
            "content": row.get::<_, String>(5)?,
            "status": row.get::<_, String>(6)?,
            "importance": row.get::<_, f64>(7)?,
            "confidence": row.get::<_, f64>(8)?,
            "validFrom": row.get::<_, Option<f64>>(9)?,
            "validUntil": row.get::<_, Option<f64>>(10)?,
            "changedBy": row.get::<_, String>(11)?,
            "changeReason": row.get::<_, Option<String>>(12)?,
            "createdAt": row.get::<_, f64>(13)?,
        });
        bytes += serde_json::to_vec(&revision)?.len() + 1;
        if bytes >= MAX_REPLY_BYTES {
            return Ok(Json::Null);
        }
        revisions.push(revision);
    }
    Ok(json!({"kind": "history", "revisions": revisions}))
}

pub(crate) fn revision(db: &Connection, id: &str) -> duckdb::Result<i64> {
    db.prepare("SELECT COALESCE(MAX(revision),0) FROM memory_revisions WHERE memory_id=?")?
        .query_row([id], |row| row.get(0))
}

pub(crate) fn detail(db: &Connection, id: &str) -> Result<Json> {
    let sql = "SELECT m.id,m.kind,m.title,m.content,m.status,m.importance,m.explicit,
                      m.source_type,m.source_id,m.source_task_id,m.content_hash,
                      m.created_at,m.updated_at,m.last_recalled_at,m.recall_count,m.metadata_json,
                      m.confidence,m.valid_from,m.valid_until
               FROM memory_records m WHERE m.id=?";
    Ok(match read_records(db, sql, [Value::Text(id.to_owned())])? {
        Some(mut records) => {
            json!({"kind": "detail", "record": records.pop(), "revision": revision(db, id)?})
        }
        None => Json::Null,
    })
}

fn read_records(
    db: &Connection,
    sql: &str,
    values: impl IntoIterator<Item = Value>,
) -> Result<Option<Vec<Json>>> {
    let mut statement = db.prepare(sql)?;
    let mut rows = statement.query(params_from_iter(values))?;
    let mut raw_records = Vec::new();
    let mut ids = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        ids.push(id.clone());
        raw_records.push(json!({
            "id": id,
            "kind": row.get::<_, String>(1)?,
            "title": row.get::<_, String>(2)?,
            "content": row.get::<_, String>(3)?,
            "status": row.get::<_, String>(4)?,
            "importance": row.get::<_, i64>(5)?,
            "explicit": crate::database::row_bool(row, 6)?,
            "sourceType": row.get::<_, String>(7)?,
            "sourceId": row.get::<_, Option<String>>(8)?,
            "sourceTaskId": row.get::<_, Option<String>>(9)?,
            "contentHash": row.get::<_, String>(10)?,
            "createdAt": row.get::<_, i64>(11)?,
            "updatedAt": row.get::<_, i64>(12)?,
            "lastRecalledAt": row.get::<_, Option<i64>>(13)?,
            "recallCount": row.get::<_, i64>(14)?,
            "metadataJson": row.get::<_, String>(15)?,
            "confidence": row.get::<_, f64>(16)?,
            "validFrom": row.get::<_, Option<f64>>(17)?,
            "validUntil": row.get::<_, Option<f64>>(18)?,
        }));
    }
    if ids.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let slots = crate::database::anon_placeholders(ids.len());
    let mut scopes_map: std::collections::HashMap<String, Vec<Json>> =
        std::collections::HashMap::new();
    {
        let mut s_stmt = db.prepare(&format!(
            "SELECT memory_id,scope_type,scope_id,binding,created_at
             FROM memory_scopes WHERE memory_id IN ({slots}) ORDER BY created_at"
        ))?;
        let mut s_rows = s_stmt.query(params_from_iter(ids.iter()))?;
        while let Some(r) = s_rows.next()? {
            let mid: String = r.get(0)?;
            scopes_map.entry(mid.clone()).or_default().push(json!({
                "memoryId": mid,
                "scopeType": r.get::<_, String>(1)?,
                "scopeId": r.get::<_, Option<String>>(2)?,
                "binding": r.get::<_, String>(3)?,
                "createdAt": r.get::<_, i64>(4)?,
            }));
        }
    }
    let mut evidence_map: std::collections::HashMap<String, Vec<Json>> =
        std::collections::HashMap::new();
    {
        let mut e_stmt = db.prepare(&format!(
            "SELECT id,memory_id,evidence_kind,ref_id,ref_title,excerpt,created_at
             FROM memory_evidence WHERE memory_id IN ({slots}) ORDER BY created_at"
        ))?;
        let mut e_rows = e_stmt.query(params_from_iter(ids.iter()))?;
        while let Some(r) = e_rows.next()? {
            let mid: String = r.get(1)?;
            evidence_map.entry(mid.clone()).or_default().push(json!({
                "id": r.get::<_, String>(0)?,
                "memoryId": mid,
                "evidenceKind": r.get::<_, String>(2)?,
                "refId": r.get::<_, Option<String>>(3)?,
                "refTitle": r.get::<_, Option<String>>(4)?,
                "excerpt": r.get::<_, Option<String>>(5)?,
                "createdAt": r.get::<_, i64>(6)?,
            }));
        }
    }
    let mut relations_map: std::collections::HashMap<String, Vec<Json>> =
        std::collections::HashMap::new();
    {
        let mut r_stmt = db.prepare(&format!(
            "SELECT id,from_memory_id,relation,to_memory_id,created_at
             FROM memory_relations
             WHERE from_memory_id IN ({slots}) OR to_memory_id IN ({slots})
             ORDER BY created_at"
        ))?;
        let params: Vec<&String> = ids.iter().chain(ids.iter()).collect();
        let mut r_rows = r_stmt.query(params_from_iter(params))?;
        while let Some(r) = r_rows.next()? {
            let from_id: String = r.get(1)?;
            let to_id: String = r.get(3)?;
            let item = json!({
                "id": r.get::<_, String>(0)?,
                "fromMemoryId": from_id,
                "relation": r.get::<_, String>(2)?,
                "toMemoryId": to_id,
                "createdAt": r.get::<_, i64>(4)?,
            });
            relations_map
                .entry(from_id.clone())
                .or_default()
                .push(item.clone());
            if to_id != from_id {
                relations_map.entry(to_id).or_default().push(item);
            }
        }
    }
    let mut records = Vec::with_capacity(raw_records.len());
    let mut bytes = 128;
    for mut value in raw_records {
        let id = value["id"].as_str().unwrap_or_default().to_owned();
        value["scopes"] = Json::Array(scopes_map.remove(&id).unwrap_or_default());
        value["evidence"] = Json::Array(evidence_map.remove(&id).unwrap_or_default());
        value["relations"] = Json::Array(relations_map.remove(&id).unwrap_or_default());
        bytes += serde_json::to_vec(&value)?.len() + 1;
        if bytes >= MAX_REPLY_BYTES {
            return Ok(None);
        }
        records.push(value);
    }
    Ok(Some(records))
}

fn group_counts(db: &Connection, sql: &str) -> Result<serde_json::Map<String, Json>> {
    let mut stmt = db.prepare(sql)?;
    let mut rows = stmt.query([])?;
    let mut map = serde_json::Map::new();
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let count: i64 = row.get(1)?;
        map.insert(key, json!(count));
    }
    Ok(map)
}

fn scalar_count(db: &Connection, sql: &str) -> Result<i64> {
    Ok(db.query_row(sql, [], |r| r.get(0))?)
}

fn read_stats(db: &Connection) -> Result<Json> {
    let (total, active, recalled): (i64, i64, i64) = db.query_row(
        "SELECT COUNT(1), COUNT(*) FILTER (WHERE status='active'), COALESCE(CAST(SUM(recall_count) AS BIGINT), 0)
         FROM memory_records",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let by_kind = group_counts(
        db,
        "SELECT kind, COUNT(1) FROM memory_records GROUP BY kind",
    )?;
    let by_scope = group_counts(
        db,
        "SELECT scope_type, COUNT(DISTINCT memory_id) FROM memory_scopes GROUP BY scope_type",
    )?;
    let candidates = group_counts(
        db,
        "SELECT status, COUNT(1) FROM memory_candidates GROUP BY status",
    )?;
    let l0_turns = scalar_count(db, "SELECT COUNT(1) FROM memory_turns")?;
    let pending_turns = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_turns WHERE extraction_state='pending' OR (extraction_state='failed' AND attempt_count<3)",
    )?;
    let failed_turns = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_turns WHERE extraction_state='failed' AND attempt_count>=3",
    )?;
    let scenarios = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_scenarios WHERE status='active'",
    )?;
    let core_profiles = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_core_profiles WHERE status='active'",
    )?;
    let skill_candidates = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_skill_candidates WHERE status IN ('draft','ready')",
    )?;
    let ready_skill_candidates = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_skill_candidates WHERE status='ready'",
    )?;
    let skill_exposures = scalar_count(db, "SELECT COUNT(1) FROM memory_skill_effectiveness")?;
    let skill_invocations = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_skill_effectiveness WHERE invoked_at IS NOT NULL",
    )?;
    let skill_negative_feedback = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_skill_effectiveness WHERE feedback_kind IN ('needs_revision','incorrect')",
    )?;
    let skill_revision_candidates = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_skill_revision_candidates WHERE status IN ('draft','ready')",
    )?;
    let ready_skill_revision_candidates = scalar_count(
        db,
        "SELECT COUNT(1) FROM memory_skill_revision_candidates WHERE status='ready'",
    )?;
    Ok(json!({
        "kind": "stats",
        "stats": {
            "total": total,
            "active": active,
            "recalled": recalled,
            "byKind": by_kind,
            "byScope": by_scope,
            "candidates": candidates,
            "l0Turns": l0_turns,
            "pendingTurns": pending_turns,
            "failedTurns": failed_turns,
            "scenarios": scenarios,
            "coreProfiles": core_profiles,
            "skillCandidates": skill_candidates,
            "readySkillCandidates": ready_skill_candidates,
            "skillExposures": skill_exposures,
            "skillInvocations": skill_invocations,
            "skillNegativeFeedback": skill_negative_feedback,
            "skillRevisionCandidates": skill_revision_candidates,
            "readySkillRevisionCandidates": ready_skill_revision_candidates,
        }
    }))
}
