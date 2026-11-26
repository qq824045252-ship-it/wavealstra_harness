use crate::{Result, javascript_whitespace, usage_live, write_connection};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{File, Metadata},
    io::{BufRead, BufReader, Read},
    path::Path,
    time::UNIX_EPOCH,
};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Job {
    Session {
        file: String,
        captured_at: i64,
    },
    Subagents {
        file: String,
        coverage: bool,
    },
    Reattribute,
    Live {
        input: Box<usage_live::LiveInput>,
        captured_at: i64,
        coverage: bool,
    },
    RepairCoverage,
    SubagentBatch {
        entries: Vec<ArchiveEntry>,
        coverage: bool,
    },
    BranchWatermark {
        session_file: String,
        inherited_last_entry_id: String,
        file_size: i64,
        updated_at: i64,
    },
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Usage {
    pub(super) input: Option<f64>,
    pub(super) output: Option<f64>,
    pub(super) cache_read: Option<f64>,
    pub(super) cache_write: Option<f64>,
    pub(super) cache_write1h: Option<f64>,
    pub(super) reasoning: Option<f64>,
    total_tokens: Option<f64>,
    pub(super) cost: Option<Costs>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Costs {
    pub(super) total: Option<f64>,
    pub(super) input: Option<f64>,
    pub(super) output: Option<f64>,
    pub(super) cache_read: Option<f64>,
    pub(super) cache_write: Option<f64>,
}

impl Usage {
    fn total(&self) -> f64 {
        self.total_tokens.unwrap_or_else(|| {
            self.input.unwrap_or_default()
                + self.output.unwrap_or_default()
                + self.cache_read.unwrap_or_default()
                + self.cache_write.unwrap_or_default()
        })
    }
    fn has_overhead(&self) -> bool {
        [self.input, self.output, self.cache_read, self.cache_write]
            .iter()
            .any(|value| value.unwrap_or_default() != 0.0)
            || self.cost.is_some()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    timestamp: Option<Value>,
    provider: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
    message: Option<Message>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    role: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    response_model: Option<String>,
    response_id: Option<String>,
    timestamp: Option<Value>,
    usage: Option<Usage>,
    stop_reason: Option<String>,
    error_message: Option<String>,
}

struct Assistant {
    id: String,
    provider: String,
    model: String,
    response_id: Option<String>,
    ts: f64,
    usage: Usage,
    stop_reason: Option<String>,
    error_message: Option<String>,
    turn: usize,
}

struct Overhead {
    id: String,
    source: &'static str,
    provider: Option<String>,
    model: Option<String>,
    ts: f64,
    usage: Usage,
}

#[derive(Default)]
struct Session {
    assistants: Vec<Assistant>,
    overhead: Vec<Overhead>,
    user_messages: usize,
}

#[derive(Clone, Copy, PartialEq)]
struct FileStamp {
    bytes: u64,
    mtime: f64,
}

impl FileStamp {
    fn read(meta: &Metadata) -> Result<Self> {
        let time = meta.modified()?.duration_since(UNIX_EPOCH)?;
        let mtime = time.as_secs() as f64 * 1000.0 + f64::from(time.subsec_nanos()) / 1_000_000.0;
        Ok(Self {
            bytes: meta.len(),
            mtime,
        })
    }
}

fn open_input(path: &str) -> Result<Option<(File, FileStamp)>> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => (),
        _ => return Ok(None),
    }
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(None);
    }
    let stamp = FileStamp::read(&metadata)?;
    Ok(Some((file, stamp)))
}

fn unchanged(path: &str, stamp: FileStamp) -> bool {
    std::fs::metadata(path)
        .ok()
        .and_then(|meta| FileStamp::read(&meta).ok())
        == Some(stamp)
}

fn scan_jsonl(
    file: File,
    stamp: FileStamp,
    mut visit: impl FnMut(Value) -> Result<()>,
) -> Result<()> {
    let mut source = BufReader::new(file.take(stamp.bytes));
    let mut line = Vec::new();
    loop {
        line.clear();
        if source.read_until(b'\n', &mut line)? == 0 {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&line);
        match serde_json::from_str(&text) {
            Ok(value) => visit(value)?,
            Err(_)
                if text.as_bytes().windows(6).any(|unit| {
                    unit[0] == b'\\'
                        && unit[1] == b'u'
                        && unit[2].eq_ignore_ascii_case(&b'd')
                        && matches!(unit[3].to_ascii_lowercase(), b'8'..=b'9' | b'a'..=b'f')
                }) =>
            {
                return Err("usage log contains JavaScript-only Unicode".into());
            }
            Err(_) => {} // A partial JSONL write is not an event.
        }
    }
}

fn overhead_time(db: &Connection, input: Option<Value>, captured: i64) -> Result<f64> {
    let Some(value) = input else {
        return Ok(captured as f64);
    };
    if let Some(number) = value.as_f64() {
        return Ok(number);
    }
    let Some(text) = value.as_str() else {
        return Ok(captured as f64);
    };
    let Some(date) = text.get(..10) else {
        return Err("usage timestamp needs JavaScript parsing".into());
    };
    let bytes = date.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return Err("usage timestamp needs JavaScript parsing".into());
    }
    let Some(rest) = text.get(10..) else {
        return Err("usage timestamp missing date".into());
    };
    let time = if rest.is_empty() {
        text.to_owned()
    } else {
        let tail = rest.as_bytes();
        let offset = tail.last() == Some(&b'Z')
            || tail
                .get(tail.len().saturating_sub(6))
                .is_some_and(|value| *value == b'+' || *value == b'-');
        if !rest.starts_with('T') || !offset {
            return Err("usage timestamp needs local calendar parsing".into());
        }
        if let Some(dot) = text.find('.') {
            let digits = text[dot + 1..]
                .bytes()
                .take_while(u8::is_ascii_digit)
                .count();
            let split = dot + 1 + digits.min(3);
            format!("{}{}", &text[..split], &text[dot + 1 + digits..])
        } else {
            text.to_owned()
        }
    };
    let millis: Option<f64> = db
        .prepare_cached("SELECT round(unixepoch(?1,'subsec')*1000)")?
        .query_row([time], |row| row.get(0))?;
    millis.ok_or_else(|| "usage timestamp needs JavaScript parsing".into())
}

fn session_rows(db: &Connection, file: File, stamp: FileStamp, captured: i64) -> Result<Session> {
    let mut session = Session::default();
    scan_jsonl(file, stamp, |value| {
        if !value.is_object() {
            return Ok(());
        }
        // Ignore message content and unrelated telemetry instead of retaining it for the write transaction.
        let entry: Record = serde_json::from_value(value)?;
        let overhead = match entry.kind.as_deref() {
            Some("message") => {
                let Some(msg) = entry.message else {
                    return Ok(());
                };
                match msg.role.as_deref() {
                    Some("user") => {
                        session.user_messages += 1;
                        None
                    }
                    Some("assistant") => {
                        let ts = match msg.timestamp {
                            Some(stamp) => stamp
                                .as_f64()
                                .ok_or("assistant time needs JavaScript compatibility")?,
                            None => captured as f64,
                        };
                        let model = msg
                            .model
                            .or(msg.response_model)
                            .unwrap_or_else(|| "unknown".into());
                        session.assistants.push(Assistant {
                            id: entry
                                .id
                                .unwrap_or_else(|| format!("entry:{}", session.assistants.len())),
                            provider: msg.provider.unwrap_or_else(|| "unknown".into()),
                            model,
                            response_id: msg.response_id,
                            ts,
                            usage: msg.usage.unwrap_or_default(),
                            stop_reason: msg.stop_reason,
                            error_message: msg.error_message,
                            turn: session.user_messages,
                        });
                        None
                    }
                    Some("toolResult") => Some((
                        "toolresult",
                        msg.usage,
                        msg.timestamp,
                        msg.provider,
                        msg.model,
                        entry.id,
                    )),
                    _ => None,
                }
            }
            Some("compaction" | "branch_summary") => Some((
                "compaction",
                entry.usage,
                entry.timestamp,
                entry.provider,
                entry.model,
                entry.id,
            )),
            _ => None,
        };
        if let Some((source, Some(usage), timestamp, provider, model, id)) = overhead
            && usage.has_overhead()
        {
            session.overhead.push(Overhead {
                id: id.unwrap_or_else(|| format!("overhead:{}", session.overhead.len())),
                source,
                ts: overhead_time(db, timestamp, captured)?,
                provider,
                model,
                usage,
            });
        }
        Ok(())
    })?;
    Ok(session)
}

pub(super) fn model_from_id(id: &str) -> Option<(&str, &str)> {
    let (provider, model) = id.trim_matches(javascript_whitespace).split_once('/')?;
    (!provider.is_empty() && !model.is_empty()).then_some((provider, model))
}

fn has_tasks(db: &Connection) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks')",
        [],
        |row| row.get(0),
    )
}

type Watermark = (Option<String>, Option<u64>, Option<f64>);

fn watermark(db: &Connection, file: &str) -> rusqlite::Result<Option<Watermark>> {
    db.prepare_cached(
        "SELECT last_entry_id,file_size,file_mtime FROM usage_backfill_state WHERE session_file=?1",
    )?
    .query_row([file], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
    .optional()
}

fn already_scanned(state: Option<&Watermark>, stamp: FileStamp) -> bool {
    state.is_some_and(|(last, size, mtime)| {
        last.as_ref().is_some_and(|id| !id.is_empty())
            && *size == Some(stamp.bytes)
            && *mtime == Some(stamp.mtime)
    })
}

fn reconcile(
    db: &Connection,
    file: &str,
    session: Session,
    state: Option<Watermark>,
    stamp: FileStamp,
    captured: i64,
) -> Result<usize> {
    let model_id: Option<String> = if has_tasks(db)? {
        db.prepare_cached(
            "SELECT model_id FROM tasks WHERE session_file=?1 AND model_id IS NOT NULL LIMIT 1",
        )?
        .query_row([file], |row| row.get(0))
        .optional()?
    } else {
        None
    };
    let attribution = model_id.as_deref().and_then(model_from_id);
    let from = state
        .and_then(|(last, _, _)| last)
        .and_then(|id| session.assistants.iter().position(|entry| entry.id == id))
        .map_or(0, |index| index + 1);
    let mut live = db.prepare_cached(
        "SELECT entry_id FROM usage_events WHERE session_file=?1 AND entry_id LIKE 'live:%'
         AND (response_id IS NULL OR response_id='') ORDER BY COALESCE(turn_index,0),ts ASC",
    )?;
    let live = live
        .query_map([file], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut handled = 0;
    let mut claimed = std::collections::HashSet::new();
    let mut claim = db.prepare_cached(
        "UPDATE usage_events SET entry_id=?1,backfilled=1,user_turn=?2
         WHERE session_file=?3 AND response_id=?4 AND entry_id LIKE 'live:%' AND source_kind='main'",
    )?;
    for entry in &session.assistants {
        let Some(response) = entry.response_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let changed = claim.execute(params![entry.id, entry.turn, file, response])?;
        if changed > 0 {
            handled += 1;
            claimed.insert(entry.id.as_str());
        }
    }
    let entries = &session.assistants[from..];
    let mut order = db.prepare_cached(
        "UPDATE usage_events SET entry_id=?1,backfilled=1,user_turn=?2 WHERE entry_id=?3",
    )?;
    for (old, entry) in live.iter().zip(
        entries
            .iter()
            .filter(|entry| entry.response_id.as_deref().is_none_or(str::is_empty)),
    ) {
        let changed = order.execute(params![entry.id, entry.turn, old])?;
        if changed > 0 {
            handled += 1;
            claimed.insert(entry.id.as_str());
        }
    }
    let mut insert = db.prepare_cached(
        "INSERT INTO usage_events(entry_id,task_id,session_file,source_kind,provider,model,response_model,ts,
           input_tokens,output_tokens,cache_read,cache_write,cache_write_1h,reasoning_tokens,total_tokens,
           cost_total,cost_input,cost_output,cost_cache_read,cost_cache_write,stop_reason,error_message,response_id,turn_index,user_turn,backfilled)
         VALUES (?1,NULL,?2,'main',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,NULL,?22,1)
         ON CONFLICT(entry_id) DO UPDATE SET user_turn=excluded.user_turn WHERE usage_events.user_turn IS NULL",
    )?;
    for entry in entries {
        if claimed.contains(entry.id.as_str()) {
            continue;
        }
        let (provider, model, response) = attribution.map_or(
            (entry.provider.as_str(), entry.model.as_str(), None),
            |(provider, model)| (provider, model, Some(entry.model.as_str())),
        );
        let u = &entry.usage;
        let cost = u.cost.as_ref();
        handled += insert.execute(params![
            entry.id,
            file,
            provider,
            model,
            response,
            entry.ts,
            u.input.unwrap_or_default(),
            u.output.unwrap_or_default(),
            u.cache_read.unwrap_or_default(),
            u.cache_write.unwrap_or_default(),
            u.cache_write1h,
            u.reasoning,
            u.total(),
            cost.and_then(|c| c.total).unwrap_or_default(),
            cost.and_then(|c| c.input).unwrap_or_default(),
            cost.and_then(|c| c.output).unwrap_or_default(),
            cost.and_then(|c| c.cache_read).unwrap_or_default(),
            cost.and_then(|c| c.cache_write).unwrap_or_default(),
            entry.stop_reason,
            entry.error_message,
            entry.response_id,
            entry.turn
        ])?;
    }
    let mut overhead = db.prepare_cached(
        "INSERT OR IGNORE INTO usage_events(entry_id,session_file,source_kind,provider,model,ts,
           input_tokens,output_tokens,cache_read,cache_write,total_tokens,cost_total,cost_input,cost_output,cost_cache_read,cost_cache_write,backfilled)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,1)",
    )?;
    for entry in session.overhead {
        let u = entry.usage;
        let cost = u.cost.as_ref();
        handled += overhead.execute(params![
            entry.id,
            file,
            entry.source,
            entry.provider,
            entry.model,
            entry.ts,
            u.input.unwrap_or_default(),
            u.output.unwrap_or_default(),
            u.cache_read.unwrap_or_default(),
            u.cache_write.unwrap_or_default(),
            u.total(),
            cost.and_then(|c| c.total).unwrap_or_default(),
            cost.and_then(|c| c.input).unwrap_or_default(),
            cost.and_then(|c| c.output).unwrap_or_default(),
            cost.and_then(|c| c.cache_read).unwrap_or_default(),
            cost.and_then(|c| c.cache_write).unwrap_or_default()
        ])?;
    }
    db.execute(
        "INSERT INTO usage_backfill_state(session_file,last_entry_id,file_size,file_mtime,user_messages,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(session_file) DO UPDATE SET last_entry_id=excluded.last_entry_id,
         file_size=excluded.file_size,file_mtime=excluded.file_mtime,user_messages=excluded.user_messages,updated_at=excluded.updated_at",
        params![file, session.assistants.last().map(|entry| &entry.id), stamp.bytes, stamp.mtime, session.user_messages, captured],
    )?;
    Ok(handled)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    subagent_id: String,
    role: Option<String>,
    scope: Option<String>,
    model: Option<String>,
    run_count: Option<i64>,
    finished_at: Option<i64>,
    usage: Option<ArchiveUsage>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveUsage {
    input: Option<f64>,
    output: Option<f64>,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
    cost: Option<f64>,
}

fn subagent_rows(db: &Connection, entries: Vec<ArchiveEntry>, coverage: bool) -> Result<usize> {
    let mut insert = db.prepare_cached(
        "INSERT OR IGNORE INTO usage_events(entry_id,task_id,source_kind,source_detail,model,ts,
           input_tokens,output_tokens,cache_read,cache_write,total_tokens,cost_total,backfilled)
         VALUES (?1,?2,'subagent',?3,?4,?5,?6,?7,?8,?9,?10,?11,1)",
    )?;
    let mut flags = if coverage {
        Some(db.prepare_cached(
            "INSERT OR IGNORE INTO usage_event_coverage VALUES (?1,?2,?3,?4,?5,?6)",
        )?)
    } else {
        None
    };
    let mut added = 0;
    for entry in entries {
        let Some(finished_at) = entry.finished_at else {
            continue;
        };
        let id = format!(
            "sub:{}:{}:{}",
            entry.subagent_id,
            entry.run_count.unwrap_or_default(),
            finished_at
        );
        let u = entry.usage.unwrap_or_default();
        let total = u.input.unwrap_or_default()
            + u.output.unwrap_or_default()
            + u.cache_read.unwrap_or_default()
            + u.cache_write.unwrap_or_default();
        let changed = insert.execute(params![
            id,
            entry.scope,
            entry.role,
            entry.model,
            finished_at,
            u.input.unwrap_or_default(),
            u.output.unwrap_or_default(),
            u.cache_read.unwrap_or_default(),
            u.cache_write.unwrap_or_default(),
            total,
            u.cost.unwrap_or_default()
        ])?;
        if changed > 0
            && let Some(flags) = flags.as_mut()
        {
            flags.execute(params![
                id,
                u.input.is_some(),
                u.output.is_some(),
                u.cache_read.is_some(),
                u.cache_write.is_some(),
                u.cost.is_some() || total > 0.0
            ])?;
        }
        added += changed;
    }
    Ok(added)
}

fn reattribute(db: &Connection) -> Result<usize> {
    if !has_tasks(db)? {
        return Ok(0);
    }
    let mut select = db.prepare(
        "SELECT e.entry_id,e.provider,e.model,t.model_id FROM usage_events e JOIN tasks t ON t.session_file=e.session_file
         WHERE t.model_id IS NOT NULL AND TRIM(t.model_id)!='' AND e.source_kind IN ('main','btw') AND e.session_file IS NOT NULL",
    )?;
    let rows = select
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut update = db.prepare_cached("UPDATE usage_events SET provider=?1,model=?2,response_model=COALESCE(response_model,?3) WHERE entry_id=?4")?;
    let mut changed = 0;
    for (id, old_provider, old_model, id_attributed) in rows {
        if let Some((provider, model)) = model_from_id(&id_attributed)
            && (old_provider.as_deref() != Some(provider) || old_model.as_deref() != Some(model))
        {
            changed += update.execute(params![provider, model, old_model, id])?;
        }
    }
    Ok(changed)
}

pub fn run(connection: &mut Option<Connection>, path: &Path, job: Job) -> Result<Value> {
    let saved = match job {
        Job::Session { file, captured_at } => {
            let Some((input, stamp)) = open_input(&file)? else {
                return Ok(json!(0));
            };
            let db = write_connection(connection, path)?;
            if already_scanned(watermark(db, &file)?.as_ref(), stamp) {
                return Ok(json!(0));
            }
            let session = session_rows(db, input, stamp, captured_at)?;
            if session.assistants.is_empty() && session.overhead.is_empty() {
                return Ok(json!(0));
            }
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !unchanged(&file, stamp) {
                return Ok(json!("changed"));
            }
            let state = watermark(&tx, &file)?;
            if already_scanned(state.as_ref(), stamp) {
                return Ok(json!(0));
            }
            let count = reconcile(&tx, &file, session, state, stamp, captured_at)?;
            tx.commit()?;
            count
        }
        Job::Subagents { file, coverage } => {
            let Some((input, stamp)) = open_input(&file)? else {
                return Ok(json!(0));
            };
            let mut entries = Vec::new();
            scan_jsonl(input, stamp, |value| {
                if value["subagentId"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty())
                {
                    entries.push(serde_json::from_value(value)?);
                }
                Ok(())
            })?;
            let db = write_connection(connection, path)?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !unchanged(&file, stamp) {
                return Ok(json!("changed"));
            }
            let count = subagent_rows(&tx, entries, coverage)?;
            tx.commit()?;
            count
        }
        Job::Reattribute => {
            let db = write_connection(connection, path)?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let count = reattribute(&tx)?;
            tx.commit()?;
            count
        }
        Job::Live {
            input,
            captured_at,
            coverage,
        } => {
            let tx = write_connection(connection, path)?
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let count = usage_live::record(&tx, *input, captured_at, coverage)?;
            tx.commit()?;
            count
        }
        Job::RepairCoverage => {
            let tx = write_connection(connection, path)?
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let count = usage_live::repair_coverage(&tx)?;
            tx.commit()?;
            count
        }
        Job::SubagentBatch { entries, coverage } => {
            let tx = write_connection(connection, path)?
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let count = subagent_rows(&tx, entries, coverage)?;
            tx.commit()?;
            count
        }
        Job::BranchWatermark {
            session_file,
            inherited_last_entry_id,
            file_size,
            updated_at,
        } => {
            let tx = write_connection(connection, path)?
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let updated = tx.execute(
                "UPDATE usage_backfill_state
                 SET last_entry_id = ?1, file_size = ?2, file_mtime = 0, updated_at = ?3
                 WHERE session_file = ?4",
                params![inherited_last_entry_id, file_size, updated_at, session_file],
            )?;
            if updated == 0 {
                tx.execute(
                    "INSERT INTO usage_backfill_state
                       (session_file, last_entry_id, file_size, file_mtime, user_messages, updated_at)
                     VALUES (?1, ?2, ?3, 0, 0, ?4)",
                    params![session_file, inherited_last_entry_id, file_size, updated_at],
                )?;
            }
            tx.commit()?;
            1
        }
    };
    Ok(json!(saved))
}
