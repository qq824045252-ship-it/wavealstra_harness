use crate::{MAX_REPLY_BYTES, Result};
use rusqlite::{Connection, params_from_iter, types::Value};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[path = "memory_candidate_data.rs"]
pub(crate) mod candidates;

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
    Stats,
}

const RECORD: &str = "SELECT json_object(
    'id',m.id,'kind',m.kind,'title',m.title,'content',m.content,'status',m.status,
    'importance',m.importance,'explicit',json(iif(m.explicit,'true','false')),
    'sourceType',m.source_type,'sourceId',m.source_id,'sourceTaskId',m.source_task_id,
    'contentHash',m.content_hash,
    'createdAt',m.created_at,'updatedAt',m.updated_at,'lastRecalledAt',m.last_recalled_at,
    'recallCount',m.recall_count,'metadataJson',m.metadata_json,
    'scopes',(SELECT json_group_array(json_object('memoryId',memory_id,'scopeType',scope_type,
        'scopeId',scope_id,'binding',binding,'createdAt',created_at))
        FROM (SELECT * FROM memory_scopes WHERE memory_id=m.id ORDER BY created_at)),
    'evidence',(SELECT json_group_array(json_object('id',id,'memoryId',memory_id,
        'evidenceKind',evidence_kind,'refId',ref_id,'refTitle',ref_title,'excerpt',excerpt,'createdAt',created_at))
        FROM (SELECT * FROM memory_evidence WHERE memory_id=m.id ORDER BY created_at)),
    'relations',(SELECT json_group_array(json_object('id',id,'fromMemoryId',from_memory_id,
        'relation',relation,'toMemoryId',to_memory_id,'createdAt',created_at))
        FROM (SELECT * FROM memory_relations WHERE from_memory_id=m.id OR to_memory_id=m.id ORDER BY created_at))
    ),m.confidence,m.valid_from,m.valid_until";

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
            let mut sql = String::from("WITH page AS (SELECT m.* FROM memory_records m");
            if !conditions.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&conditions.join(" AND "));
            }
            sql.push_str(" ORDER BY m.updated_at DESC, m.id DESC LIMIT ? OFFSET ?) ");
            sql.push_str(RECORD);
            sql.push_str(" FROM page m ORDER BY m.updated_at DESC,m.id DESC");
            values.extend([
                Value::Integer(limit.clamp(1, 5000)),
                Value::Integer(offset.max(0)),
            ]);
            Ok(match read_records(db, &sql, values)? {
                Some(records) => json!({"kind": "list", "records": records}),
                None => Json::Null,
            })
        }
        Query::Detail { id } => {
            let snapshot = db.unchecked_transaction()?;
            let reply = detail(&snapshot, &id)?;
            snapshot.commit()?;
            Ok(reply)
        }
        Query::ForTurn { turn_id } => {
            let sql = format!(
                "WITH page AS (SELECT m.* FROM memory_records m WHERE m.id IN (
                    SELECT e.memory_id FROM memory_evidence e WHERE e.evidence_kind='conversation' AND e.ref_id=?
                ) ORDER BY m.updated_at DESC,m.id DESC LIMIT 500)
                {RECORD} FROM page m ORDER BY m.updated_at DESC,m.id DESC"
            );
            Ok(match read_records(db, &sql, [Value::Text(turn_id)])? {
                Some(records) => json!({"kind": "forTurn", "records": records}),
                None => Json::Null,
            })
        }
        Query::Stats => {
            let stats: String = db.prepare_cached(STATS)?.query_row([], |r| r.get(0))?;
            Ok(json!({"kind": "stats", "stats": serde_json::from_str::<Json>(&stats)?}))
        }
        Query::History { id } => read_history(db, &id),
        Query::ForgetSource { id } => crate::memory_record_write::forget::snapshot(db, &id),
        Query::ScopeMutationSupport => Ok(json!({"kind": "scopeMutationSupport"})),
        Query::CandidateList { status, limit } => candidates::list(db, status, limit),
        Query::CandidateReviewSupported => Ok(json!({ "kind": "candidateReviewSupported" })),
    }
}

fn read_history(db: &Connection, id: &str) -> Result<Json> {
    let mut statement = db.prepare_cached(
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

pub(crate) fn revision(db: &Connection, id: &str) -> rusqlite::Result<i64> {
    db.prepare_cached("SELECT COALESCE(MAX(revision),0) FROM memory_revisions WHERE memory_id=?")?
        .query_row([id], |row| row.get(0))
}

pub(crate) fn detail(db: &Connection, id: &str) -> Result<Json> {
    let sql = format!("{RECORD} FROM memory_records m WHERE m.id=?");
    Ok(
        match read_records(db, &sql, [Value::Text(id.to_owned())])? {
            Some(mut records) => {
                json!({"kind": "detail", "record": records.pop(), "revision": revision(db, id)?})
            }
            None => Json::Null,
        },
    )
}

fn read_records(
    db: &Connection,
    sql: &str,
    values: impl IntoIterator<Item = Value>,
) -> Result<Option<Vec<Json>>> {
    let mut statement = db.prepare_cached(sql)?;
    let mut rows = statement.query(params_from_iter(values))?;
    let mut records = Vec::new();
    // Reserve the enclosing reply fields and the newline in the bridge's one-line protocol.
    let mut bytes = 128;
    while let Some(row) = rows.next()? {
        let record: String = row.get(0)?;
        // Include the three floating-point fields read directly to preserve SQLite's precision.
        bytes += record.len() + 128;
        if bytes >= MAX_REPLY_BYTES {
            return Ok(None);
        }
        let mut value: Json = serde_json::from_str(&record)?;
        value["confidence"] = json!(row.get::<_, f64>(1)?);
        value["validFrom"] = json!(row.get::<_, Option<f64>>(2)?);
        value["validUntil"] = json!(row.get::<_, Option<f64>>(3)?);
        records.push(value);
    }
    Ok(Some(records))
}

const STATS: &str = "SELECT json_object(
    'total',COUNT(1),'active',COUNT(*) FILTER (WHERE status='active'),
    'recalled',COALESCE(SUM(recall_count),0),
    'byKind',(SELECT json_group_object(kind,n) FROM (SELECT kind,COUNT(1) n FROM memory_records GROUP BY kind)),
    'byScope',(SELECT json_group_object(scope_type,n) FROM
        (SELECT scope_type,COUNT(DISTINCT memory_id) n FROM memory_scopes GROUP BY scope_type)),
    'candidates',(SELECT json_group_object(status,n) FROM
        (SELECT status,COUNT(1) n FROM memory_candidates GROUP BY status)),
    'l0Turns',(SELECT COUNT(1) FROM memory_turns),
    'pendingTurns',(SELECT COUNT(1) FROM memory_turns WHERE extraction_state='pending'
        OR (extraction_state='failed' AND attempt_count<3)),
    'failedTurns',(SELECT COUNT(1) FROM memory_turns WHERE extraction_state='failed' AND attempt_count>=3),
    'scenarios',(SELECT COUNT(1) FROM memory_scenarios WHERE status='active'),
    'coreProfiles',(SELECT COUNT(1) FROM memory_core_profiles WHERE status='active'),
    'skillCandidates',(SELECT COUNT(1) FROM memory_skill_candidates WHERE status IN ('draft','ready')),
    'readySkillCandidates',(SELECT COUNT(1) FROM memory_skill_candidates WHERE status='ready'),
    'skillExposures',(SELECT COUNT(1) FROM memory_skill_effectiveness),
    'skillInvocations',(SELECT COUNT(1) FROM memory_skill_effectiveness WHERE invoked_at IS NOT NULL),
    'skillNegativeFeedback',(SELECT COUNT(1) FROM memory_skill_effectiveness WHERE feedback_kind IN ('needs_revision','incorrect')),
    'skillRevisionCandidates',(SELECT COUNT(1) FROM memory_skill_revision_candidates WHERE status IN ('draft','ready')),
    'readySkillRevisionCandidates',(SELECT COUNT(1) FROM memory_skill_revision_candidates WHERE status='ready')
    ) FROM memory_records";
