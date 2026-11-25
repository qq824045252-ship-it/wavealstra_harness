use crate::{
    project_memory_forget::{self, Withdrawal, invalidate_projections},
    project_write::{Status, touch, writable_project_scope},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    id: String,
    evidence_kind: String,
    ref_id: String,
    ref_title: Option<String>,
    excerpt: Option<String>,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    id: String,
    kind: String,
    title: String,
    content: String,
    status: String,
    importance: i64,
    confidence: f64,
    explicit: bool,
    source_type: String,
    source_task_id: Option<String>,
    content_hash: String,
    created_at: i64,
    metadata_json: String,
    scope_row_id: String,
    revision_id: String,
    evidence: Vec<Evidence>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    event_id: String,
    id: String,
    promoted_by: String,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    id: String,
    kind: String,
    title: String,
    content: String,
    status: String,
    importance: i64,
    content_hash: String,
    metadata_json: String,
    updated_at: i64,
    expected_revision: i64,
    revision_id: String,
}

impl Evidence {
    fn belongs_to_project(&self, db: &Connection, project: &str) -> rusqlite::Result<bool> {
        let sql = match self.evidence_kind.as_str() {
            "library_item" => "SELECT EXISTS(SELECT 1 FROM library_items i LEFT JOIN library_spaces s ON s.id=i.space_id
                WHERE i.id=?1 AND (s.kind='personal' OR s.project_id IS NULL OR s.project_id=?2))",
            "task" => "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND (project_id IS NULL OR project_id=?2))",
            "artifact" => "SELECT EXISTS(SELECT 1 FROM artifacts a LEFT JOIN tasks t ON t.id=a.task_id
                WHERE a.id=?1 AND (t.project_id IS NULL OR t.project_id=?2))",
            "project_event" => "SELECT EXISTS(SELECT 1 FROM project_events WHERE id=?1 AND project_id=?2)",
            _ => return Ok(false),
        };
        db.query_row(sql, params![self.ref_id, project], |row| row.get(0))
    }
}

pub fn create(
    db: &Connection,
    project: &str,
    memory: Memory,
    actor_task_id: Option<&str>,
    promotion: Option<Promotion>,
) -> rusqlite::Result<Status> {
    let status = writable_project_scope(db, project, actor_task_id)?;
    if status != Status::Changed {
        return Ok(status);
    }
    let event_title = if let Some(link) = &promotion {
        let title = db
            .query_row(
                "SELECT title FROM project_events WHERE id=?1 AND project_id=?2",
                params![link.event_id, project],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(title) = title else {
            return Ok(Status::MissingEvent);
        };
        if db.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_event_promotions WHERE project_id=?1 AND event_id=?2 AND target_kind='memory')",
            params![project, link.event_id], |row| row.get::<_, bool>(0),
        )? {
            return Ok(Status::ExistingPromotion);
        }
        Some(title)
    } else {
        None
    };
    for evidence in &memory.evidence {
        if !evidence.belongs_to_project(db, project)? {
            return Ok(Status::InvalidEvidence);
        }
    }
    insert_memory(db, project, &memory)?;
    if let (Some(link), Some(title)) = (promotion, event_title) {
        let inserted = db.execute(
            "INSERT INTO project_event_promotions(id,project_id,event_id,event_title,target_kind,target_id,target_title,promoted_by,created_at)
             VALUES (?1,?2,?3,?4,'memory',?5,?6,?7,?8)",
            params![link.id, project, link.event_id, title, memory.id, memory.title, link.promoted_by, link.created_at],
        )?;
        if inserted != 1 {
            return Err(rusqlite::Error::StatementChangedRows(inserted));
        }
    }
    invalidate_projections(db, project, memory.created_at)?;
    touch(db, project, memory.created_at)?;
    Ok(Status::Changed)
}

pub fn edit(
    db: &Connection,
    project: &str,
    edit: Edit,
    actor_task_id: Option<&str>,
) -> rusqlite::Result<Status> {
    let status = writable_project_scope(db, project, actor_task_id)?;
    if status != Status::Changed {
        return Ok(status);
    }
    let current = db.query_row(
        "SELECT m.kind,m.status,m.content_hash,
           (SELECT coalesce(max(revision),0) FROM memory_revisions WHERE memory_id=m.id),
           EXISTS (SELECT 1 FROM memory_scopes WHERE memory_id=m.id AND (scope_type<>'project' OR scope_id IS NOT ?2))
         FROM memory_records m WHERE m.id=?1 AND EXISTS
           (SELECT 1 FROM memory_scopes WHERE memory_id=m.id AND scope_type='project' AND scope_id=?2)",
        params![edit.id, project],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?, row.get::<_, bool>(4)?)),
    ).optional()?;
    let Some((previous_kind, previous_status, previous_hash, revision, shared)) = current else {
        return Ok(Status::MissingMemory);
    };
    if shared {
        return Ok(Status::SharedMemory);
    }
    if revision != edit.expected_revision {
        return Ok(Status::Stale);
    }
    let changed = db.execute(
        "UPDATE memory_records SET kind=?2,title=?3,content=?4,status=?5,importance=?6,
           content_hash=?7,metadata_json=?8,updated_at=?9 WHERE id=?1",
        params![
            edit.id,
            edit.kind,
            edit.title,
            edit.content,
            edit.status,
            edit.importance,
            edit.content_hash,
            edit.metadata_json,
            edit.updated_at
        ],
    )?;
    if changed != 1 {
        return Err(rusqlite::Error::StatementChangedRows(changed));
    }
    let versioned = db.execute(
        "INSERT INTO memory_revisions(id,memory_id,revision,kind,title,content,status,importance,confidence,
           valid_from,valid_until,changed_by,change_reason,created_at)
         SELECT ?1,id,?2,kind,title,content,status,importance,confidence,valid_from,valid_until,'manual','project UI update',updated_at
         FROM memory_records WHERE id=?3",
        params![edit.revision_id, revision + 1, edit.id],
    )?;
    if versioned != 1 {
        return Err(rusqlite::Error::StatementChangedRows(versioned));
    }
    if (previous_kind == "procedure" || edit.kind == "procedure")
        && (previous_kind != edit.kind
            || previous_status != edit.status
            || previous_hash != edit.content_hash)
    {
        db.execute(
            "UPDATE memory_skill_candidates SET status='stale',updated_at=?2
             WHERE status IN ('draft','ready','materialized')
               AND EXISTS (SELECT 1 FROM json_each(source_memory_ids_json) WHERE value=?1)",
            params![edit.id, edit.updated_at],
        )?;
    }
    invalidate_projections(db, project, edit.updated_at)?;
    touch(db, project, edit.updated_at)?;
    Ok(Status::Changed)
}

pub fn detach(
    db: &Connection,
    project: &str,
    id: &str,
    withdrawal: Withdrawal,
) -> rusqlite::Result<Status> {
    let status = writable_project_scope(db, project, None)?;
    if status != Status::Changed {
        return Ok(status);
    }
    let bound: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_scopes WHERE memory_id=?1 AND scope_type='project' AND scope_id=?2)",
        params![id, project],
        |row| row.get(0),
    )?;
    if !bound {
        return Ok(Status::Unchanged);
    }
    if !project_memory_forget::is_current(db, project, Some(id), &withdrawal)? {
        return Ok(Status::Stale);
    }
    project_memory_forget::detach(db, project, Some(id), &withdrawal)?;
    touch(db, project, withdrawal.cutoff_at)?;
    Ok(Status::Changed)
}

fn insert_memory(db: &Connection, project: &str, memory: &Memory) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO memory_records(id,kind,title,content,status,importance,confidence,explicit,source_type,
                source_task_id,content_hash,created_at,updated_at,metadata_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13)",
        params![memory.id, memory.kind, memory.title, memory.content, memory.status, memory.importance,
            memory.confidence, memory.explicit, memory.source_type, memory.source_task_id,
            memory.content_hash, memory.created_at, memory.metadata_json],
    )?;
    db.execute(
        "INSERT INTO memory_scopes(id,memory_id,scope_type,scope_id,binding,created_at) VALUES (?1,?2,'project',?3,'owned',?4)",
        params![memory.scope_row_id, memory.id, project, memory.created_at],
    )?;
    let mut insert_evidence = db.prepare(
        "INSERT INTO memory_evidence(id,memory_id,evidence_kind,ref_id,ref_title,excerpt,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(memory_id,evidence_kind,ref_id) DO NOTHING",
    )?;
    for evidence in &memory.evidence {
        insert_evidence.execute(params![
            evidence.id,
            memory.id,
            evidence.evidence_kind,
            evidence.ref_id,
            evidence.ref_title,
            evidence.excerpt,
            evidence.created_at
        ])?;
    }
    db.execute(
        "INSERT INTO memory_revisions(id,memory_id,revision,kind,title,content,status,importance,confidence,changed_by,change_reason,created_at)
         VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9,'created',?10)",
        params![memory.revision_id, memory.id, memory.kind, memory.title, memory.content, memory.status,
            memory.importance, memory.confidence, memory.source_type, memory.created_at],
    )?;
    Ok(())
}
