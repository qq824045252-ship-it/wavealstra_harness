use crate::Result;
use duckdb::{Connection, Row, params};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    workspaces: Vec<Workspace>,
    spaces: Vec<LibrarySpace>,
    collections: Vec<Collection>,
    references: Vec<Reference>,
    owned_item_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    name: String,
    parent_id: Option<String>,
    archived: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySpace {
    id: String,
    name: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    project_archived: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Collection {
    id: String,
    space_id: String,
    parent_id: Option<String>,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    workspace_id: String,
    library_space_id: String,
    collection_id: Option<String>,
}

pub fn read(db: &mut Connection, id: &str) -> Result<Option<Snapshot>> {
    let tx = db.transaction()?;
    if !tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM spaces WHERE id=?1)",
        [id],
        |row| row.get::<_, bool>(0),
    )? {
        return Ok(None);
    }
    let workspaces = all(
        &tx,
        "WITH RECURSIVE involved(id,name,parent_id,archived) AS (
             SELECT id,name,parent_id,archived FROM spaces WHERE id=?1 OR id IN (
                 SELECT workspace_id FROM library_spaces WHERE workspace_id IS NOT NULL)
             UNION SELECT s.id,s.name,s.parent_id,s.archived FROM spaces s JOIN involved i ON s.id=i.parent_id
         ) SELECT id,name,parent_id,archived FROM involved",
        [id],
        |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                archived: row.get(3)?,
            })
        },
    )?;
    let spaces = all(&tx, "SELECT l.id,l.name,l.kind,l.project_id,l.workspace_id,coalesce(p.archived,0)
                           FROM library_spaces l LEFT JOIN projects p ON p.id=l.project_id
                           ORDER BY CASE l.kind WHEN 'personal' THEN 0 ELSE 1 END,l.created_at,l.rowid", [], |row| {
        Ok(LibrarySpace { id: row.get(0)?, name: row.get(1)?, kind: row.get(2)?, project_id: row.get(3)?,
                          workspace_id: row.get(4)?, project_archived: row.get(5)? })
    })?;
    let collections = all(
        &tx,
        "SELECT id,space_id,parent_id,name FROM library_collections ORDER BY lower(name),rowid",
        [],
        |row| {
            Ok(Collection {
                id: row.get(0)?,
                space_id: row.get(1)?,
                parent_id: row.get(2)?,
                name: row.get(3)?,
            })
        },
    )?;
    let references = all(&tx, "WITH RECURSIVE context(id,parent_id) AS (
                                SELECT id,parent_id FROM spaces WHERE id=?1
                                UNION SELECT s.id,s.parent_id FROM spaces s JOIN context c ON s.id=c.parent_id
                              ), refs AS (
                                SELECT w.workspace_id,w.library_space_id,NULL AS collection_id,w.created_at,0 AS kind
                                FROM workspace_library_links w JOIN context c ON c.id=w.workspace_id
                                UNION ALL
                                SELECT w.workspace_id,w.library_space_id,w.collection_id,w.created_at,1 AS kind
                                FROM workspace_library_collection_links w JOIN context c ON c.id=w.workspace_id
                              )
                              SELECT workspace_id,library_space_id,collection_id FROM refs
                              ORDER BY kind,created_at,coalesce(collection_id,library_space_id)", [id], |row| {
        Ok(Reference { workspace_id: row.get(0)?, library_space_id: row.get(1)?, collection_id: row.get(2)? })
    })?;
    let owned_item_count = tx.query_row(
        "SELECT count(*) FROM library_items i JOIN library_spaces s ON s.id=i.space_id
                                        WHERE s.workspace_id=?1 AND i.trashed_at IS NULL",
        [id],
        |row| row.get(0),
    )?;
    tx.commit()?;
    Ok(Some(Snapshot {
        workspaces,
        spaces,
        collections,
        references,
        owned_item_count,
    }))
}

fn all<T>(
    db: &Connection,
    sql: &str,
    params: impl duckdb::Params,
    map: impl FnMut(&Row<'_>) -> duckdb::Result<T>,
) -> Result<Vec<T>> {
    Ok(db
        .prepare(sql)?
        .query_map(params, map)?
        .collect::<duckdb::Result<_>>()?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    kind: Kind,
    workspace_id: String,
    library_space_id: String,
    collection_id: Option<String>,
    at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    Bind,
    Unbind,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Saved,
    Rejected { message: String },
}

pub fn write(db: &mut Connection, mutation: Mutation) -> Reply {
    match apply(db, mutation) {
        Ok(()) => Reply::Saved,
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn apply(db: &mut Connection, mutation: Mutation) -> Result<()> {
    let tx = db.transaction()?;
    let workspace = &mutation.workspace_id;
    let library = &mutation.library_space_id;
    let (exists, archived): (bool, bool) = tx.query_row(
        "WITH RECURSIVE ancestors(id,parent_id,archived) AS (
            SELECT id,parent_id,archived FROM spaces WHERE id=?1
            UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN ancestors a ON s.id=a.parent_id
         ) SELECT count(*)>0,coalesce(bool_or(archived!=0),FALSE) FROM ancestors",
        [workspace], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if !exists {
        return Err("工作空间不存在".into());
    }
    if archived {
        return Err("归档工作空间只可读取资料".into());
    }
    if matches!(mutation.kind, Kind::Bind) {
        let found: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_spaces WHERE id=?1)",
            [library],
            |row| row.get(0),
        )?;
        if !found {
            return Err("资料库空间不存在".into());
        }
        if let Some(collection) = &mutation.collection_id {
            let found: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_collections WHERE id=?1 AND space_id=?2)",
                params![collection, library],
                |row| row.get(0),
            )?;
            if !found {
                return Err("资料库文件夹不存在或不属于该资料库".into());
            }
        }
    }
    match (mutation.kind, mutation.collection_id) {
        (Kind::Bind, Some(collection)) => tx.execute("INSERT INTO workspace_library_collection_links
            (workspace_id,library_space_id,collection_id,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING",
            params![workspace, library, collection, mutation.at])?,
        (Kind::Bind, None) => tx.execute("INSERT INTO workspace_library_links(workspace_id,library_space_id,created_at)
            VALUES(?1,?2,?3) ON CONFLICT DO NOTHING", params![workspace, library, mutation.at])?,
        (Kind::Unbind, Some(collection)) => tx.execute("DELETE FROM workspace_library_collection_links
            WHERE workspace_id=?1 AND collection_id=?2", params![workspace, collection])?,
        (Kind::Unbind, None) => tx.execute("DELETE FROM workspace_library_links WHERE workspace_id=?1 AND library_space_id=?2",
            params![workspace, library])?,
    };
    tx.commit()?;
    Ok(())
}
