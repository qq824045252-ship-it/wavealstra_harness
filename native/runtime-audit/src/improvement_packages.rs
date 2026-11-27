use crate::Result;
use crate::resource_gate::ResourceKey;
use crate::sqlite_rows::records;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    task: String,
    conversation: String,
    run: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(flatten)]
    run: Run,
    actor: String,
    kind: String,
    event: String,
    generation: String,
    detail: String,
    at: i64,
}

#[derive(Deserialize)]
pub struct Regression {
    hash: String,
    input: String,
}

#[derive(Deserialize)]
pub struct Input {
    entry: i64,
    at: i64,
    eligible: bool,
    project: Option<String>,
    workspace: Option<String>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Current {
        id: String,
    },
    Version {
        id: String,
        revision: i64,
    },
    Select {
        task: String,
        project: Option<String>,
        workspace: Option<String>,
    },
    List,
    Staged {
        hash: String,
    },
    RegressionInputs {
        id: String,
    },
    RollbackCandidates {
        id: String,
        before_revision: i64,
    },
    Uses {
        id: String,
        revision: i64,
    },
    PendingAcceptance {
        task: String,
    },
    SourceUses {
        run: Run,
    },
    Replays {
        week: String,
    },
    Report,
    Metrics {
        start: i64,
        end: i64,
    },
    DirtyWeeks {
        through: String,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Stage {
        id: String,
        hash: String,
        draft: String,
        replays: String,
        regression_seq: i64,
    },
    Activate {
        id: String,
        hash: String,
        generation: i64,
        at: i64,
    },
    Disable {
        id: String,
        generation: i64,
        at: i64,
    },
    Revert {
        id: String,
        generation: i64,
        fallback: Vec<i64>,
        at: i64,
    },
    Record {
        id: String,
        revision: i64,
        usage: Usage,
        regression: Option<Regression>,
        fallback: Vec<i64>,
        decision_at: i64,
    },
    Correction {
        run: Run,
        actor: String,
        generation: String,
        at: i64,
    },
    IndexInputs {
        task: String,
        conversation: String,
        actor: String,
        inputs: Vec<Input>,
    },
    Followup {
        week: String,
        start: i64,
        end: i64,
        now: i64,
    },
    AcknowledgeWeek {
        week: String,
        tokens: Vec<i64>,
    },
}

fn package(id: &str) -> ResourceKey {
    ResourceKey::Entity("improvement-package".into(), id.into())
}

fn run_key(run: &Run) -> ResourceKey {
    ResourceKey::Entity(
        "improvement-run".into(),
        json!([run.task, run.conversation, run.run]).to_string(),
    )
}

impl Mutation {
    pub fn resources(&self) -> Vec<ResourceKey> {
        match self {
            Self::Stage { id, .. }
            | Self::Activate { id, .. }
            | Self::Disable { id, .. }
            | Self::Revert { id, .. } => vec![package(id)],
            Self::Record { id, usage, .. } => vec![package(id), run_key(&usage.run)],
            Self::Correction { run, .. } => vec![run_key(run)],
            Self::IndexInputs {
                task, conversation, ..
            } => vec![ResourceKey::Entity(
                "improvement-inputs".into(),
                json!([task, conversation]).to_string(),
            )],
            Self::Followup { week, .. } | Self::AcknowledgeWeek { week, .. } => {
                vec![ResourceKey::Entity(
                    "improvement-report".into(),
                    week.clone(),
                )]
            }
        }
    }
}

const VERSIONS: &str = "SELECT v.id,v.revision,h.generation,(h.enabled=1 AND v.retired=0) enabled,
    v.previous,v.hash,s.draft FROM improvement_heads h JOIN improvement_versions v ON v.id=h.id
    JOIN improvement_staged s ON s.hash=v.hash";
const USE_COLUMNS: &str =
    r#"id,revision,task,conversation,actor,run,kind,event,generation,detail,"at""#;
const CONFLICT: &str = "基础版本已变化，请重新验证";
const STALE_REPLAY: &str = "回放证据已变化，请重新验证";

fn one(mut rows: Vec<Value>) -> Value {
    rows.pop().unwrap_or(Value::Null)
}

fn version_rows(
    db: &Connection,
    predicate: &str,
    bindings: impl duckdb::Params,
) -> Result<Vec<Value>> {
    records(db, &format!("{VERSIONS} {predicate}"), bindings)
}

fn current(db: &Connection, id: &str) -> Result<Value> {
    Ok(one(version_rows(
        db,
        "WHERE h.id=? AND h.revision=v.revision",
        [id],
    )?))
}

fn report(db: &Connection) -> Result<Value> {
    let packages = version_rows(
        db,
        r#"WHERE v.revision=h.revision ORDER BY v."at" DESC,v.id"#,
        [],
    )?;
    let versions = records(
        db,
        r#"
        WITH ranked AS (
          SELECT id, revision, task, conversation, actor, run, kind, event, "at",
                 count(*) OVER (PARTITION BY id,revision) AS use_count,
                 row_number() OVER (PARTITION BY id,revision ORDER BY "at" DESC,seq_ord DESC) AS position
          FROM improvement_uses
        ), samples AS (
          SELECT id,revision,max(use_count) use_count,
                 CAST(to_json(list(struct_pack(task:=task,conversation:=conversation,actor:=actor,run:=run,
                      kind:=kind,event:=event,"at":="at") ORDER BY position)) AS VARCHAR) uses
          FROM ranked WHERE position<=32 GROUP BY id,revision
        )
        SELECT v.id,v.revision,v.previous,v.retired,v.hash,(h.revision=v.revision AND h.enabled=1) active,
               s.draft,s.replays,coalesce(u.use_count,0) AS "useCount",coalesce(u.uses,'[]') AS uses
        FROM improvement_versions v JOIN improvement_heads h ON h.id=v.id
        JOIN improvement_staged s ON s.hash=v.hash LEFT JOIN samples u ON u.id=v.id AND u.revision=v.revision
        ORDER BY v."at" DESC,v.revision DESC,v.id
    "#,
        [],
    )?;
    let outcomes = records(
        db,
        "SELECT result FROM improvement_results ORDER BY week DESC,id,revision DESC",
        [],
    )?;
    Ok(json!({ "packages": packages, "versions": versions, "outcomes": outcomes }))
}

fn read_inner(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Current { id } => current(db, &id),
        Query::Version { id, revision } => Ok(one(version_rows(db, "WHERE v.id=? AND v.revision=?", params![id, revision])?)),
        Query::Select { task, project, workspace } => Ok(one(version_rows(db,
            r#"WHERE v.revision=h.revision AND h.enabled=1 AND v.retired=0
               AND ((h.scopeKind='task' AND h.scopeId=?) OR (h.scopeKind='project' AND h.scopeId=?) OR (h.scopeKind='workspace' AND h.scopeId=?))
               ORDER BY CASE h.scopeKind WHEN 'task' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,v."at" DESC,v.id LIMIT 1"#,
            params![task, project, workspace])?)),
        Query::List => Ok(version_rows(db, r#"WHERE v.revision=h.revision ORDER BY v."at" DESC,v.id"#, [])?.into()),
        Query::Staged { hash } => {
            let draft: Option<String> = db.query_row("SELECT draft FROM improvement_staged WHERE hash=?", [hash], |r| r.get(0)).optional()?;
            Ok(json!(draft))
        }
        Query::RegressionInputs { id } => {
            let rows = records(db, "SELECT input,seq_ord FROM improvement_regressions WHERE id=? ORDER BY seq_ord", [id])?;
            Ok(json!({
                "seq": rows.last().and_then(|r| r["seq_ord"].as_i64()).unwrap_or(0),
                "inputs": rows.iter().map(|r| r["input"].clone()).collect::<Vec<_>>()
            }))
        }
        Query::RollbackCandidates { id, before_revision } => Ok(version_rows(db,
            "WHERE v.id=? AND v.revision<? AND v.retired=0 ORDER BY v.revision DESC", params![id, before_revision])?.into()),
        Query::Uses { id, revision } => Ok(records(db, &format!(
            r#"SELECT {USE_COLUMNS} FROM improvement_uses WHERE id=? AND revision=? ORDER BY "at",seq_ord"#
        ), params![id, revision])?.into()),
        Query::PendingAcceptance { task } => Ok(records(db,
            r#"SELECT p.id,p.revision,p.task,p.conversation,p.actor,p.run,p.kind,p.event,p.generation,p.detail,p."at"
               FROM improvement_uses p WHERE p.task=? AND p.kind='hook' AND p.event='passed' AND NOT EXISTS (
                 SELECT 1 FROM improvement_uses a WHERE a.id=p.id AND a.revision=p.revision AND a.task=p.task
                 AND a.conversation=p.conversation AND a.run=p.run AND a.event='accepted' AND a.generation=p.generation
               ) ORDER BY p.seq_ord"#, [task])?.into()),
        Query::SourceUses { run } => Ok(records(db,
            r#"SELECT id,revision,kind,event,generation FROM improvement_uses
               WHERE task=? AND conversation=? AND run=? ORDER BY "at",seq_ord LIMIT 80"#,
            params![run.task, run.conversation, run.run])?.into()),
        Query::Replays { week } => Ok(records(db,
            "SELECT v.id,v.revision,v.hash,s.draft,s.replays FROM improvement_versions v JOIN improvement_staged s ON s.hash=v.hash
             WHERE json_extract_string(s.draft,'$.week')=? ORDER BY v.id,v.revision", [week])?.into()),
        Query::Report => report(db),
        Query::Metrics { start, end } => {
            let rows = records(db, r#"
            SELECT bool_or(event='accepted') accepted,bool_or(event='correction') corrected,
                   bool_or(event IN ('error','falseTrigger')) error,bool_or(event='falseTrigger') AS "falseTrigger",
                   bool_or(event='executed') used,bool_or(kind='tool' AND event IN ('passed','missing')) checked
            FROM improvement_uses GROUP BY task,conversation,run HAVING min("at")>=? AND min("at")<?
            "#, params![start, end])?;
            let executions: i64 = db.query_row(
                r#"SELECT count(*) FROM improvement_uses WHERE kind='tool' AND event='executed' AND "at">=? AND "at"<?"#,
                params![start, end], |r| r.get(0),
            )?;
            let inputs: (i64, i64) = db.query_row(
                r#"SELECT count(*),count(*) FILTER (WHERE eligible=1) FROM improvement_inputs WHERE "at">=? AND "at"<?"#,
                params![start, end], |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            Ok(json!({ "rows": rows, "executions": executions, "inputs": inputs.0, "eligibleInputs": inputs.1 }))
        }
        Query::DirtyWeeks { through } => Ok(records(db,
            "SELECT DISTINCT week FROM improvement_dirty_weeks WHERE week<=? ORDER BY week", [through])?.into()),
    }
}

pub fn read(db: &mut Connection, query: Query) -> Result<Value> {
    let tx = db.transaction()?;
    let data = read_inner(&tx, query)?;
    tx.commit()?;
    Ok(json!({ "status": "ok", "data": data }))
}

fn rejected(message: &str) -> Value {
    json!({ "status": "rejected", "message": message })
}

#[derive(Deserialize)]
struct DraftIdentity {
    id: String,
    scope: Scope,
}

#[derive(Deserialize)]
struct Scope {
    kind: String,
    id: String,
}

fn digest(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

fn regression_seq(db: &Connection, id: &str) -> Result<i64> {
    Ok(db.query_row(
        "SELECT coalesce(max(seq_ord),0) FROM improvement_regressions WHERE id=?",
        [id],
        |r| r.get(0),
    )?)
}

fn head(db: &Connection, id: &str) -> Result<Option<(i64, i64, bool)>> {
    Ok(db
        .query_row(
            "SELECT revision,generation,enabled=1 FROM improvement_heads WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
}

fn set_head(
    db: &Connection,
    id: &str,
    revision: i64,
    generation: i64,
    enabled: bool,
    at: i64,
) -> Result<()> {
    // A rollback restores the scope together with the revision it points at.
    db.execute(
        "INSERT INTO improvement_heads
         SELECT v.id,?,?,?,json_extract_string(s.draft,'$.scope.kind'),json_extract_string(s.draft,'$.scope.id')
         FROM improvement_versions v JOIN improvement_staged s ON s.hash=v.hash WHERE v.id=? AND v.revision=?
         ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,
           enabled=excluded.enabled,scopeKind=excluded.scopeKind,scopeId=excluded.scopeId",
        params![revision, generation, i64::from(enabled), id, revision],
    )?;
    db.execute(r#"INSERT INTO improvement_switches(id,generation,revision,"at",enabled) VALUES(?,?,?,?,?)"#,
        params![id, generation, revision, at, i64::from(enabled)])?;
    Ok(())
}

fn revert(
    db: &Connection,
    id: &str,
    revision: i64,
    generation: i64,
    candidates: &[i64],
    at: i64,
) -> Result<()> {
    db.execute(
        "UPDATE improvement_versions SET retired=1 WHERE id=? AND revision=?",
        params![id, revision],
    )?;
    let previous: Option<i64> = db.query_row(
        "SELECT max(v.revision) FROM improvement_versions v WHERE v.id=? AND v.revision<? AND v.retired=0
         AND v.revision IN (SELECT CAST(value AS BIGINT) FROM json_each(?))",
        params![id, revision, serde_json::to_string(candidates)?], |r| r.get(0),
    )?;
    set_head(
        db,
        id,
        previous.unwrap_or(revision),
        generation + 1,
        previous.is_some(),
        at,
    )
}

fn mark_cohort(db: &Connection, at: i64) -> Result<()> {
    let day = at.div_euclid(86_400_000);
    // Unix day zero was Thursday. The reporting cohort closes on the next UTC Monday.
    let next_monday = i32::try_from(day - (day + 3).rem_euclid(7) + 7)?;
    db.execute(
        "INSERT INTO improvement_dirty_weeks VALUES (
           CAST(DATE '1970-01-01' + CAST(? AS INTEGER) AS VARCHAR),
           nextval('improvement_event_order'))",
        [next_monday],
    )?;
    Ok(())
}

fn record_use(db: &Connection, id: &str, revision: i64, use_: &Usage) -> Result<bool> {
    let run = &use_.run;
    let prior: Option<i64> = db.query_row(
        r#"SELECT min("at") FROM improvement_uses WHERE id=? AND revision=? AND task=? AND conversation=? AND run=?"#,
        params![id, revision, run.task, run.conversation, run.run], |r| r.get(0),
    )?;
    let added = db.execute(
        "INSERT INTO improvement_uses VALUES(?,?,?,?,?,?,?,?,?,?,?,nextval('improvement_event_order')) ON CONFLICT DO NOTHING",
        params![id,revision,run.task,run.conversation,use_.actor,run.run,use_.kind,use_.event,use_.generation,use_.detail,use_.at],
    )? > 0;
    if added {
        mark_cohort(db, prior.unwrap_or(use_.at))?;
        if prior.is_some_and(|time| use_.at < time) {
            mark_cohort(db, use_.at)?;
        }
    }
    Ok(added)
}

pub fn write(db: &mut Connection, mutation: Mutation) -> Result<Value> {
    let tx = db.transaction()?;
    let data = match mutation {
        Mutation::Stage {
            id,
            hash,
            draft,
            replays,
            regression_seq: checked,
        } => {
            let parsed: DraftIdentity = serde_json::from_str(&draft)?;
            if parsed.id != id
                || digest(&draft) != hash
                || parsed.scope.id.is_empty()
                || !matches!(parsed.scope.kind.as_str(), "task" | "project" | "workspace")
            {
                return Ok(rejected("改进版本校验失败"));
            }
            if checked != regression_seq(&tx, &id)? {
                return Ok(rejected(STALE_REPLAY));
            }
            let published: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM improvement_versions WHERE id=? AND hash=?)",
                params![id, hash],
                |r| r.get(0),
            )?;
            if !published {
                tx.execute(
                    "INSERT INTO improvement_staged VALUES(?,?,?,?) ON CONFLICT(hash) DO UPDATE SET
                     replays=excluded.replays,validated_seq=excluded.validated_seq",
                    params![hash, draft, replays, checked],
                )?;
            }
            hash.into()
        }
        Mutation::Activate {
            id,
            hash,
            generation,
            at,
        } => {
            let prior = head(&tx, &id)?;
            if prior.map_or(0, |(_, token, _)| token) != generation {
                return Ok(rejected(CONFLICT));
            }
            let staged: Option<(String, i64)> = tx.query_row(
                "SELECT draft,validated_seq FROM improvement_staged WHERE hash=? AND json_extract_string(draft,'$.id')=?",
                params![hash, id], |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional()?;
            let Some((draft, checked)) = staged else {
                return Ok(rejected("没有已验证的暂存版本"));
            };
            if digest(&draft) != hash {
                return Ok(rejected("改进版本校验失败"));
            }
            let existing: Option<(i64, bool)> = tx
                .query_row(
                    "SELECT revision,retired<>0 FROM improvement_versions WHERE id=? AND hash=?",
                    params![id, hash],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((revision, retired)) = existing {
                if retired || prior.map(|(current, _, _)| current) != Some(revision) {
                    return Ok(rejected("该改进版本已撤回"));
                }
            } else {
                if checked != regression_seq(&tx, &id)? {
                    return Ok(rejected(STALE_REPLAY));
                }
                let revision: i64 = tx.query_row(
                    "SELECT coalesce(max(revision),0)+1 FROM improvement_versions WHERE id=?",
                    [&id],
                    |r| r.get(0),
                )?;
                tx.execute(r#"INSERT INTO improvement_versions(id,revision,hash,previous,"at") VALUES(?,?,?,?,?)"#,
                    params![id, revision, hash, prior.map(|(r, _, _)| r), at])?;
                set_head(&tx, &id, revision, generation + 1, true, at)?;
            }
            current(&tx, &id)?
        }
        Mutation::Disable { id, generation, at } => {
            let Some((revision, current_generation, true)) = head(&tx, &id)? else {
                return Ok(rejected(CONFLICT));
            };
            if generation != current_generation {
                return Ok(rejected(CONFLICT));
            }
            set_head(&tx, &id, revision, generation + 1, false, at)?;
            Value::Null
        }
        Mutation::Revert {
            id,
            generation,
            fallback,
            at,
        } => {
            let Some((revision, current_generation, true)) = head(&tx, &id)? else {
                return Ok(rejected(CONFLICT));
            };
            if generation != current_generation {
                return Ok(rejected(CONFLICT));
            }
            revert(&tx, &id, revision, generation, &fallback, at)?;
            current(&tx, &id)?
        }
        Mutation::Record {
            id,
            revision,
            usage,
            regression,
            fallback,
            decision_at,
        } => {
            let exists: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM improvement_versions WHERE id=? AND revision=?)",
                params![id, revision],
                |r| r.get(0),
            )?;
            if !exists {
                return Ok(rejected("改进版本不存在"));
            }
            let added = record_use(&tx, &id, revision, &usage)?;
            if added
                && let Some(proof) = regression
                && matches!(usage.event.as_str(), "error" | "falseTrigger")
            {
                if digest(&proof.input) != proof.hash {
                    return Ok(rejected("回放证据校验失败"));
                }
                tx.execute(
                    "INSERT INTO improvement_regressions VALUES(?,?,?,?,nextval('improvement_event_order')) ON CONFLICT DO NOTHING",
                    params![id, proof.hash, proof.input, revision],
                )?;
            }
            if added
                && matches!(usage.event.as_str(), "error" | "falseTrigger")
                && let Some((active, generation, true)) = head(&tx, &id)?
                && active == revision
            {
                revert(&tx, &id, revision, generation, &fallback, decision_at)?;
            }
            added.into()
        }
        Mutation::Correction {
            run,
            actor,
            generation,
            at,
        } => {
            let prior = {
                let mut stmt = tx.prepare("SELECT DISTINCT id,revision FROM improvement_uses WHERE task=? AND conversation=? AND run=?")?;
                stmt.query_map(params![run.task, run.conversation, run.run], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                })?
                .collect::<duckdb::Result<Vec<_>>>()?
            };
            let usage = Usage {
                run,
                actor,
                kind: "hook".into(),
                event: "correction".into(),
                generation,
                detail: String::new(),
                at,
            };
            for (id, revision) in prior {
                record_use(&tx, &id, revision, &usage)?;
            }
            Value::Null
        }
        Mutation::IndexInputs {
            task,
            conversation,
            actor,
            inputs,
        } => {
            for input in inputs {
                let inserted = tx.execute(
                    "INSERT INTO improvement_inputs VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                    params![
                        task,
                        conversation,
                        input.entry,
                        input.at,
                        i64::from(input.eligible),
                        actor
                    ],
                )?;
                tx.execute(
                    "INSERT INTO improvement_input_scopes VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
                    params![
                        task,
                        conversation,
                        input.entry,
                        input.project,
                        input.workspace
                    ],
                )?;
                if inserted > 0 && input.eligible {
                    mark_cohort(&tx, input.at)?;
                }
            }
            Value::Null
        }
        Mutation::Followup {
            week,
            start,
            end,
            now,
        } => {
            followup(&tx, &week, start, end, now)?;
            let mut tokens = tx
                .prepare("SELECT token FROM improvement_dirty_weeks WHERE week=? ORDER BY token")?;
            json!(
                tokens
                    .query_map([week], |r| r.get::<_, i64>(0))?
                    .collect::<duckdb::Result<Vec<_>>>()?
            )
        }
        Mutation::AcknowledgeWeek { week, tokens } => {
            tx.execute("DELETE FROM improvement_dirty_weeks WHERE week=? AND token IN (SELECT CAST(value AS BIGINT) FROM json_each(?))",
                params![week, serde_json::to_string(&tokens)?])?;
            Value::Null
        }
    };
    crate::request_control::commit(tx)?;
    Ok(json!({ "status": "ok", "data": data }))
}

fn counts(rows: &[Value]) -> (usize, usize, usize, &'static str) {
    let accepted = rows
        .iter()
        .filter(|r| r["accepted"] == true && r["corrected"] != true && r["error"] != true)
        .count();
    let corrected = rows.iter().filter(|r| r["corrected"] == true).count();
    let errors = rows.iter().filter(|r| r["error"] == true).count();
    let state = if errors > 0 {
        "regressed"
    } else if corrected > 0 {
        "ineffective"
    } else if accepted > 0 {
        "effective"
    } else {
        "pending"
    };
    (accepted, corrected, errors, state)
}

fn followup(db: &Connection, week: &str, start: i64, end: i64, now: i64) -> Result<()> {
    let versions = records(
        db,
        r#"SELECT v.id,v.revision,v."at",s.draft FROM improvement_versions v
       JOIN improvement_staged s ON s.hash=v.hash WHERE json_extract_string(s.draft,'$.week')<?"#,
        [week],
    )?;
    for version in versions {
        let id = version["id"].as_str().ok_or("missing package ID")?;
        let revision = version["revision"]
            .as_i64()
            .ok_or("missing package revision")?;
        let at = version["at"].as_i64().ok_or("missing package timestamp")?;
        let draft: Value =
            serde_json::from_str(version["draft"].as_str().ok_or("missing package draft")?)?;
        let rows = records(
            db,
            r#"
            SELECT bool_or(event='accepted') accepted,bool_or(event='correction') corrected,bool_or(event IN ('error','falseTrigger')) error,
                   bool_or(kind='tool' AND event='executed') tool,
                   bool_or(kind='hook' AND event IN ('passed','feedback','unknown','error','falseTrigger')) hook,
                   bool_or(kind='convention' AND event='applied') convention,bool_or(kind='memory' AND event='recalled') memory,
                   bool_or(kind='skill' AND event='read') skill
            FROM improvement_uses WHERE id=? AND revision=? AND "at"<=? GROUP BY task,conversation,run HAVING min("at")>=? AND min("at")<?
        "#,
            params![id, revision, now, start.max(at), end],
        )?;
        let kind = draft["scope"]["kind"]
            .as_str()
            .ok_or("missing package scope kind")?;
        let scope = draft["scope"]["id"]
            .as_str()
            .ok_or("missing package scope")?;
        let missed: i64 = db.query_row(r#"
            SELECT count(*) FROM improvement_inputs i LEFT JOIN improvement_input_scopes s USING(task,conversation,entry)
            WHERE i.eligible=1 AND i."at">=? AND i."at"<? AND CASE ?
                WHEN 'task' THEN i.task WHEN 'project' THEN s.project WHEN 'workspace' THEN s.workspace END = ?
              AND ?=(SELECT CASE WHEN x.enabled=1 THEN x.revision END FROM improvement_switches x
                WHERE x.id=? AND x."at"<=i."at" ORDER BY x.generation DESC LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM improvement_uses u WHERE u.task=i.task AND u.conversation=i.conversation AND u.run=CAST(i.entry AS VARCHAR))
        "#, params![start, end.min(now + 1), kind, scope, revision, id], |r| r.get(0))?;
        let opportunities = rows.len() + missed as usize;
        let (accepted, corrections, errors, state) = counts(&rows);
        let mut assets = Vec::new();
        let knowledge = draft["knowledge"]
            .as_array()
            .ok_or("missing package knowledge")?;
        for asset in ["hook", "tool", "convention"]
            .into_iter()
            .chain(knowledge.iter().filter_map(|value| value["kind"].as_str()))
        {
            let used: Vec<_> = rows.iter().filter(|r| r[asset] == true).cloned().collect();
            let (accepted, corrections, errors, state) = counts(&used);
            assets.push(json!({ "kind": asset, "state": state, "opportunities": opportunities, "used": used.len(),
                "accepted": accepted, "corrections": corrections, "errors": errors }));
        }
        let result = json!({ "week": week, "packageId": id, "revision": revision, "state": state,
            "accepted": accepted, "opportunities": opportunities, "corrections": corrections, "errors": errors, "assets": assets });
        db.execute(
            "INSERT INTO improvement_results VALUES(?,?,?,?) ON CONFLICT(week,id,revision) DO UPDATE SET
             result=excluded.result WHERE improvement_results.result<>excluded.result",
            params![week, id, revision, result.to_string()],
        )?;
    }
    Ok(())
}
