use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const ENTRY_KIND: &str = "mybuddy.dots-assistant-reply";
pub const REVOKED: &str = "DOTS_OUTBOX_WRITE_REVOKED";

// Pi Storage escapes this valid Unicode marker as well as isolated JS surrogates.
fn decode_pi_text(value: Value) -> Value {
    match value {
        Value::String(text) => json!(text.replace("\u{e000}\u{e000}", "\u{e000}")),
        Value::Array(items) => Value::Array(items.into_iter().map(decode_pi_text).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| {
                    (
                        key.replace("\u{e000}\u{e000}", "\u{e000}"),
                        decode_pi_text(value),
                    )
                })
                .collect(),
        ),
        other => other,
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Pending {
        after_key: Option<String>,
        limit: i64,
    },
    Latest {
        task_id: String,
        space_ids: Option<Vec<String>>,
    },
    Report {
        operation_id: String,
        delivery_key: String,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Prepare {
        event_key: String,
        expected_snapshot: String,
        reply: Value,
    },
    Inspect {
        event_key: String,
    },
}

impl Command {
    pub fn event_key(&self) -> &str {
        match self {
            Self::Prepare { event_key, .. } | Self::Inspect { event_key } => event_key,
        }
    }
}

struct Event {
    key: String,
    operation: String,
    task: String,
    status: String,
    interaction: Option<String>,
    snapshot: String,
    reply: Option<Value>,
    settled: bool,
}

enum Disposition {
    Active,
    Hold,
    Obsolete,
}

fn event(db: &Connection, key: &str) -> Result<Option<Event>> {
    let row = db.query_row("SELECT operation_id,task_id,status,interaction_id,snapshot,reply,settled FROM dots_reply_events WHERE event_key=?",
        [key], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get::<_, Option<String>>(5)?,r.get::<_, i64>(6)?))).optional()?;
    let Some((operation, task, status, interaction, snapshot, reply, settled)) = row else {
        return Ok(None);
    };
    Ok(Some(Event {
        key: key.into(),
        operation,
        task,
        status,
        interaction,
        snapshot,
        reply: reply.map(|raw| serde_json::from_str(&raw)).transpose()?,
        settled: settled != 0,
    }))
}

fn disposition(db: &Connection, event: &Event) -> Result<Disposition> {
    let row: Option<(String, Option<String>, Option<String>, String, Option<String>, Option<String>, bool, bool, bool)> = db.query_row(
        "WITH RECURSIVE ancestors(id,parent_id,archived) AS (
            SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN tasks t ON s.id=t.space_id WHERE t.id=?1
            UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN ancestors a ON s.id=a.parent_id
        )
        SELECT d.status,d.interaction_id,c.state,d.text,w.lifecycle,w.closure_conclusion,
            EXISTS(SELECT 1 FROM dots_proactive_pauses p WHERE p.scope IN ('',coalesce(d.space_id,''))),
            EXISTS(SELECT 1 FROM dots_delegations newer WHERE newer.task_id=d.task_id AND newer.seq>d.seq
                AND newer.supersedes=1 AND newer.status<>'superseded'),
            EXISTS(SELECT 1 FROM dots_followup_plans p WHERE p.operation_id=d.operation_id
                AND try_cast(json_extract_string(p.plan,'$.request.dotsGoalIntentRevision') AS BIGINT)<>w.intent_revision)
        FROM dots_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
        LEFT JOIN dots_target_controls c ON c.task_id=d.task_id LEFT JOIN works w ON w.work_id=d.goal_id
        WHERE d.task_id=?1 AND d.operation_id=?2 AND t.archived=0 AND NOT EXISTS(SELECT 1 FROM ancestors WHERE archived<>0)
          AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state x WHERE x.task_id=t.id AND x.state='trashed')
          AND t.space_id IS NOT DISTINCT FROM d.space_id AND s.path IS NOT DISTINCT FROM d.space_path
          AND (t.cwd IS NOT DISTINCT FROM d.cwd OR (d.cwd IS NULL AND t.cwd IS NOT DISTINCT FROM d.space_path))",
        params![event.task,event.operation], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?)),
    ).optional()?;
    let Some((status, interaction, control, text, lifecycle, closure, paused, replaced, revised)) =
        row
    else {
        return Ok(Disposition::Obsolete);
    };
    let expected = if matches!(event.status.as_str(), "activity" | "sample") {
        "running"
    } else {
        &event.status
    };
    if control.as_deref() == Some("stopped")
        || replaced
        || revised
        || status != expected
        || interaction != event.interaction
        || lifecycle.as_deref() == Some("closed") && closure.as_deref() != Some("succeeded")
    {
        return Ok(Disposition::Obsolete);
    }
    if event.status == "running" && serde_json::from_str::<Value>(&event.snapshot)?["text"] != text
    {
        return Ok(Disposition::Obsolete);
    }
    if matches!(event.status.as_str(), "activity" | "sample" | "running") {
        let revoked: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM answer_rule_turns t JOIN dots_delegations d ON d.source_message_id=t.input_id
            WHERE d.operation_id=? AND t.task_id='mybuddy-dots' AND t.status='revoked')", [&event.operation], |row| row.get(0))?;
        if revoked {
            return Ok(Disposition::Obsolete);
        }
    }
    if event.status == "blocked"
        && let Some(interaction) = event.interaction.as_deref()
    {
        let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM conversation_interactions WHERE id=? AND task_id=? AND status='pending')",
            params![interaction,event.task], |row| row.get(0))?;
        if !pending {
            return Ok(Disposition::Obsolete);
        }
    }
    let held =
        paused || control.as_deref() == Some("paused") || lifecycle.as_deref() == Some("paused");
    if event.status == "sample" && newer_sample_waiting(db, &event.key)? {
        return Ok(Disposition::Obsolete);
    }
    if event.status == "activity" {
        if held {
            return Ok(Disposition::Obsolete);
        }
        let snapshot: Value = serde_json::from_str(&event.snapshot)?;
        let activity = &snapshot["activity"];
        let latest: Option<(i64, String, String, Option<i64>)> = db
            .query_row(
                "SELECT a.\"at\",a.tool,a.phase,
            (SELECT max(p.\"at\") FROM dots_verified_progress p WHERE p.operation_id=a.operation_id)
            FROM dots_tool_observations a WHERE a.operation_id=?",
                [&event.operation],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if !latest.is_some_and(|(at, tool, phase, progress)| {
            activity["lastActivityAt"] == at
                && activity["tool"] == tool
                && activity["phase"] == phase
                && activity["lastProgressAt"].as_i64() == progress
        }) {
            return Ok(Disposition::Obsolete);
        }
    }
    Ok(if held {
        Disposition::Hold
    } else {
        Disposition::Active
    })
}

fn original_destination(db: &Connection, source: &str) -> Result<(String, Value)> {
    if let Some(id) = source
        .strip_prefix("cron-")
        .and_then(|s| s.strip_suffix("-input"))
        && id.len() == 36
        && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
    {
        let timer: Option<(String, i64, i64)> = db
            .query_row(
                "SELECT o.source,o.conversation,o.entry FROM cron_runs r
            JOIN dots_schedule_origins o ON o.job_id=r.job_id WHERE r.id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((source, conversation, entry)) = timer {
            return Ok((
                source,
                json!({"conversationId":conversation,"entryId":entry}),
            ));
        }
    }
    let origin: Option<(i64, i64)> = db
        .query_row(
            "SELECT conversation,entry FROM dots_reply_origins WHERE source=?",
            [source],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok((
        source.into(),
        origin.map_or(
            Value::Null,
            |(conversation, entry)| json!({"conversationId":conversation,"entryId":entry}),
        ),
    ))
}

fn valid_reply(db: &Connection, event: &Event, reply: &Value) -> Result<bool> {
    if reply["operationId"] != event.operation
        || reply["taskId"] != event.task
        || !reply["artifacts"].is_array()
        || !reply["text"].is_string()
        || !reply["title"].is_string()
        || reply.get("deliveredAt").is_some()
        || reply.get("dotsOutboxEventKey").is_some()
    {
        return Ok(false);
    }
    let kind = reply["kind"].as_str();
    let allowed_kind = match event.status.as_str() {
        "running" | "sample" | "activity" => kind == Some("progress"),
        "blocked" => matches!(kind, Some("question" | "conclusion")),
        "completed" | "failed" => matches!(kind, Some("conclusion" | "question" | "progress")),
        _ => false,
    };
    if !allowed_kind {
        return Ok(false);
    }
    let source: String = db.query_row(
        "SELECT source_message_id FROM dots_delegations WHERE operation_id=? AND task_id=?",
        params![event.operation, event.task],
        |r| r.get(0),
    )?;
    if reply["completion"].is_null() {
        let (source, origin) = original_destination(db, &source)?;
        return Ok(reply["deliveryKey"] == event.key
            && reply["sourceMessageId"] == source
            && reply["origin"] == origin);
    }
    if kind != Some("conclusion") {
        return Ok(false);
    }
    let id = format!("dots-goal-close:{}", event.operation);
    let row: Option<(String,i64,i64,Option<String>,i64,String)> = db.query_row("SELECT w.work_id,w.intent_revision,w.owner_epoch,w.input_snapshot_id,
          try_cast(json_extract_string(r.result_snapshot_json,'$.stateVersion') AS BIGINT),
          CAST(json_extract(r.result_snapshot_json,'$._controlResult.dotsGoalCompletion') AS VARCHAR)
        FROM dots_delegations d JOIN works w ON w.work_id=d.goal_id
        JOIN work_operation_receipts r ON r.work_id=w.work_id AND r.user_id=w.user_id AND r.operation_id=w.close_operation_id
          AND r.operation_type='closeWork'
        WHERE d.task_id=? AND d.operation_id=? AND w.close_operation_id=? AND w.lifecycle='closed' AND w.closure_conclusion='succeeded'
          AND json_extract(r.result_snapshot_json,'$._controlResult.dotsGoalCompletion') IS NOT NULL",
        params![event.task,event.operation,id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let Some((work, intent, owner, input, state, packet)) = row else {
        return Ok(false);
    };
    let packet: Value = serde_json::from_str(&packet)?;
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([event.task, id, state]))?)
    );
    Ok(packet["id"] == id
        && packet["taskId"] == event.task
        && packet["operationId"] == event.operation
        && packet["sourceMessageId"] == source
        && packet["workId"] == work
        && packet["intentRevision"] == intent
        && packet["ownerEpoch"] == owner
        && packet["inputSnapshotId"] == json!(input)
        && packet["stateVersion"] == state
        && reply["deliveryKey"] == key
        && reply["completion"]
            == json!({"id":id,"workId":work,"intentRevision":intent,"stateVersion":state})
        && reply["sourceMessageId"] == packet["destination"]["sourceMessageId"]
        && reply["origin"] == packet["destination"]["origin"]
        && reply["text"] == packet["text"]
        && reply["artifacts"] == packet["artifacts"])
}

fn dots_store(db: &Connection) -> Result<Option<String>> {
    let directory: Option<String> = db.query_row("SELECT directory FROM durable_bot_bindings WHERE task_id='mybuddy-dots' AND backend='pi-durable'",
        [], |r| r.get(0)).optional()?;
    Ok(directory.map(|path| crate::durable::store_id_for_path(Path::new(&path))))
}

pub fn commit_is_current(db: &Connection, store: &str, key: &str, record: &Value) -> Result<bool> {
    let Some(event) = event(db, key)? else {
        return Ok(false);
    };
    let Some(reply) = event.reply.as_ref() else {
        return Ok(false);
    };
    if event.settled
        || !matches!(disposition(db, &event)?, Disposition::Active)
        || !valid_reply(db, &event, reply)?
        || dots_store(db)?.as_deref() != Some(store)
    {
        return Ok(false);
    }
    let Some(mut data) = record["data"].as_object().cloned() else {
        return Ok(false);
    };
    let delivered_at = data.remove("deliveredAt").and_then(|value| value.as_i64());
    data.remove("dotsOutboxEventKey");
    if delivered_at.is_none_or(|at| at <= 0)
        || !matches_report(db, reply, &decode_pi_text(Value::Object(data)))?
    {
        return Ok(false);
    }
    if let Some(origin) = reply["origin"].as_object()
        && origin.get("conversationId") != record.get("conversationId")
    {
        return Ok(false);
    }
    let Some(conversation) = record["conversationId"].as_i64() else {
        return Ok(false);
    };
    let source = reply["sourceMessageId"]
        .as_str()
        .unwrap_or_default()
        .replace("\u{e000}", "\u{e000}\u{e000}");
    let input_entry: Option<i64> = db.query_row("SELECT try_cast(json_extract_string(record_json,'$.entry') AS BIGINT)
        FROM durable_submissions WHERE store_id=? AND conversation_id=? AND request_id=? AND status IN ('done','unanswered')
          AND json_extract_string(record_json,'$.type')='input'
          AND coalesce(json_extract_string(record_json,'$.reason'),'') NOT IN ('aborted','reset')",
        params![store,conversation,source], |row| row.get(0)).optional()?.flatten();
    let Some(input_entry) = input_entry else {
        return Ok(false);
    };
    if !reply["origin"].is_null() && reply["origin"]["entryId"] != input_entry {
        return Ok(false);
    }
    let source_valid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM durable_entries WHERE store_id=? AND id=? AND conversation_id=?
          AND kind='mybuddy.user' AND json_extract_string(record_json,'$.data.mybuddyInput.inputRequestId')=?)",
        params![store,input_entry,conversation,source], |row| row.get(0))?;
    Ok(source_valid
        && crate::pi_storage::dots_delivery_entry(
            db,
            store,
            reply["deliveryKey"].as_str().unwrap_or_default(),
        )?
        .is_none())
}

fn commit_record(db: &Connection, store: &str, reply: &Value) -> Result<Option<Value>> {
    let Some(key) = reply["deliveryKey"].as_str() else {
        return Ok(None);
    };
    let Some(record) = crate::pi_storage::dots_delivery_entry(db, store, key)?.map(decode_pi_text)
    else {
        return Ok(None);
    };
    let mut actual = record["data"]
        .as_object()
        .cloned()
        .ok_or("Missing Dots reply body")?;
    let at = actual
        .remove("deliveredAt")
        .and_then(|value| value.as_i64());
    actual.remove("dotsOutboxEventKey");
    if at.is_none_or(|at| at <= 0)
        || !matches_report(db, reply, &Value::Object(actual))?
        || (!reply["origin"].is_null()
            && record["conversationId"] != reply["origin"]["conversationId"])
    {
        return Err("Dots 已提交回执与待发送结果不一致".into());
    }
    Ok(Some(record))
}

fn matches_report(db: &Connection, prepared: &Value, actual: &Value) -> Result<bool> {
    if prepared == actual {
        return Ok(true);
    }
    if !prepared["completion"].is_null() || actual["presentation"] != "report" {
        return Ok(false);
    }
    let text: Option<String> = db
        .query_row(
            "SELECT text FROM dots_report_text WHERE delivery_key=? AND operation_id=?",
            params![
                prepared["deliveryKey"].as_str(),
                prepared["operationId"].as_str()
            ],
            |row| row.get(0),
        )
        .optional()?;
    let Some(text) = text else {
        return Ok(false);
    };
    let mut rendered = prepared.clone();
    rendered["text"] = json!(text);
    rendered["presentation"] = json!("report");
    Ok(&rendered == actual)
}

fn newer_sample_waiting(db: &Connection, key: &str) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM dots_reply_events old JOIN dots_reply_events newer ON newer.operation_id=old.operation_id
        AND newer.rowid>old.rowid WHERE old.event_key=? AND newer.status='sample' AND newer.settled=0
          AND NOT EXISTS(SELECT 1 FROM dots_report_text WHERE delivery_key=old.event_key))", [key], |row| row.get(0))?)
}

fn short_summary(text: &str) -> String {
    let text = text.trim();
    if text.encode_utf16().count() <= 560 {
        return text.to_string();
    }
    let mut length = 0;
    let prefix: String = text
        .chars()
        .take_while(|ch| {
            length += ch.len_utf16();
            length <= 559
        })
        .collect();
    format!("{}…", prefix.trim_end())
}

fn settle(db: &Connection, event: &Event, record: Option<&Value>) -> Result<()> {
    let snapshot = match record {
        Some(record) => {
            let reply = &record["data"];
            let old = serde_json::from_str::<Value>(&event.snapshot)?;
            let mut snapshot = json!({"delivered":reply["kind"],"deliveryKey":reply["deliveryKey"],"deliveredAt":reply["deliveredAt"]});
            if !reply["completion"].is_null() {
                snapshot["completion"] = reply["completion"].clone();
            }
            if reply["kind"] == "conclusion"
                || matches!(event.status.as_str(), "completed" | "failed")
            {
                let text = reply["text"].as_str().unwrap_or_default();
                if reply["kind"] == "conclusion" {
                    snapshot["sourceConclusion"] = json!(short_summary(
                        event
                            .reply
                            .as_ref()
                            .and_then(|value| value["text"].as_str())
                            .unwrap_or(text)
                    ));
                }
                snapshot["summary"] = json!(short_summary(text));
                snapshot["fileCount"] = json!(reply["artifacts"].as_array().map_or(0, Vec::len));
            }
            if event.status == "sample" {
                snapshot["sampleFingerprint"] = old
                    .get("sampleFingerprint")
                    .cloned()
                    .unwrap_or_else(|| json!(event.key));
            }
            if event.status == "activity" {
                db.execute(
                    "UPDATE dots_tool_observations SET last_report_at=?1 WHERE operation_id=?2",
                    params![reply["deliveredAt"].as_i64(), event.operation],
                )?;
            }
            serde_json::to_string(&snapshot)?
        }
        None => String::new(),
    };
    db.execute("UPDATE dots_reply_events SET settled=1,reply=NULL,snapshot=? WHERE event_key=? AND settled=0", params![snapshot,event.key])?;
    if matches!(event.status.as_str(), "completed" | "failed") {
        db.execute(
            "DELETE FROM dots_followup_requests WHERE operation_id=?",
            [&event.operation],
        )?;
    }
    Ok(())
}

pub fn finish_commit(db: &Connection, store: &str, key: &str, entry_id: i64) -> Result<()> {
    let event = event(db, key)?.ok_or("Missing Dots outbox event")?;
    let reply = event.reply.as_ref().ok_or("Missing prepared Dots reply")?;
    let record = commit_record(db, store, reply)?.ok_or("Missing Dots conversation receipt")?;
    if record["id"] != entry_id {
        return Err("Dots conversation receipt points to another entry".into());
    }
    settle(db, &event, Some(&record))
}

pub fn write(db: &mut Connection, command: Command) -> Result<Value> {
    let tx = db.transaction()?;
    let Some(event) = event(&tx, command.event_key())? else {
        return Ok(json!({"status":"missing"}));
    };
    let result = if event.settled {
        json!({"status":"settled"})
    } else {
        match command {
            Command::Prepare {
                expected_snapshot,
                reply,
                ..
            } => {
                if event.snapshot != expected_snapshot {
                    json!({"status":"stale"})
                } else if let Some(prior) = event.reply.as_ref() {
                    json!({"status":"prepared","reply":prior})
                } else if !matches!(disposition(&tx, &event)?, Disposition::Active) {
                    json!({"status":"stale"})
                } else if !valid_reply(&tx, &event, &reply)? {
                    json!({"status":"invalid"})
                } else {
                    tx.execute("UPDATE dots_reply_events SET reply=? WHERE event_key=? AND settled=0 AND reply IS NULL",
                    params![serde_json::to_string(&reply)?,event.key])?;
                    json!({"status":"prepared","reply":reply})
                }
            }
            Command::Inspect { .. } => {
                if let Some(reply) = event.reply.as_ref() {
                    let record = match dots_store(&tx)? {
                        Some(store) => commit_record(&tx, &store, &reply)?,
                        None => None,
                    };
                    if let Some(record) = record {
                        settle(&tx, &event, Some(&record))?;
                        json!({"status":"settled"})
                    } else {
                        match disposition(&tx, &event)? {
                            Disposition::Active if valid_reply(&tx, &event, &reply)? => {
                                json!({"status":"prepared","reply":reply})
                            }
                            Disposition::Hold => json!({"status":"held"}),
                            Disposition::Obsolete => {
                                settle(&tx, &event, None)?;
                                json!({"status":"stale"})
                            }
                            Disposition::Active => json!({"status":"invalid"}),
                        }
                    }
                } else {
                    json!({"status":"missing"})
                }
            }
        }
    };
    crate::request_control::commit(tx)?;
    Ok(result)
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Report {
            operation_id,
            delivery_key,
        } => {
            let plan: Option<String> = db
                .query_row(
                    "SELECT plan FROM dots_followup_plans WHERE operation_id=?",
                    [&operation_id],
                    |row| row.get(0),
                )
                .optional()?;
            let plan = plan
                .map(|raw| serde_json::from_str::<Value>(&raw))
                .transpose()?
                .unwrap_or(Value::Null);
            let saved: Option<String> = db
                .query_row(
                    "SELECT text FROM dots_report_text WHERE operation_id=? AND delivery_key=?",
                    params![operation_id, delivery_key],
                    |row| row.get(0),
                )
                .optional()?;
            let previous: Option<String> = if saved.is_some() {
                None
            } else {
                db.query_row("SELECT text FROM dots_report_text WHERE operation_id=? AND text<>'' ORDER BY rowid DESC LIMIT 1",
                [&operation_id], |row| row.get(0)).optional()?
            };
            Ok(
                json!({"goal":plan["goal"],"format":plan["deliveryInstruction"],"saved":saved,"previous":previous,"newerSample":newer_sample_waiting(db,&delivery_key)?}),
            )
        }
        Query::Pending { after_key, limit } => {
            let size = limit.clamp(1, 256) as usize;
            let mut stmt = db.prepare("SELECT event_key,task_id FROM dots_reply_events
                WHERE settled=0 AND reply IS NOT NULL AND (?1 IS NULL OR event_key>?1) ORDER BY event_key LIMIT ?2")?;
            let mut rows = stmt.query(params![after_key, size + 1])?;
            let mut values = Vec::new();
            let mut last = None;
            while let Some(row) = rows.next()? {
                if values.len() == size {
                    return Ok(json!({"rows":values,"nextKey":last}));
                }
                let key: String = row.get(0)?;
                values.push(json!({"eventKey":key,"taskId":row.get::<_, String>(1)?}));
                last = Some(key);
            }
            Ok(json!({"rows":values,"nextKey":null}))
        }
        Query::Latest { task_id, space_ids } => {
            let spaces = space_ids
                .map(|ids| serde_json::to_string(&ids))
                .transpose()?;
            let row: Option<(String,String,String)> = db.query_row("WITH RECURSIVE ancestors(id,parent_id,archived) AS (
                    SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN tasks t ON s.id=t.space_id WHERE t.id=?1
                    UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN ancestors a ON s.id=a.parent_id
                )
                SELECT d.operation_id,d.source_message_id,json_extract_string(e.snapshot,'$.deliveryKey')
                FROM dots_delegations d JOIN dots_reply_events e ON e.operation_id=d.operation_id AND e.task_id=d.task_id
                JOIN tasks t ON t.id=d.task_id WHERE d.task_id=?1 AND t.id<>'mybuddy-dots' AND t.archived=0 AND e.settled=1
                AND NOT EXISTS(SELECT 1 FROM ancestors WHERE archived<>0)
                AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
                AND (?2 IS NULL OR t.space_id IN (SELECT json_extract_string(value,'$') FROM json_each(?2)))
                AND CASE WHEN json_valid(e.snapshot) THEN json_extract_string(e.snapshot,'$.delivered')='conclusion'
                    AND json_extract_string(e.snapshot,'$.deliveryKey') IS NOT NULL ELSE false END
                ORDER BY try_cast(json_extract_string(e.snapshot,'$.deliveredAt') AS BIGINT) DESC,d.seq DESC,e.event_key DESC LIMIT 1",
                params![task_id,spaces], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let Some((operation, source, key)) = row else {
                return Ok(Value::Null);
            };
            let Some(store) = dots_store(db)? else {
                return Ok(Value::Null);
            };
            let Some(record) =
                crate::pi_storage::dots_delivery_entry(db, &store, &key)?.map(decode_pi_text)
            else {
                return Ok(Value::Null);
            };
            let reply = &record["data"];
            if reply["operationId"] != operation
                || reply["taskId"] != task_id
                || reply["kind"] != "conclusion"
            {
                return Ok(Value::Null);
            }
            let source = if reply["completion"].is_null() {
                &source
            } else {
                reply["sourceMessageId"].as_str().unwrap_or_default()
            };
            let (source, origin) = original_destination(db, source)?;
            if reply["sourceMessageId"] != source || reply["origin"] != origin {
                return Ok(Value::Null);
            }
            let artifacts = reply["artifacts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|file| file["saved"].is_object())
                .collect::<Vec<_>>();
            Ok(json!({"deliveryKey":key,"operationId":operation,"artifacts":artifacts}))
        }
    }
}
