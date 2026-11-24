use crate::Result;
use rusqlite::{Connection, Params, types::ValueRef};
use serde_json::{Map, Value};

pub fn records(db: &Connection, sql: &str, params: impl Params) -> Result<Vec<Value>> {
    let mut statement = db.prepare_cached(sql)?;
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut rows = statement.query(params)?;
    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(number) => number.into(),
                ValueRef::Real(number) => number.into(),
                ValueRef::Text(text) => std::str::from_utf8(text)?.into(),
                ValueRef::Blob(_) => return Err("unexpected binary metadata".into()),
            };
            record.insert(name.clone(), value);
        }
        records.push(Value::Object(record));
    }
    Ok(records)
}
