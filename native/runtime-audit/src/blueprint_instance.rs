use crate::{
    Result,
    blueprint_storage::{Directories, Storage},
    workbench_write::{Gadget, GadgetOrigin, create_gadget},
};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    blueprint_id: String,
    created_at: i64,
    workspaces: Vec<Workspace>,
    tasks: Vec<Task>,
    library_bindings: Vec<Binding>,
    contexts: Vec<Context>,
    gadgets: Vec<Gadget>,
    storage: Option<Storage>,
}

impl Instance {
    pub(crate) fn resources(
        &self,
        operation_id: &str,
    ) -> Vec<crate::resource_gate::ResourceRequirement> {
        use crate::resource_gate::{ResourceKey, ResourceRequirement};
        let mut plan = vec![
            ResourceRequirement::exclusive(ResourceKey::Entity(
                "blueprint-operation".into(),
                operation_id.into(),
            )),
            ResourceRequirement::shared(ResourceKey::Entity(
                "blueprint".into(),
                self.blueprint_id.clone(),
            )),
            ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "workspaces".into(),
            )),
            ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "library".into())),
            ResourceRequirement::shared(ResourceKey::Namespace(
                "domain".into(),
                "blueprint-storage".into(),
            )),
            ResourceRequirement::shared(crate::workbench_write::gadget_namespace()),
        ];
        plan.extend(self.gadgets.iter().map(|gadget| {
            ResourceRequirement::exclusive(ResourceKey::Entity("gadget".into(), gadget.id().into()))
        }));
        plan
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    parent_id: Option<String>,
    name: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    workspace_id: String,
    title: String,
    status: String,
    welcome_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    workspace_id: String,
    library_space_id: String,
    optional: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    id: String,
    workspace_id: String,
    scope_id: String,
    revision_id: String,
    title: String,
    content: String,
    content_hash: String,
    metadata_json: String,
    created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Status {
    Committed { skipped_libraries: Vec<String> },
    MissingBlueprint,
    MissingLibrary { id: String },
    DuplicateWorkspace { name: String },
    ScopeChanged,
    Failed { message: String },
}

pub fn write(db: &mut Connection, operation_id: &str, instance: Instance) -> Result<Status> {
    let mut directories = Directories::default();
    match write_instance(db, operation_id, instance, &mut directories) {
        Ok(status) => {
            directories.finalize();
            Ok(status)
        }
        Err(error) => {
            let recovery = db.transaction()?;
            if let Some(status) = receipt(&recovery, operation_id)? {
                directories.finalize();
                return Ok(status);
            }
            directories.discard();
            Ok(Status::Failed {
                message: error.to_string(),
            })
        }
    }
}

fn receipt(db: &Connection, operation_id: &str) -> Result<Option<Status>> {
    let json: Option<String> = db
        .query_row(
            "SELECT result_json FROM blueprint_instance_receipts WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|json| Ok(serde_json::from_str(&json)?))
        .transpose()
}

fn write_instance(
    db: &mut Connection,
    operation_id: &str,
    instance: Instance,
    directories: &mut Directories,
) -> Result<Status> {
    let tx = db.transaction()?;
    if let Some(status) = receipt(&tx, operation_id)? {
        return Ok(status);
    }
    if !tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM blueprints WHERE id=?1)",
        [&instance.blueprint_id],
        |row| row.get::<_, bool>(0),
    )? {
        return Ok(Status::MissingBlueprint);
    }

    let workspace_paths = instance.storage.as_ref().map(|_| {
        instance
            .workspaces
            .iter()
            .map(|workspace| (workspace.id.clone(), PathBuf::from(&workspace.path)))
            .collect::<Vec<_>>()
    });
    let mut workspace_ids = HashSet::new();
    for workspace in instance.workspaces {
        if workspace
            .parent_id
            .as_ref()
            .is_some_and(|id| !workspace_ids.contains(id))
        {
            return Ok(Status::ScopeChanged);
        }
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM spaces WHERE parent_id IS NOT DISTINCT FROM ?1 AND lower(name)=lower(?2))",
            params![workspace.parent_id, workspace.name],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(Status::DuplicateWorkspace {
                name: workspace.name,
            });
        }
        tx.execute(
            "INSERT INTO spaces(id,parent_id,name,path,sort_order,created_at,updated_at)
             VALUES (?1,?2,?3,?4,(SELECT coalesce(max(sort_order),0)+1000 FROM spaces WHERE parent_id IS NOT DISTINCT FROM ?2),?5,?5)",
            params![workspace.id, workspace.parent_id, workspace.name, workspace.path, instance.created_at],
        )?;
        workspace_ids.insert(workspace.id);
    }

    for task in instance.tasks {
        if !workspace_ids.contains(&task.workspace_id) {
            return Ok(Status::ScopeChanged);
        }
        tx.execute("INSERT INTO tasks(id,space_id,title,status,welcome_mode,updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![task.id, task.workspace_id, task.title, task.status, task.welcome_mode, instance.created_at])?;
    }

    let mut skipped_libraries = Vec::new();
    for binding in instance.library_bindings {
        if !workspace_ids.contains(&binding.workspace_id) {
            return Ok(Status::ScopeChanged);
        }
        if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_spaces WHERE id=?1)",
            [&binding.library_space_id],
            |row| row.get::<_, bool>(0),
        )? {
            if !binding.optional {
                return Ok(Status::MissingLibrary {
                    id: binding.library_space_id,
                });
            }
            skipped_libraries.push(binding.library_space_id);
            continue;
        }
        tx.execute("INSERT INTO workspace_library_links(workspace_id,library_space_id,created_at) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
            params![binding.workspace_id, binding.library_space_id, instance.created_at])?;
    }

    for context in instance.contexts {
        if !workspace_ids.contains(&context.workspace_id) {
            return Ok(Status::ScopeChanged);
        }
        insert_context(&tx, context)?;
    }
    let gadget_ids = instance.storage.as_ref().map(|_| {
        instance
            .gadgets
            .iter()
            .map(|gadget| gadget.id().to_owned())
            .collect::<HashSet<_>>()
    });
    for gadget in instance.gadgets {
        if create_gadget(&tx, gadget, GadgetOrigin::Generated)? == 0 {
            return Ok(Status::ScopeChanged);
        }
    }
    if let (Some(storage), Some(workspace_paths), Some(gadget_ids)) =
        (instance.storage, workspace_paths, gadget_ids)
    {
        storage.materialize(operation_id, &workspace_paths, &gadget_ids, directories)?;
    }
    let status = Status::Committed { skipped_libraries };
    tx.execute(
        "INSERT INTO blueprint_instance_receipts(operation_id,result_json) VALUES (?1,?2)",
        params![operation_id, serde_json::to_string(&status)?],
    )?;
    tx.execute(
        "DELETE FROM blueprint_instance_receipts WHERE rowid <= (SELECT COALESCE(MAX(rowid), 0) - 2048 FROM blueprint_instance_receipts)",
        [],
    )?;
    crate::request_control::commit(tx)?;
    Ok(status)
}

fn insert_context(db: &Connection, context: Context) -> duckdb::Result<()> {
    db.execute("INSERT INTO memory_records(id,kind,title,content,status,importance,confidence,explicit,source_type,
        content_hash,created_at,updated_at,metadata_json) VALUES (?1,'constraint',?2,?3,'active',1,1,1,'import',?4,?5,?5,?6)",
        params![context.id, context.title, context.content, context.content_hash, context.created_at, context.metadata_json])?;
    db.execute(
        "INSERT INTO memory_scopes(id,memory_id,scope_type,scope_id,binding,created_at)
        VALUES (?1,?2,'workspace',?3,'owned',?4)",
        params![
            context.scope_id,
            context.id,
            context.workspace_id,
            context.created_at
        ],
    )?;
    db.execute("INSERT INTO memory_revisions(id,memory_id,revision,kind,title,content,status,importance,confidence,changed_by,change_reason,created_at)
        VALUES (?1,?2,1,'constraint',?3,?4,'active',1,1,'import','created',?5)",
        params![context.revision_id, context.id, context.title, context.content, context.created_at])?;
    Ok(())
}
