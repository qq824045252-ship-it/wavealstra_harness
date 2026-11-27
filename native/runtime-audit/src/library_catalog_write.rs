use crate::{
    Result,
    library_backup::{self, Owner},
    library_metadata::ITEMS,
    library_text, scoped_notes,
    sqlite_rows::records,
};
use duckdb::{Connection, OptionalExt, params};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Edit {
    Space {
        id: String,
        name: Option<String>,
        owner: Owner,
        ensure: bool,
        root: PathBuf,
        welcome: Option<Welcome>,
    },
    RenameSpace {
        id: String,
        name: String,
    },
    Folder {
        id: String,
        space_id: String,
        name: String,
        parent_id: Option<String>,
    },
    RenameFolder {
        id: String,
        name: String,
    },
    MoveFolder {
        id: String,
        parent_id: Option<String>,
    },
    Item {
        id: String,
        title: Option<String>,
        collection_id: Option<String>,
        change_collection: bool,
    },
}
#[derive(Deserialize)]
pub struct Welcome {
    title: String,
    content: String,
}

fn writable(db: &Connection, space: &str) -> Result<()> {
    let (p, w): (Option<String>, Option<String>) = db.query_row(
        "SELECT project_id,workspace_id FROM library_spaces WHERE id=?",
        [space],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if !scoped_notes::library_owner_writable(db, p.as_deref(), w.as_deref())? {
        return Err("归档资料只读".into());
    }
    Ok(())
}
fn row(db: &Connection, sql: &str, id: &str) -> Result<Value> {
    records(db, sql, [id])?
        .pop()
        .ok_or_else(|| "资料已不存在".into())
}
fn space_row(db: &Connection, id: &str) -> Result<Value> {
    row(
        db,
        "SELECT l.*,p.name AS project_name,s.name AS workspace_name FROM library_spaces l LEFT JOIN projects p ON p.id=l.project_id LEFT JOIN spaces s ON s.id=l.workspace_id WHERE l.id=?",
        id,
    )
}
fn folder_parent(db: &Connection, space: &str, parent: Option<&str>, id: &str) -> Result<()> {
    if let Some(p) = parent {
        if !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_collections WHERE id=? AND space_id=?)",
            params![p, space],
            |r| r.get::<_, bool>(0),
        )? {
            return Err("目标集合不存在或不属于同一空间".into());
        }
        if db.query_row("WITH RECURSIVE chain(id,parent_id) AS (SELECT id,parent_id FROM library_collections WHERE id=? UNION SELECT f.id,f.parent_id FROM library_collections f JOIN chain c ON c.parent_id=f.id) SELECT EXISTS(SELECT 1 FROM chain WHERE id=?)",params![p,id],|r|r.get::<_,bool>(0))? {return Err("不能把集合移入自身或子集合".into());}
    }
    Ok(())
}
pub fn apply(db: &Connection, edit: Edit, at: i64) -> Result<Value> {
    match edit {
        Edit::Space {
            id,
            name,
            owner,
            ensure,
            root,
            welcome,
        } => {
            let personal = ensure && matches!(owner, Owner::Personal);
            if ensure {
                let existing = if personal {
                    db.query_row(
                        "SELECT id FROM library_spaces WHERE id='personal'",
                        [],
                        |r| r.get(0),
                    )
                    .optional()?
                } else {
                    library_backup::spaces(db, &owner)?.into_iter().next()
                };
                if let Some(existing) = existing {
                    return space_row(db, &existing);
                }
            }
            let (project, workspace, default_name) = match &owner {
                Owner::Personal => (None, None, "我的文档".to_string()),
                Owner::Project { project_id } => (
                    Some(project_id),
                    None,
                    db.query_row(
                        "SELECT left(name,80)||'资料' FROM projects WHERE id=?",
                        [project_id],
                        |r| r.get(0),
                    )?,
                ),
                Owner::Workspace { workspace_id } => (
                    None,
                    Some(workspace_id),
                    db.query_row(
                        "SELECT left(coalesce(name,'工作空间'),80)||'资料' FROM spaces WHERE id=?",
                        [workspace_id],
                        |r| r.get(0),
                    )?,
                ),
            };
            if !scoped_notes::library_owner_writable(
                db,
                project.map(String::as_str),
                workspace.map(String::as_str),
            )? {
                return Err("归档资料只读".into());
            }
            let operation = id;
            let id = if personal { "personal" } else { &operation };
            if !root.is_absolute() || !crate::library_restore::valid_id(id) {
                return Err("资料位置无效".into());
            }
            let dir = root.join(id);
            fs::create_dir_all(&dir)?;
            if fs::symlink_metadata(&dir)?.file_type().is_symlink()
                || fs::canonicalize(&dir)?.parent() != Some(fs::canonicalize(&root)?.as_path())
            {
                return Err("资料目录不安全".into());
            }
            db.execute("INSERT INTO library_spaces(id,name,kind,project_id,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",params![id,name.unwrap_or(default_name),if personal{"personal"}else{"team"},project,workspace,at,at])?;
            if personal && let Some(welcome) = welcome {
                let note = "mybuddy-personal-welcome";
                let filename = format!("{}.md", welcome.title);
                let path = library_text::managed_path(&root, id, note, &filename);
                let bytes = welcome.content.as_bytes();
                if let Some(mut original) = library_text::open_managed(&root, &path, id, note)? {
                    let mut hash = Sha256::new();
                    std::io::copy(&mut original, &mut hash)?;
                    if hash.finalize() != Sha256::digest(bytes) {
                        return Err("已有其它同名文件，无法创建欢迎笔记".into());
                    }
                } else {
                    let staged = crate::library_restore::stage(&path, bytes, &operation, note)?;
                    let publish = crate::library_restore::commit_staged(&path, &operation, note);
                    fs::remove_file(staged)?;
                    publish?;
                }
                db.execute("INSERT INTO library_items(id,space_id,kind,title,filename,mime_type,size_bytes,owner,source_type,created_at,updated_at,last_visited_at) VALUES(?,?,'markdown',?,?,'text/markdown',?,coalesce(nullif(trim((SELECT name FROM soul WHERE id=1)),''),'我'),'created',?,?,?)",params![note,id,welcome.title,filename,bytes.len(),at,at,at])?;
            }
            space_row(db, id)
        }
        Edit::RenameSpace { id, name } => {
            writable(db, &id)?;
            if db.execute(
                "UPDATE library_spaces SET name=?,updated_at=? WHERE id=? AND kind<>'personal'",
                params![name, at, id],
            )? != 1
            {
                return Err("个人文档空间不能改名".into());
            }
            space_row(db, &id)
        }
        Edit::Folder {
            id,
            space_id,
            name,
            parent_id,
        } => {
            writable(db, &space_id)?;
            folder_parent(db, &space_id, parent_id.as_deref(), &id)?;
            db.execute("INSERT INTO library_collections(id,space_id,parent_id,name,owner,created_at,updated_at) VALUES(?,?,?,?,coalesce(nullif(trim((SELECT name FROM soul WHERE id=1)),''),'我'),?,?)",params![id,space_id,parent_id,name,at,at])?;
            row(db, "SELECT * FROM library_collections WHERE id=?", &id)
        }
        Edit::RenameFolder { id, name } => {
            let space: String = db.query_row(
                "SELECT space_id FROM library_collections WHERE id=?",
                [&id],
                |r| r.get(0),
            )?;
            writable(db, &space)?;
            db.execute(
                "UPDATE library_collections SET name=?,updated_at=? WHERE id=?",
                params![name, at, id],
            )?;
            row(db, "SELECT * FROM library_collections WHERE id=?", &id)
        }
        Edit::MoveFolder { id, parent_id } => {
            let space: String = db.query_row(
                "SELECT space_id FROM library_collections WHERE id=?",
                [&id],
                |r| r.get(0),
            )?;
            writable(db, &space)?;
            folder_parent(db, &space, parent_id.as_deref(), &id)?;
            db.execute(
                "UPDATE library_collections SET parent_id=?,updated_at=? WHERE id=?",
                params![parent_id, at, id],
            )?;
            row(db, "SELECT * FROM library_collections WHERE id=?", &id)
        }
        Edit::Item {
            id,
            title,
            collection_id,
            change_collection,
        } => {
            let sql =
                format!("SELECT {ITEMS} FROM library_items WHERE id=? AND trashed_at IS NULL");
            let old = row(db, &sql, &id)?;
            let space = old["space_id"].as_str().ok_or("空间不存在")?;
            writable(db, space)?;
            if change_collection {
                folder_parent(db, space, collection_id.as_deref(), "")?;
            }
            let next = title
                .as_deref()
                .or(old["title"].as_str())
                .ok_or("资料标题不存在")?;
            let filename = if title.is_none() {
                old["filename"].as_str().ok_or("资料文件名无效")?.to_owned()
            } else {
                let project: Option<String> = db.query_row(
                    "SELECT project_id FROM library_spaces WHERE id=?",
                    [space],
                    |r| r.get(0),
                )?;
                if project.is_none() && next.encode_utf16().count() > 200 {
                    return Err("资料标题过长".into());
                }
                let ext = Path::new(old["filename"].as_str().unwrap_or(""))
                    .extension()
                    .and_then(|s| s.to_str());
                ext.map_or_else(|| next.to_string(), |ext| format!("{next}.{ext}"))
            };
            let folder = if change_collection {
                collection_id.as_deref()
            } else {
                old["collection_id"].as_str()
            };
            if old["title"].as_str() != Some(next) || old["collection_id"].as_str() != folder {
                db.execute("UPDATE library_items SET title=?,filename=?,collection_id=?,updated_at=GREATEST(updated_at+1,?) WHERE id=?",params![next,filename,folder,at,id])?;
                if title.is_some() {
                    let body: Option<String> = db
                        .query_row(
                            "SELECT body FROM search_documents WHERE doc_key=?",
                            [format!("library:{id}")],
                            |r| r.get(0),
                        )
                        .optional()?;
                    crate::library_index::refresh_item_fts(
                        db,
                        &id,
                        Some(body.as_deref().unwrap_or("")),
                    )?;
                }
            }
            row(db, &sql, &id)
        }
    }
}
