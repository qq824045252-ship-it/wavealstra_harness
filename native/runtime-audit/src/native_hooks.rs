use crate::resource_gate::ResourceKey;
use duckdb::{Connection, OptionalExt, Params, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    id: String,
    revision: i64,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSource {
    task: String,
    conversation: String,
    generation: i64,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    List,
    Find {
        id: String,
    },
    Candidates {
        event: String,
    },
    ToolCandidates {
        tool: String,
    },
    Versions {
        versions: Vec<Version>,
    },
    Improvement {
        id: String,
        revision: i64,
        sources: Vec<FeedbackSource>,
    },
    ChildReview {
        task_id: String,
        conversation_id: String,
    },
    GenerationReceipts {
        task_id: String,
        conversation_id: String,
        task_ids: Vec<i64>,
    },
    NestedFeedback {
        task_id: String,
        conversation_id: String,
        parent_task_id: i64,
    },
    FinishAttempts {
        task_id: String,
        conversation_id: String,
        run_key: String,
    },
    Receipts {
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    id: String,
    revision: i64,
    event: String,
    task_id: String,
    conversation_id: String,
    native_task_id: i64,
    actor: String,
    tool: String,
    call_id: String,
    at: i64,
    outcome: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Readback {
    input_entry: i64,
    observed: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Publish {
        id: String,
        expected_generation: Option<i64>,
        managed: bool,
        draft_json: String,
    },
    Activate {
        id: String,
        generation: i64,
        revision: i64,
        enabled: bool,
    },
    Record {
        receipt: Receipt,
        run_key: String,
        parent_task_id: Option<i64>,
        readback: Option<Readback>,
    },
}

impl Mutation {
    pub fn resource(&self) -> ResourceKey {
        match self {
            Self::Publish { id, .. } | Self::Activate { id, .. } => {
                ResourceKey::Entity("native-hook".into(), id.clone())
            }
            Self::Record { receipt, .. } => ResourceKey::Entity(
                "native-hook-session".into(),
                json!([
                    receipt.id,
                    receipt.revision,
                    receipt.task_id,
                    receipt.conversation_id
                ])
                .to_string(),
            ),
        }
    }
}

fn rows(db: &Connection, sql: &str, bindings: impl Params) -> crate::Result<Vec<Value>> {
    let mut stmt = db.prepare(sql)?;
    let mut cursor = stmt.query(bindings)?;
    let columns = cursor
        .as_ref()
        .ok_or("missing Hook columns")?
        .column_names();
    let mut result = Vec::new();
    while let Some(row) = cursor.next()? {
        let mut item = Map::new();
        for (index, column) in columns.iter().enumerate() {
            let value = crate::database::value_ref_to_json(row.get_ref(index)?)?;
            item.insert(column.clone(), value);
        }
        result.push(Value::Object(item));
    }
    Ok(result)
}

fn decode_draft(mut row: Value) -> crate::Result<Value> {
    let draft: Value = serde_json::from_str(row["draft"].as_str().ok_or("missing Hook draft")?)?;
    row["draft"] = draft;
    Ok(row)
}

const ACTIVE_HOOKS: &str = "
    SELECT h.id, h.revision, h.generation, h.enabled <> 0 AS enabled, v.draft, v.hash,
      CAST((SELECT to_json(list(r.revision ORDER BY r.revision DESC))
            FROM native_hook_versions r WHERE r.id = h.id) AS VARCHAR) AS versions
    FROM native_hooks h JOIN native_hook_versions v ON v.id = h.id AND v.revision = h.revision";

fn active_hooks(db: &Connection, clause: &str, bindings: impl Params) -> crate::Result<Vec<Value>> {
    rows(db, &format!("{ACTIVE_HOOKS} {clause}"), bindings)?
        .into_iter()
        .map(|row| {
            let mut row = decode_draft(row)?;
            row["versions"] =
                serde_json::from_str(row["versions"].as_str().ok_or("missing Hook versions")?)?;
            Ok(row)
        })
        .collect()
}

fn current_hook(db: &Connection, id: &str) -> crate::Result<Value> {
    Ok(active_hooks(db, "WHERE h.id = ?", [id])?
        .pop()
        .unwrap_or(Value::Null))
}

fn version(db: &Connection, id: &str, revision: i64) -> crate::Result<Option<Value>> {
    let versions = rows(
        db,
        "SELECT id, revision, draft FROM native_hook_versions WHERE id = ? AND revision = ?",
        params![id, revision],
    )?;
    versions.into_iter().next().map(decode_draft).transpose()
}

fn read_inner(db: &Connection, query: Query) -> crate::Result<Value> {
    match query {
        Query::List => Ok(active_hooks(db, "ORDER BY h.ord, h.id", [])?.into()),
        Query::Find { id } => current_hook(db, &id),
        Query::Versions { versions } => versions.iter().map(|v| {
            version(db, &v.id, v.revision)?.ok_or_else(|| "Hook 版本不存在".into())
        }).collect::<crate::Result<Vec<_>>>().map(Value::Array),
        Query::Candidates { event } => candidates(db, "v.event = ? AND v.tool = ''", [event]),
        Query::ToolCandidates { tool } => candidates(db,
            "v.event IN ('beforeTool','afterTool') AND (v.tool = '' OR v.tool = ?)", [tool]),
        Query::Improvement { id, revision, sources } => {
            let (triggers, errors): (i64, i64) = db.query_row(
                "SELECT count(*) FILTER (WHERE outcome='feedback'), count(*) FILTER (WHERE outcome='error')
                 FROM native_hook_receipts WHERE id=? AND revision=?", params![id, revision],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let repaired: i64 = db.query_row(
                "SELECT count(*) FROM native_hook_readback_evidence v WHERE v.id=? AND v.revision=? AND v.observed='verified'
                 AND EXISTS (SELECT 1 FROM native_hook_readback_evidence r WHERE r.id=v.id AND r.revision=v.revision
                   AND r.taskId=v.taskId AND r.conversationId=v.conversationId AND r.runKey=v.runKey
                   AND r.inputEntry=v.inputEntry AND r.observed='written' AND r.seq_ord<v.seq_ord)",
                params![id, revision], |r| r.get(0),
            )?;
            let recurrences: i64 = db.query_row(
                "SELECT count(*) FROM json_each(?) s WHERE EXISTS (
                   SELECT 1 FROM native_hook_receipts r
                   WHERE r.id=? AND r.revision=? AND r.outcome='feedback'
                     AND r.taskId=json_extract_string(s.value,'$.task')
                     AND r.conversationId=json_extract_string(s.value,'$.conversation')
                     AND r.nativeTaskId=CAST(json_extract(s.value,'$.generation') AS BIGINT))",
                params![serde_json::to_string(&sources)?, id, revision], |r| r.get(0),
            )?;
            Ok(json!({ "hook": current_hook(db, &id)?, "version": version(db, &id, revision)?,
                "triggers": triggers, "errors": errors, "repaired": repaired, "recurrences": recurrences }))
        }
        Query::ChildReview { task_id, conversation_id } => Ok(rows(db,
            "SELECT id, revision, count(*) executions FROM native_hook_receipts
             WHERE taskId=? AND conversationId=? AND actor='subagent' GROUP BY id, revision ORDER BY id, revision",
            params![task_id, conversation_id])?.into()),
        Query::GenerationReceipts { task_id, conversation_id, task_ids } => Ok(rows(db,
            r#"WITH requested AS (
               SELECT CAST(value AS BIGINT) AS task, min(CAST(key AS BIGINT)) AS position
               FROM json_each(?) GROUP BY CAST(value AS BIGINT)
             )
             SELECT r.id,r.revision,r.event,r.nativeTaskId,r.actor,r.tool,r.callId,r.outcome,r."at"
             FROM requested p JOIN native_hook_receipts r ON r.nativeTaskId=p.task
             WHERE r.taskId=? AND r.conversationId=?
             QUALIFY row_number() OVER (PARTITION BY p.task ORDER BY r."at",r.seq_ord) <= 100
             ORDER BY p.position,r."at",r.seq_ord"#, params![serde_json::to_string(&task_ids)?, task_id, conversation_id])?.into()),
        Query::NestedFeedback { task_id, conversation_id, parent_task_id } => {
            let mut stmt = db.prepare(
                r#"SELECT json_extract_string(v.draft,'$.title'), r.revision, r.tool, r.message
                 FROM native_hook_receipts r JOIN native_hook_versions v ON r.id=v.id AND r.revision=v.revision
                 WHERE r.taskId=? AND r.conversationId=? AND r.parentTaskId=? AND r.event='afterTool' AND r.outcome<>'pass'
                 ORDER BY r."at",r.seq_ord LIMIT 16"#,
            )?;
            let lines = stmt.query_map(params![task_id, conversation_id, parent_task_id], |row| {
                let (title, revision, tool, message): (String, i64, String, String) =
                    (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?);
                Ok(format!("[Hook · {title} v{revision} · {tool}] {message}"))
            })?.collect::<duckdb::Result<Vec<_>>>()?;
            Ok(lines.join("\n").into())
        }
        Query::FinishAttempts { task_id, conversation_id, run_key } => {
            let count: i64 = db.query_row(
                "SELECT count(DISTINCT nativeTaskId) FROM native_hook_receipts
                 WHERE taskId=? AND conversationId=? AND runKey=? AND event='beforeFinish' AND outcome<>'pass'",
                params![task_id, conversation_id, run_key], |r| r.get(0),
            )?;
            Ok(count.into())
        }
        Query::Receipts { id } => Ok(rows(db,
            r#"SELECT id,revision,event,taskId,conversationId,nativeTaskId,actor,tool,callId,"at",outcome,message
             FROM native_hook_receipts WHERE id=? ORDER BY "at" DESC,seq_ord DESC LIMIT 100"#, [id])?.into()),
    }
}

fn candidates(db: &Connection, predicate: &str, bindings: impl Params) -> crate::Result<Value> {
    rows(db, &format!(
        "SELECT v.id,v.revision,v.draft FROM native_hooks h JOIN native_hook_versions v ON v.id=h.id AND v.revision=h.revision
         WHERE h.enabled=1 AND {predicate} ORDER BY CASE WHEN v.event='afterTool' THEN 1 ELSE 0 END,h.ord,h.id"
    ), bindings)?.into_iter().map(decode_draft).collect::<crate::Result<Vec<_>>>().map(Value::Array)
}

pub fn read(db: &mut Connection, query: Query) -> crate::Result<Value> {
    let tx = db.transaction()?;
    let data = read_inner(&tx, query)?;
    tx.commit()?;
    Ok(json!({ "status": "ok", "data": data }))
}

const CHANGED: &str = "Hook 已变化，请刷新后重试";

fn rejected(message: &str) -> Value {
    json!({ "status": "rejected", "message": message })
}

#[derive(Deserialize)]
struct DraftMetadata {
    event: String,
    tool: String,
}

pub fn write(db: &mut Connection, mutation: Mutation) -> crate::Result<Value> {
    let tx = db.transaction()?;
    let data = match mutation {
        Mutation::Publish {
            id,
            expected_generation,
            managed,
            draft_json,
        } => {
            let current: Option<i64> = tx
                .query_row(
                    "SELECT generation FROM native_hooks WHERE id=?",
                    [&id],
                    |r| r.get(0),
                )
                .optional()?;
            if managed && current.is_some() {
                return Ok(json!({ "status": "ok", "data": current_hook(&tx, &id)? }));
            }
            if current != expected_generation {
                return Ok(rejected(CHANGED));
            }
            let meta: DraftMetadata = serde_json::from_str(&draft_json)?;
            if !matches!(
                meta.event.as_str(),
                "beforeRequest" | "beforeTool" | "afterTool" | "beforeFinish"
            ) || !meta.tool.is_empty()
                && !matches!(meta.event.as_str(), "beforeTool" | "afterTool")
            {
                return Ok(rejected("只有工具事件可以指定工具名称"));
            }
            let revision: i64 = tx.query_row(
                "SELECT coalesce(max(revision),0)+1 FROM native_hook_versions WHERE id=?",
                [&id],
                |r| r.get(0),
            )?;
            let hash = format!("{:x}", Sha256::digest(draft_json.as_bytes()));
            tx.execute(
                "INSERT INTO native_hook_versions VALUES (?,?,?,?,?,?)",
                params![id, revision, meta.event, meta.tool, draft_json, hash],
            )?;
            if let Some(generation) = expected_generation {
                tx.execute(
                    "UPDATE native_hooks SET revision=?,generation=? WHERE id=?",
                    params![revision, generation + 1, id],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO native_hooks VALUES (?,?,1,1,nextval('native_hook_order'))",
                    params![id, revision],
                )?;
            }
            current_hook(&tx, &id)?
        }
        Mutation::Activate {
            id,
            generation,
            revision,
            enabled,
        } => {
            if version(&tx, &id, revision)?.is_none() {
                return Ok(rejected("Hook 版本不存在"));
            }
            let changed = tx.execute(
                "UPDATE native_hooks SET enabled=?,revision=?,generation=generation+1 WHERE id=? AND generation=?",
                params![i64::from(enabled), revision, id, generation],
            )?;
            if changed == 0 {
                return Ok(rejected(CHANGED));
            }
            current_hook(&tx, &id)?
        }
        Mutation::Record {
            receipt: r,
            run_key,
            parent_task_id,
            readback,
        } => {
            let event: Option<String> = tx
                .query_row(
                    "SELECT event FROM native_hook_versions WHERE id=? AND revision=?",
                    params![r.id, r.revision],
                    |row| row.get(0),
                )
                .optional()?;
            if event.as_deref() != Some(r.event.as_str()) {
                return Ok(rejected("Hook 回执版本或事件不存在"));
            }
            if readback.as_ref().is_some_and(|proof| {
                !r.id.starts_with("improvement-")
                    || r.event != "beforeFinish"
                    || !matches!(
                        (r.outcome.as_str(), proof.observed.as_str()),
                        ("pass", "verified") | ("feedback", "written")
                    )
            }) {
                return Ok(rejected("Hook 回读凭据与执行结果不符"));
            }
            let changed = tx.execute(
                r#"INSERT INTO native_hook_receipts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,nextval('native_hook_order'))
                 ON CONFLICT (id,revision,taskId,conversationId,nativeTaskId,event,callId) DO UPDATE
                 SET "at"=excluded."at",outcome=excluded.outcome,message=excluded.message
                 WHERE excluded."at">=native_hook_receipts."at""#,
                params![r.id,r.revision,r.task_id,r.conversation_id,r.native_task_id,r.event,r.tool,r.call_id,r.actor,
                    run_key,r.at,r.outcome,r.message,parent_task_id],
            )?;
            if let Some(proof) = readback.filter(|_| changed > 0) {
                tx.execute(
                    "INSERT INTO native_hook_readback_evidence VALUES (?,?,?,?,?,?,?,nextval('native_hook_order')) ON CONFLICT DO NOTHING",
                    params![r.id,r.revision,r.task_id,r.conversation_id,run_key,proof.input_entry,proof.observed],
                )?;
            }
            Value::Null
        }
    };
    crate::request_control::commit(tx)?;
    Ok(json!({ "status": "ok", "data": data }))
}
