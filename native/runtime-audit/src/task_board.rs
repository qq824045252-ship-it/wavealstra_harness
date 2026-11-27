use crate::Result;
use crate::database::{local_day_from_ms, value_ref_to_json};
use duckdb::{Connection, Statement, params, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

const HIDDEN: &str = "hidden(id) AS (
    SELECT id FROM spaces WHERE archived=1 {extra}
    UNION SELECT s.id FROM spaces s JOIN hidden h ON s.parent_id=h.id
)";
const SOURCES: &str = "board_native AS (
    SELECT t.id,t.title,t.space_id,t.status,t.updated_at,t.start_at,t.due_at,
      t.is_favorited AS pinned,t.done_acked_at AS ack,NULL::VARCHAR AS request_data,
      NULL::VARCHAR AS source_error,t.project_id
    FROM tasks t WHERE t.archived=0 AND t.id<>$dots
      AND (t.space_id IS NOT NULL OR NOT regexp_full_match(t.id,'gateway-chat-[a-f0-9]{64}'))
      AND NOT EXISTS (SELECT 1 FROM task_execution_workspace_state w WHERE w.task_id=t.id AND w.state='trashed')
  ), board_requests AS (
    SELECT 'bot-request:'||r.bot_id||':'||r.request_id AS id,
      coalesce(nullif(trim(substr(u.text,1,120)),''),'附件对话') AS title,board_space(r.bot_id,c.team_id) AS space_id,
      CASE a.status WHEN 'queued' THEN 'pending' WHEN 'running' THEN 'in_progress' WHEN 'cancelled' THEN 'stopped' ELSE a.status END AS status,
      a.updated_at,NULL::BIGINT AS start_at,NULL::BIGINT AS due_at,0 AS pinned,NULL::BIGINT AS ack,
      CAST(json_object('botId',r.bot_id,'teamId',c.team_id,'conversationId',r.conversation_id,'requestId',r.request_id,
        'messageId',a.message_id,'createdAt',u.created_at,'status',a.status) AS VARCHAR) AS request_data,
      a.error AS source_error,NULL::VARCHAR AS project_id
    FROM bot_send_receipts r JOIN bot_conversations c ON c.conversation_id=r.conversation_id
      JOIN bot_messages u ON u.message_id=r.user_message_id JOIN bot_messages a ON a.message_id=r.assistant_message_id
    WHERE r.user_id='user-local-primary' AND c.user_id=r.user_id
      AND NOT starts_with(c.conversation_id,'bot-inbox-') AND c.archived_at IS NULL
  )";
const VISIBLE: &str = "(b.space_id IS NULL OR b.space_id NOT IN (SELECT id FROM hidden))";
const WAITS: &str = "board_waits AS MATERIALIZED (
    SELECT CAST(key AS BIGINT) AS ordinal,json_extract_string(value,'$.id') AS id,
      json_extract_string(value,'$.token') AS token,json_extract_string(value,'$.message') AS message,
      json_extract_string(value,'$.detail') AS detail,CAST(json_extract(value,'$.at') AS BIGINT) AS \"at\"
    FROM json_each(CAST($waits AS JSON))
  )";
const LATEST_RESULT: &str = "(SELECT d.\"at\" FROM task_board_days d WHERE d.id=b.id AND d.kind='result' ORDER BY d.day DESC LIMIT 1)";
const AFTER_DEFERRAL: &str = "coalesce((SELECT p.deferred_at FROM task_board_plans p WHERE p.id=b.id AND p.later_until>$now),0)";
const QUESTION: &str =
    "SELECT i.id FROM conversation_interactions i WHERE i.task_id=b.id AND i.status='pending'";
const DEFERRED: &str = "(SELECT later_until FROM task_board_plans p WHERE p.id=b.id)";
const PLANNED: &str = "EXISTS (SELECT 1 FROM task_board_plans p WHERE p.id=b.id AND p.day=$day)";

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum View {
    Attention,
    Today,
    Running,
    Review,
    Week,
    Recent,
    Frequent,
    Dates,
    All,
    Unread,
    Pinned,
    Later,
    Results,
    Automation,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Lane {
    Attention,
    Pending,
    Running,
    Finished,
}

impl Lane {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attention => "attention",
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Finished => "finished",
        }
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DateKind {
    Follow,
    Result,
    Due,
    Updated,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    space_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ordinary {
    task_id: Option<String>,
    space_ids: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
struct Cursor {
    rank: i64,
    at: i64,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Calendar {
    now: i64,
    today: i64,
    tomorrow: i64,
    recent_from: i64,
    week_from: i64,
    week_until: i64,
    automation_from: i64,
}

#[derive(Deserialize, Serialize)]
struct Wait {
    id: String,
    token: String,
    message: Option<String>,
    detail: String,
    at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    view: View,
    lane: Option<Lane>,
    scope: Option<Scope>,
    project_id: Option<String>,
    search: Option<String>,
    job_id: Option<String>,
    date_kind: Option<DateKind>,
    from: Option<i64>,
    until: Option<i64>,
    cursor: Option<Cursor>,
    #[serde(default)]
    preview: bool,
    ordinary: Option<Ordinary>,
    calendar: Calendar,
    #[serde(default)]
    waits: Vec<Wait>,
}

#[derive(Serialize)]
pub struct Page {
    rows: Vec<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionInput {
    pub id: String,
    action: BoardAction,
    now: i64,
    later_until: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum BoardAction {
    Visit,
    Read,
    Today,
    Later,
    Clear,
}

fn board_prefix(ordinary: bool) -> String {
    let extra = if ordinary {
        "OR starts_with(id,'sp-gw-') OR starts_with(id,'bot-space-')
         OR starts_with(id,'bot-team-space-') OR starts_with(id,'bot-workspace-group-')"
    } else {
        ""
    };
    format!(
        "WITH RECURSIVE {},{SOURCES}",
        HIDDEN.replace("{extra}", extra)
    )
}

pub fn write_action(db: &mut Connection, input: ActionInput) -> Result<()> {
    let tx = db.transaction()?;
    let visibility = format!(
        "{}
      SELECT EXISTS(SELECT 1 FROM board_native b WHERE b.id=$id AND {VISIBLE}
        UNION ALL SELECT 1 FROM board_requests b WHERE b.id=$id AND {VISIBLE})",
        board_prefix(false)
    );
    let visible: bool = tx.query_row(
        &visibility,
        [
            ("dots", &crate::DOTS_TASK_ID as &dyn duckdb::ToSql),
            ("id", &input.id),
        ]
        .as_slice(),
        |row| row.get(0),
    )?;
    if visible {
        match input.action {
            BoardAction::Visit | BoardAction::Read => {
                let kind = if matches!(input.action, BoardAction::Visit) {
                    "visit"
                } else {
                    "read"
                };
                crate::trigger_effects::upsert_task_board_day_in_tx(
                    &tx, &input.id, kind, input.now, "",
                )?;
            }
            BoardAction::Today | BoardAction::Later => {
                let (day, later_until, deferred_at) = match input.action {
                    BoardAction::Today => (Some(local_day_from_ms(input.now)), None, None),
                    _ => {
                        let until = input
                            .later_until
                            .filter(|&until| until > input.now)
                            .ok_or("task board defer requires a future boundary")?;
                        (None, Some(until), Some(input.now))
                    }
                };
                tx.execute(
                    "INSERT INTO task_board_plans(id,day,later_until,deferred_at) VALUES(?1,?2,?3,?4)
                     ON CONFLICT(id) DO UPDATE SET day=excluded.day,
                       later_until=excluded.later_until,deferred_at=excluded.deferred_at",
                    params![input.id, day, later_until, deferred_at],
                )?;
            }
            BoardAction::Clear => {
                tx.execute("DELETE FROM task_board_plans WHERE id=?1", [input.id])?;
            }
        }
    }
    crate::request_control::commit(tx)
}

type Bindings = HashMap<&'static str, SqlValue>;

fn parameters<'a>(stmt: &Statement<'_>, params: &'a Bindings) -> Result<Vec<&'a SqlValue>> {
    (1..=stmt.parameter_count())
        .map(|index| {
            let key = stmt.parameter_name(index)?;
            params
                .get(key.as_str())
                .ok_or_else(|| format!("missing task board parameter {key}").into())
        })
        .collect()
}

fn rows(
    db: &Connection,
    sql: &str,
    params: &Bindings,
    size: usize,
) -> Result<Vec<Map<String, Value>>> {
    let mut stmt = db.prepare(sql)?;
    let values = parameters(&stmt, params)?;
    let mut result = stmt.query(params_from_iter(values))?;
    let mut found = Vec::with_capacity(size + 1);
    let names = result
        .as_ref()
        .map(|stmt| stmt.column_names())
        .unwrap_or_default();
    while let Some(row) = result.next()? {
        if found.len() > size {
            return Err("task board query exceeded its page size".into());
        }
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            record.insert(name.clone(), value_ref_to_json(row.get_ref(index)?)?);
        }
        found.push(record);
    }
    Ok(found)
}

fn bind_text(value: Option<&str>) -> SqlValue {
    value.map_or(SqlValue::Null, |text| SqlValue::Text(text.to_owned()))
}

fn haystack_search(query: &Query) -> &str {
    query.search.as_deref().unwrap_or_default().trim()
}

fn scoped_filter(query: &Query) -> &'static str {
    if query.scope.is_some() {
        "AND b.space_id IS NOT DISTINCT FROM $scope"
    } else {
        ""
    }
}

fn base_params(query: &Query, size: usize) -> Bindings {
    HashMap::from([
        ("dots", bind_text(Some(crate::DOTS_TASK_ID))),
        (
            "scope",
            bind_text(
                query
                    .scope
                    .as_ref()
                    .and_then(|scope| scope.space_id.as_deref()),
            ),
        ),
        ("term", bind_text(Some(haystack_search(query)))),
        ("limit", SqlValue::BigInt(size as i64 + 1)),
        (
            "id",
            bind_text(query.cursor.as_ref().map(|cursor| cursor.id.as_str())),
        ),
    ])
}

fn read_automation(db: &Connection, query: Query) -> Result<Page> {
    if query.ordinary.is_some() {
        return Err("自动化记录不属于普通任务看板".into());
    }
    let size = if query.preview { 4 } else { 25 };
    let scope = scoped_filter(&query);
    let chosen = if query.job_id.is_some() {
        "SELECT *,run_id AS id,1 AS runs FROM runs WHERE job_id=$job"
    } else {
        "SELECT *,job_id AS id FROM (SELECT *,count(*) OVER(PARTITION BY job_id) AS runs,
         row_number() OVER(PARTITION BY job_id ORDER BY started_at DESC,run_id DESC) AS position FROM runs) WHERE position=1"
    };
    let cursor = if query.cursor.is_some() {
        "WHERE started_at<$at OR (started_at=$at AND id>$id)"
    } else {
        ""
    };
    let sql = format!("{},runs AS (
      SELECT r.id AS run_id,r.job_id,r.started_at,r.status,r.error,b.id AS task_id,b.title,b.space_id,j.name
      FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id JOIN board_native b ON b.id=r.task_id
      WHERE r.started_at>=$from AND {VISIBLE} {scope} AND instr(lower(j.name),lower($term))>0
      ),chosen AS ({chosen})
      SELECT * FROM chosen {cursor} ORDER BY started_at DESC,id LIMIT $limit", board_prefix(false));
    let mut params = base_params(&query, size);
    params.extend([
        ("job", bind_text(query.job_id.as_deref())),
        (
            "at",
            SqlValue::BigInt(query.cursor.as_ref().map_or(0, |cursor| cursor.at)),
        ),
        ("from", SqlValue::BigInt(query.calendar.automation_from)),
    ]);
    Ok(Page {
        rows: rows(db, &sql, &params, size)?,
        total: None,
    })
}

fn rank_by_day(kinds: &str) -> String {
    format!(
        "SELECT id,max(\"at\") AS \"at\",count(DISTINCT day) AS n FROM task_board_days
        WHERE kind IN ({kinds}) AND \"at\">=$from AND \"at\"<$until GROUP BY id"
    )
}

pub fn read(db: &Connection, query: Query) -> Result<Page> {
    if query.view == View::Automation {
        return read_automation(db, query);
    }
    let q = &query;
    let cal = &q.calendar;
    let view = q.view;
    let focused = matches!(view, View::Attention | View::Today);
    let unread = format!(
        "(b.request_data IS NULL AND b.status IN ('completed','failed') AND
      coalesce(b.ack,0)<coalesce({LATEST_RESULT},b.ack,b.updated_at))"
    );
    let has_wait =
        format!("(EXISTS({QUESTION}) OR EXISTS(SELECT 1 FROM board_waits w WHERE w.id=b.id))");
    let mut rank = "0".to_owned();
    let mut at = "b.updated_at";
    let mut predicate = "TRUE".to_owned();
    let mut candidates = String::new();
    let (mut from, mut until) = (cal.recent_from, cal.tomorrow);
    match view {
        View::Recent | View::Frequent => {
            let frequent = view == View::Frequent;
            candidates = rank_by_day(if frequent {
                "'visit','follow'"
            } else {
                "'follow'"
            });
            if frequent {
                candidates.push_str(" HAVING count(DISTINCT day)>=2");
                rank = "k.n".into();
            }
            at = "k.\"at\"";
        }
        View::Dates | View::Results => {
            let kind = if view == View::Results {
                DateKind::Result
            } else {
                q.date_kind.unwrap_or(DateKind::Follow)
            };
            from = q.from.unwrap_or(from);
            until = q.until.unwrap_or(until);
            match kind {
                DateKind::Follow | DateKind::Result => {
                    candidates = rank_by_day(if kind == DateKind::Follow {
                        "'follow'"
                    } else {
                        "'result'"
                    });
                    at = "k.\"at\"";
                }
                DateKind::Due | DateKind::Updated => {
                    at = if kind == DateKind::Due {
                        "b.due_at"
                    } else {
                        "b.updated_at"
                    };
                    predicate = format!("{at}>=$from AND {at}<$until");
                }
            }
            if view == View::Results {
                predicate = "NOT EXISTS(SELECT 1 FROM cron_runs r WHERE r.task_id=b.id)
                  AND NOT EXISTS(SELECT 1 FROM task_board_days v WHERE v.id=b.id AND v.kind IN ('visit','read') AND v.\"at\">=k.\"at\")
                  AND coalesce(b.ack,0)<k.\"at\"".into();
                if q.preview {
                    candidates = "SELECT interest.id,max(d.\"at\") AS \"at\" FROM (
                        SELECT id FROM task_board_days WHERE kind IN ('follow','visit') AND \"at\">=$from AND \"at\"<$until
                        UNION SELECT id FROM tasks WHERE is_favorited=1
                        UNION SELECT id FROM task_board_plans WHERE day=$day
                      ) interest JOIN task_board_days d ON d.id=interest.id AND d.kind='result'
                      WHERE d.\"at\">=$from AND d.\"at\"<$until GROUP BY interest.id".into();
                }
            }
        }
        View::Attention | View::Today => {
            let failed = if view == View::Attention {
                "UNION ALL SELECT id,updated_at,0 FROM tasks WHERE status='failed' AND updated_at>=$from"
            } else {
                ""
            };
            candidates = format!("SELECT id,min(\"at\") AS \"at\",max(n) AS n,max(CASE WHEN n=3 THEN \"at\" END) AS newest_wait FROM (
              SELECT task_id AS id,created_at AS \"at\",3 AS n FROM conversation_interactions WHERE status='pending'
              UNION ALL SELECT id,\"at\",3 FROM board_waits
              UNION ALL SELECT id,due_at,2 FROM tasks WHERE archived=0 AND due_at<$end
                AND status IS DISTINCT FROM 'completed' AND status IS DISTINCT FROM 'stopped'
              UNION ALL SELECT id,$now,1 FROM task_board_plans WHERE day=$day
              UNION ALL SELECT id,later_until,1 FROM task_board_plans WHERE later_until>=$today AND later_until<=$now
              {failed}
            ) GROUP BY id");
            rank = "k.n".into();
            at = "-k.\"at\"";
            predicate = format!(
                "(k.n<>0 OR {unread}) AND (coalesce({DEFERRED},0)<=$now OR
                k.newest_wait>(SELECT p.deferred_at FROM task_board_plans p WHERE p.id=b.id))"
            );
            if view == View::Attention {
                predicate.push_str(
                    " AND (k.n>0 OR NOT EXISTS(SELECT 1 FROM cron_runs r WHERE r.task_id=b.id))",
                );
            }
        }
        View::Week => {
            from = cal.week_from;
            until = cal.week_until;
            predicate = "b.due_at>=$from AND b.due_at<$until AND coalesce(b.status,'planning') NOT IN ('completed','stopped')".into();
            at = "-b.due_at";
        }
        View::Later => {
            candidates =
                "SELECT id,later_until AS \"at\" FROM task_board_plans WHERE later_until>$now"
                    .into();
            at = "-k.\"at\"";
        }
        View::Running => {
            predicate = format!("b.status='in_progress' AND NOT {has_wait}");
            if q.preview {
                predicate
                    .push_str(" AND NOT EXISTS(SELECT 1 FROM cron_runs r WHERE r.task_id=b.id)");
            }
        }
        View::Review => {
            candidates =
                "SELECT DISTINCT task_id AS id FROM task_code_review WHERE status='pending'".into()
        }
        View::Unread => predicate = unread.clone(),
        View::Pinned => predicate = "b.pinned=1".into(),
        View::All => {}
        View::Automation => unreachable!(),
    }
    if let Some(lane) = q.lane {
        predicate.push_str(&format!(" AND (CASE WHEN b.status IN ('failed','unknown') OR {has_wait} THEN 'attention'
          WHEN b.status='in_progress' THEN 'running' WHEN b.status IN ('completed','stopped') THEN 'finished' ELSE 'pending' END)=$lane"));
        if lane == Lane::Attention && rank == "0" {
            rank = format!("CASE WHEN {has_wait} THEN 1 ELSE 0 END");
        }
    }
    if q.preview && !focused {
        predicate.push_str(&format!(" AND coalesce({DEFERRED},0)<=$now"));
    }
    let scope = scoped_filter(q);
    let project = if q.project_id.as_deref().is_some_and(|id| !id.is_empty()) {
        "AND b.project_id=$project"
    } else {
        ""
    };
    let search = if haystack_search(q).is_empty() {
        ""
    } else {
        "AND instr(lower(b.title),lower($term))>0"
    };
    let mut ordinary = String::new();
    if let Some(filter) = &q.ordinary {
        ordinary.push_str("AND NOT starts_with(b.id,'gw-') AND NOT starts_with(b.id,'gateway-chat-')
          AND NOT starts_with(coalesce(b.space_id,''),'sp-gw-')
          AND NOT EXISTS (SELECT 1 FROM tasks ext WHERE ext.id=b.id AND ext.external_agent_pin_json IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM gateway_sidebar_conversations g WHERE g.task_id=b.id)
          AND NOT EXISTS (SELECT 1 FROM work_execution_bindings e WHERE e.task_id=b.id)");
        if filter.task_id.as_deref().is_some_and(|id| !id.is_empty()) {
            ordinary.push_str(" AND b.id=$task");
        }
        if filter.space_ids.is_some() {
            ordinary.push_str(" AND b.space_id IN (SELECT json_extract_string(value,'$') FROM json_each(CAST($spaces AS JSON)))");
        }
    }
    let mut prefix = format!("{},{WAITS}", board_prefix(q.ordinary.is_some()));
    if !candidates.is_empty() {
        prefix.push_str(&format!(", ranked AS MATERIALIZED ({candidates})"));
    }
    let sources: &[&str] = if q.ordinary.is_some() || view == View::Review {
        &["board_native"]
    } else {
        &["board_native", "board_requests"]
    };
    let select = |paged: bool| {
        sources.iter().map(|source| {
            let fields = if paged { format!("b.*,{rank} AS rank,{at} AS \"at\"") } else { "b.id".into() };
            let source = if candidates.is_empty() { format!("{source} b") } else { format!("ranked k JOIN {source} b ON b.id=k.id") };
            let cursor = if paged && q.cursor.is_some() {
                format!("AND (({rank})<$rank OR (({rank})=$rank AND (({at})<$at OR (({at})=$at AND b.id>$id))))")
            } else { String::new() };
            format!("SELECT {fields} FROM {source} WHERE ({predicate}) AND {VISIBLE} {scope} {project} {search} {ordinary} {cursor}")
        }).collect::<Vec<_>>().join(" UNION ALL ")
    };
    let signal_kind = match (view, q.date_kind) {
        (View::Recent, _) | (View::Dates, Some(DateKind::Follow)) => Some("follow"),
        (View::Results, _) | (View::Dates, Some(DateKind::Result)) => Some("result"),
        _ => None,
    };
    let signal = if signal_kind.is_some() {
        "(SELECT detail FROM task_board_days d WHERE d.id=b.id AND d.kind=$kind AND d.\"at\"=b.\"at\" ORDER BY d.day DESC LIMIT 1)"
    } else {
        "NULL"
    };
    let wait_since = if focused { AFTER_DEFERRAL } else { "0" };
    let sql = format!("{prefix}, page AS MATERIALIZED (SELECT * FROM ({}) ORDER BY rank DESC,\"at\" DESC,id LIMIT $limit)
      SELECT b.*, {unread} AS is_unread,{PLANNED} AS is_planned,{DEFERRED} AS later_until,
        i.id AS question_id,{LATEST_RESULT} AS latest_result,
        CASE WHEN b.request_data IS NULL THEN (
          SELECT count(*) FROM task_code_review c WHERE c.task_id=b.id AND c.status='pending') ELSE 0 END AS pending_reviews,
        CASE WHEN i.id IS NOT NULL THEN 'question' WHEN w.token<>'' THEN 'approval' WHEN w.token='' THEN 'input' END AS wait_kind,
        CASE WHEN i.id IS NOT NULL THEN i.title WHEN w.token<>'' THEN w.detail END AS wait_reason,
        CASE WHEN b.status='failed' THEN coalesce(substr(b.source_error,1,240),(
          SELECT CASE WHEN type='task.failed' THEN substr(body,1,240) END FROM notifications
          WHERE task_id=b.id AND type IN ('task.failed','task.completed') ORDER BY created_at DESC,id DESC LIMIT 1
        )) END AS failure,coalesce(i.assistant_message_id,w.message) AS message,
        CASE WHEN i.id IS NULL THEN nullif(w.token,'') END AS tool,{signal} AS signal
      FROM page b LEFT JOIN LATERAL (SELECT i.id,i.title,i.assistant_message_id FROM conversation_interactions i
        WHERE i.task_id=b.id AND i.status='pending' AND i.created_at>={wait_since}
        ORDER BY i.created_at,i.id LIMIT 1) i ON TRUE
      LEFT JOIN LATERAL (SELECT w2.token,w2.message,w2.detail FROM board_waits w2
        WHERE w2.id=b.id AND w2.\"at\">={wait_since} ORDER BY (w2.token=''),w2.\"at\",w2.ordinal LIMIT 1) w ON TRUE
      ORDER BY b.rank DESC,b.\"at\" DESC,b.id", select(true));
    let size = if q.preview {
        4
    } else if q.lane.is_some() {
        10
    } else {
        25
    };
    let mut params = base_params(q, size);
    params.extend([
        ("now", SqlValue::BigInt(cal.now)),
        ("today", SqlValue::BigInt(cal.today)),
        ("day", SqlValue::Text(local_day_from_ms(cal.now))),
        ("end", SqlValue::BigInt(cal.tomorrow)),
        ("from", SqlValue::BigInt(from)),
        ("until", SqlValue::BigInt(until)),
        ("kind", bind_text(signal_kind)),
        ("lane", bind_text(q.lane.map(Lane::as_str))),
        ("project", bind_text(q.project_id.as_deref())),
        (
            "task",
            bind_text(q.ordinary.as_ref().and_then(|o| o.task_id.as_deref())),
        ),
        (
            "spaces",
            SqlValue::Text(serde_json::to_string(
                &q.ordinary.as_ref().and_then(|o| o.space_ids.as_ref()),
            )?),
        ),
        (
            "rank",
            SqlValue::BigInt(q.cursor.as_ref().map_or(0, |cursor| cursor.rank)),
        ),
        (
            "at",
            SqlValue::BigInt(q.cursor.as_ref().map_or(0, |cursor| cursor.at)),
        ),
        ("waits", SqlValue::Text(serde_json::to_string(&q.waits)?)),
    ]);
    let page = rows(db, &sql, &params, size)?;
    let include_total = q.lane.is_some()
        || (q.preview && matches!(view, View::Attention | View::Review | View::Running));
    let total = if !include_total {
        None
    } else if q.cursor.is_none() && page.len() <= size {
        Some(page.len())
    } else {
        let count_sql = format!("{prefix} SELECT count(*) FROM ({})", select(false));
        let mut stmt = db.prepare(&count_sql)?;
        let values = parameters(&stmt, &params)?;
        Some(stmt.query_row(params_from_iter(values), |row| row.get(0))?)
    };
    Ok(Page { rows: page, total })
}
