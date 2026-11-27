use crate::Result;
use duckdb::{Connection, OptionalExt, named_params};
use serde::{Deserialize, Deserializer, Serialize};

fn field<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    id: String,
    title: String,
    at: f64,
    updated_at: Option<f64>,
    preserve_title: bool,
    expected_title: Option<String>,
    preserve_workspace: bool,
    #[serde(default, deserialize_with = "field")]
    space_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "field")]
    project_id: Option<Option<String>>,
    status: Option<String>,
    session_file: Option<String>,
    cwd: Option<String>,
    welcome_mode: Option<String>,
    model_id: Option<String>,
    permission_mode: Option<String>,
    expert_id: Option<String>,
    #[serde(default, deserialize_with = "field")]
    mode_preset_id: Option<Option<String>>,
    workspace_fallback: Option<crate::workspace_persistence::TaskWorkspaceFallback>,
    #[serde(default, deserialize_with = "field")]
    start_at: Option<Option<f64>>,
    #[serde(default, deserialize_with = "field")]
    due_at: Option<Option<f64>>,
    #[serde(default, deserialize_with = "field")]
    space_sort_order: Option<Option<f64>>,
    is_favorited: Option<bool>,
    #[serde(default, deserialize_with = "field")]
    external_agent_pin_json: Option<Option<String>>,
    #[serde(default, deserialize_with = "field")]
    done_acked_at: Option<Option<f64>>,
}

impl Mutation {
    pub fn task_id(&self) -> &str {
        &self.id
    }

    pub fn may_create_workspace(&self) -> bool {
        self.workspace_fallback.is_some()
    }
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Saved { previous_project_id: Option<String> },
    MissingWorkspace,
    Rejected { message: String },
}

struct Previous {
    project_id: Option<String>,
    welcome_mode: Option<String>,
    has_session: bool,
    activity: Option<f64>,
    status: Option<String>,
}

pub fn write(db: &mut Connection, mutation: Mutation) -> Reply {
    match apply(db, mutation) {
        Ok(reply) => reply,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, mutation: Mutation) -> Result<Reply> {
    let tx = db.transaction()?;
    let previous = tx
        .prepare(
            "SELECT project_id,welcome_mode,coalesce(session_file,'')!='',
                CASE WHEN CAST(updated_at AS DOUBLE)>0
                     AND CAST(updated_at AS DOUBLE)<=1.7976931348623157e308 THEN CAST(updated_at AS DOUBLE) END,status
         FROM tasks WHERE id=?1",
        )?
        .query_row([&mutation.id], |row| {
            Ok(Previous {
                project_id: row.get(0)?,
                welcome_mode: row.get(1)?,
                has_session: row.get(2)?,
                activity: row.get(3)?,
                status: row.get(4)?,
            })
        })
        .optional()?;
    let previous_project = previous.as_ref().and_then(|row| row.project_id.as_deref());
    let writes_space =
        mutation.space_id.is_some() && !(previous.is_some() && mutation.preserve_workspace);
    let mut space = mutation.space_id.flatten();
    if let Some(requested_space) = space.as_deref().filter(|id| writes_space && !id.is_empty()) {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM spaces WHERE id=?1)",
            [requested_space],
            |row| row.get(0),
        )?;
        if !exists {
            let Some(fallback) = mutation.workspace_fallback.as_ref() else {
                return Ok(Reply::MissingWorkspace);
            };
            space = Some(
                crate::workspace_persistence::resolve_missing_task_workspace(
                    &tx,
                    requested_space,
                    fallback,
                    mutation.at as i64,
                )?,
            );
        }
    }
    if let (Some(previous), Some(mode)) = (&previous, mutation.welcome_mode.as_deref()) {
        if previous.welcome_mode.as_deref() == Some("general")
            && !mode.is_empty()
            && mode != "general"
        {
            return Err("通用任务的 Durable 后端已固定，请创建新任务以选择其他模式".into());
        }
        if previous.has_session && mode == "general" {
            return Err("旧 Pi 会话不能转换为 Durable 会话，请创建通用任务".into());
        }
    }
    if let Some(Some(project)) = &mutation.project_id {
        if !project.is_empty() {
            let archived: bool = tx
                .query_row(
                    "SELECT archived!=0 FROM projects WHERE id=?1",
                    [project],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| format!("项目不存在：{project}"))?;
            if archived && previous_project != Some(project) {
                return Err("归档项目不能绑定新任务；请先恢复项目".into());
            }
        }
    }
    let activity = previous
        .as_ref()
        .and_then(|row| row.activity)
        .into_iter()
        .chain(
            mutation
                .updated_at
                .filter(|time| time.is_finite() && *time > 0.0),
        )
        .reduce(f64::max)
        .unwrap_or(mutation.at);
    let fav_int = mutation.is_favorited.map(i64::from);
    tx.prepare(
        "INSERT INTO tasks (id,title,space_id,project_id,status,updated_at,session_file,cwd,welcome_mode,
                           model_id,permission_mode,expert_id,mode_preset_id,start_at,due_at,
                           space_sort_order,is_favorited,external_agent_pin_json,done_acked_at)
         VALUES ($id,coalesce(nullif($title,''),'任务'),$space,$project,$status,CAST($activity AS BIGINT),$session,$cwd,$mode,
                 $model,$permission,$expert,$preset,CAST($start AS BIGINT),CAST($due AS BIGINT),
                 CASE WHEN $has_sort THEN COALESCE(CAST($sort AS BIGINT), 0) ELSE 0 END,coalesce($favorite,0),$pin,CAST($ack AS BIGINT))
         ON CONFLICT(id) DO UPDATE SET
            title=CASE WHEN $preserve_title AND ($expected_title IS NULL OR tasks.title<>$expected_title)
                       THEN tasks.title ELSE coalesce(nullif($title,''),nullif(tasks.title,''),'任务') END,
            space_id=CASE WHEN $writes_space THEN $space ELSE tasks.space_id END,
            project_id=CASE WHEN $has_project THEN $project ELSE tasks.project_id END,
            status=coalesce($status,tasks.status), updated_at=CAST($activity AS BIGINT),
            session_file=coalesce($session,tasks.session_file), cwd=coalesce($cwd,tasks.cwd),
            welcome_mode=coalesce($mode,tasks.welcome_mode), model_id=coalesce($model,tasks.model_id),
            permission_mode=coalesce($permission,tasks.permission_mode), expert_id=coalesce($expert,tasks.expert_id),
            mode_preset_id=CASE WHEN $has_preset THEN $preset ELSE tasks.mode_preset_id END,
            start_at=CASE WHEN $has_start THEN CAST($start AS BIGINT) ELSE tasks.start_at END,
            due_at=CASE WHEN $has_due THEN CAST($due AS BIGINT) ELSE tasks.due_at END,
            space_sort_order=CASE WHEN $has_sort AND NOT $preserve_workspace THEN COALESCE(CAST($sort AS BIGINT), 0) ELSE tasks.space_sort_order END,
            is_favorited=coalesce($favorite,tasks.is_favorited),
            external_agent_pin_json=CASE WHEN $has_pin THEN $pin ELSE tasks.external_agent_pin_json END,
            done_acked_at=CASE WHEN $has_ack THEN CAST($ack AS BIGINT) ELSE tasks.done_acked_at END",
    )?.execute(named_params! {
        "id": mutation.id, "title": mutation.title, "preserve_title": mutation.preserve_title,
        "expected_title": mutation.expected_title, "preserve_workspace": mutation.preserve_workspace,
        "space": if writes_space { space.as_deref() } else { None }, "writes_space": writes_space,
        "project": mutation.project_id.as_ref().and_then(|id| id.as_deref()), "has_project": mutation.project_id.is_some(),
        "status": mutation.status, "activity": activity, "session": mutation.session_file, "cwd": mutation.cwd,
        "mode": mutation.welcome_mode, "model": mutation.model_id, "permission": mutation.permission_mode,
        "expert": mutation.expert_id, "preset": mutation.mode_preset_id.as_ref().and_then(|id| id.as_deref()),
        "has_preset": mutation.mode_preset_id.is_some(), "has_start": mutation.start_at.is_some(),
        "start": mutation.start_at.flatten(), "has_due": mutation.due_at.is_some(), "due": mutation.due_at.flatten(),
        "has_sort": mutation.space_sort_order.is_some(), "sort": mutation.space_sort_order.flatten(), "favorite": fav_int,
        "has_pin": mutation.external_agent_pin_json.is_some(), "pin": mutation.external_agent_pin_json.flatten(),
        "has_ack": mutation.done_acked_at.is_some(), "ack": mutation.done_acked_at.flatten(),
    })?;
    if matches!(mutation.status.as_deref(), Some("completed" | "failed"))
        && previous.as_ref().and_then(|row| row.status.as_deref()) != mutation.status.as_deref()
    {
        let at = if previous.is_some() {
            activity.max(mutation.at)
        } else {
            activity
        };
        crate::trigger_effects::on_task_ended_in_tx(&tx, &mutation.id, at.round() as i64)?;
    }
    crate::request_control::commit(tx)?;
    Ok(Reply::Saved {
        previous_project_id: previous.and_then(|row| row.project_id),
    })
}
