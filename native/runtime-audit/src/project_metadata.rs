use crate::{Result, sqlite_rows::records};
use duckdb::{Connection, OptionalExt, params};
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
    FolderRelocation,
    WriteContext {
        project_id: Option<String>, resource_id: Option<String>, todo_id: Option<String>,
        task_id: Option<String>, space_id: Option<String>, #[serde(default)] names: bool,
    },
    WritesSupported,
    TodoWritesSupported,
    EventTodoPromotionSupported,
    EventLibraryPromotionSupported,
    DeletionSupported,
    MemoryWritesSupported,
    MemoryEditsSupported,
    ReviewWritesSupported,
    EventPromotion { project_id: String, event_id: String, target_kind: String },
    WriteReceipt { operation_id: String },
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
    ContextSnapshot {
        project_id: String,
    },
    ContextWitness {
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
        Query::WriteContext { project_id, resource_id, todo_id, task_id, space_id, names } => {
            let project = if let Some(id) = resource_id {
                db.query_row("SELECT project_id FROM project_resources WHERE id=?1", [id], |r| r.get(0)).optional()?
            } else if let Some(id) = &todo_id {
                db.query_row("SELECT project_id FROM project_todos WHERE id=?1", [id], |r| r.get(0)).optional()?
            } else { project_id };
            let details = match &project { Some(id) => details(db,id)?, None => None };
            let todo = match todo_id { Some(id) => read(db, Query::Todo { id })?, None => Value::Null };
            let names = if names { records(db, "SELECT id,name FROM projects", [])? } else { Vec::new() };
            let member = if let (Some(task),Some(project)) = (task_id, &project) {
                db.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND project_id=?2)", params![task, project], |r| r.get::<_,bool>(0))?
            } else { false };
            let space_path: Option<String> = if let Some(id) = space_id
                && crate::scoped_notes::library_owner_writable(db, None, Some(&id))? {
                db.query_row("SELECT path FROM spaces WHERE id=?1", [id], |r| r.get(0)).optional()?.flatten()
            } else { None };
            Ok(json!({"details":details, "todo":todo, "names":names, "member":member, "spacePath":space_path}))
        }
        Query::FolderRelocation => folder_relocation(db),
        Query::WritesSupported | Query::TodoWritesSupported | Query::EventTodoPromotionSupported
        | Query::EventLibraryPromotionSupported | Query::DeletionSupported | Query::MemoryWritesSupported
        | Query::MemoryEditsSupported | Query::ReviewWritesSupported => Ok(true.into()),
        Query::EventPromotion { project_id, event_id, target_kind } => Ok(records(db,
            "SELECT id,project_id,event_id,event_title,target_kind,target_id,target_title,promoted_by,note,created_at
             FROM project_event_promotions WHERE project_id=? AND event_id=? AND target_kind=?",
            params![project_id,event_id,target_kind])?.pop().unwrap_or(Value::Null)),
        Query::WriteReceipt { operation_id } => Ok(crate::project_write::has_receipt(db, &operation_id)?.into()),
        Query::WithdrawalSnapshot { project_id, memory_id } => crate::project_memory_forget::snapshot(db, &project_id, memory_id.as_deref()),
        Query::List { include_archived } => Ok(records(db, &format!(
            "SELECT {PROJECT_COLUMNS} FROM projects WHERE (?1 OR archived = 0) ORDER BY updated_at DESC"
        ), [include_archived])?.into()),
        Query::Details { project_id } => Ok(serde_json::to_value(details(db, &project_id)?)?),
        Query::ContextSnapshot { project_id } => context_snapshot(db, &project_id),
        Query::ContextWitness { project_id } => context_witness(db, &project_id),
        Query::Memories { project_id } => memories(db, &project_id),
        Query::Todo { id } => Ok(records(db,
            "SELECT id,project_id,title,description,status,assignee,priority,tags_json,start_at,due_at,created_at,updated_at
             FROM project_todos WHERE id=?1", [&id],
        )?.pop().unwrap_or(Value::Null)),
        Query::NextBoundary { project_id, now } => {
            let boundary: Option<f64> = db.query_row("WITH due AS (
                SELECT due_at FROM project_todos WHERE project_id=?1 AND status<>'done' AND due_at IS NOT NULL
            ), candidates(\"at\") AS (
                SELECT due_at FROM due UNION ALL SELECT due_at-?3 FROM due
                UNION ALL SELECT updated_at+?4 FROM tasks WHERE project_id=?1 AND archived=0
                    AND coalesce(status,'') NOT IN ('completed','failed')
            ) SELECT min(\"at\") FROM candidates WHERE \"at\">?2 AND EXISTS(SELECT 1 FROM projects WHERE id=?1)", params![project_id, now, 3*DAY, 7*DAY], |row| row.get(0))?;
            Ok(json!(boundary))
        }
        Query::Todos { project_id } => {
            if !exists(db, &project_id)? { return Ok(Value::Null); }
            Ok(todos(db, &project_id)?.into())
        }
        Query::Events { project_id, limit } => {
            if !exists(db, &project_id)? { return Ok(Value::Null); }
            let events = records(db,
                "SELECT id, project_id, source, kind, title, body, ref, payload_json, triage_status, created_at
                 FROM project_events WHERE project_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
                params![project_id, limit],
            )?;
            let ids: Vec<String> = events
                .iter()
                .filter_map(|event| event["id"].as_str().map(str::to_owned))
                .collect();
            let promotions = if ids.is_empty() {
                Vec::new()
            } else {
                let slots = crate::database::anon_placeholders(ids.len());
                let mut stmt = db.prepare(&format!(
                    "SELECT id, project_id, event_id, event_title, target_kind, target_id, target_title, promoted_by, note, created_at
                     FROM project_event_promotions WHERE project_id = ? AND event_id IN ({slots})
                     ORDER BY created_at ASC"
                ))?;
                let cols = {
                    let mut params_vec: Vec<&dyn duckdb::ToSql> = vec![&project_id];
                    for id in &ids {
                        params_vec.push(id);
                    }
                    let mut rows = stmt.query(duckdb::params_from_iter(params_vec))?;
                    let cols: Vec<String> = rows
                        .as_ref()
                        .map(|s| s.column_names())
                        .unwrap_or_default();
                    let mut out = Vec::new();
                    while let Some(row) = rows.next()? {
                        let mut map = serde_json::Map::new();
                        for (i, name) in cols.iter().enumerate() {
                            map.insert(name.clone(), crate::database::value_ref_to_json(row.get_ref(i)?)?);
                        }
                        out.push(Value::Object(map));
                    }
                    out
                };
                cols
            };
            Ok(json!({ "events": events, "promotions": promotions }))
        }
        Query::Status { project_id, now } => status(db, &project_id, now),
    }
}

#[derive(Serialize)]
struct Details {
    project: Value,
    resources: Vec<Value>,
}

fn details(db: &Connection, project_id: &str) -> Result<Option<Details>> {
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
        return Ok(None);
    };
    let resources = records(
        db,
        "SELECT id,project_id,kind,title,value,enabled,sort_order,parent_id,created_at,updated_at
        FROM project_resources WHERE project_id=?1 ORDER BY sort_order,created_at,id",
        [project_id],
    )?;
    Ok(Some(Details { project, resources }))
}

fn todos(db: &Connection, project_id: &str) -> Result<Vec<Value>> {
    records(db,
        "SELECT id, project_id, title, description, status, assignee, priority, tags_json, start_at,
                due_at, created_at, updated_at
         FROM project_todos WHERE project_id = ?1 ORDER BY updated_at DESC, id DESC",
        [project_id],
    )
}

fn context_snapshot(db: &Connection, project_id: &str) -> Result<Value> {
    let Some(details) = details(db, project_id)? else {
        return Ok(Value::Null);
    };
    Ok(json!({
        "project": details.project,
        "resources": details.resources,
        "todos": todos(db, project_id)?,
        "pins": crate::project_pins_data::list(db, project_id)?,
    }))
}

fn select_ids(db: &Connection, sql: &str, project_id: &str) -> Result<Vec<String>> {
    let mut stmt = db.prepare(sql)?;
    let ids = stmt.query_map([project_id], |row| row.get(0))?.collect::<duckdb::Result<_>>()?;
    Ok(ids)
}

fn context_witness(db: &Connection, project_id: &str) -> Result<Value> {
    if !exists(db, project_id)? {
        return Ok(Value::Null);
    }
    let enabled_resource_ids = select_ids(db,
        "SELECT id FROM project_resources WHERE project_id = ?1 AND enabled <> 0 ORDER BY id", project_id)?;
    let pinned_item_ids = select_ids(db,
        "SELECT item_id FROM project_context_pins WHERE project_id = ?1 ORDER BY item_id", project_id)?;
    Ok(json!({ "enabledResourceIds": enabled_resource_ids, "pinnedItemIds": pinned_item_ids }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_context_snapshot_and_witness_keep_a_single_cut_during_concurrent_edit() -> Result<()> {
        let mut reader = Connection::open_in_memory()?;
        reader.execute_batch(crate::database::CANONICAL_DUCKDB_SCHEMA_SQL)?;
        reader.execute_batch(
            "INSERT INTO projects (id, name, instructions, created_at, updated_at)
             VALUES ('project', 'Project', 'old instructions', 1, 1);
             INSERT INTO project_expert_policy (project_id, allow_json) VALUES ('project', '[\"expert\"]');
             INSERT INTO project_resources (id, project_id, kind, title, value, created_at, updated_at)
             VALUES ('resource', 'project', 'text', 'Resource', 'old body', 1, 1);
             INSERT INTO project_todos (id, project_id, title, status, created_at, updated_at)
             VALUES ('todo', 'project', 'Todo', 'doing', 1, 1);
             INSERT INTO library_items (id, space_id, kind, title, filename, created_at, updated_at)
             VALUES ('item', 'space', 'markdown', 'Pinned title', 'item.md', 1, 1);
             INSERT INTO project_context_pins (id, project_id, item_id, note, created_at)
             VALUES ('pin', 'project', 'item', 'pin note', 1);",
        )?;
        let snapshot_query = || Query::ContextSnapshot { project_id: "project".into() };
        let witness_query = || Query::ContextWitness { project_id: "project".into() };
        let mut writer = reader.try_clone()?;
        let snapshot = reader.transaction()?;
        let original = read(&snapshot, snapshot_query())?;
        assert_eq!(original["project"]["instructions"], "old instructions");
        assert_eq!(original["project"]["expert_allow"], "[\"expert\"]");
        assert_eq!(original["resources"][0]["value"], "old body");
        assert_eq!(original["todos"][0]["status"], "doing");
        assert_eq!(original["pins"][0]["itemTitle"], "Pinned title");
        assert_eq!(original["pins"][0]["note"], "pin note");

        let update = writer.transaction()?;
        update.execute_batch(
            "UPDATE projects SET instructions = 'new instructions', archived = 1, updated_at = 2 WHERE id = 'project';
             UPDATE project_resources SET enabled = 0 WHERE id = 'resource';
             UPDATE project_todos SET status = 'done' WHERE id = 'todo';
             DELETE FROM project_context_pins WHERE id = 'pin';",
        )?;
        update.commit()?;

        assert_eq!(read(&snapshot, snapshot_query())?, original);
        assert_eq!(read(&snapshot, witness_query())?, json!({ "enabledResourceIds": ["resource"], "pinnedItemIds": ["item"] }));
        snapshot.commit()?;

        let fresh = read(&reader, snapshot_query())?;
        assert_eq!(fresh["project"]["instructions"], "new instructions");
        assert_eq!(fresh["project"]["archived"], 1);
        assert_eq!(fresh["resources"][0]["enabled"], 0);
        assert_eq!(fresh["todos"][0]["status"], "done");
        assert_eq!(fresh["pins"], json!([]));
        assert_eq!(read(&reader, witness_query())?, json!({ "enabledResourceIds": [], "pinnedItemIds": [] }));
        assert_eq!(read(&reader, Query::ContextSnapshot { project_id: "missing".into() })?, Value::Null);
        assert_eq!(read(&reader, Query::ContextWitness { project_id: "missing".into() })?, Value::Null);
        Ok(())
    }
}

fn memories(db: &Connection, project: &str) -> Result<Value> {
    if !exists(db, project)? {
        return Ok(Value::Null);
    }
    let rows = records(db,
        "SELECT m.id,m.kind,m.title,m.content,m.status,m.importance,m.created_at AS createdAt,m.updated_at AS updatedAt,
           m.source_type AS sourceType,m.source_task_id AS sourceTaskId,m.metadata_json
         FROM memory_records m JOIN memory_scopes s ON s.memory_id=m.id
         WHERE s.scope_type='project' AND s.scope_id=?1 AND m.status IN ('active','superseded','resolved')
         ORDER BY m.importance DESC,m.explicit DESC,m.updated_at DESC LIMIT 2000", [project])?;
    let mut seen = HashSet::new();
    let mut mem_ids = Vec::new();
    let mut deduped = Vec::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(Value::as_str).map(str::to_owned) else {
            return Err("missing project memory id".into());
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        mem_ids.push(id);
        deduped.push(row);
    }
    let mut ev_map: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
    if !mem_ids.is_empty() {
        let slots = crate::database::anon_placeholders(mem_ids.len());
        let mut stmt = db.prepare(&format!(
            "SELECT memory_id,id,evidence_kind,ref_id,ref_title,created_at
             FROM memory_evidence WHERE memory_id IN ({slots}) ORDER BY created_at"
        ))?;
        let mut ev_rows = stmt.query(duckdb::params_from_iter(mem_ids.iter()))?;
        while let Some(r) = ev_rows.next()? {
            let mid: String = r.get(0)?;
            ev_map.entry(mid).or_default().push(json!({
                "id": r.get::<_, String>(1)?,
                "evidenceKind": r.get::<_, String>(2)?,
                "refId": r.get::<_, Option<String>>(3)?,
                "refTitle": r.get::<_, Option<String>>(4)?,
                "createdAt": r.get::<_, i64>(5)?,
            }));
        }
    }
    let mut result = Vec::with_capacity(deduped.len());
    for mut row in deduped {
        let item = row.as_object_mut().ok_or("invalid project memory row")?;
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .ok_or("missing project memory id")?
            .to_owned();
        let metadata = item
            .remove("metadata_json")
            .and_then(|raw| serde_json::from_str(raw.as_str()?).ok())
            .unwrap_or_default();
        item.insert("metadata".into(), Value::Object(metadata));
        item.insert(
            "evidence".into(),
            Value::Array(ev_map.remove(&id).unwrap_or_default()),
        );
        result.push(row);
    }
    Ok(result.into())
}

fn exists(db: &Connection, id: &str) -> duckdb::Result<bool> {
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
        IssueKind::BlockingOverdue => "due_at < ?2 AND status = 'doing' AND priority IS NOT DISTINCT FROM 'high'",
        IssueKind::Overdue => "due_at < ?2 AND NOT (status IS NOT DISTINCT FROM 'doing' AND priority IS NOT DISTINCT FROM 'high')",
        IssueKind::NearDue => "due_at >= ?2 AND due_at < ?3",
        _ => return Err("invalid plan issue type".into()),
    };
    let mut statement = db.prepare(&format!(
        "SELECT id,title,due_at FROM project_todos WHERE project_id = ?1 AND status IS DISTINCT FROM 'done' AND {predicate}
         ORDER BY updated_at DESC,id DESC LIMIT 5"
    ))?;
    let near_due_end = now.saturating_add(3 * DAY);
    let mut values: Vec<&dyn duckdb::ToSql> = vec![&id, &now];
    if matches!(kind, IssueKind::NearDue) {
        values.push(&near_due_end);
    }
    let records = statement
        .query_map(duckdb::params_from_iter(values), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<duckdb::Result<Vec<_>>>()?;
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
                    crate::database::row_bool(r, 3)?,
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
            "SELECT count(*), count(*) FILTER (WHERE archived = 0 AND status IS DISTINCT FROM 'completed' AND status IS DISTINCT FROM 'failed'),
                    count(*) FILTER (WHERE archived = 0 AND status = 'in_progress'),
                    count(*) FILTER (WHERE archived = 0 AND status = 'in_progress' AND updated_at < ?2), max(updated_at)
             FROM tasks WHERE project_id = ?1",
            params![id, stale_after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
    let (todo_count, doing_todos, overdue_todos, last_todo): (i64, i64, i64, Option<i64>) = db
        .query_row(
            "SELECT count(*), count(*) FILTER (WHERE status = 'doing'),
                    count(*) FILTER (WHERE status IS DISTINCT FROM 'done' AND due_at < ?2), max(updated_at)
             FROM project_todos WHERE project_id = ?1",
            params![id, now],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    let mut statement = db.prepare(
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
    let mut stale = db.prepare(
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

pub(crate) fn folder_relocation(db: &Connection) -> Result<Value> {
    use sha2::{Digest, Sha256};
    let mut data = json!({
        "spaces": records(db, "SELECT id,name,path,parent_id,archived FROM spaces ORDER BY id", [])?,
        "projects": records(db, "SELECT id,name,default_space_id,updated_at,archived FROM projects ORDER BY id", [])?,
        "tasks": records(db, "SELECT id,title,project_id,space_id FROM tasks ORDER BY id", [])?,
        "references": records(db, "SELECT id,title,value,project_id FROM project_resources WHERE kind='file' ORDER BY id", [])?,
        "runs": records(db, "SELECT cwd FROM external_agent_runs WHERE status IN ('starting','working','blocked') ORDER BY id", [])?,
        "artifacts": records(db, "SELECT * FROM artifacts ORDER BY id", [])?,
        "dependencies": records(db, "SELECT artifact_id,file_path,dependency_kind,created_at FROM artifact_file_dependencies ORDER BY artifact_id,file_path", [])?,
    });
    data["witness"] = json!(format!("{:x}", Sha256::digest(serde_json::to_vec(&data)?)));
    Ok(data)
}
