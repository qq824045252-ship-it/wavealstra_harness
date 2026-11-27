use crate::resource_gate::{ResourceKey, ResourceRequirement};
use crate::{Result, scoped_notes, workbench_data::Scope};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
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

    pub(crate) fn scope_resources(&self) -> Vec<ResourceRequirement> {
        self.scope
            .task_resource()
            .into_iter()
            .chain(self.created_by_task_id.as_deref().map(shared_task))
            .collect()
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    kind: String,
    schema_version: i64,
    definition_json: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blueprint {
    id: String,
    name: String,
    description: Option<String>,
    definition: Definition,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize, Serialize)]
pub struct Description {
    value: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GadgetPatch {
    name: Option<String>,
    description: Option<Description>,
    metadata_json: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GadgetOrigin {
    Generated,
    Copy { source_id: String },
}

#[derive(Deserialize, Serialize)]
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
        #[serde(flatten)]
        patch: GadgetPatch,
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Changed,
    Missing,
    ScopeChanged,
}

impl Status {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Changed => "changed",
            Self::Missing => "missing",
            Self::ScopeChanged => "scopeChanged",
        }
    }
}

pub(crate) fn shared_task(id: &str) -> ResourceRequirement {
    ResourceRequirement::shared(ResourceKey::Entity("task".into(), id.into()))
}

pub(crate) fn gadget_namespace() -> ResourceKey {
    ResourceKey::Namespace("domain".into(), "gadgets".into())
}

pub(crate) fn gadget_resources(id: &str) -> Vec<ResourceRequirement> {
    vec![
        ResourceRequirement::shared(gadget_namespace()),
        ResourceRequirement::exclusive(ResourceKey::Entity("gadget".into(), id.into())),
    ]
}

pub(crate) fn scope_namespaces() -> [ResourceRequirement; 2] {
    ["tasks", "workspaces"].map(|domain| {
        ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into()))
    })
}

impl Scope {
    pub(crate) fn task_resource(&self) -> Option<ResourceRequirement> {
        (self.scope_type == "task")
            .then(|| self.scope_id.as_deref())
            .flatten()
            .map(shared_task)
    }
}

impl Mutation {
    fn target(&self) -> (&'static str, &str) {
        match self {
            Self::CreateGadget { gadget, .. } => ("gadget", gadget.id()),
            Self::UpdateGadget { id, .. }
            | Self::TouchGadget { id, .. }
            | Self::MoveGadget { id, .. }
            | Self::DeleteGadget { id } => ("gadget", id),
            Self::CreateBlueprint { blueprint } => ("blueprint", &blueprint.id),
            Self::PatchBlueprint { id, .. } | Self::DeleteBlueprint { id } => ("blueprint", id),
        }
    }

    pub(crate) fn resources(&self, operation_id: &str) -> Vec<ResourceRequirement> {
        let (kind, id) = self.target();
        let mut plan = vec![ResourceRequirement::exclusive(ResourceKey::Entity(
            "workbench-operation".into(),
            operation_id.into(),
        ))];
        if kind == "gadget" {
            plan.extend(gadget_resources(id));
            match self {
                Self::CreateGadget { gadget, origin } => {
                    plan.extend(scope_namespaces());
                    plan.extend(gadget.scope_resources());
                    if let GadgetOrigin::Copy { source_id } = origin {
                        plan.push(ResourceRequirement::shared(ResourceKey::Entity(
                            "gadget".into(),
                            source_id.clone(),
                        )));
                    }
                }
                Self::MoveGadget { scope, .. } => {
                    plan.extend(scope_namespaces());
                    plan.extend(scope.task_resource());
                }
                _ => {}
            }
        } else {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity(
                kind.into(),
                id.into(),
            )));
        }
        plan
    }
}

fn scope_available(db: &Connection, scope: &Scope) -> duckdb::Result<bool> {
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
) -> duckdb::Result<bool> {
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
                return db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM gadgets WHERE id=?1)",
                    [source_id],
                    |row| row.get(0),
                );
            }
            let Some(task_id) = scope.scope_id.as_deref() else {
                return Ok(false);
            };
            crate::workbench_data::task_can_access_gadget(db, &source_id, task_id)
        }
    }
}

pub(crate) fn create_gadget(
    db: &Connection,
    gadget: Gadget,
    origin: GadgetOrigin,
) -> duckdb::Result<usize> {
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
    patch: &GadgetPatch,
    updated_at: i64,
) -> duckdb::Result<usize> {
    db.execute(
        "UPDATE gadgets SET name=coalesce(?2,name),description=CASE WHEN ?3 THEN ?4 ELSE description END,
            metadata_json=coalesce(?5,metadata_json),updated_at=GREATEST(updated_at,?6) WHERE id=?1",
        params![id, patch.name, patch.description.is_some(), patch.description.as_ref().and_then(|value| value.value.as_deref()),
            patch.metadata_json, updated_at],
    )
}

pub fn write(db: &mut Connection, operation_id: &str, mutation: Mutation) -> Result<Status> {
    if operation_id.is_empty() || operation_id.len() > 192 {
        return Err("invalid workbench operation id".into());
    }
    let (kind, target) = mutation.target();
    let target = target.to_owned();
    let fingerprint = crate::work_scheduler::sha256_hex(&serde_json::to_string(&mutation)?);
    let tx = db.transaction()?;
    let receipt: Option<(String, String)> = tx
        .query_row(
            "SELECT fingerprint,status FROM workbench_write_receipts WHERE operation_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((stored, status)) = receipt {
        if stored != fingerprint {
            return Err("workbench operation id was used for another mutation".into());
        }
        return Ok(serde_json::from_value(serde_json::Value::String(status))?);
    }
    let status = mutate(&tx, mutation)?;
    tx.execute(
        "INSERT INTO workbench_write_receipts(operation_id,target_kind,target_id,fingerprint,status,recorded_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![operation_id, kind, target, fingerprint, status.as_str(), crate::core_lease::now_ms()],
    )?;
    tx.execute(
        "DELETE FROM workbench_write_receipts WHERE operation_id IN (
           SELECT operation_id FROM workbench_write_receipts WHERE target_kind=?1 AND target_id=?2
           ORDER BY recorded_at DESC, operation_id DESC OFFSET 2048
         )",
        params![kind, target],
    )?;
    crate::request_control::commit(tx)?;
    Ok(status)
}

fn mutate(tx: &Connection, mutation: Mutation) -> Result<Status> {
    let changed = match mutation {
        Mutation::CreateGadget { gadget, origin } => {
            let count = create_gadget(tx, gadget, origin)?;
            if count == 0 {
                return Ok(Status::ScopeChanged);
            }
            count
        }
        Mutation::UpdateGadget { id,patch,updated_at } => update_gadget(tx, &id, &patch, updated_at)?,
        Mutation::TouchGadget { id, updated_at } => tx.execute(
            "UPDATE gadgets SET updated_at=GREATEST(updated_at, ?2) WHERE id=?1", params![id,updated_at],
        )?,
        Mutation::MoveGadget { id, scope, updated_at } => {
            if !scope_available(tx, &scope)? {
                return Ok(Status::ScopeChanged);
            }
            tx.execute(
                "UPDATE gadgets SET scope_type=?2,scope_id=?3,updated_at=GREATEST(updated_at, ?4) WHERE id=?1",
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
                updated_at=GREATEST(updated_at, ?8) WHERE id=?1",
            params![id,name,description.is_some(),description.and_then(|patch| patch.value),
                definition.as_ref().map(|patch| &patch.kind),definition.as_ref().map(|patch| patch.schema_version),
                definition.as_ref().map(|patch| &patch.definition_json),updated_at],
        )?,
        Mutation::DeleteBlueprint { id } => tx.execute("DELETE FROM blueprints WHERE id=?1", [id])?,
    };
    Ok(if changed == 0 {
        Status::Missing
    } else {
        Status::Changed
    })
}
