use crate::Result;
use duckdb::{Connection, OptionalExt, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
enum Direction {
    #[serde(rename = "outgoing")]
    Outgoing,
    #[serde(rename = "incoming")]
    Incoming,
    #[serde(rename = "related")]
    Related,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Query {
    Count { count: Counter },
    Edges(EdgeQuery),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Counter { Edges, Tasks }

#[derive(Deserialize)]
pub struct EdgeQuery {
    direction: Direction,
    #[serde(rename = "type")]
    node_type: String,
    id: String,
    relation: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    id: String,
    from_type: String,
    from_id: String,
    relation: String,
    to_type: String,
    to_id: String,
    metadata: Value,
    created_at: i64,
    updated_at: i64,
}

const EDGE_COLUMNS: &str =
    "id,from_type,from_id,relation,to_type,to_id,metadata_json,created_at,updated_at";

fn edge_from_row(row: &Row) -> duckdb::Result<Edge> {
    let metadata = serde_json::from_str::<Value>(&row.get::<_, String>(6)?)
        .ok()
        .filter(|value| value.is_object() || value.is_array())
        .unwrap_or_else(|| json!({}));
    Ok(Edge {
        id: row.get(0)?,
        from_type: row.get(1)?,
        from_id: row.get(2)?,
        relation: row.get(3)?,
        to_type: row.get(4)?,
        to_id: row.get(5)?,
        metadata,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

pub fn read(db: &Connection, query: Query) -> Result<Value> {
    match query {
        Query::Edges(query) => Ok(serde_json::to_value(read_edges(db,query)?)?),
        Query::Count { count } => {
            let sql = match count {
                Counter::Edges => "SELECT count(*) FROM work_graph_edges",
                Counter::Tasks => "SELECT count(*) FROM tasks WHERE id <> 'mybuddy-dots'",
            };
            Ok(json!(db.query_row(sql, [], |r| r.get::<_, i64>(0))?))
        }
    }
}

fn read_edges(db: &Connection, query: EdgeQuery) -> Result<Vec<Edge>> {
    let condition = match query.direction {
        Direction::Outgoing => "from_type=?1 AND from_id=?2",
        Direction::Incoming => "to_type=?1 AND to_id=?2",
        Direction::Related => "(from_type=?1 AND from_id=?2) OR (to_type=?1 AND to_id=?2)",
    };
    let mut statement = db.prepare(&format!(
        "SELECT {EDGE_COLUMNS} FROM work_graph_edges
         WHERE ({condition}) AND (?3 IS NULL OR relation=?3) ORDER BY created_at,id"
    ))?;
    let rows = statement.query_map(
        params![query.node_type, query.id, query.relation],
        edge_from_row,
    )?;
    Ok(rows.collect::<duckdb::Result<_>>()?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEdge {
    id: String,
    from_type: String,
    from_id: String,
    relation: String,
    to_type: String,
    to_id: String,
    metadata_json: String,
    at: i64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Mutation {
    Add { edge: NewEdge },
    Remove { id: String },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Added { edge: Edge, created: bool },
    Removed { removed: bool },
    Rejected { message: String },
}

pub fn write(db: &mut Connection, mutation: Mutation) -> Reply {
    let result = match mutation {
        Mutation::Add { edge } => add(db, edge),
        Mutation::Remove { id } => db
            .execute("DELETE FROM work_graph_edges WHERE id=?1", [id])
            .map(|changes| Reply::Removed {
                removed: changes > 0,
            })
            .map_err(Into::into),
    };
    result.unwrap_or_else(|error| Reply::Rejected {
        message: error.to_string(),
    })
}

fn add(db: &mut Connection, edge: NewEdge) -> Result<Reply> {
    let tx = db.transaction()?;
    assert_exists(&tx, &edge.from_type, &edge.from_id)?;
    assert_exists(&tx, &edge.to_type, &edge.to_id)?;
    let existing = tx
        .query_row(
            &format!(
                "SELECT {EDGE_COLUMNS} FROM work_graph_edges WHERE from_type=?1 AND from_id=?2
         AND relation=?3 AND to_type=?4 AND to_id=?5 LIMIT 1"
            ),
            params![
                edge.from_type,
                edge.from_id,
                edge.relation,
                edge.to_type,
                edge.to_id
            ],
            edge_from_row,
        )
        .optional()?;
    if let Some(edge) = existing {
        return Ok(Reply::Added {
            edge,
            created: false,
        });
    }
    if matches!(edge.relation.as_str(), "DEPENDS_ON" | "SPAWNED") && would_cycle(&tx, &edge)? {
        return Err(format!(
            "DAG 环拒绝：{}:{} --{}--> {}:{} 将形成环",
            edge.from_type, edge.from_id, edge.relation, edge.to_type, edge.to_id
        )
        .into());
    }
    let saved = tx.query_row(&format!(
        "INSERT INTO work_graph_edges ({EDGE_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8) RETURNING {EDGE_COLUMNS}"
    ), params![edge.id, edge.from_type, edge.from_id, edge.relation, edge.to_type, edge.to_id, edge.metadata_json, edge.at], edge_from_row)?;
    tx.commit()?;
    Ok(Reply::Added {
        edge: saved,
        created: true,
    })
}

fn assert_exists(db: &Connection, kind: &str, id: &str) -> Result<()> {
    let table = match kind {
        "workspace" => "spaces",
        "task" => "tasks",
        "project" => "projects",
        "plan" => "project_todos",
        "artifact" => "artifacts",
        "library_item" => "library_items",
        "agent_run" => return Ok(()),
        _ => return Err(format!("非法 node type：{kind}").into()),
    };
    if matches!(kind, "artifact" | "library_item") {
        let has_table = crate::database::table_exists(db, table)?;
        if !has_table {
            return Ok(());
        }
    }
    let exists: bool = db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
        [id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(format!("{kind} 不存在：{id}").into());
    }
    Ok(())
}

fn would_cycle(db: &Connection, edge: &NewEdge) -> Result<bool> {
    Ok(db.query_row(
        "WITH RECURSIVE reachable(node_type,node_id) AS (
             SELECT ?1,?2
             UNION
             SELECT edge.to_type,edge.to_id FROM reachable JOIN work_graph_edges AS edge
             ON edge.from_type=reachable.node_type AND edge.from_id=reachable.node_id AND edge.relation=?3
         ) SELECT EXISTS(SELECT 1 FROM reachable WHERE node_type=?4 AND node_id=?5)",
        params![edge.to_type, edge.to_id, edge.relation, edge.from_type, edge.from_id],
        |row| row.get(0),
    )?)
}
