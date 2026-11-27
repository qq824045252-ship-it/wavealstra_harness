use crate::Result;
use duckdb::Connection;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub struct TaskRow {
    id: String,
    title: String,
    space_id: Option<String>,
    project_id: Option<String>,
    status: Option<String>,
    updated_at: i64,
    session_file: Option<String>,
    cwd: Option<String>,
    welcome_mode: Option<String>,
    model_id: Option<String>,
    permission_mode: Option<String>,
    archived: i64,
    expert_id: Option<String>,
    mode_preset_id: Option<String>,
    start_at: Option<i64>,
    due_at: Option<i64>,
    space_sort_order: i64,
    is_favorited: i64,
    external_agent_pin_json: Option<String>,
    done_acked_at: Option<i64>,
    gateway_sidebar_channel_id: Option<String>,
    #[serde(rename = "expertBinding", skip_serializing_if = "Option::is_none")]
    expert_binding: Option<ExpertBinding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpertBinding {
    task_id: String,
    desired: Value,
    active: Value,
    pending: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<String>,
}

fn snapshot(raw: Option<String>) -> Result<Value> {
    match raw.filter(|raw| !raw.is_empty()) {
        Some(raw) => Ok(serde_json::from_str(&raw)?),
        None => Ok(Value::Null),
    }
}

pub fn read(
    db: &Connection,
    dots_task_id: &str,
    include_expert_bindings: bool,
) -> Result<Vec<TaskRow>> {
    read_rows(db, dots_task_id, include_expert_bindings, false)
}

pub fn read_task(
    db: &Connection,
    task_id: &str,
    include_expert_bindings: bool,
) -> Result<Option<TaskRow>> {
    Ok(read_rows(db, task_id, include_expert_bindings, true)?.pop())
}

fn read_rows(
    db: &Connection,
    id: &str,
    include_expert_bindings: bool,
    exact: bool,
) -> Result<Vec<TaskRow>> {
    let (binding_columns, binding_join) = if include_expert_bindings {
        (
            ", e.task_id AS binding_task_id, e.desired_json, e.active_json, e.warnings_json",
            "LEFT JOIN task_expert_bindings e ON e.task_id = t.id",
        )
    } else {
        ("", "")
    };
    let filter = if exact {
        "t.id=?1"
    } else {
        "t.id != ?1 AND NOT EXISTS (
            SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed'
        )"
    };
    let mut statement = db.prepare(&format!(
        "SELECT t.id, t.title, t.space_id, t.project_id, t.status, t.updated_at, t.session_file,
                t.cwd, t.welcome_mode, t.model_id, t.permission_mode, t.archived, t.expert_id,
                t.mode_preset_id, t.start_at, t.due_at, t.space_sort_order, t.is_favorited,
                t.external_agent_pin_json, t.done_acked_at, g.channel_id AS gateway_sidebar_channel_id
                {binding_columns}
         FROM tasks t
         LEFT JOIN gateway_sidebar_conversations g ON g.task_id = t.id
         {binding_join}
         WHERE {filter}
         ORDER BY t.updated_at DESC, t.rowid"
    ))?;
    let mut rows = statement.query([id])?;
    let mut tasks = Vec::new();
    while let Some(row) = rows.next()? {
        let expert_binding = if include_expert_bindings
            && let Some(task_id) = row.get::<_, Option<String>>("binding_task_id")?
        {
            let desired = snapshot(row.get("desired_json")?)?;
            let active = snapshot(row.get("active_json")?)?;
            Some(ExpertBinding {
                task_id,
                pending: desired.get("revision").unwrap_or(&Value::Null)
                    != active.get("revision").unwrap_or(&Value::Null),
                desired,
                active,
                warnings: serde_json::from_str(&row.get::<_, String>("warnings_json")?)?,
            })
        } else {
            None
        };
        tasks.push(TaskRow {
            id: row.get("id")?,
            title: row.get("title")?,
            space_id: row.get("space_id")?,
            project_id: row.get("project_id")?,
            status: row.get("status")?,
            updated_at: row.get("updated_at")?,
            session_file: row.get("session_file")?,
            cwd: row.get("cwd")?,
            welcome_mode: row.get("welcome_mode")?,
            model_id: row.get("model_id")?,
            permission_mode: row.get("permission_mode")?,
            archived: row.get("archived")?,
            expert_id: row.get("expert_id")?,
            mode_preset_id: row.get("mode_preset_id")?,
            start_at: row.get("start_at")?,
            due_at: row.get("due_at")?,
            space_sort_order: row.get("space_sort_order")?,
            is_favorited: row.get("is_favorited")?,
            external_agent_pin_json: row.get("external_agent_pin_json")?,
            done_acked_at: row.get("done_acked_at")?,
            gateway_sidebar_channel_id: row.get("gateway_sidebar_channel_id")?,
            expert_binding,
        });
    }
    Ok(tasks)
}
