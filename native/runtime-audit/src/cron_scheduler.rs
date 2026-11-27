//! Step 6.1: Rust Core authoritative Cron scheduler, sleep/clock-jump recovery,
//! occurrence identity deduplication, and Core execution-bridge dispatch.

use crate::business_protocol::{
    ClientContext, EmittedEvent, ExecutorTracker, WriteSideEffects, append_event,
    current_core_generation, dispatch_waiting_executions, ensure_tables as ensure_protocol_tables,
};
use crate::work_scheduler::{ParsedCron, cron_next_wake, now_ms, sha256_hex};
use crate::{DOTS_NO_CHANGE, DOTS_TASK_ID};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const BUSY_TASK_SKIP: &str = "目标任务正忙，已跳过，未排队";
const CRON_SKIP_GRACE_MS: i64 = 60_000;
const MAX_TICK_JOBS_PER_PASS: usize = 64;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCronConfig {
    #[serde(default = "default_followup_mode")]
    pub dots_followup_mode: String,
    #[serde(default)]
    pub dots_space_ids: Option<Vec<String>>,
    #[serde(default)]
    pub dots_suspended: bool,
    #[serde(default)]
    pub default_model_id: Option<String>,
    #[serde(default)]
    pub skill_names: Map<String, Value>,
    #[serde(default)]
    pub connectors: Map<String, Value>,
    #[serde(default)]
    pub started: bool,
    #[serde(default)]
    pub last_tick_at_ms: Option<i64>,
}

fn default_followup_mode() -> String {
    "continue".to_owned()
}

fn present_scope<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<Vec<String>>>, D::Error> {
    Option::deserialize(d).map(Some)
}

#[derive(Clone, Debug)]
struct CronJobRow {
    id: String,
    name: String,
    prompt: String,
    schedule_type: String,
    schedule_expr: String,
    timezone: String,
    space_id: Option<String>,
    cwd: Option<String>,
    enabled: bool,
    created_at: i64,
    updated_at: i64,
    last_run_at: Option<i64>,
    permission_mode: Option<String>,
    model_id: Option<String>,
    expert_id: Option<String>,
    skill_ids: Vec<String>,
    connector_ids: Vec<String>,
    effective_from: Option<i64>,
    effective_to: Option<i64>,
    welcome_mode: Option<String>,
    project_id: Option<String>,
    run_count: i64,
    source_task_id: Option<String>,
    target_kind: Option<String>,
    target_task_id: Option<String>,
    is_reminder: bool,
    max_runs: Option<i64>,
    restart_policy: Option<String>,
    missed_runs: String,
    cancelled_at: Option<i64>,
}

impl CronJobRow {
    fn schedule_signature(&self) -> String {
        sha256_hex(&format!(
            "{}|{}|{}|{:?}|{:?}|{:?}|{}|{}",
            self.schedule_type,
            self.schedule_expr,
            self.timezone,
            self.effective_from,
            self.effective_to,
            self.max_runs,
            self.created_at,
            self.missed_runs
        ))
    }

    fn is_dots(&self) -> bool {
        self.source_task_id.as_deref() == Some(DOTS_TASK_ID)
    }

    fn to_dto_json(&self, next_run_at: Option<i64>) -> Value {
        let mut obj = Map::new();
        obj.insert("id".into(), Value::String(self.id.clone()));
        obj.insert("name".into(), Value::String(self.name.clone()));
        obj.insert("prompt".into(), Value::String(self.prompt.clone()));
        obj.insert(
            "scheduleType".into(),
            Value::String(self.schedule_type.clone()),
        );
        obj.insert(
            "scheduleExpr".into(),
            Value::String(self.schedule_expr.clone()),
        );
        obj.insert("timezone".into(), Value::String(self.timezone.clone()));
        if let Some(v) = &self.space_id {
            obj.insert("spaceId".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.cwd {
            obj.insert("cwd".into(), Value::String(v.clone()));
        }
        obj.insert(
            "enabled".into(),
            Value::Bool(if self.is_reminder { false } else { self.enabled }),
        );
        obj.insert("createdAt".into(), json!(self.created_at));
        obj.insert("updatedAt".into(), json!(self.updated_at));
        if let Some(v) = self.last_run_at {
            obj.insert("lastRunAt".into(), json!(v));
        }
        if let Some(v) = &self.permission_mode {
            obj.insert("permissionMode".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.welcome_mode {
            obj.insert("welcomeMode".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.model_id {
            obj.insert("modelId".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.expert_id {
            obj.insert("expertId".into(), Value::String(v.clone()));
        }
        if !self.skill_ids.is_empty() {
            obj.insert("skillIds".into(), json!(self.skill_ids));
        }
        if !self.connector_ids.is_empty() {
            obj.insert("connectorIds".into(), json!(self.connector_ids));
        }
        if let Some(v) = self.effective_from {
            obj.insert("effectiveFrom".into(), json!(v));
        }
        if let Some(v) = self.effective_to {
            obj.insert("effectiveTo".into(), json!(v));
        }
        if let Some(v) = &self.project_id {
            obj.insert("projectId".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.source_task_id {
            obj.insert("sourceTaskId".into(), Value::String(v.clone()));
        }
        if let Some(kind) = &self.target_kind {
            if kind == "task" {
                if let Some(tid) = &self.target_task_id {
                    obj.insert("target".into(), json!({ "kind": "task", "taskId": tid }));
                }
            } else {
                obj.insert("target".into(), json!({ "kind": "new-task" }));
            }
        }
        if let Some(v) = self.max_runs {
            obj.insert("maxRuns".into(), json!(v));
        }
        if let Some(v) = &self.restart_policy {
            obj.insert("restartPolicy".into(), Value::String(v.clone()));
        }
        if !self.missed_runs.is_empty() {
            obj.insert("missedRuns".into(), Value::String(self.missed_runs.clone()));
        }
        if let Some(v) = self.cancelled_at {
            obj.insert("cancelledAt".into(), json!(v));
        }
        obj.insert("runCount".into(), json!(self.run_count));
        if let Some(next) = next_run_at
            && !self.is_reminder
        {
            obj.insert("nextRunAt".into(), json!(next));
        }
        Value::Object(obj)
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Status {
        job_id: Option<String>,
        limit: Option<i64>,
    },
    NextRun {
        job_id: String,
        now_ms: Option<i64>,
    },
    SyncConfig {
        dots_followup_mode: Option<String>,
        #[serde(default, deserialize_with = "present_scope")]
        dots_space_ids: Option<Option<Vec<String>>>,
        dots_suspended: Option<bool>,
        default_model_id: Option<Option<String>>,
        skill_names: Option<Map<String, Value>>,
        connectors: Option<Map<String, Value>>,
    },
    Start {
        now_ms: Option<i64>,
    },
    ScanRecovery {
        now_ms: Option<i64>,
    },
    Tick {
        now_ms: Option<i64>,
        simulate_sleep_jump: Option<bool>,
    },
    RunNow {
        job_id: String,
        now_ms: Option<i64>,
    },
    RefreshJob {
        job_id: Option<String>,
        restoring: Option<bool>,
        now_ms: Option<i64>,
    },
    SetDotsProactive {
        source: String,
        space_id: Option<String>,
        pause: bool,
    },
    Stop,
}

impl Command {
    pub fn is_read_only(&self) -> bool {
        matches!(self, Command::Status { .. } | Command::NextRun { .. })
    }
}

pub fn ensure_cron_scheduler_tables(_db: &Connection) -> crate::Result<()> {
    Ok(())
}

fn load_config(db: &Connection) -> crate::Result<RuntimeCronConfig> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value_json FROM core_cron_runtime_config WHERE key = 'runtime'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

fn save_config(tx: &Connection, cfg: &RuntimeCronConfig) -> crate::Result<()> {
    tx.execute(
        "INSERT INTO core_cron_runtime_config (key, value_json) VALUES ('runtime', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        [serde_json::to_string(cfg)?],
    )?;
    Ok(())
}

fn parse_every_expr(expr: &str) -> std::result::Result<i64, String> {
    let trimmed = expr.trim();
    if trimmed.len() < 2 {
        return Err("Interval must be a positive integer followed by s, m, h or d".into());
    }
    let (num_str, unit) = trimmed.split_at(trimmed.len() - 1);
    let n: i64 = num_str
        .parse()
        .map_err(|_| "Interval must be a positive integer followed by s, m, h or d".to_owned())?;
    if n <= 0 {
        return Err("Interval must be a positive integer followed by s, m, h or d".into());
    }
    let mul: i64 = match unit.to_ascii_lowercase().as_str() {
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return Err("Interval must be a positive integer followed by s, m, h or d".into()),
    };
    n.checked_mul(mul)
        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
        .ok_or_else(|| "Interval overflow".to_owned())
}

pub(crate) fn parse_iso8601_utc_ms(expr: &str) -> Option<i64> {
    let s = expr.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(ms) = s.parse::<i64>() {
        return Some(ms);
    }
    // Accept YYYY-MM-DD or YYYY-MM-DDTHH:MM(:SS(.fff)?)?(Z|[+-]HH:MM)
    let (date_part, rest) = match s.find(['T', ' ']) {
        Some(idx) => (&s[..idx], Some(&s[idx + 1..])),
        None => (s, None),
    };
    let mut dp = date_part.split('-');
    let year: i32 = dp.next()?.parse().ok()?;
    let month: u32 = dp.next()?.parse().ok()?;
    let day: u32 = dp.next()?.parse().ok()?;
    if dp.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut hour: i64 = 0;
    let mut minute: i64 = 0;
    let mut second: i64 = 0;
    let mut millis: i64 = 0;
    let mut offset_minutes: i64 = 0;
    if let Some(time_and_tz) = rest {
        let (time_part, tz_part) = if let Some(stripped) = time_and_tz.strip_suffix('Z') {
            (stripped, "Z")
        } else if let Some(stripped) = time_and_tz.strip_suffix('z') {
            (stripped, "Z")
        } else if let Some(pos) = time_and_tz.rfind(['+', '-']) {
            (&time_and_tz[..pos], &time_and_tz[pos..])
        } else {
            (time_and_tz, "")
        };
        let (hms, frac) = match time_part.split_once('.') {
            Some((a, b)) => (a, Some(b)),
            None => (time_part, None),
        };
        let mut tp = hms.split(':');
        hour = tp.next()?.parse().ok()?;
        minute = tp.next()?.parse().ok()?;
        second = tp.next().map(|v| v.parse().ok()).unwrap_or(Some(0))?;
        if tp.next().is_some() || !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=59).contains(&second) {
            return None;
        }
        if let Some(f) = frac {
            let digits: String = f.chars().take(3).collect();
            let padded = format!("{digits:0<3}");
            millis = padded.parse().ok()?;
        }
        if !tz_part.is_empty() && tz_part != "Z" {
            let sign = if tz_part.starts_with('-') { -1 } else { 1 };
            let body = &tz_part[1..];
            let (oh, om) = if let Some((h, m)) = body.split_once(':') {
                (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?)
            } else if body.len() == 4 {
                (body[..2].parse::<i64>().ok()?, body[2..].parse::<i64>().ok()?)
            } else {
                (body.parse::<i64>().ok()?, 0)
            };
            if oh > 14 || om >= 60 {
                return None;
            }
            offset_minutes = sign * (oh * 60 + om);
        }
    }
    let days = crate::work_scheduler::days_from_civil(year, month, day);
    let wall_ms = (days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis;
    Some(wall_ms - offset_minutes * 60_000)
}

fn within_effective_range(job: &CronJobRow, at_ms: i64) -> &'static str {
    if let Some(from) = job.effective_from
        && at_ms < from
    {
        return "before";
    }
    if let Some(to) = job.effective_to
        && at_ms > to
    {
        return "after";
    }
    "ok"
}

fn validate_schedule(job: &CronJobRow) -> std::result::Result<(), String> {
    if let (Some(from), Some(to)) = (job.effective_from, job.effective_to)
        && from > to
    {
        return Err("Automation start must not exceed deadline".into());
    }
    match job.schedule_type.as_str() {
        "every" => {
            parse_every_expr(&job.schedule_expr)?;
            Ok(())
        }
        "at" => parse_iso8601_utc_ms(&job.schedule_expr)
            .map(|_| ())
            .ok_or_else(|| "Invalid automation time".to_owned()),
        "cron" => ParsedCron::parse(&job.schedule_expr).map(|_| ()),
        _ => Err("Invalid automation schedule type".into()),
    }
}

fn compute_next_run_at_raw(job: &CronJobRow, from_ms: i64) -> Option<i64> {
    if within_effective_range(job, from_ms) == "after" {
        return None;
    }
    if let Some(max) = job.max_runs
        && job.run_count >= max
    {
        return None;
    }
    let next = match job.schedule_type.as_str() {
        "at" => parse_iso8601_utc_ms(&job.schedule_expr),
        "every" => {
            let interval = parse_every_expr(&job.schedule_expr).ok()?;
            let anchor = job
                .created_at
                .max(job.effective_from.unwrap_or(job.created_at));
            if anchor > from_ms {
                Some(anchor)
            } else {
                Some(anchor + ((from_ms - anchor) / interval + 1) * interval)
            }
        }
        "cron" => {
            let start = match job.effective_from {
                Some(f) => from_ms.max(f - 1),
                None => from_ms,
            };
            cron_next_wake(Some(&job.schedule_expr), Some(&job.timezone), start)
        }
        _ => None,
    }?;
    if next > from_ms && within_effective_range(job, next) == "ok" {
        Some(next)
    } else {
        None
    }
}

fn compute_next_run_at(job: &CronJobRow, now: i64) -> Option<i64> {
    if !job.enabled || job.is_reminder || job.cancelled_at.is_some() {
        return None;
    }
    compute_next_run_at_raw(job, now)
}

fn fetch_all_jobs(db: &Connection) -> crate::Result<Vec<CronJobRow>> {
    let mut stmt = db.prepare(
        "SELECT c.id, c.name, c.prompt, c.schedule_type, c.schedule_expr, c.timezone,
                c.space_id, c.cwd, c.enabled, c.created_at, c.updated_at, c.last_run_at,
                c.execution_json, c.permission_mode, c.model_id, c.expert_id,
                c.skill_ids_json, c.connector_ids_json, c.effective_from, c.effective_to,
                c.welcome_mode, c.project_id,
                (SELECT COUNT(*) FROM cron_runs WHERE job_id = c.id AND
                    CASE WHEN json_extract_string(c.execution_json, '$.reminder.kind') = 'bot-reminder'
                         THEN status = 'success' ELSE status != 'skipped' END) AS run_count
         FROM cron_jobs c
         ORDER BY c.updated_at DESC",
    )?;
    let rows = stmt
        .query_map([], map_cron_job_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn fetch_job(db: &Connection, id: &str) -> crate::Result<Option<CronJobRow>> {
    db.query_row(
        "SELECT c.id, c.name, c.prompt, c.schedule_type, c.schedule_expr, c.timezone,
                c.space_id, c.cwd, c.enabled, c.created_at, c.updated_at, c.last_run_at,
                c.execution_json, c.permission_mode, c.model_id, c.expert_id,
                c.skill_ids_json, c.connector_ids_json, c.effective_from, c.effective_to,
                c.welcome_mode, c.project_id,
                (SELECT COUNT(*) FROM cron_runs WHERE job_id = c.id AND
                    CASE WHEN json_extract_string(c.execution_json, '$.reminder.kind') = 'bot-reminder'
                         THEN status = 'success' ELSE status != 'skipped' END) AS run_count
         FROM cron_jobs c
         WHERE c.id = ?1",
        [id],
        map_cron_job_row,
    )
    .optional()
    .map_err(Into::into)
}

fn map_cron_job_row(row: &duckdb::Row<'_>) -> duckdb::Result<CronJobRow> {
    let exec_raw: Option<String> = row.get(12)?;
    let exec_val: Value = exec_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);
    let skill_json: String = row.get(16)?;
    let connector_json: String = row.get(17)?;
    let skill_ids: Vec<String> = serde_json::from_str(&skill_json).unwrap_or_default();
    let connector_ids: Vec<String> = serde_json::from_str(&connector_json).unwrap_or_default();
    let target = exec_val.get("target");
    let target_kind = target
        .and_then(|t| t.get("kind"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let target_task_id = target
        .and_then(|t| t.get("taskId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    Ok(CronJobRow {
        id: row.get(0)?,
        name: row.get(1)?,
        prompt: row.get(2)?,
        schedule_type: row.get(3)?,
        schedule_expr: row.get(4)?,
        timezone: row.get(5)?,
        space_id: row.get(6)?,
        cwd: row.get(7)?,
        enabled: row.get::<_, i64>(8)? != 0,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_run_at: row.get(11)?,
        permission_mode: row.get(13)?,
        model_id: row.get(14)?,
        expert_id: row.get(15)?,
        skill_ids,
        connector_ids,
        effective_from: row.get(18)?,
        effective_to: row.get(19)?,
        welcome_mode: row.get(20)?,
        project_id: row.get(21)?,
        run_count: row.get(22)?,
        source_task_id: exec_val
            .get("sourceTaskId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        target_kind,
        target_task_id,
        is_reminder: exec_val.get("reminder").is_some_and(|v| !v.is_null()),
        max_runs: exec_val.get("maxRuns").and_then(Value::as_i64),
        restart_policy: exec_val
            .get("restartPolicy")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        missed_runs: exec_val
            .get("missedRuns")
            .and_then(Value::as_str)
            .unwrap_or("skip")
            .to_owned(),
        cancelled_at: exec_val.get("cancelledAt").and_then(Value::as_i64),
    })
}

fn table_exists(db: &Connection, name: &str) -> crate::Result<bool> {
    crate::database::table_exists(db, name)
}

pub(crate) fn schedule_owner(db: &Connection, job_id: &str) -> crate::Result<Option<(Option<String>, Option<String>)>> {
    db.query_row(
        "SELECT task_id, space_id FROM dots_schedule_scopes WHERE job_id = ?1",
        [job_id],
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
    )
    .optional()
    .map_err(Into::into)
}

fn dots_schedule_visible(db: &Connection, job_id: &str, cfg: &RuntimeCronConfig) -> crate::Result<bool> {
    let Some(space_ids) = &cfg.dots_space_ids else {
        return Ok(true);
    };
    let owner = schedule_owner(db, job_id)?;
    let Some((_, Some(space_id))) = owner else {
        return Ok(false);
    };
    Ok(space_ids.iter().any(|s| s == &space_id))
}

fn dots_policy(db: &Connection, job: &CronJobRow, cfg: &RuntimeCronConfig) -> crate::Result<String> {
    if !job.is_dots() {
        return Ok("continue".to_owned());
    }
    if !dots_schedule_visible(db, &job.id, cfg)? {
        return Ok("paused".to_owned());
    }
    Ok(cfg.dots_followup_mode.clone())
}

fn dots_followup_paused(db: &Connection, job: &CronJobRow) -> crate::Result<bool> {
    if !job.is_dots() {
        return Ok(false);
    }
    let has_hold: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM dots_schedule_holds WHERE job_id = ?1)",
            [&job.id],
            |r| r.get(0),
        )?;
    if has_hold {
        return Ok(true);
    }
    let owner = schedule_owner(db, &job.id)?;
    if let Some((Some(task_id), _)) = &owner
        && table_exists(db, "dots_target_controls")?
    {
        let paused: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM dots_target_controls WHERE task_id = ?1)",
            [task_id],
            |r| r.get(0),
        )?;
        if paused {
            return Ok(true);
        }
    }
    if table_exists(db, "dots_proactive_pauses")? {
        let space = owner.and_then(|(_, s)| s).unwrap_or_default();
        let paused: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM dots_proactive_pauses WHERE scope IN ('', ?1))",
            [space],
            |r| r.get(0),
        )?;
        if paused {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Deserialize)]
#[serde(tag = "purpose", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DotsRunPurpose {
    Admission { assistant_message_id: String, text_hash: String },
    Continuation,
    Notification,
    #[serde(skip_deserializing)]
    Placement { text_hash: Option<String> },
}

pub fn dots_run_id(source: &str) -> Option<&str> {
    source.strip_prefix("cron-")?.strip_suffix("-input").filter(|id| {
        id.len() == 36 && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() }
        })
    })
}

/// Runs inside the caller's snapshot or the transaction that will use the authorization.
pub fn authorize_dots_run(
    db: &Connection,
    source: &str,
    purpose: &DotsRunPurpose,
) -> crate::Result<Option<Option<String>>> {
    let Some(run_id) = dots_run_id(source) else { return Ok(None) };
    let row: Option<(String, String, String)> = db.query_row(
        "SELECT r.job_id,r.status,i.request_json FROM cron_runs r JOIN cron_run_inputs i ON i.run_id=r.id
         WHERE r.id=?1 AND r.task_id=?2 AND r.started_at<=?3",
        params![run_id, DOTS_TASK_ID, now_ms()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional()?;
    let Some((job_id, status, raw)) = row else { return Ok(None) };
    let eligible_status = match purpose {
        DotsRunPurpose::Admission { .. } | DotsRunPurpose::Placement { .. } => status == "running",
        DotsRunPurpose::Continuation => matches!(status.as_str(), "running" | "success"),
        DotsRunPurpose::Notification => matches!(status.as_str(), "success" | "error"),
    };
    if !eligible_status { return Ok(None); }
    let Ok(stored) = serde_json::from_str::<Value>(&raw) else { return Ok(None) };
    let request = &stored["request"];
    let expected_assistant = format!("cron-{run_id}-assistant");
    if stored["job"]["id"] != job_id || request["taskId"] != DOTS_TASK_ID
        || request["userMessageId"] != source || request["assistantMessageId"] != expected_assistant
    {
        return Ok(None);
    }
    let expected_hash = match purpose {
        DotsRunPurpose::Admission { assistant_message_id, text_hash } => {
            if assistant_message_id != &expected_assistant { return Ok(None); }
            Some(text_hash)
        }
        DotsRunPurpose::Placement { text_hash } => text_hash.as_ref(),
        _ => None,
    };
    let Some(text) = request["text"].as_str() else { return Ok(None) };
    if expected_hash.is_some_and(|hash| sha256_hex(text) != *hash) { return Ok(None); }
    let Some(job) = fetch_job(db, &job_id)? else { return Ok(None) };
    if !job.is_dots() || job.cancelled_at.is_some() || unavailable_reason(db, &job)?.is_some() {
        return Ok(None);
    }
    let cfg = load_config(db)?;
    if cfg.dots_suspended || !dots_schedule_visible(db, &job.id, &cfg)? || dots_followup_paused(db, &job)?
        || (!matches!(purpose, DotsRunPurpose::Notification) && cfg.dots_followup_mode != "continue")
    {
        return Ok(None);
    }
    Ok(Some(schedule_owner(db, &job.id)?.and_then(|(_, space)| space)))
}

pub fn dots_source_current(db: &Connection, source: &str) -> crate::Result<bool> {
    Ok(dots_run_id(source).is_none() || authorize_dots_run(db, source, &DotsRunPurpose::Continuation)?.is_some())
}

fn project_unavailable_reason(db: &Connection, project_id: Option<&str>) -> crate::Result<Option<String>> {
    let Some(pid) = project_id else {
        return Ok(None);
    };
    let archived: Option<i64> = db
        .query_row("SELECT archived FROM projects WHERE id = ?1", [pid], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(match archived {
        None => Some("所属项目不存在，自动化已停用".into()),
        Some(v) if v != 0 => Some("所属项目已归档，自动化已停用；恢复项目后请手动重新启用".into()),
        _ => None,
    })
}

fn task_effective_archived(db: &Connection, task_id: &str) -> crate::Result<bool> {
    let archived: Option<i64> = db
        .query_row(
            "WITH RECURSIVE parents(id, parent_id, archived) AS (
                SELECT s.id, s.parent_id, s.archived
                FROM tasks t
                LEFT JOIN spaces s ON s.id = t.space_id
                WHERE t.id = ?1
                UNION ALL
                SELECT s.id, s.parent_id, s.archived
                FROM spaces s
                JOIN parents p ON p.parent_id = s.id
             )
             SELECT CASE
                WHEN EXISTS(SELECT 1 FROM tasks WHERE id = ?1 AND archived <> 0)
                  OR EXISTS(SELECT 1 FROM parents WHERE archived <> 0)
                THEN 1 ELSE 0 END",
            [task_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(archived.unwrap_or(1) != 0)
}

fn unavailable_reason(db: &Connection, job: &CronJobRow) -> crate::Result<Option<String>> {
    if job.is_reminder {
        return Ok(Some("Bot 提醒功能已移除".into()));
    }
    if let Some(reason) = project_unavailable_reason(db, job.project_id.as_deref())? {
        return Ok(Some(reason));
    }
    if let Some(source_id) = &job.source_task_id {
        let archived: Option<i64> = db
            .query_row("SELECT archived FROM tasks WHERE id = ?1", [source_id], |r| {
                r.get(0)
            })
            .optional()?;
        if archived.is_none_or(|v| v != 0) {
            return Ok(Some("来源任务不存在或已归档，自动化已停用".into()));
        }
    }
    if job.is_dots()
        && let Some((owner_task, owner_space)) = schedule_owner(db, &job.id)?
    {
        if let Some(space_id) = &owner_space {
            let exists: Option<i64> = db
                .query_row("SELECT 1 FROM spaces WHERE id = ?1", [space_id], |r| r.get(0))
                .optional()?;
            if exists.is_none() {
                return Ok(Some("跟进空间已删除，自动化已停用".into()));
            }
        }
        if let Some(task_id) = &owner_task {
            let row: Option<(Option<String>, i64)> = db
                .query_row(
                    "SELECT space_id, archived FROM tasks WHERE id = ?1",
                    [task_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let trashed: bool = table_exists(db, "task_execution_workspace_state")?
                && db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM task_execution_workspace_state WHERE task_id = ?1 AND state = 'trashed')",
                    [task_id],
                    |r| r.get(0),
                )?;
            let invalid = match row {
                None => true,
                Some((task_space, archived)) => {
                    archived != 0
                        || task_space != owner_space
                        || trashed
                        || task_effective_archived(db, task_id)?
                }
            };
            if invalid {
                return Ok(Some("跟进事项已移动、归档或删除，自动化已停用".into()));
            }
        }
    }
    if job.target_kind.as_deref() == Some("task")
        && let Some(target_id) = &job.target_task_id
    {
        let target: Option<(Option<String>, i64)> = db
            .query_row(
                "SELECT project_id, archived FROM tasks WHERE id = ?1",
                [target_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((target_project, archived)) = target else {
            return Ok(Some("目标任务不存在或已归档，自动化已停用".into()));
        };
        if archived != 0 {
            return Ok(Some("目标任务不存在或已归档，自动化已停用".into()));
        }
        return project_unavailable_reason(db, target_project.as_deref());
    }
    Ok(None)
}

pub(crate) fn read_plan_context(
    db: &Connection, job_id: &str,
) -> crate::Result<(Option<(Option<String>, Option<String>)>, Option<String>)> {
    let job = fetch_job(db, job_id)?.ok_or("automation plan disappeared within its read snapshot")?;
    let owner = if job.is_dots() { schedule_owner(db, job_id)? } else { None };
    Ok((owner, unavailable_reason(db, &job)?))
}

fn set_job_enabled_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    events: &mut Vec<EmittedEvent>,
    job_id: &str,
    enabled: bool,
    now: i64,
) -> crate::Result<()> {
    tx.execute(
        "UPDATE cron_jobs SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
        params![if enabled { 1 } else { 0 }, now, job_id],
    )?;
    if !enabled {
        tx.execute(
            "DELETE FROM core_cron_schedule_state WHERE job_id = ?1",
            [job_id],
        )?;
    }
    if let Some(updated) = fetch_job(tx, job_id)? {
        let next = compute_next_run_at(&updated, now);
        events.push(append_event(
            tx,
            core_gen,
            client_gen,
            "cron",
            "cron.jobUpdated",
            job_id,
            now,
            None,
            &json!({ "type": "upsert", "job": updated.to_dto_json(next) }),
        )?);
    }
    Ok(())
}

fn proactive_schedule_state(job: &CronJobRow, unavailable: bool, started: bool, now: i64) -> &'static str {
    if job.cancelled_at.is_some() {
        "cancelled"
    } else if unavailable {
        "unavailable"
    } else if job.max_runs.is_some_and(|max| job.run_count >= max) {
        "max_runs_reached"
    } else if job.effective_to.is_some_and(|end| end <= now) {
        "expired"
    } else if job.schedule_type == "at" && parse_iso8601_utc_ms(&job.schedule_expr).is_some_and(|at| at <= now) {
        "scheduled_time_passed"
    } else if !job.enabled {
        "paused"
    } else if !started {
        "scheduler_stopped"
    } else if compute_next_run_at(job, now).is_none() {
        "no_future_occurrence"
    } else {
        "scheduled"
    }
}

fn set_dots_proactive_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    events: &mut Vec<EmittedEvent>,
    source: &str,
    space: &str,
    pause: bool,
    now: i64,
) -> crate::Result<Value> {
    if source.trim().is_empty() || source.starts_with("cron-") || source.starts_with("goal-continuation:") {
        return Ok(json!({ "status": "rejected", "message": "主动跟进策略需要用户明确交代" }));
    }
    let cfg = load_config(tx)?;
    if !space.is_empty() && (cfg.dots_space_ids.as_ref().is_some_and(|ids| !ids.iter().any(|id| id == space))
        || !crate::dots_proactive_data::is_local_scope(tx, space)?)
    {
        return Ok(json!({ "status": "rejected", "message": "工作空间不存在或未授权给 Dots" }));
    }
    let action = if pause { "pause_proactive" } else { "resume_proactive" };
    let key = serde_json::to_string(&(source, action, space))?;
    let prior: Option<String> = tx.query_row(
        "SELECT outcome FROM dots_control_receipts WHERE operation_id=?", [&key], |row| row.get(0),
    ).optional()?;
    if let Some(prior) = prior {
        let receipt: Value = serde_json::from_str(&prior)?;
        return Ok(json!({ "status": "ok", "receipt": receipt }));
    }

    let saved: Option<String> = tx.query_row(
        "SELECT timer_ids FROM dots_proactive_pauses WHERE scope=?", [space], |row| row.get(0),
    ).optional()?;
    let ids: Vec<String> = if let Some(saved) = saved {
        serde_json::from_str(&saved)?
    } else if pause {
        let mut ids = Vec::new();
        for job in fetch_all_jobs(tx)? {
            if !job.is_dots() || job.is_reminder || job.cancelled_at.is_some() { continue; }
            if !space.is_empty() && schedule_owner(tx, &job.id)?.and_then(|(_, space)| space).as_deref() != Some(space) { continue; }
            if job.max_runs.is_some_and(|max| job.run_count >= max) && !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM cron_runs WHERE job_id=? AND status='running')", [&job.id], |row| row.get::<_, bool>(0),
            )? { continue; }
            ids.push(job.id);
        }
        ids
    } else {
        Vec::new()
    };
    if pause {
        tx.execute("INSERT INTO dots_proactive_pauses (scope,timer_ids) VALUES (?,?) ON CONFLICT DO NOTHING",
            params![space, serde_json::to_string(&ids)?])?;
    } else {
        tx.execute("DELETE FROM dots_proactive_pauses WHERE scope=?", [space])?;
    }

    let holder = format!("proactive:{space}");
    let mut schedules = Vec::new();
    for id in ids {
        let Some(mut job) = fetch_job(tx, &id)? else { continue; };
        if !job.is_dots() || job.is_reminder || job.cancelled_at.is_some() { continue; }
        let in_scope = space.is_empty() || schedule_owner(tx, &id)?.and_then(|(_, space)| space).as_deref() == Some(space);
        let unavailable = unavailable_reason(tx, &job)?.is_some();
        let enabled = if pause {
            let held = tx.query_row("SELECT EXISTS(SELECT 1 FROM dots_schedule_holds WHERE job_id=?)", [&id], |row| row.get::<_, bool>(0))?;
            if in_scope && (job.enabled || held) {
                tx.execute("INSERT INTO dots_schedule_holds (job_id,holder) VALUES (?,?) ON CONFLICT DO NOTHING", params![id, holder])?;
                false
            } else { job.enabled }
        } else {
            let released = tx.execute("DELETE FROM dots_schedule_holds WHERE job_id=? AND holder=?", params![id, holder])? != 0;
            job.enabled || (released && !unavailable && job.max_runs.is_none_or(|max| job.run_count < max)
                && dots_schedule_visible(tx, &id, &cfg)? && !dots_followup_paused(tx, &job)?)
        };
        if enabled != job.enabled {
            set_job_enabled_tx(tx, core_gen, client_gen, events, &id, enabled, now)?;
            job.enabled = enabled;
            job.updated_at = now;
            if enabled {
                arm_job_state_tx(tx, &job, &cfg, false, now)?;
            }
        }
        if in_scope {
            schedules.push(json!({ "id": id, "state": proactive_schedule_state(&job, unavailable, cfg.started, now) }));
        }
    }
    let receipt = json!({ "scope": if space.is_empty() { "all" } else { space },
        "proactive": if pause { "paused" } else { "enabled" }, "schedules": schedules });
    tx.execute("INSERT INTO dots_control_receipts (operation_id,target_task_id,outcome) VALUES (?,?,?)",
        params![key, DOTS_TASK_ID, serde_json::to_string(&receipt)?])?;
    Ok(json!({ "status": "ok", "receipt": receipt }))
}

fn compose_prompt(job: &CronJobRow, cfg: &RuntimeCronConfig) -> String {
    if job.is_dots() {
        return format!(
            "{}\n\n这是之前约定的主动跟进。到点提醒直接给提醒内容。检查有实质进展、成果或阻塞时直接给结果。检查没有变化时，只返回 {}",
            job.prompt, DOTS_NO_CHANGE
        );
    }
    let mut lines = Vec::new();
    let skill_names: Vec<String> = job
        .skill_ids
        .iter()
        .filter_map(|id| {
            let name = cfg
                .skill_names
                .get(id)
                .and_then(Value::as_str)
                .unwrap_or(id.as_str());
            if name.is_empty() {
                None
            } else {
                Some(name.to_owned())
            }
        })
        .collect();
    if !skill_names.is_empty() {
        lines.push(format!(
            "请优先使用以下技能（若已安装且可用）：{}。",
            skill_names.join("、")
        ));
    }
    let mut connector_notes = Vec::new();
    for id in &job.connector_ids {
        if let Some(entry) = cfg.connectors.get(id).and_then(Value::as_object) {
            let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let skills: Vec<&str> = entry
                .get("skillNames")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if skills.is_empty() {
                connector_notes.push(name.to_owned());
            } else {
                connector_notes.push(format!("{name}（技能：{}）", skills.join("、")));
            }
        }
    }
    if !connector_notes.is_empty() {
        lines.push(format!(
            "已授权连接器（任务中可免确认使用其能力）：{}。",
            connector_notes.join("；")
        ));
    }
    if lines.is_empty() {
        job.prompt.clone()
    } else {
        format!("【自动化任务配置】\n{}\n\n{}", lines.join("\n"), job.prompt)
    }
}

fn arm_job_state_tx(
    tx: &Connection,
    job: &CronJobRow,
    cfg: &RuntimeCronConfig,
    restoring: bool,
    now: i64,
) -> crate::Result<Option<(i64, i64)>> {
    let policy = dots_policy(tx, job, cfg)?;
    if !job.enabled
        || job.is_reminder
        || job.cancelled_at.is_some()
        || policy == "paused"
        || (cfg.dots_suspended && job.is_dots())
        || dots_followup_paused(tx, job)?
    {
        tx.execute(
            "DELETE FROM core_cron_schedule_state WHERE job_id = ?1",
            [&job.id],
        )?;
        return Ok(None);
    }
    let mut next_run = compute_next_run_at(job, now);
    let mut occurrence = next_run;
    if restoring
        && job.is_dots()
        && job.missed_runs == "coalesce"
        && within_effective_range(job, now) == "ok"
    {
        let since = job.created_at.max(job.updated_at).max(job.last_run_at.unwrap_or(0));
        if let Some(missed) = compute_next_run_at(job, since)
            && missed <= now
        {
            let occ_key = sha256_hex(&format!("{}:{}", job.id, missed));
            let already: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM core_cron_occurrences WHERE occurrence_key = ?1)",
                [&occ_key],
                |r| r.get(0),
            )?;
            if !already {
                next_run = Some(now);
                occurrence = Some(missed);
            }
        }
    }
    let sig = job.schedule_signature();
    if let (Some(due), Some(occ)) = (next_run, occurrence) {
        tx.execute(
            "INSERT INTO core_cron_schedule_state (job_id, next_due_at_ms, occurrence_at_ms, last_evaluated_at_ms, schedule_sig)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(job_id) DO UPDATE SET
               next_due_at_ms = excluded.next_due_at_ms,
               occurrence_at_ms = excluded.occurrence_at_ms,
               last_evaluated_at_ms = excluded.last_evaluated_at_ms,
               schedule_sig = excluded.schedule_sig",
            params![job.id, due, occ, now, sig],
        )?;
        Ok(Some((due, occ)))
    } else {
        tx.execute(
            "DELETE FROM core_cron_schedule_state WHERE job_id = ?1",
            [&job.id],
        )?;
        Ok(None)
    }
}

fn enqueue_cron_execution_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    events: &mut Vec<EmittedEvent>,
    job: &CronJobRow,
    run_id: &str,
    task_id: &str,
    new_task: bool,
    request_value: &Value,
    input_json: &str,
    generated_task: Option<(&str, &str, Option<&str>, Option<&str>, Option<&str>, Option<&str>, Option<&str>, Option<&str>, Option<&str>)>,
    now: i64,
    requested_model_id: Option<&str>,
) -> crate::Result<()> {
    if let Some((gid, title, space_id, project_id, cwd, welcome_mode, model_id, perm_mode, expert_id)) = generated_task {
        tx.execute(
            "INSERT INTO tasks (id, title, space_id, project_id, status, updated_at, cwd, welcome_mode, model_id, permission_mode, expert_id)
             VALUES (?1, ?2, ?3, ?4, 'in_progress', ?5, ?6, ?7, ?8, ?9, ?10)",
            params![gid, title, space_id, project_id, now, cwd, welcome_mode, model_id, perm_mode, expert_id],
        )?;
    }
    tx.execute(
        "INSERT INTO cron_runs (id, job_id, started_at, finished_at, status, error, task_id)
         VALUES (?1, ?2, ?3, NULL, 'running', NULL, ?4)",
        params![run_id, job.id, now, task_id],
    )?;
    tx.execute(
        "INSERT INTO cron_run_inputs (run_id, request_json) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
        params![run_id, input_json],
    )?;
    tx.execute(
        "UPDATE cron_jobs SET last_run_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, job.id],
    )?;

    let exec_id = format!("cron-exec-{run_id}");
    let idemp_key = format!("cron-{run_id}-input");
    let queue_in_dots = job.target_task_id.as_deref() == Some(DOTS_TASK_ID)
        && job.is_dots()
        && job.missed_runs == "coalesce";
    let payload = json!({
        "resourceKey": format!("cron-job:{}", job.id),
        "cronRunId": run_id,
        "cronJobId": job.id,
        "jobName": job.name,
        "projectId": job.project_id,
        "newTask": new_task,
        "generatedTaskTitle": if new_task { Some(job.name.clone()) } else { None::<String> },
        "targetTaskId": job.target_task_id,
        "queueInDots": queue_in_dots,
        "isDots": job.is_dots(),
        "requestedModelId": requested_model_id,
        "previousLastRunAt": job.last_run_at,
        "previousUpdatedAt": job.updated_at,
        "request": request_value,
    });
    tx.execute(
        "INSERT INTO core_execution_runs (
            execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
            task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, 'service', 'core-cron', 0, ?4, 'cron', ?5, 'waiting_executor', 1, 0, ?6, ?6)
         ON CONFLICT(idempotency_key) DO NOTHING",
        params![
            exec_id,
            idemp_key,
            core_gen,
            task_id,
            serde_json::to_string(&payload)?,
            now,
        ],
    )?;
    events.push(append_event(
        tx,
        core_gen,
        client_gen,
        "cron",
        "cron.runStarted",
        &job.id,
        now,
        None,
        &json!({
            "type": "run",
            "run": {
                "id": run_id,
                "jobId": job.id,
                "taskId": task_id,
                "startedAt": now,
                "status": "running",
            }
        }),
    )?);
    Ok(())
}

fn dispatch_new_run_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    events: &mut Vec<EmittedEvent>,
    job: &CronJobRow,
    cfg: &RuntimeCronConfig,
    occ_key: String,
    occurrence_ms: Option<i64>,
    force: bool,
    now: i64,
) -> crate::Result<Option<String>> {
    if job.cancelled_at.is_some() {
        return Ok(None);
    }
    let already_running: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM cron_runs WHERE job_id = ?1 AND status = 'running')",
        [&job.id],
        |r| r.get(0),
    )?;
    if already_running {
        return Ok(None);
    }
    if let Some(reason) = unavailable_reason(tx, job)? {
        let run_id = format!("cron-skip-{}-{now}", job.id);
        tx.execute(
            "INSERT INTO cron_runs (id, job_id, started_at, finished_at, status, error, task_id)
             VALUES (?1, ?2, ?3, ?3, 'skipped', ?4, NULL)",
            params![run_id, job.id, now, reason],
        )?;
        events.push(append_event(
            tx,
            core_gen,
            client_gen,
            "cron",
            "cron.runSkipped",
            &job.id,
            now,
            None,
            &json!({ "type": "run", "run": { "id": run_id, "jobId": job.id, "startedAt": now, "finishedAt": now, "status": "skipped", "error": reason } }),
        )?);
        set_job_enabled_tx(tx, core_gen, client_gen, events, &job.id, false, now)?;
        return Ok(None);
    }
    if !force
        && (job.max_runs.is_some_and(|m| job.run_count >= m)
            || within_effective_range(job, now) == "after")
    {
        set_job_enabled_tx(tx, core_gen, client_gen, events, &job.id, false, now)?;
        return Ok(None);
    }
    if !force && within_effective_range(job, now) == "before" {
        return Ok(None);
    }
    // Atomically deduplicate scheduled occurrence.
    let inserted = tx.execute(
        "INSERT INTO core_cron_occurrences (occurrence_key, job_id, occurrence_at_ms, run_id, status, recorded_at_ms)
         VALUES (?1, ?2, ?3, NULL, 'claimed', ?4) ON CONFLICT DO NOTHING",
        params![occ_key, job.id, occurrence_ms.unwrap_or(now), now],
    )?;
    if inserted == 0 {
        return Ok(None);
    }

    let target_id = if job.target_kind.as_deref() == Some("task") {
        job.target_task_id.as_deref()
    } else {
        None
    };
    let mut target_row: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> = None;
    if let Some(tid) = target_id {
        target_row = tx
            .query_row(
                "SELECT id, permission_mode, welcome_mode, space_id, model_id, expert_id, mode_preset_id, project_id
                 FROM tasks WHERE id = ?1",
                [tid],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )
            .optional()?;
        if target_row.is_none() {
            return Ok(None);
        }
    }
    let run_id = uuid_like_id("cron", &job.id, now, &occ_key);
    let new_task = target_id.is_none();
    let task_id = target_id
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("cron-{}-{}", job.id, run_id));
    let queue_in_dots = target_id == Some(DOTS_TASK_ID)
        && job.is_dots()
        && job.missed_runs == "coalesce";
    let requested_model_id = if target_id.is_none() {
        job.model_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| cfg.default_model_id.clone())
    } else {
        None
    };
    let perm = target_row
        .as_ref()
        .and_then(|t| t.1.clone())
        .or_else(|| job.permission_mode.clone())
        .unwrap_or_else(|| if new_task { "auto".into() } else { "default".into() });
    let welcome = target_row
        .as_ref()
        .and_then(|t| t.2.clone())
        .or_else(|| job.welcome_mode.clone())
        .or_else(|| if new_task { Some("working".into()) } else { None });
    let space = target_row
        .as_ref()
        .and_then(|t| t.3.clone())
        .or_else(|| job.space_id.clone());
    let model = target_row
        .as_ref()
        .and_then(|t| t.4.clone())
        .or_else(|| requested_model_id.clone());
    let expert = target_row
        .as_ref()
        .and_then(|t| t.5.clone())
        .or_else(|| job.expert_id.clone());
    let mode_preset = target_row.as_ref().and_then(|t| t.6.clone());

    let user_msg_id = format!("cron-{run_id}-input");
    let asst_msg_id = format!("cron-{run_id}-assistant");
    let mut req = Map::new();
    req.insert("taskId".into(), Value::String(task_id.clone()));
    req.insert("text".into(), Value::String(compose_prompt(job, cfg)));
    if job.is_dots() {
        req.insert("displayText".into(), Value::String(job.prompt.clone()));
    }
    req.insert("permissionMode".into(), Value::String(perm.clone()));
    if let Some(w) = &welcome {
        req.insert("welcomeMode".into(), Value::String(w.clone()));
    }
    if let Some(s) = &space {
        req.insert("spaceId".into(), Value::String(s.clone()));
    }
    if let Some(m) = &model {
        req.insert("modelId".into(), Value::String(m.clone()));
    }
    if let Some(e) = &expert {
        req.insert("expertId".into(), Value::String(e.clone()));
    }
    if let Some(mp) = &mode_preset {
        req.insert("modePresetId".into(), Value::String(mp.clone()));
    }
    if target_id.is_none() && !job.connector_ids.is_empty() {
        req.insert("connectorIds".into(), json!(job.connector_ids));
    }
    if queue_in_dots {
        req.insert("streamingBehavior".into(), Value::String("followUp".into()));
    }
    req.insert("assistantMessageId".into(), Value::String(asst_msg_id));
    req.insert("userMessageId".into(), Value::String(user_msg_id));
    let req_val = Value::Object(req);
    let input_json = serde_json::to_string(&json!({
        "request": req_val,
        "newTask": new_task,
        "job": {
            "id": job.id,
            "name": job.name,
            "projectId": job.project_id,
        }
    }))?;
    let gen_title = if job.name.trim().is_empty() {
        "任务".to_owned()
    } else {
        job.name.clone()
    };
    let generated = if new_task {
        Some((
            task_id.as_str(),
            gen_title.as_str(),
            job.space_id.as_deref(),
            job.project_id.as_deref(),
            job.cwd.as_deref(),
            welcome.as_deref(),
            model.as_deref(),
            Some(perm.as_str()),
            expert.as_deref(),
        ))
    } else {
        None
    };
    tx.execute(
        "UPDATE core_cron_occurrences SET run_id = ?1, status = 'running' WHERE occurrence_key = ?2",
        params![run_id, occ_key],
    )?;
    enqueue_cron_execution_tx(
        tx,
        core_gen,
        client_gen,
        events,
        job,
        &run_id,
        &task_id,
        new_task,
        &req_val,
        &input_json,
        generated,
        now,
        requested_model_id.as_deref(),
    )?;
    Ok(Some(run_id))
}

fn uuid_like_id(prefix: &str, seed: &str, ts: i64, key: &str) -> String {
    let h = sha256_hex(&format!("{prefix}:{seed}:{ts}:{key}"));
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn reconcile_running_runs_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    cfg: &RuntimeCronConfig,
    events: &mut Vec<EmittedEvent>,
    now: i64,
) -> crate::Result<()> {
    let mut stmt = tx.prepare(
        "SELECT r.id, r.job_id, r.started_at, r.task_id
         FROM cron_runs r
         WHERE r.status = 'running'",
    )?;
    let running_rows: Vec<(String, String, i64, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    for (run_id, job_id, started_at, task_id) in running_rows {
        let job = fetch_job(tx, &job_id)?;
        if let Some(ref j) = job {
            if j.is_reminder || (j.cancelled_at.is_none() && dots_policy(tx, j, cfg)? != "continue") {
                continue;
            }
        }
        let exec_id = format!("cron-exec-{run_id}");
        let existing_exec: Option<(String, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT status, result_json, error_message FROM core_execution_runs WHERE execution_id = ?1",
                [&exec_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((exec_status, res_json, err_msg)) = existing_exec {
            if matches!(exec_status.as_str(), "completed" | "failed" | "cancelled" | "paused") {
                let res_val = res_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok());
                on_core_execution_state_change(
                    tx,
                    core_gen,
                    client_gen,
                    &exec_id,
                    &exec_status,
                    res_val.as_ref(),
                    err_msg.as_deref(),
                    now,
                    events,
                )?;
            }
            continue;
        }
        // Current runs commit their Core execution and Cron records in one transaction.
        let err = "计划运行缺少 Core 执行回执";
        tx.execute(
            "UPDATE cron_runs SET finished_at = ?1, status = 'error', error = ?2 WHERE id = ?3",
            params![now, err, run_id],
        )?;
        events.push(append_event(
            tx,
            core_gen,
            client_gen,
            "cron",
            "cron.runSettled",
            &job_id,
            now,
            None,
            &json!({
                "type": "run",
                "run": { "id": run_id, "jobId": job_id, "taskId": task_id, "startedAt": started_at, "finishedAt": now, "status": "error", "error": err }
            }),
        )?);
    }
    Ok(())
}

fn startup_or_scan_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    mark_started: bool,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<usize> {
    let mut cfg = load_config(tx)?;
    if mark_started {
        cfg.started = true;
        cfg.last_tick_at_ms = Some(now);
        save_config(tx, &cfg)?;
    }
    let jobs = fetch_all_jobs(tx)?;
    for job in &jobs {
        if job.is_dots()
            && job.restart_policy.as_deref() == Some("pause")
            && !job.is_reminder
            && job.cancelled_at.is_none()
            && job.enabled
        {
            tx.execute(
                "INSERT INTO dots_schedule_holds (job_id, holder) VALUES (?1, 'manual') ON CONFLICT DO NOTHING",
                [&job.id],
            )?;
            set_job_enabled_tx(tx, core_gen, client_gen, events, &job.id, false, now)?;
        }
    }
    reconcile_running_runs_tx(tx, core_gen, client_gen, &cfg, events, now)?;
    let refreshed_jobs = fetch_all_jobs(tx)?;
    let mut armed = 0usize;
    for job in &refreshed_jobs {
        if !job.enabled
            || job.is_reminder
            || (job.is_dots() && job.restart_policy.as_deref() == Some("pause"))
        {
            continue;
        }
        if let Some(_reason) = unavailable_reason(tx, job)? {
            set_job_enabled_tx(tx, core_gen, client_gen, events, &job.id, false, now)?;
            continue;
        }
        if job.restart_policy.as_deref() == Some("pause") {
            set_job_enabled_tx(tx, core_gen, client_gen, events, &job.id, false, now)?;
            continue;
        }
        if validate_schedule(job).is_err() {
            set_job_enabled_tx(tx, core_gen, client_gen, events, &job.id, false, now)?;
            continue;
        }
        if arm_job_state_tx(tx, job, &cfg, true, now)?.is_some() {
            armed += 1;
        }
    }
    Ok(armed)
}

fn tick_tx(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    now: i64,
    simulate_sleep_jump: bool,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<Value> {
    let mut cfg = load_config(tx)?;
    let prev_tick_ms = cfg.last_tick_at_ms;
    let clock_jumped_back = prev_tick_ms.is_some_and(|p| now < p - 5_000);
    let mut fired = 0usize;
    let mut skipped_missed = 0usize;
    let mut notified = 0usize;
    let mut disabled = 0usize;

    let jobs = fetch_all_jobs(tx)?;
    for job in jobs.into_iter().take(MAX_TICK_JOBS_PER_PASS) {
        if !job.enabled || job.is_reminder || job.cancelled_at.is_some() {
            tx.execute(
                "DELETE FROM core_cron_schedule_state WHERE job_id = ?1",
                [&job.id],
            )?;
            continue;
        }
        if job.max_runs.is_some_and(|m| job.run_count >= m)
            || within_effective_range(&job, now) == "after"
        {
            set_job_enabled_tx(tx, core_gen, client_gen, events, &job.id, false, now)?;
            disabled += 1;
            continue;
        }
        let state: Option<(Option<i64>, Option<i64>, i64, String)> = tx
            .query_row(
                "SELECT next_due_at_ms, occurrence_at_ms, last_evaluated_at_ms, schedule_sig
                 FROM core_cron_schedule_state WHERE job_id = ?1",
                [&job.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let sig = job.schedule_signature();
        let (due_opt, occ_opt, last_eval_ms) = match state {
            Some((due, occ, last_eval, existing_sig)) if existing_sig == sig => {
                (due, occ, last_eval)
            }
            _ => {
                // Re-arm when schedule configuration changed or job just entered active set.
                let armed = arm_job_state_tx(tx, &job, &cfg, true, now)?;
                if let Some((due, occ)) = armed {
                    (Some(due), Some(occ), now)
                } else {
                    (None, None, now)
                }
            }
        };
        if clock_jumped_back {
            // Preserve deduplicated future schedule; never rewind past already-recorded occurrences.
            tx.execute(
                "UPDATE core_cron_schedule_state SET last_evaluated_at_ms = ?1 WHERE job_id = ?2",
                params![now, job.id],
            )?;
            continue;
        }
        let Some(due_ms) = due_opt else {
            continue;
        };
        if now < due_ms {
            tx.execute(
                "UPDATE core_cron_schedule_state SET last_evaluated_at_ms = ?1 WHERE job_id = ?2",
                params![now, job.id],
            )?;
            continue;
        }
        let occ_ms = occ_opt.unwrap_or(due_ms);
        let policy = dots_policy(tx, &job, &cfg)?;
        if policy == "paused" || (cfg.dots_suspended && job.is_dots()) {
            tx.execute(
                "DELETE FROM core_cron_schedule_state WHERE job_id = ?1",
                [&job.id],
            )?;
            continue;
        }
        if policy == "notify" {
            if !dots_followup_paused(tx, &job)?
                && unavailable_reason(tx, &job)?.is_none()
            {
                let written = tx.execute(
                    "INSERT INTO dots_schedule_notices VALUES (?1, ?2)
                     ON CONFLICT(job_id) DO UPDATE SET occurrence = excluded.occurrence
                     WHERE occurrence < excluded.occurrence",
                    params![job.id, occ_ms],
                )?;
                if written > 0 {
                    notified += 1;
                    events.push(append_event(
                        tx,
                        core_gen,
                        client_gen,
                        "cron",
                        "cron.dotsReminder",
                        &job.id,
                        occ_ms,
                        None,
                        &json!({ "jobId": job.id, "jobName": job.name, "occurrence": occ_ms }),
                    )?);
                }
            }
            arm_job_state_tx(tx, &job, &cfg, false, now)?;
            continue;
        }
        if dots_followup_paused(tx, &job)? {
            tx.execute(
                "DELETE FROM core_cron_schedule_state WHERE job_id = ?1",
                [&job.id],
            )?;
            continue;
        }
        let following = compute_next_run_at_raw(&job, occ_ms);
        let jumped_or_missed = simulate_sleep_jump
            || following.is_some_and(|f| f <= now)
            || (now - occ_ms > CRON_SKIP_GRACE_MS && last_eval_ms < occ_ms);
        if job.missed_runs != "coalesce" && jumped_or_missed {
            // Preserve Cron "skip" policy across sleep/offline/clock jump without backlog.
            skipped_missed += 1;
            events.push(append_event(
                tx,
                core_gen,
                client_gen,
                "cron",
                "cron.missedSkipped",
                &job.id,
                now,
                None,
                &json!({ "jobId": job.id, "skippedOccurrence": occ_ms, "nowMs": now }),
            )?);
            if job.schedule_type == "at" {
                set_job_enabled_tx(tx, core_gen, client_gen, events, &job.id, false, now)?;
                disabled += 1;
            } else {
                arm_job_state_tx(tx, &job, &cfg, false, now)?;
            }
            continue;
        }
        let occ_key = sha256_hex(&format!("{}:{occ_ms}", job.id));
        if let Some(_run_id) = dispatch_new_run_tx(
            tx,
            core_gen,
            client_gen,
            events,
            &job,
            &cfg,
            occ_key,
            Some(occ_ms),
            false,
            now,
        )? {
            fired += 1;
        }
        if job.schedule_type == "at" {
            // Wait for run settlement to flip `at` job enabled=0 (so busy retries or settlement keep exact semantics),
            // just clear timer state so it does not double-fire.
            tx.execute(
                "DELETE FROM core_cron_schedule_state WHERE job_id = ?1",
                [&job.id],
            )?;
        } else {
            let refreshed = fetch_job(tx, &job.id)?;
            if let Some(j) = refreshed {
                if j.enabled {
                    arm_job_state_tx(tx, &j, &cfg, false, now)?;
                }
            }
        }
    }
    cfg.last_tick_at_ms = Some(now);
    save_config(tx, &cfg)?;
    Ok(json!({
        "status": "ok",
        "nowMs": now,
        "clockJumpedBack": clock_jumped_back,
        "fired": fired,
        "skippedMissed": skipped_missed,
        "notified": notified,
        "disabled": disabled,
    }))
}

pub(crate) fn on_core_execution_state_change(
    tx: &Connection,
    core_gen: &str,
    client_gen: &str,
    execution_id: &str,
    exec_status: &str,
    result_value: Option<&Value>,
    error_message: Option<&str>,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<()> {
    let Some(run_id) = execution_id.strip_prefix("cron-exec-") else {
        return Ok(());
    };
    let run_row: Option<(String, i64, Option<String>, String)> = tx
        .query_row(
            "SELECT job_id, started_at, task_id, status FROM cron_runs WHERE id = ?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((job_id, started_at, task_id, prior_status)) = run_row else {
        return Ok(());
    };
    if prior_status != "running" {
        return Ok(());
    }
    if exec_status == "unknown" {
        tx.execute(
            "UPDATE core_cron_occurrences SET status = 'unknown', recorded_at_ms = ?1 WHERE run_id = ?2",
            params![now, run_id],
        )?;
        events.push(append_event(
            tx,
            core_gen,
            client_gen,
            "cron",
            "cron.runUnknown",
            &job_id,
            now,
            None,
            &json!({ "runId": run_id, "jobId": job_id, "taskId": task_id }),
        )?);
        return Ok(());
    }
    if !matches!(exec_status, "completed" | "failed" | "cancelled" | "paused") {
        return Ok(());
    }
    let skipped_busy = result_value
        .and_then(|v| v.get("skippedBusy"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let exec_payload_raw: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM core_execution_runs WHERE execution_id = ?1",
            [execution_id],
            |r| r.get(0),
        )
        .optional()?;
    let exec_payload: Value = exec_payload_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);

    if skipped_busy {
        let prev_last_run_at = exec_payload.get("previousLastRunAt").and_then(Value::as_i64);
        let prev_updated_at = exec_payload.get("previousUpdatedAt").and_then(Value::as_i64);
        tx.execute(
            "UPDATE cron_runs SET finished_at = ?1, status = 'skipped', error = ?2, task_id = NULL WHERE id = ?3",
            params![now, BUSY_TASK_SKIP, run_id],
        )?;
        tx.execute("DELETE FROM cron_run_inputs WHERE run_id = ?1", [run_id])?;
        if let Some(prev_upd) = prev_updated_at {
            tx.execute(
                "UPDATE cron_jobs SET last_run_at = ?1,
                 updated_at = CASE WHEN updated_at = ?2 THEN ?3 ELSE updated_at END
                 WHERE id = ?4 AND last_run_at = ?2",
                params![prev_last_run_at, started_at, prev_upd, job_id],
            )?;
        }
        tx.execute(
            "UPDATE core_cron_occurrences SET status = 'skipped', recorded_at_ms = ?1 WHERE run_id = ?2",
            params![now, run_id],
        )?;
        events.push(append_event(
            tx,
            core_gen,
            client_gen,
            "cron",
            "cron.runSettled",
            &job_id,
            now,
            None,
            &json!({
                "type": "run",
                "run": { "id": run_id, "jobId": job_id, "startedAt": started_at, "finishedAt": now, "status": "skipped", "error": BUSY_TASK_SKIP }
            }),
        )?);
        return Ok(());
    }

    let final_status = if exec_status == "completed" {
        "success"
    } else {
        "error"
    };
    let final_error = if final_status == "error" {
        error_message.or(Some("执行失败")).map(ToOwned::to_owned)
    } else {
        None
    };
    tx.execute(
        "UPDATE cron_runs SET finished_at = ?1, status = ?2, error = ?3 WHERE id = ?4",
        params![now, final_status, final_error, run_id],
    )?;
    tx.execute(
        "UPDATE core_cron_occurrences SET status = ?1, recorded_at_ms = ?2 WHERE run_id = ?3",
        params![final_status, now, run_id],
    )?;
    if let (Some(title), Some(tid)) = (
        exec_payload.get("generatedTaskTitle").and_then(Value::as_str),
        task_id.as_deref(),
    ) {
        let task_status = if final_status == "success" {
            "completed"
        } else {
            "failed"
        };
        tx.execute(
            "UPDATE tasks SET title = CASE WHEN ?1 = '' THEN title ELSE ?1 END, status = ?2,
             updated_at = GREATEST(updated_at, ?3) WHERE id = ?4",
            params![title, task_status, now, tid],
        )?;
    }

    let cfg = load_config(tx)?;
    let job = fetch_job(tx, &job_id)?;
    let is_manual = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM core_cron_occurrences WHERE run_id = ?1 AND occurrence_key LIKE 'manual:%')",
            [run_id],
            |r| crate::database::row_bool(r, 0),
        )
        .unwrap_or(false);
    if let Some(j) = &job {
        if j.enabled
            && ((!is_manual && !j.is_reminder && j.schedule_type == "at")
                || j.max_runs.is_some_and(|m| j.run_count >= m))
        {
            set_job_enabled_tx(tx, core_gen, client_gen, events, &j.id, false, now)?;
        }
        let next = fetch_job(tx, &j.id)?.and_then(|updated| compute_next_run_at(&updated, now));
        events.push(append_event(
            tx,
            core_gen,
            client_gen,
            "cron",
            "cron.runSettled",
            &j.id,
            now,
            None,
            &json!({
                "type": "run",
                "run": {
                    "id": run_id,
                    "jobId": j.id,
                    "taskId": task_id,
                    "startedAt": started_at,
                    "finishedAt": now,
                    "status": final_status,
                    "error": final_error,
                },
                "nextRunAt": next,
            }),
        )?);
        let notif_status = if final_status == "success" {
            "success"
        } else {
            "failed"
        };
        let dots_message = result_value
            .and_then(|v| v.get("dotsMessage"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != DOTS_NO_CHANGE)
            .map(ToOwned::to_owned);
        let should_notify = if task_id.as_deref() == Some(DOTS_TASK_ID) {
            j.cancelled_at.is_none()
                && dots_schedule_visible(tx, &j.id, &cfg)?
                && !dots_followup_paused(tx, j)?
                && (final_status != "success" || dots_message.is_some())
        } else {
            task_id.is_some()
        };
        events.push(append_event(
            tx,
            core_gen,
            client_gen,
            "cron",
            "cron.runSummary",
            &j.id,
            now,
            None,
            &json!({
                "runId": run_id,
                "jobId": j.id,
                "jobName": j.name,
                "taskId": task_id,
                "projectId": j.project_id,
                "status": notif_status,
                "error": final_error,
                "message": dots_message,
                "notifyUser": should_notify,
            }),
        )?);
    }
    Ok(())
}

pub fn execute_read(db: &Connection, command: Command) -> crate::Result<Value> {
    let cfg = load_config(db)?;
    let has_occ_table = table_exists(db, "core_cron_occurrences")?;
    let has_state_table = table_exists(db, "core_cron_schedule_state")?;
    match command {
        Command::Status { job_id, limit } => {
            let cap = limit.unwrap_or(50).clamp(1, 200);
            let states: Vec<Value> = if has_state_table {
                let mut stmt = db.prepare(
                    "SELECT job_id, next_due_at_ms, occurrence_at_ms, last_evaluated_at_ms
                     FROM core_cron_schedule_state
                     WHERE (?1 IS NULL OR job_id = ?1)",
                )?;
                stmt.query_map([job_id.as_deref()], |r| {
                    Ok(json!({
                        "jobId": r.get::<_, String>(0)?,
                        "nextDueAtMs": r.get::<_, Option<i64>>(1)?,
                        "occurrenceAtMs": r.get::<_, Option<i64>>(2)?,
                        "lastEvaluatedAtMs": r.get::<_, i64>(3)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
            } else {
                vec![]
            };
            let occurrences: Vec<Value> = if has_occ_table {
                let mut stmt = db.prepare(
                    "SELECT occurrence_key, job_id, occurrence_at_ms, run_id, status, recorded_at_ms
                     FROM core_cron_occurrences
                     WHERE (?1 IS NULL OR job_id = ?1)
                     ORDER BY recorded_at_ms DESC LIMIT ?2",
                )?;
                stmt.query_map(params![job_id.as_deref(), cap], |r| {
                    Ok(json!({
                        "occurrenceKey": r.get::<_, String>(0)?,
                        "jobId": r.get::<_, String>(1)?,
                        "occurrenceAtMs": r.get::<_, i64>(2)?,
                        "runId": r.get::<_, Option<String>>(3)?,
                        "status": r.get::<_, String>(4)?,
                        "recordedAtMs": r.get::<_, i64>(5)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
            } else {
                vec![]
            };
            Ok(json!({
                "status": "ok",
                "config": cfg,
                "schedules": states,
                "occurrences": occurrences,
            }))
        }
        Command::NextRun { job_id, now_ms: at } => {
            let at = at.unwrap_or_else(now_ms);
            let job = fetch_job(db, &job_id)?;
            let next = job.as_ref().and_then(|j| compute_next_run_at(j, at));
            Ok(json!({
                "status": "ok",
                "jobId": job_id,
                "nextRunAt": next,
            }))
        }
        _ => Ok(json!({ "status": "rejected", "code": "NOT_READ_ONLY" })),
    }
}

pub fn execute_write(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    client: &ClientContext,
    command: Command,
) -> crate::Result<WriteSideEffects> {
    let core_gen = current_core_generation();
    ensure_protocol_tables(db, &core_gen)?;
    ensure_cron_scheduler_tables(db)?;

    let tx = db.transaction()?;
    let mut events = Vec::new();
    let mut dispatches = Vec::new();

    let data = match command {
        Command::SyncConfig {
            dots_followup_mode,
            dots_space_ids,
            dots_suspended,
            default_model_id,
            skill_names,
            connectors,
        } => {
            let now = now_ms();
            let mut cfg = load_config(&tx)?;
            if let Some(mode) = dots_followup_mode {
                cfg.dots_followup_mode = mode;
            }
            if let Some(spaces) = dots_space_ids {
                cfg.dots_space_ids = spaces;
            }
            if let Some(susp) = dots_suspended {
                cfg.dots_suspended = susp;
            }
            if let Some(dm) = default_model_id {
                cfg.default_model_id = dm;
            }
            if let Some(sn) = skill_names {
                cfg.skill_names = sn;
            }
            if let Some(conn) = connectors {
                cfg.connectors = conn;
            }
            save_config(&tx, &cfg)?;
            if cfg.started {
                let jobs = fetch_all_jobs(&tx)?;
                for job in &jobs {
                    if job.is_dots() {
                        arm_job_state_tx(&tx, job, &cfg, true, now)?;
                    }
                }
            }
            json!({ "status": "ok", "config": cfg })
        }
        Command::Start { now_ms: at } => {
            let now = at.unwrap_or_else(now_ms);
            let armed =
                startup_or_scan_tx(&tx, &core_gen, &client.generation, true, now, &mut events)?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            json!({ "status": "ok", "started": true, "armedJobs": armed, "nowMs": now })
        }
        Command::ScanRecovery { now_ms: at } => {
            let now = at.unwrap_or_else(now_ms);
            let armed =
                startup_or_scan_tx(&tx, &core_gen, &client.generation, false, now, &mut events)?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            json!({ "status": "ok", "armedJobs": armed, "nowMs": now })
        }
        Command::Tick {
            now_ms: at,
            simulate_sleep_jump,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let summary = tick_tx(
                &tx,
                &core_gen,
                &client.generation,
                now,
                simulate_sleep_jump.unwrap_or(false),
                &mut events,
            )?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            summary
        }
        Command::RunNow { job_id, now_ms: at } => {
            let now = at.unwrap_or_else(now_ms);
            let Some(job) = fetch_job(&tx, &job_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "NOT_FOUND", "message": format!("cron job not found: {job_id}") }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            if job.cancelled_at.is_some() {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "CANCELLED", "message": "Cancelled automation cannot be run" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if let Some(reason) = unavailable_reason(&tx, &job)? {
                return Ok(WriteSideEffects {
                    data: json!({ "status": "rejected", "code": "UNAVAILABLE", "message": reason }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let cfg = load_config(&tx)?;
            let seq: i64 = tx.query_row(
                "SELECT COUNT(*) FROM core_cron_occurrences WHERE job_id = ?1",
                [&job.id],
                |r| r.get(0),
            )?;
            let manual_key = format!("manual:{}:{now}:{}", job.id, seq + 1);
            let run_id = dispatch_new_run_tx(
                &tx,
                &core_gen,
                &client.generation,
                &mut events,
                &job,
                &cfg,
                manual_key,
                None,
                true,
                now,
            )?;
            dispatch_waiting_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            json!({ "status": "ok", "jobId": job.id, "runId": run_id })
        }
        Command::RefreshJob {
            job_id,
            restoring,
            now_ms: at,
        } => {
            let now = at.unwrap_or_else(now_ms);
            let cfg = load_config(&tx)?;
            let jobs = match job_id {
                Some(id) => fetch_job(&tx, &id)?.into_iter().collect(),
                None => fetch_all_jobs(&tx)?,
            };
            let mut armed = 0usize;
            for job in &jobs {
                if arm_job_state_tx(&tx, job, &cfg, restoring.unwrap_or(false), now)?.is_some() {
                    armed += 1;
                }
            }
            json!({ "status": "ok", "armed": armed })
        }
        Command::SetDotsProactive { source, space_id, pause } => {
            set_dots_proactive_tx(&tx, &core_gen, &client.generation, &mut events, &source, space_id.as_deref().unwrap_or(""), pause, now_ms())?
        }
        Command::Stop => {
            let now = now_ms();
            let mut cfg = load_config(&tx)?;
            cfg.started = false;
            save_config(&tx, &cfg)?;
            tx.execute("DELETE FROM core_cron_schedule_state", [])?;
            tx.execute(
                "UPDATE core_execution_runs SET status = 'cancelled', updated_at_ms = ?1
                 WHERE kind = 'cron' AND status IN ('queued', 'waiting_executor')",
                [now],
            )?;
            json!({ "status": "ok", "stopped": true })
        }
        Command::Status { .. } | Command::NextRun { .. } => {
            json!({ "status": "rejected", "code": "READ_ONLY" })
        }
    };

    crate::request_control::commit(tx)?;
    crate::work_scheduler::apply_committed_promotion_dispatches(tracker, &dispatches);
    Ok(WriteSideEffects {
        data,
        events,
        dispatches,
        shutdown_after_reply: false,
    })
}

pub fn run_supervised_tick(
    db: &mut Connection,
    tracker: &ExecutorTracker,
) -> crate::Result<Option<WriteSideEffects>> {
    if !table_exists(db, "core_cron_runtime_config")? {
        return Ok(None);
    }
    let cfg = load_config(db)?;
    if !cfg.started {
        return Ok(None);
    }
    let core_gen = current_core_generation();
    let ctx = ClientContext::synthetic(&core_gen);
    let fx = execute_write(
        db,
        tracker,
        &ctx,
        Command::Tick {
            now_ms: None,
            simulate_sleep_jump: None,
        },
    )?;
    if fx.events.is_empty() && fx.dispatches.is_empty() {
        Ok(None)
    } else {
        Ok(Some(fx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::CANONICAL_DUCKDB_SCHEMA_SQL;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(CANONICAL_DUCKDB_SCHEMA_SQL).expect("schema");
        let core_gen = current_core_generation();
        ensure_protocol_tables(&conn, &core_gen).expect("protocol tables");
        ensure_cron_scheduler_tables(&conn).expect("cron tables");
        conn
    }

    #[test]
    fn cron_skip_vs_coalesce_and_clock_backward_dedup() {
        let mut conn = setup_db();
        let tracker = ExecutorTracker::default();
        let ctx = ClientContext::synthetic("test-gen");
        let t0 = 1_700_000_000_000i64;
        conn.execute(
            "INSERT INTO tasks (id, title, status, updated_at) VALUES ('src', 'Source', 'idle', ?1)",
            [t0],
        )
        .unwrap();
        // Job A: standard cron with missedRuns = "skip", every 1h
        conn.execute(
            "INSERT INTO cron_jobs (id, name, prompt, schedule_type, schedule_expr, timezone, enabled, created_at, updated_at, execution_json)
             VALUES ('job-skip', 'SkipJob', 'check skip', 'every', '1h', 'UTC', 1, ?1, ?1, ?2)",
            params![
                t0,
                json!({ "sourceTaskId": "src", "target": { "kind": "new-task" }, "missedRuns": "skip" }).to_string()
            ],
        )
        .unwrap();
        // Job B: Dots job with missedRuns = "coalesce", every 1h
        conn.execute(
            "INSERT INTO tasks (id, title, status, updated_at) VALUES (?1, 'Dots', 'idle', ?2)",
            params![DOTS_TASK_ID, t0],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cron_jobs (id, name, prompt, schedule_type, schedule_expr, timezone, enabled, created_at, updated_at, execution_json)
             VALUES ('job-coalesce', 'CoalesceJob', 'check dots', 'every', '1h', 'UTC', 1, ?1, ?1, ?2)",
            params![
                t0,
                json!({ "sourceTaskId": DOTS_TASK_ID, "target": { "kind": "task", "taskId": DOTS_TASK_ID }, "missedRuns": "coalesce" }).to_string()
            ],
        )
        .unwrap();

        execute_write(&mut conn, &tracker, &ctx, Command::Start { now_ms: Some(t0) }).unwrap();

        // Simulate 3h20m sleep jump: 3 intervals passed!
        let jump_now = t0 + 3 * 3_600_000 + 1_200_000;
        let res = execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::Tick {
                now_ms: Some(jump_now),
                simulate_sleep_jump: Some(true),
            },
        )
        .unwrap();
        assert_eq!(res.data["skippedMissed"], json!(1));
        assert_eq!(res.data["fired"], json!(1));

        // SkipJob must have 0 runs; CoalesceJob must have exactly 1 coalesced run (not 3).
        let skip_runs: i64 = conn
            .query_row("SELECT COUNT(*) FROM cron_runs WHERE job_id = 'job-skip'", [], |r| r.get(0))
            .unwrap();
        let coalesce_runs: i64 = conn
            .query_row("SELECT COUNT(*) FROM cron_runs WHERE job_id = 'job-coalesce'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(skip_runs, 0);
        assert_eq!(coalesce_runs, 1);

        // Fire SkipJob cleanly on its next due hour (t0 + 4h)
        let fourth_hour = t0 + 4 * 3_600_000;
        // Finish CoalesceJob run first so both are settleable
        let coalesce_exec: String = conn
            .query_row(
                "SELECT execution_id FROM core_execution_runs WHERE kind = 'cron' AND json_extract_string(payload_json, '$.cronJobId') = 'job-coalesce'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        {
            let tx = conn.transaction().unwrap();
            let mut fx_ev = vec![];
            on_core_execution_state_change(&tx, "test-gen", "test-gen", &coalesce_exec, "completed", None, None, jump_now + 1000, &mut fx_ev).unwrap();
            tx.commit().unwrap();
        }
        execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::Tick {
                now_ms: Some(fourth_hour),
                simulate_sleep_jump: None,
            },
        )
        .unwrap();
        let skip_runs_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM cron_runs WHERE job_id = 'job-skip'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(skip_runs_after, 1);

        // Clock backward jump across the already-fired fourth_hour must NOT duplicate skip_runs.
        execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::Tick {
                now_ms: Some(fourth_hour - 120_000),
                simulate_sleep_jump: None,
            },
        )
        .unwrap();
        execute_write(
            &mut conn,
            &tracker,
            &ctx,
            Command::Tick {
                now_ms: Some(fourth_hour),
                simulate_sleep_jump: None,
            },
        )
        .unwrap();
        let skip_runs_dedup: i64 = conn
            .query_row("SELECT COUNT(*) FROM cron_runs WHERE job_id = 'job-skip'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(skip_runs_dedup, 1);
    }
}
