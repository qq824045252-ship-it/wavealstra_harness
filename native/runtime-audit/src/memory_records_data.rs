use crate::{MAX_REPLY_BYTES, Result};
use duckdb::{Connection, OptionalExt, params_from_iter, types::Value};
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
    DotsRevisionSource { id: String, revision: Option<i64>, now: i64 },
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
    DistinctProjectionScopes,
    Projects { include_archived: bool },
    CandidateById { id: String },
    CaptureReceipt { source_key: String },
    Revisions { memory_id: String },
    UserWorks { user_id: String },
    WorkCaptureFacts { work_id: String, user_id: String },
    AssistantScopeContext {
        task_id: Option<String>,
        work_id: Option<String>,
        conversation_id: Option<String>,
        user_id: String,
    },
    DotsDueProjection { now: i64 },
    SkillEffectivenessQuery {
        #[serde(flatten)]
        query: SkillEffectivenessQueryKind,
    },
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SkillEffectivenessQueryKind {
    ById { id: String },
    ByTurnSkill {
        task_id: String,
        assistant_message_id: String,
        skill_id: String,
    },
    InvokedForTurn {
        task_id: String,
        assistant_message_id: String,
    },
    LatestInvocationAfter {
        skill_id: String,
        candidate_id: String,
        after: i64,
    },
    Recent { limit: i64, invoked_only: bool },
    Summaries { limit: i64 },
    RevisionById { id: String },
    RevisionList { status: Option<String>, limit: i64 },
    RevisionRefreshFacts {
        skill_id: String,
        candidate_id: Option<String>,
    },
    RevisionStaleCount {
        skill_id: String,
        candidate_id: Option<String>,
        keep_id: String,
    },
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
        Query::DotsRevisionSource { id, revision, now } => dots_revision_source(db, &id, revision, now),
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
        Query::DistinctProjectionScopes => {
            let rows = crate::sqlite_rows::records(
                db,
                "SELECT DISTINCT scope_type AS \"scopeType\", scope_id AS \"scopeId\"
                 FROM memory_scopes WHERE scope_type IN ('global','workspace','project')",
                [],
            )?;
            Ok(json!({ "kind": "distinctProjectionScopes", "scopes": rows }))
        }
        Query::Projects { include_archived } => {
            let sql = if include_archived {
                "SELECT id, name, archived FROM projects ORDER BY updated_at DESC, id"
            } else {
                "SELECT id, name, archived FROM projects WHERE archived = 0 ORDER BY updated_at DESC, id"
            };
            Ok(json!({ "kind": "projects", "projects": crate::sqlite_rows::records(db, sql, [])? }))
        }
        Query::CandidateById { id } => {
            let candidate = crate::sqlite_rows::records(
                db,
                "SELECT id, task_id, kind, title, content, scope_type, scope_id, confidence, importance, explicit,
                        operation_hint, replaces, status, raw_json, created_at, resolved_at, resolved_memory_id
                 FROM memory_candidates WHERE id = ?1",
                [&id],
            )?
            .pop();
            Ok(json!({ "kind": "candidateById", "candidate": candidate }))
        }
        Query::CaptureReceipt { source_key } => {
            let receipt = crate::sqlite_rows::records(
                db,
                "SELECT source_key, memory_id, content_hash, suppressed, updated_at
                 FROM memory_capture_receipts WHERE source_key = ?1",
                [&source_key],
            )?
            .pop();
            Ok(json!({ "kind": "captureReceipt", "receipt": receipt }))
        }
        Query::Revisions { memory_id } => {
            let revisions = crate::sqlite_rows::records(
                db,
                "SELECT revision, changed_by, change_reason, content, title
                 FROM memory_revisions WHERE memory_id = ?1 ORDER BY revision DESC",
                [&memory_id],
            )?;
            Ok(json!({ "kind": "revisions", "revisions": revisions }))
        }
        Query::UserWorks { user_id } => {
            let mut stmt = db.prepare("SELECT work_id FROM works WHERE user_id = ?1 ORDER BY work_id")?;
            let work_ids = stmt
                .query_map([&user_id], |r| r.get::<_, String>(0))?
                .collect::<duckdb::Result<Vec<_>>>()?;
            Ok(json!({ "kind": "userWorks", "workIds": work_ids }))
        }
        Query::WorkCaptureFacts { work_id, user_id } => work_capture_facts(db, &work_id, &user_id),
        Query::AssistantScopeContext {
            task_id,
            work_id,
            conversation_id,
            user_id,
        } => assistant_scope_context(
            db,
            task_id.as_deref(),
            work_id.as_deref(),
            conversation_id.as_deref(),
            &user_id,
        ),
        Query::DotsDueProjection { now } => dots_due_projection(db, now),
        Query::SkillEffectivenessQuery { query } => skill_effectiveness_query(db, query),
    }
}

fn work_capture_facts(db: &Connection, work_id: &str, user_id: &str) -> Result<Json> {
    let work = crate::sqlite_rows::records(
        db,
        "SELECT title, progress_summary, lifecycle, mode, closure_conclusion, intent_revision, input_snapshot_id
         FROM works WHERE work_id = ?1 AND user_id = ?2",
        duckdb::params![work_id, user_id],
    )?
    .pop();
    let Some(work_val) = work else {
        return Ok(json!({ "kind": "workCaptureFacts", "work": Json::Null }));
    };
    let intent_rev = work_val["intent_revision"].as_i64().unwrap_or_default();
    let snap_id = work_val["input_snapshot_id"].as_str().unwrap_or_default().to_owned();
    let deliverables = crate::sqlite_rows::records(
        db,
        "SELECT deliverable_id, status, summary FROM work_deliverables
         WHERE work_id = ?1 AND intent_revision = ?2 AND input_snapshot_id = ?3 AND status IN ('accepted','proposed')
         ORDER BY created_at DESC, deliverable_id DESC LIMIT 6",
        duckdb::params![work_id, intent_rev, &snap_id],
    )?;
    let deliverable_total: i64 = db.query_row(
        "SELECT COUNT(*) FROM work_deliverables
         WHERE work_id = ?1 AND intent_revision = ?2 AND input_snapshot_id = ?3 AND status IN ('accepted','proposed')",
        duckdb::params![work_id, intent_rev, &snap_id],
        |r| r.get(0),
    )?;
    let blockers = crate::sqlite_rows::records(
        db,
        "SELECT reason FROM work_blockers
         WHERE work_id = ?1 AND status = 'open'
         ORDER BY waiting_for_user_input DESC, created_at DESC, blocker_id DESC LIMIT 6",
        [work_id],
    )?;
    let blocker_total: i64 = db.query_row(
        "SELECT COUNT(*) FROM work_blockers WHERE work_id = ?1 AND status = 'open'",
        [work_id],
        |r| r.get(0),
    )?;
    Ok(json!({
        "kind": "workCaptureFacts",
        "work": work_val,
        "deliverables": deliverables,
        "deliverableTotal": deliverable_total,
        "blockers": blockers,
        "blockerTotal": blocker_total,
    }))
}

fn work_has_shared_origin(db: &Connection, work_id: &str) -> Result<bool> {
    let origin: Option<String> = db
        .query_row(
            "SELECT json_extract_string(try_cast(o.origin_json AS JSON), '$.audience')
             FROM works w
             JOIN bot_turn_origins o ON o.user_message_id = w.source_message_id AND o.user_id = w.user_id
             WHERE w.work_id = ?1",
            [work_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(audience) = origin {
        return Ok(audience != "private");
    }
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM works w JOIN gateway_work_targets t ON t.user_id = w.user_id AND t.source_message_id = w.source_message_id WHERE w.work_id = ?1)",
        [work_id],
        |r| r.get(0),
    )?)
}

fn assistant_scope_context(
    db: &Connection,
    task_id: Option<&str>,
    work_id: Option<&str>,
    conversation_id: Option<&str>,
    user_id: &str,
) -> Result<Json> {
    let work_scope = match task_id {
        Some(tid) => {
            let row = crate::sqlite_rows::records(
                db,
                "SELECT w.owner_bot_id AS bot_id, b.work_id, w.project_id,
                        (SELECT team_id FROM work_team_ownership WHERE work_id = b.work_id LIMIT 1) AS team_id,
                        EXISTS(SELECT 1 FROM work_teams WHERE work_id = b.work_id) AS is_team
                 FROM work_execution_bindings b
                 JOIN works w ON w.work_id = b.work_id
                 WHERE b.task_id = ?1 AND w.user_id = ?2
                 ORDER BY b.admitted_at DESC, b.binding_id DESC LIMIT 1",
                duckdb::params![tid, user_id],
            )?
            .pop();
            match row {
                Some(mut val) => {
                    let wid = val["work_id"].as_str().unwrap_or_default().to_owned();
                    val["shared"] = json!(work_has_shared_origin(db, &wid)?);
                    Some(val)
                }
                None => None,
            }
        }
        None => None,
    };
    let effective_conv_id = conversation_id.or_else(|| if work_scope.is_none() { task_id } else { None });
    let bot_source = match effective_conv_id {
        Some(cid) => {
            let row = crate::sqlite_rows::records(
                db,
                "SELECT c.conversation_id, c.bot_id, c.team_id, c.user_id, c.source_kind, b.status,
                        EXISTS(SELECT 1 FROM bot_gateway_conversations g WHERE g.conversation_id = c.conversation_id AND g.audience = 'shared') AS shared,
                        (c.source_kind = 'peer' OR EXISTS(SELECT 1 FROM bot_peer_inputs p JOIN bot_messages m ON m.message_id = p.user_message_id WHERE m.conversation_id = c.conversation_id AND json_extract_string(try_cast(p.origin_json AS JSON), '$.kind') = 'request')) AS peer
                 FROM bot_conversations c
                 JOIN bots b ON b.bot_id = c.bot_id AND b.user_id = c.user_id
                 WHERE c.conversation_id = ?1 AND c.user_id = ?2",
                duckdb::params![cid, user_id],
            )?
            .pop();
            row
        }
        None => None,
    };
    let direct_work = match work_id {
        Some(wid) => {
            let row = crate::sqlite_rows::records(
                db,
                "SELECT w.work_id, w.owner_bot_id, w.project_id,
                        (SELECT team_id FROM work_team_ownership WHERE work_id = w.work_id LIMIT 1) AS team_id,
                        EXISTS(SELECT 1 FROM work_teams WHERE work_id = w.work_id) AS is_team
                 FROM works w WHERE w.work_id = ?1 AND w.user_id = ?2",
                duckdb::params![wid, user_id],
            )?
            .pop();
            match row {
                Some(mut val) => {
                    let id = val["work_id"].as_str().unwrap_or_default().to_owned();
                    val["shared"] = json!(work_has_shared_origin(db, &id)?);
                    Some(val)
                }
                None => None,
            }
        }
        None => None,
    };
    let has_gateway_dots_memory = match task_id {
        Some(tid) => db.query_row(
            "SELECT EXISTS(SELECT 1 FROM gateway_dots_tasks WHERE task_id = ?1)",
            [tid],
            |r| r.get(0),
        )?,
        None => false,
    };
    Ok(json!({
        "kind": "assistantScopeContext",
        "workScope": work_scope,
        "botSource": bot_source,
        "directWork": direct_work,
        "hasGatewayDotsMemory": has_gateway_dots_memory,
    }))
}

fn dots_due_projection(db: &Connection, now: i64) -> Result<Json> {
    let next_due: Option<i64> = db
        .query_row(
            "SELECT valid_from FROM memory_records
             WHERE (source_task_id = 'mybuddy-dots' OR json_extract_string(try_cast(metadata_json AS JSON), '$.dotsPrivateGateway') IN ('true','1'))
               AND status = 'active' AND valid_until IS NULL AND valid_from > ?1
             ORDER BY valid_from LIMIT 1",
            [now],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let records_list = crate::sqlite_rows::records(
        db,
        // `memory_projection_dismissals` 只按 scenario/profile 的 id 记录，没有 `memory_id`
        // 列（SQLite 与 DuckDB 两套 schema 都没有），所以这里不能按记忆行过滤——原先的
        // `NOT EXISTS (... d.memory_id = m.id)` 会让整条查询在 DuckDB 绑定阶段失败。
        "SELECT m.id, (SELECT MAX(revision) FROM memory_revisions WHERE memory_id = m.id) AS revision
         FROM memory_records m
         WHERE (m.source_task_id = 'mybuddy-dots' OR json_extract_string(try_cast(m.metadata_json AS JSON), '$.dotsPrivateGateway') IN ('true','1'))
           AND m.status = 'active' AND (m.valid_from IS NULL OR m.valid_from <= ?1) AND m.valid_until IS NULL
         ORDER BY m.explicit DESC, m.importance DESC, m.updated_at DESC, m.id LIMIT 120",
        [now],
    )?;
    Ok(json!({
        "kind": "dotsDueProjection",
        "nextDue": next_due,
        "records": records_list,
    }))
}

fn skill_effectiveness_query(db: &Connection, query: SkillEffectivenessQueryKind) -> Result<Json> {
    use crate::sqlite_rows::records;
    match query {
        SkillEffectivenessQueryKind::ById { id } => Ok(json!({
            "kind": "skillEffectiveness",
            "row": records(db, "SELECT e.*, t.title AS task_title FROM memory_skill_effectiveness e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.id = ?1", [&id])?.pop(),
        })),
        SkillEffectivenessQueryKind::ByTurnSkill { task_id, assistant_message_id, skill_id } => Ok(json!({
            "kind": "skillEffectiveness",
            "row": records(db, "SELECT e.*, t.title AS task_title FROM memory_skill_effectiveness e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.task_id = ?1 AND e.assistant_message_id = ?2 AND e.skill_id = ?3", duckdb::params![task_id, assistant_message_id, skill_id])?.pop(),
        })),
        SkillEffectivenessQueryKind::InvokedForTurn { task_id, assistant_message_id } => Ok(json!({
            "kind": "skillEffectivenessList",
            "rows": records(db, "SELECT * FROM memory_skill_effectiveness WHERE task_id = ?1 AND assistant_message_id = ?2 AND invoked_at IS NOT NULL ORDER BY invoked_at, id", duckdb::params![task_id, assistant_message_id])?,
        })),
        SkillEffectivenessQueryKind::LatestInvocationAfter { skill_id, candidate_id, after } => {
            let latest: Option<i64> = db.query_row(
                "SELECT MAX(invoked_at) FROM memory_skill_effectiveness WHERE skill_id = ?1 AND candidate_id = ?2 AND invoked_at > ?3",
                duckdb::params![skill_id, candidate_id, after],
                |r| r.get(0),
            ).optional()?.flatten();
            Ok(json!({ "kind": "skillEffectivenessLatest", "latest": latest }))
        }
        SkillEffectivenessQueryKind::Recent { limit, invoked_only } => {
            let capped = limit.clamp(1, 1000);
            let sql = if invoked_only {
                "SELECT e.*, t.title AS task_title FROM memory_skill_effectiveness e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.invoked_at IS NOT NULL ORDER BY e.invoked_at DESC, e.id DESC LIMIT ?1"
            } else {
                "SELECT e.*, t.title AS task_title FROM memory_skill_effectiveness e LEFT JOIN tasks t ON t.id = e.task_id ORDER BY e.exposed_at DESC, e.id DESC LIMIT ?1"
            };
            Ok(json!({ "kind": "skillEffectivenessList", "rows": records(db, sql, [capped])? }))
        }
        SkillEffectivenessQueryKind::Summaries { limit } => {
            let capped = limit.clamp(1, 500);
            let rows = records(db,
                "SELECT skill_id, candidate_id,
                    COUNT(*)::BIGINT AS exposures,
                    SUM(CASE WHEN invoked_at IS NOT NULL THEN 1 ELSE 0 END)::BIGINT AS invocations,
                    SUM(CASE WHEN invoked_at IS NOT NULL AND outcome = 'completed' THEN 1 ELSE 0 END)::BIGINT AS completed_invocations,
                    SUM(CASE WHEN invoked_at IS NOT NULL AND outcome = 'failed' THEN 1 ELSE 0 END)::BIGINT AS failed_invocations,
                    SUM(CASE WHEN invoked_at IS NOT NULL AND feedback_kind = 'helpful' THEN 1 ELSE 0 END)::BIGINT AS helpful_count,
                    SUM(CASE WHEN invoked_at IS NOT NULL AND feedback_kind = 'needs_revision' THEN 1 ELSE 0 END)::BIGINT AS needs_revision_count,
                    SUM(CASE WHEN invoked_at IS NOT NULL AND feedback_kind = 'incorrect' THEN 1 ELSE 0 END)::BIGINT AS incorrect_count,
                    MAX(invoked_at) AS last_invoked_at
                 FROM memory_skill_effectiveness
                 GROUP BY skill_id, candidate_id
                 ORDER BY MAX(exposed_at) DESC, skill_id ASC
                 LIMIT ?1",
                [capped],
            )?;
            Ok(json!({ "kind": "skillEffectivenessSummaries", "rows": rows }))
        }
        SkillEffectivenessQueryKind::RevisionById { id } => Ok(json!({
            "kind": "skillRevisionCandidate",
            "row": records(db, "SELECT * FROM memory_skill_revision_candidates WHERE id = ?1", [&id])?.pop(),
        })),
        SkillEffectivenessQueryKind::RevisionList { status, limit } => {
            let capped = limit.clamp(1, 1000);
            let rows = match status {
                Some(st) => records(db, "SELECT * FROM memory_skill_revision_candidates WHERE status = ?1 ORDER BY updated_at DESC, id ASC LIMIT ?2", duckdb::params![st, capped])?,
                None => records(db, "SELECT * FROM memory_skill_revision_candidates ORDER BY updated_at DESC, id ASC LIMIT ?1", [capped])?,
            };
            Ok(json!({ "kind": "skillRevisionCandidateList", "rows": rows }))
        }
        SkillEffectivenessQueryKind::RevisionRefreshFacts { skill_id, candidate_id } => {
            let cid = candidate_id.unwrap_or_default();
            let negative_rows = records(db,
                "SELECT id, feedback_kind, feedback_note, outcome, updated_at
                 FROM memory_skill_effectiveness
                 WHERE skill_id = ?1 AND coalesce(candidate_id, '') = ?2 AND invoked_at IS NOT NULL
                   AND feedback_kind IN ('needs_revision','incorrect')
                 ORDER BY updated_at DESC, id ASC",
                duckdb::params![skill_id, cid],
            )?;
            let failed_count: i64 = db.query_row(
                "SELECT COUNT(*) FROM memory_skill_effectiveness WHERE skill_id = ?1 AND coalesce(candidate_id, '') = ?2 AND invoked_at IS NOT NULL AND outcome = 'failed'",
                duckdb::params![skill_id, cid],
                |r| r.get(0),
            )?;
            Ok(json!({ "kind": "skillRevisionRefreshFacts", "negativeRows": negative_rows, "failedCount": failed_count }))
        }
        SkillEffectivenessQueryKind::RevisionStaleCount { skill_id, candidate_id, keep_id } => {
            let cid = candidate_id.unwrap_or_default();
            let staled: i64 = db.query_row(
                "SELECT COUNT(*) FROM memory_skill_revision_candidates WHERE skill_id = ?1 AND coalesce(base_candidate_id, '') = ?2 AND id <> ?3 AND status IN ('draft','ready')",
                duckdb::params![skill_id, cid, keep_id],
                |r| r.get(0),
            )?;
            Ok(json!({ "kind": "skillRevisionStaleCount", "count": staled }))
        }
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

// Only return evidence attached to the requested revision of a currently visible Dots record.
// Direct tool saves retain the verified message excerpt. Extracted memories must point back
// to the original user turn, including its private admission for channel-origin turns.
fn dots_revision_source(db: &Connection, id: &str, revision: Option<i64>, now: i64) -> Result<Json> {
    let empty = json!({"kind":"dotsRevisionSource","source":null});
    let mut stmt = db.prepare("WITH rev AS (
        SELECT r.*,try_cast(substr(r.change_reason,16) AS JSON) AS ptr FROM memory_revisions r
        WHERE r.memory_id=?1 AND r.revision=coalesce(?2,(SELECT max(revision) FROM memory_revisions WHERE memory_id=?1))
          AND starts_with(r.change_reason,'dots-source-v1 ')
    ) SELECT r.revision,r.change_reason,e.excerpt,t.user_text,t.captured_at,t.task_id
      FROM rev r JOIN memory_records m ON m.id=r.memory_id
      JOIN memory_evidence e ON e.memory_id=m.id
      LEFT JOIN memory_turns t ON t.id=json_extract_string(r.ptr,'$.turnId')
      WHERE m.status<>'invalid' AND (m.valid_from IS NULL OR m.valid_from<=?3)
        AND (m.valid_until IS NULL OR m.valid_until>?3) AND r.status<>'invalid'
        AND NOT starts_with(m.id,'mem_weekly_')
        AND EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND
           ((s.scope_type='task' AND s.scope_id='mybuddy-dots') OR s.scope_type='global'))
        AND ((json_extract_string(r.ptr,'$.turnId') IS NULL AND m.source_task_id='mybuddy-dots'
              AND e.evidence_kind='message' AND e.ref_id=json_extract_string(r.ptr,'$.messageId'))
          OR (e.evidence_kind='conversation' AND e.ref_id=t.id AND t.user_message_id=json_extract_string(r.ptr,'$.messageId')
              AND (t.task_id='mybuddy-dots' AND m.source_task_id='mybuddy-dots'
                OR (m.source_task_id=t.task_id AND m.kind IN ('identity','preference','constraint')
                  AND json_extract_string(m.metadata_json,'$.dotsPrivateGateway')='true'
                  AND NOT EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND
                    (s.scope_type<>'task' OR s.scope_id IS DISTINCT FROM 'mybuddy-dots'))
                  AND json_extract_string(t.metadata_json,'$.gatewayOrigin.audience')='private'
                  AND EXISTS (SELECT 1 FROM gateway_dots_tasks g JOIN gateway_dots_admissions a ON a.binding_id=g.binding_id
                    WHERE g.task_id=t.task_id AND g.binding_id=json_extract_string(t.metadata_json,'$.gatewayOrigin.personalMemoryBindingId')
                      AND a.channel_id IN ('qq-default','weixin-default','feishu-default')
                      AND a.channel_id=json_extract_string(t.metadata_json,'$.gatewayOrigin.channelId')
                      AND a.connection_key=json_extract_string(t.metadata_json,'$.gatewayOrigin.connectionKey')
                      AND a.chat_id=json_extract_string(t.metadata_json,'$.gatewayOrigin.chatId')
                      AND a.message_id=json_extract_string(t.metadata_json,'$.gatewayOrigin.messageId'))))))
        ORDER BY e.created_at DESC,e.id LIMIT 1")?;
    let mut rows=stmt.query(duckdb::params![id,revision,now])?;
    let Some(row)=rows.next()? else { return Ok(empty); };
    let revision:i64=row.get(0)?;
    let reason:String=row.get(1)?;
    let excerpt:Option<String>=row.get(2)?;
    let user_text:Option<String>=row.get(3)?;
    let turn_at:Option<i64>=row.get(4)?;
    let task:Option<String>=row.get(5)?;
    let Some(pointer)=reason.strip_prefix("dots-source-v1 ").and_then(|s| serde_json::from_str::<Json>(s).ok()) else {return Ok(empty)};
    let (Some(at),Some(message))=(pointer["capturedAt"].as_i64(),pointer["messageId"].as_str()) else {return Ok(empty)};
    if turn_at.is_some_and(|time| time!=at) {return Ok(empty);}
    // Compare durable message order on an equal timestamp, exactly as fixture sourceFilter does.
    let predicate="(scope_type='global' AND scope_id='' OR scope_type='task' AND scope_id IN ('mybuddy-dots',?1))
        AND (cutoff_at>?2 OR cutoff_at=?2 AND (allowed_message_id IS NULL OR allowed_message_id=?3 OR
          ((SELECT ordinal FROM bot_messages WHERE message_id=?3) >
           (SELECT ordinal FROM bot_messages WHERE message_id=allowed_message_id)) IS NOT TRUE))";
    let args=duckdb::params![task.as_deref().unwrap_or("mybuddy-dots"),at,message];
    let coarse:bool=db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM memory_forget_watermarks WHERE {predicate})"),args,|r|r.get(0))?;
    if coarse {return Ok(empty);}
    let mut stmt=db.prepare(&format!("SELECT fingerprint,text_length,value_fingerprint,guard_fingerprint,guard_length FROM memory_forget_targets WHERE {predicate}"))?;
    let targets=stmt.query_map(args,|r| Ok(json!({"fingerprint":r.get::<_,String>(0)?,"text_length":r.get::<_,i64>(1)?,
        "value_fingerprint":r.get::<_,Option<String>>(2)?,"guard_fingerprint":r.get::<_,Option<String>>(3)?,
        "guard_length":r.get::<_,Option<i64>>(4)?})))?.collect::<duckdb::Result<Vec<_>>>()?;
    Ok(json!({"kind":"dotsRevisionSource","source":{"revision":revision,"reason":reason,"excerpt":excerpt,"userText":user_text,"targets":targets}}))
}
