use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    space_ids: Option<Vec<String>>,
    after: Option<String>,
}

const PAGE_SIZE: usize = 128;

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    if query.space_ids.as_ref().is_some_and(Vec::is_empty) {
        return Ok(json!({"rows":[],"next":null}));
    }
    let spaces = query
        .space_ids
        .map(|ids| serde_json::to_string(&ids))
        .transpose()?;
    let transaction = db.unchecked_transaction()?;
    // Page by task identity so changing an activity's timestamp cannot repeat it across pages.
    // A pending question still takes precedence over an ordinary newer delegation of the task.
    let mut statement = transaction.prepare(r#"WITH RECURSIVE archived_spaces(id) AS (
        SELECT id FROM spaces WHERE archived<>0
        UNION SELECT s.id FROM spaces s JOIN archived_spaces a ON s.parent_id=a.id
    ), chosen AS (
        SELECT d.seq AS sequence,d.operation_id,d.task_id,t.title,s.name AS space,d.status,d.text,d.updated_at,
          d.files,d.interaction_id,d.goal_id,i.assistant_message_id AS question_message_id,
          i.title AS question_title,i.description AS question_description
        FROM dots_delegations d JOIN tasks t ON t.id=d.task_id
        LEFT JOIN spaces s ON s.id=t.space_id
        LEFT JOIN conversation_interactions i ON i.id=d.interaction_id AND i.task_id=t.id AND i.status='pending'
        WHERE t.id<>'mybuddy-dots' AND t.archived=0 AND (?1 IS NULL OR t.id>?1)
          AND (?2 IS NULL OR t.space_id IN (SELECT json_extract_string(value,'$') FROM json_each(?2)))
          AND NOT EXISTS(SELECT 1 FROM archived_spaces a WHERE a.id=t.space_id)
          AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
        QUALIFY row_number() OVER (PARTITION BY d.task_id ORDER BY
          (d.status='blocked' AND i.id IS NOT NULL) DESC,d.seq DESC)=1
        ORDER BY d.task_id LIMIT ?3
    ), receipts AS (
        SELECT r.operation_id,r.event_key,try_cast(r.snapshot AS JSON) AS snapshot
        FROM dots_reply_events r JOIN chosen d ON r.operation_id=d.operation_id AND r.task_id=d.task_id
          AND r.status=d.status AND r.interaction_id IS NOT DISTINCT FROM d.interaction_id
        WHERE r.settled=1 AND (json_extract_string(try_cast(r.snapshot AS JSON),'$.delivered') IN ('question','conclusion')
          OR (r.status IN ('completed','failed') AND json_extract_string(try_cast(r.snapshot AS JSON),'$.delivered')='progress'))
        QUALIFY row_number() OVER (PARTITION BY r.operation_id ORDER BY r.rowid DESC)=1
    ), ready AS (
        SELECT r.operation_id,json_extract_string(try_cast(r.reply AS JSON),'$.text') AS ready_text
        FROM dots_reply_events r JOIN chosen d ON r.operation_id=d.operation_id AND r.task_id=d.task_id
        WHERE r.settled=0 AND json_extract_string(try_cast(r.reply AS JSON),'$.kind')='conclusion'
        QUALIFY row_number() OVER (PARTITION BY r.operation_id ORDER BY r.rowid DESC)=1
    )
    SELECT d.sequence,d.operation_id,d.task_id,d.title,d.space,d.status,d.text,d.updated_at,
      coalesce(json_array_length(try_cast(d.files AS JSON)),0)::BIGINT AS file_count,
      d.interaction_id,d.question_message_id,d.question_title,d.question_description,a."at" AS last_activity_at,
      coalesce(json_extract_string(e.snapshot,'$.deliveryKey'),e.event_key) AS delivery_key,
      json_extract_string(e.snapshot,'$.delivered') AS delivered,json_extract_string(e.snapshot,'$.summary') AS summary,
      try_cast(json_extract_string(e.snapshot,'$.deliveredAt') AS BIGINT) AS delivered_at,
      try_cast(json_extract_string(e.snapshot,'$.fileCount') AS BIGINT) AS delivered_file_count,
      json_extract_string(e.snapshot,'$.sourceConclusion') AS source_conclusion,
      coalesce(json_extract_string(try_cast(p.plan AS JSON),'$.goal'),json_extract_string(try_cast(p.plan AS JSON),'$.assignment')) AS assignment,
      ready.ready_text,(EXISTS(SELECT 1 FROM dots_reply_events r WHERE r.operation_id=d.operation_id
        AND r.task_id=d.task_id AND r.status=d.status AND r.settled=0))::BIGINT AS following,
      c.state AS control,w.lifecycle AS goal_lifecycle,w.closure_conclusion AS goal_conclusion,
      dw.prerequisite_id AS dependency_id,dw.title AS dependency_title,dw.deadline_at AS dependency_deadline
    FROM chosen d
    LEFT JOIN receipts e USING(operation_id) LEFT JOIN ready USING(operation_id)
    LEFT JOIN dots_followup_plans p ON p.operation_id=d.operation_id
    LEFT JOIN dots_target_controls c ON c.task_id=d.task_id LEFT JOIN works w ON w.work_id=d.goal_id
    LEFT JOIN dots_tool_observations a ON a.operation_id=d.operation_id
    LEFT JOIN dots_dependency_waits dw ON dw.operation_id=d.operation_id AND d.status='blocked'
    ORDER BY d.task_id"#)?;
    let mut cursor = statement.query(params![query.after, spaces, PAGE_SIZE + 1])?;
    let columns = cursor
        .as_ref()
        .ok_or("Missing Dots activity columns")?
        .column_names();
    let mut rows = Vec::new();
    let mut more = false;
    let mut bytes = 4096;
    while let Some(row) = cursor.next()? {
        if rows.len() == PAGE_SIZE {
            more = true;
            break;
        }
        let mut projection = serde_json::Map::new();
        for (index, name) in columns.iter().enumerate() {
            projection.insert(
                name.clone(),
                crate::database::value_ref_to_json(row.get_ref(index)?)?,
            );
        }
        let output = Value::Object(projection);
        bytes += serde_json::to_vec(&output)?.len() + 1;
        if bytes >= crate::MAX_REPLY_BYTES {
            if rows.is_empty() {
                return Err("Dots activity exceeds IPC page limit".into());
            }
            more = true;
            break;
        }
        rows.push(output);
    }
    drop(cursor);
    drop(statement);

    if rows.iter().any(|row| row["delivery_key"].is_string()) {
        verify_deliveries(&transaction, &mut rows)?;
    }
    let next = if more {
        rows.last().and_then(|row| row["task_id"].as_str())
    } else {
        None
    };
    Ok(json!({"rows":rows,"next":next}))
}

fn verify_deliveries(db: &Connection, rows: &mut [Value]) -> Result<()> {
    let directory: Option<String> = db.query_row(
        "SELECT directory FROM durable_bot_bindings WHERE task_id='mybuddy-dots' AND backend='pi-durable'",
        [], |row| row.get(0),
    ).optional()?;
    let store = directory.map(|path| crate::durable::store_id_for_path(Path::new(&path)));

    for row in rows {
        let Some(key) = row["delivery_key"].as_str() else {
            continue;
        };
        let record = match &store {
            Some(store) => crate::pi_storage::dots_delivery_entry(db, store, key)?,
            None => None,
        };
        // A clickable delivery always needs the corresponding persisted conversation entry.
        if !record.is_some_and(|record| {
            let data = &record["data"];
            data["taskId"] == row["task_id"]
                && data["operationId"] == row["operation_id"]
                && data["kind"] == row["delivered"]
                && data["deliveredAt"] == row["delivered_at"]
        }) {
            for field in [
                "delivery_key",
                "delivered",
                "summary",
                "delivered_at",
                "delivered_file_count",
                "source_conclusion",
            ] {
                row[field] = Value::Null;
            }
        }
    }
    Ok(())
}
