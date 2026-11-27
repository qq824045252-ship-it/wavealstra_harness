use crate::Result;
use duckdb::{Connection, OptionalExt, Row, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    List {
        task_id: Option<String>,
        extraction_state: Option<String>,
        query: Option<String>,
        limit: u32,
    },
    Detail {
        id: String,
    },
    HasPending {
        task_id: String,
    },
    ExtractionCurrent {
        #[serde(flatten)]
        lease: ExtractionLease,
    },
    Tasks,
    SkillLearningStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    id: String,
    task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_title: Option<String>,
    task_trashed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assistant_message_id: Option<String>,
    user_text: String,
    assistant_text: String,
    content_hash: String,
    captured_at: f64,
    extraction_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    extracted_at: Option<f64>,
    attempt_count: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    metadata_json: String,
}

#[derive(Serialize)]
struct TurnTask {
    id: String,
    title: String,
    trashed: bool,
}

const TURN_COLUMNS: &str = "m.id,m.task_id,m.session_id,m.user_message_id,m.assistant_message_id,
    m.user_text,m.assistant_text,m.content_hash,m.captured_at,m.extraction_state,m.extracted_at,
    m.attempt_count,m.last_error,m.metadata_json";
const TASK_TITLE: &str =
    "CASE WHEN b.bot_id IS NOT NULL THEN 'Bot 对话' ELSE NULLIF(t.title,'') END";
const TASK_JOINS: &str = "LEFT JOIN tasks t ON t.id=m.task_id
    LEFT JOIN task_execution_workspace_state w ON w.task_id=m.task_id
    LEFT JOIN bot_conversations c ON c.conversation_id=m.task_id AND c.user_id=?1 AND COALESCE(t.title,'')=''
    LEFT JOIN bots b ON b.bot_id=c.bot_id AND b.user_id=c.user_id";

pub fn read(db: &Connection, query: Query, user_id: &str) -> Result<Json> {
    let select = || {
        format!(
            "SELECT {TURN_COLUMNS},{TASK_TITLE},COALESCE(w.state='trashed',FALSE) FROM memory_turns m {TASK_JOINS}"
        )
    };
    match query {
        Query::List {
            task_id,
            extraction_state,
            query,
            limit,
        } => {
            let mut sql = select();
            let mut values = vec![Value::Text(user_id.to_owned())];
            let mut conditions = Vec::new();
            if let Some(id) = task_id.filter(|id| !id.is_empty()) {
                conditions.push("m.task_id=?");
                values.push(Value::Text(id));
            }
            if let Some(state) = extraction_state.filter(|state| !state.is_empty()) {
                conditions.push("m.extraction_state=?");
                values.push(Value::Text(state));
            }
            if let Some(query) = query.filter(|query| !query.is_empty()) {
                conditions.push("(m.user_text LIKE ? OR m.assistant_text LIKE ?)");
                let pattern = Value::Text(format!("%{query}%"));
                values.extend([pattern.clone(), pattern]);
            }
            if !conditions.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&conditions.join(" AND "));
            }
            sql.push_str(" ORDER BY m.captured_at DESC,m.rowid DESC LIMIT ?");
            values.push(Value::BigInt(i64::from(limit.clamp(1, 2000))));
            let turns = db
                .prepare(&sql)?
                .query_map(params_from_iter(values), map_turn)?
                .collect::<duckdb::Result<Vec<_>>>()?;
            Ok(json!({"kind": "list", "turns": turns}))
        }
        Query::Detail { id } => {
            let turn = db
                .prepare(&format!("{} WHERE m.id=?2", select()))?
                .query_row(params![user_id, id], map_turn)
                .optional()?;
            Ok(json!({"kind": "detail", "turn": turn}))
        }
        Query::HasPending { task_id } => {
            Ok(json!({"kind":"hasPending","pending":has_pending(db, user_id, &task_id)?}))
        }
        Query::ExtractionCurrent { lease } => Ok(json!({"kind":"extractionCurrent",
            "current":extraction_turn_ids(db, user_id, &lease)?.is_some()})),
        Query::Tasks => {
            let sql = format!("SELECT m.task_id,COALESCE({TASK_TITLE},'原任务已删除'),COALESCE(w.state='trashed',FALSE)
                FROM (SELECT DISTINCT task_id FROM memory_turns) m {TASK_JOINS} ORDER BY t.title,m.task_id");
            let tasks = db
                .prepare(&sql)?
                .query_map([user_id], |row| {
                    Ok(TurnTask {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        trashed: row.get(2)?,
                    })
                })?
                .collect::<duckdb::Result<Vec<_>>>()?;
            Ok(json!({"kind": "tasks", "tasks": tasks}))
        }
        Query::SkillLearningStatus => skill_learning_status(db, user_id),
    }
}

const SKILL_LEARNING_STATUS: &str = "
    WITH latest_procedures AS (
        SELECT id FROM memory_records WHERE kind='procedure' AND status='active'
        ORDER BY updated_at DESC,id DESC LIMIT 2000
    ), procedure_counts AS (
        SELECT COUNT(*) AS total, COUNT(*) FILTER (
            WHERE EXISTS(SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND s.scope_type<>'task')
        ) AS reusable FROM latest_procedures m
    ), pending_sources AS (
        SELECT task_id, COUNT(*) FILTER (WHERE extraction_state='failed') AS failed,
            COUNT(*) FILTER (WHERE extraction_state='pending' OR attempt_count<3) AS pending
        FROM memory_turns WHERE extraction_state IN ('pending','failed') GROUP BY task_id
    ), extraction_sources AS (
        SELECT m.failed,m.pending,CASE WHEN b.bot_id IS NOT NULL THEN b.status='active'
            ELSE t.id IS NOT NULL AND w.state IS DISTINCT FROM 'trashed'
                AND (NULLIF(t.project_id,'') IS NULL OR p.archived=0)
            END AS eligible
        FROM pending_sources m
        LEFT JOIN bot_conversations c ON c.conversation_id=m.task_id AND c.user_id=?1
        LEFT JOIN bots b ON b.bot_id=c.bot_id AND b.user_id=c.user_id
        LEFT JOIN tasks t ON t.id=m.task_id
        LEFT JOIN task_execution_workspace_state w ON w.task_id=m.task_id
        LEFT JOIN projects p ON p.id=t.project_id
    ), turn_counts AS (
        SELECT COALESCE(SUM(failed),0) AS failed,
            COALESCE(SUM(failed) FILTER (WHERE eligible),0) AS retryable,
            COALESCE(SUM(pending) FILTER (WHERE eligible),0) AS pending
        FROM extraction_sources
    )
    SELECT p.total,p.reusable,t.failed,t.retryable,t.pending,
        (SELECT last_error FROM memory_turns WHERE extraction_state='failed' ORDER BY captured_at DESC LIMIT 1)
    FROM procedure_counts p CROSS JOIN turn_counts t";

fn skill_learning_status(db: &Connection, user_id: &str) -> Result<Json> {
    Ok(db
        .prepare(SKILL_LEARNING_STATUS)?
        .query_row([user_id], |r| {
            Ok(json!({
                "kind": "skillLearningStatus",
                "procedures": r.get::<_, i64>(0)?,
                "reusableProcedures": r.get::<_, i64>(1)?,
                "failedTurns": r.get::<_, i64>(2)?,
                "retryableFailedTurns": r.get::<_, i64>(3)?,
                "pendingTurns": r.get::<_, i64>(4)?,
                "latestError": r.get::<_, Option<String>>(5)?
            }))
        })?)
}

fn nonempty(row: &Row<'_>, column: usize) -> duckdb::Result<Option<String>> {
    Ok(row
        .get::<_, Option<String>>(column)?
        .filter(|value| !value.is_empty()))
}

fn map_turn(row: &Row<'_>) -> duckdb::Result<Turn> {
    Ok(Turn {
        id: row.get(0)?,
        task_id: row.get(1)?,
        session_id: nonempty(row, 2)?,
        user_message_id: nonempty(row, 3)?,
        assistant_message_id: nonempty(row, 4)?,
        user_text: row.get(5)?,
        assistant_text: row.get(6)?,
        content_hash: row.get(7)?,
        captured_at: row.get(8)?,
        extraction_state: row.get(9)?,
        extracted_at: row.get(10)?,
        attempt_count: row.get(11)?,
        last_error: nonempty(row, 12)?,
        metadata_json: row.get(13)?,
        task_title: row.get(14)?,
        task_trashed: row.get(15)?,
    })
}

const RETRYABLE: &str = "extraction_state IN ('pending','failed') AND attempt_count<3";
const CLAIMED: &str = "claimed";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionLease {
    pub task_id: String,
    pub owner: String,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExtractionCommand {
    Claim {
        #[serde(flatten)]
        lease: ExtractionLease,
        captured_through: i64,
        limit: u32,
        lease_ms: Option<i64>,
    },
    Renew {
        #[serde(flatten)]
        lease: ExtractionLease,
        lease_ms: Option<i64>,
    },
    Settle {
        #[serde(flatten)]
        lease: ExtractionLease,
        disposition: Disposition,
        error: Option<String>,
    },
}

impl ExtractionCommand {
    pub fn task_id(&self) -> &str {
        match self {
            Self::Claim { lease, .. } | Self::Renew { lease, .. } | Self::Settle { lease, .. } => {
                &lease.task_id
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Disposition {
    Completed,
    Failed,
    Release,
}

impl Disposition {
    fn status(&self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Release => "released",
        }
    }
}

#[derive(Deserialize, Serialize)]
struct Witness {
    id: String,
    version: String,
    attempt: i64,
}

#[derive(Deserialize, Serialize)]
struct Claim {
    owner: String,
    generation: String,
    expires_at: i64,
    scope: String,
    turns: Vec<Witness>,
}

struct Receipt {
    token: String,
    request_hash: String,
    status: String,
    claim: Claim,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}

fn expiry(now: i64, lease_ms: Option<i64>) -> i64 {
    now + lease_ms.unwrap_or(60_000).clamp(1_000, 300_000)
}

fn digest(value: &Json) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn receipt_scope(user_id: &str, task_id: &str) -> String {
    format!("memory-extraction:{}", json!([user_id, task_id]))
}

fn decode_receipt(row: (String, String, String, String)) -> Result<Receipt> {
    let (token, request_hash, status, result) = row;
    Ok(Receipt {
        token,
        request_hash,
        status,
        claim: serde_json::from_str(&result)?,
    })
}

fn receipt(db: &Connection, scope: &str, token: &str) -> Result<Option<Receipt>> {
    db.query_row(
        "SELECT operation_id,request_hash,status,result_json FROM operation_receipts
        WHERE caller_scope=?1 AND operation_id=?2 AND batch_index=0",
        params![scope, token],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()?
    .map(decode_receipt)
    .transpose()
}

fn active_receipt(db: &Connection, scope: &str) -> Result<Option<Receipt>> {
    db.query_row(
        "SELECT operation_id,request_hash,status,result_json FROM operation_receipts
        WHERE caller_scope=?1 AND status='claimed' AND batch_index=0",
        [scope],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()?
    .map(decode_receipt)
    .transpose()
}

fn persist_claim(
    db: &Connection,
    scope: &str,
    token: &str,
    request_hash: &str,
    claim: &Claim,
    now: i64,
) -> Result<()> {
    db.execute("INSERT INTO operation_receipts(caller_scope,operation_id,batch_index,request_hash,status,result_json,created_at_ms)
        VALUES(?1,?2,0,?3,'claimed',?4,?5)", params![scope, token, request_hash, serde_json::to_string(claim)?, now])?;
    Ok(())
}

fn close_receipt(db: &Connection, scope: &str, receipt: &Receipt, status: &str) -> Result<()> {
    // Preserve the token tombstone so a lost or very late reply cannot reopen a terminal lease.
    // The receipt no longer needs source identifiers or provenance after settlement.
    let terminal =
        json!({"owner":receipt.claim.owner,"generation":"","expires_at":0,"scope":"","turns":[]});
    db.execute("UPDATE operation_receipts SET status=?1,result_json=?2 WHERE caller_scope=?3 AND operation_id=?4
        AND batch_index=0 AND status='claimed'", params![status, terminal.to_string(), scope, receipt.token])?;
    Ok(())
}

fn live(claim: &Claim, now: i64) -> bool {
    claim.expires_at > now
        && claim.generation == crate::business_protocol::current_core_generation()
}

fn scope_stamp(db: &Connection, user_id: &str, task_id: &str) -> Result<Option<String>> {
    let mut scopes = vec![("global", String::new()), ("task", task_id.to_owned())];
    let bot = db.query_row("SELECT c.user_id,c.bot_id,c.team_id,c.source_kind,b.status,b.memory_scope_json,b.authorization_json,
        g.audience,g.channel_id,g.connection_key FROM bot_conversations c LEFT JOIN bots b ON b.bot_id=c.bot_id AND b.user_id=c.user_id
        LEFT JOIN bot_gateway_conversations g ON g.conversation_id=c.conversation_id WHERE c.conversation_id=?1", [task_id], |r|
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?, r.get::<_, Option<String>>(8)?, r.get::<_, Option<String>>(9)?))).optional()?;
    let binding = if let Some(bot) = bot {
        if bot.0 != user_id || bot.4.as_deref() != Some("active") {
            return Ok(None);
        }
        scopes.push(("conversation", task_id.to_owned()));
        scopes.push(("bot", bot.1.clone()));
        if let Some(team) = &bot.2 {
            scopes.push(("team", team.clone()));
        }
        json!(["bot", bot])
    } else {
        let task = db.query_row("SELECT nullif(t.project_id,''),nullif(t.space_id,''),t.cwd,t.archived,w.state,
            p.archived,t.external_agent_pin_json FROM tasks t LEFT JOIN task_execution_workspace_state w ON w.task_id=t.id
            LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?1", [task_id], |r|
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<i64>>(5)?, r.get::<_, Option<String>>(6)?))).optional()?;
        let Some(task) = task else {
            return Ok(None);
        };
        if task.4.as_deref() == Some("trashed") || task.0.is_some() && task.5 != Some(0) {
            return Ok(None);
        }
        if let Some(project) = &task.0 {
            scopes.push(("project", project.clone()));
        }
        let mut parents = Vec::new();
        if let Some(space) = &task.1 {
            scopes.push(("workspace", space.clone()));
            let mut stmt = db.prepare("WITH RECURSIVE parents(id,parent_id,path,archived) AS (
                SELECT id,parent_id,path,archived FROM spaces WHERE id=?1
                UNION SELECT s.id,s.parent_id,s.path,s.archived FROM spaces s JOIN parents p ON s.id=p.parent_id)
                SELECT id,parent_id,path,archived FROM parents ORDER BY id")?;
            parents = stmt
                .query_map([space], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })?
                .collect::<duckdb::Result<_>>()?;
            scopes.extend(parents.iter().map(|(id, ..)| ("workspace", id.clone())));
        }
        let work = db.query_row("SELECT w.work_id,w.user_id,w.owner_bot_id,w.project_id,w.intent_revision,w.owner_epoch,o.team_id
            FROM work_execution_bindings b JOIN works w ON w.work_id=b.work_id LEFT JOIN work_team_ownership o ON o.work_id=w.work_id
            WHERE b.task_id=?1 ORDER BY b.admitted_at DESC,b.rowid DESC LIMIT 1", [task_id], |r| Ok((r.get::<_, String>(0)?,
                r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?, r.get::<_, i64>(5)?, r.get::<_, Option<String>>(6)?))).optional()?;
        if let Some(work) = &work {
            if work.1 != user_id {
                return Ok(None);
            }
            scopes.push(("work", work.0.clone()));
            if let Some(bot) = &work.2 {
                scopes.push(("bot", bot.clone()));
            }
            if let Some(project) = &work.3 {
                scopes.push(("project", project.clone()));
            }
            if let Some(team) = &work.6 {
                scopes.push(("team", team.clone()));
            }
        }
        if task_id.starts_with("gateway-chat-") {
            scopes.push(("task", crate::DOTS_TASK_ID.to_owned()));
        }
        json!(["task", task, parents, work])
    };
    let scopes = serde_json::to_string(&scopes)?;
    let mut watermarks = Sha256::new();
    let mut stmt = db.prepare("WITH scopes AS (
       SELECT json_extract_string(value,'$[0]') AS kind,json_extract_string(value,'$[1]') AS id FROM json_each(?1)
      ), versions AS (
       SELECT CAST(json_array('watermark',w.scope_type,w.scope_id,w.cutoff_at,w.allowed_message_id) AS VARCHAR) AS version
         FROM memory_forget_watermarks w WHERE EXISTS(SELECT 1 FROM scopes s WHERE s.kind=w.scope_type AND s.id=w.scope_id)
       UNION ALL SELECT CAST(json_array('target',w.scope_type,w.scope_id,w.fingerprint,w.text_length,w.cutoff_at,
          w.value_fingerprint,w.guard_fingerprint,w.guard_length,w.allowed_message_id) AS VARCHAR)
         FROM memory_forget_targets w WHERE EXISTS(SELECT 1 FROM scopes s WHERE s.kind=w.scope_type AND s.id=w.scope_id)
      ) SELECT version FROM versions ORDER BY version")?;
    let rows = stmt.query_map([scopes], |r| r.get::<_, String>(0))?;
    for row in rows {
        let version = row?;
        watermarks.update((version.len() as u64).to_le_bytes());
        watermarks.update(version);
    }
    Ok(Some(digest(&json!([
        binding,
        format!("{:x}", watermarks.finalize())
    ]))?))
}

fn turn_stamp(turn: &Turn) -> Result<String> {
    digest(&json!([
        turn.task_id,
        turn.session_id,
        turn.user_message_id,
        turn.assistant_message_id,
        turn.user_text,
        turn.assistant_text,
        turn.content_hash,
        turn.captured_at,
        turn.metadata_json
    ]))
}

fn read_claimed_turn(
    db: &Connection,
    user_id: &str,
    task_id: &str,
    witness: &Witness,
    recover: bool,
) -> Result<Option<Turn>> {
    let turn = db.query_row(&format!("SELECT {TURN_COLUMNS},{TASK_TITLE},COALESCE(w.state='trashed',FALSE)
        FROM memory_turns m {TASK_JOINS} WHERE m.id=?2 AND m.task_id=?3 AND m.attempt_count=?4
          AND (m.extraction_state='processing' OR (?5 AND m.extraction_state='failed' AND m.last_error IS NULL))"),
        params![user_id, witness.id, task_id, witness.attempt, recover], map_turn).optional()?;
    if let Some(turn) = turn {
        if turn_stamp(&turn)? == witness.version {
            return Ok(Some(turn));
        }
    }
    Ok(None)
}

fn read_claimed_batch(
    db: &Connection,
    user_id: &str,
    task_id: &str,
    claim: &Claim,
    recover: bool,
) -> Result<Option<Vec<Turn>>> {
    if scope_stamp(db, user_id, task_id)?.as_deref() != Some(claim.scope.as_str()) {
        return Ok(None);
    }
    let mut turns = Vec::new();
    for witness in &claim.turns {
        let Some(turn) = read_claimed_turn(db, user_id, task_id, witness, recover)? else {
            return Ok(None);
        };
        turns.push(turn);
    }
    Ok((!turns.is_empty()).then_some(turns))
}

pub fn extraction_turn_ids(
    db: &Connection,
    user_id: &str,
    lease: &ExtractionLease,
) -> Result<Option<Vec<String>>> {
    let scope = receipt_scope(user_id, &lease.task_id);
    let Some(receipt) = receipt(db, &scope, &lease.token)? else {
        return Ok(None);
    };
    if receipt.status != CLAIMED
        || receipt.claim.owner != lease.owner
        || !live(&receipt.claim, now_ms())
    {
        return Ok(None);
    }
    Ok(
        read_claimed_batch(db, user_id, &lease.task_id, &receipt.claim, false)?
            .map(|turns| turns.into_iter().map(|turn| turn.id).collect()),
    )
}

fn has_pending(db: &Connection, user_id: &str, task_id: &str) -> Result<bool> {
    let scope = receipt_scope(user_id, task_id);
    if let Some(receipt) = active_receipt(db, &scope)? {
        if live(&receipt.claim, now_ms()) {
            return Ok(false);
        }
        // Claim releases or recovers the abandoned batch, even on the final retry or after its sources were erased.
        return Ok(true);
    }
    Ok(db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM memory_turns WHERE task_id=?1 AND {RETRYABLE})"),
        [task_id],
        |r| r.get(0),
    )?)
}

fn release_turns(db: &Connection, task_id: &str, claim: &Claim) -> Result<()> {
    for witness in &claim.turns {
        // Reset only this lease's attempt, without restoring any erased or edited source data.
        db.execute("UPDATE memory_turns SET extraction_state='pending',attempt_count=greatest(0,attempt_count-1),last_error=NULL
            WHERE id=?1 AND task_id=?2 AND attempt_count=?3
              AND (extraction_state='processing' OR (extraction_state='failed' AND last_error IS NULL))",
            params![witness.id, task_id, witness.attempt])?;
    }
    Ok(())
}

fn pending_batch(
    db: &Connection,
    user_id: &str,
    task_id: &str,
    captured_through: i64,
    limit: u32,
) -> Result<Vec<Turn>> {
    let sql = format!("SELECT {TURN_COLUMNS},{TASK_TITLE},COALESCE(w.state='trashed',FALSE) FROM memory_turns m {TASK_JOINS}
       WHERE m.task_id=?2 AND {RETRYABLE} AND m.captured_at<=?3 ORDER BY m.captured_at,m.rowid LIMIT ?4");
    let mut stmt = db.prepare(&sql)?;
    let mut cursor = stmt.query(params![
        user_id,
        task_id,
        captured_through,
        i64::from(limit)
    ])?;
    let mut items = Vec::new();
    let mut bytes = 16_384;
    while let Some(row) = cursor.next()? {
        let turn = map_turn(row)?;
        bytes += serde_json::to_vec(&turn)?.len() + 1;
        if bytes >= crate::MAX_REPLY_BYTES / 2 {
            if items.is_empty() {
                return Err("Memory turn exceeds the extraction reply limit".into());
            }
            break;
        }
        items.push(turn);
    }
    Ok(items)
}

fn claim_work(
    db: &Connection,
    user_id: &str,
    lease: &ExtractionLease,
    now: i64,
    captured_through: i64,
    limit: u32,
    lease_ms: Option<i64>,
) -> Result<Json> {
    let scope = receipt_scope(user_id, &lease.task_id);
    let limit = limit.clamp(1, 50);
    let request_hash = digest(&json!([lease.owner, captured_through, limit, lease_ms]))?;
    if let Some(previous) = receipt(db, &scope, &lease.token)? {
        if previous.request_hash == request_hash
            && previous.status == CLAIMED
            && previous.claim.owner == lease.owner
            && live(&previous.claim, now)
            && let Some(turns) =
                read_claimed_batch(db, user_id, &lease.task_id, &previous.claim, false)?
        {
            return Ok(
                json!({"status":"claimed","turns":turns,"leaseExpiresAt":previous.claim.expires_at}),
            );
        }
        return Ok(json!({"status":"stale"}));
    }
    let current_scope = scope_stamp(db, user_id, &lease.task_id)?;
    let mut recovered = None;
    if let Some(previous) = active_receipt(db, &scope)? {
        if live(&previous.claim, now)
            && read_claimed_batch(db, user_id, &lease.task_id, &previous.claim, false)?.is_some()
        {
            return Ok(json!({"status":"busy"}));
        }
        if current_scope.as_deref() == Some(previous.claim.scope.as_str())
            && let Some(turns) =
                read_claimed_batch(db, user_id, &lease.task_id, &previous.claim, true)?
            && turns.len() <= limit as usize
            && turns
                .iter()
                .all(|turn| turn.captured_at <= captured_through as f64)
        {
            recovered = Some(turns);
        } else {
            release_turns(db, &lease.task_id, &previous.claim)?;
        }
        close_receipt(db, &scope, &previous, "expired")?;
    }
    let Some(current_scope) = current_scope else {
        return Ok(json!({"status":"ineligible"}));
    };
    let is_recovered = recovered.is_some();
    let mut turns = match recovered {
        Some(turns) => turns,
        None => pending_batch(
            db,
            user_id,
            &lease.task_id,
            captured_through.min(now),
            limit,
        )?,
    };
    if turns.is_empty() {
        return Ok(json!({"status":"empty"}));
    }
    let mut witnesses = Vec::with_capacity(turns.len());
    for turn in &mut turns {
        let attempt = turn.attempt_count as i64;
        let changed = if is_recovered {
            db.execute(
                "UPDATE memory_turns SET extraction_state='processing',last_error=NULL
               WHERE id=?1 AND task_id=?2 AND attempt_count=?3 AND (extraction_state='processing'
                 OR (extraction_state='failed' AND last_error IS NULL))",
                params![turn.id, lease.task_id, attempt],
            )?
        } else {
            db.execute(&format!("UPDATE memory_turns SET extraction_state='processing',attempt_count=attempt_count+1,last_error=NULL
                WHERE id=?1 AND task_id=?2 AND attempt_count=?3 AND {RETRYABLE}"), params![turn.id, lease.task_id, attempt])?
        };
        if changed != 1 {
            return Err("Memory extraction sources changed while claiming the batch".into());
        }
        if !is_recovered {
            turn.attempt_count += 1.0;
        }
        turn.extraction_state = "processing".to_owned();
        turn.last_error = None;
        witnesses.push(Witness {
            id: turn.id.clone(),
            version: turn_stamp(turn)?,
            attempt: turn.attempt_count as i64,
        });
    }
    let claim = Claim {
        owner: lease.owner.clone(),
        generation: crate::business_protocol::current_core_generation(),
        expires_at: expiry(now, lease_ms),
        scope: current_scope,
        turns: witnesses,
    };
    persist_claim(db, &scope, &lease.token, &request_hash, &claim, now)?;
    Ok(json!({"status":"claimed","turns":turns,"leaseExpiresAt":claim.expires_at}))
}

fn renew_work(
    db: &Connection,
    user_id: &str,
    lease: &ExtractionLease,
    now: i64,
    lease_ms: Option<i64>,
) -> Result<Json> {
    let scope = receipt_scope(user_id, &lease.task_id);
    let Some(mut receipt) = receipt(db, &scope, &lease.token)? else {
        return Ok(json!({"status":"stale"}));
    };
    if receipt.status != CLAIMED
        || receipt.claim.owner != lease.owner
        || !live(&receipt.claim, now)
        || read_claimed_batch(db, user_id, &lease.task_id, &receipt.claim, false)?.is_none()
    {
        return Ok(json!({"status":"stale"}));
    }
    receipt.claim.expires_at = expiry(now, lease_ms).max(receipt.claim.expires_at);
    db.execute(
        "UPDATE operation_receipts SET result_json=?1 WHERE caller_scope=?2 AND operation_id=?3
        AND batch_index=0 AND status='claimed'",
        params![serde_json::to_string(&receipt.claim)?, scope, receipt.token],
    )?;
    Ok(json!({"status":"renewed","leaseExpiresAt":receipt.claim.expires_at}))
}

fn settle_work(
    db: &Connection,
    user_id: &str,
    lease: &ExtractionLease,
    now: i64,
    disposition: Disposition,
    error: Option<String>,
) -> Result<Json> {
    let scope = receipt_scope(user_id, &lease.task_id);
    let Some(receipt) = receipt(db, &scope, &lease.token)? else {
        return Ok(json!({"status":"stale"}));
    };
    if receipt.claim.owner != lease.owner {
        return Ok(json!({"status":"stale"}));
    }
    let status = disposition.status();
    if receipt.status == status {
        return Ok(json!({"status":status}));
    }
    if receipt.status != CLAIMED || !live(&receipt.claim, now) {
        return Ok(json!({"status":"stale"}));
    }
    if read_claimed_batch(db, user_id, &lease.task_id, &receipt.claim, false)?.is_none() {
        release_turns(db, &lease.task_id, &receipt.claim)?;
        close_receipt(db, &scope, &receipt, "invalidated")?;
        return Ok(json!({"status":"stale"}));
    }
    match disposition {
        Disposition::Release => release_turns(db, &lease.task_id, &receipt.claim)?,
        Disposition::Completed | Disposition::Failed => {
            let note = error
                .as_deref()
                .map(|error| error.chars().take(1000).collect::<String>());
            for turn in &receipt.claim.turns {
                let changed = db.execute("UPDATE memory_turns SET extraction_state=?1,extracted_at=?2,last_error=?3
                    WHERE id=?4 AND task_id=?5 AND attempt_count=?6 AND extraction_state='processing'", params![status,
                    (status == "completed").then_some(now), (status == "failed").then_some(note.as_deref()).flatten(),
                    turn.id, lease.task_id, turn.attempt])?;
                if changed != 1 {
                    return Err("Memory extraction sources changed while settling the batch".into());
                }
            }
            if status == "completed" {
                let remaining: i64 = db.query_row(
                    &format!("SELECT count(*) FROM memory_turns WHERE task_id=?1 AND {RETRYABLE}"),
                    [&lease.task_id],
                    |r| r.get(0),
                )?;
                db.execute("INSERT INTO memory_pipeline_state(task_id,captured_turns,turns_since_l1,last_l1_at,last_l2_at,last_l3_at,
                  l1_run_count,l2_run_count,l3_run_count,updated_at) VALUES (?1,0,?2,?3,NULL,NULL,1,0,0,?3)
                  ON CONFLICT(task_id) DO UPDATE SET turns_since_l1=excluded.turns_since_l1,last_l1_at=excluded.last_l1_at,
                    l1_run_count=memory_pipeline_state.l1_run_count+1,updated_at=excluded.updated_at",
                    params![lease.task_id, remaining, now])?;
            }
        }
    }
    close_receipt(db, &scope, &receipt, status)?;
    Ok(json!({"status":status}))
}

pub fn write_extraction(
    db: &mut Connection,
    command: ExtractionCommand,
    user_id: &str,
) -> Result<Json> {
    let lease = match &command {
        ExtractionCommand::Claim { lease, .. }
        | ExtractionCommand::Renew { lease, .. }
        | ExtractionCommand::Settle { lease, .. } => lease,
    };
    if user_id.trim().is_empty()
        || lease.task_id.trim().is_empty()
        || lease.owner.trim().is_empty()
        || lease.owner.len() > 200
        || lease.token.trim().is_empty()
        || lease.token.len() > 200
    {
        return Err("Invalid memory extraction lease identity".into());
    }
    let tx = db.transaction()?;
    let now = now_ms();
    let reply = match command {
        ExtractionCommand::Claim {
            lease,
            captured_through,
            limit,
            lease_ms,
        } => claim_work(&tx, user_id, &lease, now, captured_through, limit, lease_ms)?,
        ExtractionCommand::Renew { lease, lease_ms } => {
            renew_work(&tx, user_id, &lease, now, lease_ms)?
        }
        ExtractionCommand::Settle {
            lease,
            disposition,
            error,
        } => settle_work(&tx, user_id, &lease, now, disposition, error)?,
    };
    crate::request_control::commit(tx)?;
    Ok(reply)
}
