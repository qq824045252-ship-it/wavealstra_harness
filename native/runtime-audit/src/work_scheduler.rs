//! Step 5: Rust Core authoritative Work state machine, watch/cron/deadline tick scheduler,
//! resource-conflict/concurrency dispatcher, and crash recovery scanner.

use crate::business_protocol::{
    ClientContext, EmittedEvent, ExecutorTracker, WriteSideEffects, append_event,
    current_core_generation, ensure_tables,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_LEASE_TTL_MS: i64 = 60_000;
const TICK_INTERVAL_MS: i64 = 5_000;
const MAX_SUBSCRIPTIONS_PER_TICK: usize = 128;
const MAX_CATCHUP_SLOTS_PER_SUB: usize = 64;
const MAX_DEADLINES_PER_TICK: usize = 64;

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

// =========================================================================
// Pure-Rust 5/6-field Cron & DST-aware Timezone Engine
// =========================================================================

pub(crate) fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = y as i64 - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m as i64 + if m > 2 { -3 } else { 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u32, d as u32)
}

/// Day of week where 0 = Sunday .. 6 = Saturday (Unix epoch 1970-01-01 was Thursday = 4).
fn weekday_from_days(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

fn nth_weekday_day(year: i32, month: u32, target_dow: u32, nth: u32) -> u32 {
    let first_dow = weekday_from_days(days_from_civil(year, month, 1));
    let delta = (target_dow + 7 - first_dow) % 7;
    1 + delta + (nth - 1) * 7
}

fn last_weekday_day(year: i32, month: u32, target_dow: u32) -> u32 {
    let dim = days_in_month(year, month);
    let last_dow = weekday_from_days(days_from_civil(year, month, dim));
    let delta = (last_dow + 7 - target_dow) % 7;
    dim - delta
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let y = year as i64;
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

#[derive(Clone, Copy)]
enum TzRule {
    FixedMinutes(i64),
    Us { std_min: i64 },
    Eu { std_min: i64 },
}

fn parse_fixed_offset(spec: &str) -> Option<i64> {
    let s = spec.trim();
    if s.eq_ignore_ascii_case("UTC")
        || s.eq_ignore_ascii_case("Etc/UTC")
        || s.eq_ignore_ascii_case("GMT")
        || s.eq_ignore_ascii_case("Etc/GMT")
    {
        return Some(0);
    }
    let body = s
        .strip_prefix("UTC")
        .or_else(|| s.strip_prefix("GMT"))
        .unwrap_or(s);
    if (body.starts_with('+') || body.starts_with('-')) && body.len() >= 2 {
        let sign = if body.starts_with('-') { -1 } else { 1 };
        let rest = &body[1..];
        let (h_str, m_str) = if let Some((h, m)) = rest.split_once(':') {
            (h, m)
        } else {
            (rest, "0")
        };
        if let (Ok(h), Ok(m)) = (h_str.parse::<i64>(), m_str.parse::<i64>())
            && h <= 14
            && m < 60
        {
            return Some(sign * (h * 60 + m));
        }
    }
    None
}

fn tz_rule(timezone: Option<&str>) -> TzRule {
    let tz = timezone.unwrap_or("UTC").trim();
    if tz.is_empty() || tz == "UTC" || tz == "Etc/UTC" || tz == "GMT" {
        return TzRule::FixedMinutes(0);
    }
    if let Some(mins) = parse_fixed_offset(tz) {
        return TzRule::FixedMinutes(mins);
    }
    match tz {
        "Asia/Shanghai" | "Asia/Taipei" | "Asia/Hong_Kong" | "Asia/Macau" | "Asia/Singapore"
        | "Asia/Chongqing" => TzRule::FixedMinutes(8 * 60),
        "Asia/Tokyo" | "Asia/Seoul" => TzRule::FixedMinutes(9 * 60),
        "Asia/Kolkata" | "Asia/Calcutta" => TzRule::FixedMinutes(5 * 60 + 30),
        "America/Los_Angeles" | "US/Pacific" => TzRule::Us { std_min: -8 * 60 },
        "America/Denver" | "US/Mountain" => TzRule::Us { std_min: -7 * 60 },
        "America/Chicago" | "US/Central" => TzRule::Us { std_min: -6 * 60 },
        "America/New_York" | "US/Eastern" => TzRule::Us { std_min: -5 * 60 },
        "Europe/London" | "Europe/Dublin" | "Europe/Lisbon" => TzRule::Eu { std_min: 0 },
        "Europe/Berlin" | "Europe/Paris" | "Europe/Rome" | "Europe/Madrid"
        | "Europe/Amsterdam" | "Europe/Zurich" => TzRule::Eu { std_min: 60 },
        "Europe/Athens" | "Europe/Helsinki" => TzRule::Eu { std_min: 120 },
        _ => TzRule::FixedMinutes(0),
    }
}

fn us_dst_window_utc_ms(year: i32, std_min: i64) -> (i64, i64) {
    // 2nd Sunday of March 02:00 standard time -> enters DST
    let start_day = nth_weekday_day(year, 3, 0, 2);
    let start_local_ms = (days_from_civil(year, 3, start_day) * 86_400 + 2 * 3_600) * 1000;
    let start_utc = start_local_ms - std_min * 60_000;
    // 1st Sunday of November 02:00 daylight time (std_min + 60) -> exits DST
    let end_day = nth_weekday_day(year, 11, 0, 1);
    let end_local_ms = (days_from_civil(year, 11, end_day) * 86_400 + 2 * 3_600) * 1000;
    let end_utc = end_local_ms - (std_min + 60) * 60_000;
    (start_utc, end_utc)
}

fn eu_dst_window_utc_ms(year: i32) -> (i64, i64) {
    // Last Sunday of March 01:00 UTC -> Last Sunday of October 01:00 UTC
    let start_day = last_weekday_day(year, 3, 0);
    let start_utc = (days_from_civil(year, 3, start_day) * 86_400 + 3_600) * 1000;
    let end_day = last_weekday_day(year, 10, 0);
    let end_utc = (days_from_civil(year, 10, end_day) * 86_400 + 3_600) * 1000;
    (start_utc, end_utc)
}

fn offset_minutes_at_utc(utc_ms: i64, timezone: Option<&str>) -> i64 {
    match tz_rule(timezone) {
        TzRule::FixedMinutes(m) => m,
        TzRule::Us { std_min } => {
            let days = utc_ms.div_euclid(86_400_000);
            let (year, _, _) = civil_from_days(days);
            let (start_utc, end_utc) = us_dst_window_utc_ms(year, std_min);
            if utc_ms >= start_utc && utc_ms < end_utc {
                std_min + 60
            } else {
                std_min
            }
        }
        TzRule::Eu { std_min } => {
            let days = utc_ms.div_euclid(86_400_000);
            let (year, _, _) = civil_from_days(days);
            let (start_utc, end_utc) = eu_dst_window_utc_ms(year);
            if utc_ms >= start_utc && utc_ms < end_utc {
                std_min + 60
            } else {
                std_min
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalParts {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub dow: u32,
    pub date: String,
    pub time: String,
    pub offset_minutes: i64,
}

pub fn local_parts(utc_ms: i64, timezone: Option<&str>) -> LocalParts {
    let offset_min = offset_minutes_at_utc(utc_ms, timezone);
    let local_ms = utc_ms + offset_min * 60_000;
    let days = local_ms.div_euclid(86_400_000);
    let rem_ms = local_ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let total_sec = rem_ms / 1000;
    let hour = (total_sec / 3600) as u32;
    let minute = ((total_sec % 3600) / 60) as u32;
    let dow = weekday_from_days(days);
    LocalParts {
        year,
        month,
        day,
        hour,
        minute,
        dow,
        date: format!("{year:04}-{month:02}-{day:02}"),
        time: format!("{hour:02}:{minute:02}"),
        offset_minutes: offset_min,
    }
}

/// Resolves a local wall-clock instant `(Y, M, D, H, Min)` in `timezone` to its UTC epoch ms.
/// Matches DST `first-valid` policy:
/// - Spring-forward non-existent local time returns the instant `std_offset + 60` shifted forward (matching croner).
/// - Fall-back repeated local time returns the FIRST occurrence (DST offset, earlier instant).
fn local_wall_to_utc_first_valid(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    timezone: Option<&str>,
) -> i64 {
    let wall_ms = (days_from_civil(year, month, day) * 86_400
        + hour as i64 * 3_600
        + minute as i64 * 60)
        * 1000;
    match tz_rule(timezone) {
        TzRule::FixedMinutes(m) => wall_ms - m * 60_000,
        TzRule::Us { std_min } => {
            let (start_utc, end_utc) = us_dst_window_utc_ms(year, std_min);
            let dst_utc = wall_ms - (std_min + 60) * 60_000;
            let std_utc = wall_ms - std_min * 60_000;
            // Candidate 1: happens before or in DST when interpreted with DST/STD
            if std_utc < start_utc {
                std_utc
            } else if dst_utc >= start_utc && dst_utc < end_utc {
                // Covers both pure-DST and the first occurrence of fall-back repeated hour!
                dst_utc
            } else if dst_utc < start_utc && std_utc >= start_utc {
                // Spring-forward gap (02:00..02:59): first valid instant shifts forward by 1h (e.g. 02:30 -> 03:30 PDT == std_utc)!
                std_utc
            } else {
                std_utc
            }
        }
        TzRule::Eu { std_min } => {
            let (start_utc, end_utc) = eu_dst_window_utc_ms(year);
            let dst_utc = wall_ms - (std_min + 60) * 60_000;
            let std_utc = wall_ms - std_min * 60_000;
            if std_utc < start_utc {
                std_utc
            } else if dst_utc >= start_utc && dst_utc < end_utc {
                dst_utc
            } else if dst_utc < start_utc && std_utc >= start_utc {
                std_utc
            } else {
                std_utc
            }
        }
    }
}

#[derive(Clone, Debug)]
struct CronField {
    allowed: Vec<bool>,
    restricted: bool,
}

impl CronField {
    fn parse(token: &str, min: usize, max: usize, wrap_sunday: bool) -> Result<Self, String> {
        let len = max + 1;
        let mut allowed = vec![false; len];
        let restricted = token.trim() != "*";
        for part in token.trim().split(',') {
            let part = part.trim();
            if part.is_empty() {
                return Err(format!("empty cron field part in '{token}'"));
            }
            let (range_part, step_str) = match part.split_once('/') {
                Some((r, s)) => (r.trim(), Some(s.trim())),
                None => (part, None),
            };
            let step: usize = match step_str {
                Some(s) => s
                    .parse::<usize>()
                    .ok()
                    .filter(|&v| v > 0)
                    .ok_or_else(|| format!("invalid cron step '{s}'"))?,
                None => 1,
            };
            let (start, end) = if range_part == "*" {
                (min, max)
            } else if let Some((a, b)) = range_part.split_once('-') {
                let mut lo = a
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| format!("invalid cron range start '{a}'"))?;
                let mut hi = b
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| format!("invalid cron range end '{b}'"))?;
                if wrap_sunday && lo == 7 {
                    lo = 0;
                }
                if wrap_sunday && hi == 7 {
                    hi = 6;
                }
                if lo < min || hi > max || lo > hi {
                    return Err(format!("out-of-range cron bounds '{range_part}'"));
                }
                (lo, hi)
            } else {
                let mut single = range_part
                    .parse::<usize>()
                    .map_err(|_| format!("invalid cron value '{range_part}'"))?;
                if wrap_sunday && single == 7 {
                    single = 0;
                }
                if single < min || single > max {
                    return Err(format!("out-of-range cron value '{single}'"));
                }
                (single, if step_str.is_some() { max } else { single })
            };
            let mut val = start;
            while val <= end {
                allowed[val] = true;
                val += step;
            }
        }
        Ok(Self {
            allowed,
            restricted,
        })
    }

    fn contains(&self, value: u32) -> bool {
        self.allowed.get(value as usize).copied().unwrap_or(false)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ParsedCron {
    seconds: Option<CronField>,
    minutes: CronField,
    hours: CronField,
    dom: CronField,
    months: CronField,
    dow: CronField,
}

impl ParsedCron {
    pub(crate) fn parse(expr: &str) -> Result<Self, String> {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() == 6 {
            return Ok(Self {
                seconds: Some(CronField::parse(fields[0], 0, 59, false)?),
                minutes: CronField::parse(fields[1], 0, 59, false)?,
                hours: CronField::parse(fields[2], 0, 23, false)?,
                dom: CronField::parse(fields[3], 1, 31, false)?,
                months: CronField::parse(fields[4], 1, 12, false)?,
                dow: CronField::parse(fields[5], 0, 6, true)?,
            });
        }
        if fields.len() != 5 {
            return Err(format!("expected 5-field cron expression, got '{}'", expr));
        }
        Ok(Self {
            seconds: None,
            minutes: CronField::parse(fields[0], 0, 59, false)?,
            hours: CronField::parse(fields[1], 0, 23, false)?,
            dom: CronField::parse(fields[2], 1, 31, false)?,
            months: CronField::parse(fields[3], 1, 12, false)?,
            dow: CronField::parse(fields[4], 0, 6, true)?,
        })
    }

    fn matches_day(&self, year: i32, month: u32, day: u32) -> bool {
        if !self.months.contains(month) {
            return false;
        }
        let dow = weekday_from_days(days_from_civil(year, month, day));
        let dom_ok = self.dom.contains(day);
        let dow_ok = self.dow.contains(dow);
        if self.dom.restricted && self.dow.restricted {
            dom_ok || dow_ok
        } else {
            dom_ok && dow_ok
        }
    }

    fn matches_local(&self, local: &LocalParts) -> bool {
        self.minutes.contains(local.minute)
            && self.hours.contains(local.hour)
            && self.matches_day(local.year, local.month, local.day)
    }

    fn next_run_after_utc(&self, after_utc_ms: i64, timezone: Option<&str>) -> Option<i64> {
        let start_parts = local_parts(after_utc_ms, timezone);
        let mut day_cursor = days_from_civil(start_parts.year, start_parts.month, start_parts.day);
        // Check up to ~400 days (~13 months) to cover leap years / rare cron expressions cleanly.
        for day_offset in 0..=400 {
            let days = day_cursor + day_offset;
            let (year, month, day) = civil_from_days(days);
            if !self.matches_day(year, month, day) {
                continue;
            }
            for hour in 0..24u32 {
                if !self.hours.contains(hour) {
                    continue;
                }
                for minute in 0..60u32 {
                    if !self.minutes.contains(minute) {
                        continue;
                    }
                    let base_utc =
                        local_wall_to_utc_first_valid(year, month, day, hour, minute, timezone);
                    if let Some(sec_field) = &self.seconds {
                        if base_utc + 59_000 <= after_utc_ms {
                            continue;
                        }
                        for sec in 0..60u32 {
                            if !sec_field.contains(sec) {
                                continue;
                            }
                            let candidate_utc = base_utc + sec as i64 * 1_000;
                            if candidate_utc > after_utc_ms {
                                return Some(candidate_utc);
                            }
                        }
                    } else if base_utc > after_utc_ms {
                        return Some(base_utc);
                    }
                }
            }
        }
        let _ = day_cursor;
        day_cursor = 0;
        let _ = day_cursor;
        None
    }
}

pub fn cron_next_wake(
    cron_expression: Option<&str>,
    timezone: Option<&str>,
    from_ms: i64,
) -> Option<i64> {
    let expr = cron_expression?.trim();
    if expr.is_empty() {
        return None;
    }
    let parsed = ParsedCron::parse(expr).ok()?;
    parsed.next_run_after_utc(from_ms, timezone)
}

fn nominal_wall_slot(
    cron_expression: &str,
    effective_at_ms: i64,
    timezone: Option<&str>,
) -> (String, String, bool) {
    let local = local_parts(effective_at_ms, timezone);
    let Ok(parsed) = ParsedCron::parse(cron_expression) else {
        return (local.date, local.time, false);
    };
    let pseudo_ms = (days_from_civil(local.year, local.month, local.day) * 86_400
        + local.hour as i64 * 3_600
        + local.minute as i64 * 60)
        * 1000;
    let mut cursor = pseudo_ms - 3 * 3_600_000 - 60_000;
    let mut best: Option<LocalParts> = None;
    for _ in 0..512 {
        let Some(next) = parsed.next_run_after_utc(cursor, Some("UTC")) else {
            break;
        };
        if next > pseudo_ms {
            break;
        }
        best = Some(local_parts(next, Some("UTC")));
        cursor = next;
    }
    match best {
        Some(b) => {
            let normalized = b.time != local.time || b.date != local.date;
            (b.date, b.time, normalized)
        }
        None => {
            let _ = parsed.matches_local(&local);
            (local.date, local.time, false)
        }
    }
}

pub fn logical_slot_key(
    subscription_id: &str,
    revision: i64,
    date: &str,
    time: &str,
) -> (String, String) {
    let wall = format!("{date}T{time}");
    let _digest = sha256_hex(&format!("{subscription_id}:{revision}:{wall}"));
    // Keep TS parity: logical_slot_key column stores YYYY-MM-DDTHH:MM for direct slot inspection,
    // matching `WorkWatchScheduler.logicalSlot` (`${wall.date}T${wall.time}`).
    (wall, _digest)
}

// =========================================================================
// Command & Query Schema
// =========================================================================

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    OwnerAcquire {
        owner_id: String,
        lease_ttl_ms: Option<i64>,
        now_ms: Option<i64>,
    },
    OwnerHeartbeat {
        owner_id: String,
        lease_ttl_ms: Option<i64>,
        now_ms: Option<i64>,
    },
    OwnerRelease {
        owner_id: String,
        now_ms: Option<i64>,
    },
    OwnerStatus {
        owner_id: Option<String>,
        lease_ttl_ms: Option<i64>,
        now_ms: Option<i64>,
    },
    CreateWork {
        operation_id: String,
        user_id: String,
        work_id: Option<String>,
        title: String,
        goal_description: Option<String>,
        mode: Option<String>,
        watch_rule: Option<Value>,
        owner_bot_id: Option<String>,
        criteria: Option<Vec<Value>>,
        input_snapshot_id: Option<String>,
        deadline_at: Option<i64>,
        authorization: Option<Value>,
        workspace_path: Option<String>,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    AmendWork {
        operation_id: String,
        user_id: String,
        work_id: String,
        title: Option<String>,
        goal_description: Option<String>,
        criteria: Option<Vec<Value>>,
        input_snapshot_id: Option<String>,
        expected_state_version: i64,
        expected_intent_revision: i64,
        expected_owner_epoch: i64,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    PauseWork {
        operation_id: String,
        user_id: String,
        work_id: String,
        expected_state_version: Option<i64>,
        expected_intent_revision: Option<i64>,
        expected_owner_epoch: Option<i64>,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    ResumeWork {
        operation_id: String,
        user_id: String,
        work_id: String,
        expected_state_version: Option<i64>,
        expected_intent_revision: Option<i64>,
        expected_owner_epoch: Option<i64>,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    CancelWork {
        operation_id: String,
        user_id: String,
        work_id: String,
        summary: Option<String>,
        expected_state_version: Option<i64>,
        expected_intent_revision: Option<i64>,
        expected_owner_epoch: Option<i64>,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    CloseWork {
        operation_id: String,
        user_id: String,
        work_id: String,
        conclusion: String,
        summary: Option<String>,
        expected_state_version: Option<i64>,
        expected_intent_revision: Option<i64>,
        expected_owner_epoch: Option<i64>,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    ArchiveWork {
        work_id: String,
        owner_id: Option<String>,
        archived_at: Option<i64>,
    },
    ConfigureSubscription {
        operation_id: String,
        user_id: String,
        work_id: String,
        subscription_id: Option<String>,
        source: String,
        source_target: Option<String>,
        catch_up_policy: Option<String>,
        cron_expression: Option<String>,
        timezone: Option<String>,
        next_wake_at: Option<i64>,
        max_merge_wait_ms: Option<i64>,
        max_queue_depth: Option<i64>,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    DispatchExecution {
        operation_id: String,
        user_id: Option<String>,
        work_id: String,
        binding_id: Option<String>,
        execution_id: Option<String>,
        task_id: Option<String>,
        bot_id: Option<String>,
        kind: Option<String>,
        resource_key: Option<String>,
        lock_mode: Option<String>,
        allow_concurrent_same_work: Option<bool>,
        payload: Option<Value>,
        inbox_event_id: Option<String>,
        expected_state_version: Option<i64>,
        expected_intent_revision: Option<i64>,
        expected_owner_epoch: Option<i64>,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    SettleExecution {
        binding_id: String,
        work_id: Option<String>,
        outcome: String,
        result: Option<Value>,
        error_message: Option<String>,
        deliverable: Option<DeliverableInput>,
        subitems: Option<Vec<Value>>,
        owner_epoch: Option<i64>,
        intent_revision: Option<i64>,
        input_snapshot_id: Option<String>,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    AcceptDeliverable {
        operation_id: String,
        user_id: String,
        work_id: String,
        deliverable_id: String,
        accepted: bool,
        rejected_reason: Option<String>,
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    Tick {
        owner_id: Option<String>,
        now_ms: Option<i64>,
        lease_ttl_ms: Option<i64>,
    },
    ScanRecovery {
        owner_id: Option<String>,
        now_ms: Option<i64>,
    },
    GetWork {
        work_id: String,
    },
    ListWorks {
        user_id: Option<String>,
    },
    GetExecutionQueue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverableInput {
    pub deliverable_id: Option<String>,
    pub summary: String,
    pub artifact_refs: Option<Vec<String>>,
    pub evidence_refs: Option<Vec<String>>,
    pub uncovered_scope: Option<Vec<String>>,
    pub uncovered_criterion_ids: Option<Vec<String>>,
}

impl Command {
    pub fn is_read_only(&self) -> bool {
        matches!(
            self,
            Self::GetWork { .. } | Self::ListWorks { .. } | Self::GetExecutionQueue | Self::OwnerStatus { .. }
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkRowDto {
    work_id: String,
    user_id: String,
    workspace_path: Option<String>,
    owner_bot_id: String,
    owner_epoch: i64,
    intent_revision: i64,
    source_version: i64,
    title: String,
    goal_description: Option<String>,
    criteria: Value,
    input_snapshot_id: String,
    mode: String,
    lifecycle: String,
    pending_conclusion: Option<String>,
    closure_conclusion: Option<String>,
    closure_summary: Option<String>,
    accepted_deliverable_ids: Value,
    watch_rule: Option<Value>,
    deadline_at: Option<i64>,
    deadline_revision: i64,
    state_version: i64,
    created_at: i64,
    updated_at: i64,
    closed_at: Option<i64>,
}

fn fetch_work(conn: &Connection, work_id: &str) -> crate::Result<Option<WorkRowDto>> {
    conn.query_row(
        "SELECT work_id, user_id, workspace_path, owner_bot_id, owner_epoch, intent_revision,
                source_version, title, goal_description, criteria_json, input_snapshot_id,
                mode, lifecycle, pending_conclusion, closure_conclusion, closure_summary,
                accepted_deliverable_ids_json, watch_rule_json, deadline_at, deadline_revision,
                state_version, created_at, updated_at, closed_at
         FROM works WHERE work_id = ?",
        params![work_id],
        |r| {
            let criteria_str: String = r.get(9)?;
            let accepted_str: String = r.get(16)?;
            let watch_str: Option<String> = r.get(17)?;
            Ok(WorkRowDto {
                work_id: r.get(0)?,
                user_id: r.get(1)?,
                workspace_path: r.get(2)?,
                owner_bot_id: r.get(3)?,
                owner_epoch: r.get(4)?,
                intent_revision: r.get(5)?,
                source_version: r.get(6)?,
                title: r.get(7)?,
                goal_description: r.get(8)?,
                criteria: serde_json::from_str(&criteria_str).unwrap_or_else(|_| json!([])),
                input_snapshot_id: r.get(10)?,
                mode: r.get(11)?,
                lifecycle: r.get(12)?,
                pending_conclusion: r.get(13)?,
                closure_conclusion: r.get(14)?,
                closure_summary: r.get(15)?,
                accepted_deliverable_ids: serde_json::from_str(&accepted_str)
                    .unwrap_or_else(|_| json!([])),
                watch_rule: watch_str.and_then(|s| serde_json::from_str(&s).ok()),
                deadline_at: r.get(18)?,
                deadline_revision: r.get(19)?,
                state_version: r.get(20)?,
                created_at: r.get(21)?,
                updated_at: r.get(22)?,
                closed_at: r.get(23)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn ensure_bot_exists(tx: &Connection, user_id: &str, bot_id: &str, now: i64) -> crate::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO bots (
           bot_id, user_id, display_name, responsibility_summary, expert_profile_json,
           memory_scope_json, authorization_json, foreground_allowed_tools_json,
           notification_policy_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, '', '{}', '{}', '{}', '[]', '{}', 'active', ?, ?)",
        params![bot_id, user_id, bot_id, now, now],
    )?;
    Ok(())
}

fn check_owner_lease_write(
    tx: &Connection,
    owner_id: Option<&str>,
    now: i64,
    lease_ttl_ms: i64,
) -> crate::Result<Option<WriteSideEffects>> {
    let Some(supplied) = owner_id else {
        return Ok(None);
    };
    let row: Option<(String, i64, i64, Option<i64>)> = tx
        .query_row(
            "SELECT authority_id, acquired_at, heartbeat_at, released_at FROM work_host_lease WHERE lease_id='singleton'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    match row {
        None => Ok(Some(WriteSideEffects {
            data: json!({
                "ok": false,
                "status": "rejected",
                "code": "STALE_OWNER",
                "message": "No active Work scheduler owner lease held",
                "suppliedOwner": supplied,
            }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        })),
        Some((holder, _acq, hb, rel)) => {
            let live = rel.is_none() && now.saturating_sub(hb) < lease_ttl_ms;
            if !live || holder != supplied {
                Ok(Some(WriteSideEffects {
                    data: json!({
                        "ok": false,
                        "status": "rejected",
                        "code": if holder != supplied { "OWNER_CONFLICT" } else { "LEASE_EXPIRED" },
                        "holderOwner": holder,
                        "suppliedOwner": supplied,
                        "releasedAt": rel,
                        "heartbeatAt": hb,
                    }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                }))
            } else {
                Ok(None)
            }
        }
    }
}

fn check_version_guard(
    work: &WorkRowDto,
    expected_state_version: Option<i64>,
    expected_intent_revision: Option<i64>,
    expected_owner_epoch: Option<i64>,
) -> Option<WriteSideEffects> {
    if expected_state_version.is_some_and(|v| v != work.state_version)
        || expected_intent_revision.is_some_and(|v| v != work.intent_revision)
        || expected_owner_epoch.is_some_and(|v| v != work.owner_epoch)
    {
        return Some(WriteSideEffects {
            data: json!({
                "ok": false,
                "status": "rejected",
                "code": "REVISION_CONFLICT",
                "actualStateVersion": work.state_version,
                "actualIntentRevision": work.intent_revision,
                "actualOwnerEpoch": work.owner_epoch,
            }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        });
    }
    None
}

fn check_receipt(
    tx: &Connection,
    user_id: &str,
    operation_id: &str,
    payload_hash: &str,
) -> crate::Result<Option<WriteSideEffects>> {
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT payload_hash, result_snapshot_json FROM work_operation_receipts WHERE user_id = ? AND operation_id = ?",
            params![user_id, operation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((saved_hash, snapshot)) = row else {
        return Ok(None);
    };
    if saved_hash != payload_hash {
        return Ok(Some(WriteSideEffects {
            data: json!({
                "ok": false,
                "status": "rejected",
                "code": "IDEMPOTENCY_CONFLICT",
                "operationId": operation_id,
            }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        }));
    }
    let mut parsed: Value = serde_json::from_str(&snapshot).unwrap_or_else(|_| json!({}));
    if let Some(obj) = parsed.as_object_mut() {
        obj.insert("replayed".into(), Value::Bool(true));
    }
    Ok(Some(WriteSideEffects {
        data: parsed,
        events: vec![],
        dispatches: vec![],
        shutdown_after_reply: false,
    }))
}

fn save_receipt(
    tx: &Connection,
    user_id: &str,
    operation_id: &str,
    work_id: &str,
    operation_type: &str,
    payload_hash: &str,
    reply: &Value,
    outbox_event_id: Option<&str>,
    now: i64,
) -> crate::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO work_operation_receipts (
           user_id, operation_id, work_id, operation_type, payload_hash,
           result_snapshot_json, outbox_event_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            user_id,
            operation_id,
            work_id,
            operation_type,
            payload_hash,
            serde_json::to_string(reply)?,
            outbox_event_id,
            now
        ],
    )?;
    Ok(())
}

fn insert_outbox(
    tx: &Connection,
    work: &WorkRowDto,
    event_type: &str,
    operation_id: &str,
    binding_id: Option<&str>,
    payload: &Value,
    now: i64,
) -> crate::Result<String> {
    let event_id = format!("out-{}", sha256_hex(&format!("{}:{operation_id}:{event_type}", work.work_id))[..16].to_owned());
    let dedupe_key = format!("outbox:{}:{event_type}:{operation_id}", work.work_id);
    tx.execute(
        "INSERT OR IGNORE INTO work_events_outbox (
           event_id, dedupe_key, event_type, work_id, binding_id,
           intent_revision, state_version, owner_epoch, request_id,
           payload_json, delivery_status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        params![
            event_id,
            dedupe_key,
            event_type,
            work.work_id,
            binding_id,
            work.intent_revision,
            work.state_version,
            work.owner_epoch,
            operation_id,
            serde_json::to_string(payload)?,
            now
        ],
    )?;
    Ok(event_id)
}

struct ActiveConflictSet {
    active_ids: HashSet<String>,
    work_ids: HashMap<String, String>,
    resources: HashMap<String, Vec<(String, String)>>,
    sessions: HashMap<String, String>,
}

impl ActiveConflictSet {
    fn load(tx: &Connection) -> crate::Result<Self> {
        let mut set = Self {
            active_ids: HashSet::new(),
            work_ids: HashMap::new(),
            resources: HashMap::new(),
            sessions: HashMap::new(),
        };
        let mut stmt = tx.prepare(
            "SELECT execution_id, task_id, kind, payload_json FROM core_execution_runs
             WHERE status IN ('dispatching', 'running', 'pause_requested', 'cancel_requested')",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (exec_id, task_id, kind, payload_str) in rows {
            let payload: Value = serde_json::from_str(&payload_str).unwrap_or_else(|_| json!({}));
            set.insert(&exec_id, &task_id, &kind, &payload);
        }
        Ok(set)
    }

    fn effective_session_key<'a>(task_id: &'a str, kind: &str, payload: &'a Value) -> Option<&'a str> {
        if let Some(sk) = payload
            .get("sessionKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(sk);
        }
        if kind == "pi_turn" && !task_id.trim().is_empty() {
            return Some(task_id);
        }
        None
    }

    fn insert(&mut self, exec_id: &str, task_id: &str, kind: &str, payload: &Value) {
        self.active_ids.insert(exec_id.to_owned());
        if let Some(work_id) = payload
            .get("workId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            self.work_ids
                .entry(work_id.to_owned())
                .or_insert_with(|| exec_id.to_owned());
        }
        if let Some(rk) = payload
            .get("resourceKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mode = payload
                .get("lockMode")
                .and_then(Value::as_str)
                .unwrap_or("exclusive")
                .to_owned();
            self.resources
                .entry(rk.to_owned())
                .or_default()
                .push((exec_id.to_owned(), mode));
        }
        if let Some(sk) = Self::effective_session_key(task_id, kind, payload)
            && !payload
                .get("allowConcurrentSameSession")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            self.sessions
                .entry(sk.to_owned())
                .or_insert_with(|| exec_id.to_owned());
        }
    }

    fn check(&self, exec_id: &str, task_id: &str, kind: &str, payload: &Value) -> Option<String> {
        let work_id = payload
            .get("workId")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let allow_same_work = payload
            .get("allowConcurrentSameWork")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !work_id.is_empty()
            && !allow_same_work
            && let Some(active_id) = self.work_ids.get(work_id)
            && active_id != exec_id
        {
            return Some(format!("work:{work_id}:active:{active_id}"));
        }

        if let Some(rk) = payload
            .get("resourceKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            && let Some(holders) = self.resources.get(rk)
        {
            let lock_mode = payload
                .get("lockMode")
                .and_then(Value::as_str)
                .unwrap_or("exclusive");
            for (active_id, active_mode) in holders {
                if active_id != exec_id && (lock_mode != "shared" || active_mode != "shared") {
                    return Some(format!("resource:{rk}:held_by:{active_id}"));
                }
            }
        }

        if let Some(sk) = Self::effective_session_key(task_id, kind, payload)
            && !payload
                .get("allowConcurrentSameSession")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && let Some(active_id) = self.sessions.get(sk)
            && active_id != exec_id
        {
            return Some(format!("session:{sk}:active:{active_id}"));
        }
        None
    }
}

fn candidate_priority_tier(kind: &str, payload: &Value) -> i64 {
    match payload.get("priority").and_then(Value::as_str) {
        Some("foreground" | "high") => return 0,
        Some("background" | "low") => return 2,
        Some("normal") => return 1,
        _ => {}
    }
    match kind {
        "pi_turn" | "pi_control" | "pi_compact" => 0,
        "dots_control" | "gateway_control" | "maintenance_control" => 2,
        _ => 1,
    }
}

/// Checks whether a queued execution candidate conflicts with currently dispatching/running
/// executions on either `workId` (when not `allowConcurrentSameWork`) or `resourceKey` (exclusive lock).
fn has_active_conflict(
    tx: &Connection,
    candidate_execution_id: &str,
    candidate_payload: &Value,
) -> crate::Result<Option<String>> {
    let work_id = candidate_payload
        .get("workId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let allow_same_work = candidate_payload
        .get("allowConcurrentSameWork")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let resource_key = candidate_payload
        .get("resourceKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let lock_mode = candidate_payload
        .get("lockMode")
        .and_then(Value::as_str)
        .unwrap_or("exclusive");

    if work_id.is_empty() && resource_key.is_none() {
        return Ok(None);
    }

    let mut stmt = tx.prepare(
        "SELECT execution_id, payload_json FROM core_execution_runs
         WHERE status IN ('dispatching', 'running', 'pause_requested', 'cancel_requested')
           AND execution_id != ?",
    )?;
    let rows = stmt
        .query_map(params![candidate_execution_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (active_id, active_payload_str) in rows {
        let Ok(active_payload) = serde_json::from_str::<Value>(&active_payload_str) else {
            continue;
        };
        if !work_id.is_empty()
            && !allow_same_work
            && active_payload.get("workId").and_then(Value::as_str) == Some(work_id)
        {
            return Ok(Some(format!("work:{work_id}:active:{active_id}")));
        }
        if let Some(rk) = resource_key
            && active_payload.get("resourceKey").and_then(Value::as_str) == Some(rk)
        {
            let active_mode = active_payload
                .get("lockMode")
                .and_then(Value::as_str)
                .unwrap_or("exclusive");
            if lock_mode != "shared" || active_mode != "shared" {
                return Ok(Some(format!("resource:{rk}:held_by:{active_id}")));
            }
        }
    }
    Ok(None)
}

fn update_wait_reason_if_changed(
    tx: &Connection,
    exec_id: &str,
    prev_reason: Option<&str>,
    next_reason: &str,
) -> crate::Result<()> {
    if prev_reason == Some(next_reason) {
        return Ok(());
    }
    tx.execute(
        "UPDATE core_execution_runs SET wait_reason = ? WHERE execution_id = ?",
        params![next_reason, exec_id],
    )?;
    Ok(())
}

/// Promotes non-conflicting queued/waiting executions across ALL queued candidates (no `LIMIT 128`
/// head-of-line blocking), with foreground priority + bounded aging and explainable `waitReason`.
pub(crate) fn promote_compatible_executions(
    tx: &Connection,
    core_gen: &str,
    tracker: &ExecutorTracker,
    events: &mut Vec<EmittedEvent>,
    dispatches: &mut Vec<Value>,
) -> crate::Result<usize> {
    const PAGE_SIZE: i64 = 128;
    const MAX_PROMOTE_SCAN: usize = 1024;
    const AGING_STEP_MS: i64 = 5_000;

    let mut all_candidates: Vec<(String, String, String, String, i64, Option<String>)> = Vec::new();
    let mut cursor_ts = i64::MIN;
    let mut cursor_id = String::new();
    while all_candidates.len() < MAX_PROMOTE_SCAN {
        let mut stmt = tx.prepare(
            "SELECT execution_id, task_id, kind, payload_json, created_at_ms, wait_reason
             FROM core_execution_runs
             WHERE status IN ('queued', 'waiting_executor')
               AND (created_at_ms > ?1 OR (created_at_ms = ?1 AND execution_id > ?2))
             ORDER BY created_at_ms ASC, execution_id ASC
             LIMIT ?3",
        )?;
        let page: Vec<(String, String, String, String, i64, Option<String>)> = stmt
            .query_map(params![cursor_ts, cursor_id, PAGE_SIZE], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let page_len = page.len();
        if let Some(last) = page.last() {
            cursor_ts = last.4;
            cursor_id = last.0.clone();
        }
        all_candidates.extend(page);
        if (page_len as i64) < PAGE_SIZE {
            break;
        }
    }

    if all_candidates.is_empty() {
        return Ok(0);
    }

    let Some((exec_epoch, exec_client_id)) = tracker.is_online() else {
        for (exec_id, _, _, _, _, prev_reason) in all_candidates {
            update_wait_reason_if_changed(tx, &exec_id, prev_reason.as_deref(), "executor_offline")?;
        }
        return Ok(0);
    };

    let active_conflicts = ActiveConflictSet::load(tx)?;
    let active_count = active_conflicts.active_ids.len() as i64;
    let mut available = (tracker.slots_limit() - active_count).max(0);
    let mut conflicts = active_conflicts;

    let mut prioritized: Vec<(i64, i64, String, String, String, Value, Option<String>)> = all_candidates
        .into_iter()
        .map(|(exec_id, task_id, kind, payload_str, created_at_ms, prev_reason)| {
            let payload: Value = serde_json::from_str(&payload_str).unwrap_or_else(|_| json!({}));
            let tier = candidate_priority_tier(&kind, &payload);
            let effective_key = created_at_ms.saturating_add(tier * AGING_STEP_MS);
            (effective_key, created_at_ms, exec_id, task_id, kind, payload, prev_reason)
        })
        .collect();
    prioritized.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.cmp(&b.2)));

    let now = now_ms();
    let mut promoted = 0usize;
    for (_, _, exec_id, task_id, kind, payload, prev_reason) in prioritized {
        if !tracker.supports_kind(&kind) {
            let reason = format!("capability_unavailable:{kind}");
            update_wait_reason_if_changed(tx, &exec_id, prev_reason.as_deref(), &reason)?;
            continue;
        }
        if let Some(conflict) = conflicts.check(&exec_id, &task_id, &kind, &payload) {
            let reason = format!("conflict:{conflict}");
            update_wait_reason_if_changed(tx, &exec_id, prev_reason.as_deref(), &reason)?;
            continue;
        }
        if available <= 0 {
            update_wait_reason_if_changed(tx, &exec_id, prev_reason.as_deref(), "slots_exhausted")?;
            continue;
        }
        let Some(row) = crate::business_protocol::fetch_execution_tx(tx, &exec_id)? else {
            continue;
        };
        let next_rev = row.revision + 1;
        let next_attempt = row.attempt + 1;
        tx.execute(
            "UPDATE core_execution_runs
             SET status = 'dispatching', revision = ?, attempt = ?, executor_client_id = ?, executor_epoch = ?, wait_reason = NULL, updated_at_ms = ?
             WHERE execution_id = ?",
            params![
                next_rev,
                next_attempt,
                exec_client_id,
                exec_epoch as i64,
                now,
                exec_id
            ],
        )?;
        tracker.register_active_execution(&exec_id, next_attempt, exec_epoch, &row.owner_generation);
        conflicts.insert(&exec_id, &task_id, &kind, &payload);

        if let Some(binding_id) = payload.get("bindingId").and_then(Value::as_str) {
            tx.execute(
                "UPDATE work_execution_bindings
                 SET status = 'submitted', attempt_id = COALESCE(attempt_id, ?), submitted_at = COALESCE(submitted_at, ?)
                 WHERE binding_id = ? AND status = 'pending'",
                params![format!("attempt-{next_attempt}"), now, binding_id],
            )?;
        }
        if let Some(dispatch_op) = payload.get("operationId").and_then(Value::as_str) {
            tx.execute(
                "UPDATE work_dispatch_requests SET state = 'dispatched', attempts = attempts + 1, error = NULL
                 WHERE operation_id = ? AND state = 'pending'",
                params![dispatch_op],
            )?;
        }
        let updated = crate::business_protocol::fetch_execution_tx(tx, &exec_id)?.unwrap();
        let ev = append_event(
            tx,
            core_gen,
            &updated.owner_generation,
            "execution",
            "execution.dispatching",
            &exec_id,
            next_rev,
            None,
            &json!({
                "executionId": exec_id,
                "taskId": updated.task_id,
                "attempt": next_attempt,
                "executorClientId": exec_client_id,
                "executorEpoch": exec_epoch,
                "status": "dispatching",
            }),
        )?;
        events.push(ev);
        dispatches.push(json!({
            "coreExecutionDispatch": {
                "targetRole": "execution-host",
                "targetEpoch": exec_epoch,
                "coreGeneration": core_gen,
                "action": "start",
                "execution": updated,
            }
        }));
        available -= 1;
        promoted += 1;
    }
    Ok(promoted)
}

/// Hooks `CoreExecution` settlement back into `work_execution_bindings`, `work_deliverables`,
/// `work_automatic_recovery`, and closing settlement when a `core_execution_runs` row is bound to a Work.
pub(crate) fn on_core_execution_state_change(
    tx: &Connection,
    core_gen: &str,
    exec_id: &str,
    status: &str,
    result: Option<&Value>,
    error_message: Option<&str>,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<()> {
    let Some(exec) = crate::business_protocol::fetch_execution_tx(tx, exec_id)? else {
        return Ok(());
    };
    let Some(binding_id) = exec.payload.get("bindingId").and_then(Value::as_str) else {
        return Ok(());
    };
    let binding_status = match status {
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" | "paused" => "stopped",
        "unknown" => "unknown",
        "running" => "running",
        _ => return Ok(()),
    };
    if binding_status == "running" {
        tx.execute(
            "UPDATE work_execution_bindings SET status = 'running' WHERE binding_id = ? AND status IN ('pending', 'submitted')",
            params![binding_id],
        )?;
        return Ok(());
    }
    settle_binding_tx(
        tx,
        core_gen,
        binding_id,
        None,
        binding_status,
        result,
        error_message,
        None,
        None,
        None,
        None,
        None,
        now,
        events,
    )?;
    Ok(())
}

fn settle_binding_tx(
    tx: &Connection,
    core_gen: &str,
    binding_id: &str,
    work_id_hint: Option<&str>,
    outcome: &str,
    result: Option<&Value>,
    error_message: Option<&str>,
    deliverable: Option<&DeliverableInput>,
    subitems: Option<&Vec<Value>>,
    expected_owner_epoch: Option<i64>,
    expected_intent_revision: Option<i64>,
    expected_input_snapshot_id: Option<&str>,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<Value> {
    if !matches!(outcome, "completed" | "failed" | "stopped" | "unknown") {
        return Ok(json!({ "ok": false, "status": "rejected", "code": "INVALID_STATE", "outcome": outcome }));
    }
    let row: Option<(String, String, String, i64, i64, String, String)> = tx
        .query_row(
            "SELECT binding_id, work_id, bot_id, owner_epoch, intent_revision, input_snapshot_id, status
             FROM work_execution_bindings WHERE binding_id = ?",
            params![binding_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;
    let Some((_, work_id, bot_id, b_epoch, b_rev, b_snap, cur_status)) = row else {
        return Ok(json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND", "bindingId": binding_id }));
    };
    if work_id_hint.is_some_and(|w| w != work_id)
        || expected_owner_epoch.is_some_and(|e| e != b_epoch)
        || expected_intent_revision.is_some_and(|r| r != b_rev)
        || expected_input_snapshot_id.is_some_and(|s| s != b_snap)
    {
        return Ok(json!({
            "ok": false,
            "status": "rejected",
            "code": "IDENTITY_MISMATCH",
            "bindingId": binding_id,
            "workId": work_id,
            "ownerEpoch": b_epoch,
            "intentRevision": b_rev,
            "inputSnapshotId": b_snap,
        }));
    }
    if cur_status == "invalidated" {
        return Ok(json!({ "ok": false, "status": "rejected", "code": "BINDING_INVALIDATED", "bindingId": binding_id }));
    }

    let note = error_message.or_else(|| {
        result
            .and_then(|v| v.get("summary").and_then(Value::as_str))
    });
    tx.execute(
        "UPDATE work_execution_bindings
         SET status = ?, settlement_note = COALESCE(?, settlement_note), settled_at = COALESCE(settled_at, ?)
         WHERE binding_id = ?",
        params![outcome, note, now, binding_id],
    )?;

    if let Some(exec_row) = tx
        .query_row(
            "SELECT execution_id, revision FROM core_execution_runs
             WHERE json_extract(payload_json, '$.bindingId') = ? LIMIT 1",
            params![binding_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?
    {
        let core_status = match outcome {
            "completed" => "completed",
            "failed" => "failed",
            "stopped" => "cancelled",
            "unknown" => "unknown",
            _ => "unknown",
        };
        let result_json = result.map(serde_json::to_string).transpose()?;
        tx.execute(
            "UPDATE core_execution_runs
             SET status = ?, revision = ?, result_json = COALESCE(?, result_json), error_message = COALESCE(?, error_message), updated_at_ms = ?
             WHERE execution_id = ?",
            params![core_status, exec_row.1 + 1, result_json, error_message, now, exec_row.0],
        )?;
    }

    let mut created_deliverable_id: Option<String> = None;
    if let Some(deliv) = deliverable {
        let did = deliv
            .deliverable_id
            .clone()
            .unwrap_or_else(|| format!("deliv-{}", sha256_hex(&format!("{binding_id}:{now}"))[..16].to_owned()));
        let artifacts_json = serde_json::to_string(&deliv.artifact_refs.clone().unwrap_or_default())?;
        let evidence_json = serde_json::to_string(&deliv.evidence_refs.clone().unwrap_or_default())?;
        let uncovered_json = serde_json::to_string(&deliv.uncovered_scope.clone().unwrap_or_default())?;
        let uncovered_crit_json =
            serde_json::to_string(&deliv.uncovered_criterion_ids.clone().unwrap_or_default())?;
        tx.execute(
            "INSERT OR IGNORE INTO work_deliverables (
               deliverable_id, work_id, producer_bot_id, execution_id,
               intent_revision, owner_epoch, input_snapshot_id, status, summary,
               artifact_refs_json, evidence_refs_json, uncovered_scope_json,
               uncovered_criterion_ids_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)",
            params![
                did,
                work_id,
                bot_id,
                binding_id,
                b_rev,
                b_epoch,
                b_snap,
                deliv.summary,
                artifacts_json,
                evidence_json,
                uncovered_json,
                uncovered_crit_json,
                now
            ],
        )?;
        created_deliverable_id = Some(did);
    }

    if let Some(items) = subitems {
        for (idx, item) in items.iter().enumerate() {
            let item_id = item
                .get("itemId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("item-{idx}"));
            let fact_id = format!("fact-{}", sha256_hex(&format!("{binding_id}:{item_id}"))[..16].to_owned());
            tx.execute(
                "INSERT INTO work_subitem_results (
                   fact_id, work_id, binding_id, item_id, result_json, deliverable_id, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(binding_id, item_id) DO UPDATE SET
                   result_json = excluded.result_json,
                   deliverable_id = COALESCE(excluded.deliverable_id, work_subitem_results.deliverable_id)",
                params![
                    fact_id,
                    work_id,
                    binding_id,
                    item_id,
                    serde_json::to_string(item)?,
                    created_deliverable_id,
                    now
                ],
            )?;
        }
    }

    if outcome == "unknown" {
        let blocker_id = format!("unknown-exec:{binding_id}");
        tx.execute(
            "INSERT OR IGNORE INTO work_blockers (
               blocker_id, work_id, reported_by_bot_id, reason, kind,
               unknown_external_effect_ref, waiting_for_user_input, status, created_at, reason_code
             ) VALUES (?, ?, ?, 'Execution settled in unknown state; awaiting readback verification', 'external_effect', ?, 0, 'open', ?, 'unknown-execution')",
            params![blocker_id, work_id, bot_id, binding_id, now],
        )?;
    } else if outcome == "failed" {
        let plan_id = format!("auto-rec:{binding_id}");
        let fp = sha256_hex(&format!("{binding_id}:{outcome}:{}", error_message.unwrap_or("")));
        tx.execute(
            "INSERT OR IGNORE INTO work_automatic_recovery (
               source_binding_id, plan_id, fingerprint, mode, created_at
             ) VALUES (?, ?, ?, 'recover', ?)",
            params![binding_id, plan_id, fp, now],
        )?;
    }

    // Never collapse execution settlement into Work closure when `active`, EXCEPT finishing a
    // `closing` Work once all in-flight bindings and admissions have settled.
    if let Some(mut work) = fetch_work(tx, &work_id)? {
        work.state_version += 1;
        work.updated_at = now;
        if work.lifecycle == "closing" {
            let unsettled_bindings: i64 = tx.query_row(
                "SELECT COUNT(*) FROM work_execution_bindings
                 WHERE work_id = ? AND invalidated_at IS NULL AND status IN ('pending', 'submitted', 'running', 'unknown')",
                params![work_id],
                |r| r.get(0),
            )?;
            let unsettled_admissions: i64 = tx.query_row(
                "SELECT COUNT(*) FROM work_action_admissions WHERE work_id = ? AND state IN ('admitted', 'unknown')",
                params![work_id],
                |r| r.get(0),
            )?;
            if unsettled_bindings == 0 && unsettled_admissions == 0 {
                let conclusion = work
                    .pending_conclusion
                    .clone()
                    .unwrap_or_else(|| "ended_unsuccessfully".to_owned());
                tx.execute(
                    "UPDATE works
                     SET lifecycle = 'closed', closure_conclusion = ?, pending_conclusion = NULL,
                         closed_at = COALESCE(closed_at, ?), state_version = ?, updated_at = ?
                     WHERE work_id = ?",
                    params![conclusion, now, work.state_version, now, work_id],
                )?;
            } else {
                tx.execute(
                    "UPDATE works SET state_version = ?, updated_at = ? WHERE work_id = ?",
                    params![work.state_version, now, work_id],
                )?;
            }
        } else {
            tx.execute(
                "UPDATE works SET state_version = ?, updated_at = ? WHERE work_id = ?",
                params![work.state_version, now, work_id],
            )?;
        }
        let latest = fetch_work(tx, &work_id)?.unwrap();
        events.push(append_event(
            tx,
            core_gen,
            core_gen,
            "work",
            &format!("work.execution.{outcome}"),
            &work_id,
            latest.state_version,
            None,
            &json!({
                "workId": work_id,
                "bindingId": binding_id,
                "outcome": outcome,
                "deliverableId": created_deliverable_id,
                "lifecycle": latest.lifecycle,
            }),
        )?);
        return Ok(json!({
            "ok": true,
            "status": "committed",
            "bindingId": binding_id,
            "outcome": outcome,
            "deliverableId": created_deliverable_id,
            "work": latest,
        }));
    }

    Ok(json!({
        "ok": true,
        "status": "committed",
        "bindingId": binding_id,
        "outcome": outcome,
        "deliverableId": created_deliverable_id,
    }))
}

fn tick_tx(
    tx: &Connection,
    core_gen: &str,
    tracker: &ExecutorTracker,
    owner_id: Option<&str>,
    now: i64,
    lease_ttl_ms: i64,
    events: &mut Vec<EmittedEvent>,
    dispatches: &mut Vec<Value>,
) -> crate::Result<Value> {
    if let Some(rejection) = check_owner_lease_write(tx, owner_id, now, lease_ttl_ms)? {
        return Ok(rejection.data);
    }

    let auth_id: String = if let Some(oid) = owner_id {
        oid.to_owned()
    } else {
        tx.query_row(
            "SELECT authority_id FROM work_host_lease WHERE lease_id = 'singleton'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| format!("core:{core_gen}"))
    };

    let host_state: Option<(Option<i64>, Option<String>, Option<i64>, String)> = tx
        .query_row(
            "SELECT last_scan_at, last_scan_cursor, active_since, session_id
             FROM work_watch_host_state WHERE authority_id = ?",
            params![auth_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let (last_scan_at, prev_cursor, active_since, session_id) = match host_state {
        Some((lsa, lsc, acs, sid)) => (lsa, lsc, acs.unwrap_or(now), sid),
        None => (None, None, now, format!("rust-sched-{core_gen}")),
    };
    let wall_rolled_back = last_scan_at.is_some_and(|prev| now < prev);
    tx.execute(
        "INSERT INTO work_watch_host_state (
           authority_id, session_id, last_scan_at, last_scan_cursor,
           active_since, last_seen_at, stopped_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(authority_id) DO UPDATE SET
           last_scan_at = MAX(COALESCE(work_watch_host_state.last_scan_at, excluded.last_scan_at), excluded.last_scan_at),
           last_seen_at = excluded.last_seen_at,
           stopped_at = NULL,
           updated_at = excluded.updated_at",
        params![auth_id, session_id, now, prev_cursor, active_since, now, now],
    )?;

    // 1. Expire watch works whose `endsAt <= now` or `termination.reason == 'schedule_expired'`
    let mut expired_watch_ids = Vec::new();
    {
        let mut stmt = tx.prepare(
            "SELECT work_id FROM works WHERE mode = 'watch' AND lifecycle IN ('active', 'paused', 'closing')
             AND ((json_type(watch_rule_json, '$.endsAt') IN ('integer', 'real') AND json_extract(watch_rule_json, '$.endsAt') <= ?)
               OR json_extract(watch_rule_json, '$.termination.reason') = 'schedule_expired')",
        )?;
        for r in stmt.query_map(params![now], |r| r.get::<_, String>(0))? {
            let wid = r?;
            if let Some(work) = fetch_work(tx, &wid)? {
                let mut rule = work.watch_rule.clone().unwrap_or_else(|| json!({}));
                if let Some(obj) = rule.as_object_mut()
                    && !obj.contains_key("termination")
                {
                    obj.insert(
                        "termination".into(),
                        json!({ "reason": "schedule_expired", "requestedAt": now, "settledAt": now }),
                    );
                }
                let unsettled: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM work_execution_bindings
                     WHERE work_id = ? AND invalidated_at IS NULL AND status IN ('pending', 'submitted', 'running', 'unknown')",
                    params![wid],
                    |row| row.get(0),
                )?;
                let next_ver = work.state_version + 1;
                if unsettled == 0 {
                    tx.execute(
                        "UPDATE works
                         SET lifecycle = 'closed', closure_conclusion = 'succeeded', pending_conclusion = NULL,
                             watch_rule_json = ?, closed_at = COALESCE(closed_at, ?), state_version = ?, updated_at = ?
                         WHERE work_id = ?",
                        params![serde_json::to_string(&rule)?, now, next_ver, now, wid],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE works
                         SET lifecycle = 'closing', pending_conclusion = COALESCE(pending_conclusion, 'succeeded'),
                             watch_rule_json = ?, state_version = ?, updated_at = ?
                         WHERE work_id = ?",
                        params![serde_json::to_string(&rule)?, next_ver, now, wid],
                    )?;
                }
                tx.execute(
                    "UPDATE work_subscriptions SET stopped_at = COALESCE(stopped_at, ?), stopped_reason = COALESCE(stopped_reason, 'schedule_expired')
                     WHERE work_id = ? AND stopped_at IS NULL",
                    params![now, wid],
                )?;
                expired_watch_ids.push(wid.clone());
                events.push(append_event(
                    tx,
                    core_gen,
                    core_gen,
                    "work",
                    "work.watch_expired",
                    &wid,
                    next_ver,
                    None,
                    &json!({ "workId": wid, "expiredAt": now, "unsettledBindings": unsettled }),
                )?);
            }
        }
    }

    // 2. Round-robin due subscriptions (limit 128) with DST-aware cron slots + catchUpPolicy + highWater guard
    let after_cursor = prev_cursor.unwrap_or_default();
    let mut sub_rows: Vec<(String, String, Option<String>, Option<String>, Option<i64>, String, i64, i64, Option<String>)> = Vec::new();
    for (cmp, rem) in [(">", MAX_SUBSCRIPTIONS_PER_TICK), ("<=", MAX_SUBSCRIPTIONS_PER_TICK)] {
        let take = rem.saturating_sub(sub_rows.len());
        if take == 0 {
            break;
        }
        let sql = format!(
            "SELECT s.subscription_id, s.work_id, s.cron_expression, s.timezone, s.next_wake_at,
                    s.catch_up_policy, s.schedule_revision, s.max_queue_depth, s.source_target
             FROM work_subscriptions s
             JOIN works w ON w.work_id = s.work_id
             WHERE s.stopped_at IS NULL AND w.lifecycle = 'active' AND s.next_wake_at IS NOT NULL AND s.next_wake_at <= ?
               AND s.subscription_id {cmp} ?
             ORDER BY s.subscription_id ASC LIMIT ?"
        );
        let mut stmt = tx.prepare(&sql)?;
        for r in stmt.query_map(params![now, after_cursor, take as i64], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
            ))
        })? {
            sub_rows.push(r?);
        }
    }

    let mut fired_ticks = Vec::new();
    let mut last_sub_id: Option<String> = None;
    for (sub_id, work_id, cron_expr, timezone, next_wake_at, catch_up_policy, revision, max_queue_depth, source_target) in sub_rows {
        last_sub_id = Some(sub_id.clone());
        let Some(scheduled_at) = next_wake_at else { continue };
        let Some(work) = fetch_work(tx, &work_id)? else { continue };
        if work.lifecycle != "active" {
            continue;
        }

        let high_water: Option<i64> = tx
            .query_row(
                "SELECT MAX(planned_at) FROM work_schedule_ticks WHERE subscription_id = ? AND schedule_revision = ?",
                params![sub_id, revision],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        if wall_rolled_back && high_water.is_some_and(|hw| now < hw) {
            continue;
        }

        let mut cursor = scheduled_at;
        if let Some(expr) = cron_expr.as_deref()
            && catch_up_policy != "each"
        {
            // Fast binary/step advance to latest slot <= now for coalesced policies
            let mut latest = cursor;
            while let Some(nxt) = cron_next_wake(Some(expr), timezone.as_deref(), latest) {
                if nxt > now {
                    break;
                }
                latest = nxt;
            }
            cursor = latest;
        }

        if catch_up_policy == "skip" && cursor < now - TICK_INTERVAL_MS {
            let next_wake = cron_next_wake(cron_expr.as_deref(), timezone.as_deref(), now);
            tx.execute(
                "UPDATE work_subscriptions SET next_wake_at = ?, updated_at = ? WHERE subscription_id = ?",
                params![next_wake, now, sub_id],
            )?;
            continue;
        }

        if catch_up_policy == "latest" {
            let mut stale_stmt = tx.prepare(
                "SELECT i.event_id FROM work_events_inbox i
                 JOIN work_schedule_ticks t ON t.inbox_event_id = i.event_id
                 WHERE i.subscription_id = ? AND i.event_type = 'work.tick'
                   AND i.status = 'pending' AND i.frozen_at IS NULL
                   AND t.schedule_revision = ? AND t.planned_at < ?
                   AND NOT EXISTS (SELECT 1 FROM work_execution_bindings b WHERE b.inbox_event_id = i.event_id)",
            )?;
            let stale_ids: Vec<String> = stale_stmt
                .query_map(params![sub_id, revision, cursor], |r| r.get(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(stale_stmt);
            for eid in stale_ids {
                tx.execute(
                    "UPDATE work_events_inbox SET status = 'skipped', processed_at = ?, process_reason = 'schedule-latest-coalesced' WHERE event_id = ?",
                    params![now, eid],
                )?;
                tx.execute(
                    "UPDATE work_schedule_ticks SET status = 'skipped' WHERE inbox_event_id = ?",
                    params![eid],
                )?;
            }
        }

        let depth: i64 = tx.query_row(
            "SELECT COUNT(*) FROM work_events_inbox WHERE subscription_id = ? AND status IN ('pending', 'merged', 'blocked')",
            params![sub_id],
            |r| r.get(0),
        )?;
        let mut available = (max_queue_depth - depth).max(0);
        if available == 0 {
            continue;
        }

        let mut guard = 0usize;
        while cursor <= now && guard < MAX_CATCHUP_SLOTS_PER_SUB && available > 0 {
            guard += 1;
            let effective_at = cursor;
            let (slot_key, normalized, wall_time) = match cron_expr.as_deref() {
                Some(expr) => {
                    let (d, t, norm) = nominal_wall_slot(expr, effective_at, timezone.as_deref());
                    let (wk, _) = logical_slot_key(&sub_id, revision, &d, &t);
                    (wk, norm, t)
                }
                None => {
                    let lp = local_parts(effective_at, timezone.as_deref());
                    let (wk, _) = logical_slot_key(&sub_id, revision, &lp.date, &lp.time);
                    (wk, false, lp.time)
                }
            };
            let merged_into: Option<(String, String)> = tx
                .query_row(
                    "SELECT tick_id, merged_from_slot_keys_json FROM work_schedule_ticks
                     WHERE subscription_id = ? AND schedule_revision = ? AND effective_at = ? AND status = 'dispatched' LIMIT 1",
                    params![sub_id, revision, effective_at],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let tick_id = format!("tick-{}", sha256_hex(&format!("{sub_id}:{revision}:{slot_key}"))[..16].to_owned());
            let initial_status = if merged_into.is_some() { "skipped" } else { "pending" };
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO work_schedule_ticks (
                   tick_id, subscription_id, work_id, schedule_revision, logical_slot_key,
                   planned_at, effective_at, status, merged_from_slot_keys_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)",
                params![tick_id, sub_id, work_id, revision, slot_key, cursor, effective_at, initial_status, now],
            )?;
            if inserted > 0 && merged_into.is_none() {
                let dedupe_key = format!("sub:{sub_id}:tick:{revision}:{slot_key}");
                let event_id = format!("evt-{}", sha256_hex(&dedupe_key)[..16].to_owned());
                let payload = json!({
                    "scheduledAt": cursor,
                    "plannedAt": cursor,
                    "effectiveAt": effective_at,
                    "logicalSlotKey": slot_key,
                    "plannedWallTime": wall_time,
                    "scheduleRevision": revision,
                    "timezone": timezone,
                    "dstNormalized": normalized,
                    "continuousExecution": work.watch_rule.as_ref().and_then(|v| v.get("executionMode")).and_then(Value::as_str) == Some("continuous"),
                });
                tx.execute(
                    "INSERT OR IGNORE INTO work_events_inbox (
                       event_id, dedupe_key, source, source_event_id, event_type,
                       work_id, subscription_id, intent_revision, state_version, owner_epoch,
                       source_version, payload_json, status, merged_count, received_at, target_key, process_reason
                     ) VALUES (?, ?, 'cron', ?, 'work.tick', ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, 'schedule-tick')",
                    params![
                        event_id,
                        dedupe_key,
                        dedupe_key,
                        work_id,
                        sub_id,
                        work.intent_revision,
                        work.state_version,
                        work.owner_epoch,
                        cursor.to_string(),
                        serde_json::to_string(&payload)?,
                        now,
                        source_target
                    ],
                )?;
                tx.execute(
                    "UPDATE work_schedule_ticks SET status = 'dispatched', inbox_event_id = ? WHERE tick_id = ?",
                    params![event_id, tick_id],
                )?;
                available -= 1;
                fired_ticks.push(json!({
                    "subscriptionId": sub_id,
                    "workId": work_id,
                    "scheduledAt": cursor,
                    "logicalSlotKey": slot_key,
                    "inboxEventId": event_id,
                }));
                events.push(append_event(
                    tx,
                    core_gen,
                    core_gen,
                    "work",
                    "work.tick_fired",
                    &work_id,
                    work.state_version,
                    None,
                    &json!({ "subscriptionId": sub_id, "scheduledAt": cursor, "logicalSlotKey": slot_key }),
                )?);
            } else if inserted > 0 && let Some((merged_tick_id, prev_json)) = merged_into {
                let mut covered: Vec<String> = serde_json::from_str(&prev_json).unwrap_or_default();
                if !covered.contains(&slot_key) {
                    covered.push(slot_key);
                    covered.sort();
                }
                tx.execute(
                    "UPDATE work_schedule_ticks SET merged_from_slot_keys_json = ? WHERE tick_id = ?",
                    params![serde_json::to_string(&covered)?, merged_tick_id],
                )?;
            }
            let Some(next) = cron_expr
                .as_deref()
                .and_then(|expr| cron_next_wake(Some(expr), timezone.as_deref(), effective_at))
            else {
                cursor += 60_000;
                break;
            };
            if next <= cursor {
                cursor += 60_000;
                break;
            }
            cursor = next;
        }
        let next_wake_after = if cron_expr.is_some() { Some(cursor) } else { None };
        tx.execute(
            "UPDATE work_subscriptions SET next_wake_at = ?, last_checked_at = ?, updated_at = ? WHERE subscription_id = ?",
            params![next_wake_after, now, now, sub_id],
        )?;
        tx.execute(
            "UPDATE work_offline_gaps
             SET queryable = 1, state = 'recovered',
                 gap_reason = '已按策略恢复调度槽；业务来源需由后续检查读取', updated_at = ?
             WHERE subscription_id = ? AND state IN ('open', 'recovering', 'unqueryable')
               AND (? IS NULL OR offline_gap_to < ?)",
            params![now, sub_id, next_wake_after, next_wake_after],
        )?;
    }

    if let Some(cursor) = last_sub_id {
        tx.execute(
            "UPDATE work_watch_host_state SET last_scan_cursor = ? WHERE authority_id = ?",
            params![cursor, auth_id],
        )?;
    }

    // 3. Expire deadlines cleanly (paused keeps followed-up without inbox dispatch until resumed)
    let mut expired_deadlines = Vec::new();
    {
        let mut dl_stmt = tx.prepare(
            "SELECT w.work_id, w.lifecycle, w.deadline_revision, w.deadline_at, w.intent_revision, w.state_version, w.owner_epoch
             FROM works w
             LEFT JOIN work_deadline_instances d
               ON d.work_id = w.work_id AND d.deadline_revision = w.deadline_revision AND d.deadline_at = w.deadline_at
             WHERE w.lifecycle IN ('active', 'paused') AND w.deadline_at IS NOT NULL AND w.deadline_at <= ?
               AND (d.work_id IS NULL OR d.state = 'armed' OR (w.lifecycle = 'active' AND d.state = 'followed-up' AND d.inbox_event_id IS NULL))
             ORDER BY w.deadline_at ASC, w.work_id ASC LIMIT ?",
        )?;
        let dl_rows: Vec<(String, String, i64, i64, i64, i64, i64)> = dl_stmt
            .query_map(params![now, MAX_DEADLINES_PER_TICK as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(dl_stmt);
        for (wid, lifecycle, rev, at, irev, sver, oepoch) in dl_rows {
            tx.execute(
                "INSERT OR IGNORE INTO work_deadline_instances (work_id, deadline_revision, deadline_at, state, created_at)
                 VALUES (?, ?, ?, 'armed', ?)",
                params![wid, rev, at, now],
            )?;
            if lifecycle == "paused" {
                tx.execute(
                    "UPDATE work_deadline_instances SET state = 'followed-up', followed_at = ?
                     WHERE work_id = ? AND deadline_revision = ? AND deadline_at = ?",
                    params![now, wid, rev, at],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO work_blockers (
                       blocker_id, work_id, reason, kind, waiting_for_user_input, status, created_at, reason_code
                     ) VALUES (?, ?, '事项承诺期限已到，但事项处于暂停状态；保留到期事实，恢复后再决定跟进', 'operational', 0, 'open', ?, 'deadline-follow-up')",
                    params![format!("offline:{wid}:deadline-follow-up"), wid, now],
                )?;
            } else {
                let dedupe_key = format!("work:{wid}:deadline:{rev}:{at}");
                let event_id = format!("evt-{}", sha256_hex(&dedupe_key)[..16].to_owned());
                tx.execute(
                    "INSERT OR IGNORE INTO work_events_inbox (
                       event_id, dedupe_key, source, source_event_id, event_type,
                       work_id, intent_revision, state_version, owner_epoch,
                       payload_json, status, merged_count, received_at, batch_id, process_reason
                     ) VALUES (?, ?, 'system', ?, 'deadline_expired', ?, ?, ?, ?, ?, 'pending', 1, ?, ?, 'deadline-expired')",
                    params![
                        event_id,
                        dedupe_key,
                        dedupe_key,
                        wid,
                        irev,
                        sver,
                        oepoch,
                        serde_json::to_string(&json!({ "deadlineExpired": true, "readOnlyFollowUp": true, "deadlineRevision": rev, "deadlineAt": at }))?,
                        now,
                        format!("deadline:{wid}:{rev}:{at}")
                    ],
                )?;
                tx.execute(
                    "UPDATE work_deadline_instances SET state = 'followed-up', inbox_event_id = ?, followed_at = ?
                     WHERE work_id = ? AND deadline_revision = ? AND deadline_at = ?",
                    params![event_id, now, wid, rev, at],
                )?;
                tx.execute(
                    "UPDATE works SET state_version = state_version + 1, updated_at = ? WHERE work_id = ?",
                    params![now, wid],
                )?;
                expired_deadlines.push(wid);
            }
        }
    }

    // 4. Promote unblocked queued executions and reconcile crashed in-flight ones
    let promoted = promote_compatible_executions(tx, core_gen, tracker, events, dispatches)?;
    let recovered_unknown = scan_recovery_tx(tx, core_gen, now, events)?;

    Ok(json!({
        "ok": true,
        "status": "ok",
        "nowMs": now,
        "wallRolledBack": wall_rolled_back,
        "firedTicks": fired_ticks,
        "expiredWatchWorks": expired_watch_ids,
        "expiredDeadlines": expired_deadlines,
        "promotedDispatches": promoted,
        "reconciledUnknown": recovered_unknown,
    }))
}

/// Scans interrupted executions/bindings whose Core run is missing/terminated without settling.
/// Marks uncertain bindings as `unknown` + records external_effect blocker without blind replay!
fn scan_recovery_tx(
    tx: &Connection,
    core_gen: &str,
    now: i64,
    events: &mut Vec<EmittedEvent>,
) -> crate::Result<Vec<String>> {
    // Only mark stale when a `core_execution_runs` entry is explicitly terminal `'unknown'` or
    // its linked binding stayed `'submitted'`/`'running'` under an older `core_generation` run
    // no longer active (`executor_epoch` disconnected). Never invent a new operationId!
    let mut stmt = tx.prepare(
        "SELECT b.binding_id, b.work_id, b.bot_id, b.status
         FROM work_execution_bindings b
         JOIN core_execution_runs r ON json_extract(r.payload_json, '$.bindingId') = b.binding_id
         WHERE b.invalidated_at IS NULL
           AND b.status IN ('submitted', 'running')
           AND r.status = 'unknown'",
    )?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut reconciled = Vec::new();
    for (binding_id, work_id, _bot_id, _status) in rows {
        settle_binding_tx(
            tx,
            core_gen,
            &binding_id,
            Some(&work_id),
            "unknown",
            None,
            Some("interrupted execution recovered as unknown; manual or readback verification required"),
            None,
            None,
            None,
            None,
            None,
            now,
            events,
        )?;
        reconciled.push(binding_id);
    }
    Ok(reconciled)
}

// =========================================================================
// Public Entrypoints
// =========================================================================

pub fn execute_read(db: &Connection, command: Command) -> crate::Result<Value> {
    let core_gen = current_core_generation();
    match command {
        Command::GetWork { work_id } => {
            let work = fetch_work(db, &work_id)?;
            let bindings: Vec<Value> = db
                .prepare(
                    "SELECT binding_id, operation_id, bot_id, task_id, intent_revision, owner_epoch,
                            input_snapshot_id, status, attempt_id, settlement_note, admitted_at, settled_at
                     FROM work_execution_bindings WHERE work_id = ? ORDER BY admitted_at ASC",
                )?
                .query_map(params![work_id], |r| {
                    Ok(json!({
                        "bindingId": r.get::<_, String>(0)?,
                        "operationId": r.get::<_, String>(1)?,
                        "botId": r.get::<_, String>(2)?,
                        "taskId": r.get::<_, String>(3)?,
                        "intentRevision": r.get::<_, i64>(4)?,
                        "ownerEpoch": r.get::<_, i64>(5)?,
                        "inputSnapshotId": r.get::<_, String>(6)?,
                        "status": r.get::<_, String>(7)?,
                        "attemptId": r.get::<_, Option<String>>(8)?,
                        "settlementNote": r.get::<_, Option<String>>(9)?,
                        "admittedAt": r.get::<_, i64>(10)?,
                        "settledAt": r.get::<_, Option<i64>>(11)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let deliverables: Vec<Value> = db
                .prepare(
                    "SELECT deliverable_id, execution_id, status, summary, uncovered_scope_json, created_at, reviewed_at
                     FROM work_deliverables WHERE work_id = ? ORDER BY created_at ASC",
                )?
                .query_map(params![work_id], |r| {
                    let uncov: String = r.get(4)?;
                    Ok(json!({
                        "deliverableId": r.get::<_, String>(0)?,
                        "executionId": r.get::<_, String>(1)?,
                        "status": r.get::<_, String>(2)?,
                        "summary": r.get::<_, String>(3)?,
                        "uncoveredScope": serde_json::from_str::<Value>(&uncov).unwrap_or_else(|_| json!([])),
                        "createdAt": r.get::<_, i64>(5)?,
                        "reviewedAt": r.get::<_, Option<i64>>(6)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let dispatches: Vec<Value> = db
                .prepare(
                    "SELECT operation_id, task_id, bot_id, intent_revision, state, error, attempts, created_at
                     FROM work_dispatch_requests WHERE work_id = ? ORDER BY created_at ASC",
                )?
                .query_map(params![work_id], |r| {
                    Ok(json!({
                        "operationId": r.get::<_, String>(0)?,
                        "taskId": r.get::<_, String>(1)?,
                        "botId": r.get::<_, String>(2)?,
                        "intentRevision": r.get::<_, i64>(3)?,
                        "state": r.get::<_, String>(4)?,
                        "error": r.get::<_, Option<String>>(5)?,
                        "attempts": r.get::<_, i64>(6)?,
                        "createdAt": r.get::<_, i64>(7)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let blockers: Vec<Value> = db
                .prepare(
                    "SELECT blocker_id, kind, reason, reason_code, status, unknown_external_effect_ref
                     FROM work_blockers WHERE work_id = ? ORDER BY created_at ASC",
                )?
                .query_map(params![work_id], |r| {
                    Ok(json!({
                        "blockerId": r.get::<_, String>(0)?,
                        "kind": r.get::<_, String>(1)?,
                        "reason": r.get::<_, String>(2)?,
                        "reasonCode": r.get::<_, Option<String>>(3)?,
                        "status": r.get::<_, String>(4)?,
                        "unknownExternalEffectRef": r.get::<_, Option<String>>(5)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let archived_at: Option<i64> = db
                .query_row(
                    "SELECT archived_at FROM work_record_archive WHERE work_id = ?",
                    params![work_id],
                    |r| r.get(0),
                )
                .optional()?;
            let recoveries: Vec<Value> = db
                .prepare(
                    "SELECT r.source_binding_id, r.plan_id, r.fingerprint, r.mode, r.created_at
                     FROM work_automatic_recovery r
                     JOIN work_execution_bindings b ON b.binding_id = r.source_binding_id
                     WHERE b.work_id = ?",
                )?
                .query_map(params![work_id], |r| {
                    Ok(json!({
                        "sourceBindingId": r.get::<_, String>(0)?,
                        "planId": r.get::<_, String>(1)?,
                        "fingerprint": r.get::<_, String>(2)?,
                        "mode": r.get::<_, String>(3)?,
                        "createdAt": r.get::<_, i64>(4)?,
                    }))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(json!({
                "ok": true,
                "status": if work.is_some() { "ok" } else { "not_found" },
                "coreGeneration": core_gen,
                "work": work,
                "archivedAt": archived_at,
                "bindings": bindings,
                "deliverables": deliverables,
                "dispatches": dispatches,
                "blockers": blockers,
                "recoveries": recoveries,
            }))
        }
        Command::ListWorks { user_id } => {
            let mut sql = "SELECT work_id FROM works".to_owned();
            if user_id.is_some() {
                sql.push_str(" WHERE user_id = ?1");
            }
            sql.push_str(" ORDER BY updated_at DESC LIMIT 200");
            let mut stmt = db.prepare(&sql)?;
            let ids: Vec<String> = match user_id.as_deref() {
                Some(uid) => stmt
                    .query_map(params![uid], |r| r.get(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?,
                None => stmt
                    .query_map([], |r| r.get(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?,
            };
            let mut works = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(w) = fetch_work(db, &id)? {
                    works.push(w);
                }
            }
            Ok(json!({ "ok": true, "coreGeneration": core_gen, "works": works }))
        }
        Command::GetExecutionQueue => {
            if !crate::business_protocol::table_exists(db, "core_execution_runs")? {
                return Ok(json!({ "ok": true, "coreGeneration": core_gen, "runs": [] }));
            }
            let mut stmt = db.prepare(
                "SELECT execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                        task_id, kind, payload_json, status, revision, executor_client_id, executor_epoch, attempt,
                        result_json, error_message, created_at_ms, updated_at_ms
                 FROM core_execution_runs ORDER BY created_at_ms ASC LIMIT 256",
            )?;
            let runs = stmt
                .query_map([], crate::business_protocol::row_to_execution_pub)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(json!({ "ok": true, "coreGeneration": core_gen, "runs": runs }))
        }
        Command::OwnerStatus {
            owner_id,
            lease_ttl_ms,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let ttl = lease_ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS);
            let row: Option<(String, i64, i64, Option<i64>)> = db
                .query_row(
                    "SELECT authority_id, acquired_at, heartbeat_at, released_at FROM work_host_lease WHERE lease_id='singleton'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            let is_owner = row.as_ref().is_some_and(|(holder, _, hb, rel)| {
                rel.is_none()
                    && now.saturating_sub(*hb) < ttl
                    && owner_id.as_deref().is_none_or(|o| o == holder)
            });
            Ok(json!({
                "ok": true,
                "coreGeneration": core_gen,
                "isOwner": is_owner,
                "holderAuthorityId": row.as_ref().map(|r| r.0.clone()),
                "acquiredAt": row.as_ref().map(|r| r.1),
                "heartbeatAt": row.as_ref().map(|r| r.2),
                "releasedAt": row.and_then(|r| r.3),
            }))
        }
        _ => Err("execute_read called with mutating work_scheduler command".into()),
    }
}

pub fn execute_write(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    client: &ClientContext,
    command: Command,
) -> crate::Result<WriteSideEffects> {
    let core_gen = current_core_generation();
    ensure_tables(db, &core_gen)?;
    match command {
        Command::OwnerAcquire {
            owner_id,
            lease_ttl_ms,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let ttl = lease_ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let prev: Option<(String, i64, i64, Option<i64>)> = tx
                .query_row(
                    "SELECT authority_id, acquired_at, heartbeat_at, released_at FROM work_host_lease WHERE lease_id='singleton'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            let live = prev
                .as_ref()
                .is_some_and(|(_, _, hb, rel)| rel.is_none() && now.saturating_sub(*hb) < ttl);
            let ours = prev.as_ref().is_some_and(|(h, _, _, _)| h == &owner_id);
            if live && !ours {
                let holder = prev.as_ref().map(|r| r.0.clone());
                return Ok(WriteSideEffects {
                    data: json!({
                        "ok": false,
                        "status": "rejected",
                        "code": "OWNER_CONFLICT",
                        "holderAuthorityId": holder,
                        "ownerId": owner_id,
                    }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let acquired_at = prev.as_ref().map_or(now, |(_, prev_acq, _, _)| {
                if ours && live {
                    *prev_acq
                } else {
                    now.max(prev_acq.saturating_add(1))
                }
            });
            tx.execute(
                "INSERT INTO work_host_lease (lease_id, authority_id, acquired_at, heartbeat_at, released_at)
                 VALUES ('singleton', ?, ?, ?, NULL)
                 ON CONFLICT(lease_id) DO UPDATE SET
                   authority_id = excluded.authority_id,
                   acquired_at = excluded.acquired_at,
                   heartbeat_at = excluded.heartbeat_at,
                   released_at = NULL",
                params![owner_id, acquired_at, now],
            )?;
            // Bump all active works' owner_epoch monotonically when a new authority takes over
            if !ours || !live {
                tx.execute(
                    "UPDATE works SET owner_epoch = owner_epoch + 1, updated_at = ? WHERE lifecycle != 'closed'",
                    params![now],
                )?;
            }
            let mut events = vec![append_event(
                &tx,
                &core_gen,
                &core_gen,
                "workScheduler",
                "workScheduler.owner_acquired",
                &owner_id,
                acquired_at,
                None,
                &json!({ "ownerId": owner_id, "acquiredAt": acquired_at }),
            )?];
            let recovered = scan_recovery_tx(&tx, &core_gen, now, &mut events)?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({
                    "ok": true,
                    "status": "acquired",
                    "ownerId": owner_id,
                    "holderAuthorityId": owner_id,
                    "acquiredAt": acquired_at,
                    "heartbeatAt": now,
                    "recoveredBindings": recovered,
                }),
                events,
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        Command::OwnerHeartbeat {
            owner_id,
            lease_ttl_ms,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let ttl = lease_ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) = check_owner_lease_write(&tx, Some(&owner_id), now, ttl)? {
                return Ok(rej);
            }
            tx.execute(
                "UPDATE work_host_lease SET heartbeat_at = ? WHERE lease_id = 'singleton' AND authority_id = ?",
                params![now, owner_id],
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({ "ok": true, "ownerId": owner_id, "heartbeatAt": now }),
                events: vec![],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        Command::OwnerRelease {
            owner_id,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let updated = tx.execute(
                "UPDATE work_host_lease SET released_at = ? WHERE lease_id = 'singleton' AND authority_id = ?",
                params![now, owner_id],
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({ "ok": updated > 0, "ownerId": owner_id, "releasedAt": now }),
                events: vec![],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        Command::CreateWork {
            operation_id,
            user_id,
            work_id,
            title,
            goal_description,
            mode,
            watch_rule,
            owner_bot_id,
            criteria,
            input_snapshot_id,
            deadline_at,
            authorization,
            workspace_path,
            owner_id,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) =
                check_owner_lease_write(&tx, owner_id.as_deref(), now, DEFAULT_LEASE_TTL_MS)?
            {
                return Ok(rej);
            }
            let payload_hash = sha256_hex(&format!("create:{user_id}:{operation_id}:{title}"));
            if let Some(replay) = check_receipt(&tx, &user_id, &operation_id, &payload_hash)? {
                return Ok(replay);
            }
            let wid = work_id
                .unwrap_or_else(|| format!("work-{}", sha256_hex(&format!("{user_id}:{operation_id}"))[..16].to_owned()));
            let bot_id = owner_bot_id.unwrap_or_else(|| "default".to_owned());
            ensure_bot_exists(&tx, &user_id, &bot_id, now)?;
            let work_mode = mode.unwrap_or_else(|| "once".to_owned());
            let snap_id = input_snapshot_id.unwrap_or_else(|| format!("snap:{operation_id}"));
            let intent_snap = format!("intent:{wid}:1");
            let criteria_json = serde_json::to_string(&criteria.unwrap_or_default())?;
            let auth_json = serde_json::to_string(&authorization.unwrap_or_else(|| {
                json!({ "allowedScopes": ["workspace:read", "workspace:write"], "targetWhitelist": [] })
            }))?;
            let watch_json = watch_rule.map(|v| serde_json::to_string(&v)).transpose()?;
            tx.execute(
                "INSERT INTO works (
                   work_id, user_id, workspace_path, owner_bot_id, owner_epoch,
                   intent_revision, source_version, title, goal_description,
                   constraints_json, criteria_json, authorization_json,
                   active_intent_snapshot_id, input_snapshot_id, goal_sources_json,
                   mode, lifecycle, accepted_deliverable_ids_json, active_execution_ids_json,
                   watch_rule_json, state_version, created_by, created_at, updated_at,
                   deadline_at, deadline_revision
                 ) VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?, '[]', ?, ?, ?, ?, '[]', ?, 'active', '[]', '[]', ?, 1, 'user', ?, ?, ?, 1)",
                params![
                    wid,
                    user_id,
                    workspace_path,
                    bot_id,
                    title,
                    goal_description,
                    criteria_json,
                    auth_json,
                    intent_snap,
                    snap_id,
                    work_mode,
                    watch_json,
                    now,
                    now,
                    deadline_at
                ],
            )?;
            let work = fetch_work(&tx, &wid)?.unwrap();
            let outbox_id = insert_outbox(
                &tx,
                &work,
                "work.created",
                &operation_id,
                None,
                &json!({ "workId": wid, "title": title, "mode": work_mode }),
                now,
            )?;
            let ev = append_event(
                &tx,
                &core_gen,
                &core_gen,
                "work",
                "work.created",
                &wid,
                work.state_version,
                Some(&operation_id),
                &json!({ "workId": wid, "title": title, "mode": work_mode, "ownerEpoch": work.owner_epoch }),
            )?;
            let reply = json!({
                "ok": true,
                "replayed": false,
                "operationId": operation_id,
                "outboxEventId": outbox_id,
                "work": work,
            });
            save_receipt(
                &tx,
                &user_id,
                &operation_id,
                &wid,
                "createWork",
                &payload_hash,
                &reply,
                Some(&outbox_id),
                now,
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: reply,
                events: vec![ev],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        Command::AmendWork {
            operation_id,
            user_id,
            work_id,
            title,
            goal_description,
            criteria,
            input_snapshot_id,
            expected_state_version,
            expected_intent_revision,
            expected_owner_epoch,
            owner_id,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) =
                check_owner_lease_write(&tx, owner_id.as_deref(), now, DEFAULT_LEASE_TTL_MS)?
            {
                return Ok(rej);
            }
            let payload_hash = sha256_hex(&format!(
                "amend:{work_id}:{operation_id}:{expected_state_version}:{expected_intent_revision}"
            ));
            if let Some(replay) = check_receipt(&tx, &user_id, &operation_id, &payload_hash)? {
                return Ok(replay);
            }
            let Some(work) = fetch_work(&tx, &work_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            if work.lifecycle == "closed" || work.lifecycle == "closing" {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "INVALID_LIFECYCLE", "lifecycle": work.lifecycle }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if let Some(rej) = check_version_guard(
                &work,
                Some(expected_state_version),
                Some(expected_intent_revision),
                Some(expected_owner_epoch),
            ) {
                return Ok(rej);
            }
            let next_intent = work.intent_revision + 1;
            let next_state = work.state_version + 1;
            let next_title = title.unwrap_or(work.title.clone());
            let next_goal = goal_description.or(work.goal_description.clone());
            let next_criteria = criteria
                .map(|c| serde_json::to_string(&c))
                .transpose()?
                .unwrap_or_else(|| serde_json::to_string(&work.criteria).unwrap());
            let next_snap = input_snapshot_id.unwrap_or(work.input_snapshot_id.clone());
            tx.execute(
                "UPDATE works
                 SET title = ?, goal_description = ?, criteria_json = ?, input_snapshot_id = ?,
                     intent_revision = ?, state_version = ?, updated_at = ?
                 WHERE work_id = ?",
                params![
                    next_title,
                    next_goal,
                    next_criteria,
                    next_snap,
                    next_intent,
                    next_state,
                    now,
                    work_id
                ],
            )?;
            // Invalidate only not-yet-running pending bindings of superseded intent
            tx.execute(
                "UPDATE work_execution_bindings SET status = 'invalidated', invalidated_at = COALESCE(invalidated_at, ?)
                 WHERE work_id = ? AND intent_revision < ? AND status = 'pending'",
                params![now, work_id, next_intent],
            )?;
            let updated = fetch_work(&tx, &work_id)?.unwrap();
            let outbox_id = insert_outbox(
                &tx,
                &updated,
                "work.amended",
                &operation_id,
                None,
                &json!({ "workId": work_id, "intentRevision": next_intent }),
                now,
            )?;
            let ev = append_event(
                &tx,
                &core_gen,
                &core_gen,
                "work",
                "work.amended",
                &work_id,
                next_state,
                Some(&operation_id),
                &json!({ "workId": work_id, "intentRevision": next_intent, "stateVersion": next_state }),
            )?;
            let reply = json!({
                "ok": true,
                "replayed": false,
                "operationId": operation_id,
                "outboxEventId": outbox_id,
                "work": updated,
            });
            save_receipt(
                &tx,
                &user_id,
                &operation_id,
                &work_id,
                "amendWork",
                &payload_hash,
                &reply,
                Some(&outbox_id),
                now,
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: reply,
                events: vec![ev],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        Command::PauseWork {
            operation_id,
            user_id,
            work_id,
            expected_state_version,
            expected_intent_revision,
            expected_owner_epoch,
            owner_id,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) =
                check_owner_lease_write(&tx, owner_id.as_deref(), now, DEFAULT_LEASE_TTL_MS)?
            {
                return Ok(rej);
            }
            let payload_hash = sha256_hex(&format!("pause:{work_id}:{operation_id}"));
            if let Some(replay) = check_receipt(&tx, &user_id, &operation_id, &payload_hash)? {
                return Ok(replay);
            }
            let Some(work) = fetch_work(&tx, &work_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            if work.lifecycle != "active" {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "INVALID_LIFECYCLE", "lifecycle": work.lifecycle }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if let Some(rej) = check_version_guard(
                &work,
                expected_state_version,
                expected_intent_revision,
                expected_owner_epoch,
            ) {
                return Ok(rej);
            }
            let next_ver = work.state_version + 1;
            tx.execute(
                "UPDATE works SET lifecycle = 'paused', state_version = ?, updated_at = ? WHERE work_id = ?",
                params![next_ver, now, work_id],
            )?;
            let updated = fetch_work(&tx, &work_id)?.unwrap();
            let outbox_id = insert_outbox(
                &tx,
                &updated,
                "work.paused",
                &operation_id,
                None,
                &json!({ "workId": work_id }),
                now,
            )?;
            let ev = append_event(
                &tx,
                &core_gen,
                &core_gen,
                "work",
                "work.paused",
                &work_id,
                next_ver,
                Some(&operation_id),
                &json!({ "workId": work_id, "lifecycle": "paused" }),
            )?;
            let reply = json!({
                "ok": true,
                "replayed": false,
                "operationId": operation_id,
                "outboxEventId": outbox_id,
                "work": updated,
            });
            save_receipt(
                &tx,
                &user_id,
                &operation_id,
                &work_id,
                "pauseWork",
                &payload_hash,
                &reply,
                Some(&outbox_id),
                now,
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: reply,
                events: vec![ev],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        Command::ResumeWork {
            operation_id,
            user_id,
            work_id,
            expected_state_version,
            expected_intent_revision,
            expected_owner_epoch,
            owner_id,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) =
                check_owner_lease_write(&tx, owner_id.as_deref(), now, DEFAULT_LEASE_TTL_MS)?
            {
                return Ok(rej);
            }
            let payload_hash = sha256_hex(&format!("resume:{work_id}:{operation_id}"));
            if let Some(replay) = check_receipt(&tx, &user_id, &operation_id, &payload_hash)? {
                return Ok(replay);
            }
            let Some(work) = fetch_work(&tx, &work_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            if work.lifecycle != "paused" {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "INVALID_LIFECYCLE", "lifecycle": work.lifecycle }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if let Some(rej) = check_version_guard(
                &work,
                expected_state_version,
                expected_intent_revision,
                expected_owner_epoch,
            ) {
                return Ok(rej);
            }
            let next_ver = work.state_version + 1;
            tx.execute(
                "UPDATE works SET lifecycle = 'active', state_version = ?, updated_at = ? WHERE work_id = ?",
                params![next_ver, now, work_id],
            )?;
            // Re-arm paused deadline follow-up without inbox dispatch so the next tick emits 1 follow-up
            tx.execute(
                "UPDATE work_deadline_instances SET inbox_event_id = NULL WHERE work_id = ? AND state = 'followed-up' AND inbox_event_id IS NULL",
                params![work_id],
            )?;
            let updated = fetch_work(&tx, &work_id)?.unwrap();
            let outbox_id = insert_outbox(
                &tx,
                &updated,
                "work.resumed",
                &operation_id,
                None,
                &json!({ "workId": work_id }),
                now,
            )?;
            let mut events = vec![append_event(
                &tx,
                &core_gen,
                &core_gen,
                "work",
                "work.resumed",
                &work_id,
                next_ver,
                Some(&operation_id),
                &json!({ "workId": work_id, "lifecycle": "active" }),
            )?];
            let mut dispatches = vec![];
            promote_compatible_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            let reply = json!({
                "ok": true,
                "replayed": false,
                "operationId": operation_id,
                "outboxEventId": outbox_id,
                "work": updated,
            });
            save_receipt(
                &tx,
                &user_id,
                &operation_id,
                &work_id,
                "resumeWork",
                &payload_hash,
                &reply,
                Some(&outbox_id),
                now,
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: reply,
                events,
                dispatches,
                shutdown_after_reply: false,
            })
        }
        Command::CancelWork {
            operation_id,
            user_id,
            work_id,
            summary,
            expected_state_version,
            expected_intent_revision,
            expected_owner_epoch,
            owner_id,
            now_ms: supplied_now,
        } => {
            transition_close_tx(
                db,
                tracker,
                &core_gen,
                client,
                &operation_id,
                &user_id,
                &work_id,
                "cancelled",
                summary,
                expected_state_version,
                expected_intent_revision,
                expected_owner_epoch,
                owner_id.as_deref(),
                supplied_now,
            )
        }
        Command::CloseWork {
            operation_id,
            user_id,
            work_id,
            conclusion,
            summary,
            expected_state_version,
            expected_intent_revision,
            expected_owner_epoch,
            owner_id,
            now_ms: supplied_now,
        } => {
            if !matches!(
                conclusion.as_str(),
                "succeeded" | "cancelled" | "ended_unsuccessfully"
            ) {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "INVALID_CONCLUSION" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            transition_close_tx(
                db,
                tracker,
                &core_gen,
                client,
                &operation_id,
                &user_id,
                &work_id,
                &conclusion,
                summary,
                expected_state_version,
                expected_intent_revision,
                expected_owner_epoch,
                owner_id.as_deref(),
                supplied_now,
            )
        }
        Command::ArchiveWork {
            work_id,
            owner_id,
            archived_at,
        } => {
            let now = archived_at.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) =
                check_owner_lease_write(&tx, owner_id.as_deref(), now, DEFAULT_LEASE_TTL_MS)?
            {
                return Ok(rej);
            }
            let Some(work) = fetch_work(&tx, &work_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            let unsettled: i64 = tx.query_row(
                "SELECT COUNT(*) FROM work_execution_bindings
                 WHERE work_id = ? AND invalidated_at IS NULL AND status IN ('pending', 'submitted', 'running', 'unknown')",
                params![work_id],
                |r| r.get(0),
            )?;
            let has_settled_failure: i64 = tx.query_row(
                "SELECT COUNT(*) FROM work_execution_bindings WHERE work_id = ? AND invalidated_at IS NULL AND status IN ('failed', 'stopped')",
                params![work_id],
                |r| r.get(0),
            )?;
            if unsettled > 0 || (work.lifecycle != "closed" && (work.mode == "watch" || has_settled_failure == 0)) {
                return Ok(WriteSideEffects {
                    data: json!({
                        "ok": false,
                        "status": "rejected",
                        "code": "ARCHIVE_NOT_ALLOWED",
                        "lifecycle": work.lifecycle,
                        "unsettledBindings": unsettled,
                    }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            tx.execute(
                "INSERT OR IGNORE INTO work_record_archive (work_id, archived_at) VALUES (?, ?)",
                params![work_id, now],
            )?;
            let ev = append_event(
                &tx,
                &core_gen,
                &core_gen,
                "work",
                "work.archived",
                &work_id,
                work.state_version,
                None,
                &json!({ "workId": work_id, "archivedAt": now }),
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({ "ok": true, "workId": work_id, "archivedAt": now }),
                events: vec![ev],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        Command::ConfigureSubscription {
            operation_id,
            user_id,
            work_id,
            subscription_id,
            source,
            source_target,
            catch_up_policy,
            cron_expression,
            timezone,
            next_wake_at,
            max_merge_wait_ms,
            max_queue_depth,
            owner_id,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) =
                check_owner_lease_write(&tx, owner_id.as_deref(), now, DEFAULT_LEASE_TTL_MS)?
            {
                return Ok(rej);
            }
            let payload_hash =
                sha256_hex(&format!("sub:{work_id}:{operation_id}:{source}"));
            if let Some(replay) = check_receipt(&tx, &user_id, &operation_id, &payload_hash)? {
                return Ok(replay);
            }
            let Some(work) = fetch_work(&tx, &work_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            let sub_id = subscription_id
                .unwrap_or_else(|| format!("sub-{}", sha256_hex(&format!("{work_id}:{operation_id}"))[..16].to_owned()));
            let policy = catch_up_policy.unwrap_or_else(|| "each".to_owned());
            let computed_next = next_wake_at
                .or_else(|| cron_next_wake(cron_expression.as_deref(), timezone.as_deref(), now));
            tx.execute(
                "INSERT INTO work_subscriptions (
                   subscription_id, work_id, source, catch_up_policy, max_merge_wait_ms,
                   max_queue_depth, timezone, cron_expression, next_wake_at,
                   created_at, updated_at, source_target
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(subscription_id) DO UPDATE SET
                   catch_up_policy = excluded.catch_up_policy,
                   cron_expression = excluded.cron_expression,
                   timezone = excluded.timezone,
                   next_wake_at = excluded.next_wake_at,
                   schedule_revision = work_subscriptions.schedule_revision + 1,
                   config_revision = work_subscriptions.config_revision + 1,
                   updated_at = excluded.updated_at",
                params![
                    sub_id,
                    work_id,
                    source,
                    policy,
                    max_merge_wait_ms.unwrap_or(100),
                    max_queue_depth.unwrap_or(64),
                    timezone,
                    cron_expression,
                    computed_next,
                    now,
                    now,
                    source_target
                ],
            )?;
            let ev = append_event(
                &tx,
                &core_gen,
                &core_gen,
                "work",
                "work.subscription_configured",
                &work_id,
                work.state_version,
                Some(&operation_id),
                &json!({ "workId": work_id, "subscriptionId": sub_id, "nextWakeAt": computed_next }),
            )?;
            let reply = json!({
                "ok": true,
                "replayed": false,
                "workId": work_id,
                "subscriptionId": sub_id,
                "nextWakeAt": computed_next,
            });
            save_receipt(
                &tx,
                &user_id,
                &operation_id,
                &work_id,
                "configureSubscription",
                &payload_hash,
                &reply,
                None,
                now,
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: reply,
                events: vec![ev],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        Command::DispatchExecution {
            operation_id,
            user_id,
            work_id,
            binding_id,
            execution_id,
            task_id,
            bot_id,
            kind,
            resource_key,
            lock_mode,
            allow_concurrent_same_work,
            payload,
            inbox_event_id,
            expected_state_version,
            expected_intent_revision,
            expected_owner_epoch,
            owner_id,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) =
                check_owner_lease_write(&tx, owner_id.as_deref(), now, DEFAULT_LEASE_TTL_MS)?
            {
                return Ok(rej);
            }
            let Some(work) = fetch_work(&tx, &work_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            let uid = user_id.unwrap_or_else(|| work.user_id.clone());
            let payload_hash = sha256_hex(&format!("dispatch:{work_id}:{operation_id}"));
            if let Some(replay) = check_receipt(&tx, &uid, &operation_id, &payload_hash)? {
                return Ok(replay);
            }
            if work.lifecycle != "active" {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "INVALID_LIFECYCLE", "lifecycle": work.lifecycle }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            if let Some(rej) = check_version_guard(
                &work,
                expected_state_version,
                expected_intent_revision,
                expected_owner_epoch,
            ) {
                return Ok(rej);
            }

            let bind_id = binding_id
                .unwrap_or_else(|| format!("bind-{}", sha256_hex(&format!("{work_id}:{operation_id}"))[..16].to_owned()));
            let exec_id = execution_id
                .unwrap_or_else(|| format!("exec-{}", sha256_hex(&format!("{work_id}:{operation_id}"))[..16].to_owned()));
            let t_id = task_id
                .unwrap_or_else(|| format!("task-{}", sha256_hex(&format!("{work_id}:{operation_id}"))[..16].to_owned()));
            let b_id = bot_id.unwrap_or_else(|| work.owner_bot_id.clone());
            let exec_kind = kind.unwrap_or_else(|| "work_execution".to_owned());

            tx.execute(
                "INSERT OR IGNORE INTO work_execution_bindings (
                   binding_id, work_id, operation_id, bot_id, task_id, durable_store_key,
                   conversation_id, intent_revision, owner_epoch, input_snapshot_id,
                   expert_snapshot_json, delegated_scope_json, workspace_binding,
                   status, admitted_at, inbox_event_id
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, 'pending', ?, ?)",
                params![
                    bind_id,
                    work_id,
                    operation_id,
                    b_id,
                    t_id,
                    format!("durable:{t_id}"),
                    t_id,
                    work.intent_revision,
                    work.owner_epoch,
                    work.input_snapshot_id,
                    resource_key.as_deref().or(work.workspace_path.as_deref()).unwrap_or(""),
                    now,
                    inbox_event_id
                ],
            )?;

            let mut enriched_payload = payload.unwrap_or_else(|| json!({}));
            if let Some(obj) = enriched_payload.as_object_mut() {
                obj.insert("workId".into(), Value::String(work_id.clone()));
                obj.insert("bindingId".into(), Value::String(bind_id.clone()));
                obj.insert("operationId".into(), Value::String(operation_id.clone()));
                obj.insert("intentRevision".into(), json!(work.intent_revision));
                obj.insert("ownerEpoch".into(), json!(work.owner_epoch));
                if let Some(rk) = resource_key.as_ref() {
                    obj.insert("resourceKey".into(), Value::String(rk.clone()));
                }
                if let Some(lm) = lock_mode.as_ref() {
                    obj.insert("lockMode".into(), Value::String(lm.clone()));
                }
                if let Some(ac) = allow_concurrent_same_work {
                    obj.insert("allowConcurrentSameWork".into(), Value::Bool(ac));
                }
            }

            let conflict = has_active_conflict(&tx, &exec_id, &enriched_payload)?;
            tx.execute(
                "INSERT OR IGNORE INTO work_dispatch_requests (
                   operation_id, work_id, task_id, bot_id, intent_revision,
                   input_snapshot_id, state, error, attempts, created_at, inbox_event_id
                 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)",
                params![
                    operation_id,
                    work_id,
                    t_id,
                    b_id,
                    work.intent_revision,
                    work.input_snapshot_id,
                    conflict.as_deref().map(|c| format!("queued_conflict:{c}")),
                    now,
                    inbox_event_id
                ],
            )?;

            let initial_status = if tracker.is_online().is_some() {
                "queued"
            } else {
                "waiting_executor"
            };
            let idemp_key = format!("work:{work_id}:{operation_id}");
            tx.execute(
                "INSERT OR IGNORE INTO core_execution_runs (
                   execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                   task_id, kind, payload_json, status, revision, created_at_ms, updated_at_ms
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                params![
                    exec_id,
                    idemp_key,
                    core_gen,
                    client.role,
                    client.client_id,
                    client.epoch as i64,
                    t_id,
                    exec_kind,
                    serde_json::to_string(&enriched_payload)?,
                    initial_status,
                    now,
                    now
                ],
            )?;

            let mut events = vec![];
            let mut dispatches = vec![];
            promote_compatible_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            let run_row = crate::business_protocol::fetch_execution_tx(&tx, &exec_id)?;
            let run_status = run_row
                .as_ref()
                .map(|r| r.status.clone())
                .unwrap_or_else(|| initial_status.to_owned());
            let conflict_queued = conflict.is_some() && run_status != "dispatching" && run_status != "running";

            let reply = json!({
                "ok": true,
                "replayed": false,
                "workId": work_id,
                "bindingId": bind_id,
                "executionId": exec_id,
                "taskId": t_id,
                "conflictQueued": conflict_queued,
                "conflictReason": conflict,
                "execution": run_row,
            });
            save_receipt(
                &tx,
                &uid,
                &operation_id,
                &work_id,
                "dispatchExecution",
                &payload_hash,
                &reply,
                None,
                now,
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: reply,
                events,
                dispatches,
                shutdown_after_reply: false,
            })
        }
        Command::SettleExecution {
            binding_id,
            work_id,
            outcome,
            result,
            error_message,
            deliverable,
            subitems,
            owner_epoch,
            intent_revision,
            input_snapshot_id,
            owner_id: _owner_id,
            now_ms: supplied_now,
        } => {
            // Note: Legitimate in-flight settlements match their original `(bindingId, ownerEpoch, intentRevision, inputSnapshotId)`
            // identity even across Work host restarts or ownership transitions (`RC-11` / `RC-13`)!
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut events = vec![];
            let data = settle_binding_tx(
                &tx,
                &core_gen,
                &binding_id,
                work_id.as_deref(),
                &outcome,
                result.as_ref(),
                error_message.as_deref(),
                deliverable.as_ref(),
                subitems.as_ref(),
                owner_epoch,
                intent_revision,
                input_snapshot_id.as_deref(),
                now,
                &mut events,
            )?;
            let mut dispatches = vec![];
            if data.get("ok").and_then(Value::as_bool) == Some(true) {
                promote_compatible_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            }
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data,
                events,
                dispatches,
                shutdown_after_reply: false,
            })
        }
        Command::AcceptDeliverable {
            operation_id,
            user_id,
            work_id,
            deliverable_id,
            accepted,
            rejected_reason,
            owner_id,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) =
                check_owner_lease_write(&tx, owner_id.as_deref(), now, DEFAULT_LEASE_TTL_MS)?
            {
                return Ok(rej);
            }
            let payload_hash =
                sha256_hex(&format!("acceptDeliv:{work_id}:{deliverable_id}:{accepted}"));
            if let Some(replay) = check_receipt(&tx, &user_id, &operation_id, &payload_hash)? {
                return Ok(replay);
            }
            let Some(work) = fetch_work(&tx, &work_id)? else {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            };
            let next_status = if accepted { "accepted" } else { "rejected" };
            let updated_rows = tx.execute(
                "UPDATE work_deliverables SET status = ?, rejected_reason = ?, reviewed_at = ?
                 WHERE deliverable_id = ? AND work_id = ?",
                params![next_status, rejected_reason, now, deliverable_id, work_id],
            )?;
            if updated_rows == 0 {
                return Ok(WriteSideEffects {
                    data: json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND" }),
                    events: vec![],
                    dispatches: vec![],
                    shutdown_after_reply: false,
                });
            }
            let mut accepted_ids: Vec<String> =
                serde_json::from_value(work.accepted_deliverable_ids.clone()).unwrap_or_default();
            if accepted && !accepted_ids.contains(&deliverable_id) {
                accepted_ids.push(deliverable_id.clone());
            }
            let next_ver = work.state_version + 1;
            tx.execute(
                "UPDATE works SET accepted_deliverable_ids_json = ?, state_version = ?, updated_at = ? WHERE work_id = ?",
                params![serde_json::to_string(&accepted_ids)?, next_ver, now, work_id],
            )?;
            let updated_work = fetch_work(&tx, &work_id)?.unwrap();
            let ev = append_event(
                &tx,
                &core_gen,
                &core_gen,
                "work",
                if accepted { "work.deliverable_accepted" } else { "work.deliverable_rejected" },
                &work_id,
                next_ver,
                Some(&operation_id),
                &json!({ "workId": work_id, "deliverableId": deliverable_id, "status": next_status }),
            )?;
            let reply = json!({
                "ok": true,
                "replayed": false,
                "deliverableId": deliverable_id,
                "status": next_status,
                "work": updated_work,
            });
            save_receipt(
                &tx,
                &user_id,
                &operation_id,
                &work_id,
                "acceptDeliverable",
                &payload_hash,
                &reply,
                None,
                now,
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: reply,
                events: vec![ev],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
        Command::Tick {
            owner_id,
            now_ms: supplied_now,
            lease_ttl_ms,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let ttl = lease_ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut events = vec![];
            let mut dispatches = vec![];
            let data = tick_tx(
                &tx,
                &core_gen,
                tracker,
                owner_id.as_deref(),
                now,
                ttl,
                &mut events,
                &mut dispatches,
            )?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data,
                events,
                dispatches,
                shutdown_after_reply: false,
            })
        }
        Command::ScanRecovery {
            owner_id,
            now_ms: supplied_now,
        } => {
            let now = supplied_now.unwrap_or_else(now_ms);
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(rej) =
                check_owner_lease_write(&tx, owner_id.as_deref(), now, DEFAULT_LEASE_TTL_MS)?
            {
                return Ok(rej);
            }
            let mut events = vec![];
            let recovered = scan_recovery_tx(&tx, &core_gen, now, &mut events)?;
            let mut dispatches = vec![];
            let promoted =
                promote_compatible_executions(&tx, &core_gen, tracker, &mut events, &mut dispatches)?;
            crate::request_control::commit(tx)?;
            Ok(WriteSideEffects {
                data: json!({
                    "ok": true,
                    "reconciledUnknown": recovered,
                    "promotedDispatches": promoted,
                }),
                events,
                dispatches,
                shutdown_after_reply: false,
            })
        }
        Command::GetWork { .. } | Command::ListWorks { .. } | Command::GetExecutionQueue | Command::OwnerStatus { .. } => {
            let data = execute_read(db, command)?;
            Ok(WriteSideEffects {
                data,
                events: vec![],
                dispatches: vec![],
                shutdown_after_reply: false,
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn transition_close_tx(
    db: &mut Connection,
    tracker: &ExecutorTracker,
    core_gen: &str,
    _client: &ClientContext,
    operation_id: &str,
    user_id: &str,
    work_id: &str,
    conclusion: &str,
    summary: Option<String>,
    expected_state_version: Option<i64>,
    expected_intent_revision: Option<i64>,
    expected_owner_epoch: Option<i64>,
    owner_id: Option<&str>,
    now_ms_opt: Option<i64>,
) -> crate::Result<WriteSideEffects> {
    let now = now_ms_opt.unwrap_or_else(now_ms);
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(rej) = check_owner_lease_write(&tx, owner_id, now, DEFAULT_LEASE_TTL_MS)? {
        return Ok(rej);
    }
    let payload_hash = sha256_hex(&format!("close:{work_id}:{operation_id}:{conclusion}"));
    if let Some(replay) = check_receipt(&tx, user_id, operation_id, &payload_hash)? {
        return Ok(replay);
    }
    let Some(work) = fetch_work(&tx, work_id)? else {
        return Ok(WriteSideEffects {
            data: json!({ "ok": false, "status": "rejected", "code": "NOT_FOUND" }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        });
    };
    if work.lifecycle == "closed" {
        return Ok(WriteSideEffects {
            data: json!({ "ok": false, "status": "rejected", "code": "INVALID_LIFECYCLE", "lifecycle": "closed" }),
            events: vec![],
            dispatches: vec![],
            shutdown_after_reply: false,
        });
    }
    if let Some(rej) = check_version_guard(
        &work,
        expected_state_version,
        expected_intent_revision,
        expected_owner_epoch,
    ) {
        return Ok(rej);
    }

    // Cancel non-running queued requests cleanly before checking in-flight bindings
    tx.execute(
        "UPDATE work_subscriptions SET stopped_at = COALESCE(stopped_at, ?), stopped_reason = COALESCE(stopped_reason, ?)
         WHERE work_id = ? AND stopped_at IS NULL",
        params![now, conclusion, work_id],
    )?;
    tx.execute(
        "UPDATE work_dispatch_requests SET state = 'cancelled', error = COALESCE(error, 'work_closed')
         WHERE work_id = ? AND state = 'pending'",
        params![work_id],
    )?;
    tx.execute(
        "UPDATE work_execution_bindings SET status = 'stopped', settled_at = COALESCE(settled_at, ?)
         WHERE work_id = ? AND invalidated_at IS NULL AND status = 'pending'",
        params![now, work_id],
    )?;

    let mut dispatches = vec![];
    let mut events = vec![];
    if let Some((exec_epoch, _)) = tracker.is_online() {
        let mut active_runs_stmt = tx.prepare(
            "SELECT execution_id, revision, owner_generation, task_id FROM core_execution_runs
             WHERE json_extract(payload_json, '$.workId') = ?
               AND status IN ('queued', 'waiting_executor', 'dispatching', 'running', 'pause_requested')",
        )?;
        let active_runs: Vec<(String, i64, String, String)> = active_runs_stmt
            .query_map(params![work_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(active_runs_stmt);
        for (eid, rev, _, _) in active_runs {
            tx.execute(
                "UPDATE core_execution_runs
                 SET status = CASE WHEN status IN ('queued', 'waiting_executor') THEN 'cancelled' ELSE 'cancel_requested' END,
                     revision = ?, updated_at_ms = ?
                 WHERE execution_id = ?",
                params![rev + 1, now, eid],
            )?;
            if let Some(exec_row) = crate::business_protocol::fetch_execution_tx(&tx, &eid)?
                && exec_row.status == "cancel_requested"
            {
                dispatches.push(json!({
                    "coreExecutionDispatch": {
                        "targetRole": "execution-host",
                        "targetEpoch": exec_epoch,
                        "coreGeneration": core_gen,
                        "action": "cancel",
                        "execution": exec_row,
                    }
                }));
            }
        }
    }

    let unsettled: i64 = tx.query_row(
        "SELECT COUNT(*) FROM work_execution_bindings
         WHERE work_id = ? AND invalidated_at IS NULL AND status IN ('pending', 'submitted', 'running', 'unknown')",
        params![work_id],
        |r| r.get(0),
    )?;
    let next_ver = work.state_version + 1;
    if unsettled == 0 {
        tx.execute(
            "UPDATE works
             SET lifecycle = 'closed', closure_conclusion = ?, closure_summary = COALESCE(?, closure_summary),
                 pending_conclusion = NULL, closed_at = COALESCE(closed_at, ?), close_operation_id = ?,
                 state_version = ?, updated_at = ?
             WHERE work_id = ?",
            params![conclusion, summary, now, operation_id, next_ver, now, work_id],
        )?;
    } else {
        tx.execute(
            "UPDATE works
             SET lifecycle = 'closing', pending_conclusion = ?, closure_summary = COALESCE(?, closure_summary),
                 cancel_requested_at = COALESCE(cancel_requested_at, ?), close_operation_id = ?,
                 state_version = ?, updated_at = ?
             WHERE work_id = ?",
            params![conclusion, summary, now, operation_id, next_ver, now, work_id],
        )?;
    }

    let updated = fetch_work(&tx, work_id)?.unwrap();
    let outbox_id = insert_outbox(
        &tx,
        &updated,
        if updated.lifecycle == "closed" { "work.closed" } else { "work.closing" },
        operation_id,
        None,
        &json!({ "workId": work_id, "conclusion": conclusion, "lifecycle": updated.lifecycle }),
        now,
    )?;
    events.push(append_event(
        &tx,
        core_gen,
        core_gen,
        "work",
        if updated.lifecycle == "closed" { "work.closed" } else { "work.closing" },
        work_id,
        next_ver,
        Some(operation_id),
        &json!({ "workId": work_id, "lifecycle": updated.lifecycle, "conclusion": conclusion }),
    )?);
    let reply = json!({
        "ok": true,
        "replayed": false,
        "operationId": operation_id,
        "outboxEventId": outbox_id,
        "work": updated,
    });
    save_receipt(
        &tx,
        user_id,
        operation_id,
        work_id,
        "closeWork",
        &payload_hash,
        &reply,
        Some(&outbox_id),
        now,
    )?;
    crate::request_control::commit(tx)?;
    Ok(WriteSideEffects {
        data: reply,
        events,
        dispatches,
        shutdown_after_reply: false,
    })
}

/// Ensures supervised Core holds `work_host_lease` if not already held, without disturbing external owners.
pub fn claim_supervised_core_lease(db: &mut Connection) -> crate::Result<bool> {
    let core_gen = current_core_generation();
    ensure_tables(db, &core_gen)?;
    let now = now_ms();
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let core_owner = format!("core:{core_gen}");
    let prev: Option<(String, i64, i64, Option<i64>)> = tx
        .query_row(
            "SELECT authority_id, acquired_at, heartbeat_at, released_at FROM work_host_lease WHERE lease_id='singleton'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let live_other = prev.as_ref().is_some_and(|(holder, _, hb, rel)| {
        // Only one supervised Core generation can hold the OS core.lock/core-worker.lock on this DB;
        // a prior `"core:*"` holder is guaranteed retired and must be taken over immediately without waiting 60s TTL.
        holder != &core_owner
            && !holder.starts_with("core:")
            && rel.is_none()
            && now.saturating_sub(*hb) < DEFAULT_LEASE_TTL_MS
    });
    if live_other {
        return Ok(false);
    }
    let same_live = prev.as_ref().is_some_and(|(h, _, hb, rel)| {
        h == &core_owner && rel.is_none() && now.saturating_sub(*hb) < DEFAULT_LEASE_TTL_MS
    });
    let acquired_at = prev.as_ref().map_or(now, |(h, acq, _, rel)| {
        if h == &core_owner && rel.is_none() {
            *acq
        } else {
            now.max(acq.saturating_add(1))
        }
    });
    tx.execute(
        "INSERT INTO work_host_lease (lease_id, authority_id, acquired_at, heartbeat_at, released_at)
         VALUES ('singleton', ?, ?, ?, NULL)
         ON CONFLICT(lease_id) DO UPDATE SET
           authority_id = excluded.authority_id,
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at,
           released_at = NULL",
        params![core_owner, acquired_at, now],
    )?;
    if !same_live {
        tx.execute(
            "UPDATE works SET owner_epoch = owner_epoch + 1, updated_at = ? WHERE lifecycle != 'closed'",
            params![now],
        )?;
    }
    crate::request_control::commit(tx)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db_schema::CANONICAL_SCHEMA_SQL).unwrap();
        ensure_tables(&conn, "test-gen").unwrap();
        conn
    }

    #[test]
    fn dst_spring_forward_fall_back_and_shanghai_slots_match_contract() {
        // Spring forward: 02:30 LA on 2026-03-08 -> 10:30:00Z, nominal 2026-03-08T02:30
        let from_spring = 1_772_928_000_000i64; // 2026-03-08T00:00:00Z (16:00 PST Mar 7)
        let spring_wake = cron_next_wake(Some("30 2 * * *"), Some("America/Los_Angeles"), from_spring).unwrap();
        assert_eq!(spring_wake, 1_772_965_800_000); // 2026-03-08T10:30:00.000Z
        let (date, time, norm) = nominal_wall_slot("30 2 * * *", spring_wake, Some("America/Los_Angeles"));
        assert_eq!(format!("{date}T{time}"), "2026-03-08T02:30");
        assert!(norm);

        // Fall back: 01:30 LA on 2026-11-01 -> 08:30:00Z first occurrence
        let from_fall = 1_793_448_000_000i64; // 2026-10-31T12:00:00Z
        let fall_wake = cron_next_wake(Some("30 1 * * *"), Some("America/Los_Angeles"), from_fall).unwrap();
        assert_eq!(fall_wake, 1_793_521_800_000); // 2026-11-01T08:30:00.000Z

        // Asia/Shanghai: 02:30 CST on 2026-03-08 -> 2026-03-07T18:30:00Z
        let from_sh = 1_772_884_800_000i64; // 2026-03-07T12:00:00Z
        let sh_wake = cron_next_wake(Some("30 2 * * *"), Some("Asia/Shanghai"), from_sh).unwrap();
        assert_eq!(sh_wake, 1_772_908_200_000); // 2026-03-07T18:30:00.000Z
    }

    #[test]
    fn single_owner_fencing_and_resource_conflict_concurrency() {
        let mut db = setup_db();
        let tracker = ExecutorTracker::new();
        tracker.set_presence(true, 1, "exec-1".into());
        let client = ClientContext::synthetic("test-gen");

        // Dual owner contention
        let a1 = execute_write(&mut db, &tracker, &client, Command::OwnerAcquire {
            owner_id: "owner-a".into(),
            lease_ttl_ms: Some(10_000),
            now_ms: Some(1_000),
        }).unwrap();
        assert_eq!(a1.data["ok"], true);
        let b1 = execute_write(&mut db, &tracker, &client, Command::OwnerAcquire {
            owner_id: "owner-b".into(),
            lease_ttl_ms: Some(10_000),
            now_ms: Some(1_500),
        }).unwrap();
        assert_eq!(b1.data["ok"], false);
        assert_eq!(b1.data["code"], "OWNER_CONFLICT");

        // Create two independent Works sharing same resourceKey on w1 & w3, separate on w2
        let w1 = execute_write(&mut db, &tracker, &client, Command::CreateWork {
            operation_id: "op-w1".into(), user_id: "u1".into(), work_id: Some("w1".into()),
            title: "W1".into(), goal_description: None, mode: None, watch_rule: None,
            owner_bot_id: None, criteria: None, input_snapshot_id: None, deadline_at: None,
            authorization: None, workspace_path: Some("/repo-a".into()),
            owner_id: Some("owner-a".into()), now_ms: Some(2_000),
        }).unwrap();
        assert_eq!(w1.data["ok"], true);

        let w2 = execute_write(&mut db, &tracker, &client, Command::CreateWork {
            operation_id: "op-w2".into(), user_id: "u1".into(), work_id: Some("w2".into()),
            title: "W2".into(), goal_description: None, mode: None, watch_rule: None,
            owner_bot_id: None, criteria: None, input_snapshot_id: None, deadline_at: None,
            authorization: None, workspace_path: Some("/repo-b".into()),
            owner_id: Some("owner-a".into()), now_ms: Some(2_001),
        }).unwrap();
        assert_eq!(w2.data["ok"], true);

        let d1 = execute_write(&mut db, &tracker, &client, Command::DispatchExecution {
            operation_id: "d1".into(), user_id: Some("u1".into()), work_id: "w1".into(),
            binding_id: Some("b1".into()), execution_id: Some("e1".into()), task_id: Some("t1".into()),
            bot_id: None, kind: None, resource_key: Some("/repo-a".into()), lock_mode: None,
            allow_concurrent_same_work: None, payload: None, inbox_event_id: None,
            expected_state_version: Some(1), expected_intent_revision: Some(1), expected_owner_epoch: Some(1),
            owner_id: Some("owner-a".into()), now_ms: Some(2_100),
        }).unwrap();
        assert_eq!(d1.data["execution"]["status"], "dispatching");
        assert_eq!(d1.data["conflictQueued"], false);

        // Independent resource repo-b runs concurrently!
        let d2 = execute_write(&mut db, &tracker, &client, Command::DispatchExecution {
            operation_id: "d2".into(), user_id: Some("u1".into()), work_id: "w2".into(),
            binding_id: Some("b2".into()), execution_id: Some("e2".into()), task_id: Some("t2".into()),
            bot_id: None, kind: None, resource_key: Some("/repo-b".into()), lock_mode: None,
            allow_concurrent_same_work: None, payload: None, inbox_event_id: None,
            expected_state_version: Some(1), expected_intent_revision: Some(1), expected_owner_epoch: Some(1),
            owner_id: Some("owner-a".into()), now_ms: Some(2_101),
        }).unwrap();
        assert_eq!(d2.data["execution"]["status"], "dispatching");
        assert_eq!(d2.data["conflictQueued"], false);

        // Conflicting resource repo-a queues behind b1, then auto-promotes when b1 settles!
        let w3 = execute_write(&mut db, &tracker, &client, Command::CreateWork {
            operation_id: "op-w3".into(), user_id: "u1".into(), work_id: Some("w3".into()),
            title: "W3".into(), goal_description: None, mode: None, watch_rule: None,
            owner_bot_id: None, criteria: None, input_snapshot_id: None, deadline_at: None,
            authorization: None, workspace_path: Some("/repo-a".into()),
            owner_id: Some("owner-a".into()), now_ms: Some(2_102),
        }).unwrap();
        assert_eq!(w3.data["ok"], true);
        let d3 = execute_write(&mut db, &tracker, &client, Command::DispatchExecution {
            operation_id: "d3".into(), user_id: Some("u1".into()), work_id: "w3".into(),
            binding_id: Some("b3".into()), execution_id: Some("e3".into()), task_id: Some("t3".into()),
            bot_id: None, kind: None, resource_key: Some("/repo-a".into()), lock_mode: None,
            allow_concurrent_same_work: None, payload: None, inbox_event_id: None,
            expected_state_version: Some(1), expected_intent_revision: Some(1), expected_owner_epoch: Some(1),
            owner_id: Some("owner-a".into()), now_ms: Some(2_105),
        }).unwrap();
        assert_eq!(d3.data["conflictQueued"], true);
        assert_eq!(d3.data["execution"]["status"], "queued");

        let s1 = execute_write(&mut db, &tracker, &client, Command::SettleExecution {
            binding_id: "b1".into(), work_id: Some("w1".into()), outcome: "completed".into(),
            result: Some(json!({ "summary": "part 1 done" })), error_message: None,
            deliverable: Some(DeliverableInput {
                deliverable_id: Some("del-1".into()), summary: "Partial deliverable".into(),
                artifact_refs: Some(vec!["out.txt".into()]), evidence_refs: None,
                uncovered_scope: Some(vec!["step-2".into()]), uncovered_criterion_ids: None,
            }),
            subitems: None, owner_epoch: Some(1), intent_revision: Some(1),
            input_snapshot_id: Some("snap:op-w1".into()), owner_id: None, now_ms: Some(2_200),
        }).unwrap();
        assert_eq!(s1.data["ok"], true);
        // Settling execution produced proposed deliverable & bumped stateVersion, did NOT auto-close Work!
        assert_eq!(s1.data["work"]["lifecycle"], "active");
        // And promoted waiting e3 on repo-a!
        assert_eq!(s1.dispatches.len(), 1);
        assert_eq!(s1.dispatches[0]["coreExecutionDispatch"]["execution"]["executionId"], "e3");
    }

    #[test]
    fn promote_skips_128_conflicting_candidates_to_start_129th_independent_execution() {
        let mut db = setup_db();
        let tracker = ExecutorTracker::new();
        tracker.set_presence(true, 1, "pi-1".into());
        tracker.set_slots_limit(4);
        let core_gen = current_core_generation();

        // Active holder on hot-lock + 128 waiting candidates on hot-lock + 129th independent candidate.
        db.execute(
            "INSERT INTO core_execution_runs (
                execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                task_id, kind, payload_json, status, revision, executor_client_id, executor_epoch, attempt, created_at_ms, updated_at_ms
             ) VALUES ('exec-holder', 'ik-holder', ?1, 'ui', 'c1', 1, 't-holder', 'pi_turn', '{\"resourceKey\":\"hot-lock\"}', 'running', 2, 'pi-1', 1, 1, 1000, 1000)",
            params![core_gen],
        )
        .unwrap();
        for i in 1..=128 {
            db.execute(
                "INSERT INTO core_execution_runs (
                    execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                    task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, ?3, 'ui', 'c1', 1, ?4, 'pi_turn', '{\"resourceKey\":\"hot-lock\"}', 'queued', 1, 0, ?5, ?5)",
                params![
                    format!("exec-wait-{i:03}"),
                    format!("ik-wait-{i:03}"),
                    core_gen,
                    format!("t-wait-{i:03}"),
                    1000 + i as i64
                ],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO core_execution_runs (
                execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
             ) VALUES ('exec-129', 'ik-129', ?1, 'ui', 'c1', 1, 't-129', 'pi_turn', '{\"resourceKey\":\"indep-129\"}', 'queued', 1, 0, 2000, 2000)",
            params![core_gen],
        )
        .unwrap();

        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        let mut events = Vec::new();
        let mut dispatches = Vec::new();
        let promoted = promote_compatible_executions(&tx, &core_gen, &tracker, &mut events, &mut dispatches).unwrap();
        tx.commit().unwrap();

        assert_eq!(promoted, 1);
        assert_eq!(dispatches[0]["coreExecutionDispatch"]["execution"]["executionId"], "exec-129");
        let wait_reason: Option<String> = db
            .query_row(
                "SELECT wait_reason FROM core_execution_runs WHERE execution_id = 'exec-wait-001'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(wait_reason.as_deref().unwrap_or("").contains("conflict:resource:hot-lock"));
    }

    #[test]
    fn promote_enforces_same_session_and_prioritizes_foreground_with_aging() {
        let mut db = setup_db();
        let tracker = ExecutorTracker::new();
        tracker.set_presence(true, 1, "pi-1".into());
        tracker.set_slots_limit(2);
        let core_gen = current_core_generation();

        // Active pi_turn on sess-1 blocks queued pi_turn on sess-1.
        db.execute(
            "INSERT INTO core_execution_runs (
                execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                task_id, kind, payload_json, status, revision, executor_client_id, executor_epoch, attempt, created_at_ms, updated_at_ms
             ) VALUES ('exec-s1-a', 'ik-s1-a', ?1, 'ui', 'c1', 1, 'sess-1', 'pi_turn', '{}', 'running', 2, 'pi-1', 1, 1, 10000, 10000)",
            params![core_gen],
        )
        .unwrap();
        db.execute(
            "INSERT INTO core_execution_runs (
                execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
             ) VALUES ('exec-s1-b', 'ik-s1-b', ?1, 'ui', 'c1', 1, 'sess-1', 'pi_turn', '{}', 'queued', 1, 0, 10001, 10001)",
            params![core_gen],
        )
        .unwrap();
        // Background task queued slightly earlier (10002) vs Foreground task (10500):
        // With tier=2 (+10_000ms) vs tier=0 (+0ms), foreground wins!
        db.execute(
            "INSERT INTO core_execution_runs (
                execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
             ) VALUES ('exec-bg-fresh', 'ik-bg-f', ?1, 'service', 'c1', 1, 't-bg-f', 'maintenance_control', '{}', 'queued', 1, 0, 10002, 10002)",
            params![core_gen],
        )
        .unwrap();
        db.execute(
            "INSERT INTO core_execution_runs (
                execution_id, idempotency_key, owner_generation, source_role, source_client_id, source_epoch,
                task_id, kind, payload_json, status, revision, attempt, created_at_ms, updated_at_ms
             ) VALUES ('exec-fg', 'ik-fg', ?1, 'ui', 'c1', 1, 'sess-fg', 'pi_turn', '{}', 'queued', 1, 0, 10500, 10500)",
            params![core_gen],
        )
        .unwrap();

        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        let mut events = Vec::new();
        let mut dispatches = Vec::new();
        let promoted = promote_compatible_executions(&tx, &core_gen, &tracker, &mut events, &mut dispatches).unwrap();
        tx.commit().unwrap();

        assert_eq!(promoted, 1);
        assert_eq!(dispatches[0]["coreExecutionDispatch"]["execution"]["executionId"], "exec-fg");
        let sess_reason: Option<String> = db
            .query_row(
                "SELECT wait_reason FROM core_execution_runs WHERE execution_id = 'exec-s1-b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sess_reason.as_deref(), Some("conflict:session:sess-1:active:exec-s1-a"));
    }
}
