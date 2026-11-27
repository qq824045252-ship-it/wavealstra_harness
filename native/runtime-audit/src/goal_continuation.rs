use crate::{
    Result,
    business_protocol::ClientContext,
    outbox_publisher::{OutboxEventDraft, OutboxGroupDraft, append_outbox_group_in_tx},
};
use duckdb::{Connection, OptionalExt, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

const STALL_LIMIT: i64 = 2;
const MAX_JSON_INTEGER: i64 = 9_007_199_254_740_991;
const REQUEST_PREFIX: &str = "goal-continuation:";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub user_id: String,
    pub task_id: String,
    pub work_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResponse {
    pub user_id: String,
    pub task_id: String,
    pub store_id: String,
    pub host_generation: String,
    pub conversation_id: i64,
    pub generation_id: i64,
    pub entry_id: i64,
    pub fallback_budget: Option<i64>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Trigger {
    Settled,
    Continued,
}

impl Trigger {
    fn name(self) -> &'static str {
        match self {
            Self::Settled => "settled",
            Self::Continued => "continued",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    #[serde(flatten)]
    query: Query,
    operation_id: String,
    intent_revision: i64,
    state_version: i64,
    owner_epoch: i64,
    store_id: String,
    host_generation: String,
    conversation_id: i64,
    expected_store_commit_seq: i64,
    expected_attempt_serial: i64,
    expected_ledger_updated_at: i64,
    source_entry_id: i64,
    trigger: Trigger,
    max_attempts: i64,
    fallback_budget: Option<i64>,
    progress_fingerprint: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum AttemptOutcome {
    SubmitRejected,
    Settled,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportAttempt {
    #[serde(flatten)]
    query: Query,
    operation_id: String,
    claim_operation_id: String,
    store_id: String,
    host_generation: String,
    outcome: AttemptOutcome,
    progress_fingerprint: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Command {
    RecordResponse(RecordResponse),
    Claim(Claim),
    ReportAttempt(ReportAttempt),
}

impl Command {
    pub fn task_id(&self) -> &str {
        match self {
            Self::RecordResponse(args) => &args.task_id,
            Self::Claim(args) => &args.query.task_id,
            Self::ReportAttempt(args) => &args.query.task_id,
        }
    }

    pub fn work_id(&self) -> Option<&str> {
        match self {
            Self::RecordResponse(_) => None,
            Self::Claim(args) => Some(&args.query.work_id),
            Self::ReportAttempt(args) => Some(&args.query.work_id),
        }
    }

    pub fn store_id(&self) -> &str {
        match self {
            Self::RecordResponse(args) => &args.store_id,
            Self::Claim(args) => &args.store_id,
            Self::ReportAttempt(args) => &args.store_id,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ActiveQueryKind {
    ActiveClaim,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveQuery {
    #[serde(rename = "kind")]
    _kind: ActiveQueryKind,
    #[serde(flatten)]
    scope: Query,
    store_id: String,
    host_generation: String,
    conversation_id: i64,
    run_task_id: i64,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum ReadRequest {
    Active(ActiveQuery),
    Ledger(Query),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ledger {
    intent_revision: i64,
    state_version: i64,
    owner_epoch: i64,
    attempt_serial: i64,
    attempts: i64,
    tokens_used: i64,
    token_budget: Option<i64>,
    progress_stalls: i64,
    progress_fingerprint: Option<String>,
    run_cursor: i64,
    state: String,
    defer_reason: Option<String>,
    updated_at: i64,
    can_advance: bool,
    directory: String,
    lifecycle: String,
}

fn ledger(db: &Connection, scope: &Query) -> Result<Option<Ledger>> {
    db.query_row(
        "SELECT w.intent_revision,w.state_version,w.owner_epoch,c.attempt_serial,c.attempts,
                c.tokens_used,c.tokens_budget,c.progress_stalls,c.progress_fingerprint,c.run_cursor,c.state,
                c.defer_reason,c.updated_at,
                (w.lifecycle='active' AND w.mode<>'watch'
                 AND NOT EXISTS(SELECT 1 FROM work_blockers b WHERE b.work_id=w.work_id AND b.status='open')
                 AND (json_array_length(w.criteria_json)=0 OR EXISTS(SELECT 1 FROM json_each(w.criteria_json) j
                      WHERE coalesce(json_extract_string(j.value,'$.status'),'pending') NOT IN ('satisfied','waived')))
                 AND NOT EXISTS(SELECT 1 FROM work_conversations other JOIN works candidate USING(work_id)
                      WHERE other.conversation_id=t.id AND other.work_id<>w.work_id AND candidate.lifecycle<>'closed')),
                d.directory,w.lifecycle
         FROM works w JOIN work_conversations link USING(work_id)
         JOIN tasks t ON t.id=link.conversation_id
         JOIN durable_bot_bindings d ON d.task_id=t.id AND d.backend='pi-durable'
         JOIN conversation_goal_continuations c ON c.work_id=w.work_id AND c.task_id=t.id AND c.intent_revision=w.intent_revision
         WHERE w.user_id=?1 AND t.id=?2 AND w.work_id=?3 AND t.id<>'mybuddy-dots'
           AND t.archived=0 AND t.external_agent_pin_json IS NULL
           AND NOT EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.task_id=t.id)
           AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state x WHERE x.task_id=t.id AND x.state='trashed')
           AND NOT EXISTS(WITH RECURSIVE parents(id,parent_id,archived) AS (
             SELECT id,parent_id,archived FROM spaces WHERE id=t.space_id
             UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN parents p ON s.id=p.parent_id
           ) SELECT 1 FROM parents WHERE archived<>0)",
        params![scope.user_id, scope.task_id, scope.work_id],
        |row| Ok(Ledger {
            intent_revision: row.get(0)?, state_version: row.get(1)?, owner_epoch: row.get(2)?,
            attempt_serial: row.get(3)?, attempts: row.get(4)?, tokens_used: row.get(5)?, token_budget: row.get(6)?,
            progress_stalls: row.get(7)?, progress_fingerprint: row.get(8)?, run_cursor: row.get(9)?,
            state: row.get(10)?, defer_reason: row.get(11)?, updated_at: row.get(12)?, can_advance: row.get(13)?, directory: row.get(14)?, lifecycle: row.get(15)?,
        }),
    ).optional().map_err(Into::into)
}

pub fn read(db: &mut Connection, scope: Query) -> Result<Value> {
    let tx = db.transaction()?;
    let Some(row) = ledger(&tx, &scope)? else {
        return Ok(Value::Null);
    };
    let store = crate::durable::store_id_for_path(Path::new(&row.directory));
    let commit: Option<i64> = tx
        .query_row(
            "SELECT commit_seq FROM durable_stores WHERE store_id=? AND NOT retired",
            [&store],
            |result| result.get(0),
        )
        .optional()?;
    let mut value = serde_json::to_value(row)?;
    value
        .as_object_mut()
        .expect("ledger serializes as an object")
        .remove("directory");
    value["storeCommitSeq"] = json!(commit);
    value["storeId"] = store.into();
    value["placementGuardVersion"] = 1.into();
    value["activeClaimGuardVersion"] = 1.into();
    Ok(value)
}

pub fn read_request(db: &mut Connection, query: ReadRequest) -> Result<Value> {
    match query {
        ReadRequest::Active(query) => active_claim(db, &query),
        ReadRequest::Ledger(query) => read(db, query),
    }
}

fn active_claim(db: &mut Connection, query: &ActiveQuery) -> Result<Value> {
    let tx = db.transaction()?;
    let scope = &query.scope;
    let Some(ledger) = ledger(&tx, scope)? else {
        return Ok(reject("scope_changed"));
    };
    let now = i64::try_from(crate::request_control::now_ms())?;
    let core_generation = crate::business_protocol::current_core_generation();
    let host_live: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM core_pi_hosts h WHERE h.host_generation=?1
        AND h.core_generation=?2 AND h.status='running' AND h.stopped_at_ms IS NULL
        AND NOT EXISTS(SELECT 1 FROM core_pi_host_fences f WHERE f.host_generation=h.host_generation))",
        params![query.host_generation, core_generation], |row| row.get(0))?;
    if !host_live {
        return Ok(reject("host_fenced"));
    }
    let Some((_, created_at)) = current_store(
        &tx,
        &ledger.directory,
        &query.store_id,
        &query.host_generation,
        now,
    )?
    else {
        return Ok(reject("writer_fenced"));
    };
    if !crate::pi_storage::is_goal_input_conversation(&tx, &query.store_id, query.conversation_id)?
    {
        return Ok(reject("conversation_changed"));
    }
    let Some((run, inputs)) =
        crate::pi_storage::goal_live_run(&tx, &query.store_id, query.conversation_id)?
    else {
        return Ok(reject("run_changed"));
    };
    if run != query.run_task_id {
        return Ok(reject("run_changed"));
    }

    let mut ordinary = false;
    let mut current = false;
    let mut stale = false;
    for id in inputs {
        let source: Option<(String, String, Option<String>)> = tx.query_row("SELECT s.status,s.record_json,e.record_json FROM durable_submissions s
            LEFT JOIN durable_entries e ON e.store_id=s.store_id AND e.conversation_id=s.conversation_id
              AND e.id=try_cast(json_extract(s.record_json,'$.entry') AS BIGINT)
            WHERE s.store_id=?1 AND s.conversation_id=?2 AND s.id=?3", params![query.store_id, query.conversation_id,id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        let Some((status, submission, entry)) = source else {
            return Ok(reject("input_missing"));
        };
        let source: Value = serde_json::from_str(&submission)?;
        let request = source["requestId"].as_str().and_then(decode_wire_string);
        let is_goal = request
            .as_deref()
            .is_some_and(|request| request.starts_with(REQUEST_PREFIX));
        if !matches!(status.as_str(), "placed" | "done") {
            return Ok(reject("input_changed"));
        }
        if !is_goal {
            ordinary = true;
            continue;
        }
        let Some(entry) = entry else {
            return Ok(reject("input_missing"));
        };
        let entry: Value = serde_json::from_str(&entry)?;
        let input = &entry["data"]["mybuddyInput"];
        let marker = &input["goalContinuation"];
        let operation = marker_string(marker, "claimOperationId");
        let saved = match operation {
            Some(id) => receipt(&tx, scope, &id)?,
            None => None,
        };
        let Some((_, encoded)) = saved else {
            stale = true;
            continue;
        };
        let claim: Value = serde_json::from_str(&encoded)?;
        let matches = ledger.lifecycle == "active"
            && ledger.state == "igniting"
            && claim["status"] == "claimed"
            && claim["taskId"] == scope.task_id
            && claim["workId"] == scope.work_id
            && claim["storeId"] == query.store_id
            && claim["storeCreatedAt"] == created_at
            && claim["hostGeneration"] == query.host_generation
            && claim["conversationId"] == query.conversation_id
            && claim["intentRevision"] == ledger.intent_revision
            && claim["ownerEpoch"] == ledger.owner_epoch
            && claim["attemptSerial"] == ledger.attempt_serial
            && claim["attemptSerial"] == marker["attemptSerial"]
            && claim["intentRevision"] == marker["intentRevision"]
            && claim["ownerEpoch"] == marker["ownerEpoch"]
            && claim["requestId"].as_str() == request.as_deref()
            && input["inputRequestId"] == source["requestId"];
        current |= matches;
        stale |= !matches;
    }
    Ok(if stale {
        json!({ "status":if ordinary { "mixed" } else { "stale" }, "reason":"goal_claim_changed" })
    } else if current {
        json!({ "status":"current", "workId":scope.work_id, "attemptSerial":ledger.attempt_serial })
    } else {
        json!({ "status":"ordinary" })
    })
}

fn reject(code: &str) -> Value {
    json!({ "status": "rejected", "code": code })
}

fn current_host(tx: &Transaction<'_>, client: &ClientContext, host: &str) -> Result<bool> {
    if client.role != "execution-host" || host.is_empty() {
        return Ok(false);
    }
    tx.query_row("SELECT EXISTS(SELECT 1 FROM core_pi_hosts p WHERE p.host_generation=?1
        AND p.core_generation=?2 AND p.status='running' AND p.stopped_at_ms IS NULL
        AND NOT EXISTS(SELECT 1 FROM core_pi_host_fences f WHERE f.host_generation=p.host_generation))",
        params![host, client.generation], |row| row.get(0)).map_err(Into::into)
}

fn current_store(
    tx: &Transaction<'_>,
    directory: &str,
    store: &str,
    host: &str,
    now: i64,
) -> Result<Option<(i64, i64)>> {
    if crate::durable::store_id_for_path(Path::new(directory)) != store {
        return Ok(None);
    }
    tx.query_row("SELECT commit_seq,created_at_ms FROM durable_stores WHERE store_id=?1 AND host_generation=?2 AND NOT retired
        AND lease_holder IS NOT NULL AND lease_expires_at_ms>?3", params![store, host, now], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(Into::into)
}

pub fn write(db: &mut Connection, command: Command, client: &ClientContext) -> Result<Value> {
    let tx = db.transaction()?;
    let now = i64::try_from(crate::request_control::now_ms())?;
    let result = match command {
        Command::RecordResponse(args) => record_response(&tx, args, client, now),
        Command::Claim(args) => {
            if current_host(&tx, client, &args.host_generation)? {
                apply_once(
                    &tx,
                    &args.query,
                    &args.operation_id,
                    "claim",
                    &args,
                    now,
                    || claim(&tx, &args, now),
                )
            } else {
                Ok(reject("host_fenced"))
            }
        }
        Command::ReportAttempt(args) => {
            if current_host(&tx, client, &args.host_generation)? {
                apply_once(
                    &tx,
                    &args.query,
                    &args.operation_id,
                    "report",
                    &args,
                    now,
                    || report(&tx, &args, now),
                )
            } else {
                Ok(reject("host_fenced"))
            }
        }
    };
    match result {
        Ok(reply) => {
            crate::request_control::commit(tx)?;
            Ok(reply)
        }
        Err(error) => {
            if tx.rollback().is_ok() {
                crate::request_control::known_failure();
            }
            Err(error)
        }
    }
}

fn caller_scope(scope: &Query) -> String {
    format!(
        "goal-continuation:{}",
        json!([scope.user_id, scope.task_id, scope.work_id])
    )
}

fn receipt(tx: &Transaction<'_>, scope: &Query, id: &str) -> Result<Option<(String, String)>> {
    tx.query_row("SELECT request_hash,result_json FROM operation_receipts WHERE caller_scope=?1 AND operation_id=?2 AND batch_index=0",
        params![caller_scope(scope), id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(Into::into)
}

fn apply_once(
    tx: &Transaction<'_>,
    scope: &Query,
    id: &str,
    kind: &str,
    payload: &impl Serialize,
    now: i64,
    apply: impl FnOnce() -> Result<Value>,
) -> Result<Value> {
    if id.is_empty() || id.len() > 200 {
        return Ok(reject("invalid_operation"));
    }
    let hash = crate::work_scheduler::sha256_hex(&serde_json::to_string(&(kind, payload))?);
    if let Some((prior, encoded)) = receipt(tx, scope, id)? {
        if prior != hash {
            return Ok(reject("conflicting_operation"));
        }
        let mut saved: Value = serde_json::from_str(&encoded)?;
        saved["replayed"] = true.into();
        return Ok(saved);
    }
    let reply = apply()?;
    if reply["status"] != "rejected" {
        tx.execute("INSERT INTO operation_receipts(caller_scope,operation_id,batch_index,request_hash,status,result_json,created_at_ms)
                    VALUES (?1,?2,0,?3,'committed',?4,?5)",
            params![caller_scope(scope), id, hash, serde_json::to_string(&reply)?, now])?;
    }
    Ok(reply)
}

fn publish(
    tx: &Transaction<'_>,
    scope: &Query,
    host: &str,
    id: &str,
    revision: i64,
    mut data: Value,
    now: i64,
) -> Result<()> {
    data["taskId"] = json!(scope.task_id);
    let event_id = format!(
        "goal-continuation:{}",
        json!([scope.user_id, scope.task_id, scope.work_id, id])
    );
    append_outbox_group_in_tx(
        tx,
        &OutboxGroupDraft {
            group_id: event_id.clone(),
            operation_id: event_id.clone(),
            batch_index: 0,
            entity_key: format!("work:{}", scope.work_id),
            entity_revision: None,
            previous_revision: None,
            depends_on_group_id: None,
            work_projection_user_id: Some(scope.user_id.clone()),
        },
        &[OutboxEventDraft {
            event_id,
            owner_generation: host.into(),
            domain: "work".into(),
            kind: "work.goalContinuationChanged".into(),
            task_id: Some(scope.task_id.clone()),
            entity_id: scope.work_id.clone(),
            revision,
            command_id: Some(id.into()),
            payload_json: data.to_string(),
        }],
        now,
    )?;
    Ok(())
}

fn assistant_entry(
    db: &Connection,
    store: &str,
    conversation: i64,
    entry: i64,
) -> Result<Option<(i64, Value)>> {
    let row: Option<(i64, String)> = db.query_row("SELECT by_task_id,record_json FROM durable_entries
        WHERE store_id=?1 AND conversation_id=?2 AND id=?3 AND by_task_id IS NOT NULL AND kind='pi.assistant'",
        params![store, conversation, entry], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
    row.map(|(generation, encoded)| Ok((generation, serde_json::from_str(&encoded)?)))
        .transpose()
}

fn generation_owner(
    db: &Connection,
    task: &str,
    conversation: i64,
    generation: i64,
) -> Result<Option<(String, i64, i64)>> {
    db.query_row("SELECT work_id,try_cast(json_extract(metadata,'$.intentRevision') AS BIGINT),
                  try_cast(json_extract(metadata,'$.ownerEpoch') AS BIGINT) FROM conversation_goal_generations
                  WHERE task_id=?1 AND conversation_id=?2 AND generation_id=?3", params![task, conversation.to_string(), generation],
        |row| Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0), row.get::<_, Option<i64>>(2)?.unwrap_or(0))))
        .optional().map_err(Into::into)
}

fn record_response(
    tx: &Transaction<'_>,
    args: RecordResponse,
    client: &ClientContext,
    now: i64,
) -> Result<Value> {
    if !current_host(tx, client, &args.host_generation)? {
        return Ok(reject("host_fenced"));
    }
    let Some((work_id, revision, epoch)) =
        generation_owner(tx, &args.task_id, args.conversation_id, args.generation_id)?
    else {
        return Ok(json!({ "status":"ignored", "reason":"unowned_generation" }));
    };
    let scope = Query {
        user_id: args.user_id,
        task_id: args.task_id,
        work_id,
    };
    let Some(row) = ledger(tx, &scope)? else {
        return Ok(reject("scope_changed"));
    };
    if row.intent_revision != revision || row.owner_epoch != epoch {
        return Ok(reject("stale_generation"));
    }
    let store = &args.store_id;
    let Some((_, created_at)) =
        current_store(tx, &row.directory, store, &args.host_generation, now)?
    else {
        return Ok(reject("writer_fenced"));
    };
    let Some((generation, entry)) =
        assistant_entry(tx, &store, args.conversation_id, args.entry_id)?
    else {
        return Ok(reject("entry_missing"));
    };
    if generation != args.generation_id {
        return Ok(reject("wrong_generation"));
    }
    let tokens = entry["model"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["role"] == "assistant")
        .flat_map(|message| {
            ["input", "output", "cacheRead"]
                .map(|field| message["usage"][field].as_i64().unwrap_or(0).max(0))
        })
        .fold(0_i64, |total, value| {
            total.saturating_add(value).min(MAX_JSON_INTEGER)
        });
    if tokens == 0 {
        return Ok(json!({ "status":"ignored", "reason":"no_tokens" }));
    }
    let key = format!(
        "core-goal-response:{}",
        json!([
            scope.work_id,
            revision,
            store,
            created_at,
            args.conversation_id,
            args.entry_id
        ])
    );
    let replayed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversation_goal_usage_events WHERE event_key=?)",
        [&key],
        |result| result.get(0),
    )?;
    if replayed {
        return Ok(
            json!({ "status":"accounted", "replayed":true, "tokensAdded":0, "workId":scope.work_id, "tokensUsed":row.tokens_used }),
        );
    }
    // A manual reset starts after its observed source entry across the same Pi store. It does
    // not let a delayed first observation of older output spend the reset budget.
    let before_window: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operation_receipts WHERE caller_scope=?1
        AND json_extract_string(result_json,'$.status')='claimed' AND json_extract_string(result_json,'$.trigger')='continued'
        AND json_extract_string(result_json,'$.storeId')=?2 AND try_cast(json_extract(result_json,'$.storeCreatedAt') AS BIGINT)=?3
        AND try_cast(json_extract(result_json,'$.intentRevision') AS BIGINT)=?4
        AND try_cast(json_extract(result_json,'$.sourceEntryId') AS BIGINT)>=?5)",
        params![caller_scope(&scope), store, created_at, revision, args.entry_id], |result| result.get(0))?;
    if before_window {
        return Ok(json!({ "status":"ignored", "reason":"older_budget_window" }));
    }
    let inserted = tx.execute(
        "INSERT INTO conversation_goal_usage_events(event_key,task_id,tokens,recorded_at)
        VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
        params![key, scope.task_id, tokens, now],
    )?;
    if inserted == 0 {
        return Ok(
            json!({ "status":"accounted", "replayed":true, "tokensAdded":0, "workId":scope.work_id, "tokensUsed":row.tokens_used }),
        );
    }
    let used = row.tokens_used.saturating_add(tokens).min(MAX_JSON_INTEGER);
    let budget = row
        .token_budget
        .or(args.fallback_budget)
        .filter(|budget| *budget > 0);
    let exhaust = row.state == "idle" && budget.is_some_and(|limit| used >= limit);
    tx.execute("UPDATE conversation_goal_continuations SET tokens_used=?1,
                usage_cursor=least(usage_cursor,?3-?2)+?2,last_token_at=?4,
                state=CASE WHEN ?5 THEN 'exhausted' ELSE state END,
                defer_reason=CASE WHEN ?5 THEN 'budget' ELSE defer_reason END,
                deferred_at=CASE WHEN ?5 THEN ?4 ELSE deferred_at END, updated_at=greatest(updated_at+1,?4) WHERE work_id=?6",
        params![used, tokens, MAX_JSON_INTEGER, now, exhaust, scope.work_id])?;
    let reply = json!({ "status":"accounted", "replayed":false, "tokensAdded":tokens, "workId":scope.work_id,
        "intentRevision":revision,"tokensUsed":used,"state":if exhaust { "exhausted" } else { &row.state } });
    publish(
        tx,
        &scope,
        &args.host_generation,
        &key,
        revision,
        reply.clone(),
        now,
    )?;
    Ok(reply)
}

fn placement_marker(write: &Value) -> Option<&Value> {
    if write["type"] == "entry" && write["value"]["kind"] == "mybuddy.user" {
        let data = &write["value"]["data"];
        let input = &data["mybuddyInput"];
        // Fork seeds passively carry the old display marker, without admitting an input.
        if data["inherited"] == true
            && data["sourceEntryId"].is_string()
            && input["inputRequestId"].is_null()
        {
            return None;
        }
        input
            .get("goalContinuation")
            .filter(|marker| !marker.is_null())
    } else {
        None
    }
}

fn marker_string(marker: &Value, key: &str) -> Option<String> {
    marker[key].as_str().and_then(decode_wire_string)
}

fn decode_wire_string(encoded: &str) -> Option<String> {
    String::from_utf16(&crate::pi_storage::decode_pi_string(encoded)).ok()
}

pub(crate) fn placement_resources(write: &Value) -> Option<(String, String)> {
    let marker = placement_marker(write)?;
    Some((
        marker_string(marker, "taskId")?,
        marker_string(marker, "workId")?,
    ))
}

/// The authorized automatic input must place on the exact idle conversation seen by the claim.
/// A queued automatic input is never durable, so a later user input cannot inherit stale Goal work.
pub(crate) fn placement_current(
    tx: &Transaction<'_>,
    store: &str,
    store_created_at: i64,
    commit: i64,
    host: Option<&str>,
    batch: &[Value],
) -> Result<bool> {
    let mut input_writes = batch.iter().filter_map(|write| {
        let value = &write["value"];
        (write["type"] == "submission"
            && value["type"] == "input"
            && matches!(value["status"].as_str(), Some("queued" | "placed")))
        .then_some(value)
    });
    let mut marked = batch
        .iter()
        .filter_map(|write| placement_marker(write).map(|marker| (&write["value"], marker)));
    let Some((entry, marker)) = marked.next() else {
        return Ok(!input_writes.any(|record| {
            record["requestId"]
                .as_str()
                .is_some_and(|id| id.starts_with(REQUEST_PREFIX))
        }));
    };
    let Some(submission) = input_writes.next() else {
        return Ok(false);
    };
    if marked.next().is_some()
        || input_writes.next().is_some()
        || submission["status"] != "placed"
        || !submission["requestId"]
            .as_str()
            .is_some_and(|id| id.starts_with(REQUEST_PREFIX))
    {
        return Ok(false);
    }
    let input = &entry["data"]["mybuddyInput"];
    let Some(conversation) = entry["conversationId"].as_i64().filter(|id| *id > 0) else {
        return Ok(false);
    };
    if entry["id"].as_i64().is_none_or(|id| id <= 0)
        || submission["entry"] != entry["id"]
        || submission["conversationId"] != conversation
        || submission["requestId"] != input["inputRequestId"]
        || !input["gatewayOrigin"].is_null()
        || !input["botRequestId"].is_null()
        || !input["goalUserInput"].is_null()
    {
        return Ok(false);
    }
    let (Some(task_id), Some(work_id), Some(operation), Some(host)) = (
        marker_string(marker, "taskId"),
        marker_string(marker, "workId"),
        marker_string(marker, "claimOperationId"),
        host,
    ) else {
        return Ok(false);
    };
    let user: Option<String> = tx
        .query_row(
            "SELECT user_id FROM works WHERE work_id=?",
            [&work_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(user_id) = user else {
        return Ok(false);
    };
    let scope = Query {
        task_id,
        work_id,
        user_id,
    };
    let Some((_, encoded)) = receipt(tx, &scope, &operation)? else {
        return Ok(false);
    };
    let authority: Value = serde_json::from_str(&encoded)?;
    let Some(request) = authority["requestId"].as_str() else {
        return Ok(false);
    };
    let Some(pi_request) = submission["requestId"].as_str() else {
        return Ok(false);
    };
    if authority["status"] != "claimed"
        || authority["taskId"] != scope.task_id
        || authority["workId"] != scope.work_id
        || authority["hostGeneration"] != host
        || authority["storeId"] != store
        || authority["storeCreatedAt"] != store_created_at
        || authority["conversationId"] != conversation
        || authority["storeCommitSeq"] != commit
        || authority["intentRevision"] != marker["intentRevision"]
        || authority["ownerEpoch"] != marker["ownerEpoch"]
        || authority["attempt"] != marker["attempt"]
        || authority["attemptSerial"] != marker["attemptSerial"]
        || decode_wire_string(pi_request).as_deref() != Some(request)
    {
        return Ok(false);
    }

    let Some(row) = ledger(tx, &scope)? else {
        return Ok(false);
    };
    if row.state != "igniting"
        || !row.can_advance
        || authority["stateVersion"] != row.state_version
        || authority["attemptSerial"] != row.attempt_serial
        || authority["ownerEpoch"] != row.owner_epoch
        || authority["intentRevision"] != row.intent_revision
        || authority["sourceEntryId"] != row.run_cursor
        || crate::durable::store_id_for_path(Path::new(&row.directory)) != store
    {
        return Ok(false);
    }
    let budget = row.token_budget.or(authority["budget"].as_i64());
    if budget.is_some_and(|budget| row.tokens_used >= budget) {
        return Ok(false);
    }
    let active_host: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM core_pi_hosts h WHERE h.host_generation=?1
            AND h.status='running' AND h.stopped_at_ms IS NULL
            AND NOT EXISTS(SELECT 1 FROM core_pi_host_fences f WHERE f.host_generation=h.host_generation))",
        [host], |value| value.get(0))?;
    if !active_host
        || !crate::pi_storage::is_goal_input_conversation(tx, store, conversation)?
        || !conversation_idle(tx, &scope.task_id, store, conversation)?
        || latest_chat_entry(tx, store, conversation)?.unwrap_or(0) != row.run_cursor
    {
        return Ok(false);
    }
    let present: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM durable_request_keys WHERE store_id=?1 AND conversation_id=?2 AND request_id=?3)",
        params![store, conversation, indexed_request(request)], |value| value.get(0))?;
    Ok(!present)
}

fn latest_chat_entry(db: &Connection, store: &str, conversation: i64) -> Result<Option<i64>> {
    db.query_row(
        "SELECT max(id) FROM durable_entries WHERE store_id=?1 AND conversation_id=?2
        AND kind IN ('mybuddy.user','pi.user','pi.assistant')",
        params![store, conversation],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn conversation_idle(db: &Connection, task: &str, store: &str, conversation: i64) -> Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM durable_conversations WHERE store_id=?1 AND id=?2)
        AND NOT EXISTS(SELECT 1 FROM durable_tasks WHERE store_id=?1 AND conversation_id=?2 AND NOT background AND status<>'terminal')
        AND NOT EXISTS(SELECT 1 FROM durable_submissions WHERE store_id=?1 AND conversation_id=?2 AND status IN ('queued','placed'))
        AND NOT EXISTS(SELECT 1 FROM conversation_interactions WHERE task_id=?3 AND status='pending')",
        params![store, conversation, task], |row| row.get(0)).map_err(Into::into)
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn indexed_request(value: &str) -> String {
    crate::pi_storage::encode_indexed_str(&crate::pi_storage::encode_pi_string(
        value.encode_utf16().collect(),
    ))
}

fn checked_budget(budget: Option<i64>) -> bool {
    budget.is_none_or(|value| (1..=MAX_JSON_INTEGER).contains(&value))
}

fn save_check(
    tx: &Transaction<'_>,
    scope: &Query,
    revision: i64,
    trigger: &str,
    reason: &str,
    at: i64,
) -> Result<()> {
    tx.execute("INSERT INTO conversation_goal_last_check(work_id,task_id,intent_revision,trigger,reason,\"at\")
        VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(work_id) DO UPDATE SET task_id=excluded.task_id,intent_revision=excluded.intent_revision,
        trigger=excluded.trigger,reason=excluded.reason,\"at\"=excluded.\"at\"", params![scope.work_id, scope.task_id, revision, trigger, reason, at])?;
    Ok(())
}

fn claim(tx: &Transaction<'_>, args: &Claim, now: i64) -> Result<Value> {
    if !(1..=10).contains(&args.max_attempts)
        || !checked_budget(args.fallback_budget)
        || !valid_fingerprint(&args.progress_fingerprint)
    {
        return Ok(reject("invalid_limits"));
    }
    let scope = &args.query;
    let Some(row) = ledger(tx, scope)? else {
        return Ok(reject("scope_changed"));
    };
    if !row.can_advance {
        return Ok(reject("goal_not_eligible"));
    }
    if (
        row.state_version,
        row.intent_revision,
        row.owner_epoch,
        row.attempt_serial,
        row.updated_at,
    ) != (
        args.state_version,
        args.intent_revision,
        args.owner_epoch,
        args.expected_attempt_serial,
        args.expected_ledger_updated_at,
    ) {
        return Ok(reject("stale_ledger"));
    }
    let manual = matches!(args.trigger, Trigger::Continued);
    if (manual && !matches!(row.state.as_str(), "deferred" | "exhausted"))
        || (!manual && row.state != "idle")
    {
        return Ok(reject("invalid_state"));
    }
    let store = &args.store_id;
    let Some((commit, created_at)) =
        current_store(tx, &row.directory, store, &args.host_generation, now)?
    else {
        return Ok(reject("writer_fenced"));
    };
    if commit != args.expected_store_commit_seq
        || !crate::pi_storage::is_goal_input_conversation(tx, &store, args.conversation_id)?
    {
        return Ok(reject("conversation_changed"));
    }
    if !conversation_idle(tx, &scope.task_id, &store, args.conversation_id)? {
        return Ok(reject("conversation_busy"));
    }
    if latest_chat_entry(tx, &store, args.conversation_id)?.unwrap_or(0) != args.source_entry_id {
        return Ok(reject("source_changed"));
    }
    if !manual {
        if args.source_entry_id <= row.run_cursor {
            return Ok(reject("settlement_consumed"));
        }
        let Some((generation, entry)) =
            assistant_entry(tx, &store, args.conversation_id, args.source_entry_id)?
        else {
            return Ok(reject("entry_missing"));
        };
        let measured = entry["model"].as_array().and_then(|messages| {
            messages
                .iter()
                .rfind(|message| message["role"] == "assistant")
        });
        if measured.is_none()
            || generation_owner(tx, &scope.task_id, args.conversation_id, generation)?
                != Some((scope.work_id.clone(), row.intent_revision, row.owner_epoch))
        {
            return Ok(reject("unowned_settlement"));
        }
        let reason = match measured.and_then(|message| message["stopReason"].as_str()) {
            Some("aborted") => Some("user_interrupt"),
            Some("error" | "length") => Some("run_failed"),
            _ => None,
        };
        if let Some(reason) = reason {
            return stop(tx, args, &row, "deferred", reason, now);
        }
    }
    let budget = row
        .token_budget
        .or(args.fallback_budget)
        .filter(|budget| *budget > 0);
    if !manual {
        if row.attempts >= args.max_attempts {
            return stop(tx, args, &row, "exhausted", "attempts", now);
        }
        if budget.is_some_and(|limit| row.tokens_used >= limit) {
            return stop(tx, args, &row, "exhausted", "budget", now);
        }
        if row.progress_stalls >= STALL_LIMIT {
            return stop(tx, args, &row, "deferred", "no_progress", now);
        }
    }

    let attempt = if manual { 1 } else { row.attempts + 1 };
    let serial = row
        .attempt_serial
        .checked_add(1)
        .ok_or("Goal attempt serial exhausted")?;
    if serial > MAX_JSON_INTEGER {
        return Ok(reject("serial_exhausted"));
    }
    let used = if manual { 0 } else { row.tokens_used };
    tx.execute("UPDATE conversation_goal_continuations SET state='igniting',attempts=?1,attempt_serial=?2,tokens_used=?3,
        progress_fingerprint=?4,progress_stalls=CASE WHEN ?5 THEN 0 ELSE progress_stalls END,run_cursor=?6,
        last_continuation_at=?7,deferred_at=NULL,defer_reason=NULL,updated_at=greatest(updated_at+1,?7) WHERE work_id=?8",
        params![attempt, serial, used, args.progress_fingerprint, manual, args.source_entry_id, now, scope.work_id])?;
    save_check(
        tx,
        scope,
        row.intent_revision,
        args.trigger.name(),
        "claimed",
        now,
    )?;
    let suffix = format!("{}:{}:{}", scope.work_id, row.intent_revision, serial);
    let reply = json!({"status":"claimed","replayed":false,"operationId":args.operation_id,"userId":scope.user_id,
        "workId":scope.work_id,"taskId":scope.task_id,"intentRevision":row.intent_revision,"ownerEpoch":row.owner_epoch,
        "stateVersion":row.state_version,"conversationId":args.conversation_id,"storeCommitSeq":commit,"storeId":store,"storeCreatedAt":created_at,
        "sourceEntryId":args.source_entry_id,"hostGeneration":args.host_generation,
        "attempt":attempt,"attemptSerial":serial,"maxAttempts":args.max_attempts,"budget":budget,"tokensUsed":used,
        "trigger":args.trigger.name(),"requestId":format!("goal-continuation:{suffix}"),"assistantMessageId":format!("goal-continuation-answer:{suffix}")});
    publish(
        tx,
        scope,
        &args.host_generation,
        &args.operation_id,
        row.intent_revision,
        json!({ "state":"igniting", "attemptSerial":serial, "attempts":attempt, "tokensUsed":used }),
        now,
    )?;
    Ok(reply)
}

fn stop(
    tx: &Transaction<'_>,
    args: &Claim,
    row: &Ledger,
    state: &str,
    reason: &str,
    now: i64,
) -> Result<Value> {
    let scope = &args.query;
    tx.execute(
        "UPDATE conversation_goal_continuations SET state=?1,defer_reason=?2,deferred_at=?3,
                updated_at=greatest(updated_at+1,?3) WHERE work_id=?4",
        params![state, reason, now, scope.work_id],
    )?;
    save_check(
        tx,
        scope,
        row.intent_revision,
        args.trigger.name(),
        reason,
        now,
    )?;
    let reply = json!({ "status":"stopped", "state":state, "reason":reason, "workId":scope.work_id, "attemptSerial":row.attempt_serial });
    publish(
        tx,
        scope,
        &args.host_generation,
        &args.operation_id,
        row.intent_revision,
        reply.clone(),
        now,
    )?;
    Ok(reply)
}

fn report(tx: &Transaction<'_>, args: &ReportAttempt, now: i64) -> Result<Value> {
    if args
        .progress_fingerprint
        .as_deref()
        .is_some_and(|value| !valid_fingerprint(value))
    {
        return Ok(reject("invalid_fingerprint"));
    }
    let scope = &args.query;
    let Some((_, encoded)) = receipt(tx, scope, &args.claim_operation_id)? else {
        return Ok(reject("claim_missing"));
    };
    let authority: Value = serde_json::from_str(&encoded)?;
    if authority["status"] != "claimed"
        || authority["workId"] != scope.work_id
        || authority["taskId"] != scope.task_id
        || authority["hostGeneration"] != args.host_generation
        || authority["storeId"] != args.store_id
    {
        return Ok(reject("wrong_claim"));
    }
    let Some(row) = ledger(tx, scope)? else {
        return Ok(reject("scope_changed"));
    };
    if row.state != "igniting"
        || authority["attemptSerial"] != row.attempt_serial
        || authority["ownerEpoch"] != row.owner_epoch
        || authority["intentRevision"] != row.intent_revision
    {
        return Ok(reject("stale_attempt"));
    }
    let store = &args.store_id;
    let Some((_, created_at)) =
        current_store(tx, &row.directory, store, &args.host_generation, now)?
    else {
        return Ok(reject("writer_fenced"));
    };
    if authority["storeCreatedAt"] != created_at {
        return Ok(reject("store_replaced"));
    }
    let conversation = authority["conversationId"]
        .as_i64()
        .ok_or("Stored Goal claim lacks its conversation")?;
    let request = authority["requestId"]
        .as_str()
        .ok_or("Stored Goal claim lacks its request identity")?;
    let request = indexed_request(request);
    let submission: Option<(String, String)> = tx.query_row("SELECT s.status,s.record_json FROM durable_request_keys k
        JOIN durable_submissions s ON s.store_id=k.store_id AND s.conversation_id=k.conversation_id AND s.id=k.submission_id
        WHERE k.store_id=?1 AND k.conversation_id=?2 AND k.request_id=?3", params![store, conversation, request],
        |result| Ok((result.get(0)?, result.get(1)?))).optional()?;
    let (state, reason, attempts, stalls, wake) = match args.outcome {
        AttemptOutcome::SubmitRejected => {
            if submission.is_some() {
                return Ok(reject("submission_exists"));
            }
            (
                "deferred",
                "run_failed",
                (row.attempts - 1).max(0),
                row.progress_stalls,
                false,
            )
        }
        AttemptOutcome::Settled => {
            let Some((status, encoded)) = submission else {
                return Ok(reject("submission_missing"));
            };
            let submission: Value = serde_json::from_str(&encoded)?;
            if status == "unanswered" {
                let reason = match submission["reason"].as_str() {
                    Some("aborted" | "user_abort") => "user_interrupt",
                    _ => "run_failed",
                };
                ("deferred", reason, row.attempts, row.progress_stalls, true)
            } else if status != "done" {
                return Ok(reject("submission_unsettled"));
            } else {
                let stalls = match args.progress_fingerprint.as_ref() {
                    Some(progress) if Some(progress) == row.progress_fingerprint.as_ref() => {
                        row.progress_stalls.saturating_add(1)
                    }
                    Some(_) => 0,
                    None => row.progress_stalls,
                };
                let budget = row.token_budget.or(authority["budget"].as_i64());
                if budget.is_some_and(|budget| row.tokens_used >= budget) {
                    ("exhausted", "budget", row.attempts, stalls, true)
                } else if stalls >= STALL_LIMIT {
                    ("deferred", "no_progress", row.attempts, stalls, true)
                } else {
                    ("idle", "settled", row.attempts, stalls, true)
                }
            }
        }
    };
    let defer_reason = (state != "idle").then_some(reason);
    let deferred_at = defer_reason.map(|_| now);
    tx.execute("UPDATE conversation_goal_continuations SET state=?1,defer_reason=?2,deferred_at=?3,attempts=?4,
        progress_stalls=?5,progress_fingerprint=coalesce(?6,progress_fingerprint),updated_at=greatest(updated_at+1,?7) WHERE work_id=?8",
        params![state, defer_reason, deferred_at, attempts, stalls, args.progress_fingerprint, now, scope.work_id])?;
    save_check(tx, scope, row.intent_revision, "settled", reason, now)?;
    if wake {
        let trigger = authority["trigger"]
            .as_str()
            .ok_or("Stored Goal claim lacks its trigger")?;
        tx.execute("INSERT INTO conversation_goal_last_wake(work_id,task_id,intent_revision,trigger,\"at\")
            VALUES (?1,?2,?3,?4,?5) ON CONFLICT(work_id) DO UPDATE SET task_id=excluded.task_id,intent_revision=excluded.intent_revision,
            trigger=excluded.trigger,\"at\"=excluded.\"at\"", params![scope.work_id, scope.task_id, row.intent_revision, trigger, now])?;
    }
    let reply = json!({"status":"reported","workId":scope.work_id,"state":state,"reason":reason,"attemptSerial":row.attempt_serial,
        "attempts":attempts,"progressStalls":stalls,"tokensUsed":row.tokens_used });
    publish(
        tx,
        scope,
        &args.host_generation,
        &args.operation_id,
        row.intent_revision,
        reply.clone(),
        now,
    )?;
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "goal-test-host";
    const DIRECTORY: &str = "goal-test-store";
    const FINGERPRINT: &str = "024748dffd7d40a03c58b166a42d64484f76fd2be6ee325193e938c09d664f4bd";

    fn scope() -> Query {
        Query {
            user_id: "limited-user".into(),
            task_id: "goal-task".into(),
            work_id: "goal-work".into(),
        }
    }

    fn client() -> ClientContext {
        ClientContext {
            role: "execution-host".into(),
            epoch: 1,
            client_id: "goal-test".into(),
            generation: "goal-test-core".into(),
        }
    }

    fn fixture() -> (Connection, String) {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::database::CANONICAL_DUCKDB_SCHEMA_SQL)
            .unwrap();
        db.execute_batch("INSERT INTO tasks(id,title,updated_at) VALUES ('goal-task','Goal task',1), ('other-task','Other task',1);
            INSERT INTO works (work_id,user_id,owner_bot_id,title,authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,created_at,updated_at)
              VALUES ('goal-work','limited-user','bot','Goal','{}','intent','input','user',1,1);
            INSERT INTO work_conversations(work_id,conversation_id,channel_type,last_referenced_at) VALUES ('goal-work','goal-task','desktop',1);
            INSERT INTO conversation_goal_continuations(work_id,task_id,intent_revision,updated_at) VALUES ('goal-work','goal-task',1,1);
            INSERT INTO core_pi_hosts(host_id,pid,core_generation,host_generation,storage_root,db_path,pi_version,status,started_at_ms,last_heartbeat_ms)
              VALUES ('host',1,'goal-test-core','goal-test-host','root','db','pi-test','running',1,1);
            INSERT INTO conversation_goal_generations(task_id,conversation_id,generation_id,work_id,metadata)
              VALUES ('goal-task','1',2,'goal-work','{\"intentRevision\":1,\"ownerEpoch\":1}');").unwrap();
        db.execute(
            "INSERT INTO durable_bot_bindings VALUES ('goal-task','pi-durable',?1,?1)",
            [DIRECTORY],
        )
        .unwrap();
        let store = crate::durable::store_id_for_path(Path::new(DIRECTORY));
        let open: crate::pi_storage::Invocation =
            serde_json::from_value(json!({"action":"openWriter",
            "storeId":store,"hostGeneration":HOST,"leaseHolder":"holder"}))
            .unwrap();
        assert_eq!(open.execute(&mut db).unwrap()["ok"], true);
        db.execute("UPDATE durable_stores SET commit_seq=5,next_id=4,lease_expires_at_ms=?1 WHERE store_id=?2",
            params![MAX_JSON_INTEGER, store]).unwrap();
        db.execute(
            "INSERT INTO durable_conversations(store_id,id,record_json) VALUES (?1,1,'{}')",
            [&store],
        )
        .unwrap();
        db.execute("INSERT INTO durable_entries(store_id,id,conversation_id,kind,by_task_id,commit_seq,record_json)
            VALUES (?1,3,1,'pi.assistant',2,5,?2)", params![store, json!({ "model":[{"role":"assistant","stopReason":"stop",
                "usage":{"input":15,"output":3,"cacheRead":2,"cacheWrite":100}}] }).to_string()]).unwrap();
        (db, store)
    }

    fn command(payload: Value) -> Command {
        serde_json::from_value(payload).unwrap()
    }

    fn account() -> Value {
        json!({"kind":"recordResponse","userId":"limited-user","taskId":"goal-task","hostGeneration":HOST,
            "storeId":crate::durable::store_id_for_path(Path::new(DIRECTORY)),
            "conversationId":1,"generationId":2,"entryId":3,"fallbackBudget":50})
    }

    fn claim_command(row: &Value, operation: &str, trigger: &str) -> Value {
        json!({"kind":"claim","userId":"limited-user","taskId":"goal-task","workId":"goal-work",
            "operationId":operation,"intentRevision":row["intentRevision"],"stateVersion":row["stateVersion"],"ownerEpoch":row["ownerEpoch"],
            "hostGeneration":HOST,"storeId":row["storeId"],"conversationId":1,"expectedStoreCommitSeq":row["storeCommitSeq"],
            "expectedAttemptSerial":row["attemptSerial"],"expectedLedgerUpdatedAt":row["updatedAt"],"sourceEntryId":3,"trigger":trigger,
            "maxAttempts":3,"fallbackBudget":50,"progressFingerprint":FINGERPRINT})
    }

    #[test]
    fn usage_is_measured_once_and_a_manual_retry_keeps_the_old_event_fenced() {
        let (mut db, store) = fixture();
        let mut input = account();
        input["fallbackBudget"] = 19.into();
        let saved = write(&mut db, command(input.clone()), &client()).unwrap();
        assert_eq!(saved["tokensAdded"], 20);
        assert_eq!(saved["state"], "exhausted");
        let duplicate = write(&mut db, command(input.clone()), &client()).unwrap();
        assert_eq!(duplicate["replayed"], true);
        assert_eq!(duplicate["tokensAdded"], 0);
        assert_eq!(duplicate["tokensUsed"], 20);

        let row = read(&mut db, scope()).unwrap();
        assert_eq!(row["state"], "exhausted");
        let earlier: String = db
            .query_row(
                "SELECT record_json FROM durable_entries WHERE store_id=? AND id=3",
                [&store],
                |result| result.get(0),
            )
            .unwrap();
        db.execute("INSERT INTO durable_entries(store_id,id,conversation_id,kind,by_task_id,commit_seq,record_json)
            VALUES (?1,4,1,'pi.assistant',2,5,?2)", params![store, earlier]).unwrap();
        let mut restart = claim_command(&row, "manual", "continued");
        restart["sourceEntryId"] = 4.into();
        let manual = write(&mut db, command(restart), &client()).unwrap();
        assert_eq!(manual["requestId"], "goal-continuation:goal-work:1:1");
        assert_eq!(manual["tokensUsed"], 0);
        let late = write(&mut db, command(input.clone()), &client()).unwrap();
        assert_eq!(late["replayed"], true);
        assert_eq!(late["tokensUsed"], 0);
        let mut late_first_observation = input.clone();
        late_first_observation["entryId"] = 4.into();
        assert_eq!(
            write(&mut db, command(late_first_observation), &client()).unwrap(),
            json!({"status":"ignored","reason":"older_budget_window"})
        );
        assert_eq!(read(&mut db, scope()).unwrap()["tokensUsed"], 0);

        input["hostGeneration"] = "prior-host".into();
        assert_eq!(
            write(&mut db, command(input.clone()), &client()).unwrap()["code"],
            "host_fenced"
        );
        input["hostGeneration"] = HOST.into();
        input["userId"] = "other-user".into();
        assert_eq!(
            write(&mut db, command(input), &client()).unwrap()["code"],
            "scope_changed"
        );
    }

    #[test]
    fn a_claim_cannot_join_a_busy_conversation_or_reuse_authority_after_owner_change() {
        let (mut db, store) = fixture();
        let row = read(&mut db, scope()).unwrap();
        let request = claim_command(&row, "first-claim", "settled");
        db.execute("INSERT INTO durable_tasks(store_id,id,conversation_id,kind,status,commit_seq,record_json)
            VALUES (?1,2,1,'pi.generation','running',5,'{}')", [&store]).unwrap();
        assert_eq!(
            write(&mut db, command(request.clone()), &client()).unwrap()["code"],
            "conversation_busy"
        );
        db.execute(
            "UPDATE durable_tasks SET status='terminal' WHERE store_id=? AND id=2",
            [&store],
        )
        .unwrap();
        let first = write(&mut db, command(request.clone()), &client()).unwrap();
        assert_eq!(first["status"], "claimed");
        assert_eq!(first["attemptSerial"], 1);
        let replay = write(&mut db, command(request.clone()), &client()).unwrap();
        assert_eq!(replay["requestId"], first["requestId"]);
        assert_eq!(replay["replayed"], true);
        let mut competing = request.clone();
        competing["operationId"] = "competing-claim".into();
        assert_eq!(
            write(&mut db, command(competing), &client()).unwrap()["code"],
            "stale_ledger"
        );

        let report = json!({"kind":"reportAttempt","userId":"limited-user","taskId":"goal-task","workId":"goal-work",
            "operationId":"late-attempt","claimOperationId":"first-claim","hostGeneration":HOST,"storeId":store,"outcome":"settled",
            "progressFingerprint":FINGERPRINT});
        assert_eq!(
            write(&mut db, command(report.clone()), &client()).unwrap()["code"],
            "submission_missing"
        );
        db.execute("INSERT INTO durable_submissions(store_id,id,conversation_id,status,commit_seq,record_json)
            VALUES (?1,6,1,'done',6,'{\"type\":\"input\"}')", [&store]).unwrap();
        db.execute(
            "INSERT INTO durable_request_keys VALUES (?1,1,?2,6)",
            params![store, first["requestId"].as_str().unwrap()],
        )
        .unwrap();
        let completed = write(&mut db, command(report.clone()), &client()).unwrap();
        assert_eq!(completed["state"], "idle");
        assert_eq!(completed["progressStalls"], 1);
        assert_eq!(
            write(&mut db, command(report.clone()), &client()).unwrap()["replayed"],
            true
        );

        db.execute_batch(
            "UPDATE works SET owner_epoch=2 WHERE work_id='goal-work';
            UPDATE conversation_goal_continuations SET state='igniting' WHERE work_id='goal-work';",
        )
        .unwrap();
        let mut stale = report;
        stale["operationId"] = "stale-epoch-settle".into();
        assert_eq!(
            write(&mut db, command(stale), &client()).unwrap()["code"],
            "stale_attempt"
        );
        assert_eq!(read(&mut db, scope()).unwrap()["state"], "igniting");
    }

    #[test]
    fn ongoing_authority_detects_old_attempt_even_if_the_pi_run_is_still_live() {
        let (mut db, store) = fixture();
        let row = read(&mut db, scope()).unwrap();
        let claim = write(
            &mut db,
            command(claim_command(&row, "active-attempt", "settled")),
            &client(),
        )
        .unwrap();
        let mut batch = claimed_batch(&claim);
        batch.push(
            json!({"type":"document.create","record":{"id":10,"kind":"pi.live",
            "scope":{"kind":"conversation","conversationId":1},"history":"latest","fork":"initial"},
            "content":{"kind":"base","version":3,"value":{"run":{"taskId":11,"inputs":[5]}}}}),
        );
        assert_eq!(
            pi_placement(&mut db, &store, "place-active", &batch)["stored"],
            1
        );
        let core_generation = crate::business_protocol::current_core_generation();
        db.execute(
            "UPDATE core_pi_hosts SET core_generation=?1 WHERE host_generation=?2",
            params![core_generation, HOST],
        )
        .unwrap();
        let request = json!({"kind":"activeClaim","userId":"limited-user","taskId":"goal-task","workId":"goal-work",
            "storeId":store,"hostGeneration":HOST,"conversationId":1,"runTaskId":11});
        let validate = |db: &mut Connection| {
            read_request(db, serde_json::from_value(request.clone()).unwrap()).unwrap()
        };
        assert_eq!(validate(&mut db)["status"], "current");
        db.execute_batch(
            "UPDATE works SET state_version=state_version+1 WHERE work_id='goal-work';",
        )
        .unwrap();
        assert_eq!(validate(&mut db)["status"], "current");
        db.execute_batch(
            "UPDATE conversation_goal_continuations SET state='deferred',defer_reason='restart'
            WHERE work_id='goal-work';",
        )
        .unwrap();
        assert_eq!(validate(&mut db)["status"], "stale");

        let mut user = input_batch(&json!("new-foreground"), 12, 13, None);
        user.push(
            json!({"type":"document.change","id":10,"content":{"kind":"base","version":3,
            "value":{"run":{"taskId":11,"inputs":[5,13]}}}}),
        );
        assert_eq!(
            pi_placement(&mut db, &store, "place-user-steer", &user)["stored"],
            1
        );
        assert_eq!(validate(&mut db)["status"], "mixed");
        let next = json!({"type":"document.change","id":10,"content":{"kind":"base","version":3,
            "value":{"run":{"taskId":11,"inputs":[13]}}}});
        assert_eq!(
            pi_placement(&mut db, &store, "new-run-authority", &[next])["stored"],
            1
        );
        assert_eq!(validate(&mut db)["status"], "ordinary");
    }

    fn pi_placement(db: &mut Connection, store: &str, id: &str, writes: &[Value]) -> Value {
        let invoke: crate::pi_storage::Invocation =
            serde_json::from_value(json!({"action":"commit","storeId":store,
            "writerEpoch":1,"hostGeneration":HOST,"operationId":id,"batches":[writes]}))
            .unwrap();
        let reply = invoke.execute(db).unwrap();
        assert_eq!(reply["ok"], true);
        reply["data"].clone()
    }

    fn input_batch(
        request: &Value,
        entry: i64,
        submission: i64,
        marker: Option<Value>,
    ) -> Vec<Value> {
        let mut input = json!({"inputRequestId":request});
        if let Some(marker) = marker {
            input["goalContinuation"] = marker;
        }
        vec![
            json!({"type":"entry","value":{"id":entry,"conversationId":1,"kind":"mybuddy.user","data":{"mybuddyInput":input}}}),
            json!({"type":"submission","value":{"id":submission,"conversationId":1,"type":"input","status":"placed","entry":entry,"requestId":request}}),
        ]
    }

    fn claimed_batch(claim: &Value) -> Vec<Value> {
        input_batch(
            &claim["requestId"],
            4,
            5,
            Some(json!({"taskId":claim["taskId"],"workId":claim["workId"],
            "intentRevision":claim["intentRevision"],"ownerEpoch":claim["ownerEpoch"],"attempt":claim["attempt"],
            "attemptSerial":claim["attemptSerial"],"claimOperationId":claim["operationId"]})),
        )
    }

    #[test]
    fn pi_store_places_the_claim_once_and_preserves_a_user_input_that_wins_the_race() {
        let (mut db, store) = fixture();
        let row = read(&mut db, scope()).unwrap();
        let claim = write(
            &mut db,
            command(claim_command(&row, "claim-winner", "settled")),
            &client(),
        )
        .unwrap();
        let goal = claimed_batch(&claim);
        let mut forged = goal.clone();
        forged[0]["value"]["data"]["mybuddyInput"]["goalContinuation"]["claimOperationId"] =
            "fake-claim".into();
        assert_eq!(pi_placement(&mut db, &store, "forge", &forged)["stored"], 0);
        let placed = pi_placement(&mut db, &store, "place", &goal);
        assert_eq!(placed["stored"], 1);
        assert_eq!(pi_placement(&mut db, &store, "place", &goal), placed);
        assert_eq!(
            pi_placement(&mut db, &store, "duplicate", &goal)["stored"],
            0
        );
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM durable_request_keys WHERE store_id=?1 AND request_id=?2",
                params![store, claim["requestId"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let (mut db, store) = fixture();
        let row = read(&mut db, scope()).unwrap();
        let claim = write(
            &mut db,
            command(claim_command(&row, "claim-loser", "settled")),
            &client(),
        )
        .unwrap();
        let ordinary = input_batch(&json!("ordinary-user"), 6, 7, None);
        assert_eq!(
            pi_placement(&mut db, &store, "user-wins", &ordinary)["stored"],
            1
        );
        let refused = pi_placement(&mut db, &store, "stale-goal", &claimed_batch(&claim));
        assert_eq!(refused["stored"], 0);
        assert_eq!(refused["refused"], "原目标或会话已变化，请重新发起目标续跑");
        let (request, count): (String, i64) = db
            .query_row(
                "SELECT min(request_id),count(*) FROM durable_request_keys WHERE store_id=?",
                [&store],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((request.as_str(), count), ("ordinary-user", 1));

        let marker = &claimed_batch(&claim)[0]["value"]["data"]["mybuddyInput"]["goalContinuation"];
        let inherited = json!({"type":"entry","value":{"id":8,"conversationId":1,"kind":"mybuddy.user",
            "data":{"inherited":true,"sourceEntryId":"4","mybuddyInput":{"goalContinuation":marker}}}});
        assert_eq!(
            pi_placement(&mut db, &store, "branch-history", &[inherited])["stored"],
            1
        );
    }
}
