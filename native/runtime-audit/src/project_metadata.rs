use crate::{Result, sqlite_rows::records};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

const DAY: i64 = 86_400_000;
const PROJECT_COLUMNS: &str =
    "id, name, description, instructions, goal, current_stage, created_at,
    updated_at, archived, resource_budget_chars, template_id, default_space_id";

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    WritesSupported,
    TodoWritesSupported,
    EventTodoPromotionSupported,
    EventLibraryPromotionSupported,
    DeletionSupported,
    MemoryWritesSupported,
    MemoryEditsSupported,
    ReviewWritesSupported,
    WithdrawalSnapshot {
        project_id: String,
        memory_id: Option<String>,
    },
    List {
        include_archived: bool,
    },
    Details {
        project_id: String,
    },
    Todos {
        project_id: String,
    },
    Memories {
        project_id: String,
    },
    Todo {
        id: String,
    },
    NextBoundary {
        project_id: String,
        now: f64,
    },
    Events {
        project_id: String,
        limit: usize,
    },
    Status {
        project_id: String,
        now: i64,
    },
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::WritesSupported | Query::TodoWritesSupported | Query::EventTodoPromotionSupported
        | Query::EventLibraryPromotionSupported | Query::DeletionSupported | Query::MemoryWritesSupported
        | Query::MemoryEditsSupported | Query::ReviewWritesSupported => Ok(true.into()),
        Query::WithdrawalSnapshot { project_id, memory_id } => crate::project_memory_forget::snapshot(db, &project_id, memory_id.as_deref()),
        Query::List { include_archived } => Ok(records(db, &format!(
            "SELECT {PROJECT_COLUMNS} FROM projects WHERE (?1 OR archived = 0) ORDER BY updated_at DESC"
        ), [include_archived])?.into()),
        Query::Details { project_id } => details(db, &project_id),
        Query::Memories { project_id } => memories(db, &project_id),
        Query::Todo { id } => Ok(records(db,
            "SELECT id,project_id,title,description,status,assignee,priority,tags_json,start_at,due_at,created_at,updated_at
             FROM project_todos WHERE id=?1", [&id],
        )?.pop().unwrap_or(Value::Null)),
        Query::NextBoundary { project_id, now } => {
            let boundary: Option<f64> = db.query_row("WITH due AS (
                SELECT due_at FROM project_todos WHERE project_id=?1 AND status<>'done' AND due_at IS NOT NULL
            ), candidates(at) AS (
                SELECT due_at FROM due UNION ALL SELECT due_at-?3 FROM due
                UNION ALL SELECT updated_at+?4 FROM tasks WHERE project_id=?1 AND archived=0
                    AND coalesce(status,'') NOT IN ('completed','failed')
            ) SELECT min(at) FROM candidates WHERE at>?2 AND EXISTS(SELECT 1 FROM projects WHERE id=?1)", params![project_id, now, 3*DAY, 7*DAY], |row| row.get(0))?;
            Ok(json!(boundary))
        }
        Query::Todos { project_id } => {
            if !exists(db, &project_id)? { return Ok(Value::Null); }
            Ok(records(db,
                "SELECT id, project_id, title, description, status, assignee, priority, tags_json, start_at,
                        due_at, created_at, updated_at
                 FROM project_todos WHERE project_id = ?1 ORDER BY updated_at DESC, id DESC",
                [&project_id],
            )?.into())
        }
        Query::Events { project_id, limit } => {
            if !exists(db, &project_id)? { return Ok(Value::Null); }
            let events = records(db,
                "SELECT id, project_id, source, kind, title, body, ref, payload_json, triage_status, created_at
                 FROM project_events WHERE project_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
                params![project_id, limit],
            )?;
            let ids: Vec<_> = events.iter().filter_map(|event| event["id"].as_str()).collect();
            let promotions = if ids.is_empty() { Vec::new() } else {
                records(db,
                    "SELECT id, project_id, event_id, event_title, target_kind, target_id, target_title, promoted_by, note, created_at
                     FROM project_event_promotions WHERE project_id = ?1 AND event_id IN (SELECT value FROM json_each(?2))
                     ORDER BY created_at ASC",
                    params![project_id, serde_json::to_string(&ids)?],
                )?
            };
            Ok(json!({ "events": events, "promotions": promotions }))
        }
        Query::Status { project_id, now } => status(db, &project_id, now),
    }
}

fn details(db: &Connection, project_id: &str) -> Result<Value> {
    let Some(project) = records(db, "SELECT p.*,
        e.allow_json AS expert_allow,e.deny_json AS expert_deny,e.recommended_json AS expert_recommended,
        s.allow_json AS skill_allow,s.prefer_json AS skill_prefer,s.demote_json AS skill_demote,s.hide_json AS skill_hide,
        c.allow_json AS connector_allow,c.deny_json AS connector_deny,c.recommended_json AS connector_recommended,
        m.mode AS mcp_mode,m.allow_json AS mcp_allow,m.deny_json AS mcp_deny
        FROM projects p
        LEFT JOIN project_expert_policy e ON e.project_id=p.id
        LEFT JOIN project_skill_policy s ON s.project_id=p.id
        LEFT JOIN project_connector_policy c ON c.project_id=p.id
        LEFT JOIN project_mcp_policy m ON m.project_id=p.id WHERE p.id=?1", [project_id])?.pop() else {
        return Ok(Value::Null);
    };
    let resources = records(
        db,
        "SELECT id,project_id,kind,title,value,enabled,sort_order,parent_id,created_at,updated_at
        FROM project_resources WHERE project_id=?1 ORDER BY sort_order,created_at,id",
        [project_id],
    )?;
    Ok(json!({ "project": project, "resources": resources }))
}

fn memories(db: &Connection, project: &str) -> Result<Value> {
    if !exists(db, project)? {
        return Ok(Value::Null);
    }
    let rows = records(db,
        "SELECT m.id,m.kind,m.title,m.content,m.status,m.importance,m.created_at AS createdAt,m.updated_at AS updatedAt,
           m.source_type AS sourceType,m.source_task_id AS sourceTaskId,m.metadata_json,
           (SELECT json_group_array(json_object('id',e.id,'evidenceKind',e.evidence_kind,
               'refId',e.ref_id,'refTitle',e.ref_title,'createdAt',e.created_at))
            FROM (SELECT id,evidence_kind,ref_id,ref_title,created_at FROM memory_evidence
                  WHERE memory_id=m.id ORDER BY created_at) e) AS evidence_json
         FROM memory_records m JOIN memory_scopes s ON s.memory_id=m.id
         WHERE s.scope_type='project' AND s.scope_id=?1 AND m.status IN ('active','superseded','resolved')
         ORDER BY m.importance DESC,m.explicit DESC,m.updated_at DESC LIMIT 2000", [project])?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for mut row in rows {
        let item = row.as_object_mut().ok_or("invalid project memory row")?;
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .ok_or("missing project memory id")?;
        if !seen.insert(id.to_owned()) {
            continue;
        }
        let metadata = item
            .remove("metadata_json")
            .and_then(|raw| serde_json::from_str(raw.as_str()?).ok())
            .unwrap_or_default();
        item.insert("metadata".into(), Value::Object(metadata));
        let evidence = item
            .remove("evidence_json")
            .ok_or("missing project memory evidence")?;
        item.insert(
            "evidence".into(),
            serde_json::from_str(evidence.as_str().ok_or("invalid project memory evidence")?)?,
        );
        result.push(row);
    }
    Ok(result.into())
}

fn exists(db: &Connection, id: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum IssueKind {
    BlockingOverdue,
    Overdue,
    NearDue,
    StaleTask,
    ActiveRisk,
    ImportantQuestion,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Issue {
    kind: IssueKind,
    ref_id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    due_at: Option<i64>,
}

fn plan_issues(db: &Connection, id: &str, now: i64, kind: IssueKind) -> Result<Vec<Issue>> {
    let predicate = match kind {
        IssueKind::BlockingOverdue => "due_at < ?2 AND status = 'doing' AND priority IS 'high'",
        IssueKind::Overdue => "due_at < ?2 AND NOT (status IS 'doing' AND priority IS 'high')",
        IssueKind::NearDue => "due_at >= ?2 AND due_at < ?3",
        _ => return Err("invalid plan issue type".into()),
    };
    let mut statement = db.prepare_cached(&format!(
        "SELECT id,title,due_at FROM project_todos WHERE project_id = ?1 AND status IS NOT 'done' AND {predicate}
         ORDER BY updated_at DESC,id DESC LIMIT 5"
    ))?;
    let near_due_end = now.saturating_add(3 * DAY);
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&id, &now];
    if matches!(kind, IssueKind::NearDue) {
        values.push(&near_due_end);
    }
    let records = statement
        .query_map(rusqlite::params_from_iter(values), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(records
        .into_iter()
        .map(|(ref_id, title, due_at)| Issue {
            kind,
            ref_id,
            title,
            due_at: Some(due_at),
        })
        .collect())
}

struct MemoryFact {
    id: String,
    title: String,
    kind: String,
    status: String,
    importance: i64,
    updated_at: i64,
}

fn status(db: &Connection, id: &str, now: i64) -> Result<Value> {
    let project = db
        .query_row(
            "SELECT name, goal, current_stage, archived, updated_at FROM projects WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((name, goal, stage, archived, mut last_activity)) = project else {
        return Ok(Value::Null);
    };
    let stale_after = now.saturating_sub(7 * DAY);
    let (task_count, active_tasks, doing_tasks, stale_tasks, last_task): (i64, i64, i64, i64, Option<i64>) =
        db.query_row(
            "SELECT count(*), count(*) FILTER (WHERE archived = 0 AND status IS NOT 'completed' AND status IS NOT 'failed'),
                    count(*) FILTER (WHERE archived = 0 AND status = 'in_progress'),
                    count(*) FILTER (WHERE archived = 0 AND status = 'in_progress' AND updated_at < ?2), max(updated_at)
             FROM tasks WHERE project_id = ?1",
            params![id, stale_after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
    let (todo_count, doing_todos, overdue_todos, last_todo): (i64, i64, i64, Option<i64>) = db
        .query_row(
            "SELECT count(*), count(*) FILTER (WHERE status = 'doing'),
                    count(*) FILTER (WHERE status IS NOT 'done' AND due_at < ?2), max(updated_at)
             FROM project_todos WHERE project_id = ?1",
            params![id, now],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    let mut statement = db.prepare_cached(
        "SELECT m.id, m.title, m.kind, m.status, m.importance, m.updated_at FROM memory_records m
         JOIN memory_scopes s ON s.memory_id = m.id
         WHERE s.scope_type = 'project' AND s.scope_id = ?1 AND m.status IN ('active','superseded','resolved')
         ORDER BY m.importance DESC, m.explicit DESC, m.updated_at DESC LIMIT 2000",
    )?;
    let mut seen = HashSet::new();
    let mut memories = Vec::new();
    for record in statement.query_map([id], |r| {
        Ok(MemoryFact {
            id: r.get(0)?,
            title: r.get(1)?,
            kind: r.get(2)?,
            status: r.get(3)?,
            importance: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })? {
        let record = record?;
        if seen.insert(record.id.clone()) {
            memories.push(record);
        }
    }
    for at in last_task
        .into_iter()
        .chain(last_todo)
        .chain(memories.iter().map(|m| m.updated_at))
    {
        last_activity = last_activity.max(at);
    }
    let mut risks: Vec<_> = memories
        .iter()
        .filter(|m| m.status == "active" && m.kind == "risk")
        .collect();
    risks.sort_by_key(|m| {
        (
            std::cmp::Reverse(m.importance),
            std::cmp::Reverse(m.updated_at),
        )
    });
    let open: Vec<_> = memories
        .iter()
        .filter(|m| m.status == "active" && m.kind == "open_question")
        .collect();
    let last_review: Option<i64> = db.query_row(
        "SELECT max(reviewed_at) FROM project_reviews WHERE project_id = ?1",
        [id],
        |r| r.get(0),
    )?;
    let blockers = plan_issues(db, id, now, IssueKind::BlockingOverdue)?;
    let mut at_risks = plan_issues(db, id, now, IssueKind::Overdue)?;
    at_risks.extend(plan_issues(db, id, now, IssueKind::NearDue)?);
    let mut stale = db.prepare_cached(
        "SELECT id,title FROM tasks WHERE project_id = ?1 AND archived = 0 AND status = 'in_progress' AND updated_at < ?2
         ORDER BY rowid LIMIT 3",
    )?;
    for row in stale.query_map(params![id, stale_after], |r| {
        Ok(Issue {
            kind: IssueKind::StaleTask,
            ref_id: r.get(0)?,
            title: r.get(1)?,
            due_at: None,
        })
    })? {
        at_risks.push(row?);
    }
    at_risks.extend(risks.iter().take(3).map(|m| Issue {
        kind: IssueKind::ActiveRisk,
        ref_id: m.id.clone(),
        title: m.title.clone(),
        due_at: None,
    }));
    at_risks.extend(
        open.iter()
            .filter(|m| m.importance >= 2)
            .take(3)
            .map(|m| Issue {
                kind: IssueKind::ImportantQuestion,
                ref_id: m.id.clone(),
                title: m.title.clone(),
                due_at: None,
            }),
    );
    at_risks.truncate(8);
    let next_actions = records(db,
        "SELECT 'plan' as source, id as refId, title, due_at as dueAt
         FROM project_todos WHERE project_id = ?1 AND status = 'doing'
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
                  due_at IS NULL, due_at, updated_at DESC, id DESC LIMIT 4",
        [id],
    )?.into_iter().chain(records(db,
        "SELECT 'task' as source, id as refId, title
         FROM tasks WHERE project_id = ?1 AND archived = 0 AND status = 'in_progress'
         ORDER BY updated_at DESC, rowid LIMIT 4",
        [id],
    )?).collect::<Vec<_>>();
    let (proposals_total, needs_confirmation): (i64, i64) = db.query_row(
        "SELECT count(*), count(*) FILTER (WHERE action_type = 'needs_confirmation' AND status = 'proposed')
         FROM project_action_proposals WHERE project_id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(json!({
        "status": {
            "projectId": id, "projectName": name, "goal": goal, "currentStage": stage, "archived": archived,
            "health": if !blockers.is_empty() { "red" } else if !at_risks.is_empty() { "yellow" } else { "green" },
            "generatedAt": now, "lastActivityAt": last_activity, "lastReviewedAt": last_review,
            "tasks": { "total": task_count, "active": active_tasks, "doing": doing_tasks, "stale": stale_tasks },
            "plan": { "total": todo_count, "doing": doing_todos, "overdue": overdue_todos },
            "memory": { "openQuestions": open.len(), "risks": risks.len() },
            "blockers": blockers, "atRisks": at_risks, "nextActions": next_actions
        },
        "proposalsTotal": proposals_total, "needsConfirmation": needs_confirmation
    }))
}
