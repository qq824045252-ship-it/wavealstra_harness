use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    GetSettings,
    SetSettings {
        mode: Option<String>,
        set_decision_model: bool,
        decision_model: Option<String>,
    },
    GetScope {
        scope: Option<Scope>,
    },
    SetScope {
        scope: Scope,
        mode: Option<String>,
    },
}

impl Request {
    pub(crate) fn is_read(&self) -> bool {
        matches!(self, Self::GetSettings | Self::GetScope { .. })
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    Space { id: String },
    Project { id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    mode: String,
    decision_model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSettings {
    #[serde(rename = "override")]
    override_mode: Option<String>,
    effective: String,
    source: &'static str,
    source_id: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Settings { settings: Settings },
    Scope { settings: ScopeSettings },
    Rejected { message: String },
}

pub fn run(db: &mut Connection, request: Request) -> Reply {
    apply(db, request).unwrap_or_else(|error| Reply::Rejected {
        message: error.to_string(),
    })
}

fn apply(db: &mut Connection, request: Request) -> Result<Reply> {
    let tx = db.transaction()?;
    let reply = match request {
        Request::GetSettings => Reply::Settings {
            settings: settings(&tx)?,
        },
        Request::SetSettings {
            mode,
            set_decision_model,
            decision_model,
        } => {
            let mut next = settings(&tx)?;
            if let Some(mode) = mode {
                next.mode = mode;
            }
            if set_decision_model {
                next.decision_model = decision_model;
            }
            validate_mode(&next.mode)?;
            if next
                .decision_model
                .as_ref()
                .is_some_and(|model| model.trim_matches(js_whitespace).is_empty())
            {
                return Err("无效的 SAG2 决策模型".into());
            }
            tx.prepare(
                "INSERT INTO material_retrieval_settings (singleton, mode, decision_model)
                 VALUES (1, ?1, ?2)
                 ON CONFLICT(singleton) DO UPDATE SET
                 mode = excluded.mode, decision_model = excluded.decision_model",
            )?
            .execute(params![next.mode, next.decision_model])?;
            Reply::Settings { settings: next }
        }
        Request::GetScope { scope } => Reply::Scope {
            settings: effective_scope(&tx, scope.as_ref())?,
        },
        Request::SetScope { scope, mode } => {
            set_scope(&tx, &scope, mode.as_deref())?;
            Reply::Scope {
                settings: effective_scope(&tx, Some(&scope))?,
            }
        }
    };
    tx.commit()?;
    Ok(reply)
}

fn settings(db: &Connection) -> duckdb::Result<Settings> {
    Ok(db
        .prepare(
            "SELECT mode, decision_model FROM material_retrieval_settings WHERE singleton = 1",
        )?
        .query_row([], |row| {
            Ok(Settings {
                mode: row.get(0)?,
                decision_model: row.get(1)?,
            })
        })
        .optional()?
        .unwrap_or(Settings {
            mode: "hybrid".into(),
            decision_model: None,
        }))
}

struct SpacePolicy {
    parent: Option<String>,
    mode: Option<String>,
    archived: bool,
}

fn space_policy(db: &Connection, id: &str) -> duckdb::Result<Option<SpacePolicy>> {
    db.prepare(
        "SELECT s.parent_id, o.mode, s.archived FROM spaces s
         LEFT JOIN material_retrieval_spaces o ON s.id = o.id WHERE s.id = ?1",
    )?
    .query_row([id], |row| {
        Ok(SpacePolicy {
            parent: row.get(0)?,
            mode: row.get(1)?,
            archived: row.get(2)?,
        })
    })
    .optional()
}

struct ProjectPolicy {
    space: Option<String>,
    mode: Option<String>,
    archived: bool,
}

fn project_policy(db: &Connection, id: &str) -> duckdb::Result<Option<ProjectPolicy>> {
    db.prepare(
        "SELECT p.default_space_id, o.mode, p.archived FROM projects p
         LEFT JOIN material_retrieval_projects o ON p.id = o.id WHERE p.id = ?1",
    )?
    .query_row([id], |row| {
        Ok(ProjectPolicy {
            space: row.get(0)?,
            mode: row.get(1)?,
            archived: row.get(2)?,
        })
    })
    .optional()
}

fn walk_spaces<T>(
    db: &Connection,
    mut space: Option<String>,
    find: impl Fn(&SpacePolicy) -> Option<T>,
) -> duckdb::Result<Option<(String, T)>> {
    let mut seen = HashSet::new();
    while let Some(id) = space.filter(|id| !id.is_empty()) {
        if !seen.insert(id.clone()) {
            break;
        }
        let Some(policy) = space_policy(db, &id)? else {
            break;
        };
        if let Some(found) = find(&policy) {
            return Ok(Some((id, found)));
        }
        space = policy.parent;
    }
    Ok(None)
}

fn effective_scope(db: &Connection, scope: Option<&Scope>) -> duckdb::Result<ScopeSettings> {
    let (space_id, override_mode) = match scope {
        Some(Scope::Project { id }) => match project_policy(db, id)? {
            Some(ProjectPolicy {
                mode: Some(mode), ..
            }) => {
                return Ok(ScopeSettings {
                    override_mode: Some(mode.clone()),
                    effective: mode,
                    source: "project",
                    source_id: Some(id.clone()),
                });
            }
            Some(ProjectPolicy { space, .. }) => (space, None),
            None => (None, None),
        },
        Some(Scope::Space { id }) => {
            let policy = space_policy(db, id)?;
            (Some(id.clone()), policy.and_then(|policy| policy.mode))
        }
        None => (None, None),
    };
    if let Some((id, mode)) = walk_spaces(db, space_id, |policy| policy.mode.clone())? {
        return Ok(ScopeSettings {
            override_mode,
            effective: mode,
            source: "space",
            source_id: Some(id),
        });
    }
    Ok(ScopeSettings {
        override_mode,
        effective: settings(db)?.mode,
        source: "global",
        source_id: None,
    })
}

fn set_scope(db: &Connection, scope: &Scope, mode: Option<&str>) -> Result<()> {
    let (id, table) = match scope {
        Scope::Project { id } => {
            let project = project_policy(db, id)?.ok_or("资料检索范围已不存在")?;
            if project.archived
                || walk_spaces(db, project.space, |policy| policy.archived.then_some(()))?.is_some()
            {
                return Err("归档项目的资料检索设置为只读".into());
            }
            (id, "material_retrieval_projects")
        }
        Scope::Space { id } => {
            if space_policy(db, id)?.is_none() {
                return Err("资料检索范围已不存在".into());
            }
            if walk_spaces(db, Some(id.clone()), |policy| policy.archived.then_some(()))?.is_some()
            {
                return Err("归档空间的资料检索设置为只读".into());
            }
            (id, "material_retrieval_spaces")
        }
    };
    if let Some(mode) = mode {
        validate_mode(mode)?;
        db.prepare(&format!(
            "INSERT INTO {table} (id, mode) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET mode = excluded.mode"
        ))?
        .execute(params![id, mode])?;
    } else {
        db.prepare(&format!("DELETE FROM {table} WHERE id = ?1"))?
            .execute([id])?;
    }
    Ok(())
}

fn validate_mode(mode: &str) -> Result<()> {
    if matches!(mode, "keyword" | "hybrid") {
        Ok(())
    } else {
        Err("未知的资料检索方式".into())
    }
}

fn js_whitespace(value: char) -> bool {
    matches!(
        value,
        '\u{9}'..='\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}
