//! Rust-owned Batch 2 transactional writes (`Step 4 Stage 4.2`, `RC-09`/`RC-10`):
//! project folder relocation, external agent runs, code review snapshots/decisions,
//! task board daily notes, task expert bindings, conversation branches, and
//! task/workspace lifecycle metadata.

use crate::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, named_params, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMove {
    id: String,
    new_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMove {
    id: String,
    project_id: String,
    new_path: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    RelocateProjectFolder {
        now: i64,
        folders: Vec<FolderMove>,
        references: Vec<ResourceMove>,
        affected_project_ids: Vec<String>,
    },
    ExternalAgentRecoverInterrupted {
        now: i64,
    },
    ExternalAgentInsertRun {
        id: String,
        task_id: String,
        agent_id: String,
        agent_name: String,
        status: String,
        cwd: String,
        user_message_id: String,
        assistant_message_id: String,
        prompt: String,
        display_text: String,
        attachments_json: String,
        started_at: i64,
        continued_from_run_id: Option<String>,
        continuation_mode: Option<String>,
    },
    ExternalAgentSetContinuationMode {
        id: String,
        mode: String,
    },
    ExternalAgentSetCapabilities {
        id: String,
        resume_supported: i64,
        cancel_supported: i64,
    },
    ExternalAgentSetRecovery {
        id: String,
        state: String,
        message: Option<String>,
    },
    ExternalAgentSetWorkspaceObservation {
        id: String,
        artifact_refs_json: String,
    },
    ExternalAgentSetCancellationEvidence {
        id: String,
        evidence: String,
    },
    ExternalAgentUpdateRun {
        id: String,
        status: String,
        session_id: Option<String>,
        completed_at: Option<i64>,
        error: Option<String>,
        cancel_supported: i64,
    },
    ExternalAgentAppendText {
        id: String,
        column: String,
        delta: String,
        output_cursor: i64,
    },
    ExternalAgentWriteTools {
        id: String,
        tools_json: String,
        output_cursor: i64,
    },
    CodeReviewUpdateAfterStamp {
        id: String,
        after_stamp: String,
    },
    CodeReviewDelete {
        id: String,
    },
    CodeReviewUpsert {
        task_id: String,
        target_key: String,
        root_entity: String,
        path: String,
        relative_path: String,
        id: String,
        before_present: i64,
        before_stamp: String,
        before_bytes_base64: Option<String>,
        before_mode: Option<i64>,
        after_present: i64,
        after_stamp: String,
        after_bytes_base64: Option<String>,
        after_mode: Option<i64>,
        additions: i64,
        deletions: i64,
        stats_available: i64,
        capture_reason: Option<String>,
    },
    CodeReviewSetRestoring {
        id: String,
    },
    CodeReviewSetFailure {
        id: String,
        reason: String,
    },
    CodeReviewFinish {
        id: String,
        status: String,
    },
    TaskBoardNote {
        id: String,
        kind_name: String,
        detail: String,
        at: i64,
    },
    TaskExpertInstallFrozen {
        task_id: String,
        desired_json: String,
        active_json: String,
        desired_skills_json: String,
        active_skills_json: String,
        updated_at: i64,
    },
    TaskExpertWriteLegacyFailure {
        task_id: String,
        warnings_json: String,
        updated_at: i64,
    },
    TaskExpertWriteDesired {
        task_id: String,
        expected_desired_json: Option<String>,
        desired_json: Option<String>,
        desired_skills_json: String,
        updated_at: i64,
    },
    TaskExpertPromote {
        task_id: String,
        updated_at: i64,
    },
    BindTaskExecutionWorkspaceCwd {
        task_id: String,
        cwd: String,
        at: i64,
    },
    AddTaskWriteGrant {
        task_id: String,
        path: String,
        at: i64,
    },
    DeleteTaskWriteGrant {
        task_id: String,
        path: String,
    },
    ArchiveTask {
        id: String,
        archived: bool,
        at: i64,
    },
    UpsertTaskExecutionWorkspaceState {
        task_id: String,
        directory_name: String,
        state: String,
        created_at: i64,
        updated_at: i64,
        trashed_at: Option<i64>,
        purge_after: Option<i64>,
        trash_path: Option<String>,
    },
    DeleteTaskExecutionWorkspaceState {
        task_id: String,
    },
    DeleteTask {
        id: String,
    },
    CommitTaskWorkspaceTrashed {
        task_id: String,
        directory_name: String,
        created_at: Option<i64>,
        trashed_at: i64,
        purge_after: i64,
        trash_path: Option<String>,
    },
    CommitTaskWorkspaceAdopt {
        task_id: String,
        workspace_dir: String,
        directory_name: String,
        now: i64,
    },
    OpenDots {
        at: i64,
    },
    UpsertSpaceRaw {
        id: String,
        name: String,
        path: Option<String>,
        parent_id: Option<String>,
        has_parent: bool,
        sort_order: Option<f64>,
        has_sort_order: bool,
        at: i64,
    },
    CreateConversationBranch {
        child_task_id: String,
        parent_task_id: String,
        root_task_id: String,
        parent_title_snapshot: String,
        source_session_file: String,
        source_leaf_entry_id: String,
        source_user_message_index: i64,
        request_id: String,
        position: String,
        workspace_strategy: String,
        created_at: i64,
        task_title: String,
        task_space_id: Option<String>,
        task_project_id: Option<String>,
        task_status: Option<String>,
        task_updated_at: i64,
        task_session_file: Option<String>,
        task_cwd: Option<String>,
        task_welcome_mode: Option<String>,
        task_model_id: Option<String>,
        task_permission_mode: Option<String>,
        task_expert_id: Option<String>,
        task_mode_preset_id: Option<String>,
    },
    RebindLegacyTaskWorkspacePaths {
        cwd_updates: Vec<(String, String)>,
        trash_updates: Vec<(String, String)>,
    },
}

fn decode_optional_bytes(encoded: Option<String>) -> Result<Option<Vec<u8>>> {
    let Some(raw) = encoded else {
        return Ok(None);
    };
    Ok(Some(STANDARD.decode(raw)?))
}

fn bind_task_cwd_tx(tx: &rusqlite::Transaction<'_>, task_id: &str, cwd: &str, at: i64) -> Result<()> {
    let exists: Option<String> = tx
        .query_row("SELECT title FROM tasks WHERE id = ?1", [task_id], |r| r.get(0))
        .optional()?;
    if exists.is_some() {
        tx.execute(
            "UPDATE tasks SET cwd = ?1, updated_at = ?2 WHERE id = ?3",
            params![cwd, at, task_id],
        )?;
        return Ok(());
    }
    let title = if task_id.starts_with("gw-") {
        "助理消息"
    } else if task_id.starts_with("cron-") {
        "定时任务"
    } else {
        "新任务"
    };
    tx.execute(
        "INSERT INTO tasks (id, title, updated_at, cwd) VALUES (?1, ?2, ?3, ?4)",
        params![task_id, title, at, cwd],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upsert_ws_state_tx(
    tx: &rusqlite::Transaction<'_>,
    task_id: &str,
    directory_name: &str,
    state: &str,
    created_at: i64,
    updated_at: i64,
    trashed_at: Option<i64>,
    purge_after: Option<i64>,
    trash_path: Option<&str>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO task_execution_workspace_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(task_id) DO UPDATE SET
           directory_name = excluded.directory_name,
           state = excluded.state,
           updated_at = excluded.updated_at,
           trashed_at = excluded.trashed_at,
           purge_after = excluded.purge_after,
           trash_path = excluded.trash_path",
        params![
            task_id,
            directory_name,
            state,
            created_at,
            updated_at,
            trashed_at,
            purge_after,
            trash_path
        ],
    )?;
    Ok(())
}

pub fn run(db: &mut Connection, request: Request) -> Result<Value> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let out = match request {
        Request::RelocateProjectFolder {
            now,
            folders,
            references,
            affected_project_ids,
        } => {
            let mut update_space =
                tx.prepare("UPDATE spaces SET path = ?1, updated_at = ?2 WHERE id = ?3")?;
            for f in folders {
                update_space.execute(params![f.new_path, now, f.id])?;
            }
            drop(update_space);
            let mut update_res = tx.prepare(
                "UPDATE project_resources SET value = ?1, updated_at = ?2 WHERE id = ?3 AND project_id = ?4",
            )?;
            for r in references {
                update_res.execute(params![r.new_path, now, r.id, r.project_id])?;
            }
            drop(update_res);
            let mut update_proj = tx.prepare(
                "UPDATE projects SET updated_at = MAX(updated_at + 1, ?1) WHERE id = ?2",
            )?;
            for pid in affected_project_ids {
                update_proj.execute(params![now, pid])?;
            }
            drop(update_proj);
            json!({ "ok": true })
        }
        Request::ExternalAgentRecoverInterrupted { now } => {
            tx.execute(
                "UPDATE external_agent_runs
                   SET status='failed',
                       completed_at=COALESCE(completed_at, ?1),
                       error=COALESCE(error, 'MyBuddy 已重启，上一轮外部子任务已中断。'),
                       recovery_state=CASE
                         WHEN session_id IS NOT NULL AND resume_supported=1 THEN 'resume-available'
                         ELSE 'new-run-required'
                       END,
                       cancel_supported=0,
                       recovery_message=CASE
                         WHEN session_id IS NOT NULL AND resume_supported=1 THEN '应用重启后原进程已不存在；可基于原 session 续聊，续聊前请先核对工作目录与已有产物。'
                         ELSE '应用重启后原进程已不存在，且没有可恢复 session；请核对已有输出/产物后新建执行。'
                       END
                 WHERE status IN ('starting','working','blocked')",
                [now],
            )?;
            tx.execute(
                "UPDATE external_agent_runs SET cancellation_evidence='unconfirmed' WHERE cancellation_evidence='requested'",
                [],
            )?;
            json!({ "ok": true })
        }
        Request::ExternalAgentInsertRun {
            id,
            task_id,
            agent_id,
            agent_name,
            status,
            cwd,
            user_message_id,
            assistant_message_id,
            prompt,
            display_text,
            attachments_json,
            started_at,
            continued_from_run_id,
            continuation_mode,
        } => {
            tx.execute(
                "INSERT INTO external_agent_runs (
                   id, task_id, agent_id, agent_name, protocol, status, cwd,
                   user_message_id, assistant_message_id, prompt, display_text, attachments_json, started_at,
                   continued_from_run_id, continuation_mode
                 ) VALUES (?1, ?2, ?3, ?4, 'acp', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    id,
                    task_id,
                    agent_id,
                    agent_name,
                    status,
                    cwd,
                    user_message_id,
                    assistant_message_id,
                    prompt,
                    display_text,
                    attachments_json,
                    started_at,
                    continued_from_run_id,
                    continuation_mode
                ],
            )?;
            json!({ "ok": true })
        }
        Request::ExternalAgentSetContinuationMode { id, mode } => {
            tx.execute(
                "UPDATE external_agent_runs SET continuation_mode=?1 WHERE id=?2",
                params![mode, id],
            )?;
            json!({ "ok": true })
        }
        Request::ExternalAgentSetCapabilities {
            id,
            resume_supported,
            cancel_supported,
        } => {
            tx.execute(
                "UPDATE external_agent_runs SET resume_supported=?1, cancel_supported=?2 WHERE id=?3",
                params![resume_supported, cancel_supported, id],
            )?;
            json!({ "ok": true })
        }
        Request::ExternalAgentSetRecovery { id, state, message } => {
            tx.execute(
                "UPDATE external_agent_runs SET recovery_state=?1, recovery_message=?2 WHERE id=?3",
                params![state, message, id],
            )?;
            json!({ "ok": true })
        }
        Request::ExternalAgentSetWorkspaceObservation {
            id,
            artifact_refs_json,
        } => {
            tx.execute(
                "UPDATE external_agent_runs SET artifact_refs_json=?1, verification_status='workspace_observed' WHERE id=?2",
                params![artifact_refs_json, id],
            )?;
            json!({ "ok": true })
        }
        Request::ExternalAgentSetCancellationEvidence { id, evidence } => {
            tx.execute(
                "UPDATE external_agent_runs SET cancellation_evidence=?1 WHERE id=?2",
                params![evidence, id],
            )?;
            json!({ "ok": true })
        }
        Request::ExternalAgentUpdateRun {
            id,
            status,
            session_id,
            completed_at,
            error,
            cancel_supported,
        } => {
            tx.execute(
                "UPDATE external_agent_runs SET status=?1, session_id=COALESCE(?2, session_id),
                 completed_at=COALESCE(?3, completed_at), error=?4, cancel_supported=?5 WHERE id=?6",
                params![status, session_id, completed_at, error, cancel_supported, id],
            )?;
            json!({ "ok": true })
        }
        Request::ExternalAgentAppendText {
            id,
            column,
            delta,
            output_cursor,
        } => {
            let sql = match column.as_str() {
                "final_text" => {
                    "UPDATE external_agent_runs SET final_text = final_text || ?1, output_cursor=?2 WHERE id = ?3"
                }
                "thinking_text" => {
                    "UPDATE external_agent_runs SET thinking_text = thinking_text || ?1, output_cursor=?2 WHERE id = ?3"
                }
                _ => return Err(format!("invalid external_agent_runs text column: {column}").into()),
            };
            tx.execute(sql, params![delta, output_cursor, id])?;
            json!({ "ok": true })
        }
        Request::ExternalAgentWriteTools {
            id,
            tools_json,
            output_cursor,
        } => {
            tx.execute(
                "UPDATE external_agent_runs SET tools_json=?1, output_cursor=?2 WHERE id=?3",
                params![tools_json, output_cursor, id],
            )?;
            json!({ "ok": true })
        }
        Request::CodeReviewUpdateAfterStamp { id, after_stamp } => {
            tx.execute(
                "UPDATE task_code_review SET after_stamp = ?1 WHERE id = ?2",
                params![after_stamp, id],
            )?;
            json!({ "ok": true })
        }
        Request::CodeReviewDelete { id } => {
            tx.execute("DELETE FROM task_code_review WHERE id = ?1", [id])?;
            json!({ "ok": true })
        }
        Request::CodeReviewUpsert {
            task_id,
            target_key,
            root_entity,
            path,
            relative_path,
            id,
            before_present,
            before_stamp,
            before_bytes_base64,
            before_mode,
            after_present,
            after_stamp,
            after_bytes_base64,
            after_mode,
            additions,
            deletions,
            stats_available,
            capture_reason,
        } => {
            let before_bytes = decode_optional_bytes(before_bytes_base64)?;
            let after_bytes = decode_optional_bytes(after_bytes_base64)?;
            tx.execute(
                "INSERT OR REPLACE INTO task_code_review (
                   task_id, target_key, root_entity, path, relative_path, id, status,
                   before_present, before_stamp, before_bytes, before_mode,
                   after_present, after_stamp, after_bytes, after_mode, additions, deletions, stats_available, capture_reason
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    task_id,
                    target_key,
                    root_entity,
                    path,
                    relative_path,
                    id,
                    before_present,
                    before_stamp,
                    before_bytes,
                    before_mode,
                    after_present,
                    after_stamp,
                    after_bytes,
                    after_mode,
                    additions,
                    deletions,
                    stats_available,
                    capture_reason
                ],
            )?;
            json!({ "ok": true })
        }
        Request::CodeReviewSetRestoring { id } => {
            tx.execute("UPDATE task_code_review SET restoring = 1 WHERE id = ?1", [id])?;
            json!({ "ok": true })
        }
        Request::CodeReviewSetFailure { id, reason } => {
            tx.execute(
                "UPDATE task_code_review SET failure_reason = ?1 WHERE id = ?2",
                params![reason, id],
            )?;
            json!({ "ok": true })
        }
        Request::CodeReviewFinish { id, status } => {
            tx.execute(
                "UPDATE task_code_review SET status = ?1, failure_reason = NULL, restoring = 0 WHERE id = ?2",
                params![status, id],
            )?;
            json!({ "ok": true })
        }
        Request::TaskBoardNote {
            id,
            kind_name,
            detail,
            at,
        } => {
            tx.execute(
                "INSERT INTO task_board_days(id,kind,day,at,detail)
                 VALUES(?1,?2,date(?3/1000.0,'unixepoch','localtime'),?3,?4)
                 ON CONFLICT(id,kind,day) DO UPDATE SET at=excluded.at, detail=excluded.detail WHERE excluded.at>=at",
                params![id, kind_name, at, detail],
            )?;
            json!({ "ok": true })
        }
        Request::TaskExpertInstallFrozen {
            task_id,
            desired_json,
            active_json,
            desired_skills_json,
            active_skills_json,
            updated_at,
        } => {
            tx.execute(
                "INSERT INTO task_expert_bindings(task_id,desired_json,active_json,desired_skills_json,active_skills_json,warnings_json,updated_at)
                 VALUES (?1,?2,?3,?4,?5,'[]',?6)
                 ON CONFLICT(task_id) DO UPDATE SET
                   desired_json=excluded.desired_json,
                   active_json=excluded.active_json,
                   desired_skills_json=excluded.desired_skills_json,
                   active_skills_json=excluded.active_skills_json,
                   warnings_json='[]',
                   updated_at=excluded.updated_at",
                params![
                    task_id,
                    desired_json,
                    active_json,
                    desired_skills_json,
                    active_skills_json,
                    updated_at
                ],
            )?;
            json!({ "ok": true })
        }
        Request::TaskExpertWriteLegacyFailure {
            task_id,
            warnings_json,
            updated_at,
        } => {
            tx.execute(
                "INSERT INTO task_expert_bindings(task_id, desired_json, active_json, warnings_json, updated_at)
                 VALUES (?1, NULL, NULL, ?2, ?3)",
                params![task_id, warnings_json, updated_at],
            )?;
            tx.execute(
                "UPDATE tasks SET expert_id = NULL, updated_at = ?1 WHERE id = ?2",
                params![updated_at, task_id],
            )?;
            json!({ "ok": true })
        }
        Request::TaskExpertWriteDesired {
            task_id,
            expected_desired_json,
            desired_json,
            desired_skills_json,
            updated_at,
        } => {
            let current: Option<Option<String>> = tx
                .query_row(
                    "SELECT desired_json FROM task_expert_bindings WHERE task_id = ?1",
                    [&task_id],
                    |r| r.get(0),
                )
                .optional()?;
            let current_val = current.flatten();
            if current_val != expected_desired_json {
                return Err("人设已被修改，请刷新后重试".into());
            }
            tx.execute(
                "INSERT INTO task_expert_bindings(task_id, desired_json, active_json, desired_skills_json, active_skills_json, warnings_json, updated_at)
                 VALUES (?1, ?2, NULL, ?3, '[]', '[]', ?4) ON CONFLICT(task_id) DO UPDATE SET
                 desired_json=excluded.desired_json, desired_skills_json=excluded.desired_skills_json, warnings_json='[]', updated_at=excluded.updated_at",
                params![task_id, desired_json, desired_skills_json, updated_at],
            )?;
            json!({ "ok": true })
        }
        Request::TaskExpertPromote {
            task_id,
            updated_at,
        } => {
            tx.execute(
                "UPDATE task_expert_bindings SET active_json=desired_json,
                 active_skills_json=desired_skills_json, updated_at=?1 WHERE task_id=?2",
                params![updated_at, task_id],
            )?;
            json!({ "ok": true })
        }
        Request::BindTaskExecutionWorkspaceCwd { task_id, cwd, at } => {
            bind_task_cwd_tx(&tx, &task_id, &cwd, at)?;
            json!({ "ok": true })
        }
        Request::AddTaskWriteGrant { task_id, path, at } => {
            tx.execute(
                "INSERT INTO task_write_grants (task_id, path, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(task_id, path) DO NOTHING",
                params![task_id, path, at],
            )?;
            json!({ "ok": true })
        }
        Request::DeleteTaskWriteGrant { task_id, path } => {
            let changes = tx.execute(
                "DELETE FROM task_write_grants WHERE task_id = ?1 AND path = ?2",
                params![task_id, path],
            )?;
            json!({ "deleted": changes > 0 })
        }
        Request::ArchiveTask { id, archived, at } => {
            tx.execute(
                "UPDATE tasks SET archived = ?1, updated_at = max(updated_at, ?2) WHERE id = ?3",
                params![i64::from(archived), at, id],
            )?;
            json!({ "ok": true })
        }
        Request::UpsertTaskExecutionWorkspaceState {
            task_id,
            directory_name,
            state,
            created_at,
            updated_at,
            trashed_at,
            purge_after,
            trash_path,
        } => {
            upsert_ws_state_tx(
                &tx,
                &task_id,
                &directory_name,
                &state,
                created_at,
                updated_at,
                trashed_at,
                purge_after,
                trash_path.as_deref(),
            )?;
            json!({ "ok": true })
        }
        Request::DeleteTaskExecutionWorkspaceState { task_id } => {
            tx.execute(
                "DELETE FROM task_execution_workspace_state WHERE task_id = ?1",
                [task_id],
            )?;
            json!({ "ok": true })
        }
        Request::DeleteTask { id } => {
            tx.execute(
                "UPDATE memory_evidence
                 SET excerpt = COALESCE(NULLIF(excerpt,''), (
                   SELECT substr('用户：' || t.user_text || char(10) || '助手：' || t.assistant_text, 1, 1200)
                   FROM memory_turns t
                   WHERE t.id = memory_evidence.ref_id
                 ))
                 WHERE evidence_kind='conversation'
                   AND ref_id IN (SELECT id FROM memory_turns WHERE task_id=?1)",
                [&id],
            )?;
            tx.execute("DELETE FROM memory_turns WHERE task_id = ?1", [&id])?;
            tx.execute("DELETE FROM memory_pipeline_state WHERE task_id = ?1", [&id])?;
            tx.execute(
                "DELETE FROM memory_skill_effectiveness WHERE task_id = ?1",
                [&id],
            )?;
            tx.execute("DELETE FROM tasks WHERE id = ?1", [&id])?;
            tx.execute("DELETE FROM task_library_references WHERE task_id = ?1", [&id])?;
            json!({ "ok": true })
        }
        Request::CommitTaskWorkspaceTrashed {
            task_id,
            directory_name,
            created_at,
            trashed_at,
            purge_after,
            trash_path,
        } => {
            tx.execute(
                "UPDATE tasks SET archived = 1, updated_at = max(updated_at, ?1) WHERE id = ?2",
                params![trashed_at, task_id],
            )?;
            upsert_ws_state_tx(
                &tx,
                &task_id,
                &directory_name,
                "trashed",
                created_at.unwrap_or(trashed_at),
                trashed_at,
                Some(trashed_at),
                Some(purge_after),
                trash_path.as_deref(),
            )?;
            json!({ "ok": true })
        }
        Request::CommitTaskWorkspaceAdopt {
            task_id,
            workspace_dir,
            directory_name,
            now,
        } => {
            let had_task: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1)",
                [&task_id],
                |r| r.get(0),
            )?;
            bind_task_cwd_tx(&tx, &task_id, &workspace_dir, now)?;
            if had_task {
                tx.execute(
                    "UPDATE tasks SET archived = 0, updated_at = max(updated_at, ?1) WHERE id = ?2",
                    params![now, task_id],
                )?;
            }
            upsert_ws_state_tx(
                &tx,
                &task_id,
                &directory_name,
                "active",
                now,
                now,
                None,
                None,
                None,
            )?;
            json!({ "ok": true })
        }
        Request::OpenDots { at } => {
            tx.execute(
                "INSERT OR IGNORE INTO tasks (id,title,updated_at,welcome_mode,mode_preset_id)
                 VALUES ('__dots__', 'Dots', ?1, 'general', 'native')",
                [at],
            )?;
            json!({ "ok": true })
        }
        Request::UpsertSpaceRaw {
            id,
            name,
            path,
            parent_id,
            has_parent,
            sort_order,
            has_sort_order,
            at,
        } => {
            let (saved_parent, saved_sort): (Option<String>, f64) = tx.query_row(
                "INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at)
                 VALUES (:id, :name, :path,
                   CASE WHEN :hasParent THEN :parentId ELSE (SELECT parent_id FROM spaces WHERE id = :id) END,
                   CASE WHEN :hasSortOrder THEN :sortOrder ELSE COALESCE(
                     (SELECT sort_order FROM spaces WHERE id = :id),
                     (SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM spaces WHERE parent_id IS :parentId)
                   ) END,
                   :now, :now)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   path = excluded.path,
                   parent_id = excluded.parent_id,
                   sort_order = excluded.sort_order,
                   updated_at = excluded.updated_at
                 RETURNING parent_id, sort_order",
                named_params! {
                    ":id": id,
                    ":name": name,
                    ":path": path,
                    ":parentId": parent_id,
                    ":sortOrder": sort_order,
                    ":now": at,
                    ":hasParent": i64::from(has_parent),
                    ":hasSortOrder": i64::from(has_sort_order),
                },
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            json!({ "parentId": saved_parent, "sortOrder": saved_sort })
        }
        Request::CreateConversationBranch {
            child_task_id,
            parent_task_id,
            root_task_id,
            parent_title_snapshot,
            source_session_file,
            source_leaf_entry_id,
            source_user_message_index,
            request_id,
            position,
            workspace_strategy,
            created_at,
            task_title,
            task_space_id,
            task_project_id,
            task_status,
            task_updated_at,
            task_session_file,
            task_cwd,
            task_welcome_mode,
            task_model_id,
            task_permission_mode,
            task_expert_id,
            task_mode_preset_id,
        } => {
            tx.execute(
                "INSERT INTO tasks (id, title, space_id, project_id, status, updated_at, session_file, cwd, welcome_mode,
                   model_id, permission_mode, expert_id, mode_preset_id, start_at, due_at, space_sort_order, is_favorited)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, NULL, 0, 0)",
                params![
                    child_task_id,
                    task_title,
                    task_space_id,
                    task_project_id,
                    task_status,
                    task_updated_at,
                    task_session_file,
                    task_cwd,
                    task_welcome_mode,
                    task_model_id,
                    task_permission_mode,
                    task_expert_id,
                    task_mode_preset_id,
                ],
            )?;
            tx.execute(
                "INSERT INTO conversation_branches (
                   child_task_id, parent_task_id, root_task_id, parent_title_snapshot,
                   source_session_file, source_leaf_entry_id, source_user_message_index,
                   request_id, source_position, workspace_strategy, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    child_task_id,
                    parent_task_id,
                    root_task_id,
                    parent_title_snapshot,
                    source_session_file,
                    source_leaf_entry_id,
                    source_user_message_index,
                    request_id,
                    position,
                    workspace_strategy,
                    created_at,
                ],
            )?;
            tx.execute(
                "INSERT INTO task_library_references (task_id, item_id, project_id, added_at, added_by)
                 SELECT ?1, item_id, project_id, added_at, 'conversation-branch'
                   FROM task_library_references WHERE task_id = ?2
                   AND item_id IN (SELECT id FROM library_items)",
                params![child_task_id, parent_task_id],
            )?;
            json!({ "ok": true })
        }
        Request::RebindLegacyTaskWorkspacePaths {
            cwd_updates,
            trash_updates,
        } => {
            let mut cwds = 0usize;
            for (task_id, cwd) in cwd_updates {
                cwds += tx.execute(
                    "UPDATE tasks SET cwd = ?1 WHERE id = ?2",
                    params![cwd, task_id],
                )?;
            }
            let mut trash_paths = 0usize;
            for (task_id, trash_path) in trash_updates {
                trash_paths += tx.execute(
                    "UPDATE task_execution_workspace_state SET trash_path = ?1 WHERE task_id = ?2",
                    params![trash_path, task_id],
                )?;
            }
            json!({ "cwds": cwds, "trashPaths": trash_paths })
        }
    };
    tx.commit()?;
    Ok(out)
}
