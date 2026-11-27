use crate::{Result, sqlite_rows::records};
use duckdb::{Connection, params};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Query {
    Gadgets {
        scopes: Option<Vec<Scope>>,
    },
    Gadget {
        id: String,
    },
    GadgetForTask {
        id: String,
        #[serde(rename = "taskId")]
        task_id: String,
    },
    InheritedGadgets {
        scope: Scope,
    },
    Blueprints,
    Blueprint {
        id: String,
    },
    WorkbenchReceipt {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    BlueprintReceipt {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    WritesSupported,
    InstantiationSupported,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub(crate) scope_type: String,
    pub(crate) scope_id: Option<String>,
}

// The starting workspace stays visible to its own task. Inherited ancestors must
// be effectively active. Keep a visited path even if a malformed tree has a cycle.
const LINEAGE: &str = "WITH RECURSIVE anchor(id) AS (
     SELECT space_id FROM tasks WHERE $kind='task' AND id=$owner
     UNION ALL SELECT $owner WHERE $kind='workspace'
   ), lineage(id,parent_id,archived,depth,visited) AS (
     SELECT s.id,s.parent_id,s.archived,0,[s.id] FROM spaces s JOIN anchor a ON a.id=s.id
     UNION ALL
     SELECT s.id,s.parent_id,s.archived,a.depth+1,list_append(a.visited,s.id)
       FROM spaces s JOIN lineage a ON s.id=a.parent_id WHERE NOT list_contains(a.visited,s.id)
   ), requested(scope_type,scope_id,scope_index) AS (
     SELECT $kind,$owner,0 WHERE $kind='workspace' OR EXISTS(SELECT 1 FROM anchor)
     UNION ALL
     SELECT 'workspace',l.id,l.depth+CASE WHEN $kind='task' THEN 1 ELSE 0 END FROM lineage l
       WHERE ($kind='task' AND l.depth=0) OR (l.depth>0 AND NOT EXISTS (
         SELECT 1 FROM lineage a WHERE a.depth>=l.depth AND a.archived<>0))
     UNION ALL
     SELECT 'global',NULL,COALESCE((SELECT max(depth)+2 FROM lineage),1)
       WHERE $kind='task' AND EXISTS(SELECT 1 FROM anchor)
   )";

const MATCH_SCOPE: &str =
    "g.scope_type=r.scope_type AND g.scope_id IS NOT DISTINCT FROM r.scope_id";

pub(crate) fn task_can_access_gadget(
    db: &Connection,
    id: &str,
    task_id: &str,
) -> duckdb::Result<bool> {
    db.query_row(&format!("{LINEAGE} SELECT EXISTS(SELECT 1 FROM requested r JOIN gadgets g ON {MATCH_SCOPE} WHERE g.id=$id)"),
        duckdb::named_params! { "kind": "task", "owner": task_id, "id": id }, |row| row.get(0))
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    let rows = match query {
        Query::Gadgets { scopes: Some(scopes) } => {
            if scopes.is_empty() {
                Vec::new()
            } else {
                let mut values_sql = Vec::with_capacity(scopes.len());
                let mut params_vec: Vec<duckdb::types::Value> = Vec::with_capacity(scopes.len() * 3);
                for (idx, sc) in scopes.into_iter().enumerate() {
                    let base = idx * 3 + 1;
                    values_sql.push(format!("(CAST(?{} AS BIGINT), CAST(?{} AS VARCHAR), CAST(?{} AS VARCHAR))", base, base + 1, base + 2));
                    params_vec.push(duckdb::types::Value::BigInt(idx as i64));
                    params_vec.push(duckdb::types::Value::Text(sc.scope_type));
                    params_vec.push(match sc.scope_id {
                        Some(id) => duckdb::types::Value::Text(id),
                        None => duckdb::types::Value::Null,
                    });
                }
                let sql = format!(
                    "WITH requested(scope_index, scope_type, scope_id) AS (VALUES {})
                     SELECT g.*, r.scope_index FROM requested r JOIN gadgets g
                        ON g.scope_type = r.scope_type AND g.scope_id IS NOT DISTINCT FROM r.scope_id
                     ORDER BY r.scope_index, g.updated_at DESC, g.id",
                    values_sql.join(", ")
                );
                let refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|v| v as &dyn duckdb::ToSql).collect();
                records(db, &sql, duckdb::params_from_iter(refs))?
            }
        }
        Query::Gadgets { scopes: None } => records(
            db,
            "SELECT *, 0 AS scope_index FROM gadgets ORDER BY updated_at DESC, id",
            [],
        )?,
        Query::Gadget { id } => records(db, "SELECT * FROM gadgets WHERE id=?1", [id])?,
        Query::GadgetForTask { id, task_id } => {
            if task_can_access_gadget(db, &id, &task_id)? {
                records(db, "SELECT * FROM gadgets WHERE id=?1", [id])?
            } else { Vec::new() }
        }
        Query::InheritedGadgets { scope } => records(db,
            &format!("{LINEAGE} SELECT g.*,r.scope_index FROM requested r JOIN gadgets g ON {MATCH_SCOPE}
               ORDER BY r.scope_index,g.updated_at DESC,g.id"),
            duckdb::named_params! { "kind": scope.scope_type, "owner": scope.scope_id })?,
        Query::WorkbenchReceipt { operation_id } => records(db,
            "SELECT status FROM workbench_write_receipts WHERE operation_id=?1", params![operation_id])?,
        Query::BlueprintReceipt { operation_id } => records(db,
            "SELECT result_json FROM blueprint_instance_receipts WHERE operation_id=?1", params![operation_id])?,
        Query::Blueprints => {
            return blueprint_rows(records(db, "SELECT * FROM blueprints ORDER BY updated_at DESC, id", [])?);
        }
        Query::Blueprint { id } => {
            return blueprint_rows(records(db, "SELECT * FROM blueprints WHERE id=?1", [id])?);
        }
        Query::WritesSupported | Query::InstantiationSupported => return Ok(true.into()),
    };
    Ok(rows.into())
}

fn blueprint_rows(rows: Vec<Value>) -> Result<Value> {
    // The line protocol has a 32 MiB limit. A large definition can expand
    // substantially when its JSON is escaped again inside a row.
    if serde_json::to_vec(&rows)?.len() > 31 * 1024 * 1024 {
        return Ok(Value::Null);
    }
    Ok(rows.into())
}
