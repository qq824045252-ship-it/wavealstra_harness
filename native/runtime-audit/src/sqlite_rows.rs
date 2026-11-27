use crate::Result;
use crate::database::value_ref_to_json;
use duckdb::{Connection, Params};
use serde_json::{Map, Value};

pub fn records(db: &Connection, sql: &str, params: impl Params) -> Result<Vec<Value>> {
    let mut statement = db.prepare(sql)?;
    let mut rows = statement.query(params)?;
    let names: Vec<String> = rows
        .as_ref()
        .map(|s| s.column_names())
        .unwrap_or_default();
    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = value_ref_to_json(row.get_ref(index)?)?;
            record.insert(name.clone(), value);
        }
        records.push(Value::Object(record));
    }
    Ok(records)
}
