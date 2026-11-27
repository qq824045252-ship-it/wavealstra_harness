use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Get {
        id: String,
        conversation_id: i64,
    },
    Pending {
        task_id: String,
        conversation_id: i64,
    },
    Candidates {
        conversation_id: i64,
        source_id: String,
        task_id: Option<String>,
        space_id: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Save {
        requirement: Requirement,
        source_id: String,
    },
    Accept {
        task_id: String,
        operation_id: String,
        submission_id: i64,
    },
}

impl Command {
    pub fn task_id(&self) -> &str {
        match self {
            Self::Save { requirement, .. } => &requirement.task_id,
            Self::Accept { task_id, .. } => task_id,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    id: String,
    conversation_id: i64,
    task_id: String,
    prerequisite_id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reservation {
    pub id: String,
    pub conversation_id: i64,
    pub original_task_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    #[serde(flatten)]
    requirement: Requirement,
    operation_id: Option<String>,
    applied: i64,
}

fn get(db: &Connection, id: &str, conversation_id: i64) -> Result<Option<Row>> {
    Ok(db
        .query_row(
            "SELECT id,conversationId,taskId,prerequisiteId,text,operationId,applied
         FROM dots_deferred_requirements WHERE id=? AND conversationId=?",
            params![id, conversation_id],
            |row| {
                Ok(Row {
                    requirement: Requirement {
                        id: row.get(0)?,
                        conversation_id: row.get(1)?,
                        task_id: row.get(2)?,
                        prerequisite_id: row.get(3)?,
                        text: row.get(4)?,
                    },
                    operation_id: row.get(5)?,
                    applied: row.get(6)?,
                })
            },
        )
        .optional()?)
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Get {
            id,
            conversation_id,
        } => {
            let Some(row) = get(db, &id, conversation_id)? else {
                return Ok(Value::Null);
            };
            let prerequisite: Option<String> = db
                .query_row(
                    "SELECT status FROM dots_delegations WHERE operation_id=? AND task_id=?",
                    params![row.requirement.prerequisite_id, row.requirement.task_id],
                    |r| r.get(0),
                )
                .optional()?;
            let attempt = row.operation_id.as_ref().map(|operation_id| db.query_row(
                "SELECT source_message_id,status FROM dots_delegations WHERE operation_id=?",
                [operation_id], |r| Ok(json!({"sourceMessageId":r.get::<_, String>(0)?,"status":r.get::<_, String>(1)?})),
            ).optional()).transpose()?.flatten();
            Ok(json!({"requirement":row,"prerequisiteStatus":prerequisite,"attempt":attempt}))
        }
        Query::Pending {
            task_id,
            conversation_id,
        } => {
            let mut stmt = db.prepare(
                "SELECT r.id,r.text,r.prerequisiteId,d.status FROM dots_deferred_requirements r
                 JOIN dots_delegations d ON d.operation_id=r.prerequisiteId AND d.task_id=r.taskId
                 LEFT JOIN dots_delegations attempt ON attempt.operation_id=r.operationId
                 WHERE r.taskId=? AND r.conversationId=? AND r.applied=0 AND (r.operationId IS NULL OR attempt.status='failed') ORDER BY r.rowid",
            )?;
            let rows = stmt.query_map(params![task_id, conversation_id], |r| Ok(json!({
                "id":r.get::<_, String>(0)?,"text":r.get::<_, String>(1)?,"prerequisiteId":r.get::<_, String>(2)?,"status":r.get::<_, String>(3)?
            })))?.collect::<duckdb::Result<Vec<_>>>()?;
            Ok(json!(rows))
        }
        Query::Candidates {
            conversation_id,
            source_id,
            task_id,
            space_id,
        } => {
            let mut stmt = db.prepare(
                "SELECT r.id FROM dots_deferred_requirements r JOIN tasks t ON t.id=r.taskId
                 LEFT JOIN dots_delegations attempt ON attempt.operation_id=r.operationId
                 WHERE r.conversationId=?1 AND (r.taskId=?2 OR (?2 IS NULL AND t.space_id=?3)) AND t.archived=0
                  AND (attempt.source_message_id=?4 OR (r.applied=0 AND (r.operationId IS NULL OR attempt.status='failed')))
                  AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
                 ORDER BY r.rowid LIMIT 2",
            )?;
            let rows = stmt
                .query_map(
                    params![conversation_id, task_id, space_id, source_id],
                    |r| r.get::<_, String>(0),
                )?
                .collect::<duckdb::Result<Vec<_>>>()?;
            Ok(json!(rows))
        }
    }
}

fn prerequisite_current(
    db: &Connection,
    requirement: &Requirement,
    completed: bool,
) -> Result<bool> {
    Ok(db.query_row(
        "WITH RECURSIVE parents(id,parent_id,archived) AS (
            SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN tasks t ON t.space_id=s.id WHERE t.id=?1
            UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN parents p ON s.id=p.parent_id
         ) SELECT EXISTS(SELECT 1 FROM dots_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
             WHERE d.task_id=?1 AND d.operation_id=?2 AND t.archived=0 AND t.external_agent_pin_json IS NULL
               AND NOT EXISTS(SELECT 1 FROM parents WHERE archived<>0)
               AND NOT EXISTS(SELECT 1 FROM work_execution_bindings w WHERE w.task_id=t.id)
               AND NOT EXISTS(SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
               AND d.space_id IS NOT DISTINCT FROM t.space_id AND d.space_path IS NOT DISTINCT FROM s.path
               AND (d.cwd IS NOT DISTINCT FROM t.cwd OR (d.cwd IS NULL AND t.cwd IS NOT DISTINCT FROM d.space_path))
               AND ((?3 AND d.status='completed') OR (NOT ?3 AND NOT EXISTS
                   (SELECT 1 FROM dots_delegations newer WHERE newer.task_id=d.task_id AND newer.seq>d.seq))))",
        params![requirement.task_id, requirement.prerequisite_id, completed], |r| r.get(0),
    )?)
}

fn submission_exists(
    db: &Connection,
    task_id: &str,
    operation_id: &str,
    submission_id: Option<i64>,
) -> Result<bool> {
    let directory: Option<String> = db
        .query_row(
            "SELECT directory FROM durable_bot_bindings WHERE task_id=? AND backend='pi-durable'",
            [task_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(directory) = directory else {
        return Ok(false);
    };
    let store = crate::durable::store_id_for_path(Path::new(&directory));
    let request = operation_id.replace('\u{e000}', "\u{e000}\u{e000}");
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM durable_submissions r JOIN durable_stores s USING(store_id)
         WHERE s.store_id=?1 AND NOT s.retired AND r.request_id=?2 AND (?3 IS NULL OR r.id=?3)
           AND r.status IN ('queued','placed','done','unanswered') AND json_extract_string(r.record_json,'$.type')='input'
           AND coalesce(json_extract_string(r.record_json,'$.reason'),'') NOT IN ('aborted','reset'))",
        params![store, request, submission_id], |r| r.get(0),
    )?)
}

pub fn reserve_in_transaction(
    db: &Connection,
    reservation: &Reservation,
    task_id: &str,
    operation_id: &str,
    source_id: &str,
) -> Result<()> {
    let Some(row) = get(db, &reservation.id, reservation.conversation_id)? else {
        return Err("找不到原对话的待办".into());
    };
    if row.requirement.task_id != reservation.original_task_id {
        return Err("待办只可用于用户确认的原事项".into());
    }
    let in_origin_and_workspace: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM dots_delegations linked
           JOIN dots_reply_origins o ON o.source=linked.source_message_id
           JOIN tasks target ON target.id=linked.task_id JOIN tasks original ON original.id=?5
           WHERE linked.operation_id=?1 AND linked.task_id=?2 AND linked.source_message_id=?3 AND o.conversation=?4
             AND target.space_id IS NOT DISTINCT FROM original.space_id AND (target.id=original.id OR original.space_id IS NOT NULL)
             AND NOT EXISTS(SELECT 1 FROM dots_deferred_requirements used WHERE used.operationId=?1 AND used.id<>?6))",
        params![operation_id, task_id, source_id, reservation.conversation_id, row.requirement.task_id, reservation.id], |r| r.get(0),
    )?;
    if !in_origin_and_workspace {
        return Err("待办的委派与原对话或工作空间不符".into());
    }
    if row.operation_id.as_deref() == Some(operation_id) {
        return Ok(());
    }
    if row.applied != 0 || !prerequisite_current(db, &row.requirement, true)? {
        return Err("这条待办已使用，或原交办尚未完成或已变更工作空间".into());
    }
    if let Some(previous) = row.operation_id {
        let attempt: Option<(String, String)> = db
            .query_row(
                "SELECT task_id,status FROM dots_delegations WHERE operation_id=?",
                [&previous],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((previous_task, status)) = attempt else {
            return Err("这条待办已关联其他交办，请核对原任务".into());
        };
        if status != "failed" || submission_exists(db, &previous_task, &previous, None)? {
            return Err("这条待办已关联其他交办，请核对原任务".into());
        }
    }
    db.execute(
        "UPDATE dots_deferred_requirements SET operationId=? WHERE id=?",
        params![operation_id, reservation.id],
    )?;
    Ok(())
}

pub fn write(db: &mut Connection, command: Command) -> Result<Value> {
    let tx = db.transaction()?;
    let reply = match command {
        Command::Save {
            requirement,
            source_id,
        } => {
            let original_source: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM dots_reply_origins WHERE source=? AND conversation=?)",
                params![source_id, requirement.conversation_id],
                |r| r.get(0),
            )?;
            if !original_source {
                json!({"status":"scopeChanged"})
            } else if let Some(previous) = get(&tx, &requirement.id, requirement.conversation_id)? {
                if previous.requirement.task_id == requirement.task_id {
                    json!({"status":"saved","row":previous})
                } else {
                    json!({"status":"conflict"})
                }
            } else if requirement.id.is_empty()
                || requirement.conversation_id <= 0
                || requirement.text.trim().is_empty()
                || requirement.text.encode_utf16().count() > 6000
                || !prerequisite_current(&tx, &requirement, false)?
            {
                json!({"status":"scopeChanged"})
            } else {
                let inserted = tx.execute(
                    "INSERT INTO dots_deferred_requirements (id,conversationId,taskId,prerequisiteId,text)
                     VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
                    params![requirement.id, requirement.conversation_id, requirement.task_id, requirement.prerequisite_id, requirement.text],
                )?;
                if inserted == 0 {
                    json!({"status":"conflict"})
                } else {
                    json!({"status":"saved","row":Row { requirement, operation_id: None, applied: 0 }})
                }
            }
        }
        Command::Accept {
            task_id,
            operation_id,
            submission_id,
        } => {
            let reserved: Option<i64> = tx.query_row(
                "SELECT r.applied FROM dots_deferred_requirements r JOIN dots_delegations d ON d.operation_id=r.operationId
                 WHERE d.task_id=? AND d.operation_id=?", params![task_id, operation_id], |r| r.get(0),
            ).optional()?;
            match reserved {
                None => json!({"status":"unreserved"}),
                Some(applied) if applied != 0 => json!({"status":"accepted"}),
                Some(_)
                    if !submission_exists(&tx, &task_id, &operation_id, Some(submission_id))? =>
                {
                    json!({"status":"receiptMissing"})
                }
                Some(_) => {
                    tx.execute("UPDATE dots_deferred_requirements SET applied=1 WHERE operationId=? AND applied=0", [operation_id])?;
                    json!({"status":"accepted"})
                }
            }
        }
    };
    crate::request_control::commit(tx)?;
    Ok(reply)
}
