use crate::{
    Result,
    usage_history::{Usage, model_from_id},
};
use rusqlite::{Connection, named_params, params};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveInput {
    task_id: Option<String>,
    session_file: Option<String>,
    source_kind: String,
    source_detail: Option<String>,
    sample: Timing,
    persisted_entry_id: Option<String>,
    message: Message,
    user_turn: Option<i64>,
    model_id: Option<String>,
    pricing_configured: Option<bool>,
    reported_usage: Option<Reported>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Timing {
    turn_index: i64,
    request_started_at: Option<f64>,
    first_response_at: Option<f64>,
    completed_at: Option<f64>,
    ttft_ms: Option<f64>,
    decode_ms: Option<f64>,
    generation_tps: Option<f64>,
    model_wall_ms: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    provider: Option<String>,
    model: Option<String>,
    response_model: Option<String>,
    response_id: Option<String>,
    usage: Option<Usage>,
    stop_reason: Option<String>,
    error_message: Option<String>,
    timestamp: Option<f64>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reported {
    input: Option<f64>,
    output: Option<f64>,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
    cost_total: Option<f64>,
}

fn catalog_cost(
    usage: &Usage,
    reported: &Reported,
    configured: Option<bool>,
) -> (Option<f64>, bool) {
    let amount = usage
        .cost
        .as_ref()
        .and_then(|cost| cost.total)
        .filter(|amount| {
            amount.is_finite() && *amount >= 0.0 && (*amount != 0.0 || configured != Some(false))
        });
    let complete = amount.is_some_and(|amount| {
        amount > 0.0
            || [
                usage.input,
                usage.output,
                usage.cache_read,
                usage.cache_write,
            ]
            .into_iter()
            .flatten()
            .any(|tokens| tokens > 0.0)
            || (reported.input.is_some() && reported.output.is_some())
    });
    (amount, complete)
}

pub fn record(db: &Connection, input: LiveInput, captured: i64, coverage: bool) -> Result<usize> {
    let m = input.message;
    let t = input.sample;
    let native = m.usage.unwrap_or_default();
    let reported = input.reported_usage.unwrap_or_default();
    // Some providers include cache writes in the reported new input. Pi splits those counters.
    let new_input = if reported.input.is_some()
        && reported.cache_write.is_none()
        && native.cache_write.is_some_and(|tokens| tokens > 0.0)
    {
        native.input.or(reported.input)
    } else {
        reported.input.or(native.input)
    };
    let output = reported.output.or(native.output);
    let cache_read = reported.cache_read.or(native.cache_read);
    let cache_write = reported.cache_write.or(native.cache_write);
    let total = new_input.unwrap_or_default()
        + output.unwrap_or_default()
        + cache_read.unwrap_or_default()
        + cache_write.unwrap_or_default();
    let (cost, complete) = reported
        .cost_total
        .filter(|amount| amount.is_finite() && *amount >= 0.0)
        .map_or_else(
            || catalog_cost(&native, &reported, input.pricing_configured),
            |amount| (Some(amount), true),
        );
    let known_cost = if input.pricing_configured.is_none() {
        total > 0.0 || reported.cost_total.is_some() || catalog_cost(&native, &reported, None).1
    } else {
        reported.cost_total.is_some() || complete
    };
    let selected = input.model_id.as_deref().and_then(model_from_id);
    let provider_model = m.model.as_deref().or(m.response_model.as_deref());
    let (provider, model, response_model) = selected.map_or(
        (
            m.provider.as_deref(),
            provider_model,
            m.response_model.as_deref(),
        ),
        |(provider, model)| (Some(provider), Some(model), provider_model),
    );
    let entry_id = input.persisted_entry_id.unwrap_or_else(|| {
        let session = input
            .session_file
            .as_deref()
            .or(input.task_id.as_deref())
            .unwrap_or("?");
        match m.response_id.as_deref() {
            Some(response) => format!("live:{session}:{response}"),
            None => format!("live:{session}:ti{}", t.turn_index),
        }
    });
    let native_cost = native.cost.unwrap_or_default();
    let saved = db.prepare_cached(
        "INSERT OR IGNORE INTO usage_events(
           entry_id,task_id,session_file,source_kind,source_detail,provider,model,response_model,ts,
           input_tokens,output_tokens,cache_read,cache_write,cache_write_1h,reasoning_tokens,total_tokens,
           cost_total,cost_input,cost_output,cost_cache_read,cost_cache_write,stop_reason,error_message,
           request_started_at,first_response_at,completed_at,ttft_ms,decode_ms,generation_tps,model_wall_ms,
           response_id,turn_index,user_turn,backfilled
         ) VALUES (
           :entry,:task,:session,:source,:detail,:provider,:model,:response_model,:time,
           :input,:output,:cache_read,:cache_write,:cache_write_1h,:reasoning,:total,
           :cost,:cost_input,:cost_output,:cost_read,:cost_write,:stop,:error,
           :started,:first,:complete,:ttft,:decode,:tps,:wall,:response,:turn,:user_turn,0
         )",
    )?.execute(named_params! {
        ":entry": entry_id, ":task": input.task_id, ":session": input.session_file,
        ":source": input.source_kind, ":detail": input.source_detail, ":provider": provider, ":model": model,
        ":response_model": response_model, ":time": m.timestamp.or(t.completed_at).unwrap_or(captured as f64),
        ":input": new_input.unwrap_or_default(), ":output": output.unwrap_or_default(),
        ":cache_read": cache_read.unwrap_or_default(), ":cache_write": cache_write.unwrap_or_default(),
        ":cache_write_1h": native.cache_write1h, ":reasoning": native.reasoning, ":total": total,
        ":cost": cost.unwrap_or_default(), ":cost_input": native_cost.input.unwrap_or_default(),
        ":cost_output": native_cost.output.unwrap_or_default(), ":cost_read": native_cost.cache_read.unwrap_or_default(),
        ":cost_write": native_cost.cache_write.unwrap_or_default(), ":stop": m.stop_reason, ":error": m.error_message,
        ":started": t.request_started_at, ":first": t.first_response_at, ":complete": t.completed_at,
        ":ttft": t.ttft_ms, ":decode": t.decode_ms, ":tps": t.generation_tps, ":wall": t.model_wall_ms,
        ":response": m.response_id, ":turn": t.turn_index, ":user_turn": input.user_turn,
    })?;
    if coverage {
        db.prepare_cached("INSERT OR IGNORE INTO usage_event_coverage VALUES (?1,?2,?3,?4,?5,?6)")?
            .execute(params![
                entry_id,
                new_input.is_some(),
                output.is_some(),
                cache_read.is_some(),
                cache_write.is_some(),
                known_cost
            ])?;
    }
    Ok(saved)
}

pub fn repair_coverage(db: &Connection) -> Result<usize> {
    let real_usage = "EXISTS (SELECT 1 FROM usage_events e WHERE e.entry_id=usage_event_coverage.entry_id AND e.total_tokens>0)";
    let tokens = db.execute(&format!(
        "UPDATE usage_event_coverage SET input_known=1,output_known=1,cache_read_known=1,cache_write_known=1
         WHERE cache_write_known=0 AND {real_usage}"
    ), [])?;
    let cost = db.execute(
        &format!(
            "UPDATE usage_event_coverage SET cost_known=1 WHERE cost_known=0 AND {real_usage}"
        ),
        [],
    )?;
    Ok(tokens + cost)
}
