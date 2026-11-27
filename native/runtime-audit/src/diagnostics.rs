use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

fn nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

fn present<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Source {
    Main,
    Subagent,
    Auxiliary,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CostSource {
    ProviderReported,
    PiNative,
    SdkDefault,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    #[serde(deserialize_with = "nullable")]
    input: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    output: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    cache_read: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    cache_write: Option<f64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Attempt {
    number: f64,
    started_at: f64,
    #[serde(deserialize_with = "nullable")]
    finished_at: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    http_status: Option<f64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheContext {
    #[serde(deserialize_with = "nullable")]
    previous_request_id: Option<String>,
    #[serde(deserialize_with = "nullable")]
    prefix_stable: Option<bool>,
    changed_fields: Vec<String>,
    coverage: String,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum RequestStatus {
    Running,
    Completed,
    Failed,
    Aborted,
    Interrupted,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    #[serde(deserialize_with = "nullable")]
    task_id: Option<String>,
    execution_scope: String,
    conversation_id: String,
    generation_task_id: f64,
    #[serde(default, deserialize_with = "present")]
    execution_id: Option<String>,
    source_kind: Source,
    provider: String,
    model: String,
    started_at: f64,
    #[serde(deserialize_with = "nullable")]
    first_response_at: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    finished_at: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    model_ms: Option<f64>,
    status: RequestStatus,
    #[serde(deserialize_with = "nullable")]
    outcome: Option<String>,
    #[serde(deserialize_with = "nullable")]
    error: Option<String>,
    usage: Usage,
    #[serde(deserialize_with = "nullable")]
    usage_source: Option<String>,
    #[serde(deserialize_with = "nullable")]
    known_cost_usd: Option<f64>,
    cost_complete: bool,
    #[serde(deserialize_with = "nullable")]
    cost_source: Option<CostSource>,
    attempts: Vec<Attempt>,
    cache_context: CacheContext,
}

impl Request {
    fn ensure_execution_id(&mut self) {
        if self.execution_id.is_some() {
            return;
        }
        let prefix = match self.task_id.as_deref() {
            Some(id)
                if !id.is_empty()
                    && (self.execution_scope.is_empty() || self.execution_scope == id) =>
            {
                format!("durable:{id}")
            }
            _ if self.execution_scope.is_empty() => "global".into(),
            _ => self.execution_scope.clone(),
        };
        self.execution_id = Some(format!(
            "{prefix}:{}:{}",
            self.conversation_id, self.generation_task_id
        ));
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Interval {
    start: f64,
    end: f64,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ToolStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredTool {
    id: String,
    task_id: String,
    conversation_id: String,
    execution_id: String,
    source_kind: Source,
    name: String,
    call_id: String,
    started_at: f64,
    #[serde(deserialize_with = "nullable")]
    finished_at: Option<f64>,
    status: ToolStatus,
    complete: bool,
    intervals: Vec<Interval>,
    #[serde(deserialize_with = "nullable")]
    segment_started_at: Option<f64>,
    diagnostics: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    generation_task_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ToolPhase {
    Start,
    Finish,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolEvent {
    phase: ToolPhase,
    task_id: Option<String>,
    execution_scope: Option<String>,
    conversation_id: String,
    tool_task_id: i64,
    generation_task_id: Option<i64>,
    call_id: String,
    name: String,
    source_kind: Source,
    at: f64,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    diagnostics: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Write {
    Trace { request: TraceRequest },
    Tool { event: ToolEvent },
}

impl Write {
    pub(crate) fn record_key(&self) -> String {
        match self {
            Self::Trace { request } => format!("request:{}", request.id),
            Self::Tool { event } => format!("tool:{}:{}:{}",
                event.execution_scope.as_deref().or(event.task_id.as_deref()).unwrap_or(""),
                event.conversation_id, event.tool_task_id),
        }
    }

    pub(crate) fn task_ids(&self) -> impl Iterator<Item = &str> {
        let (trace, task) = match self {
            Self::Trace { request } => (request.events.as_slice(), None),
            Self::Tool { event } => (&[][..], event.task_id.as_deref()),
        };
        trace.iter().filter_map(|event| event.task_id.as_deref()).chain(task)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRequest {
    id: String,
    provider: String,
    model: String,
    started_at: f64,
    events: Vec<TraceEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TraceKind {
    Started,
    Execution,
    FirstResponse,
    Request,
    HttpResult,
    Result,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviousRequest {
    request: String,
    prefix: Option<bool>,
    changed_fields: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceEvent {
    event: TraceKind,
    at: f64,
    task_id: Option<String>,
    conversation_id: Option<String>,
    generation_task_id: Option<f64>,
    source_kind: Option<Source>,
    execution_scope: Option<String>,
    model_ms: Option<f64>,
    reported_usage: Option<Usage>,
    usage_source: Option<String>,
    outcome: Option<String>,
    error: Option<String>,
    native_cost_total: Option<f64>,
    native_cost_source: Option<CostSource>,
    native_cost_complete: Option<bool>,
    stage: Option<String>,
    attempt: Option<f64>,
    status: Option<f64>,
    coverage: Option<String>,
    previous: Option<PreviousRequest>,
}

fn reduce_trace(row: &mut Request, event: TraceEvent) {
    match event.event {
        TraceKind::Started => {}
        TraceKind::Execution => {
            if let (Some(conversation), Some(generation)) =
                (event.conversation_id, event.generation_task_id)
                && !conversation.is_empty()
            {
                row.execution_scope = event
                    .execution_scope
                    .or_else(|| event.task_id.clone())
                    .unwrap_or_else(|| "global".into());
                row.task_id = event.task_id;
                row.conversation_id = conversation;
                row.generation_task_id = generation;
                row.source_kind = event.source_kind.unwrap_or(Source::Main);
            }
        }
        TraceKind::FirstResponse => {
            row.first_response_at.get_or_insert(event.at);
        }
        TraceKind::Request => {
            let http = event.stage.as_deref() == Some("http");
            if let Some(number) = event.attempt.filter(|number| *number != 0.0)
                && http
                && !row.attempts.iter().any(|item| item.number == number)
            {
                row.attempts.push(Attempt {
                    number,
                    started_at: event.at,
                    finished_at: None,
                    http_status: None,
                });
            }
            if event
                .previous
                .as_ref()
                .map(|previous| previous.request.as_str())
                != Some(row.id.as_str())
                && (http || row.cache_context.coverage == "unobserved")
            {
                let (request, prefix, changed_fields) = event
                    .previous
                    .map(|previous| {
                        (
                            Some(previous.request),
                            previous.prefix,
                            previous.changed_fields,
                        )
                    })
                    .unwrap_or_default();
                row.cache_context = CacheContext {
                    previous_request_id: request,
                    prefix_stable: prefix,
                    changed_fields,
                    coverage: event.coverage.unwrap_or_else(|| "unobserved".into()),
                };
            }
        }
        TraceKind::HttpResult => {
            if let Some(attempt) = row
                .attempts
                .iter_mut()
                .find(|item| Some(item.number) == event.attempt)
            {
                attempt.finished_at = Some(event.at);
                attempt.http_status = event.status;
            }
        }
        TraceKind::Result => {
            if row.finished_at.is_some() {
                return;
            }
            row.finished_at = Some(event.at);
            row.model_ms = event.model_ms;
            row.status = match event.outcome.as_deref() {
                Some("error") => RequestStatus::Failed,
                Some("aborted") => RequestStatus::Aborted,
                Some("observation-failed") => RequestStatus::Interrupted,
                _ => RequestStatus::Completed,
            };
            row.outcome = event.outcome;
            row.error = event.error;
            row.usage = event.reported_usage.unwrap_or_default();
            row.usage_source = event.usage_source;
            row.cost_complete =
                event.native_cost_complete == Some(true) && event.native_cost_total.is_some();
            row.known_cost_usd = if row.cost_complete
                || matches!(
                    event.native_cost_source,
                    Some(CostSource::ProviderReported | CostSource::PiNative)
                ) {
                event.native_cost_total
            } else {
                None
            };
            row.cost_source = event.native_cost_source;
        }
    }
}

fn write_trace(db: &Connection, request: TraceRequest) -> Result<()> {
    let stored: Option<String> = db
        .prepare("SELECT record_json FROM task_request_diagnostics WHERE request_id=?1")?
        .query_row([&request.id], |row| row.get(0))
        .optional()?;
    let mut row = if let Some(stored) = stored {
        let Ok(row) = serde_json::from_str::<Request>(&stored) else {
            return Ok(());
        };
        row
    } else {
        Request {
            id: request.id,
            task_id: None,
            execution_scope: String::new(),
            conversation_id: String::new(),
            generation_task_id: 0.0,
            execution_id: None,
            source_kind: Source::Main,
            provider: request.provider,
            model: request.model,
            started_at: request.started_at,
            first_response_at: None,
            finished_at: None,
            model_ms: None,
            status: RequestStatus::Running,
            outcome: None,
            error: None,
            usage: Usage::default(),
            usage_source: None,
            known_cost_usd: None,
            cost_complete: false,
            cost_source: None,
            attempts: Vec::new(),
            cache_context: CacheContext {
                previous_request_id: None,
                prefix_stable: None,
                changed_fields: Vec::new(),
                coverage: "unobserved".into(),
            },
        }
    };
    for event in request.events {
        reduce_trace(&mut row, event);
    }
    if row.conversation_id.is_empty() {
        return Ok(());
    }
    if let Some(task) = &row.task_id
        && !task_exists(db, task)?
    {
        return Ok(());
    }
    row.execution_id = None;
    row.ensure_execution_id();
    db.prepare(
        "INSERT INTO task_request_diagnostics VALUES(?1,?2,?3,?4)
         ON CONFLICT(request_id) DO UPDATE SET record_json=excluded.record_json,task_id=excluded.task_id",
    )?.execute(params![row.id, row.task_id, row.started_at, serde_json::to_string(&row)?])?;
    Ok(())
}

fn task_exists(db: &Connection, task_id: &str) -> duckdb::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
        [task_id],
        |row| row.get(0),
    )
}

fn write_tool(db: &Connection, event: ToolEvent) -> Result<()> {
    let task = event.task_id.as_deref().filter(|id| !id.is_empty());
    let scope = event.execution_scope.as_deref();
    let (table, owner) = match (task, scope) {
        (Some(task), _) if task_exists(db, task)? => ("task_tool_diagnostics", task),
        (None, Some(scope)) if !scope.is_empty() => ("scope_tool_diagnostics", scope),
        _ => return Ok(()),
    };
    let id = format!(
        "{}:{}:{}",
        scope.or(task).unwrap_or(owner),
        event.conversation_id,
        event.tool_task_id
    );
    let execution_id = |generation: Option<i64>| match generation.filter(|id| *id >= 0) {
        Some(generation) => {
            let scope = scope.filter(|value| !value.is_empty());
            let prefix = match task {
                Some(task) if scope.is_none() || scope == Some(task) => format!("durable:{task}"),
                _ => scope.unwrap_or("global").to_owned(),
            };
            format!("{}:{}:{}", prefix, event.conversation_id, generation)
        }
        None => {
            let prefix = if task.is_some() {
                format!("durable:{owner}")
            } else {
                owner.to_owned()
            };
            format!(
                "{}:{}:{}",
                prefix, event.conversation_id, event.tool_task_id
            )
        }
    };
    let raw: Option<String> = db
        .prepare(&format!("SELECT record_json FROM {table} WHERE id=?1"))?
        .query_row([&id], |row| row.get(0))
        .optional()?;
    let mut tool = if let Some(raw) = raw {
        serde_json::from_str::<StoredTool>(&raw)?
    } else {
        StoredTool {
            id,
            task_id: owner.to_owned(),
            execution_id: execution_id(event.generation_task_id),
            conversation_id: event.conversation_id.clone(),
            source_kind: event.source_kind,
            call_id: event.call_id,
            name: event.name,
            started_at: event.at,
            finished_at: None,
            status: ToolStatus::Running,
            complete: true,
            intervals: Vec::new(),
            segment_started_at: None,
            diagnostics: Vec::new(),
            generation_task_id: event.generation_task_id,
        }
    };
    if matches!(tool.status, ToolStatus::Completed | ToolStatus::Failed) {
        return Ok(());
    }
    if event.generation_task_id.is_some() && tool.generation_task_id != event.generation_task_id {
        tool.generation_task_id = event.generation_task_id;
        tool.execution_id = execution_id(event.generation_task_id);
    }
    match event.phase {
        ToolPhase::Start => {
            tool.status = ToolStatus::Running;
            tool.segment_started_at.get_or_insert(event.at);
        }
        ToolPhase::Finish => {
            if let Some(start) = tool.segment_started_at.take() {
                tool.intervals.push(Interval {
                    start,
                    end: start.max(event.at),
                });
            } else {
                tool.complete = false;
            }
            tool.status = if event.is_error {
                ToolStatus::Failed
            } else {
                ToolStatus::Completed
            };
            tool.finished_at = Some(event.at);
            tool.diagnostics = event.diagnostics;
        }
    }
    db.prepare(&format!(
        "INSERT INTO {table} VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json"
    ))?
    .execute(params![
        tool.id,
        tool.task_id,
        tool.started_at,
        serde_json::to_string(&tool)?
    ])?;
    Ok(())
}

pub fn write_batch(db: &mut Connection, writer_id: &str, sequence: i64, writes: Vec<Write>) -> Result<()> {
    if writes.is_empty() || writes.len() > 64 || writer_id.is_empty() || writer_id.len() > 128 || sequence < 1 {
        return Err("invalid diagnostic batch size".into());
    }
    let tx = db.transaction()?;
    let claimed = tx.execute(
        "INSERT INTO runtime_diagnostic_writers(writer_id,sequence) VALUES(?,?)
         ON CONFLICT(writer_id) DO UPDATE SET sequence=excluded.sequence WHERE runtime_diagnostic_writers.sequence<excluded.sequence",
        params![writer_id, sequence],
    )?;
    if claimed > 0 {
        for write in writes {
            match write {
                Write::Trace { request } => write_trace(&tx, request)?,
                Write::Tool { event } => write_tool(&tx, event)?,
            }
        }
    }
    crate::request_control::commit(tx)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Wait {
    id: String,
    execution_id: String,
    title: String,
    started_at: f64,
    finished_at: Option<f64>,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    id: String,
    conversation_id: String,
    execution_id: String,
    source_kind: Source,
    name: String,
    call_id: String,
    started_at: f64,
    finished_at: Option<f64>,
    status: ToolStatus,
    observed_ms: f64,
    active_ms: f64,
    waiting_ms: f64,
    complete: bool,
    diagnostics: Vec<String>,
    derived_execution: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    model_ms: Option<f64>,
    tool_ms: Option<f64>,
    waiting_ms: f64,
    known_cost_usd: Option<f64>,
    cost_complete: bool,
    unknown_usage_requests: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPage {
    task_id: String,
    captured_at: f64,
    offset: u64,
    requests: Vec<Request>,
    tools: Vec<Tool>,
    waits: Vec<Wait>,
    truncated: bool,
    totals: Totals,
}

fn merge(mut intervals: Vec<Interval>) -> Vec<Interval> {
    intervals.retain(|interval| interval.end > interval.start);
    intervals.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut merged: Vec<Interval> = Vec::new();
    for interval in intervals {
        if let Some(previous) = merged
            .last_mut()
            .filter(|previous| previous.end >= interval.start)
        {
            previous.end = previous.end.max(interval.end);
        } else {
            merged.push(interval);
        }
    }
    merged
}

fn duration(intervals: &[Interval]) -> f64 {
    intervals.iter().fold(0.0, |total, interval| {
        total + (interval.end - interval.start)
    })
}

fn intersection(a: &[Interval], b: &[Interval]) -> f64 {
    let (mut i, mut j, mut total) = (0, 0, 0.0);
    while let (Some(left), Some(right)) = (a.get(i), b.get(j)) {
        total += (left.end.min(right.end) - left.start.max(right.start)).max(0.0);
        if left.end <= right.end {
            i += 1;
        } else {
            j += 1;
        }
    }
    total
}

fn sum_known(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    values.flatten().reduce(|sum, value| sum + value)
}

pub fn read(
    db: &Connection,
    task_id: &str,
    limit: Option<u32>,
    offset: u64,
    now: f64,
) -> Result<DiagnosticPage> {
    let limit = limit.map(|value| value.clamp(1, 500) as i64);
    let page_size = limit.map(|value| value + 1);
    let skip = if limit.is_some() { offset } else { 0 };
    let mut request_statement = db.prepare(
        "SELECT record_json FROM task_request_diagnostics WHERE task_id=?1
         ORDER BY started_at DESC,request_id DESC LIMIT ?2 OFFSET ?3",
    )?;
    let mut tool_statement = db.prepare(
        "SELECT record_json FROM task_tool_diagnostics WHERE task_id=?1
         ORDER BY started_at DESC,id DESC LIMIT ?2 OFFSET ?3",
    )?;
    let mut wait_statement = db.prepare(
        "SELECT id,execution_id,title,created_at,resolved_at,status FROM conversation_interactions
         WHERE task_id=?1 ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3",
    )?;
    let mut request_rows = request_statement.query(params![task_id, page_size, skip])?;
    let mut tool_rows = tool_statement.query(params![task_id, page_size, skip])?;
    let mut wait_rows = wait_statement.query(params![task_id, page_size, skip])?;
    let mut truncated = false;
    let max = limit.unwrap_or(i64::MAX);
    let mut requests = Vec::new();
    let mut stored = Vec::new();
    let mut waits = Vec::new();
    for index in 0.. {
        let Some(row) = request_rows.next()? else {
            break;
        };
        if index == max {
            truncated = true;
            break;
        }
        let raw = row.get_ref(0)?.as_str()?;
        // Let the host apply its existing compatibility handling to unexpected records.
        let mut request = serde_json::from_str::<Request>(raw)?;
        request.ensure_execution_id();
        requests.push(request);
    }
    for index in 0.. {
        let Some(row) = tool_rows.next()? else { break };
        if index == max {
            truncated = true;
            break;
        }
        let raw = row.get_ref(0)?.as_str()?;
        stored.push(serde_json::from_str::<StoredTool>(raw)?);
    }
    for index in 0.. {
        let Some(row) = wait_rows.next()? else { break };
        if index == max {
            truncated = true;
            break;
        }
        waits.push(Wait {
            id: row.get(0)?,
            execution_id: row.get(1)?,
            title: row.get(2)?,
            started_at: row.get(3)?,
            finished_at: row.get(4)?,
            status: row.get(5)?,
        });
    }

    let mut completed: HashMap<&str, Vec<(f64, &str)>> = HashMap::new();
    for request in &requests {
        if request.execution_scope == task_id
            && (request.status != RequestStatus::Running || request.finished_at.is_some())
        {
            completed
                .entry(&request.conversation_id)
                .or_default()
                .push((
                    request.finished_at.unwrap_or(request.started_at),
                    request
                        .execution_id
                        .as_deref()
                        .expect("execution ID was derived"),
                ));
        }
    }
    for turns in completed.values_mut() {
        turns.sort_by(|a, b| a.0.total_cmp(&b.0));
    }
    let mapped_ids: HashMap<String, String> = stored
        .iter()
        .map(|tool| {
            let mut execution_id = tool.execution_id.as_str();
            if tool.generation_task_id.is_none()
                && let Some(turns) = completed.get(tool.conversation_id.as_str())
            {
                let index = turns.partition_point(|(at, _)| *at <= tool.started_at);
                if index > 0 {
                    execution_id = turns[index - 1].1;
                }
            }
            (format!("durable:{}", tool.id), execution_id.to_owned())
        })
        .collect();
    let mut waits_by_execution: HashMap<&str, Vec<Interval>> = HashMap::new();
    let mut all_waits = Vec::new();
    for wait in &mut waits {
        if let Some(execution_id) = mapped_ids.get(&wait.execution_id) {
            wait.execution_id.clone_from(execution_id);
        }
        let interval = Interval {
            start: wait.started_at,
            end: wait.finished_at.unwrap_or(now),
        };
        all_waits.push(interval);
        waits_by_execution
            .entry(&wait.execution_id)
            .or_default()
            .push(interval);
    }
    for intervals in waits_by_execution.values_mut() {
        *intervals = merge(std::mem::take(intervals));
    }

    let tools: Vec<Tool> = stored
        .into_iter()
        .map(|mut tool| {
            let execution_id = mapped_ids[&format!("durable:{}", tool.id)].clone();
            if let Some(start) = tool.segment_started_at {
                tool.intervals.push(Interval { start, end: now });
            }
            let intervals = merge(tool.intervals);
            let observed_ms = duration(&intervals);
            let waiting_ms = waits_by_execution
                .get(execution_id.as_str())
                .map_or(0.0, |wait_intervals| {
                    intersection(&intervals, wait_intervals)
                });
            let derived_execution =
                tool.generation_task_id.is_none() && execution_id != tool.execution_id;
            Tool {
                id: tool.id,
                conversation_id: tool.conversation_id,
                execution_id,
                source_kind: tool.source_kind,
                name: tool.name,
                call_id: tool.call_id,
                started_at: tool.started_at,
                finished_at: tool.finished_at,
                status: tool.status,
                observed_ms,
                active_ms: (observed_ms - waiting_ms).max(0.0),
                waiting_ms,
                complete: tool.complete,
                diagnostics: tool.diagnostics,
                derived_execution,
            }
        })
        .collect();
    let totals = Totals {
        model_ms: sum_known(requests.iter().map(|value| value.model_ms)),
        tool_ms: tools
            .iter()
            .any(|value| value.complete || value.observed_ms > 0.0)
            .then(|| tools.iter().map(|value| value.active_ms).sum::<f64>()),
        waiting_ms: duration(&merge(all_waits)),
        known_cost_usd: sum_known(requests.iter().map(|value| value.known_cost_usd)),
        cost_complete: !requests.is_empty() && requests.iter().all(|value| value.cost_complete),
        unknown_usage_requests: requests
            .iter()
            .filter(|value| {
                [
                    value.usage.input,
                    value.usage.output,
                    value.usage.cache_read,
                    value.usage.cache_write,
                ]
                .iter()
                .any(Option::is_none)
            })
            .count(),
    };
    Ok(DiagnosticPage {
        task_id: task_id.to_owned(),
        captured_at: now,
        offset,
        requests,
        tools,
        waits,
        truncated,
        totals,
    })
}
