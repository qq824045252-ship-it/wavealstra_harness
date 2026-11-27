use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

struct Candidate {
    id: String,
    status: String,
    scope_type: String,
    scope_id: Option<String>,
    sources_json: String,
    signature: String,
}

pub(super) fn read(
    db: &Connection,
    installed_skill_id: &str,
    candidate_id: &str,
    mut package_sources: Vec<String>,
) -> Result<Value> {
    let installed_skill_id = installed_skill_id.trim().to_lowercase();
    package_sources.sort_unstable();
    package_sources.dedup();
    if installed_skill_id.is_empty() || candidate_id.is_empty() || package_sources.is_empty() {
        return Ok(json!({"kind":"installedSkillGrounding","grounded":null}));
    }
    let snapshot = db.unchecked_transaction()?;
    let grounded = check(
        &snapshot,
        &installed_skill_id,
        candidate_id,
        &package_sources,
    )?;
    snapshot.commit()?;
    Ok(json!({"kind":"installedSkillGrounding","grounded":grounded}))
}

fn check(
    db: &Connection,
    installed_skill_id: &str,
    candidate_id: &str,
    package_sources: &[String],
) -> Result<Option<Value>> {
    let candidate = db
        .query_row(
            "SELECT id,status,scope_type,scope_id,source_memory_ids_json,source_signature
         FROM memory_skill_candidates WHERE lower(installed_skill_id)=?1
         ORDER BY updated_at DESC,id ASC LIMIT 1",
            [installed_skill_id],
            |row| {
                Ok(Candidate {
                    id: row.get(0)?,
                    status: row.get(1)?,
                    scope_type: row.get(2)?,
                    scope_id: row.get(3)?,
                    sources_json: row.get(4)?,
                    signature: row.get(5)?,
                })
            },
        )
        .optional()?;
    let Some(candidate) = candidate.filter(|candidate| candidate.status == "materialized") else {
        return Ok(None);
    };
    let Ok(source_ids) = serde_json::from_str::<Vec<String>>(&candidate.sources_json) else {
        return Ok(None);
    };
    let Some(source_id) = source_ids.first() else {
        return Ok(None);
    };
    let mut sorted_sources: Vec<&str> = source_ids.iter().map(String::as_str).collect();
    sorted_sources.sort_unstable();
    if !sorted_sources
        .into_iter()
        .eq(package_sources.iter().map(String::as_str))
    {
        return Ok(None);
    }
    if approved_revision(db, installed_skill_id, &candidate.id, package_sources)?.as_deref()
        != Some(candidate_id)
    {
        return Ok(None);
    }

    let active_count: i64 = db.query_row(
        "SELECT COUNT(*) FROM memory_records WHERE status='active' AND kind='procedure'
         AND id IN (SELECT json_extract_string(value,'$') FROM json_each(?1))",
        [&candidate.sources_json],
        |row| row.get(0),
    )?;
    if usize::try_from(active_count)? != source_ids.len() {
        return Ok(None);
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as f64;
    let primary: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT content_hash,source_task_id FROM memory_records WHERE id=?1
         AND (valid_from IS NULL OR valid_from<=?2) AND (valid_until IS NULL OR valid_until>?2)",
            params![source_id, now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((content_hash, source_task_id)) = primary else {
        return Ok(None);
    };
    let Some((scope_type, scope_id)) = reusable_scope(db, source_id, source_task_id.as_deref())?
    else {
        return Ok(None);
    };
    if scope_type != candidate.scope_type || scope_id != candidate.scope_id {
        return Ok(None);
    }
    let signature = [
        source_id.as_str(),
        content_hash.as_str(),
        scope_type,
        scope_id.as_deref().unwrap_or(""),
    ]
    .join("\n");
    if format!("{:x}", Sha256::digest(signature.as_bytes())) != candidate.signature {
        return Ok(None);
    }
    Ok(Some(
        json!({"candidateId":candidate_id,"scopeType":scope_type,"scopeId":scope_id,
        "sourceSignature":candidate.signature}),
    ))
}

fn approved_revision(
    db: &Connection,
    installed_skill_id: &str,
    base_id: &str,
    package_sources: &[String],
) -> Result<Option<String>> {
    let mut current = base_id.to_owned();
    let mut seen = HashSet::new();
    let mut next = db.prepare(
        "SELECT id,source_memory_ids_json FROM memory_skill_revision_candidates
         WHERE lower(skill_id)=?1 AND base_candidate_id=?2 AND status='materialized'
           AND materialized_candidate_id=id AND materialized_version IS NOT NULL AND resolved_at IS NOT NULL
         ORDER BY resolved_at DESC,id ASC LIMIT 1",
    )?;
    while seen.insert(current.clone()) {
        let child: Option<(String, String)> = next
            .query_row(params![installed_skill_id, &current], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        let Some((child_id, source_json)) = child else {
            return Ok(Some(current));
        };
        let Ok(mut sources) = serde_json::from_str::<Vec<String>>(&source_json) else {
            return Ok(None);
        };
        sources.sort_unstable();
        if sources != package_sources {
            return Ok(None);
        }
        current = child_id;
    }
    Ok(None)
}

fn reusable_scope(
    db: &Connection,
    memory_id: &str,
    source_task_id: Option<&str>,
) -> Result<Option<(&'static str, Option<String>)>> {
    let mut statement = db.prepare(
        "SELECT scope_type,scope_id FROM memory_scopes WHERE memory_id=?1 ORDER BY created_at,rowid",
    )?;
    let scopes: Vec<(String, Option<String>)> = statement
        .query_map([memory_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<duckdb::Result<_>>()?;
    let work_ids: Vec<&str> = scopes
        .iter()
        .filter_map(|(kind, id)| (kind == "work").then_some(id.as_deref()).flatten())
        .collect();
    if work_ids.is_empty() {
        return Ok(["bot", "global", "project", "workspace"]
            .into_iter()
            .find_map(|kind| {
                scopes
                    .iter()
                    .find(|(scope, _)| scope.as_str() == kind)
                    .map(|(_, id)| (kind, id.clone()))
            }));
    }
    if let Some((_, project_id)) = scopes.iter().find(|(kind, _)| kind == "project") {
        return Ok(Some(("project", project_id.clone())));
    }
    let ([work_id], Some(task_id)) = (work_ids.as_slice(), source_task_id) else {
        return Ok(None);
    };
    if db
        .prepare("SELECT 1 FROM work_teams WHERE work_id=?1")?
        .exists([*work_id])?
    {
        return Ok(None);
    }
    // The exact Task binding proves who executed the historical Work procedure.
    let mut statement = db.prepare(
        "SELECT DISTINCT b.bot_id,w.project_id FROM work_execution_bindings b
         JOIN works w ON w.work_id=b.work_id
         JOIN bots bot ON bot.bot_id=b.bot_id AND bot.user_id=w.user_id
         WHERE b.work_id=?1 AND b.task_id=?2 AND b.status NOT IN ('invalidated','unknown') LIMIT 2",
    )?;
    let bindings: Vec<(String, Option<String>)> = statement
        .query_map(params![*work_id, task_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<duckdb::Result<_>>()?;
    match bindings.as_slice() {
        [(bot_id, project_id)] if project_id.as_deref().unwrap_or("").is_empty() => {
            Ok(Some(("bot", Some(bot_id.clone()))))
        }
        _ => Ok(None),
    }
}
