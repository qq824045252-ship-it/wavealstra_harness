use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Query {
    State { input_id: String },
    Unlinked { after_input_id: Option<String> },
}

#[derive(Deserialize)]
pub struct Rule {
    id: String,
    revision: i64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Freeze { input_id: String },
    Charge {
        input_id: String,
        call_id: String,
        source: String,
        description: String,
        text: String,
        rule: Option<Rule>,
        #[serde(default)]
        related_input_ids: Vec<String>,
    },
    Handoff { input_id: String, candidate: Value },
    Linked { input_id: String },
}

impl Command {
    pub fn input_id(&self) -> &str {
        match self {
            Self::Freeze { input_id } | Self::Charge { input_id, .. }
            | Self::Handoff { input_id, .. } | Self::Linked { input_id } => input_id,
        }
    }
}

#[derive(Deserialize)]
struct Limits {
    calls: usize,
    sources: usize,
    characters: usize,
}

struct ReadRow {
    call_id: String,
    source: String,
    description: String,
    characters: usize,
    excerpt: Option<String>,
}

struct Turn {
    policy: Value,
    limits: Limits,
    reads: Vec<ReadRow>,
    used: usize,
    exhausted: bool,
}

impl Turn {
    fn projection(self) -> Value {
        let reads: Vec<Value> = self.reads.into_iter().map(|row| {
            let mut item = json!({"source":row.source,"description":row.description,"characters":row.characters});
            if let Some(excerpt) = row.excerpt { item["excerpt"] = json!(excerpt); }
            item
        }).collect();
        json!({"status":"ready","state":{"policy":self.policy,"calls":reads.len(),"characters":self.used,
            "exhausted":self.exhausted,"reads":reads}})
    }
}

fn rule_turn(db: &Connection, input: &str) -> Result<Option<(bool, Option<String>)>> {
    Ok(db.query_row("SELECT t.status='revoked' OR COALESCE(r.enabled,0)<>1,t.snapshot FROM answer_rule_turns t
        LEFT JOIN answer_rules r ON r.id=t.rule_id WHERE t.task_id='mybuddy-dots' AND t.input_id=?1",
        [input], |row| Ok((row.get(0)?, row.get(1)?))).optional()?)
}

fn permitted(db: &Connection, input: &str) -> Result<bool> {
    Ok(!rule_turn(db, input)?.is_some_and(|(revoked, _)| revoked))
}

fn turn(db: &Connection, input: &str, rule: Option<&Rule>) -> Result<Option<Turn>> {
    let record = rule_turn(db, input)?;
    if record.as_ref().is_some_and(|(revoked, _)| *revoked) { return Ok(None); }
    let selected: Option<String> = if let Some(rule) = rule {
        let active = db.query_row("SELECT config FROM answer_rules WHERE id=?1 AND revision=?2 AND enabled=1",
            params![rule.id, rule.revision], |row| row.get(0)).optional()?;
        if active.is_none() { return Ok(None); }
        active
    } else { None };
    let frozen: Option<(String, i64)> = db.query_row("SELECT policy,exhausted FROM dots_foreground_policies WHERE input_id=?1",
        [input], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
    let policy = if let Some((raw, _)) = &frozen {
        serde_json::from_str(raw)?
    } else {
        let config = selected.or_else(|| record.and_then(|(_, snapshot)| snapshot));
        let mut policy = config.map(|raw| -> Result<Value> {
            Ok(serde_json::from_str::<Value>(&raw)?["policy"].clone())
        }).transpose()?.unwrap_or(Value::Null);
        if policy.is_null() {
            let raw: String = db.query_row("SELECT config FROM answer_rules WHERE id='dots-default-policy'", [], |row| row.get(0))
                .optional()?.unwrap_or_else(|| crate::db_schema::DEFAULT_DOTS_RULE_CONFIG.to_owned());
            policy = serde_json::from_str::<Value>(&raw)?["policy"].clone();
            if policy.is_null() { policy = serde_json::from_str::<Value>(crate::db_schema::DEFAULT_DOTS_RULE_CONFIG)?["policy"].clone(); }
        }
        policy
    };
    let limits: Limits = serde_json::from_value(policy["foregroundReadLimits"].clone())?;
    let reads = db.prepare("SELECT call_id,source,description,characters,excerpt FROM dots_foreground_reads
        WHERE input_id=?1 ORDER BY rowid")?.query_map([input], |row| Ok(ReadRow {
            call_id: row.get(0)?, source: row.get(1)?, description: row.get(2)?,
            characters: row.get::<_, i64>(3)?.max(0) as usize, excerpt: row.get(4)?,
        }))?.collect::<duckdb::Result<Vec<_>>>()?;
    let used = reads.iter().map(|row| row.characters).sum();
    let exhausted = frozen.is_some_and(|(_, exhausted)| exhausted != 0) || reads.len() >= limits.calls || used >= limits.characters;
    Ok(Some(Turn { policy, limits, reads, used, exhausted }))
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::State { input_id } => {
            let snapshot = db.unchecked_transaction()?;
            Ok(turn(&snapshot, &input_id, None)?.map_or_else(|| json!({"status":"revoked"}), Turn::projection))
        }
        Query::Unlinked { after_input_id } => {
            let mut stmt = db.prepare("SELECT input_id,data FROM dots_foreground_handoffs
                WHERE linked=0 AND (?1 IS NULL OR input_id>?1) ORDER BY input_id LIMIT 65")?;
            let mut cursor = stmt.query([after_input_id])?;
            let mut rows = Vec::new();
            let mut last = None;
            let mut bytes = 512;
            while let Some(row) = cursor.next()? {
                let raw: String = row.get(1)?;
                bytes += raw.len() + 16;
                if rows.len() == 64 || bytes >= crate::MAX_REPLY_BYTES {
                    if rows.is_empty() { return Err("Dots foreground handoff exceeds IPC page size".into()); }
                    return Ok(json!({"rows":rows,"nextInputId":last}));
                }
                last = Some(row.get::<_, String>(0)?);
                rows.push(serde_json::from_str::<Value>(&raw)?);
            }
            Ok(json!({"rows":rows,"nextInputId":null}))
        }
    }
}

fn freeze(db: &Connection, input: &str, policy: &Value) -> Result<()> {
    db.execute("INSERT INTO dots_foreground_policies(input_id,policy) VALUES(?1,?2) ON CONFLICT DO NOTHING",
        params![input, policy.to_string()])?;
    Ok(())
}

fn mark_exhausted(db: &Connection, input: &str) -> Result<()> {
    db.execute("UPDATE dots_foreground_policies SET exhausted=1 WHERE input_id=?1", [input])?;
    Ok(())
}

fn prefix(text: &str, mut remaining: usize) -> (&str, usize) {
    let initial = remaining;
    for (offset, character) in text.char_indices() {
        if character.len_utf16() > remaining { return (&text[..offset], initial - remaining); }
        remaining -= character.len_utf16();
    }
    (text, initial - remaining)
}

pub fn write(db: &mut Connection, command: Command) -> Result<Value> {
    let tx = db.transaction()?;
    let reply = match command {
        Command::Freeze { input_id } => match turn(&tx, &input_id, None)? {
            Some(state) => { freeze(&tx, &input_id, &state.policy)?; state.projection() }
            None => json!({"status":"revoked"}),
        },
        Command::Charge { input_id, call_id, source, description, text, rule, related_input_ids } => {
            let mut authorized = true;
            for input in &related_input_ids { authorized &= permitted(&tx, input)?; }
            match turn(&tx, &input_id, rule.as_ref())?.filter(|_| authorized) {
                None => json!({"status":"revoked"}),
                Some(state) => {
                    if let Some(existing) = state.reads.iter().find(|row| row.call_id == call_id) {
                        let (result, _) = prefix(&text, existing.characters);
                        if existing.source != source || existing.description != description
                            || existing.excerpt.as_ref().is_some_and(|excerpt| excerpt != result) {
                            json!({"status":"callReused"})
                        } else {
                            json!({"status":"charged","text":result,"exhausted":state.exhausted || result.len()<text.len()})
                        }
                    } else {
                        freeze(&tx, &input_id, &state.policy)?;
                        let sources: HashSet<&str> = state.reads.iter().map(|row| row.source.as_str()).collect();
                        if state.exhausted || (!sources.contains(source.as_str()) && sources.len() >= state.limits.sources) {
                            mark_exhausted(&tx, &input_id)?;
                            json!({"status":"charged","text":"","exhausted":true})
                        } else {
                            let (result, units) = prefix(&text, state.limits.characters.saturating_sub(state.used));
                            let exhausted = result.len() < text.len() || state.reads.len()+1 >= state.limits.calls
                                || state.used+units >= state.limits.characters;
                            let excerpt = source.starts_with("file:").then_some(result);
                            tx.execute("INSERT INTO dots_foreground_reads(input_id,call_id,source,description,characters,excerpt)
                                VALUES(?1,?2,?3,?4,?5,?6)", params![input_id,call_id,source,description,units as i64,excerpt])?;
                            if exhausted { mark_exhausted(&tx, &input_id)?; }
                            json!({"status":"charged","text":result,"exhausted":exhausted})
                        }
                    }
                }
            }
        }
        Command::Handoff { input_id, candidate } => {
            let inputs = candidate["inputs"].as_array().ok_or("Invalid foreground handoff inputs")?;
            if inputs.first().and_then(|input| input["id"].as_str()) != Some(input_id.as_str()) {
                return Err("Invalid original foreground handoff input".into());
            }
            let mut authorized = true;
            for input in inputs {
                authorized &= permitted(&tx, input["id"].as_str().ok_or("Missing foreground handoff input identity")?)?;
            }
            if !authorized { json!({"status":"revoked"}) }
            else {
                tx.execute("INSERT INTO dots_foreground_handoffs(input_id,data) VALUES(?1,?2) ON CONFLICT DO NOTHING",
                    params![input_id, candidate.to_string()])?;
                let data: String = tx.query_row("SELECT data FROM dots_foreground_handoffs WHERE input_id=?1", [&input_id], |row| row.get(0))?;
                json!({"status":"prepared","handoff":serde_json::from_str::<Value>(&data)?})
            }
        }
        Command::Linked { input_id } => {
            tx.execute("UPDATE dots_foreground_handoffs SET linked=1 WHERE input_id=?1", [&input_id])?;
            json!({"status":"linked"})
        }
    };
    crate::request_control::commit(tx)?;
    Ok(reply)
}
