use crate::Result;
use crate::resource_gate::ResourceKey;
use crate::sqlite_rows::records;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};

const LEASE_MS: i64 = 120_000;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Bindings {
        task: Option<String>,
    },
    Source {
        key: String,
        task: String,
        conversation: String,
        entry: i64,
    },
    Children {
        task: String,
    },
    Checkpoint {
        task: String,
        conversation: String,
    },
    Managed,
    Groups,
    Samples {
        key: String,
    },
    Unverified {
        key: String,
        source: String,
    },
    Unfinished {
        through: String,
    },
    AssessmentCandidates {
        week: String,
    },
    WeeklyStats {
        week: String,
        start: i64,
        end: i64,
    },
    Report {
        export_week: Option<String>,
    },
    SubagentDiagnostics {
        task: String,
        id: String,
    },
    SourceContext {
        task: String,
        conversation: String,
        generation: i64,
        actor: String,
        assistant_message_id: Option<String>,
        operation: Option<String>,
        goal_id: Option<String>,
        goal_revision: Option<i64>,
        evidence_refs_json: Option<String>,
        input_snapshot_id: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Begin {
        owner: String,
        week: String,
        at: i64,
        scheduled: bool,
    },
    Renew {
        owner: String,
    },
    Release {
        owner: String,
    },
    Write {
        owner: String,
        change: Change,
    },
}

#[derive(Deserialize)]
pub struct Observation {
    key: String,
    kind: String,
    scope: String,
    entry: i64,
    source: String,
    replay: String,
    generation: Option<i64>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Change {
    SaveScan {
        week: String,
        task: String,
        conversation: String,
        state: String,
        observations: Vec<Observation>,
        scanned: i64,
    },
    SaveChild {
        task: String,
        directory: String,
        conversation: i64,
        child_id: String,
        immutable: bool,
        summary: String,
    },
    PruneChildren {
        task: String,
        seen: Vec<i64>,
    },
    ReserveSlot {
        key: String,
        week: String,
    },
    ReleaseSlot {
        key: String,
        week: String,
    },
    SaveManaged {
        key: String,
        hook: String,
        revision: i64,
        installed: i64,
        week: String,
    },
    Unverified {
        key: String,
        source: String,
        reason: String,
    },
    Followup {
        week: String,
        key: String,
        metrics: String,
    },
    FinishScan {
        week: String,
        at: i64,
        duration: i64,
        issues: String,
    },
    MarkExported {
        week: String,
        finished: bool,
    },
    SealReview {
        week: String,
    },
    ReserveAssessment {
        key: String,
        week: String,
        source: String,
    },
    AssessmentStarted {
        week: String,
    },
    AssessmentResult {
        key: String,
        week: String,
        source: String,
        assessment: Option<String>,
        error: Option<String>,
    },
}

pub fn resource() -> ResourceKey {
    ResourceKey::Entity("improvement-review".into(), "lease".into())
}

fn groups(db: &Connection) -> Result<Vec<Value>> {
    records(db,
        "SELECT key,kind,scope,count(*) total,max(TRY_CAST(json_extract(replay,'$.repairMs') AS DOUBLE)) cost
         FROM improvement_observations GROUP BY key,kind,scope
         HAVING kind<>'sequence' OR count(DISTINCT (task,conversation,json_extract(source,'$.input')))>=2",
        [],
    )
}

fn managed(db: &Connection) -> Result<Vec<Value>> {
    records(
        db,
        "SELECT key,hook,revision,installed,week FROM improvement_managed ORDER BY key",
        [],
    )
}

fn report(db: &Connection, export_week: Option<String>) -> Result<Value> {
    let mut items = groups(db)?;
    for item in &mut items {
        let key = item["key"]
            .as_str()
            .ok_or("missing improvement observation key")?
            .to_owned();
        item["sources"] = records(
            db,
            "SELECT source FROM improvement_observations WHERE key=? ORDER BY seq_ord DESC LIMIT 8",
            [&key],
        )?
        .into();
        item["feedback"] = records(db,
            "SELECT o.task,o.conversation,o.generation FROM improvement_observations o JOIN improvement_managed m ON m.key=o.key
             WHERE o.key=? AND o.generation IS NOT NULL AND CAST(json_extract(o.source,'$.at') AS BIGINT)>=m.installed",
            [&key],
        )?.into();
        item["pendingReason"] = json!(
            db.query_row(
                "SELECT reason FROM improvement_unverified WHERE key=?",
                [&key],
                |r| { r.get::<_, String>(0) }
            )
            .optional()?
        );
        item["assessment"] = records(db,
            "SELECT assessment,source FROM improvement_assessments WHERE key=? AND assessment IS NOT NULL ORDER BY week DESC LIMIT 1",
            [&key],
        )?.pop().unwrap_or(Value::Null);
    }
    let mut runs = records(
        db,
        r#"
        SELECT c.week,c."at",c.scanned,c.added,c.issues,
               (SELECT count(*) FROM improvement_managed m WHERE m.week=c.week) published
        FROM improvement_cycles c WHERE c.week IN (SELECT week FROM improvement_cycles ORDER BY week DESC LIMIT 12)
        OR c.week=? ORDER BY c.week DESC
    "#,
        [export_week],
    )?;
    for run in &mut runs {
        let week = run["week"]
            .as_str()
            .ok_or("missing improvement reporting week")?
            .to_owned();
        run["followup"] = records(
            db,
            "SELECT metrics FROM improvement_followup WHERE week=? ORDER BY key",
            [&week],
        )?
        .into();
        run["assessmentErrors"] = records(db,
            "SELECT error FROM improvement_assessments WHERE week=? AND error IS NOT NULL ORDER BY key", [&week],
        )?.into();
    }
    let children = records(
        db,
        "SELECT task,directory,summary FROM improvement_child_evidence
         ORDER BY TRY_CAST(json_extract(summary,'$.startedAt') AS BIGINT) DESC,task,conversation",
        [],
    )?;
    Ok(json!({ "managed": managed(db)?, "items": items, "runs": runs, "children": children }))
}

fn read_inner(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Bindings { task } => Ok(records(db, r#"
            SELECT b.task_id AS "taskId", b.directory, b.cwd, t.project_id AS "projectId", t.space_id AS "spaceId"
            FROM durable_bot_bindings b JOIN tasks t ON t.id=b.task_id
            WHERE ?1 IS NULL OR b.task_id=?1 ORDER BY b.task_id
        "#, [task])?.into()),
        Query::Source { key, task, conversation, entry } => Ok(json!(db.query_row(
            "SELECT source FROM improvement_observations WHERE key=? AND task=? AND conversation=? AND entry=? ORDER BY seq_ord DESC LIMIT 1",
            params![key, task, conversation, entry], |r| r.get::<_, String>(0),
        ).optional()?)),
        Query::Children { task } => Ok(records(db,
            r#"SELECT directory,conversation,childId AS "childId",immutable=1 AS immutable FROM improvement_child_evidence WHERE task=?"#, [task],
        )?.into()),
        Query::Checkpoint { task, conversation } => Ok(json!(db.query_row(
            "SELECT state FROM improvement_checkpoints WHERE task=? AND conversation=?",
            params![task, conversation], |r| r.get::<_, String>(0),
        ).optional()?)),
        Query::Managed => Ok(managed(db)?.into()),
        Query::Groups => Ok(groups(db)?.into()),
        Query::Samples { key } => Ok(records(db,
            "SELECT task,source,replay FROM improvement_observations WHERE key=? ORDER BY seq_ord DESC LIMIT 3", [key],
        )?.into()),
        Query::Unverified { key, source } => Ok(db.query_row(
            "SELECT EXISTS (SELECT 1 FROM improvement_unverified WHERE key=? AND source=?)",
            params![key, source], |r| r.get::<_, bool>(0),
        )?.into()),
        Query::Unfinished { through } => Ok(records(db,
            "SELECT week FROM improvement_cycles WHERE finished=0 AND week<=? ORDER BY week", [through],
        )?.into()),
        Query::AssessmentCandidates { week } => Ok(records(db, r#"
            WITH ranked AS (
                SELECT key,source,row_number() OVER (PARTITION BY key ORDER BY seq_ord DESC) position,
                       count(*) OVER (PARTITION BY key) total
                FROM improvement_observations
                WHERE kind IN ('correction','handoff','redundant','recovery','childDelivery','childSteer','deliveryContract','oscillation','sequence','progress')
                AND (kind<>'sequence' OR key IN (
                    SELECT key FROM improvement_observations WHERE kind='sequence' GROUP BY key
                    HAVING count(DISTINCT (task,conversation,json_extract(source,'$.input')))>=2
                ))
            )
            SELECT r.key,r.source FROM ranked r WHERE r.position=1 AND NOT EXISTS (
                SELECT 1 FROM improvement_assessments a WHERE a.key=r.key
                AND ((a.week=? AND coalesce(a.error,'')<>'运行中') OR (a.source=r.source AND a.assessment IS NOT NULL))
            ) ORDER BY total DESC,key
        "#, [week])?.into()),
        Query::WeeklyStats { week, start, end } => {
            let cost: Option<(i64,i64)> = db.query_row("SELECT duration,requests FROM weekly_cost WHERE week=?", [week],
                |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            let corrections: i64 = db.query_row(
                "SELECT count(*) FROM improvement_observations WHERE kind='deliveryContract'
                 AND CAST(json_extract(source,'$.at') AS BIGINT)>=? AND CAST(json_extract(source,'$.at') AS BIGINT)<?",
                params![start,end], |r| r.get(0),
            )?;
            let (duration, requests) = cost.unwrap_or_default();
            Ok(json!({ "durationMs": duration, "modelRequests": requests, "corrections": corrections }))
        }
        Query::Report { export_week } => report(db, export_week),
        Query::SubagentDiagnostics { task, id } => subagent_diagnostics(db, &task, &id),
        Query::SourceContext {
            task,
            conversation,
            generation,
            actor,
            assistant_message_id,
            operation,
            goal_id,
            goal_revision,
            evidence_refs_json,
            input_snapshot_id,
        } => source_context(
            db,
            &task,
            &conversation,
            generation,
            &actor,
            assistant_message_id.as_deref(),
            operation.as_deref(),
            goal_id.as_deref(),
            goal_revision,
            evidence_refs_json.as_deref(),
            input_snapshot_id.as_deref(),
        ),
    }
}

fn subagent_diagnostics(db: &Connection, task: &str, id: &str) -> Result<Value> {
    let row = db.query_row(
        "WITH requests AS (
            SELECT record_json AS r FROM task_request_diagnostics
            WHERE task_id = ?1
              AND json_extract_string(try_cast(record_json AS JSON), '$.sourceKind') = 'subagent'
              AND json_extract_string(try_cast(record_json AS JSON), '$.executionScope') = ?1
              AND json_extract_string(try_cast(record_json AS JSON), '$.conversationId') = ?2
         ), execution_ids AS (
            SELECT COALESCE(
                json_extract_string(try_cast(r AS JSON), '$.executionId'),
                'durable:' || ?1 || ':' || ?2 || ':' || COALESCE(json_extract_string(try_cast(r AS JSON), '$.generationTaskId'), '')
            ) AS id FROM requests
            UNION
            SELECT json_extract_string(try_cast(record_json AS JSON), '$.executionId') AS id
            FROM task_tool_diagnostics
            WHERE task_id = ?1
              AND json_extract_string(try_cast(record_json AS JSON), '$.sourceKind') = 'subagent'
              AND json_extract_string(try_cast(record_json AS JSON), '$.conversationId') = ?2
         ), waits AS (
            SELECT i.* FROM conversation_interactions i
            WHERE i.task_id = ?1 AND i.execution_id IN (SELECT id FROM execution_ids WHERE id IS NOT NULL)
         )
         SELECT
            count(*)::BIGINT,
            CASE WHEN count(TRY_CAST(json_extract_string(try_cast(r AS JSON), '$.usage.input') AS DOUBLE)) = count(*)
                 THEN CAST(sum(TRY_CAST(json_extract_string(try_cast(r AS JSON), '$.usage.input') AS DOUBLE)) AS BIGINT) END,
            CASE WHEN count(TRY_CAST(json_extract_string(try_cast(r AS JSON), '$.usage.output') AS DOUBLE)) = count(*)
                 THEN CAST(sum(TRY_CAST(json_extract_string(try_cast(r AS JSON), '$.usage.output') AS DOUBLE)) AS BIGINT) END,
            CASE WHEN count(TRY_CAST(json_extract_string(try_cast(r AS JSON), '$.usage.cacheRead') AS DOUBLE)) = count(*)
                 THEN CAST(sum(TRY_CAST(json_extract_string(try_cast(r AS JSON), '$.usage.cacheRead') AS DOUBLE)) AS BIGINT) END,
            (SELECT count(*)::BIGINT FROM waits),
            (SELECT count(*)::BIGINT FROM waits WHERE status = 'resolved'),
            (SELECT CAST(sum(GREATEST(0, resolved_at - created_at)) AS BIGINT) FROM waits WHERE resolved_at IS NOT NULL)
         FROM requests",
        params![task, id],
        |r| {
            Ok(json!({
                "requests": r.get::<_, i64>(0)?,
                "inputTokens": r.get::<_, Option<i64>>(1)?,
                "outputTokens": r.get::<_, Option<i64>>(2)?,
                "cacheReadTokens": r.get::<_, Option<i64>>(3)?,
                "waits": r.get::<_, i64>(4)?,
                "answered": r.get::<_, i64>(5)?,
                "waitMs": r.get::<_, Option<i64>>(6)?,
            }))
        },
    )?;
    Ok(row)
}

#[allow(clippy::too_many_arguments)]
fn source_context(
    db: &Connection,
    task: &str,
    conversation: &str,
    generation: i64,
    actor: &str,
    assistant_message_id: Option<&str>,
    operation: Option<&str>,
    goal_id: Option<&str>,
    goal_revision: Option<i64>,
    evidence_refs_json: Option<&str>,
    input_snapshot_id: Option<&str>,
) -> Result<Value> {
    let gen_str = generation.to_string();
    let read_diag = |table: &str| -> Result<Vec<Value>> {
        let sql = format!(
            "SELECT record_json FROM {table}
             WHERE task_id = ?1
               AND json_extract_string(try_cast(record_json AS JSON), '$.conversationId') = ?2
               AND json_extract_string(try_cast(record_json AS JSON), '$.generationTaskId') = ?3
               AND json_extract_string(try_cast(record_json AS JSON), '$.sourceKind') = ?4
               AND (json_extract_string(try_cast(record_json AS JSON), '$.executionScope') = ?1
                    OR json_extract_string(try_cast(record_json AS JSON), '$.executionScope') IS NULL)
             ORDER BY started_at LIMIT 64"
        );
        let mut stmt = db.prepare(&sql)?;
        let rows = stmt
            .query_map(params![task, conversation, gen_str, actor], |r| r.get::<_, String>(0))?
            .collect::<duckdb::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
            .collect())
    };
    let requests = read_diag("task_request_diagnostics")?;
    let tools = read_diag("task_tool_diagnostics")?;
    let mut exec_ids: Vec<String> = requests
        .iter()
        .chain(tools.iter())
        .filter_map(|r| r.get("executionId").and_then(Value::as_str).map(str::to_owned))
        .collect();
    exec_ids.sort();
    exec_ids.dedup();
    let mut interactions = Vec::new();
    for eid in &exec_ids {
        interactions.extend(records(
            db,
            "SELECT id, execution_id, kind, status, created_at, resolved_at
             FROM conversation_interactions WHERE task_id = ?1 AND execution_id = ?2
             ORDER BY created_at LIMIT 100",
            params![task, eid],
        )?);
    }
    let loadout = match assistant_message_id {
        Some(mid) => records(
            db,
            "SELECT actual_json, blocked_json, used_skill_ids_json, outcome
             FROM agent_loadout_observations WHERE task_id = ?1 AND assistant_message_id = ?2",
            params![task, mid],
        )?
        .pop()
        .unwrap_or(Value::Null),
        None => Value::Null,
    };
    let work_outcome = match operation {
        Some(op) if actor == "main" && !op.is_empty() => {
            let binding = records(
                db,
                "SELECT binding_id, work_id, intent_revision, owner_epoch, input_snapshot_id, status
                 FROM work_execution_bindings WHERE task_id = ?1 AND conversation_id = ?2 AND operation_id = ?3",
                params![task, conversation, op],
            )?
            .pop();
            match binding {
                Some(b) => {
                    let bid = b["binding_id"].as_str().unwrap_or_default().to_owned();
                    let wid = b["work_id"].as_str().unwrap_or_default().to_owned();
                    let irev = b["intent_revision"].as_i64().unwrap_or_default();
                    let epoch = b["owner_epoch"].as_i64().unwrap_or_default();
                    let snap = b["input_snapshot_id"].as_str().unwrap_or_default().to_owned();
                    let deliveries = records(
                        db,
                        "SELECT deliverable_id, status, artifact_refs_json, evidence_refs_json, is_speculation, has_write_conflicts
                         FROM work_deliverables
                         WHERE execution_id = ?1 AND work_id = ?2 AND intent_revision = ?3 AND owner_epoch = ?4 AND input_snapshot_id = ?5
                         ORDER BY created_at LIMIT 64",
                        params![bid, wid, irev, epoch, snap],
                    )?;
                    json!({ "binding": b, "deliveries": deliveries })
                }
                None => Value::Null,
            }
        }
        _ => Value::Null,
    };
    let goal_evidence = match (goal_id, goal_revision, input_snapshot_id) {
        (Some(gid), Some(rev), Some(snap)) => match evidence_refs_json {
            Some(refs) => records(
                db,
                "SELECT evidence_id, kind, provenance, source_ref, criterion_ids_json
                 FROM work_evidence
                 WHERE work_id = ?1 AND intent_revision = ?2 AND input_snapshot_id = ?3
                   AND evidence_id IN (SELECT json_extract_string(value, '$') FROM json_each(?4))
                 ORDER BY recorded_at",
                params![gid, rev, snap, refs],
            )?,
            None => records(
                db,
                "SELECT evidence_id, kind, provenance, source_ref, criterion_ids_json
                 FROM work_evidence
                 WHERE work_id = ?1 AND intent_revision = ?2 AND input_snapshot_id = ?3
                 ORDER BY recorded_at LIMIT 64",
                params![gid, rev, snap],
            )?,
        },
        _ => Vec::new(),
    };
    Ok(json!({
        "requests": requests,
        "tools": tools,
        "interactions": interactions,
        "loadout": loadout,
        "workOutcome": work_outcome,
        "goalEvidence": goal_evidence,
    }))
}

pub fn read(db: &mut Connection, query: Query) -> Result<Value> {
    let tx = db.transaction()?;
    let data = read_inner(&tx, query)?;
    tx.commit()?;
    Ok(json!({ "status": "ok", "data": data }))
}

fn needs_review(db: &Connection, week: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM improvement_cycles WHERE week=? AND finished=1)
                OR NOT EXISTS (SELECT 1 FROM release_review_weeks WHERE week=?)
                OR EXISTS (SELECT 1 FROM improvement_cycles WHERE finished=0 AND week<?)
                OR EXISTS (SELECT 1 FROM improvement_dirty_weeks WHERE week<=?)",
        params![week, week, week, week],
        |r| r.get(0),
    )?)
}

pub fn write(db: &mut Connection, mutation: Mutation) -> Result<Value> {
    let tx = db.transaction()?;
    let now = crate::request_control::now_ms() as i64;
    let data = match mutation {
        Mutation::Begin { owner, week, at, scheduled } => {
            let active: Option<String> = tx.query_row("SELECT owner FROM improvement_review_lease WHERE id=1 AND expires_at>?", [now],
                |r| r.get(0)).optional()?;
            if let Some(active) = active {
                return Ok(json!({ "status": "ok", "data": active == owner }));
            }
            if scheduled && !needs_review(&tx, &week)? {
                return Ok(json!({ "status": "ok", "data": false }));
            }
            tx.execute("INSERT INTO improvement_review_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET
                        owner=excluded.owner,expires_at=excluded.expires_at", params![owner, now + LEASE_MS])?;
            tx.execute(r#"INSERT INTO improvement_cycles(week,"at") VALUES(?,?)
                          ON CONFLICT(week) DO UPDATE SET "at"=excluded."at",finished=0"#, params![week,at])?;
            true.into()
        }
        Mutation::Renew { owner } => (tx.execute(
            "UPDATE improvement_review_lease SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?",
            params![now + LEASE_MS,owner,now],
        )? > 0).into(),
        Mutation::Release { owner } => {
            tx.execute("DELETE FROM improvement_review_lease WHERE id=1 AND owner=?", [owner])?;
            Value::Null
        }
        Mutation::Write { owner, change } => {
            let active: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM improvement_review_lease WHERE id=1 AND owner=? AND expires_at>?)",
                params![owner, now], |r| r.get(0))?;
            if !active {
                return Ok(json!({ "status": "rejected", "message": "改进复盘所有权已失效" }));
            }
            apply(&tx, change)?
        }
    };
    crate::request_control::commit(tx)?;
    Ok(json!({ "status": "ok", "data": data }))
}

fn apply(db: &Connection, change: Change) -> Result<Value> {
    match change {
        Change::SaveScan {
            week,
            task,
            conversation,
            state,
            observations,
            scanned,
        } => {
            let mut added = 0;
            for observation in observations {
                added += db.execute(
                    "INSERT INTO improvement_observations VALUES(?,?,?,?,?,?,?,?,?,nextval('improvement_event_order')) ON CONFLICT DO NOTHING",
                    params![observation.key,observation.kind,observation.scope,task,conversation,observation.entry,
                            observation.source,observation.replay,observation.generation],
                )?;
            }
            let advanced = db.execute(
                "INSERT INTO improvement_checkpoints VALUES(?,?,?) ON CONFLICT(task,conversation) DO UPDATE SET state=excluded.state
                 WHERE (coalesce(CAST(json_extract(excluded.state,'$.analysisVersion') AS BIGINT),0),CAST(json_extract(excluded.state,'$.last') AS BIGINT))
                    > (coalesce(CAST(json_extract(improvement_checkpoints.state,'$.analysisVersion') AS BIGINT),0),CAST(json_extract(improvement_checkpoints.state,'$.last') AS BIGINT))",
                params![task,conversation,state],
            )?;
            db.execute(
                "UPDATE improvement_cycles SET scanned=scanned+?,added=added+? WHERE week=?",
                params![if advanced > 0 { scanned } else { 0 }, added as i64, week],
            )?;
        }
        Change::SaveChild {
            task,
            directory,
            conversation,
            child_id,
            immutable,
            summary,
        } => {
            db.execute("INSERT INTO improvement_child_evidence VALUES(?,?,?,?,?,?) ON CONFLICT(task,conversation) DO UPDATE
                        SET directory=excluded.directory,childId=excluded.childId,immutable=excluded.immutable,summary=excluded.summary",
                params![task,directory,conversation,child_id,i64::from(immutable),summary])?;
        }
        Change::PruneChildren { task, seen } => {
            db.execute(
                "DELETE FROM improvement_child_evidence WHERE task=? AND conversation NOT IN
                        (SELECT CAST(value AS BIGINT) FROM json_each(?))",
                params![task, serde_json::to_string(&seen)?],
            )?;
        }
        Change::ReserveSlot { key, week } => {
            let existing: Option<String> = db
                .query_row(
                    "SELECT week FROM improvement_slots WHERE key=?",
                    [&key],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                return Ok(existing.into());
            }
            let used: i64 = db.query_row(
                "SELECT count(*) FROM improvement_slots WHERE week=?",
                [&week],
                |r| r.get(0),
            )?;
            if used >= 5 {
                return Ok(Value::Null);
            }
            db.execute(
                "INSERT INTO improvement_slots VALUES(?,?)",
                params![key, week],
            )?;
            return Ok(week.into());
        }
        Change::ReleaseSlot { key, week } => {
            db.execute(
                "DELETE FROM improvement_slots WHERE key=? AND week=?",
                params![key, week],
            )?;
        }
        Change::SaveManaged {
            key,
            hook,
            revision,
            installed,
            week,
        } => {
            db.execute(
                "INSERT INTO improvement_managed VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
                params![key, hook, revision, installed, week],
            )?;
        }
        Change::Unverified {
            key,
            source,
            reason,
        } => {
            db.execute(
                "INSERT INTO improvement_unverified VALUES(?,?,?) ON CONFLICT(key) DO UPDATE
                        SET source=excluded.source,reason=excluded.reason",
                params![key, source, reason],
            )?;
        }
        Change::Followup { week, key, metrics } => {
            db.execute(
                "INSERT INTO improvement_followup VALUES(?,?,?) ON CONFLICT(week,key) DO UPDATE
                        SET metrics=excluded.metrics",
                params![week, key, metrics],
            )?;
        }
        Change::FinishScan {
            week,
            at,
            duration,
            issues,
        } => {
            db.execute(
                "INSERT INTO weekly_cost(week,duration) VALUES(?,?) ON CONFLICT(week) DO UPDATE
                        SET duration=weekly_cost.duration+excluded.duration",
                params![week, duration],
            )?;
            db.execute(
                "UPDATE improvement_cycles SET issues=? WHERE week=?",
                params![issues, week],
            )?;
            db.execute(r#"
                INSERT INTO improvement_cycles(week,"at")
                SELECT CAST(CAST(week AS DATE) AS VARCHAR),?
                FROM generate_series((SELECT CAST(max(week) AS DATE) FROM improvement_cycles WHERE week<? AND finished=1) + 7,
                                     CAST(? AS DATE) - 7,INTERVAL '7 days') AS missed(week)
                ON CONFLICT DO NOTHING
            "#, params![at,week,week])?;
        }
        Change::MarkExported { week, finished } => {
            db.execute(
                "UPDATE improvement_cycles SET finished=? WHERE week=?",
                params![i64::from(finished), week],
            )?;
        }
        Change::SealReview { week } => {
            db.execute(
                "INSERT INTO child_review_weeks VALUES(?) ON CONFLICT DO NOTHING",
                [&week],
            )?;
            db.execute(
                "INSERT INTO release_review_weeks VALUES(?) ON CONFLICT DO NOTHING",
                [&week],
            )?;
        }
        Change::ReserveAssessment { key, week, source } => {
            let exists: Option<bool> = db.query_row("SELECT coalesce(error='运行中',false) FROM improvement_assessments WHERE key=? AND week=?",
                params![key,week], |r| r.get(0)).optional()?;
            if let Some(pending) = exists {
                if pending {
                    db.execute(
                        "UPDATE improvement_assessments SET source=? WHERE key=? AND week=?",
                        params![source, key, week],
                    )?;
                }
                return Ok(pending.into());
            }
            let inserted = db.execute(
                "INSERT INTO improvement_assessments SELECT ?,?,?,NULL,'运行中' WHERE (SELECT count(*) FROM improvement_assessments WHERE week=?)<5",
                params![key,week,source,week],
            )?;
            return Ok((inserted > 0).into());
        }
        Change::AssessmentStarted { week } => {
            db.execute(
                "INSERT INTO weekly_cost(week,requests) VALUES(?,1) ON CONFLICT(week) DO UPDATE
                        SET requests=weekly_cost.requests+1",
                [week],
            )?;
        }
        Change::AssessmentResult {
            key,
            week,
            source,
            assessment,
            error,
        } => {
            db.execute("UPDATE improvement_assessments SET assessment=?,error=? WHERE key=? AND week=? AND source=? AND error='运行中'",
                params![assessment,error,key,week,source])?;
        }
    }
    Ok(Value::Null)
}
