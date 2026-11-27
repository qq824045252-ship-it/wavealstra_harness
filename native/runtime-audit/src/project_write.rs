use crate::{Result, scoped_notes::library_owner_writable};
use crate::{project_memory_forget, project_memory_write};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    name: String,
    description: Option<String>,
    instructions: Option<String>,
    goal: Option<String>,
    current_stage: Option<String>,
    default_space_id: Option<String>,
    resource_budget_chars: i64,
    template_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    id: String,
    project_id: String,
    kind: String,
    title: String,
    value: String,
    enabled: bool,
    sort_order: i64,
    parent_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    id: String,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    id: String,
    project_id: String,
    title: String,
    description: Option<String>,
    status: String,
    assignee: Option<String>,
    priority: Option<String>,
    tags_json: String,
    start_at: Option<f64>,
    due_at: Option<f64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    id: String,
    project_id: String,
    reviewed_at: i64,
    note: Option<String>,
    created_by: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Create {
        project: Project,
        policies_json: String,
        resources: Vec<Resource>,
        source: Option<Version>,
    },
    Edit {
        project: Project,
        expected_updated_at: i64,
        default_space_path: Option<String>,
        policies_json: Option<String>,
    },
    Archive {
        id: String,
        archived: bool,
        updated_at: i64,
    },
    SaveResource {
        resource: Resource,
        expected_updated_at: i64,
        create: bool,
    },
    DeleteResource {
        id: String,
        project_id: String,
        expected_updated_at: i64,
        updated_at: i64,
    },
    SaveTodo {
        todo: Todo,
        expected_updated_at: Option<i64>,
        source_task_id: Option<String>,
    },
    DeleteTodo {
        id: String,
        project_id: String,
        updated_at: i64,
    },
    RecordReview {
        review: Review,
        actor_task_id: Option<String>,
    },
    PromoteEventToTodo {
        todo: Todo,
        event_id: String,
        promotion_id: String,
        promoted_by: String,
        created_at: i64,
        source_task_id: Option<String>,
    },
    CreateMemory {
        project_id: String,
        memory: project_memory_write::Memory,
        actor_task_id: Option<String>,
        promotion: Option<project_memory_write::Promotion>,
    },
    EditMemory {
        project_id: String,
        edit: project_memory_write::Edit,
        actor_task_id: Option<String>,
    },
    DetachMemory {
        project_id: String,
        id: String,
        withdrawal: project_memory_forget::Withdrawal,
    },
}

#[derive(Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Changed,
    Missing,
    Stale,
    Archived,
    NameTaken,
    InvalidSpace,
    InvalidParent,
    ScopeChanged,
    MissingEvent,
    ExistingPromotion,
    InvalidEvidence,
    MissingMemory,
    SharedMemory,
    Unchanged,
}

pub fn write(db: &mut Connection, operation_id: &str, mutation: Mutation) -> Result<Status> {
    let tx = db.transaction()?;
    if has_receipt(&tx, operation_id)? {
        return Ok(Status::Changed);
    }
    let status = apply(&tx, mutation)?;
    if status == Status::Changed {
        record_receipt(&tx, operation_id)?;
        tx.commit()?;
    }
    Ok(status)
}

pub(crate) fn has_receipt(db: &Connection, operation_id: &str) -> duckdb::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_write_receipts WHERE operation_id=?1)",
        [operation_id],
        |row| row.get(0),
    )
}

pub(crate) fn record_receipt(db: &Connection, operation_id: &str) -> duckdb::Result<()> {
    let inserted = db.execute(
        "INSERT INTO project_write_receipts(operation_id) VALUES (?1)",
        [operation_id],
    )?;
    if inserted != 1 {
        return Err(duckdb::Error::StatementChangedRows(inserted));
    }
    db.execute(
        "DELETE FROM project_write_receipts WHERE rowid <= (SELECT COALESCE(MAX(rowid), 0) - 2048 FROM project_write_receipts)",
        [],
    )?;
    Ok(())
}

fn apply(db: &Connection, mutation: Mutation) -> duckdb::Result<Status> {
    match mutation {
        Mutation::Create {
            project,
            policies_json,
            resources,
            source,
        } => {
            if let Some(source) = source
                && project_version(db, &source.id)?.map(|row| row.0) != Some(source.updated_at)
            {
                return Ok(Status::Stale);
            }
            if name_taken(db, &project)? {
                return Ok(Status::NameTaken);
            }
            db.execute("INSERT INTO projects(id,name,description,instructions,goal,current_stage,default_space_id,
                resource_budget_chars,template_id,created_at,updated_at,archived) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0)",
                params![project.id,project.name,project.description,project.instructions,project.goal,project.current_stage,
                    project.default_space_id,project.resource_budget_chars,project.template_id,project.created_at,project.updated_at])?;
            write_policies(db, &project.id, &policies_json)?;
            for resource in &resources {
                insert_resource(db, resource)?;
            }
        }
        Mutation::Edit {
            project,
            expected_updated_at,
            default_space_path,
            policies_json,
        } => {
            let status = writable_version(db, &project.id, expected_updated_at)?;
            if status != Status::Changed {
                return Ok(status);
            }
            if name_taken(db, &project)? {
                return Ok(Status::NameTaken);
            }
            if let (Some(id), Some(path)) = (&project.default_space_id, default_space_path) {
                if !library_owner_writable(db, None, Some(id))?
                    || !db.query_row(
                        "SELECT EXISTS(SELECT 1 FROM spaces WHERE id=?1 AND path=?2)",
                        params![id, path],
                        |row| row.get::<_, bool>(0),
                    )?
                {
                    return Ok(Status::InvalidSpace);
                }
            }
            db.execute("UPDATE projects SET name=?2,description=?3,instructions=?4,goal=?5,current_stage=?6,
                default_space_id=?7,resource_budget_chars=?8,updated_at=?9 WHERE id=?1",
                params![project.id,project.name,project.description,project.instructions,project.goal,project.current_stage,
                    project.default_space_id,project.resource_budget_chars,project.updated_at])?;
            if let Some(policies) = policies_json {
                write_policies(db, &project.id, &policies)?;
            }
        }
        Mutation::Archive {
            id,
            archived,
            updated_at,
        } => {
            if db.execute(
                "UPDATE projects SET archived=?2, updated_at=GREATEST(updated_at+1, ?3) WHERE id=?1",
                params![id, archived, updated_at],
            )? == 0
            {
                return Ok(Status::Missing);
            }
        }
        Mutation::SaveResource {
            resource,
            expected_updated_at,
            create,
        } => {
            let status = writable_version(db, &resource.project_id, expected_updated_at)?;
            if status != Status::Changed {
                return Ok(status);
            }
            if !valid_parent(db, &resource)? {
                return Ok(Status::InvalidParent);
            }
            if create {
                insert_resource(db, &resource)?;
            } else if db.execute(
                "UPDATE project_resources SET title=?3,value=?4,enabled=?5,sort_order=?6,
                parent_id=?7,updated_at=?8 WHERE id=?1 AND project_id=?2",
                params![
                    resource.id,
                    resource.project_id,
                    resource.title,
                    resource.value,
                    resource.enabled,
                    resource.sort_order,
                    resource.parent_id,
                    resource.updated_at
                ],
            )? == 0
            {
                return Ok(Status::Missing);
            }
            touch(db, &resource.project_id, resource.updated_at)?;
        }
        Mutation::DeleteResource {
            id,
            project_id,
            expected_updated_at,
            updated_at,
        } => {
            let status = writable_version(db, &project_id, expected_updated_at)?;
            if status != Status::Changed {
                return Ok(status);
            }
            if db.execute(
                "DELETE FROM project_resources WHERE id=?1 AND project_id=?2",
                params![id, project_id],
            )? == 0
            {
                return Ok(Status::Missing);
            }
            touch(db, &project_id, updated_at)?;
        }
        Mutation::SaveTodo {
            todo,
            expected_updated_at,
            source_task_id,
        } => {
            let status = writable_project_scope(db, &todo.project_id, source_task_id.as_deref())?;
            if status != Status::Changed {
                return Ok(status);
            }
            let changed = if let Some(expected) = expected_updated_at {
                db.execute("UPDATE project_todos SET title=?3,description=?4,status=?5,assignee=?6,priority=?7,tags_json=?8,
                    start_at=?9,due_at=?10,updated_at=?11 WHERE id=?1 AND project_id=?2 AND updated_at=?12",
                    params![todo.id,todo.project_id,todo.title,todo.description,todo.status,todo.assignee,todo.priority,
                        todo.tags_json,todo.start_at,todo.due_at,todo.updated_at,expected])?
            } else {
                insert_todo(db, &todo)?
            };
            if changed == 0 {
                return Ok(Status::Stale);
            }
            touch(db, &todo.project_id, todo.updated_at)?;
        }
        Mutation::DeleteTodo {
            id,
            project_id,
            updated_at,
        } => {
            let status = writable_project(db, &project_id, None)?;
            if status != Status::Changed {
                return Ok(status);
            }
            if db.execute(
                "DELETE FROM project_todos WHERE id=?1 AND project_id=?2",
                params![id, project_id],
            )? == 0
            {
                return Ok(Status::Missing);
            }
            db.execute("DELETE FROM work_graph_edges WHERE (from_type='plan' AND from_id=?1) OR (to_type='plan' AND to_id=?1)", [&id])?;
            touch(db, &project_id, updated_at)?;
        }
        Mutation::PromoteEventToTodo {
            todo,
            event_id,
            promotion_id,
            promoted_by,
            created_at,
            source_task_id,
        } => {
            let status = writable_project_scope(db, &todo.project_id, source_task_id.as_deref())?;
            if status != Status::Changed {
                return Ok(status);
            }
            let Some(title) = db
                .query_row(
                    "SELECT title FROM project_events WHERE id=?1 AND project_id=?2",
                    params![event_id, todo.project_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            else {
                return Ok(Status::MissingEvent);
            };
            if db.query_row("SELECT EXISTS(SELECT 1 FROM project_event_promotions WHERE project_id=?1 AND event_id=?2 AND target_kind='todo')",
                params![todo.project_id, event_id], |row| row.get::<_, bool>(0))? {
                return Ok(Status::ExistingPromotion);
            }
            if insert_todo(db, &todo)? != 1 {
                return Err(duckdb::Error::StatementChangedRows(0));
            }
            let inserted = db.execute("INSERT INTO project_event_promotions(id,project_id,event_id,event_title,target_kind,target_id,target_title,promoted_by,created_at)
                VALUES (?1,?2,?3,?4,'todo',?5,?6,?7,?8)",
                params![promotion_id,todo.project_id,event_id,title,todo.id,todo.title,promoted_by,created_at])?;
            if inserted != 1 {
                return Err(duckdb::Error::StatementChangedRows(inserted));
            }
            touch(db, &todo.project_id, todo.updated_at)?;
        }
        Mutation::RecordReview {
            review,
            actor_task_id,
        } => {
            let status = writable_project_scope(db, &review.project_id, actor_task_id.as_deref())?;
            if status != Status::Changed {
                return Ok(status);
            }
            let inserted = db.execute(
                "INSERT INTO project_reviews (id,project_id,reviewed_at,note,created_by) VALUES (?1,?2,?3,?4,?5)",
                params![review.id, review.project_id, review.reviewed_at, review.note, review.created_by],
            )?;
            if inserted != 1 {
                return Err(duckdb::Error::StatementChangedRows(inserted));
            }
        }
        Mutation::CreateMemory {
            project_id,
            memory,
            actor_task_id,
            promotion,
        } => {
            return project_memory_write::create(
                db,
                &project_id,
                memory,
                actor_task_id.as_deref(),
                promotion,
            );
        }
        Mutation::EditMemory {
            project_id,
            edit,
            actor_task_id,
        } => {
            return project_memory_write::edit(db, &project_id, edit, actor_task_id.as_deref());
        }
        Mutation::DetachMemory {
            project_id,
            id,
            withdrawal,
        } => {
            return project_memory_write::detach(db, &project_id, &id, withdrawal);
        }
    }
    Ok(Status::Changed)
}

pub(crate) fn writable_project_scope(
    db: &Connection,
    project_id: &str,
    source_task_id: Option<&str>,
) -> duckdb::Result<Status> {
    if let Some(task_id) = source_task_id
        && !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND project_id=?2)",
            params![task_id, project_id],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Ok(Status::ScopeChanged);
    }
    writable_project(db, project_id, None)
}

fn insert_todo(db: &Connection, todo: &Todo) -> duckdb::Result<usize> {
    db.execute("INSERT INTO project_todos(id,project_id,title,description,status,assignee,priority,tags_json,start_at,due_at,created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![todo.id,todo.project_id,todo.title,todo.description,todo.status,todo.assignee,todo.priority,
            todo.tags_json,todo.start_at,todo.due_at,todo.created_at,todo.updated_at])
}

fn name_taken(db: &Connection, project: &Project) -> duckdb::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE lower(name)=lower(?1) AND id<>?2)",
        params![project.name, project.id],
        |row| row.get(0),
    )
}

fn project_version(db: &Connection, id: &str) -> duckdb::Result<Option<(i64, bool)>> {
    db.query_row(
        "SELECT updated_at,archived FROM projects WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, crate::database::row_bool(row, 1)?)),
    )
    .optional()
}

fn writable_version(db: &Connection, id: &str, expected: i64) -> duckdb::Result<Status> {
    writable_project(db, id, Some(expected))
}

fn writable_project(db: &Connection, id: &str, expected: Option<i64>) -> duckdb::Result<Status> {
    Ok(match project_version(db, id)? {
        None => Status::Missing,
        Some((_, true)) => Status::Archived,
        Some((updated_at, false)) if expected.is_some_and(|expected| updated_at != expected) => {
            Status::Stale
        }
        Some(_) => Status::Changed,
    })
}

pub(crate) fn touch(db: &Connection, id: &str, now: i64) -> duckdb::Result<()> {
    db.execute(
        "UPDATE projects SET updated_at=GREATEST(updated_at+1, ?2) WHERE id=?1",
        params![id, now],
    )?;
    Ok(())
}

fn valid_parent(db: &Connection, resource: &Resource) -> duckdb::Result<bool> {
    let Some(parent) = &resource.parent_id else {
        return Ok(true);
    };
    db.query_row("WITH RECURSIVE chain AS (
        SELECT id,parent_id FROM project_resources WHERE id=?1 AND project_id=?2 AND kind='folder'
        UNION SELECT p.id,p.parent_id FROM project_resources p JOIN chain c ON p.id=c.parent_id WHERE p.project_id=?2
        ) SELECT EXISTS(SELECT 1 FROM chain) AND NOT EXISTS(SELECT 1 FROM chain WHERE id=?3)",
        params![parent,resource.project_id,resource.id], |row| row.get(0))
}

fn insert_resource(db: &Connection, resource: &Resource) -> duckdb::Result<()> {
    db.execute("INSERT INTO project_resources(id,project_id,kind,title,value,enabled,sort_order,parent_id,created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![resource.id,resource.project_id,resource.kind,resource.title,resource.value,resource.enabled,
            resource.sort_order,resource.parent_id,resource.created_at,resource.updated_at])?;
    Ok(())
}

fn write_policies(db: &Connection, id: &str, json: &str) -> duckdb::Result<()> {
    let parsed: serde_json::Value = serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
    let ser = |v: &serde_json::Value| -> Option<String> {
        if v.is_null() {
            None
        } else {
            serde_json::to_string(v).ok()
        }
    };
    db.execute(
        "INSERT INTO project_expert_policy(project_id,allow_json,deny_json,recommended_json)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(project_id) DO UPDATE SET allow_json=excluded.allow_json,deny_json=excluded.deny_json,recommended_json=excluded.recommended_json",
        params![id, ser(&parsed["expert"]["allow"]), ser(&parsed["expert"]["deny"]), ser(&parsed["expert"]["recommended"])],
    )?;
    db.execute(
        "INSERT INTO project_skill_policy(project_id,prefer_json,demote_json,hide_json,allow_json)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(project_id) DO UPDATE SET prefer_json=excluded.prefer_json,demote_json=excluded.demote_json,hide_json=excluded.hide_json,allow_json=excluded.allow_json",
        params![id, ser(&parsed["skill"]["prefer"]), ser(&parsed["skill"]["demote"]), ser(&parsed["skill"]["hide"]), ser(&parsed["skill"]["allow"])],
    )?;
    db.execute(
        "INSERT INTO project_connector_policy(project_id,allow_json,deny_json,recommended_json)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(project_id) DO UPDATE SET allow_json=excluded.allow_json,deny_json=excluded.deny_json,recommended_json=excluded.recommended_json",
        params![id, ser(&parsed["connector"]["allow"]), ser(&parsed["connector"]["deny"]), ser(&parsed["connector"]["recommended"])],
    )?;
    let mcp_mode = parsed["mcp"]["mode"].as_str().map(str::to_owned);
    db.execute(
        "INSERT INTO project_mcp_policy(project_id,mode,allow_json,deny_json)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode,allow_json=excluded.allow_json,deny_json=excluded.deny_json",
        params![id, mcp_mode, ser(&parsed["mcp"]["allow"]), ser(&parsed["mcp"]["deny"])],
    )?;
    Ok(())
}
