use crate::Result;
use rusqlite::{Connection, Row};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    task_id: String,
    revision: i64,
    legacy_migrated: bool,
    state: &'static str,
    artifacts: Vec<Descriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Source {
    WorkspaceFile {
        entry_file: String,
        root_dir: String,
    },
    ManagedContent {
        storage_path: String,
        root_dir: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    id: String,
    task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    space_id: Option<String>,
    kind: String,
    source: Source,
    version: i64,
    capabilities: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by_tool_call_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl Descriptor {
    fn read(row: &Row<'_>, id: String, task_id: &str) -> Result<Self> {
        let root_dir = row.get("root_dir")?;
        let source = if row.get::<_, String>("source_type")? == "managed-content" {
            Source::ManagedContent {
                storage_path: row
                    .get::<_, Option<String>>("storage_path")?
                    .unwrap_or_default(),
                root_dir,
            }
        } else {
            Source::WorkspaceFile {
                entry_file: row
                    .get::<_, Option<String>>("entry_file")?
                    .unwrap_or_default(),
                root_dir,
            }
        };
        Ok(Self {
            id,
            task_id: task_id.into(),
            space_id: row.get("space_id")?,
            kind: row.get("kind")?,
            source,
            version: row.get("version")?,
            capabilities: serde_json::from_str(&row.get::<_, String>("capabilities_json")?)?,
            title: row.get("title")?,
            mime_type: row.get("mime_type")?,
            created_by_message_id: row.get("created_by_message_id")?,
            created_by_tool_call_id: row.get("created_by_tool_call_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

pub fn read(db: &Connection, task_ids: &[String]) -> Result<Vec<Snapshot>> {
    let mut stmt = db.prepare_cached(
        "SELECT q.value AS requested_task_id, coalesce(r.revision, 0) AS task_revision,
                s.task_id IS NOT NULL AS legacy_migrated, a.*
         FROM json_each(?1) q
         LEFT JOIN artifact_task_revisions r ON r.task_id = q.value
         LEFT JOIN artifact_task_state s ON s.task_id = q.value
         LEFT JOIN artifacts a ON a.task_id = q.value
         ORDER BY q.key, a.created_at, a.rowid",
    )?;
    let mut rows = stmt.query([serde_json::to_string(task_ids)?])?;
    let mut snapshots: Vec<Snapshot> = Vec::new();
    while let Some(row) = rows.next()? {
        let task_id: &str = row.get_ref("requested_task_id")?.as_str()?;
        if snapshots
            .last()
            .is_none_or(|snapshot| snapshot.task_id != task_id)
        {
            snapshots.push(Snapshot {
                task_id: task_id.into(),
                revision: row.get("task_revision")?,
                legacy_migrated: row.get("legacy_migrated")?,
                state: "ready",
                artifacts: Vec::new(),
                error: None,
            });
        }
        let snapshot = snapshots.last_mut().expect("every row belongs to a task");
        if snapshot.error.is_none()
            && let Some(id) = row.get("id")?
        {
            match Descriptor::read(row, id, task_id) {
                Ok(artifact) => snapshot.artifacts.push(artifact),
                Err(error) => {
                    snapshot.artifacts.clear();
                    snapshot.revision = 0;
                    snapshot.state = "error";
                    snapshot.error = Some(error.to_string());
                }
            }
        }
    }
    Ok(snapshots)
}
