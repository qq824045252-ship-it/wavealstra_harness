use crate::{Result, usage_skills};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::ops::RangeInclusive;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Report {
    Summary {
        since: i64,
    },
    Models {
        since: i64,
    },
    Dashboard {
        since: i64,
        range_days: u32,
        calendar: Calendar,
    },
    Trend {
        calendar: Calendar,
    },
    Heatmap {
        calendar: Calendar,
        until: i64,
    },
    Monthly {
        calendar: Calendar,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    buckets: Vec<Bucket>,
    end: i64,
}

#[derive(Deserialize)]
struct Bucket {
    start: i64,
    key: String,
}

impl Calendar {
    fn start(&self) -> i64 {
        self.buckets.first().map_or(self.end, |day| day.start)
    }

    fn index(&self, ts: i64) -> Option<usize> {
        if ts >= self.end {
            return None;
        }
        self.buckets
            .partition_point(|bucket| bucket.start <= ts)
            .checked_sub(1)
    }

    fn check(&self) -> Result<()> {
        if self.buckets.len() > 4_000
            || self
                .buckets
                .windows(2)
                .any(|days| days[0].start >= days[1].start)
            || self
                .buckets
                .last()
                .is_some_and(|last| last.start >= self.end)
        {
            return Err("invalid usage calendar".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Known {
    input: bool,
    output: bool,
    cache_read: bool,
    cache_write: bool,
    cost: bool,
}

impl Default for Known {
    fn default() -> Self {
        Self {
            input: true,
            output: true,
            cache_read: true,
            cache_write: true,
            cost: true,
        }
    }
}

impl Known {
    fn intersect(&mut self, other: Self) {
        self.input &= other.input;
        self.output &= other.output;
        self.cache_read &= other.cache_read;
        self.cache_write &= other.cache_write;
        self.cost &= other.cost;
    }
}

struct ObservedUsage {
    ts: i64,
    call: bool,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    tokens: f64,
    cost: f64,
    known: Known,
}

impl ObservedUsage {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        // Offsets match the common SELECT projection in scan().
        let tokens: f64 = row.get(5)?;
        let legacy_known = tokens > 0.0;
        let flag = |field| {
            row.get::<_, Option<i64>>(field)
                .map(|value| value.map_or(legacy_known, |n| n == 1))
        };
        let known = Known {
            input: flag(8)?,
            output: flag(9)?,
            cache_read: flag(10)?,
            cache_write: flag(11)?,
            cost: legacy_known || flag(12)?,
        };
        let value = |known, field| {
            if known {
                row.get::<_, f64>(field)
            } else {
                Ok(0.0)
            }
        };
        let input = value(known.input, 1)?;
        let output = value(known.output, 2)?;
        let cache_read = value(known.cache_read, 3)?;
        let cache_write = value(known.cache_write, 4)?;
        Ok(Self {
            ts: row.get(0)?,
            call: row.get(7)?,
            input,
            output,
            cache_read,
            cache_write,
            known,
            tokens: if known.input && known.output && known.cache_read && known.cache_write {
                tokens
            } else {
                input + output + cache_read + cache_write
            },
            cost: value(known.cost, 6)?,
        })
    }
}

struct Row {
    usage: ObservedUsage,
    id: String,
    task: Option<String>,
    session: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    response_model: Option<String>,
    user_turn: Option<i64>,
    error: bool,
    cache_write_1h: Option<f64>,
    reasoning: Option<f64>,
    ttft: Option<f64>,
    tps: Option<f64>,
    wall: Option<f64>,
}

impl Row {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        // The full report appends identity and performance columns to the shared projection.
        Ok(Self {
            usage: ObservedUsage::read(row)?,
            id: row.get(13)?,
            task: row.get(14)?,
            session: row.get(15)?,
            provider: row.get(16)?,
            model: row.get(17)?,
            response_model: row.get(18)?,
            user_turn: row.get(19)?,
            error: row.get(20)?,
            cache_write_1h: row.get(21)?,
            reasoning: row.get(22)?,
            ttft: row.get(23)?,
            tps: row.get(24)?,
            wall: row.get(25)?,
        })
    }

    fn session_key(&self) -> &str {
        self.session
            .as_deref()
            .or(self.task.as_deref())
            .unwrap_or("?")
    }
}

#[derive(Default)]
struct Average {
    sum: f64,
    count: usize,
}

impl Average {
    fn add(&mut self, value: Option<f64>) {
        if let Some(value) = value {
            self.sum += value;
            self.count += 1;
        }
    }
    fn value(&self) -> Option<f64> {
        (self.count > 0).then(|| self.sum / self.count as f64)
    }
}

#[derive(Default)]
struct Totals {
    known: Known,
    tokens: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cache_write_1h: Option<f64>,
    reasoning: Option<f64>,
    cost: f64,
    calls: usize,
    errors: usize,
    ttft: Average,
    tps: Average,
    wall: Average,
}

impl Totals {
    fn add(&mut self, row: &Row) {
        let usage = &row.usage;
        if usage.tokens > 0.0
            || usage.input > 0.0
            || usage.output > 0.0
            || usage.cache_read > 0.0
            || usage.cache_write > 0.0
        {
            self.known.intersect(usage.known);
        }
        self.tokens += usage.tokens;
        self.input += usage.input;
        self.output += usage.output;
        self.cache_read += usage.cache_read;
        self.cache_write += usage.cache_write;
        self.cost += usage.cost;
        if let Some(value) = row.reasoning {
            *self.reasoning.get_or_insert(0.0) += value;
        }
        if let Some(value) = row.cache_write_1h {
            *self.cache_write_1h.get_or_insert(0.0) += value;
        }
        if usage.call {
            self.calls += 1;
            self.errors += usize::from(row.error);
            self.ttft.add(row.ttft);
            self.tps.add(row.tps);
            self.wall.add(row.wall);
        }
    }
}

#[derive(Default)]
struct Summary {
    totals: Totals,
    cache_hit: f64,
    cache_miss: f64,
    sessions: HashSet<String>,
    providers: HashSet<String>,
    turns: HashSet<(String, i64)>,
}

impl Summary {
    fn add(&mut self, row: &Row) {
        self.totals.add(row);
        let usage = &row.usage;
        if usage.known.cache_read && (usage.known.input || usage.known.cache_write) {
            self.cache_hit += usage.cache_read;
            self.cache_miss += usage.input + usage.cache_write;
        }
        if usage.call {
            let session = row.session_key();
            self.sessions.insert(session.to_owned());
            self.providers
                .insert(row.provider.as_deref().unwrap_or("unknown").to_owned());
            if let Some(turn) = row.user_turn {
                self.turns.insert((session.to_owned(), turn));
            }
        }
    }
    fn cache_hit_rate(&self) -> Option<f64> {
        let denominator = self.cache_hit + self.cache_miss;
        (denominator > 0.0).then(|| self.cache_hit / denominator)
    }
    fn error_rate(&self) -> Option<f64> {
        let t = &self.totals;
        (t.calls > 0).then(|| t.errors as f64 / t.calls as f64)
    }
    fn result(&self) -> Value {
        let t = &self.totals;
        json!({ "known": t.known, "totalTokens": t.tokens, "input": t.input, "output": t.output,
            "cacheRead": t.cache_read, "cacheWrite": t.cache_write, "cacheWrite1h": t.cache_write_1h, "reasoning": t.reasoning,
            "cost": t.cost, "calls": t.calls, "turns": self.turns.len(), "sessions": self.sessions.len(),
            "providers": self.providers.len(), "cacheHitRate": self.cache_hit_rate(), "errorRate": self.error_rate(),
            "avgTtftMs": t.ttft.value(), "avgTps": t.tps.value(), "avgModelWallMs": t.wall.value(), "errors": t.errors })
    }
}

#[derive(Default)]
struct Models {
    indexes: HashMap<(String, String), usize>,
    ordered: Vec<(String, String, Totals)>,
}

impl Models {
    fn add(&mut self, row: &Row) {
        if !row.usage.call {
            return;
        }
        let provider = row.provider.as_deref().unwrap_or("unknown");
        let model = row
            .model
            .as_deref()
            .or(row.response_model.as_deref())
            .unwrap_or("unknown");
        let index = *self
            .indexes
            .entry((provider.to_owned(), model.to_owned()))
            .or_insert_with(|| {
                self.ordered
                    .push((provider.to_owned(), model.to_owned(), Totals::default()));
                self.ordered.len() - 1
            });
        self.ordered[index].2.add(row);
    }

    fn result(mut self) -> Vec<Value> {
        self.ordered.sort_by(|a, b| {
            b.2.tokens
                .partial_cmp(&a.2.tokens)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        self.ordered.into_iter().map(|(provider, model, t)| {
            let denominator = t.cache_read
                + if t.known.input { t.input } else { 0.0 }
                + if t.known.cache_write { t.cache_write } else { 0.0 };
            let hit_rate = (t.known.cache_read && denominator > 0.0).then(|| t.cache_read / denominator);
            json!({ "provider": provider, "model": model, "known": t.known, "calls": t.calls,
                "input": t.input, "output": t.output, "cacheRead": t.cache_read, "cacheWrite": t.cache_write,
                "reasoning": t.reasoning, "totalTokens": t.tokens, "cost": t.cost, "ttftMs": t.ttft.value(),
                "tps": t.tps.value(), "wallMs": t.wall.value(), "errors": t.errors, "cacheHitRate": hit_rate })
        }).collect()
    }
}

#[derive(Clone, Copy, Default)]
struct Activity {
    tokens: f64,
    calls: usize,
    cost: f64,
    seen: bool,
}

impl Activity {
    fn add(&mut self, usage: &ObservedUsage) {
        self.seen = true;
        self.tokens += usage.tokens;
        self.calls += usize::from(usage.call);
        self.cost += usage.cost;
    }
    fn active(&self) -> bool {
        self.tokens > 0.0 || self.calls > 0
    }
}

struct Span {
    first: i64,
    last: i64,
    wall: f64,
}

#[derive(Default)]
struct Dashboard {
    summary: Summary,
    models: Models,
    spans: HashMap<String, Span>,
    files: HashSet<String>,
}

impl Dashboard {
    fn add(&mut self, row: &Row) {
        self.summary.add(row);
        self.models.add(row);
        if let Some(file) = &row.session
            && !file.is_empty()
        {
            self.files.insert(file.clone());
        }
        if row.usage.call {
            let ts = row.usage.ts;
            let session = row.session_key();
            let key = match row.user_turn {
                Some(turn) => format!("{session}:turn:{turn}"),
                None => format!("{session}:call:{}", row.id),
            };
            let span = self.spans.entry(key).or_insert(Span {
                first: ts,
                last: ts,
                wall: 0.0,
            });
            span.first = span.first.min(ts);
            span.last = span.last.max(ts);
            span.wall += row.wall.unwrap_or_default();
        }
    }

    fn result(
        self,
        calendar: Calendar,
        activity: Vec<Activity>,
        since: i64,
        range_days: u32,
    ) -> Value {
        let mut longest = 0;
        let mut streak = 0;
        let mut peak = 0.0_f64;
        let mut from = None;
        let days: Vec<_> = calendar.buckets.iter().zip(&activity).map(|(day, value)| {
            if value.active() { streak += 1; longest = longest.max(streak); } else { streak = 0; }
            if day.start >= since { peak = peak.max(value.tokens); from.get_or_insert(&day.key); }
            json!({ "date": day.key, "tokens": value.tokens, "calls": value.calls, "cost": value.cost })
        }).collect();
        let to = calendar.buckets.last().map(|day| day.key.as_str());
        let heat_from = calendar.buckets.first().map(|day| day.key.as_str());
        let summary = &self.summary;
        let t = &summary.totals;
        let runs = summary.turns.len();
        let longest_span = self
            .spans
            .values()
            .map(|s| s.wall.max((s.last - s.first) as f64))
            .fold(0.0, f64::max);
        json!({ "known": t.known, "rangeDays": range_days, "from": from, "to": to,
            "heatFrom": heat_from, "heatTo": to, "totalTokens": t.tokens, "dailyPeakTokens": peak,
            "longestTaskMs": longest_span, "currentStreakDays": streak, "longestStreakDays": longest,
            "sessions": summary.sessions.len(), "runs": runs, "calls": t.calls,
            "avgTokensPerRun": if runs > 0 { t.tokens / runs as f64 } else { 0.0 },
            "input": t.input, "output": t.output, "cacheRead": t.cache_read, "cacheWrite": t.cache_write,
            "reasoning": t.reasoning, "cost": t.cost, "cacheHitRate": summary.cache_hit_rate(),
            "avgTtftMs": t.ttft.value(), "avgTps": t.tps.value(), "avgModelWallMs": t.wall.value(),
            "errorRate": summary.error_rate(), "errors": t.errors, "days": days,
            "models": self.models.result(), "skills": usage_skills::counts(self.files) })
    }
}

fn scan<T>(
    db: &Connection,
    coverage: bool,
    time: RangeInclusive<i64>,
    details: &str,
    decode: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    mut consume: impl FnMut(T) -> Result<()>,
) -> Result<()> {
    let (columns, join) = if coverage {
        (
            "c.input_known,c.output_known,c.cache_read_known,c.cache_write_known,c.cost_known",
            "LEFT JOIN usage_event_coverage c ON c.entry_id=e.entry_id",
        )
    } else {
        (
            "NULL AS input_known,NULL AS output_known,NULL AS cache_read_known,NULL AS cache_write_known,NULL AS cost_known",
            "",
        )
    };
    let mut query = db.prepare(&format!(
        "SELECT ts,input_tokens,output_tokens,cache_read,cache_write,total_tokens,cost_total,
            source_kind IN ('main','btw','subagent','auxiliary') AND stop_reason IS NOT 'disposed',
            {columns}{details}
         FROM usage_events e {join} WHERE ts>=?1 AND ts<=?2 ORDER BY ts ASC"
    ))?;
    let mut rows = query.query(params![time.start(), time.end()])?;
    while let Some(row) = rows.next()? {
        consume(decode(row)?)?;
    }
    Ok(())
}

fn scan_details(
    db: &Connection,
    coverage: bool,
    since: i64,
    mut consume: impl FnMut(Row),
) -> Result<()> {
    scan(
        db,
        coverage,
        since..=i64::MAX,
        ",e.entry_id,task_id,session_file,provider,model,response_model,user_turn,
          stop_reason IS 'error' OR COALESCE(error_message,'')<>'',
          cache_write_1h,reasoning_tokens,ttft_ms,generation_tps,model_wall_ms",
        Row::read,
        |row| {
            consume(row);
            Ok(())
        },
    )
}

fn calendar_activity(
    db: &Connection,
    coverage: bool,
    calendar: &Calendar,
    until: i64,
) -> Result<Vec<Activity>> {
    calendar.check()?;
    let mut days = vec![Activity::default(); calendar.buckets.len()];
    scan(
        db,
        coverage,
        calendar.start()..=until,
        "",
        ObservedUsage::read,
        |usage| {
            if let Some(index) = calendar.index(usage.ts) {
                days[index].add(&usage);
            }
            Ok(())
        },
    )?;
    Ok(days)
}

fn decimal(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let abs = value.abs();
    if (1e-6..1e21).contains(&abs) {
        value.to_string()
    } else {
        let scientific = format!("{value:e}");
        let Some((digits, exponent)) = scientific.split_once('e') else {
            return scientific;
        };
        if exponent.starts_with('-') {
            scientific
        } else {
            format!("{digits}e+{exponent}")
        }
    }
}

fn fixed(value: f64, digits: u32) -> String {
    if !value.is_finite() || value.abs() >= 1e21 {
        return decimal(value);
    }
    // Round the exact binary value to decimal, with ties away from zero as in Number.toFixed.
    let bits = value.abs().to_bits();
    let mantissa_bits = bits & ((1_u64 << 52) - 1);
    let biased = (bits >> 52) as i32;
    let (mantissa, exponent) = if biased == 0 {
        (mantissa_bits, -1074)
    } else {
        (mantissa_bits | (1_u64 << 52), biased - 1075)
    };
    let scale = 10_u128.pow(digits);
    let exact = u128::from(mantissa) * scale;
    let shift = exponent.unsigned_abs();
    let rounded = if exponent >= 0 {
        exact << shift
    } else if shift >= 128 {
        0
    } else {
        let denominator = 1_u128 << shift;
        exact / denominator + u128::from(exact % denominator >= denominator / 2)
    };
    let sign = if value < 0.0 { "-" } else { "" };
    format!(
        "{sign}{}.{:0width$}",
        rounded / scale,
        rounded % scale,
        width = digits as usize
    )
}

struct CsvRow {
    usage: ObservedUsage,
    time: String,
    source: String,
    provider: Option<String>,
    model: Option<String>,
    reasoning: Option<f64>,
    stop: Option<String>,
    error: bool,
    ttft: Option<f64>,
    tps: Option<f64>,
    wall: Option<f64>,
}

impl CsvRow {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            usage: ObservedUsage::read(row)?,
            time: row.get(13)?,
            source: row.get(14)?,
            provider: row.get(15)?,
            model: row.get(16)?,
            reasoning: row.get(17)?,
            stop: row.get(18)?,
            error: row.get(19)?,
            ttft: row.get(20)?,
            tps: row.get(21)?,
            wall: row.get(22)?,
        })
    }

    fn write(self, csv: &mut String) {
        let available = |known, value| {
            if known {
                decimal(value)
            } else {
                "unknown".into()
            }
        };
        let u = self.usage;
        let total_known =
            u.known.input && u.known.output && u.known.cache_read && u.known.cache_write;
        let fields = [
            self.time,
            self.source,
            self.provider.unwrap_or_default(),
            self.model.unwrap_or_default(),
            available(u.known.input, u.input),
            available(u.known.output, u.output),
            available(u.known.cache_read, u.cache_read),
            available(u.known.cache_write, u.cache_write),
            self.reasoning.map(decimal).unwrap_or_default(),
            available(total_known, u.tokens),
            if u.known.cost {
                fixed(u.cost, 6)
            } else {
                "unknown".into()
            },
            self.stop.unwrap_or_default(),
            (if self.error { "1" } else { "0" }).into(),
            self.ttft.map(decimal).unwrap_or_default(),
            self.tps.map(|n| fixed(n, 2)).unwrap_or_default(),
            self.wall.map(decimal).unwrap_or_default(),
        ];
        csv.push('\n');
        for (index, field) in fields.iter().enumerate() {
            if index > 0 {
                csv.push(',');
            }
            csv.push('"');
            for (part, quoted) in field.split('"').enumerate() {
                if part > 0 {
                    csv.push_str("\"\"");
                }
                csv.push_str(quoted);
            }
            csv.push('"');
        }
    }
}

pub fn export_csv(db: &Connection, since: i64, coverage: bool) -> Result<String> {
    let mut csv = String::from(
        "ts_utc_iso,source_kind,provider,model,input,output,cache_read,cache_write,reasoning,total_tokens,cost,stop_reason,error,ttft_ms,generation_tps,model_wall_ms",
    );
    scan(db, coverage, since..=i64::MAX,
        ",strftime('%Y-%m-%dT%H:%M:%fZ',ts/1000.0,'unixepoch'),source_kind,provider,model,reasoning_tokens,
          stop_reason,stop_reason IS 'error' OR COALESCE(error_message,'')<>'',ttft_ms,generation_tps,model_wall_ms",
        CsvRow::read, |row| {
            row.write(&mut csv);
            if csv.len() > 16 * 1024 * 1024 { return Err("usage CSV exceeds native reply limit".into()); }
            Ok(())
        })?;
    Ok(csv)
}

fn calendar_points(
    db: &Connection,
    coverage: bool,
    calendar: &Calendar,
    include_empty: bool,
) -> Result<Value> {
    let points: Vec<_> = calendar_activity(db, coverage, calendar, calendar.end.saturating_sub(1))?
        .into_iter().zip(&calendar.buckets).filter(|(activity, _)| include_empty || activity.seen)
        .map(|(activity, bucket)| json!({ "key": bucket.key, "tokens": activity.tokens, "calls": activity.calls, "cost": activity.cost }))
        .collect();
    Ok(json!(points))
}

pub fn read(db: &mut Connection, coverage: bool, report: Report) -> Result<Value> {
    let snapshot = db.transaction()?;
    let data = match report {
        Report::Summary { since } => {
            let mut summary = Summary::default();
            scan_details(&snapshot, coverage, since, |row| summary.add(&row))?;
            summary.result()
        }
        Report::Models { since } => {
            let mut models = Models::default();
            scan_details(&snapshot, coverage, since, |row| models.add(&row))?;
            json!(models.result())
        }
        Report::Dashboard {
            since,
            range_days,
            calendar,
        } => {
            calendar.check()?;
            if !calendar.buckets.iter().any(|bucket| bucket.start == since) {
                return Err("usage window does not start on a calendar boundary".into());
            }
            let mut report = Dashboard::default();
            let mut days =
                calendar_activity(&snapshot, coverage, &calendar, since.saturating_sub(1))?;
            scan_details(&snapshot, coverage, since, |row| {
                if let Some(index) = calendar.index(row.usage.ts) {
                    days[index].add(&row.usage);
                }
                report.add(&row);
            })?;
            snapshot.commit()?;
            return Ok(report.result(calendar, days, since, range_days));
        }
        Report::Trend { calendar } => calendar_points(&snapshot, coverage, &calendar, true)?,
        Report::Monthly { calendar } => {
            let beyond: bool = snapshot.query_row(
                "SELECT EXISTS(SELECT 1 FROM usage_events WHERE ts<?1 OR ts>=?2)",
                params![calendar.start(), calendar.end],
                |row| row.get(0),
            )?;
            if beyond {
                return Err("usage month bounds changed".into());
            }
            calendar_points(&snapshot, coverage, &calendar, false)?
        }
        Report::Heatmap { calendar, until } => {
            let days = calendar_activity(&snapshot, coverage, &calendar, until)?;
            let mut weeks = [Activity::default(); 53];
            for (day, activity) in calendar.buckets.iter().zip(days) {
                let week: usize = day.key.parse()?;
                let Some(cut) = week.checked_sub(1).and_then(|index| weeks.get_mut(index)) else {
                    return Err("invalid usage week".into());
                };
                cut.tokens += activity.tokens;
                cut.calls += activity.calls;
            }
            let result: Vec<_> = weeks.into_iter().enumerate()
                .map(|(index, activity)| json!({ "week": index + 1, "tokens": activity.tokens, "calls": activity.calls })).collect();
            json!(result)
        }
    };
    snapshot.commit()?;
    Ok(data)
}
