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
    }
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
