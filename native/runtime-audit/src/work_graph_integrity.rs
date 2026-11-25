use crate::Result;
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Finding {
    OrphanEdge {
        edge_id: String,
        relation: String,
        from_type: String,
        from_id: String,
        to_type: String,
        to_id: String,
        detail: String,
    },
    DagCycle {
        relation: &'static str,
        detail: String,
    },
    BrokenLibraryBinding {
        workspace_id: String,
        library_space_id: String,
        detail: String,
    },
    BrokenCwd {
        detail: String,
    },
}

impl Finding {
    fn kind(&self) -> &'static str {
        match self {
            Self::OrphanEdge { .. } => "orphan_edge",
            Self::DagCycle { .. } => "dag_cycle",
            Self::BrokenLibraryBinding { .. } => "broken_library_binding",
            Self::BrokenCwd { .. } => "broken_cwd",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    checked_at: u128,
    findings: Vec<Finding>,
    summary: BTreeMap<&'static str, usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairPreview {
    will_delete_edge_ids: Vec<String>,
    will_delete_binding_keys: Vec<BindingKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindingKey {
    workspace_id: String,
    library_space_id: String,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RepairReply {
    Applied {
        deleted_edges: usize,
        deleted_bindings: usize,
    },
    Rejected {
        message: String,
    },
}

pub fn repair(db: &mut Connection, preview: &RepairPreview) -> RepairReply {
    match apply_repair(db, preview) {
        Ok((deleted_edges, deleted_bindings)) => RepairReply::Applied {
            deleted_edges,
            deleted_bindings,
        },
        Err(error) => RepairReply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply_repair(db: &mut Connection, preview: &RepairPreview) -> rusqlite::Result<(usize, usize)> {
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let orphan = orphan_predicate(&transaction)?;
    let (workspace_exists, library_exists) = binding_predicates(&transaction)?;
    let mut deleted_edges = 0;
    let mut deleted_bindings = 0;
    {
        let mut delete_edge = transaction.prepare_cached(&format!(
            "DELETE FROM work_graph_edges AS e WHERE e.id = ?1 AND {orphan}"
        ))?;
        for id in &preview.will_delete_edge_ids {
            deleted_edges += delete_edge.execute([id])?;
        }
        let mut delete_binding = transaction.prepare_cached(&format!(
            "DELETE FROM workspace_library_links AS b
             WHERE b.workspace_id = ?1 AND b.library_space_id = ?2
               AND NOT ({workspace_exists} AND {library_exists})"
        ))?;
        for key in &preview.will_delete_binding_keys {
            deleted_bindings +=
                delete_binding.execute(params![key.workspace_id, key.library_space_id])?;
        }
    }
    transaction.commit()?;
    Ok((deleted_edges, deleted_bindings))
}

pub fn scan(path: &Path) -> Result<Report> {
    let mut db = crate::read_connection(path)?;
    let snapshot = db.transaction()?;
    let mut findings = Vec::new();
    scan_edges(&snapshot, &mut findings)?;
    scan_bindings(&snapshot, &mut findings)?;
    let mut cwd = snapshot.prepare_cached(
        "SELECT t.id, t.space_id FROM tasks t WHERE t.space_id <> ''
         AND NOT EXISTS(SELECT 1 FROM spaces WHERE id = t.space_id) ORDER BY t.rowid",
    )?;
    for row in cwd.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (task, space) = row?;
        findings.push(Finding::BrokenCwd {
            detail: format!("task {task} space_id {space} missing"),
        });
    }
    let mut summary = BTreeMap::new();
    for finding in &findings {
        *summary.entry(finding.kind()).or_insert(0) += 1;
    }
    Ok(Report {
        checked_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
        findings,
        summary,
    })
}

fn has_table(db: &Connection, table: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
}

fn orphan_predicate(db: &Connection) -> rusqlite::Result<String> {
    let has_artifacts = has_table(db, "artifacts")?;
    let has_library = has_table(db, "library_items")?;
    let exists = |side: &str| {
        let artifact = if has_artifacts {
            format!("EXISTS(SELECT 1 FROM artifacts WHERE id = e.{side}_id)")
        } else {
            "1".to_owned()
        };
        let library = if has_library {
            format!("EXISTS(SELECT 1 FROM library_items WHERE id = e.{side}_id)")
        } else {
            "1".to_owned()
        };
        format!(
            "CASE e.{side}_type
               WHEN 'workspace' THEN EXISTS(SELECT 1 FROM spaces WHERE id = e.{side}_id)
               WHEN 'task' THEN EXISTS(SELECT 1 FROM tasks WHERE id = e.{side}_id)
               WHEN 'project' THEN EXISTS(SELECT 1 FROM projects WHERE id = e.{side}_id)
               WHEN 'plan' THEN EXISTS(SELECT 1 FROM project_todos WHERE id = e.{side}_id)
               WHEN 'artifact' THEN {artifact}
               WHEN 'library_item' THEN {library}
               WHEN 'agent_run' THEN 1 ELSE 0 END"
        )
    };
    Ok(format!("NOT (({}) AND ({}))", exists("from"), exists("to")))
}

fn scan_edges(db: &Connection, findings: &mut Vec<Finding>) -> Result<()> {
    let orphan = orphan_predicate(db)?;
    let mut query = db.prepare_cached(&format!(
        "SELECT e.id, e.relation, e.from_type, e.from_id, e.to_type, e.to_id,
           {orphan} AS orphan FROM work_graph_edges e
         ORDER BY e.created_at, e.id"
    ))?;
    let mut dependencies = Dag::default();
    let mut spawned = Dag::default();
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let relation: String = row.get(1)?;
        let orphan: bool = row.get(6)?;
        let dag = match relation.as_str() {
            "DEPENDS_ON" => Some(&mut dependencies),
            "SPAWNED" => Some(&mut spawned),
            _ => None,
        };
        if !orphan && dag.is_none() {
            continue;
        }
        let from_type: String = row.get(2)?;
        let from_id: String = row.get(3)?;
        let to_type: String = row.get(4)?;
        let to_id: String = row.get(5)?;
        if let Some(dag) = dag {
            dag.add(
                format!("{from_type}:{from_id}"),
                format!("{to_type}:{to_id}"),
            );
        }
        if orphan {
            findings.push(Finding::OrphanEdge {
                edge_id: row.get(0)?,
                detail: format!("orphan: {from_type}:{from_id} --{relation}--> {to_type}:{to_id}"),
                relation,
                from_type,
                from_id,
                to_type,
                to_id,
            });
        }
    }
    dependencies.find_cycles("DEPENDS_ON", findings);
    spawned.find_cycles("SPAWNED", findings);
    Ok(())
}

#[derive(Default)]
struct Dag {
    roots: Vec<String>,
    outgoing: HashMap<String, Vec<String>>,
}

impl Dag {
    fn add(&mut self, from: String, to: String) {
        self.outgoing
            .entry(from.clone())
            .or_insert_with(|| {
                self.roots.push(from);
                Vec::new()
            })
            .push(to);
    }

    fn find_cycles(&self, relation: &'static str, findings: &mut Vec<Finding>) {
        let mut visited = HashSet::new();
        let mut active = HashSet::new();
        for root in &self.roots {
            if !visited.insert(root.as_str()) {
                continue;
            }
            active.insert(root.as_str());
            let mut path = vec![(root.as_str(), 0)];
            while let Some((node, offset)) = path.last_mut() {
                let next = self
                    .outgoing
                    .get(*node)
                    .and_then(|nodes| nodes.get(*offset));
                if let Some(next) = next.map(String::as_str) {
                    *offset += 1;
                    if active.contains(next) {
                        let cycle = path
                            .iter()
                            .map(|(node, _)| *node)
                            .chain([next])
                            .collect::<Vec<_>>()
                            .join(" -> ");
                        findings.push(Finding::DagCycle {
                            relation,
                            detail: format!("cycle {relation}: {cycle}"),
                        });
                    } else if visited.insert(next) {
                        active.insert(next);
                        path.push((next, 0));
                    }
                } else {
                    active.remove(*node);
                    path.pop();
                }
            }
        }
    }
}

fn binding_predicates(db: &Connection) -> rusqlite::Result<(&'static str, &'static str)> {
    let workspace_exists = "EXISTS(SELECT 1 FROM spaces WHERE id = b.workspace_id)";
    let library_exists = if has_table(db, "library_spaces")? {
        "EXISTS(SELECT 1 FROM library_spaces WHERE id = b.library_space_id)"
    } else {
        "1"
    };
    Ok((workspace_exists, library_exists))
}

fn scan_bindings(db: &Connection, findings: &mut Vec<Finding>) -> Result<()> {
    let (workspace_exists, library_exists) = binding_predicates(db)?;
    let mut query = db.prepare_cached(&format!(
        "SELECT * FROM (
           SELECT b.workspace_id, b.library_space_id,
             {workspace_exists} AS workspace_exists,
             {library_exists} AS library_exists
           FROM workspace_library_links b ORDER BY b.rowid
         ) WHERE NOT workspace_exists OR NOT library_exists"
    ))?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let workspace_id: String = row.get(0)?;
        let library_space_id: String = row.get(1)?;
        let missing = if row.get::<_, bool>(2)? {
            "library_space"
        } else {
            "workspace"
        };
        findings.push(Finding::BrokenLibraryBinding {
            detail: format!("binding {workspace_id} ↔ {library_space_id} missing {missing}"),
            workspace_id,
            library_space_id,
        });
    }
    Ok(())
}
