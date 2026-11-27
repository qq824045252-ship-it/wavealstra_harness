use crate::resource_gate::ResourceKey;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize, Serialize)]
pub struct Scope {
    task: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    List,
    State { key: String },
    Has { scope: Scope },
    Lookup { scope: Scope, missing: String },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Publish {
        scope: Scope,
        key: String,
        missing: String,
        found: String,
        week: String,
    },
    Disable {
        scope: Scope,
        key: String,
    },
    RecordUse {
        scope: Scope,
        key: String,
        missing: String,
        found: String,
        conversation: String,
        run: String,
        call: String,
    },
    Repair {
        scope: Scope,
        found: String,
        conversation: String,
        run: String,
    },
}

impl Mutation {
    pub fn resource(&self) -> ResourceKey {
        let scope = match self {
            Self::Publish { scope, .. }
            | Self::Disable { scope, .. }
            | Self::RecordUse { scope, .. }
            | Self::Repair { scope, .. } => scope,
        };
        ResourceKey::Entity(
            "read-hint-scope".into(),
            json!([scope.task, scope.cwd]).to_string(),
        )
    }
}

#[derive(Serialize)]
struct Hint {
    key: String,
    task: String,
    cwd: String,
    missing: String,
    found: String,
    enabled: bool,
    week: String,
}

fn hint(row: &duckdb::Row<'_>) -> duckdb::Result<Hint> {
    Ok(Hint {
        key: row.get(0)?,
        task: row.get(1)?,
        cwd: row.get(2)?,
        missing: row.get(3)?,
        found: row.get(4)?,
        enabled: row.get::<_, i64>(5)? == 1,
        week: row.get(6)?,
    })
}

const FIELDS: &str = "key,task,cwd,missing,found,enabled,week";

pub fn read(db: &Connection, query: Query) -> crate::Result<Value> {
    let data = match query {
        Query::List => {
            let mut stmt = db.prepare(
                "SELECT p.key,p.task,p.cwd,p.missing,p.found,p.enabled,p.week,
                        coalesce(u.triggers,0),coalesce(u.repaired,0)
                 FROM path_hints p LEFT JOIN (
                   SELECT key,count(*) triggers,count(DISTINCT (conversation,run)) FILTER (WHERE repaired=1) repaired
                   FROM path_hint_uses GROUP BY key
                 ) u ON p.key=u.key ORDER BY p.key",
            )?;
            let rows = stmt.query_map([], |r| {
                let hint = hint(r)?;
                let triggers: i64 = r.get(7)?;
                let repaired: i64 = r.get(8)?;
                Ok(json!({ "hint": hint, "triggers": triggers, "repaired": repaired, "errors": 0 }))
            })?.collect::<duckdb::Result<Vec<_>>>()?;
            rows.into()
        }
        Query::State { key } => json!(db.query_row(
            &format!("SELECT {FIELDS} FROM path_hints WHERE key=?"), [key], hint,
        ).optional()?),
        Query::Has { scope } => {
            let exists: bool = db.query_row(
                "SELECT EXISTS (SELECT 1 FROM path_hints WHERE task=? AND cwd=? AND enabled=1)",
                params![scope.task, scope.cwd], |r| r.get(0),
            )?;
            exists.into()
        }
        Query::Lookup { scope, missing } => json!(db.query_row(
            &format!("SELECT {FIELDS} FROM path_hints WHERE task=? AND cwd=? AND missing=? AND enabled=1 ORDER BY key LIMIT 1"),
            params![scope.task, scope.cwd, missing], hint,
        ).optional()?),
    };
    Ok(json!({ "status": "ok", "data": data }))
}

pub fn write(db: &mut Connection, mutation: Mutation) -> crate::Result<Value> {
    let tx = db.transaction()?;
    let data: Value = match mutation {
        Mutation::Publish {
            scope,
            key,
            missing,
            found,
            week,
        } => {
            let exists: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM path_hints WHERE key=?)",
                [&key],
                |r| r.get(0),
            )?;
            if exists {
                return Ok(json!({ "status": "ok", "data": false }));
            }
            let conflict: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM path_hints WHERE task=? AND cwd=? AND missing=? AND found<>?)",
                params![scope.task, scope.cwd, missing, found], |r| r.get(0),
            )?;
            if conflict {
                tx.execute("UPDATE path_hints SET enabled=0 WHERE task=? AND cwd=? AND missing=? AND enabled=1",
                    params![scope.task, scope.cwd, missing])?;
            }
            tx.execute(
                "INSERT INTO path_hints VALUES (?,?,?,?,?,?,?)",
                params![
                    key,
                    scope.task,
                    scope.cwd,
                    missing,
                    found,
                    i64::from(!conflict),
                    week
                ],
            )?;
            true.into()
        }
        Mutation::Disable { scope, key } => (tx.execute(
            "UPDATE path_hints SET enabled=0 WHERE key=? AND task=? AND cwd=? AND enabled=1",
            params![key, scope.task, scope.cwd],
        )? > 0)
            .into(),
        Mutation::RecordUse {
            scope,
            key,
            missing,
            found,
            conversation,
            run,
            call,
        } => {
            let enabled: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM path_hints WHERE key=? AND task=? AND cwd=? AND missing=? AND found=? AND enabled=1)",
                params![key, scope.task, scope.cwd, missing, found], |r| r.get(0),
            )?;
            if !enabled {
                return Ok(json!({ "status": "ok", "data": false }));
            }
            tx.execute(
                "INSERT INTO path_hint_uses(key,conversation,run,call) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
                params![key, conversation, run, call],
            )?;
            true.into()
        }
        Mutation::Repair {
            scope,
            found,
            conversation,
            run,
        } => {
            tx.execute(
                "UPDATE path_hint_uses SET repaired=1 WHERE conversation=? AND run=? AND repaired=0
                 AND key IN (SELECT key FROM path_hints WHERE task=? AND cwd=? AND found=? AND enabled=1)",
                params![conversation, run, scope.task, scope.cwd, found],
            )?;
            Value::Null
        }
    };
    crate::request_control::commit(tx)?;
    Ok(json!({ "status": "ok", "data": data }))
}
