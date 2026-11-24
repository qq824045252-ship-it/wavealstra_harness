use crate::Result;
use rusqlite::{Connection, Statement, functions::FunctionFlags, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub fn install_functions(db: &Connection) -> rusqlite::Result<()> {
    db.create_scalar_function(
        "board_space",
        2,
        FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let bot: String = ctx.get(0)?;
            let team: Option<String> = ctx.get(1)?;
            let (prefix, id) = match team.filter(|id| !id.is_empty()) {
                Some(id) => ("bot-team-space-", id),
                None => ("bot-space-", bot),
            };
            let digest = format!("{:x}", Sha256::digest(id.as_bytes()));
            Ok(format!("{prefix}{}", &digest[..24]))
        },
    )
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Parameter {
    Integer(i64),
    Text(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    sql: String,
    count_sql: Option<String>,
    parameters: HashMap<String, Option<Parameter>>,
    size: usize,
    has_cursor: bool,
}

#[derive(Serialize)]
pub struct Page {
    rows: Vec<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
}

fn bind(
    statement: &mut Statement<'_>,
    parameters: &HashMap<String, Option<Parameter>>,
) -> Result<()> {
    if !statement.readonly() {
        return Err("task board query is not read-only".into());
    }
    for index in 1..=statement.parameter_count() {
        let name = statement
            .parameter_name(index)
            .and_then(|name| name.strip_prefix('@'))
            .ok_or("task board requires named parameters")?;
        match parameters.get(name).ok_or("missing task board parameter")? {
            Some(Parameter::Integer(value)) => statement.raw_bind_parameter(index, value)?,
            Some(Parameter::Text(value)) => statement.raw_bind_parameter(index, value)?,
            None => statement.raw_bind_parameter(index, rusqlite::types::Null)?,
        }
    }
    Ok(())
}

pub fn read(db: &Connection, query: Query) -> Result<Page> {
    if !(1..=25).contains(&query.size) {
        return Err("invalid task board page size".into());
    }
    let mut statement = db.prepare_cached(&query.sql)?;
    bind(&mut statement, &query.parameters)?;
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut results = statement.raw_query();
    let mut rows = Vec::new();
    while let Some(row) = results.next()? {
        if rows.len() > query.size {
            return Err("task board query exceeded its page size".into());
        }
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => value.into(),
                ValueRef::Real(value) => value.into(),
                ValueRef::Text(value) => std::str::from_utf8(value)?.into(),
                ValueRef::Blob(_) => return Err("invalid task board column".into()),
            };
            record.insert(name.clone(), value);
        }
        rows.push(record);
    }
    let total = if let Some(sql) = query.count_sql {
        if !query.has_cursor && rows.len() <= query.size {
            Some(rows.len())
        } else {
            let mut statement = db.prepare_cached(&sql)?;
            bind(&mut statement, &query.parameters)?;
            let mut result = statement.raw_query();
            Some(result.next()?.ok_or("missing task board count")?.get(0)?)
        }
    } else {
        None
    };
    Ok(Page { rows, total })
}
