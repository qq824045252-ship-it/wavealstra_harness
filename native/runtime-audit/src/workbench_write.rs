use crate::{Result, scoped_notes, workbench_data::Scope};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gadget {
    id: String,
    name: String,
    description: Option<String>,
    scope: Scope,
    manifest_path: String,
    source_path: String,
    created_by_task_id: Option<String>,
    blueprint_id: Option<String>,
    metadata_json: String,
    created_at: i64,
    updated_at: i64,
}

impl Gadget {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    kind: String,
    schema_version: i64,
    definition_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blueprint {
    id: String,
    name: String,
    description: Option<String>,
    definition: Definition,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
pub struct Description {
    value: Option<String>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GadgetOrigin {
    Generated,
    Copy { source_id: String },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    CreateGadget {
        gadget: Gadget,
        origin: GadgetOrigin,
    },
    UpdateGadget {
        id: String,
        name: String,
        description: Option<String>,
        metadata_json: String,
        updated_at: i64,
    },
    TouchGadget {
        id: String,
        updated_at: i64,
    },
    MoveGadget {
        id: String,
        scope: Scope,
        updated_at: i64,
    },
    DeleteGadget {
        id: String,
    },
    CreateBlueprint {
        blueprint: Blueprint,
    },
    PatchBlueprint {
        id: String,
        name: Option<String>,
        description: Option<Description>,
        definition: Option<Definition>,
        updated_at: i64,
    },
    DeleteBlueprint {
        id: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Changed,
    Missing,
    ScopeChanged,
}

fn scope_available(db: &Connection, scope: &Scope) -> rusqlite::Result<bool> {
    match (scope.scope_type.as_str(), scope.scope_id.as_deref()) {
        ("global", None) => Ok(true),
        ("workspace", Some(id)) => scoped_notes::library_owner_writable(db, None, Some(id)),
        ("task", Some(id)) => db.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
            [id],
            |row| row.get(0),
        ),
        _ => Ok(false),
    }
}

fn gadget_origin_available(
    db: &Connection,
    gadget: &Gadget,
    origin: GadgetOrigin,
) -> rusqlite::Result<bool> {
    let scope = &gadget.scope;
    match origin {
        GadgetOrigin::Generated => {
            let Some(origin) = gadget.created_by_task_id.as_deref() else {
                return Ok(scope.scope_type != "task");
            };
            let workspace: Option<Option<String>> = db
                .query_row("SELECT space_id FROM tasks WHERE id=?1", [origin], |row| {
                    row.get(0)
                })
                .optional()?;
            let Some(workspace) = workspace else {
                return Ok(false);
            };
            Ok(match scope.scope_type.as_str() {
                "task" => scope.scope_id.as_deref() == Some(origin),
                "workspace" => scope.scope_id == workspace,
                _ => true,
            })
        }
        GadgetOrigin::Copy { source_id } => {
            if scope.scope_type != "task" {
                return Ok(true);
            }
            db.query_row(
                "WITH RECURSIVE visible(id) AS (
                    SELECT space_id FROM tasks WHERE id=?2
                    UNION SELECT s.parent_id FROM spaces s JOIN visible v ON s.id=v.id
                )
                SELECT EXISTS(SELECT 1 FROM gadgets WHERE id=?1 AND (
                    scope_type='global' OR (scope_type='task' AND scope_id=?2)
                    OR (scope_type='workspace' AND scope_id IN (SELECT id FROM visible))
                ))",
                params![source_id, scope.scope_id],
                |row| row.get(0),
            )
        }
    }
}

pub(crate) fn create_gadget(
    db: &Connection,
    gadget: Gadget,
    origin: GadgetOrigin,
) -> rusqlite::Result<usize> {
    if !scope_available(db, &gadget.scope)? || !gadget_origin_available(db, &gadget, origin)? {
        return Ok(0);
    }
    db.execute(
        "INSERT INTO gadgets(id,name,description,scope_type,scope_id,type,manifest_path,source_path,
            created_by_task_id,blueprint_id,metadata_json,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,'web',?6,?7,?8,?9,?10,?11,?12)",
        params![gadget.id, gadget.name, gadget.description, gadget.scope.scope_type, gadget.scope.scope_id,
            gadget.manifest_path, gadget.source_path, gadget.created_by_task_id, gadget.blueprint_id,
            gadget.metadata_json, gadget.created_at, gadget.updated_at],
    )
}

pub(crate) fn update_gadget(
    db: &Connection,
    id: &str,
    name: &str,
    description: Option<&str>,
    metadata_json: &str,
    updated_at: i64,
) -> rusqlite::Result<usize> {
    db.execute(
        "UPDATE gadgets SET name=?2,description=?3,metadata_json=?4,updated_at=max(updated_at,?5) WHERE id=?1",
        params![id,name,description,metadata_json,updated_at],
    )
}

pub fn write(db: &mut Connection, operation_id: &str, mutation: Mutation) -> Result<Status> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let applied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM workbench_write_receipts WHERE operation_id=?1)",
        [operation_id],
        |row| row.get(0),
    )?;
    if applied {
        return Ok(Status::Changed);
    }
    let changed = match mutation {
        Mutation::CreateGadget { gadget, origin } => {
            let count = create_gadget(&tx, gadget, origin)?;
            if count == 0 {
                return Ok(Status::ScopeChanged);
            }
            count
        }
        Mutation::UpdateGadget { id,name,description,metadata_json,updated_at } =>
            update_gadget(&tx, &id, &name, description.as_deref(), &metadata_json, updated_at)?,
        Mutation::TouchGadget { id, updated_at } => tx.execute(
            "UPDATE gadgets SET updated_at=max(updated_at,?2) WHERE id=?1", params![id,updated_at],
        )?,
        Mutation::MoveGadget { id, scope, updated_at } => {
            if !scope_available(&tx, &scope)? {
                return Ok(Status::ScopeChanged);
            }
            tx.execute(
                "UPDATE gadgets SET scope_type=?2,scope_id=?3,updated_at=max(updated_at,?4) WHERE id=?1",
                params![id,scope.scope_type,scope.scope_id,updated_at],
            )?
        }
        Mutation::DeleteGadget { id } => tx.execute("DELETE FROM gadgets WHERE id=?1", [id])?,
        Mutation::CreateBlueprint { blueprint } => tx.execute(
            "INSERT INTO blueprints(id,name,description,kind,schema_version,definition_json,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![blueprint.id,blueprint.name,blueprint.description,blueprint.definition.kind,
                blueprint.definition.schema_version,blueprint.definition.definition_json,blueprint.created_at,blueprint.updated_at],
        )?,
        Mutation::PatchBlueprint { id,name,description,definition,updated_at } => tx.execute(
            "UPDATE blueprints SET name=coalesce(?2,name),description=CASE WHEN ?3 THEN ?4 ELSE description END,
                kind=coalesce(?5,kind),schema_version=coalesce(?6,schema_version),definition_json=coalesce(?7,definition_json),
                updated_at=max(updated_at,?8) WHERE id=?1",
            params![id,name,description.is_some(),description.and_then(|patch| patch.value),
                definition.as_ref().map(|patch| &patch.kind),definition.as_ref().map(|patch| patch.schema_version),
                definition.as_ref().map(|patch| &patch.definition_json),updated_at],
        )?,
        Mutation::DeleteBlueprint { id } => tx.execute("DELETE FROM blueprints WHERE id=?1", [id])?,
    };
    if changed == 0 {
        return Ok(Status::Missing);
    }
    tx.execute(
        "INSERT INTO workbench_write_receipts(operation_id) VALUES (?1)",
        [operation_id],
    )?;
    tx.execute(
        "DELETE FROM workbench_write_receipts WHERE rowid <= last_insert_rowid()-2048",
        [],
    )?;
    tx.commit()?;
    Ok(Status::Changed)
}
