use crate::{Result, memory_records_data};
use rusqlite::{Connection, ErrorCode, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[path = "memory_record_forget.rs"]
pub(crate) mod forget;
#[path = "memory_record_scopes.rs"]
mod scopes;

const DOTS_TASK_ID: &str = "mybuddy-dots";

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Create {
        record: CreateRecord,
        scope: Scope,
        revision: Revision,
        user_id: String,
    },
    Update {
        record: Record,
        expected_revision: i64,
        revision: Revision,
    },
    Forget {
        id: String,
        withdrawal: forget::Withdrawal,
    },
    PromoteScope {
        id: String,
        scope: Scope,
        user_id: String,
        now: i64,
    },
    DetachScope {
        id: String,
        scope_type: String,
        scope_id: Option<String>,
        withdrawal: forget::Withdrawal,
    },
    RejectCandidate {
        id: String,
        at: i64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    id: String,
    kind: String,
    title: String,
    content: String,
    status: String,
    importance: i64,
    confidence: f64,
    explicit: bool,
    valid_from: Option<f64>,
    valid_until: Option<f64>,
    content_hash: String,
    updated_at: i64,
    metadata_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRecord {
    #[serde(flatten)]
    record: Record,
    created_at: i64,
    source_type: String,
    source_id: Option<String>,
    source_task_id: Option<String>,
    evidence: Vec<Evidence>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    id: String,
    evidence_kind: String,
    ref_id: String,
    ref_title: Option<String>,
    excerpt: Option<String>,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    id: String,
    scope_type: String,
    scope_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    revision_id: String,
    changed_at: i64,
    changed_by: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Applied { record: Value },
    Forgotten { refresh_dots: bool },
    Detached { forgotten: bool },
    CandidateRejected,
    NeedsHost,
    Stale,
    Rejected { message: String },
}

pub fn write(db: &mut Connection, request: Request) -> Reply {
    match apply(db, request) {
        Ok(reply) => reply,
        Err(error) => {
            if error
                .downcast_ref::<rusqlite::Error>()
                .and_then(rusqlite::Error::sqlite_error_code)
                .is_some_and(|code| {
                    matches!(code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
                })
            {
                return Reply::NeedsHost;
            }
            Reply::Rejected {
                message: error.to_string(),
            }
        }
    }
}

fn apply(db: &mut Connection, request: Request) -> Result<Reply> {
    if let Request::Forget { id, withdrawal } = request {
        return forget::apply(db, &id, withdrawal);
    }
    if let Request::PromoteScope {
        id,
        scope,
        user_id,
        now,
    } = request
    {
        return scopes::promote(db, &id, scope, &user_id, now);
    }
    if let Request::DetachScope {
        id,
        scope_type,
        scope_id,
        withdrawal,
    } = request
    {
        return scopes::detach(db, &id, &scope_type, scope_id.as_deref(), withdrawal);
    }
    if let Request::RejectCandidate { id, at } = request {
        memory_records_data::candidates::reject(db, &id, at)?;
        return Ok(Reply::CandidateRejected);
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (record, revision, number, is_update, procedure_changed) = match request {
        Request::Create {
            record,
            scope,
            revision,
            user_id,
        } => {
            assert_scope(&tx, &scope, &user_id)?;
            insert(&tx, &record, &scope)?;
            let procedure = record.record.kind == "procedure";
            (record.record, revision, 1, false, procedure)
        }
        Request::Update {
            record,
            expected_revision,
            revision,
        } => {
            let previous = tx
                .prepare_cached("SELECT kind,status,content_hash FROM memory_records WHERE id=?1")?
                .query_row([&record.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .optional()?
                .ok_or_else(|| format!("记忆不存在：{}", record.id))?;
            let actual = memory_records_data::revision(&tx, &record.id)?;
            if actual != expected_revision {
                return Ok(Reply::Stale);
            }
            let archived: bool = tx
                .prepare_cached(
                    "SELECT EXISTS(SELECT 1 FROM memory_scopes s JOIN projects p ON p.id=s.scope_id
                 WHERE s.memory_id=?1 AND s.scope_type='project' AND p.archived=1)",
                )?
                .query_row([&record.id], |row| row.get(0))?;
            if archived {
                return Err("项目已归档（只读），不能修改其关联记忆".into());
            }
            update(&tx, &record)?;
            let procedure_changed = (previous.0 == "procedure" || record.kind == "procedure")
                && (previous.0 != record.kind
                    || previous.1 != record.status
                    || previous.2 != record.content_hash);
            (record, revision, actual + 1, true, procedure_changed)
        }
        Request::Forget { .. }
        | Request::PromoteScope { .. }
        | Request::DetachScope { .. }
        | Request::RejectCandidate { .. } => unreachable!(),
    };
    tx.prepare_cached(
        "INSERT INTO memory_revisions(id,memory_id,revision,kind,title,content,status,importance,
         confidence,valid_from,valid_until,changed_by,change_reason,created_at)
         SELECT ?1,id,?2,kind,title,content,status,importance,confidence,valid_from,valid_until,?3,?4,?5
         FROM memory_records WHERE id=?6",
    )?.execute(params![revision.revision_id, number, revision.changed_by, revision.reason, revision.changed_at, record.id])?;
    invalidate_projections(&tx, &record.id, revision.changed_at, is_update)?;
    if procedure_changed {
        tx.prepare_cached(
            "UPDATE memory_skill_candidates SET status='stale',updated_at=?2
             WHERE status IN ('draft','ready','materialized')
               AND EXISTS (SELECT 1 FROM json_each(source_memory_ids_json) WHERE value=?1)",
        )?
        .execute(params![record.id, revision.changed_at])?;
    }
    tx.prepare_cached(
        "UPDATE projects SET updated_at=MAX(updated_at+1,?2)
         WHERE id IN (SELECT scope_id FROM memory_scopes WHERE memory_id=?1 AND scope_type='project')",
    )?.execute(params![record.id, record.updated_at])?;
    let mut detail = memory_records_data::detail(&tx, &record.id)?;
    if detail.is_null() {
        return Ok(Reply::NeedsHost);
    }
    let saved = detail["record"].take();
    if saved.is_null() {
        return Err(format!("记忆保存后不可读取：{}", record.id).into());
    }
    tx.commit()?;
    Ok(Reply::Applied { record: saved })
}

fn assert_scope(db: &Connection, scope: &Scope, user_id: &str) -> Result<()> {
    if scope.scope_type == "global" {
        return if scope.scope_id.is_none() {
            Ok(())
        } else {
            Err("global 记忆不能携带 scopeId".into())
        };
    }
    let Some(id) = scope.scope_id.as_deref().filter(|id| !id.trim().is_empty()) else {
        return Err(format!("{} 记忆必须携带 scopeId", scope.scope_type).into());
    };
    if scope.scope_type == "project" {
        let archived = db
            .prepare_cached("SELECT archived FROM projects WHERE id=?1")?
            .query_row([id], |row| row.get::<_, bool>(0))
            .optional()?;
        return match archived {
            Some(false) => Ok(()),
            Some(true) => Err("项目已归档（只读），不能写入项目记忆".into()),
            None => Err(format!("项目不存在：{id}").into()),
        };
    }
    let (sql, message) = match scope.scope_type.as_str() {
        "bot" => ("SELECT 1 FROM bots WHERE bot_id=?1", "Bot 不存在".to_owned()),
        "conversation" => (
            "SELECT 1 FROM bot_conversations c JOIN bots b ON b.bot_id=c.bot_id AND b.user_id=c.user_id
             WHERE c.conversation_id=?1 AND c.user_id=?2", "对话不存在".to_owned()
        ),
        "work" => ("SELECT 1 FROM works WHERE work_id=?1 AND user_id=?2", "Work 不存在".to_owned()),
        "team" => ("SELECT 1 FROM work_team_templates WHERE template_id=?1 AND user_id=?2", "团队不存在".to_owned()),
        "workspace" => ("SELECT 1 FROM spaces WHERE id=?1", format!("工作空间不存在：{id}")),
        "task" => ("SELECT 1 FROM tasks WHERE id=?1", format!("任务不存在：{id}")),
        _ => return Err("记忆作用域类型非法".into()),
    };
    let mut statement = db.prepare_cached(sql)?;
    let exists = if statement.parameter_count() == 2 {
        statement.exists(params![id, user_id])?
    } else {
        statement.exists([id])?
    };
    if exists { Ok(()) } else { Err(message.into()) }
}

fn insert(db: &Connection, create: &CreateRecord, scope: &Scope) -> rusqlite::Result<()> {
    let r = &create.record;
    db.prepare_cached(
        "INSERT INTO memory_records(id,kind,title,content,status,importance,confidence,explicit,source_type,
         source_id,source_task_id,valid_from,valid_until,content_hash,created_at,updated_at,metadata_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
    )?.execute(params![r.id, r.kind, r.title, r.content, r.status, r.importance, r.confidence, r.explicit,
        create.source_type, create.source_id, create.source_task_id, r.valid_from, r.valid_until, r.content_hash,
        create.created_at, r.updated_at, r.metadata_json])?;
    db.prepare_cached(
        "INSERT INTO memory_scopes(id,memory_id,scope_type,scope_id,binding,created_at)
         VALUES (?1,?2,?3,?4,'owned',?5)",
    )?
    .execute(params![
        scope.id,
        r.id,
        scope.scope_type,
        scope.scope_id,
        create.created_at
    ])?;
    let mut evidence = db.prepare_cached(
        "INSERT INTO memory_evidence(id,memory_id,evidence_kind,ref_id,ref_title,excerpt,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(memory_id,evidence_kind,ref_id) DO NOTHING",
    )?;
    for e in &create.evidence {
        evidence.execute(params![
            e.id,
            r.id,
            e.evidence_kind,
            e.ref_id,
            e.ref_title,
            e.excerpt,
            e.created_at
        ])?;
    }
    Ok(())
}

fn update(db: &Connection, r: &Record) -> rusqlite::Result<()> {
    db.prepare_cached(
        "UPDATE memory_records SET kind=?2,title=?3,content=?4,status=?5,importance=?6,confidence=?7,
         explicit=?8,valid_from=?9,valid_until=?10,content_hash=?11,updated_at=?12,metadata_json=?13 WHERE id=?1",
    )?.execute(params![r.id, r.kind, r.title, r.content, r.status, r.importance, r.confidence, r.explicit,
        r.valid_from, r.valid_until, r.content_hash, r.updated_at, r.metadata_json])?;
    Ok(())
}

fn invalidate_projections(
    db: &Connection,
    id: &str,
    now: i64,
    is_update: bool,
) -> rusqlite::Result<()> {
    for table in ["memory_scenarios", "memory_core_profiles"] {
        db.prepare_cached(&format!(
            "UPDATE {table} AS target SET status='stale',updated_at=?2 WHERE status='active'
             AND EXISTS(SELECT 1 FROM memory_scopes s WHERE s.memory_id=?1
                 AND s.scope_type IN ('global','workspace','project') AND s.scope_type=target.scope_type
                 AND s.scope_id IS target.scope_id)",
        ))?.execute(params![id, now])?;
    }
    if is_update {
        let has_dots: bool = db.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM memory_scopes WHERE memory_id=?1 AND scope_type='task' AND scope_id=?2)",
        )?.query_row(params![id, DOTS_TASK_ID], |row| row.get(0))?;
        if has_dots {
            db.prepare_cached(
                "UPDATE memory_core_profiles AS p SET status='stale',updated_at=?2 WHERE status='active'
                 AND EXISTS(SELECT 1 FROM json_each(p.source_scenario_ids_json) j
                   JOIN memory_scenarios s ON s.id=j.value AND s.status='active'
                   WHERE EXISTS(SELECT 1 FROM json_each(s.source_memory_ids_json) WHERE value=?1))",
            )?.execute(params![id, now])?;
            db.prepare_cached(
                "UPDATE memory_scenarios AS s SET status='stale',updated_at=?2 WHERE status='active'
                 AND EXISTS(SELECT 1 FROM json_each(s.source_memory_ids_json) WHERE value=?1)",
            )?.execute(params![id, now])?;
        }
    }
    Ok(())
}
