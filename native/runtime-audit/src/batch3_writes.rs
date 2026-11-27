//! Rust-owned Batch 3 transactional writes (`Step 4 Stage 4.3`, `RC-09`/`RC-10`):
//! Artifacts, Library, and Memory domain mutations + derived indexes.

use crate::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use duckdb::{Connection, OptionalExt, Transaction, named_params, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDepInput {
    file_path: String,
    dependency_kind: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRelocationChange {
    id: String,
    task_id: String,
    updated_at: i64,
    source_type: String,
    root_dir: String,
    entry_file: Option<String>,
    storage_path: Option<String>,
    dependencies: Vec<ArtifactDepInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChunkInput {
    id: String,
    chunk_index: i64,
    content: String,
    char_offset: i64,
    hash: String,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEmbeddingInput {
    chunk_id: String,
    model_id: String,
    model_version: String,
    chunk_hash: String,
    dimension: i64,
    embedding_base64: String,
    created_at: i64,
    eligible_space_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScopeInput {
    id: Option<String>,
    memory_id: String,
    scope_type: String,
    scope_id: Option<String>,
    binding: String,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvidenceInput {
    id: String,
    memory_id: String,
    evidence_kind: String,
    ref_id: String,
    ref_title: Option<String>,
    excerpt: Option<String>,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRelationInput {
    id: String,
    from_memory_id: String,
    relation: String,
    to_memory_id: String,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecordInput {
    id: String,
    kind: String,
    title: String,
    content: String,
    status: String,
    importance: i64,
    confidence: f64,
    explicit: bool,
    source_type: String,
    source_id: Option<String>,
    source_task_id: Option<String>,
    valid_from: Option<i64>,
    valid_until: Option<i64>,
    content_hash: String,
    created_at: i64,
    updated_at: i64,
    last_recalled_at: Option<i64>,
    recall_count: i64,
    metadata_json: String,
    scopes: Vec<MemoryScopeInput>,
    evidence: Vec<MemoryEvidenceInput>,
    relations: Vec<MemoryRelationInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTurnInput {
    id: String,
    task_id: String,
    session_id: Option<String>,
    user_message_id: Option<String>,
    assistant_message_id: Option<String>,
    user_text: String,
    assistant_text: String,
    content_hash: String,
    captured_at: i64,
    metadata_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioRowInput {
    id: String,
    title: String,
    summary: String,
    source_memory_ids_json: String,
    content_hash: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalRowInput {
    id: String,
    target_id: String,
    title: String,
    body: String,
    source_ids_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExposureInput {
    id: String,
    skill_id: String,
    candidate_id: Option<String>,
    source_memory_ids_json: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    // ---------- Artifacts ----------
    ArtifactRelocateFolders {
        changes: Vec<ArtifactRelocationChange>,
    },
    ArtifactUpdateMetadata {
        id: String,
        task_id: String,
        space_id: Option<String>,
        has_space_id: bool,
        title: Option<String>,
        has_title: bool,
        mime_type: Option<String>,
        has_mime_type: bool,
        capabilities_json: Option<String>,
        updated_at: i64,
    },
    ArtifactAddMessageRef {
        task_id: String,
        message_id: String,
        artifact_id: String,
        relation: String,
        tool_call_id: Option<String>,
        created_at: i64,
    },
    ArtifactSetFileDependencies {
        artifact_id: String,
        task_id: String,
        dependencies: Vec<ArtifactDepInput>,
        created_at: i64,
    },
    ArtifactMarkLegacyMigrated {
        task_id: String,
        at: i64,
    },

    // ---------- Library ----------
    LibraryCatalogEdit { edit: crate::library_catalog_write::Edit, at: i64 },
    LibrarySetIndexState {
        key: String,
        value: String,
        updated_at: i64,
    },
    LibraryInsertSpace {
        id: String,
        name: String,
        space_kind: String,
        project_id: Option<String>,
        workspace_id: Option<String>,
        created_at: i64,
        updated_at: i64,
    },
    LibraryUpdateSpace {
        id: String,
        name: String,
        updated_at: i64,
    },
    LibraryDeleteSpace {
        id: String,
    },
    LibraryInsertCollection {
        id: String,
        space_id: String,
        parent_id: Option<String>,
        name: String,
        owner: String,
        created_at: i64,
        updated_at: i64,
    },
    LibraryUpdateCollection {
        id: String,
        parent_id: Option<String>,
        name: String,
        owner: String,
        updated_at: i64,
    },
    LibraryDeleteCollection {
        id: String,
    },
    LibraryInsertItem {
        id: String,
        space_id: String,
        collection_id: Option<String>,
        item_kind: String,
        title: String,
        filename: String,
        mime_type: String,
        size_bytes: i64,
        owner: String,
        favorite: i64,
        url: Option<String>,
        source_type: String,
        source_task_id: Option<String>,
        source_artifact_id: Option<String>,
        original_path: Option<String>,
        content_hash: Option<String>,
        extract_status: Option<String>,
        created_at: i64,
        updated_at: i64,
        last_visited_at: Option<i64>,
        trashed_at: Option<i64>,
        note_metadata: Option<String>,
    },
    LibraryVisitItem { id: String, at: i64 },
    LibraryFavoriteItem { id: String, favorite: bool, at: i64 },
    LibraryUpdateItem {
        id: String,
        collection_id: Option<String>,
        title: String,
        filename: String,
        mime_type: String,
        size_bytes: i64,
        owner: String,
        favorite: i64,
        url: Option<String>,
        source_type: String,
        source_task_id: Option<String>,
        source_artifact_id: Option<String>,
        original_path: Option<String>,
        content_hash: Option<String>,
        extract_status: Option<String>,
        updated_at: i64,
        last_visited_at: Option<i64>,
        trashed_at: Option<i64>,
        note_metadata: Option<String>,
        prev_collection: Option<String>,
        prev_title: String,
        prev_filename: String,
        prev_size: i64,
        prev_hash: Option<String>,
        prev_trash: Option<i64>,
        prev_metadata: Option<String>,
        prev_updated_at: i64,
    },
    LibraryDeleteItem {
        id: String,
    },
    LibrarySetExtractStatus {
        id: Option<String>,
        status: String,
        only_if_missing: bool,
    },
    LibraryUpsertFts {
        item_id: String,
        title: Option<String>,
        filename: Option<String>,
        body: Option<String>,
        clear_only: bool,
    },
    LibraryReplaceChunks {
        item_id: String,
        reuse_embeddings: bool,
        fts_available: bool,
        chunks: Vec<LibraryChunkInput>,
    },
    LibraryClearChunks {
        item_id: String,
        fts_available: bool,
    },
    LibraryMergeChunkStage {
        file: String,
        item_id: String,
        title: String,
        filename: String,
        chunk_count: i64,
        updated_at: i64,
        fts_available: bool,
    },
    LibraryChunkEmbeddings {
        upsert: Vec<LibraryEmbeddingInput>,
        delete_item_id: Option<String>,
        delete_chunk_ids: Vec<String>,
        prune_stale_item_id: Option<String>,
    },
    LibraryInsertVersion {
        id: String,
        item_id: String,
        version: i64,
        content_hash: String,
        path: String,
        created_by: String,
        source_task_id: Option<String>,
        created_at: i64,
        snapshot_base64: Option<String>,
    },
    LibraryDeleteVersion {
        id: String,
    },
    LibraryTaskReference {
        action: String,
        task_id: String,
        item_id: Option<String>,
        project_id: Option<String>,
        added_at: Option<i64>,
        added_by: Option<String>,
    },
    LibraryDeleteTextSaveIntent {
        item_id: String,
        operation_id: String,
    },
    LibraryDeleteBindingLinks {
        link_kind: String,
        id: String,
    },

    // ---------- Memory ----------
    MemoryInsertRecord {
        record: MemoryRecordInput,
        change_reason: String,
        revision_id: String,
    },
    MemoryUpdateRecord {
        id: String,
        memory_kind: String,
        title: String,
        content: String,
        status: String,
        importance: i64,
        confidence: f64,
        explicit: bool,
        valid_from: Option<i64>,
        valid_until: Option<i64>,
        content_hash: String,
        updated_at: i64,
        metadata_json: String,
        changed_by: String,
        change_reason: String,
        revision_id: String,
    },
    MemorySupersede {
        old_id: String,
        old_status: String,
        old_valid_until: Option<i64>,
        old_updated_at: i64,
        old_kind: String,
        old_title: String,
        old_content: String,
        old_importance: i64,
        old_confidence: f64,
        old_explicit: bool,
        old_valid_from: Option<i64>,
        old_content_hash: String,
        old_metadata_json: String,
        old_revision_id: String,
        changed_by: String,
        change_reason: String,
        replacement: MemoryRecordInput,
        replacement_reason: String,
        replacement_revision_id: String,
        relation: MemoryRelationInput,
    },
    MemoryAddScope {
        id: String,
        memory_id: String,
        scope_type: String,
        scope_id: Option<String>,
        binding: String,
        created_at: i64,
    },
    MemoryRemoveScope {
        memory_id: String,
        scope_type: Option<String>,
        scope_id: Option<String>,
    },
    MemoryAddEvidence {
        evidence: MemoryEvidenceInput,
    },
    MemoryRemoveEvidence {
        id: String,
    },
    MemoryAddRelation {
        relation: MemoryRelationInput,
    },
    MemoryRemoveRelation {
        id: String,
    },
    MemoryHardDelete {
        id: String,
    },
    MemoryRecordRecall {
        ids: Vec<String>,
        now: i64,
    },
    MemoryInsertCandidate {
        id: String,
        task_id: String,
        memory_kind: String,
        title: String,
        content: String,
        scope_type: String,
        scope_id: Option<String>,
        confidence: f64,
        importance: i64,
        explicit: bool,
        operation_hint: String,
        replaces: Option<String>,
        status: String,
        raw_json: Option<String>,
        created_at: i64,
        resolved_at: Option<i64>,
    },
    MemoryResolveCandidate {
        id: String,
        status: String,
        resolved_at: i64,
        resolved_memory_id: Option<String>,
        pending_only: bool,
    },
    MemoryReapStaleCandidates {
        older_than: i64,
        now: i64,
    },
    MemoryTurnCapture {
        turn: MemoryTurnInput,
        note_captured: bool,
        now: i64,
    },
    MemoryTurnUpdateState {
        state_action: String,
        ids: Vec<String>,
        now: i64,
        error: Option<String>,
        task_id: Option<String>,
        remaining_pending: Option<i64>,
    },
    MemoryTurnDelete {
        delete_all: bool,
        ids: Vec<String>,
        now: i64,
    },
    MemoryResetFailedTurns {
        eligible_ids: Vec<String>,
    },
    MemoryUpsertWatermark {
        scope_type: String,
        scope_id: String,
        cutoff_at: i64,
        allowed_message_id: Option<String>,
    },
    MemoryUpsertForgetTarget {
        scope_type: String,
        scope_id: String,
        fingerprint: String,
        text_length: i64,
        cutoff_at: i64,
        allowed_message_id: Option<String>,
        value_fingerprint: Option<String>,
        guard_fingerprint: Option<String>,
        guard_length: Option<i64>,
    },
    MemoryInsertForgetReceipt {
        scope_type: String,
        scope_id: String,
        source_message_id: String,
        request_fingerprint: String,
    },
    MemoryUpsertEmbedding {
        memory_id: String,
        model_id: String,
        model_version: String,
        content_hash: String,
        dimension: i64,
        embedding_base64: String,
        created_at: i64,
    },
    MemoryRecallLineageRecord {
        assistant_id: String,
        lineage_json: String,
    },
    WorkMemoryUpsertReceipt {
        source_key: String,
        memory_id: String,
        content_hash: String,
        updated_at: i64,
    },
    WorkMemoryRepairMeta {
        memory_id: String,
        source_key: String,
        updated_at: i64,
    },
    WorkMemorySuppressReceipt {
        source_key: String,
        updated_at: i64,
    },
    MemoryTouchProjectScopes {
        project_ids: Vec<String>,
        now: i64,
    },
    MemoryTurnSetDurableProjection {
        task_id: String,
        entry_id: i64,
    },
    MemorySkillHistoryDelete {
        kind_name: String,
        delete_all: bool,
        ids: Vec<String>,
    },
    MemoryOrganizationRecover {
        now: i64,
        error: String,
    },
    MemoryOrganizationSaveRun {
        id: String,
        created_at: i64,
        updated_at: i64,
        state_json: String,
    },
    MemoryOrganizationPauseRun {
        id: String,
        at: i64,
    },
    MemoryOrganizationMarkApplied {
        id: String,
        created_at: i64,
        updated_at: i64,
        state_json: String,
    },
    MemoryOrganizationDeleteUndo {
        evidence_ids: Vec<String>,
        relation_ids: Vec<String>,
        id: String,
        created_at: i64,
        updated_at: i64,
        state_json: String,
    },
    MemoryProjectionSyncScenarios {
        scope_type: String,
        scope_id: Option<String>,
        rows: Vec<ScenarioRowInput>,
        now: i64,
    },
    MemoryProjectionUpsertProfile {
        id: String,
        scope_type: String,
        scope_id: Option<String>,
        title: String,
        content: String,
        source_scenario_ids_json: String,
        content_hash: String,
        created_at: i64,
        updated_at: i64,
    },
    MemoryProjectionMarkStale {
        proj_action: String,
        id: Option<String>,
        scope_type: Option<String>,
        scope_id: Option<String>,
        source_memory_ids: Vec<String>,
        now: i64,
    },
    MemoryProjectionPruneTask {
        task_id: String,
    },
    MemoryProjectionDismiss {
        id: String,
        proj_kind: String,
        title: String,
        scope_type: String,
        scope_id: Option<String>,
        dismissed_at: i64,
    },
    MemoryProjectionDelete {
        scope: String,
        proj_kind: String,
        id: Option<String>,
    },
    MemoryProjectionRestoreDismissal {
        id: String,
    },
    MemoryProjectionPropose {
        proj_kind: String,
        scope_type: String,
        scope_id: Option<String>,
        proposals: Vec<ProposalRowInput>,
        now: i64,
    },
    MemoryProjectionProposalAction {
        proj_action: String,
        id: String,
        now: i64,
        created_id: Option<String>,
        scope_type: Option<String>,
        scope_id: Option<String>,
        title: Option<String>,
        body: Option<String>,
        sources_json: Option<String>,
        content_hash: Option<String>,
    },
    MemorySkillCandidateUpsert {
        id: String,
        slug: String,
        title: String,
        description: String,
        instructions: String,
        status: String,
        scope_type: String,
        scope_id: Option<String>,
        source_memory_ids_json: String,
        source_signature: String,
        support_count: i64,
        distinct_task_count: i64,
        completed_task_count: i64,
        evidence_count: i64,
        confidence: f64,
        score: f64,
        installed_skill_id: Option<String>,
        created_at: i64,
        updated_at: i64,
        resolved_at: Option<i64>,
    },
    MemorySkillCandidateStatus {
        cand_action: String,
        id: Option<String>,
        ids: Vec<String>,
        installed_skill_id: Option<String>,
        now: i64,
    },
    MemorySkillRevisionUpsert {
        id: String,
        skill_id: String,
        base_candidate_id: Option<String>,
        base_version: String,
        base_content_hash: String,
        title: String,
        status: String,
        issue_summary: String,
        base_description: String,
        base_instructions: String,
        proposed_description: String,
        proposed_instructions: String,
        negative_feedback_ids_json: String,
        source_memory_ids_json: String,
        feedback_signature: String,
        needs_revision_count: i64,
        incorrect_count: i64,
        failed_invocation_count: i64,
        created_at: i64,
        updated_at: i64,
        resolved_at: Option<i64>,
        materialized_candidate_id: Option<String>,
        materialized_version: Option<String>,
    },
    MemorySkillRevisionStatus {
        rev_action: String,
        id: Option<String>,
        ids: Vec<String>,
        materialized_candidate_id: Option<String>,
        materialized_version: Option<String>,
        skill_id: Option<String>,
        base_candidate_id: Option<String>,
        now: i64,
    },
    MemorySkillEffectivenessOp {
        eff_action: String,
        task_id: Option<String>,
        assistant_message_id: Option<String>,
        exposures: Vec<SkillExposureInput>,
        skill_id: Option<String>,
        inv_kind: Option<String>,
        tool_call_id: Option<String>,
        outcome: Option<String>,
        id: Option<String>,
        feedback_kind: Option<String>,
        feedback_note: Option<String>,
        at: i64,
    },
}

impl Request {
    pub fn artifact_tasks(&self) -> Option<Vec<&str>> {
        match self {
            Self::ArtifactRelocateFolders { changes } => Some(changes.iter().map(|c| c.task_id.as_str()).collect()),
            Self::ArtifactUpdateMetadata { task_id, .. }
            | Self::ArtifactAddMessageRef { task_id, .. }
            | Self::ArtifactSetFileDependencies { task_id, .. }
            | Self::ArtifactMarkLegacyMigrated { task_id, .. } => Some(vec![task_id.as_str()]),
            _ => None,
        }
    }
}

fn require_artifact(db: &Connection, task_id: &str, id: &str) -> Result<()> {
    if !db.query_row("SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=?1 AND task_id=?2)",
        params![id, task_id], |r| r.get::<_, bool>(0))? {
        return Err("成果不属于该任务".into());
    }
    Ok(())
}

fn bump_artifact_revision_tx(tx: &Transaction<'_>, task_id: &str) -> Result<i64> {
    let rev: i64 = tx.query_row(
        "INSERT INTO artifact_task_revisions (task_id, revision) VALUES (?1, 1)
         ON CONFLICT(task_id) DO UPDATE SET revision = artifact_task_revisions.revision + 1
         RETURNING revision",
        [task_id],
        |r| r.get(0),
    )?;
    Ok(rev)
}

fn insert_memory_within_tx(
    tx: &Transaction<'_>,
    r: &MemoryRecordInput,
    revision_id: &str,
    change_reason: &str,
) -> Result<()> {
    tx.execute(
        "INSERT INTO memory_records (
           id, kind, title, content, status, importance, confidence, explicit,
           source_type, source_id, source_task_id, valid_from, valid_until, content_hash,
           created_at, updated_at, last_recalled_at, recall_count, metadata_json
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
        params![
            r.id,
            r.kind,
            r.title,
            r.content,
            r.status,
            r.importance,
            r.confidence,
            i64::from(r.explicit),
            r.source_type,
            r.source_id,
            r.source_task_id,
            r.valid_from,
            r.valid_until,
            r.content_hash,
            r.created_at,
            r.updated_at,
            r.last_recalled_at,
            r.recall_count,
            r.metadata_json,
        ],
    )?;
    for s in &r.scopes {
        if s.scope_type == "project" {
            let sid = s.scope_id.as_deref().unwrap_or("");
            let archived: Option<i64> = tx
                .query_row("SELECT archived FROM projects WHERE id=?1", [sid], |row| row.get(0))
                .optional()?;
            let archived = archived.ok_or_else(|| format!("项目不存在：{sid}"))?;
            if archived != 0 {
                return Err("项目已归档（只读），不能写入项目记忆".into());
            }
        }
        let sid_pk = s.id.clone().unwrap_or_else(|| uuid_like_id(&s.memory_id, &s.scope_type, s.scope_id.as_deref(), s.created_at));
        tx.execute(
            "INSERT INTO memory_scopes (id, memory_id, scope_type, scope_id, binding, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING",
            params![sid_pk, s.memory_id, s.scope_type, s.scope_id, s.binding, s.created_at],
        )?;
    }
    for e in &r.evidence {
        tx.execute(
            "INSERT INTO memory_evidence (id, memory_id, evidence_kind, ref_id, ref_title, excerpt, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(memory_id, evidence_kind, ref_id) DO NOTHING",
            params![e.id, e.memory_id, e.evidence_kind, e.ref_id, e.ref_title, e.excerpt, e.created_at],
        )?;
    }
    for rel in &r.relations {
        tx.execute(
            "INSERT INTO memory_relations (id, from_memory_id, relation, to_memory_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
            params![rel.id, rel.from_memory_id, rel.relation, rel.to_memory_id, rel.created_at],
        )?;
    }
    let rev: i64 = tx.query_row(
        "SELECT coalesce(max(revision), 0) + 1 FROM memory_revisions WHERE memory_id = ?1",
        [&r.id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO memory_revisions (id, memory_id, revision, kind, title, content, status, importance, confidence, valid_from, valid_until, changed_by, change_reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            revision_id,
            r.id,
            rev,
            r.kind,
            r.title,
            r.content,
            r.status,
            r.importance,
            r.confidence,
            r.valid_from,
            r.valid_until,
            r.source_type,
            change_reason,
            r.updated_at,
        ],
    )?;
    Ok(())
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

fn uuid_like_id(a: &str, b: &str, c: Option<&str>, ts: i64) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(a.as_bytes());
    h.update(b":");
    h.update(b.as_bytes());
    h.update(b":");
    h.update(c.unwrap_or("").as_bytes());
    h.update(ts.to_le_bytes());
    let d = h.finalize();
    format!("mscp_{}", to_hex(&d[..14]))
}

fn active_library_item(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    let rows = crate::sqlite_rows::records(tx,&format!("SELECT {} FROM library_items WHERE id=?1 AND trashed_at IS NULL",
        crate::library_metadata::ITEMS), [id])?;
    let item = rows.into_iter().next().ok_or("条目不存在")?;
    Ok(json!({"item":item}))
}

pub fn run(db: &mut Connection, request: Request) -> Result<Value> {
    if let Request::LibraryMergeChunkStage {
        file,
        item_id,
        title: _title,
        filename: _filename,
        chunk_count,
        updated_at,
        fts_available,
    } = request
    {
        let staged = crate::library_text::read_staged_chunks(&file)?;
        let tx = db.transaction()?;
        if fts_available {
            let joined: String = staged
                .iter()
                .map(|c| c.content.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            crate::library_index::refresh_item_fts(&tx, &item_id, Some(&joined))?;
        }
        let has_chunks = crate::database::table_exists(&tx, "library_chunks")?;
        if has_chunks {
            let mut ins = tx.prepare(
                "INSERT INTO library_chunks(id,item_id,chunk_index,content,char_offset,hash,updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET chunk_index=excluded.chunk_index,content=excluded.content,
                   char_offset=excluded.char_offset,hash=excluded.hash,updated_at=excluded.updated_at",
            )?;
            for chunk in &staged {
                let cid = format!("{item_id}#{}", chunk.chunk_index);
                ins.execute(params![
                    cid,
                    item_id,
                    chunk.chunk_index,
                    chunk.content,
                    chunk.char_offset,
                    chunk.hash,
                    updated_at
                ])?;
            }
            tx.execute(
                "DELETE FROM library_chunk_embeddings
                 WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?1)
                   AND NOT EXISTS (
                     SELECT 1 FROM library_chunks c WHERE c.id = library_chunk_embeddings.chunk_id
                       AND c.chunk_index < ?2 AND c.hash = library_chunk_embeddings.chunk_hash
                   )",
                params![item_id, chunk_count],
            )?;
            tx.execute(
                "DELETE FROM library_chunks WHERE item_id = ?1 AND chunk_index >= ?2",
                params![item_id, chunk_count],
            )?;
        }
        tx.commit()?;
        return Ok(json!({ "ok": true }));
    }

    let tx = db.transaction()?;
    let out = match request {
        Request::LibraryMergeChunkStage { .. } => unreachable!(),
        Request::ArtifactRelocateFolders { changes } => {
            relocate_artifacts(&tx, changes)?
        }
        Request::ArtifactUpdateMetadata {
            id,
            task_id,
            space_id,
            has_space_id,
            title,
            has_title,
            mime_type,
            has_mime_type,
            capabilities_json,
            updated_at,
        } => {
            let changed = tx.execute(
                "UPDATE artifacts SET space_id=CASE WHEN ?1 THEN ?2 ELSE space_id END,
                    title=CASE WHEN ?3 THEN ?4 ELSE title END, mime_type=CASE WHEN ?5 THEN ?6 ELSE mime_type END,
                    capabilities_json=coalesce(?7,capabilities_json), updated_at=?8 WHERE id=?9 AND task_id=?10",
                params![has_space_id, space_id, has_title, title, has_mime_type, mime_type, capabilities_json, updated_at, id, task_id],
            )?;
            if changed == 0 { return Err("成果不属于该任务".into()); }
            let revision = bump_artifact_revision_tx(&tx, &task_id)?;
            json!({ "revision": revision })
        }
        Request::ArtifactAddMessageRef {
            task_id,
            message_id,
            artifact_id,
            relation,
            tool_call_id,
            created_at,
        } => {
            require_artifact(&tx, &task_id, &artifact_id)?;
            tx.execute(
                "INSERT INTO artifact_message_refs (task_id, message_id, artifact_id, relation, tool_call_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(task_id, message_id, artifact_id, relation) DO NOTHING",
                params![task_id, message_id, artifact_id, relation, tool_call_id, created_at],
            )?;
            json!({ "ok": true })
        }
        Request::ArtifactSetFileDependencies {
            artifact_id,
            task_id,
            dependencies,
            created_at,
        } => {
            require_artifact(&tx, &task_id, &artifact_id)?;
            tx.execute(
                "DELETE FROM artifact_file_dependencies WHERE artifact_id = ?1",
                [&artifact_id],
            )?;
            for dep in dependencies {
                tx.execute(
                    "INSERT INTO artifact_file_dependencies (artifact_id, file_path, dependency_kind, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        artifact_id,
                        dep.file_path,
                        dep.dependency_kind.as_deref().unwrap_or("runtime"),
                        created_at
                    ],
                )?;
            }
            let revision = bump_artifact_revision_tx(&tx, &task_id)?;
            json!({ "revision": revision })
        }
        Request::ArtifactMarkLegacyMigrated { task_id, at } => {
            tx.execute(
                "INSERT INTO artifact_task_state (task_id, legacy_migrated_at) VALUES (?1, ?2)
                 ON CONFLICT(task_id) DO UPDATE SET legacy_migrated_at = excluded.legacy_migrated_at",
                params![task_id, at],
            )?;
            json!({ "ok": true })
        }
        Request::LibraryCatalogEdit { edit, at } => crate::library_catalog_write::apply(&tx,edit,at)?,
        Request::LibrarySetIndexState { key, value, updated_at } => {
            tx.execute(
                "INSERT INTO library_index_state(key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                params![key, value, updated_at],
            )?;
            json!({ "ok": true })
        }
        Request::LibraryInsertSpace {
            id,
            name,
            space_kind,
            project_id,
            workspace_id,
            created_at,
            updated_at,
        } => {
            tx.execute(
                "INSERT INTO library_spaces (id, name, kind, project_id, workspace_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, name, space_kind, project_id, workspace_id, created_at, updated_at],
            )?;
            json!({ "ok": true })
        }
        Request::LibraryUpdateSpace { id, name, updated_at } => {
            tx.execute(
                "UPDATE library_spaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name, updated_at, id],
            )?;
            json!({ "ok": true })
        }
        Request::LibraryDeleteSpace { id } => {
            tx.execute("DELETE FROM library_spaces WHERE id = ?1", [id])?;
            json!({ "ok": true })
        }
        Request::LibraryInsertCollection {
            id,
            space_id,
            parent_id,
            name,
            owner,
            created_at,
            updated_at,
        } => {
            tx.execute(
                "INSERT INTO library_collections (id, space_id, parent_id, name, owner, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, space_id, parent_id, name, owner, created_at, updated_at],
            )?;
            json!({ "ok": true })
        }
        Request::LibraryUpdateCollection {
            id,
            parent_id,
            name,
            owner,
            updated_at,
        } => {
            tx.execute(
                "UPDATE library_collections SET parent_id = ?1, name = ?2, owner = ?3, updated_at = ?4 WHERE id = ?5",
                params![parent_id, name, owner, updated_at, id],
            )?;
            json!({ "ok": true })
        }
        Request::LibraryDeleteCollection { id } => {
            tx.execute("DELETE FROM library_collections WHERE id = ?1", [id])?;
            json!({ "ok": true })
        }
        Request::LibraryInsertItem {
            id,
            space_id,
            collection_id,
            item_kind,
            title,
            filename,
            mime_type,
            size_bytes,
            owner,
            favorite,
            url,
            source_type,
            source_task_id,
            source_artifact_id,
            original_path,
            content_hash,
            extract_status,
            created_at,
            updated_at,
            last_visited_at,
            trashed_at,
            note_metadata,
        } => {
            tx.execute(
                "INSERT INTO library_items (
                   id, space_id, collection_id, kind, title, filename, mime_type, size_bytes, owner,
                   favorite, url, source_type, source_task_id, source_artifact_id, original_path,
                   content_hash, extract_status, created_at, updated_at, last_visited_at, trashed_at, note_metadata
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
                params![
                    id,
                    space_id,
                    collection_id,
                    item_kind,
                    title,
                    filename,
                    mime_type,
                    size_bytes,
                    owner,
                    favorite,
                    url,
                    source_type,
                    source_task_id,
                    source_artifact_id,
                    original_path,
                    content_hash,
                    extract_status,
                    created_at,
                    updated_at,
                    last_visited_at,
                    trashed_at,
                    note_metadata
                ],
            )?;
            json!({ "ok": true })
        }
        Request::LibraryVisitItem { id, at } => {
            tx.execute("UPDATE library_items SET last_visited_at=greatest(coalesce(last_visited_at,0),?1)
                        WHERE id=?2 AND trashed_at IS NULL", params![at,id])?;
            active_library_item(&tx,&id)?
        }
        Request::LibraryFavoriteItem { id, favorite, at } => {
            let owner: Option<(Option<String>,Option<String>)> = tx.query_row(
                "SELECT s.project_id,s.workspace_id FROM library_spaces s JOIN library_items i ON i.space_id=s.id
                 WHERE i.id=?1 AND i.trashed_at IS NULL", [&id], |r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let Some((project,workspace))=owner else { return Err("条目不存在".into()); };
            if !crate::scoped_notes::library_owner_writable(&tx,project.as_deref(),workspace.as_deref())? {
                return Err("已归档的资料只可读取".into());
            }
            tx.execute("UPDATE library_items SET favorite=?1,updated_at=greatest(updated_at,?2) WHERE id=?3",
                params![i64::from(favorite),at,id])?;
            active_library_item(&tx,&id)?
        }
        Request::LibraryUpdateItem {
            id,
            collection_id,
            title,
            filename,
            mime_type,
            size_bytes,
            owner,
            favorite,
            url,
            source_type,
            source_task_id,
            source_artifact_id,
            original_path,
            content_hash,
            extract_status,
            updated_at,
            last_visited_at,
            trashed_at,
            note_metadata,
            prev_collection,
            prev_title,
            prev_filename,
            prev_size,
            prev_hash,
            prev_trash,
            prev_metadata,
            prev_updated_at,
        } => {
            tx.execute(
                "UPDATE library_items SET
                   collection_id = CASE WHEN $collectionId IS NOT DISTINCT FROM $previousCollection THEN collection_id ELSE $collectionId END,
                   title = CASE WHEN $title = $previousTitle THEN title ELSE $title END,
                   filename = CASE WHEN $filename = $previousFilename THEN filename ELSE $filename END,
                   mime_type = $mimeType,
                   size_bytes = CASE WHEN $sizeBytes = $previousSize THEN size_bytes ELSE $sizeBytes END,
                   owner = $owner, favorite = $favorite, url = $url,
                   source_type = $sourceType, source_task_id = $sourceTaskId,
                   source_artifact_id = $sourceArtifactId, original_path = $originalPath,
                   content_hash = CASE WHEN $contentHash IS NOT DISTINCT FROM $previousHash THEN content_hash ELSE $contentHash END,
                   extract_status = $extractStatus,
                   updated_at = CASE WHEN updated_at = $previousUpdatedAt THEN $updatedAt ELSE GREATEST(updated_at, $updatedAt) END,
                   last_visited_at = $lastVisitedAt,
                   trashed_at = CASE WHEN $trashedAt IS NOT DISTINCT FROM $previousTrash THEN trashed_at ELSE $trashedAt END,
                   note_metadata = CASE WHEN $noteMetadata = $previousMetadata THEN note_metadata ELSE $noteMetadata END
                 WHERE id = $id",
                named_params! {
                    "id": id,
                    "collectionId": collection_id,
                    "title": title,
                    "filename": filename,
                    "mimeType": mime_type,
                    "sizeBytes": size_bytes,
                    "owner": owner,
                    "favorite": favorite,
                    "url": url,
                    "sourceType": source_type,
                    "sourceTaskId": source_task_id,
                    "sourceArtifactId": source_artifact_id,
                    "originalPath": original_path,
                    "contentHash": content_hash,
                    "extractStatus": extract_status,
                    "updatedAt": updated_at,
                    "lastVisitedAt": last_visited_at,
                    "trashedAt": trashed_at,
                    "noteMetadata": note_metadata,
                    "previousCollection": prev_collection,
                    "previousTitle": prev_title,
                    "previousFilename": prev_filename,
                    "previousSize": prev_size,
                    "previousHash": prev_hash,
                    "previousTrash": prev_trash,
                    "previousMetadata": prev_metadata,
                    "previousUpdatedAt": prev_updated_at,
                },
            )?;
            json!({ "ok": true })
        }
        Request::LibraryDeleteItem { id } => {
            crate::search_postings::delete_document_postings_in_tx(&tx, &format!("library:{id}"))?;
            tx.execute(
                "DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id=?1)",
                [&id],
            )?;
            tx.execute("DELETE FROM library_chunks WHERE item_id = ?1", [&id])?;
            tx.execute("DELETE FROM library_versions WHERE item_id = ?1", [&id])?;
            tx.execute("DELETE FROM library_text_saves WHERE item_id = ?1", [&id])?;
            tx.execute("DELETE FROM library_items WHERE id = ?1", [&id])?;
            json!({ "ok": true })
        }
        Request::LibrarySetExtractStatus {
            id,
            status,
            only_if_missing,
        } => {
            if let Some(item_id) = id {
                tx.execute(
                    "UPDATE library_items SET extract_status = ?1 WHERE id = ?2",
                    params![status, item_id],
                )?;
            } else if only_if_missing {
                tx.execute(
                    "UPDATE library_items SET extract_status = ?1 WHERE kind IN ('office', 'pdf') AND extract_status IS NULL",
                    [&status],
                )?;
            } else {
                tx.execute(
                    "UPDATE library_items SET extract_status = ?1 WHERE kind IN ('office', 'pdf')",
                    [&status],
                )?;
            }
            json!({ "ok": true })
        }
        Request::LibraryUpsertFts {
            item_id,
            title: _title,
            filename: _filename,
            body,
            clear_only,
        } => {
            crate::library_index::refresh_item_fts(
                &tx,
                &item_id,
                if clear_only {
                    None
                } else {
                    Some(body.as_deref().unwrap_or(""))
                },
            )?;
            json!({ "ok": true })
        }
        Request::LibraryReplaceChunks {
            item_id,
            reuse_embeddings,
            fts_available,
            chunks,
        } => {
            if !reuse_embeddings {
                tx.execute(
                    "DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?1)",
                    [&item_id],
                )?;
                tx.execute("DELETE FROM library_chunks WHERE item_id = ?1", [&item_id])?;
            }
            let count = chunks.len() as i64;
            if fts_available {
                let joined: String = chunks
                    .iter()
                    .map(|c| c.content.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                crate::library_index::refresh_item_fts(&tx, &item_id, Some(&joined))?;
            }
            for c in chunks {
                tx.execute(
                    "INSERT INTO library_chunks (id, item_id, chunk_index, content, char_offset, hash, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET chunk_index = excluded.chunk_index, content = excluded.content,
                       char_offset = excluded.char_offset, hash = excluded.hash, updated_at = excluded.updated_at",
                    params![c.id, item_id, c.chunk_index, c.content, c.char_offset, c.hash, c.updated_at],
                )?;
            }
            if reuse_embeddings {
                tx.execute(
                    "DELETE FROM library_chunk_embeddings
                     WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?1)
                       AND NOT EXISTS (
                         SELECT 1 FROM library_chunks c WHERE c.id = library_chunk_embeddings.chunk_id
                           AND c.chunk_index < ?2 AND c.hash = library_chunk_embeddings.chunk_hash
                       )",
                    params![item_id, count],
                )?;
                tx.execute(
                    "DELETE FROM library_chunks WHERE item_id = ?1 AND chunk_index >= ?2",
                    params![item_id, count],
                )?;
            }
            json!({ "ok": true })
        }
        Request::LibraryClearChunks {
            item_id,
            fts_available,
        } => {
            tx.execute(
                "DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?1)",
                [&item_id],
            )?;
            tx.execute("DELETE FROM library_chunks WHERE item_id = ?1", [&item_id])?;
            if fts_available {
                crate::search_postings::delete_document_postings_in_tx(&tx, &format!("library:{item_id}"))?;
            }
            json!({ "ok": true })
        }
        Request::LibraryChunkEmbeddings {
            upsert,
            delete_item_id,
            delete_chunk_ids,
            prune_stale_item_id,
        } => {
            if let Some(item_id) = delete_item_id {
                tx.execute(
                    "DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id=?1)",
                    [item_id],
                )?;
            }
            for cid in delete_chunk_ids {
                tx.execute(
                    "DELETE FROM library_chunk_embeddings WHERE chunk_id = ?1",
                    [cid],
                )?;
            }
            if let Some(item_id) = prune_stale_item_id {
                tx.execute(
                    "DELETE FROM library_chunk_embeddings
                     WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?1)
                       AND chunk_hash != (SELECT hash FROM library_chunks WHERE library_chunks.id = library_chunk_embeddings.chunk_id)",
                    [item_id],
                )?;
            }
            let mut succeeded: i64 = 0;
            for u in upsert {
                if u.eligible_space_ids.is_empty() {
                    continue;
                }
                let bytes = STANDARD
                    .decode(u.embedding_base64.as_bytes())
                    .map_err(|e| format!("invalid embedding base64: {e}"))?;
                let space_slots = crate::database::anon_placeholders(u.eligible_space_ids.len());
                let sql = format!(
                    "INSERT INTO library_chunk_embeddings
                       (chunk_id, model_id, model_version, chunk_hash, dimension, embedding, created_at)
                     SELECT c.id, ?, ?, c.hash, ?, ?, ?
                     FROM library_chunks c JOIN library_items i ON i.id = c.item_id
                     WHERE c.id = ? AND c.hash = ? AND i.trashed_at IS NULL
                       AND i.space_id IN ({space_slots})
                     ON CONFLICT(chunk_id, model_id, model_version) DO UPDATE SET
                       chunk_hash=excluded.chunk_hash, dimension=excluded.dimension,
                       embedding=excluded.embedding, created_at=excluded.created_at"
                );
                let mut p: Vec<duckdb::types::Value> = vec![
                    duckdb::types::Value::Text(u.model_id),
                    duckdb::types::Value::Text(u.model_version),
                    duckdb::types::Value::BigInt(u.dimension),
                    duckdb::types::Value::Blob(bytes),
                    duckdb::types::Value::BigInt(u.created_at),
                    duckdb::types::Value::Text(u.chunk_id),
                    duckdb::types::Value::Text(u.chunk_hash),
                ];
                p.extend(u.eligible_space_ids.into_iter().map(duckdb::types::Value::Text));
                let changes = tx.execute(&sql, duckdb::params_from_iter(p))?;
                succeeded += i64::from(changes > 0);
            }
            json!({ "succeeded": succeeded })
        }
        Request::LibraryInsertVersion {
            id,
            item_id,
            version,
            content_hash,
            path,
            created_by,
            source_task_id,
            created_at,
            snapshot_base64,
        } => {
            let snapshot: Option<Vec<u8>> = match snapshot_base64 {
                Some(b64) => Some(
                    STANDARD
                        .decode(b64.as_bytes())
                        .map_err(|e| format!("invalid snapshot base64: {e}"))?,
                ),
                None => None,
            };
            tx.execute(
                "INSERT INTO library_versions (id, item_id, version, content_hash, path, created_by, source_task_id, created_at, snapshot)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id, item_id, version, content_hash, path, created_by, source_task_id, created_at, snapshot],
            )?;
            json!({ "ok": true })
        }
        Request::LibraryDeleteVersion { id } => {
            tx.execute("DELETE FROM library_versions WHERE id = ?1", [id])?;
            json!({ "ok": true })
        }
        Request::LibraryTaskReference {
            action,
            task_id,
            item_id,
            project_id,
            added_at,
            added_by,
        } => {
            let agent = matches!(action.as_str(),"attachVisibleToTask" | "detachVisibleFromTask");
            if agent || action == "attachToTask" || action == "detachFromTask" {
                let id = item_id.as_deref().ok_or("缺少资料 ID")?;
                let task: Option<(Option<String>,bool)> = tx.query_row(
                    "SELECT t.project_id,coalesce(p.archived,0)<>0 FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?",
                    [&task_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
                if task.as_ref().is_some_and(|t|t.1) {
                    return Ok(json!({"ok":false,"error":"项目已归档，仅可读取"}));
                }
                if agent {
                    let scope=crate::library_metadata::task_scope(&tx,Some(&task_id),None,None,Some(vec![id.to_owned()]))?;
                    if (scope["projectId"].is_null() && scope["workspaceId"].is_null()) || scope["items"].as_array().is_none_or(|rows|rows.is_empty()) {
                        return Ok(json!({"ok":false,"error":"条目不在当前任务可写归属和可见范围内"}));
                    }
                }
                let result = if action == "detachFromTask" || action == "detachVisibleFromTask" {
                    tx.execute("DELETE FROM task_library_references WHERE task_id=? AND item_id=?",params![task_id,id])?;
                    json!({"ok":true})
                } else {
                    let Some((project,_))=task else {return Ok(json!({"ok":false,"error":"任务不存在"}))};
                    let scope:Option<Option<String>>=tx.query_row(
                        "SELECT l.project_id FROM library_items i JOIN library_spaces l ON l.id=i.space_id
                         WHERE i.id=? AND i.trashed_at IS NULL AND (l.project_id IS NULL OR l.project_id=?)
                           AND (l.workspace_id IS NULL OR (l.project_id IS NULL AND EXISTS(SELECT 1 FROM spaces WHERE id=l.workspace_id)))
                           AND (l.kind<>'personal' OR (l.project_id IS NULL AND l.workspace_id IS NULL))",
                        params![id,project],|r|r.get(0)).optional()?;
                    let Some(scope)=scope else {return Ok(json!({"ok":false,"error":"资料不存在或不属于当前项目，不能跨项目附加"}))};
                    tx.execute("INSERT INTO task_library_references(task_id,item_id,project_id,added_at,added_by)
                       VALUES(?,?,?,epoch_ms(current_timestamp),coalesce(nullif(trim((SELECT name FROM soul WHERE id=1)),''),'我')) ON CONFLICT DO NOTHING",
                       params![task_id,id,scope])?;
                    tx.query_row("SELECT project_id,added_at,added_by FROM task_library_references WHERE task_id=? AND item_id=?",params![task_id,id],|r|
                      Ok(json!({"ok":true,"reference":{"taskId":task_id,"itemId":id,"projectId":r.get::<_,Option<String>>(0)?,
                          "addedAt":r.get::<_,i64>(1)?,"addedBy":r.get::<_,String>(2)?}})))?
                };
                crate::request_control::commit(tx)?;
                return Ok(result);
            }
            match action.as_str() {
                "add" => {
                    tx.execute(
                        "INSERT INTO task_library_references (task_id, item_id, project_id, added_at, added_by)
                         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
                        params![
                            task_id,
                            item_id.unwrap_or_default(),
                            project_id,
                            added_at.unwrap_or(0),
                            added_by.unwrap_or_default(),
                        ],
                    )?;
                }
                "remove" => {
                    tx.execute(
                        "DELETE FROM task_library_references WHERE task_id = ?1 AND item_id = ?2",
                        params![task_id, item_id.unwrap_or_default()],
                    )?;
                }
                "clearTask" => {
                    tx.execute("DELETE FROM task_library_references WHERE task_id = ?1", [task_id])?;
                }
                other => return Err(format!("unknown libraryTaskReference action: {other}").into()),
            }
            json!({ "ok": true })
        }
        Request::LibraryDeleteTextSaveIntent {
            item_id,
            operation_id,
        } => {
            tx.execute(
                "DELETE FROM library_text_saves WHERE item_id = ?1 AND operation_id = ?2 AND committed = 0",
                params![item_id, operation_id],
            )?;
            json!({ "ok": true })
        }
        Request::LibraryDeleteBindingLinks { link_kind, id } => {
            match link_kind.as_str() {
                "workspace" => {
                    tx.execute(
                        "DELETE FROM workspace_library_links WHERE workspace_id = ?1",
                        params![id],
                    )?;
                    tx.execute(
                        "DELETE FROM workspace_library_collection_links WHERE workspace_id = ?1",
                        params![id],
                    )?;
                }
                "space" => {
                    tx.execute(
                        "DELETE FROM workspace_library_links WHERE library_space_id = ?1",
                        params![id],
                    )?;
                    tx.execute(
                        "DELETE FROM workspace_library_collection_links WHERE library_space_id = ?1",
                        params![id],
                    )?;
                }
                "collection" => {
                    tx.execute(
                        "DELETE FROM workspace_library_collection_links WHERE collection_id = ?1",
                        params![id],
                    )?;
                }
                other => {
                    return Err(format!("unknown libraryDeleteBindingLinks kind: {other}").into())
                }
            }
            json!({ "ok": true })
        }
        Request::MemoryInsertRecord {
            record,
            change_reason,
            revision_id,
        } => {
            insert_memory_within_tx(&tx, &record, &revision_id, &change_reason)?;
            json!({ "ok": true })
        }
        Request::MemoryUpdateRecord {
            id,
            memory_kind,
            title,
            content,
            status,
            importance,
            confidence,
            explicit,
            valid_from,
            valid_until,
            content_hash,
            updated_at,
            metadata_json,
            changed_by,
            change_reason,
            revision_id,
        } => {
            let changes = tx.execute(
                "UPDATE memory_records SET
                   kind=?1, title=?2, content=?3, status=?4,
                   importance=?5, confidence=?6, explicit=?7,
                   valid_from=?8, valid_until=?9, content_hash=?10,
                   updated_at=?11, metadata_json=?12
                 WHERE id=?13",
                params![
                    memory_kind,
                    title,
                    content,
                    status,
                    importance,
                    confidence,
                    i64::from(explicit),
                    valid_from,
                    valid_until,
                    content_hash,
                    updated_at,
                    metadata_json,
                    id
                ],
            )?;
            if changes == 0 {
                return Err(format!("记忆不存在：{id}").into());
            }
            let rev: i64 = tx.query_row(
                "SELECT coalesce(max(revision), 0) + 1 FROM memory_revisions WHERE memory_id = ?1",
                [&id],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO memory_revisions (id, memory_id, revision, kind, title, content, status, importance, confidence, valid_from, valid_until, changed_by, change_reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    revision_id,
                    id,
                    rev,
                    memory_kind,
                    title,
                    content,
                    status,
                    importance,
                    confidence,
                    valid_from,
                    valid_until,
                    changed_by,
                    change_reason,
                    updated_at
                ],
            )?;
            json!({ "ok": true })
        }
        Request::MemorySupersede {
            old_id,
            old_status,
            old_valid_until,
            old_updated_at,
            old_kind,
            old_title,
            old_content,
            old_importance,
            old_confidence,
            old_explicit,
            old_valid_from,
            old_content_hash,
            old_metadata_json,
            old_revision_id,
            changed_by,
            change_reason,
            replacement,
            replacement_reason,
            replacement_revision_id,
            relation,
        } => {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_records WHERE id=?1)",
                [&old_id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(format!("被替代记忆不存在：{old_id}").into());
            }
            insert_memory_within_tx(&tx, &replacement, &replacement_revision_id, &replacement_reason)?;
            tx.execute(
                "UPDATE memory_records SET
                   kind=?1, title=?2, content=?3, status=?4,
                   importance=?5, confidence=?6, explicit=?7,
                   valid_from=?8, valid_until=?9, content_hash=?10,
                   updated_at=?11, metadata_json=?12
                 WHERE id=?13",
                params![
                    old_kind,
                    old_title,
                    old_content,
                    old_status,
                    old_importance,
                    old_confidence,
                    i64::from(old_explicit),
                    old_valid_from,
                    old_valid_until,
                    old_content_hash,
                    old_updated_at,
                    old_metadata_json,
                    old_id
                ],
            )?;
            let old_rev: i64 = tx.query_row(
                "SELECT coalesce(max(revision), 0) + 1 FROM memory_revisions WHERE memory_id = ?1",
                [&old_id],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO memory_revisions (id, memory_id, revision, kind, title, content, status, importance, confidence, valid_from, valid_until, changed_by, change_reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    old_revision_id,
                    old_id,
                    old_rev,
                    old_kind,
                    old_title,
                    old_content,
                    old_status,
                    old_importance,
                    old_confidence,
                    old_valid_from,
                    old_valid_until,
                    changed_by,
                    change_reason,
                    old_updated_at
                ],
            )?;
            tx.execute(
                "INSERT INTO memory_relations (id, from_memory_id, relation, to_memory_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
                params![
                    relation.id,
                    relation.from_memory_id,
                    relation.relation,
                    relation.to_memory_id,
                    relation.created_at
                ],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryAddScope {
            id,
            memory_id,
            scope_type,
            scope_id,
            binding,
            created_at,
        } => {
            if scope_type == "project" {
                let sid = scope_id.as_deref().unwrap_or("");
                let archived: Option<i64> = tx
                    .query_row("SELECT archived FROM projects WHERE id=?1", [sid], |r| r.get(0))
                    .optional()?;
                let archived = archived.ok_or_else(|| format!("项目不存在：{sid}"))?;
                if archived != 0 {
                    return Err("项目已归档（只读），不能写入项目记忆".into());
                }
            }
            tx.execute(
                "INSERT INTO memory_scopes (id, memory_id, scope_type, scope_id, binding, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING",
                params![id, memory_id, scope_type, scope_id, binding, created_at],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryRemoveScope {
            memory_id,
            scope_type,
            scope_id,
        } => {
            match scope_type.as_deref() {
                None => {
                    tx.execute("DELETE FROM memory_scopes WHERE memory_id = ?1", [&memory_id])?;
                }
                Some("global") => {
                    tx.execute(
                        "DELETE FROM memory_scopes WHERE memory_id = ?1 AND scope_type = 'global' AND scope_id IS NULL",
                        [&memory_id],
                    )?;
                }
                Some(st) => {
                    tx.execute(
                        "DELETE FROM memory_scopes WHERE memory_id = ?1 AND scope_type = ?2 AND scope_id = ?3",
                        params![memory_id, st, scope_id.unwrap_or_default()],
                    )?;
                }
            }
            json!({ "ok": true })
        }
        Request::MemoryAddEvidence { evidence } => {
            tx.execute(
                "INSERT INTO memory_evidence (id, memory_id, evidence_kind, ref_id, ref_title, excerpt, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(memory_id, evidence_kind, ref_id) DO NOTHING",
                params![
                    evidence.id,
                    evidence.memory_id,
                    evidence.evidence_kind,
                    evidence.ref_id,
                    evidence.ref_title,
                    evidence.excerpt,
                    evidence.created_at
                ],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryRemoveEvidence { id } => {
            tx.execute("DELETE FROM memory_evidence WHERE id = ?1", [id])?;
            json!({ "ok": true })
        }
        Request::MemoryAddRelation { relation } => {
            tx.execute(
                "INSERT INTO memory_relations (id, from_memory_id, relation, to_memory_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
                params![
                    relation.id,
                    relation.from_memory_id,
                    relation.relation,
                    relation.to_memory_id,
                    relation.created_at
                ],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryRemoveRelation { id } => {
            tx.execute("DELETE FROM memory_relations WHERE id = ?1", [id])?;
            json!({ "ok": true })
        }
        Request::MemoryHardDelete { id } => {
            crate::search_postings::delete_document_postings_in_tx(&tx, &format!("memory:{id}"))?;
            tx.execute("UPDATE answer_rules SET source_id = NULL WHERE source_id = ?1", [&id])?;
            tx.execute(
                "DELETE FROM memory_relations WHERE from_memory_id = ?1 OR to_memory_id = ?1",
                [&id],
            )?;
            tx.execute("DELETE FROM memory_embeddings WHERE memory_id = ?1", [&id])?;
            tx.execute("DELETE FROM memory_evidence WHERE memory_id = ?1", [&id])?;
            tx.execute("DELETE FROM memory_revisions WHERE memory_id = ?1", [&id])?;
            tx.execute("DELETE FROM memory_scopes WHERE memory_id = ?1", [&id])?;
            tx.execute("DELETE FROM memory_candidates WHERE resolved_memory_id = ?1", [&id])?;
            tx.execute("DELETE FROM memory_records WHERE id = ?1", [&id])?;
            json!({ "ok": true })
        }
        Request::MemoryRecordRecall { ids, now } => {
            let mut seen = HashSet::new();
            for id in ids {
                if id.is_empty() || !seen.insert(id.clone()) {
                    continue;
                }
                tx.execute(
                    "UPDATE memory_records SET last_recalled_at = ?1, recall_count = recall_count + 1 WHERE id = ?2",
                    params![now, id],
                )?;
            }
            json!({ "ok": true })
        }
        Request::MemoryInsertCandidate {
            id,
            task_id,
            memory_kind,
            title,
            content,
            scope_type,
            scope_id,
            confidence,
            importance,
            explicit,
            operation_hint,
            replaces,
            status,
            raw_json,
            created_at,
            resolved_at,
        } => {
            tx.execute(
                "INSERT INTO memory_candidates (
                   id, task_id, kind, title, content, scope_type, scope_id, confidence, importance,
                   explicit, operation_hint, replaces, status, raw_json, created_at, resolved_at, resolved_memory_id
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,NULL)",
                params![
                    id,
                    task_id,
                    memory_kind,
                    title,
                    content,
                    scope_type,
                    scope_id,
                    confidence,
                    importance,
                    i64::from(explicit),
                    operation_hint,
                    replaces,
                    status,
                    raw_json,
                    created_at,
                    resolved_at
                ],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryResolveCandidate {
            id,
            status,
            resolved_at,
            resolved_memory_id,
            pending_only,
        } => {
            if pending_only {
                tx.execute(
                    "UPDATE memory_candidates SET status=?1, resolved_at=?2, resolved_memory_id=NULL WHERE id=?3 AND status='pending'",
                    params![status, resolved_at, id],
                )?;
            } else {
                tx.execute(
                    "UPDATE memory_candidates SET status=?1, resolved_at=?2, resolved_memory_id=?3 WHERE id=?4",
                    params![status, resolved_at, resolved_memory_id, id],
                )?;
            }
            json!({ "ok": true })
        }
        Request::MemoryReapStaleCandidates { older_than, now } => {
            let changes = tx.execute(
                "UPDATE memory_candidates SET status='needs_review', resolved_at=?1 WHERE status='pending' AND created_at < ?2",
                params![now, older_than],
            )?;
            json!({ "changes": changes })
        }
        Request::MemoryTurnCapture {
            turn,
            note_captured,
            now,
        } => {
            use sha2::{Digest, Sha256};
            let user_text = turn.user_text.trim();
            let assistant_text = turn.assistant_text.trim();
            let existing: Option<String> = if let Some(mid) = &turn.assistant_message_id {
                tx.query_row(
                    "SELECT id FROM memory_turns WHERE assistant_message_id=?1",
                    [mid],
                    |r| r.get(0),
                )
                .optional()?
            } else {
                tx.query_row(
                    "SELECT id FROM memory_turns WHERE task_id=?1 AND content_hash=?2 ORDER BY captured_at DESC LIMIT 1",
                    params![turn.task_id, turn.content_hash],
                    |r| r.get(0),
                )
                .optional()?
            };
            let (id, created) = if let Some(eid) = existing {
                (eid, false)
            } else {
                let mut h = Sha256::new();
                h.update(user_text.as_bytes());
                h.update("\n\u{241e}\n".as_bytes());
                h.update(assistant_text.as_bytes());
                let digest = if turn.content_hash.is_empty() {
                    to_hex(&h.finalize())
                } else {
                    turn.content_hash
                };
                tx.execute(
                    "INSERT INTO memory_turns (
                       id,task_id,session_id,user_message_id,assistant_message_id,user_text,assistant_text,content_hash,
                       captured_at,extraction_state,extracted_at,attempt_count,last_error,metadata_json
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending',NULL,0,NULL,?10)",
                    params![
                        turn.id,
                        turn.task_id,
                        turn.session_id,
                        turn.user_message_id,
                        turn.assistant_message_id,
                        user_text,
                        assistant_text,
                        digest,
                        turn.captured_at,
                        turn.metadata_json,
                    ],
                )?;
                if note_captured {
                    tx.execute(
                        "INSERT INTO memory_pipeline_state (
                           task_id,captured_turns,turns_since_l1,last_l1_at,last_l2_at,last_l3_at,l1_run_count,l2_run_count,l3_run_count,updated_at
                         ) VALUES (?1,1,1,NULL,NULL,NULL,0,0,0,?2)
                         ON CONFLICT(task_id) DO UPDATE SET
                           captured_turns=captured_turns+1,
                           turns_since_l1=turns_since_l1+1,
                           updated_at=excluded.updated_at",
                        params![turn.task_id, turn.captured_at.max(now)],
                    )?;
                }
                (turn.id, true)
            };
            json!({ "id": id, "created": created })
        }
        Request::MemoryTurnUpdateState {
            state_action,
            ids,
            now,
            task_id,
            ..
        } => {
            match state_action.as_str() {
                "processing" | "requeue" | "completed" | "failed" | "noteL1Completed" => {
                    return Err("记忆提炼状态必须通过持有者认领接口更新".into());
                }
                "skillDistilled" => {
                    for id in ids {
                        let raw: Option<String> = tx
                            .query_row(
                                "SELECT metadata_json FROM memory_turns WHERE id=?1",
                                [&id],
                                |r| r.get(0),
                            )
                            .optional()?;
                        if let Some(raw) = raw {
                            let patched = crate::database::patch_json_fields(
                                &raw,
                                &[("skillDistilled", json!(1))],
                            );
                            tx.execute(
                                "UPDATE memory_turns SET metadata_json=?1 WHERE id=?2",
                                params![patched, id],
                            )?;
                        }
                    }
                }
                "noteCaptured" => {
                    if let Some(tid) = task_id {
                        tx.execute(
                            "INSERT INTO memory_pipeline_state (
                               task_id,captured_turns,turns_since_l1,last_l1_at,last_l2_at,last_l3_at,l1_run_count,l2_run_count,l3_run_count,updated_at
                             ) VALUES (?1,1,1,NULL,NULL,NULL,0,0,0,?2)
                             ON CONFLICT(task_id) DO UPDATE SET
                               captured_turns=captured_turns+1,
                               turns_since_l1=turns_since_l1+1,
                               updated_at=excluded.updated_at",
                            params![tid, now],
                        )?;
                    }
                }
                other => return Err(format!("unknown MemoryTurnUpdateState action: {other}").into()),
            }
            json!({ "ok": true })
        }
        Request::MemoryTurnDelete {
            delete_all,
            ids,
            now,
        } => {
            let deleted = if delete_all {
                tx.execute(
                    "UPDATE memory_evidence
                     SET excerpt = COALESCE(NULLIF(excerpt,''), (
                       SELECT substr('用户：' || t.user_text || chr(10) || '助手：' || t.assistant_text, 1, 1200)
                       FROM memory_turns t WHERE t.id=memory_evidence.ref_id
                     ))
                     WHERE evidence_kind='conversation' AND ref_id IN (SELECT id FROM memory_turns)",
                    [],
                )?;
                let deleted = tx.execute("DELETE FROM memory_turns", [])?;
                tx.execute("DELETE FROM memory_pipeline_state", [])?;
                deleted
            } else {
                let mut task_ids = HashSet::new();
                let mut deleted = 0usize;
                for id in ids {
                    let row: Option<String> = tx
                        .query_row("SELECT task_id FROM memory_turns WHERE id=?1", [&id], |r| r.get(0))
                        .optional()?;
                    let Some(tid) = row else {
                        continue;
                    };
                    tx.execute(
                        "UPDATE memory_evidence
                         SET excerpt = COALESCE(NULLIF(excerpt,''), (
                           SELECT substr('用户：' || t.user_text || chr(10) || '助手：' || t.assistant_text, 1, 1200)
                           FROM memory_turns t WHERE t.id=memory_evidence.ref_id
                         )) WHERE evidence_kind='conversation' AND ref_id=?1",
                        [&id],
                    )?;
                    deleted += tx.execute("DELETE FROM memory_turns WHERE id=?1", [&id])?;
                    task_ids.insert(tid);
                }
                for tid in task_ids {
                    tx.execute(
                        "UPDATE memory_pipeline_state SET
                           captured_turns=(SELECT COUNT(*) FROM memory_turns WHERE task_id=?1),
                           turns_since_l1=(SELECT COUNT(*) FROM memory_turns WHERE task_id=?1 AND extraction_state IN ('pending','failed','processing')),
                           updated_at=?2 WHERE task_id=?1",
                        params![tid, now],
                    )?;
                    tx.execute(
                        "DELETE FROM memory_pipeline_state WHERE task_id=?1 AND NOT EXISTS (SELECT 1 FROM memory_turns WHERE task_id=?1)",
                        [&tid],
                    )?;
                }
                deleted
            };
            if deleted > 0 {
                for table in ["memory_scenarios", "memory_core_profiles"] {
                    tx.execute(&format!("UPDATE {table} SET status='stale',updated_at=?1
                        WHERE scope_type='task' AND scope_id=?2 AND status='active'"),
                        params![now, crate::DOTS_TASK_ID])?;
                }
            }
            json!({ "deleted": deleted })
        }
        Request::MemoryResetFailedTurns { eligible_ids } => {
            for id in eligible_ids {
                tx.execute(
                    "UPDATE memory_turns SET extraction_state='pending',attempt_count=0,last_error=NULL WHERE id=?1 AND extraction_state='failed'",
                    [id],
                )?;
            }
            json!({ "ok": true })
        }
        Request::MemoryUpsertWatermark {
            scope_type,
            scope_id,
            cutoff_at,
            allowed_message_id,
        } => {
            tx.execute(
                "INSERT INTO memory_forget_watermarks(scope_type,scope_id,cutoff_at,allowed_message_id) SELECT ?1,?2,?3,?4
                 WHERE NOT EXISTS (SELECT 1 FROM memory_forget_watermarks w WHERE w.scope_type=?1 AND w.scope_id=?2
                   AND (?3>w.cutoff_at OR (?3=w.cutoff_at AND (?4 IS NULL OR (w.allowed_message_id IS NOT NULL AND
                        (SELECT ordinal FROM bot_messages WHERE message_id=?4) >=
                        (SELECT ordinal FROM bot_messages WHERE message_id=w.allowed_message_id))))) IS NOT TRUE)
                 ON CONFLICT(scope_type,scope_id) DO UPDATE SET cutoff_at=excluded.cutoff_at,allowed_message_id=excluded.allowed_message_id",
                params![scope_type, scope_id, cutoff_at, allowed_message_id],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryUpsertForgetTarget {
            scope_type,
            scope_id,
            fingerprint,
            text_length,
            cutoff_at,
            allowed_message_id,
            value_fingerprint,
            guard_fingerprint,
            guard_length,
        } => {
            tx.execute(
                "INSERT INTO memory_forget_targets(scope_type,scope_id,fingerprint,text_length,cutoff_at,allowed_message_id,value_fingerprint,guard_fingerprint,guard_length)
                 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
                 WHERE NOT EXISTS (SELECT 1 FROM memory_forget_targets w WHERE w.scope_type=?1 AND w.scope_id=?2 AND w.fingerprint=?3
                   AND (?5>w.cutoff_at OR (?5=w.cutoff_at AND (?6 IS NULL OR (w.allowed_message_id IS NOT NULL AND
                        (SELECT ordinal FROM bot_messages WHERE message_id=?6) >=
                        (SELECT ordinal FROM bot_messages WHERE message_id=w.allowed_message_id))))) IS NOT TRUE)
                 ON CONFLICT(scope_type,scope_id,fingerprint) DO UPDATE SET
                 cutoff_at=excluded.cutoff_at,allowed_message_id=excluded.allowed_message_id",
                params![
                    scope_type,
                    scope_id,
                    fingerprint,
                    text_length,
                    cutoff_at,
                    allowed_message_id,
                    value_fingerprint,
                    guard_fingerprint,
                    guard_length
                ],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryInsertForgetReceipt {
            scope_type,
            scope_id,
            source_message_id,
            request_fingerprint,
        } => {
            tx.execute(
                "INSERT INTO memory_forget_receipts(scope_type,scope_id,source_message_id,request_fingerprint)
                 VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                params![scope_type, scope_id, source_message_id, request_fingerprint],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryUpsertEmbedding {
            memory_id,
            model_id,
            model_version,
            content_hash,
            dimension,
            embedding_base64,
            created_at,
        } => {
            let current: Option<(String, String)> = tx
                .query_row(
                    "SELECT content_hash, status FROM memory_records WHERE id=?1",
                    [&memory_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let changed = match current {
                Some((hash, status)) if status == "active" && hash == content_hash => {
                    let bytes = STANDARD
                        .decode(embedding_base64.as_bytes())
                        .map_err(|e| format!("invalid embedding base64: {e}"))?;
                    let c = tx.execute(
                        "INSERT INTO memory_embeddings (memory_id,model_id,model_version,content_hash,dimension,embedding,created_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7)
                         ON CONFLICT(memory_id,model_id,model_version) DO UPDATE SET
                           content_hash=excluded.content_hash, dimension=excluded.dimension, embedding=excluded.embedding, created_at=excluded.created_at
                         WHERE content_hash<>excluded.content_hash OR dimension<>excluded.dimension OR octet_length(embedding)<>octet_length(excluded.embedding)",
                        params![memory_id, model_id, model_version, content_hash, dimension, bytes, created_at],
                    )?;
                    if c > 0 { "indexed" } else { "current" }
                }
                _ => "skipped",
            };
            json!({ "outcome": changed })
        }
        Request::MemoryRecallLineageRecord {
            assistant_id,
            lineage_json,
        } => {
            let lineage_val: Value = serde_json::from_str(&lineage_json).unwrap_or(Value::Null);
            let run_rows: Vec<(String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT message_id, context_json FROM bot_request_runs WHERE message_id=?1",
                )?;
                stmt.query_map([&assistant_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<duckdb::Result<_>>()?
            };
            for (mid, raw) in run_rows {
                let patched = crate::database::patch_json_fields(
                    &raw,
                    &[("memoryRecallDependencies", lineage_val.clone())],
                );
                tx.execute(
                    "UPDATE bot_request_runs SET context_json=?1 WHERE message_id=?2",
                    params![patched, mid],
                )?;
            }
            let turn_rows: Vec<(String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT id, metadata_json FROM memory_turns WHERE assistant_message_id=?1",
                )?;
                stmt.query_map([&assistant_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<duckdb::Result<_>>()?
            };
            for (tid, raw) in turn_rows {
                let patched = crate::database::patch_json_fields(
                    &raw,
                    &[("memoryRecallDependencies", lineage_val.clone())],
                );
                tx.execute(
                    "UPDATE memory_turns SET metadata_json=?1 WHERE id=?2",
                    params![patched, tid],
                )?;
            }
            json!({ "ok": true })
        }
        Request::WorkMemoryUpsertReceipt {
            source_key,
            memory_id,
            content_hash,
            updated_at,
        } => {
            tx.execute(
                "INSERT INTO memory_capture_receipts(source_key,memory_id,content_hash,updated_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(source_key) DO UPDATE SET content_hash=excluded.content_hash,updated_at=excluded.updated_at",
                params![source_key, memory_id, content_hash, updated_at],
            )?;
            json!({ "ok": true })
        }
        Request::WorkMemoryRepairMeta {
            memory_id,
            source_key,
            updated_at,
        } => {
            tx.execute(
                "UPDATE memory_records SET source_type='event',source_id=NULL,source_task_id=NULL WHERE id=?1",
                [&memory_id],
            )?;
            tx.execute(
                "UPDATE memory_capture_receipts SET suppressed=0,content_hash='',updated_at=?1 WHERE memory_id=?2 AND source_key=?3",
                params![updated_at, memory_id, source_key],
            )?;
            json!({ "ok": true })
        }
        Request::WorkMemorySuppressReceipt {
            source_key,
            updated_at,
        } => {
            tx.execute(
                "UPDATE memory_capture_receipts SET suppressed=1,updated_at=?1 WHERE source_key=?2",
                params![updated_at, source_key],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryTouchProjectScopes { project_ids, now } => {
            for pid in project_ids {
                tx.execute(
                    "UPDATE projects SET updated_at = GREATEST(updated_at + 1, ?1) WHERE id = ?2",
                    params![now, pid],
                )?;
            }
            json!({ "ok": true })
        }
        Request::MemoryTurnSetDurableProjection { task_id, entry_id } => {
            tx.execute(
                "INSERT INTO durable_bot_memory_projection(task_id,entry_id) VALUES (?1,?2)
                 ON CONFLICT(task_id) DO UPDATE SET entry_id=excluded.entry_id",
                params![task_id, entry_id],
            )?;
            json!({ "ok": true })
        }
        Request::MemorySkillHistoryDelete {
            kind_name,
            delete_all,
            ids,
        } => {
            let table = match kind_name.as_str() {
                "candidate" => "memory_skill_candidates",
                "revision" => "memory_skill_revision_candidates",
                other => return Err(format!("unknown skill history kind: {other}").into()),
            };
            let deleted = if delete_all {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE status IN ('stale','rejected')"),
                    [],
                )? as i64
            } else {
                for id in &ids {
                    let status: Option<String> = tx
                        .query_row(
                            &format!("SELECT status FROM {table} WHERE id=?1"),
                            [id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if let Some(st) = status {
                        if st != "stale" && st != "rejected" {
                            return Err("只能删除已过期或已拒绝的历史记录；待处理记录请拒绝，已生成技能请在技能中心管理。".into());
                        }
                    }
                }
                let mut total = 0i64;
                for id in ids {
                    total += tx.execute(
                        &format!(
                            "DELETE FROM {table} WHERE id=?1 AND status IN ('stale','rejected')"
                        ),
                        [id],
                    )? as i64;
                }
                total
            };
            json!({ "deleted": deleted })
        }
        Request::MemoryOrganizationRecover { now, error } => {
            let matching: Vec<(String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT id, state_json FROM memory_organization_runs WHERE json_extract_string(state_json,'$.run.status')='scanning'",
                )?;
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<duckdb::Result<_>>()?
            };
            for (rid, raw) in matching {
                let mut doc: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
                if let Some(run) = doc.get_mut("run").and_then(Value::as_object_mut) {
                    run.insert("status".into(), json!("paused"));
                    run.insert("updatedAt".into(), json!(now));
                    run.insert("error".into(), json!(error));
                }
                tx.execute(
                    "UPDATE memory_organization_runs SET updated_at=?1, state_json=?2 WHERE id=?3",
                    params![now, serde_json::to_string(&doc)?, rid],
                )?;
            }
            json!({ "ok": true })
        }
        Request::MemoryOrganizationSaveRun {
            id,
            created_at,
            updated_at,
            state_json,
        } => {
            tx.execute(
                "INSERT INTO memory_organization_runs(id,created_at,updated_at,state_json) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,state_json=excluded.state_json",
                params![id, created_at, updated_at, state_json],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryOrganizationPauseRun { id, at } => {
            let raw: Option<String> = tx
                .query_row(
                    "SELECT state_json FROM memory_organization_runs
                     WHERE id=?1 AND json_extract_string(state_json,'$.run.status') IN ('scanning','paused')",
                    [&id],
                    |r| r.get(0),
                )
                .optional()?;
            let run_json = if let Some(raw) = raw {
                let mut doc: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
                if let Some(run) = doc.get_mut("run").and_then(Value::as_object_mut) {
                    run.insert("status".into(), json!("paused"));
                    run.insert("updatedAt".into(), json!(at));
                }
                let updated = serde_json::to_string(&doc)?;
                tx.execute(
                    "UPDATE memory_organization_runs SET updated_at=?1, state_json=?2 WHERE id=?3",
                    params![at, updated, id],
                )?;
                doc.get("run").map(serde_json::to_string).transpose()?
            } else {
                None
            };
            json!({ "runJson": run_json })
        }
        Request::MemoryOrganizationMarkApplied {
            id,
            created_at,
            updated_at,
            state_json,
        } => {
            tx.execute(
                "INSERT INTO memory_organization_runs(id,created_at,updated_at,state_json) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,state_json=excluded.state_json",
                params![id, created_at, updated_at, state_json],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryOrganizationDeleteUndo {
            evidence_ids,
            relation_ids,
            id,
            created_at,
            updated_at,
            state_json,
        } => {
            for eid in evidence_ids {
                tx.execute("DELETE FROM memory_evidence WHERE id=?1", [eid])?;
            }
            for rid in relation_ids {
                tx.execute("DELETE FROM memory_relations WHERE id=?1", [rid])?;
            }
            tx.execute(
                "INSERT INTO memory_organization_runs(id,created_at,updated_at,state_json) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,state_json=excluded.state_json",
                params![id, created_at, updated_at, state_json],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryProjectionSyncScenarios {
            scope_type,
            scope_id,
            rows,
            now,
        } => {
            if rows.is_empty() {
                if let Some(sid) = &scope_id {
                    tx.execute(
                        "UPDATE memory_scenarios SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id=?3 AND status='active'",
                        params![now, scope_type, sid],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE memory_scenarios SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id IS NULL AND status='active'",
                        params![now, scope_type],
                    )?;
                }
            } else {
                let active_ids: HashSet<String> = rows.iter().map(|r| r.id.clone()).collect();
                let mut existing_ids = Vec::new();
                if let Some(sid) = &scope_id {
                    let mut stmt = tx.prepare("SELECT id FROM memory_scenarios WHERE scope_type=?1 AND scope_id=?2 AND status='active'")?;
                    for row in stmt.query_map(params![scope_type, sid], |r| r.get::<_, String>(0))? {
                        existing_ids.push(row?);
                    }
                } else {
                    let mut stmt = tx.prepare("SELECT id FROM memory_scenarios WHERE scope_type=?1 AND scope_id IS NULL AND status='active'")?;
                    for row in stmt.query_map([&scope_type], |r| r.get::<_, String>(0))? {
                        existing_ids.push(row?);
                    }
                }
                for eid in existing_ids {
                    if !active_ids.contains(&eid) {
                        tx.execute(
                            "UPDATE memory_scenarios SET status='stale',updated_at=?1 WHERE id=?2",
                            params![now, eid],
                        )?;
                    }
                }
                for r in rows {
                    tx.execute(
                        "INSERT INTO memory_scenarios (
                           id,scope_type,scope_id,title,summary,status,source_memory_ids_json,content_hash,created_at,updated_at
                         ) VALUES (?1,?2,?3,?4,?5,'active',?6,?7,?8,?9)
                         ON CONFLICT(id) DO UPDATE SET
                           title=excluded.title,
                           summary=excluded.summary,
                           status='active',
                           source_memory_ids_json=excluded.source_memory_ids_json,
                           content_hash=excluded.content_hash,
                           updated_at=CASE
                             WHEN memory_scenarios.content_hash<>excluded.content_hash OR memory_scenarios.status<>'active' THEN excluded.updated_at
                             ELSE memory_scenarios.updated_at
                           END
                         WHERE memory_scenarios.content_hash<>excluded.content_hash OR memory_scenarios.status<>'active'
                           OR memory_scenarios.source_memory_ids_json<>excluded.source_memory_ids_json",
                        params![
                            r.id,
                            scope_type,
                            scope_id,
                            r.title,
                            r.summary,
                            r.source_memory_ids_json,
                            r.content_hash,
                            r.created_at,
                            r.updated_at
                        ],
                    )?;
                }
            }
            json!({ "ok": true })
        }
        Request::MemoryProjectionUpsertProfile {
            id,
            scope_type,
            scope_id,
            title,
            content,
            source_scenario_ids_json,
            content_hash,
            created_at,
            updated_at,
        } => {
            if let Some(sid) = &scope_id {
                tx.execute(
                    "UPDATE memory_core_profiles SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id=?3 AND id<>?4 AND status='active'",
                    params![updated_at, scope_type, sid, id],
                )?;
            } else {
                tx.execute(
                    "UPDATE memory_core_profiles SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id IS NULL AND id<>?3 AND status='active'",
                    params![updated_at, scope_type, id],
                )?;
            }
            tx.execute(
                "INSERT INTO memory_core_profiles (
                   id,scope_type,scope_id,title,content,status,source_scenario_ids_json,content_hash,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,'active',?6,?7,?8,?9)
                 ON CONFLICT(id) DO UPDATE SET
                   title=excluded.title,
                   content=excluded.content,
                   status='active',
                   source_scenario_ids_json=excluded.source_scenario_ids_json,
                   content_hash=excluded.content_hash,
                   updated_at=CASE
                     WHEN memory_core_profiles.content_hash<>excluded.content_hash OR memory_core_profiles.status<>'active' THEN excluded.updated_at
                     ELSE memory_core_profiles.updated_at
                   END
                 WHERE memory_core_profiles.content_hash<>excluded.content_hash OR memory_core_profiles.status<>'active'
                   OR memory_core_profiles.source_scenario_ids_json<>excluded.source_scenario_ids_json",
                params![
                    id,
                    scope_type,
                    scope_id,
                    title,
                    content,
                    source_scenario_ids_json,
                    content_hash,
                    created_at,
                    updated_at
                ],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryProjectionMarkStale {
            proj_action,
            id,
            scope_type,
            scope_id,
            source_memory_ids,
            now,
        } => {
            let mut changes = 0usize;
            match proj_action.as_str() {
                "scenarioByMemory" => {
                    let needle: std::collections::HashSet<&str> =
                        source_memory_ids.iter().map(String::as_str).collect();
                    let sids: Vec<String> = {
                        let mut stmt = tx.prepare(
                            "SELECT id, source_memory_ids_json FROM memory_scenarios WHERE status='active'",
                        )?;
                        let mut rows = stmt.query([])?;
                        let mut out = Vec::new();
                        while let Some(r) = rows.next()? {
                            let sid: String = r.get(0)?;
                            let raw: String = r.get(1)?;
                            if serde_json::from_str::<Vec<String>>(&raw)
                                .map(|v| v.iter().any(|x| needle.contains(x.as_str())))
                                .unwrap_or(false)
                            {
                                out.push(sid);
                            }
                        }
                        out
                    };
                    for sid in sids {
                        changes += tx.execute(
                            "UPDATE memory_scenarios SET status='stale',updated_at=?1 WHERE id=?2",
                            params![now, sid],
                        )?;
                    }
                }
                "profileById" => {
                    if let Some(pid) = id {
                        changes = tx.execute(
                            "UPDATE memory_core_profiles SET status='stale',updated_at=?1 WHERE id=?2 AND status='active'",
                            params![now, pid],
                        )?;
                    }
                }
                "byScope" => {
                    if let Some(st) = scope_type {
                        if let Some(sid) = scope_id {
                            changes += tx.execute(
                                "UPDATE memory_scenarios SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id=?3 AND status='active'",
                                params![now, st, sid],
                            )?;
                            changes += tx.execute(
                                "UPDATE memory_core_profiles SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id=?3 AND status='active'",
                                params![now, st, sid],
                            )?;
                        } else {
                            changes += tx.execute(
                                "UPDATE memory_scenarios SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id IS NULL AND status='active'",
                                params![now, st],
                            )?;
                            changes += tx.execute(
                                "UPDATE memory_core_profiles SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id IS NULL AND status='active'",
                                params![now, st],
                            )?;
                        }
                    }
                }
                "profilesByScope" => {
                    if let Some(st) = scope_type {
                        if let Some(sid) = scope_id {
                            changes += tx.execute(
                                "UPDATE memory_core_profiles SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id=?3 AND status='active'",
                                params![now, st, sid],
                            )?;
                        } else {
                            changes += tx.execute(
                                "UPDATE memory_core_profiles SET status='stale',updated_at=?1 WHERE scope_type=?2 AND scope_id IS NULL AND status='active'",
                                params![now, st],
                            )?;
                        }
                    }
                }
                other => return Err(format!("unknown MemoryProjectionMarkStale action: {other}").into()),
            }
            json!({ "changes": changes })
        }
        Request::MemoryProjectionPruneTask { task_id } => {
            tx.execute(
                "DELETE FROM memory_scenarios WHERE scope_type='task' AND scope_id=?1 AND status='stale'",
                [&task_id],
            )?;
            tx.execute(
                "DELETE FROM memory_core_profiles WHERE scope_type='task' AND scope_id=?1 AND status='stale'",
                [&task_id],
            )?;
            json!({ "ok": true })
        }
        Request::MemoryProjectionDismiss {
            id,
            proj_kind,
            title,
            scope_type,
            scope_id,
            dismissed_at,
        } => {
            tx.execute(
                "INSERT INTO memory_projection_dismissals (id,kind,title,scope_type,scope_id,dismissed_at)
                 VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET dismissed_at=excluded.dismissed_at",
                params![id, proj_kind, title, scope_type, scope_id, dismissed_at],
            )?;
            if proj_kind == "scenario" {
                tx.execute("DELETE FROM memory_scenarios WHERE id=?1", [&id])?;
                let pids: Vec<String> = {
                    let mut stmt = tx.prepare(
                        "SELECT id, source_scenario_ids_json FROM memory_core_profiles WHERE status='active'",
                    )?;
                    let mut rows = stmt.query([])?;
                    let mut out = Vec::new();
                    while let Some(r) = rows.next()? {
                        let pid: String = r.get(0)?;
                        let raw: String = r.get(1)?;
                        if serde_json::from_str::<Vec<String>>(&raw)
                            .map(|v| v.iter().any(|x| x == &id))
                            .unwrap_or(false)
                        {
                            out.push(pid);
                        }
                    }
                    out
                };
                for pid in pids {
                    tx.execute(
                        "UPDATE memory_core_profiles SET status='stale',updated_at=?1 WHERE id=?2 AND status='active'",
                        params![dismissed_at, pid],
                    )?;
                }
            } else {
                tx.execute("DELETE FROM memory_core_profiles WHERE id=?1", [&id])?;
            }
            json!({ "ok": true })
        }
        Request::MemoryProjectionDelete {
            scope,
            proj_kind,
            id,
        } => {
            let mut projections = 0usize;
            let mut dismissals = 0usize;
            let mut proposals = 0usize;
            let table = if proj_kind == "scenario" {
                "memory_scenarios"
            } else {
                "memory_core_profiles"
            };
            if scope == "all" {
                if proj_kind == "scenario" {
                    let deleted_ids: std::collections::HashSet<String> = {
                        let mut stmt = tx.prepare("SELECT id FROM memory_scenarios")?;
                        stmt.query_map([], |r| r.get(0))?
                            .collect::<std::result::Result<_, _>>()?
                    };
                    if !deleted_ids.is_empty() {
                        let prop_ids: Vec<String> = {
                            let mut stmt = tx.prepare(
                                "SELECT id, source_ids_json FROM memory_projection_proposals WHERE kind='profile'",
                            )?;
                            let mut rows = stmt.query([])?;
                            let mut out = Vec::new();
                            while let Some(r) = rows.next()? {
                                let pid: String = r.get(0)?;
                                let raw: String = r.get(1)?;
                                if serde_json::from_str::<Vec<String>>(&raw)
                                    .map(|v| v.iter().any(|x| deleted_ids.contains(x)))
                                    .unwrap_or(false)
                                {
                                    out.push(pid);
                                }
                            }
                            out
                        };
                        for pid in prop_ids {
                            tx.execute(
                                "DELETE FROM memory_projection_proposals WHERE id=?1",
                                [pid],
                            )?;
                        }
                    }
                }
                projections = tx.execute(&format!("DELETE FROM {table}"), [])?;
                dismissals = tx.execute("DELETE FROM memory_projection_dismissals WHERE kind=?1", [&proj_kind])?;
                proposals = tx.execute("DELETE FROM memory_projection_proposals WHERE kind=?1", [&proj_kind])?;
            } else if let Some(target) = id {
                if proj_kind == "scenario" {
                    let prop_ids: Vec<String> = {
                        let mut stmt = tx.prepare(
                            "SELECT id, source_ids_json FROM memory_projection_proposals WHERE kind='profile'",
                        )?;
                        let mut rows = stmt.query([])?;
                        let mut out = Vec::new();
                        while let Some(r) = rows.next()? {
                            let pid: String = r.get(0)?;
                            let raw: String = r.get(1)?;
                            if serde_json::from_str::<Vec<String>>(&raw)
                                .map(|v| v.iter().any(|x| x == &target))
                                .unwrap_or(false)
                            {
                                out.push(pid);
                            }
                        }
                        out
                    };
                    for pid in prop_ids {
                        tx.execute(
                            "DELETE FROM memory_projection_proposals WHERE id=?1",
                            [pid],
                        )?;
                    }
                }
                projections = tx.execute(&format!("DELETE FROM {table} WHERE id=?1"), [&target])?;
                dismissals = tx.execute(
                    "DELETE FROM memory_projection_dismissals WHERE id=?1 AND kind=?2",
                    params![target, proj_kind],
                )?;
                proposals = tx.execute(
                    "DELETE FROM memory_projection_proposals WHERE target_id=?1 AND kind=?2",
                    params![target, proj_kind],
                )?;
                proposals += tx.execute(
                    "DELETE FROM memory_projection_proposals WHERE id=?1 AND kind=?2",
                    params![target, proj_kind],
                )?;
            }
            json!({ "projections": projections, "dismissals": dismissals, "proposals": proposals })
        }
        Request::MemoryProjectionRestoreDismissal { id } => {
            let changes = tx.execute("DELETE FROM memory_projection_dismissals WHERE id=?1", [id])?;
            json!({ "restored": changes > 0 })
        }
        Request::MemoryProjectionPropose {
            proj_kind,
            scope_type,
            scope_id,
            proposals,
            now,
        } => {
            let mut created = 0usize;
            for p in proposals {
                let c = tx.execute(
                    "INSERT INTO memory_projection_proposals
                       (id,kind,scope_type,scope_id,title,body,source_ids_json,target_id,status,created_at,updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending',?9,?9)
                     ON CONFLICT(id) DO UPDATE SET
                       body=excluded.body, source_ids_json=excluded.source_ids_json,
                       target_id=excluded.target_id, updated_at=excluded.updated_at
                     WHERE memory_projection_proposals.status='pending'",
                    params![
                        p.id,
                        proj_kind,
                        scope_type,
                        scope_id,
                        p.title,
                        p.body,
                        p.source_ids_json,
                        p.target_id,
                        now
                    ],
                )?;
                if c > 0 {
                    created += 1;
                }
            }
            json!({ "created": created })
        }
        Request::MemoryProjectionProposalAction {
            proj_action,
            id,
            now,
            created_id,
            scope_type,
            scope_id,
            title,
            body,
            sources_json,
            content_hash,
        } => {
            let ok = match proj_action.as_str() {
                "reject" => tx.execute(
                    "UPDATE memory_projection_proposals SET status='rejected',updated_at=?1 WHERE id=?2 AND status='pending'",
                    params![now, id],
                )? > 0,
                "restore" => tx.execute(
                    "UPDATE memory_projection_proposals SET status='pending',updated_at=?1 WHERE id=?2 AND status='rejected'",
                    params![now, id],
                )? > 0,
                "approveScenario" => {
                    let target_id = created_id.ok_or("missing created_id")?;
                    let st = scope_type.ok_or("missing scope_type")?;
                    let t = title.ok_or("missing title")?;
                    let b = body.ok_or("missing body")?;
                    let s = sources_json.ok_or("missing sources_json")?;
                    let ch = content_hash.ok_or("missing content_hash")?;
                    tx.execute(
                        "INSERT INTO memory_scenarios
                           (id,scope_type,scope_id,title,summary,status,source_memory_ids_json,content_hash,created_at,updated_at)
                         VALUES (?1,?2,?3,?4,?5,'active',?6,?7,?8,?8)
                         ON CONFLICT(id) DO UPDATE SET
                           title=excluded.title,summary=excluded.summary,status='active',
                           source_memory_ids_json=excluded.source_memory_ids_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at",
                        params![target_id, st, scope_id, t, b, s, ch, now],
                    )?;
                    tx.execute("DELETE FROM memory_projection_dismissals WHERE id=?1", [&target_id])?;
                    tx.execute("DELETE FROM memory_projection_proposals WHERE id=?1", [&id])?;
                    true
                }
                "approveProfile" => {
                    let target_id = created_id.ok_or("missing created_id")?;
                    let st = scope_type.ok_or("missing scope_type")?;
                    let t = title.ok_or("missing title")?;
                    let b = body.ok_or("missing body")?;
                    let s = sources_json.ok_or("missing sources_json")?;
                    let ch = content_hash.ok_or("missing content_hash")?;
                    tx.execute(
                        "INSERT INTO memory_core_profiles
                           (id,scope_type,scope_id,title,content,status,source_scenario_ids_json,content_hash,created_at,updated_at)
                         VALUES (?1,?2,?3,?4,?5,'active',?6,?7,?8,?8)
                         ON CONFLICT(id) DO UPDATE SET
                           title=excluded.title,content=excluded.content,status='active',
                           source_scenario_ids_json=excluded.source_scenario_ids_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at",
                        params![target_id, st, scope_id, t, b, s, ch, now],
                    )?;
                    tx.execute("DELETE FROM memory_projection_dismissals WHERE id=?1", [&target_id])?;
                    tx.execute("DELETE FROM memory_projection_proposals WHERE id=?1", [&id])?;
                    true
                }
                other => return Err(format!("unknown proposal action: {other}").into()),
            };
            json!({ "ok": ok })
        }
        Request::MemorySkillCandidateUpsert {
            id,
            slug,
            title,
            description,
            instructions,
            status,
            scope_type,
            scope_id,
            source_memory_ids_json,
            source_signature,
            support_count,
            distinct_task_count,
            completed_task_count,
            evidence_count,
            confidence,
            score,
            installed_skill_id,
            created_at,
            updated_at,
            resolved_at,
        } => {
            tx.execute(
                "INSERT INTO memory_skill_candidates (
                   id,slug,title,description,instructions,status,scope_type,scope_id,
                   source_memory_ids_json,source_signature,support_count,distinct_task_count,completed_task_count,evidence_count,
                   confidence,score,installed_skill_id,created_at,updated_at,resolved_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
                 ON CONFLICT(id) DO UPDATE SET
                   slug=excluded.slug,
                   title=excluded.title,
                   description=excluded.description,
                   instructions=excluded.instructions,
                   status=CASE
                     WHEN memory_skill_candidates.status IN ('rejected','materialized') THEN memory_skill_candidates.status
                     ELSE excluded.status
                   END,
                   scope_type=excluded.scope_type,
                   scope_id=excluded.scope_id,
                   source_memory_ids_json=excluded.source_memory_ids_json,
                   source_signature=excluded.source_signature,
                   support_count=excluded.support_count,
                   distinct_task_count=excluded.distinct_task_count,
                   completed_task_count=excluded.completed_task_count,
                   evidence_count=excluded.evidence_count,
                   confidence=excluded.confidence,
                   score=excluded.score,
                   updated_at=excluded.updated_at",
                params![
                    id,
                    slug,
                    title,
                    description,
                    instructions,
                    status,
                    scope_type,
                    scope_id,
                    source_memory_ids_json,
                    source_signature,
                    support_count,
                    distinct_task_count,
                    completed_task_count,
                    evidence_count,
                    confidence,
                    score,
                    installed_skill_id,
                    created_at,
                    updated_at,
                    resolved_at,
                ],
            )?;
            json!({ "ok": true })
        }
        Request::MemorySkillCandidateStatus {
            cand_action,
            id,
            ids,
            installed_skill_id,
            now,
        } => {
            let mut changes = 0usize;
            match cand_action.as_str() {
                "staleUngroundedIds" => {
                    for cid in ids {
                        changes += tx.execute(
                            "UPDATE memory_skill_candidates SET status='stale',updated_at=?1
                             WHERE id=?2 AND status IN ('draft','ready','materialized')",
                            params![now, cid],
                        )?;
                    }
                }
                "invalidateByMemoryIds" => {
                    let needle: std::collections::HashSet<&str> =
                        ids.iter().map(String::as_str).collect();
                    let cand_ids: Vec<String> = {
                        let mut stmt = tx.prepare(
                            "SELECT id, source_memory_ids_json FROM memory_skill_candidates
                             WHERE status IN ('draft','ready','materialized')",
                        )?;
                        let mut rows = stmt.query([])?;
                        let mut out = Vec::new();
                        while let Some(r) = rows.next()? {
                            let cid: String = r.get(0)?;
                            let raw: String = r.get(1)?;
                            if serde_json::from_str::<Vec<String>>(&raw)
                                .map(|v| v.iter().any(|x| needle.contains(x.as_str())))
                                .unwrap_or(false)
                            {
                                out.push(cid);
                            }
                        }
                        out
                    };
                    for cid in cand_ids {
                        changes += tx.execute(
                            "UPDATE memory_skill_candidates SET status='stale',updated_at=?1 WHERE id=?2",
                            params![now, cid],
                        )?;
                    }
                }
                "reject" => {
                    let cid = id.ok_or("missing candidate id")?;
                    changes = tx.execute(
                        "UPDATE memory_skill_candidates SET status='rejected',resolved_at=?1,updated_at=?1 WHERE id=?2",
                        params![now, cid],
                    )?;
                }
                "staleOne" => {
                    let cid = id.ok_or("missing candidate id")?;
                    changes = tx.execute(
                        "UPDATE memory_skill_candidates SET status='stale',updated_at=?1 WHERE id=?2",
                        params![now, cid],
                    )?;
                }
                "materialize" => {
                    let cid = id.ok_or("missing candidate id")?;
                    let skill = installed_skill_id.ok_or("missing installed_skill_id")?;
                    changes = tx.execute(
                        "UPDATE memory_skill_candidates SET status='materialized',installed_skill_id=?1,resolved_at=?2,updated_at=?2 WHERE id=?3",
                        params![skill, now, cid],
                    )?;
                }
                other => return Err(format!("unknown MemorySkillCandidateStatus action: {other}").into()),
            }
            json!({ "changes": changes })
        }
        Request::MemorySkillRevisionUpsert {
            id,
            skill_id,
            base_candidate_id,
            base_version,
            base_content_hash,
            title,
            status,
            issue_summary,
            base_description,
            base_instructions,
            proposed_description,
            proposed_instructions,
            negative_feedback_ids_json,
            source_memory_ids_json,
            feedback_signature,
            needs_revision_count,
            incorrect_count,
            failed_invocation_count,
            created_at,
            updated_at,
            resolved_at,
            materialized_candidate_id,
            materialized_version,
        } => {
            tx.execute(
                "INSERT INTO memory_skill_revision_candidates (
                   id,skill_id,base_candidate_id,base_version,base_content_hash,title,status,issue_summary,
                   base_description,base_instructions,proposed_description,proposed_instructions,
                   negative_feedback_ids_json,source_memory_ids_json,feedback_signature,
                   needs_revision_count,incorrect_count,failed_invocation_count,
                   created_at,updated_at,resolved_at,materialized_candidate_id,materialized_version
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
                 ON CONFLICT(id) DO UPDATE SET
                   title=excluded.title,
                   status=CASE WHEN memory_skill_revision_candidates.status IN ('rejected','materialized') THEN memory_skill_revision_candidates.status ELSE excluded.status END,
                   issue_summary=excluded.issue_summary,
                   proposed_description=excluded.proposed_description,
                   proposed_instructions=excluded.proposed_instructions,
                   negative_feedback_ids_json=excluded.negative_feedback_ids_json,
                   source_memory_ids_json=excluded.source_memory_ids_json,
                   feedback_signature=excluded.feedback_signature,
                   needs_revision_count=excluded.needs_revision_count,
                   incorrect_count=excluded.incorrect_count,
                   failed_invocation_count=excluded.failed_invocation_count,
                   updated_at=excluded.updated_at",
                params![
                    id,
                    skill_id,
                    base_candidate_id,
                    base_version,
                    base_content_hash,
                    title,
                    status,
                    issue_summary,
                    base_description,
                    base_instructions,
                    proposed_description,
                    proposed_instructions,
                    negative_feedback_ids_json,
                    source_memory_ids_json,
                    feedback_signature,
                    needs_revision_count,
                    incorrect_count,
                    failed_invocation_count,
                    created_at,
                    updated_at,
                    resolved_at,
                    materialized_candidate_id,
                    materialized_version,
                ],
            )?;
            let staled = tx.execute(
                "UPDATE memory_skill_revision_candidates SET status='stale',updated_at=?1
                 WHERE skill_id=?2 AND COALESCE(base_candidate_id,'')=COALESCE(?3, '') AND id<>?4 AND status IN ('draft','ready')",
                params![updated_at, skill_id, base_candidate_id, id],
            )?;
            json!({ "staled": staled })
        }
        Request::MemorySkillRevisionStatus {
            rev_action,
            id,
            ids,
            materialized_candidate_id,
            materialized_version,
            skill_id,
            base_candidate_id,
            now,
        } => {
            let mut changes = 0usize;
            match rev_action.as_str() {
                "reject" => {
                    let rid = id.ok_or("missing rev id")?;
                    changes = tx.execute(
                        "UPDATE memory_skill_revision_candidates SET status='rejected',resolved_at=?1,updated_at=?1 WHERE id=?2",
                        params![now, rid],
                    )?;
                }
                "staleOne" => {
                    let rid = id.ok_or("missing rev id")?;
                    changes = tx.execute(
                        "UPDATE memory_skill_revision_candidates SET status='stale',updated_at=?1 WHERE id=?2",
                        params![now, rid],
                    )?;
                }
                "materialize" => {
                    let rid = id.ok_or("missing rev id")?;
                    changes = tx.execute(
                        "UPDATE memory_skill_revision_candidates
                         SET status='materialized',materialized_candidate_id=?1,materialized_version=?2,resolved_at=?3,updated_at=?3 WHERE id=?4",
                        params![materialized_candidate_id, materialized_version, now, rid],
                    )?;
                }
                "staleIds" => {
                    for rid in ids {
                        changes += tx.execute(
                            "UPDATE memory_skill_revision_candidates SET status='stale',updated_at=?1 WHERE id=?2 AND status IN ('draft','ready')",
                            params![now, rid],
                        )?;
                    }
                }
                "staleForBase" => {
                    let sid = skill_id.ok_or("missing skill_id")?;
                    changes = tx.execute(
                        "UPDATE memory_skill_revision_candidates SET status='stale',updated_at=?1
                         WHERE skill_id=?2 AND COALESCE(base_candidate_id,'')=COALESCE(?3, '') AND status IN ('draft','ready')",
                        params![now, sid, base_candidate_id],
                    )?;
                }
                other => return Err(format!("unknown MemorySkillRevisionStatus action: {other}").into()),
            }
            json!({ "changes": changes })
        }
        Request::MemorySkillEffectivenessOp {
            eff_action,
            task_id,
            assistant_message_id,
            exposures,
            skill_id,
            inv_kind,
            tool_call_id,
            outcome,
            id,
            feedback_kind,
            feedback_note,
            at,
        } => {
            let mut changes = 0usize;
            match eff_action.as_str() {
                "recordExposure" => {
                    let tid = task_id.as_deref().ok_or("missing task_id")?;
                    let amid = assistant_message_id.as_deref().ok_or("missing assistant_message_id")?;
                    for exp in exposures {
                        changes += tx.execute(
                            "INSERT INTO memory_skill_effectiveness (
                               id,task_id,assistant_message_id,skill_id,candidate_id,source_memory_ids_json,
                               exposed_at,outcome,updated_at
                             ) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?7)
                             ON CONFLICT(task_id,assistant_message_id,skill_id) DO UPDATE SET
                               candidate_id=COALESCE(memory_skill_effectiveness.candidate_id,excluded.candidate_id),
                               source_memory_ids_json=CASE
                                 WHEN memory_skill_effectiveness.source_memory_ids_json='[]' THEN excluded.source_memory_ids_json
                                 ELSE memory_skill_effectiveness.source_memory_ids_json
                               END,
                               updated_at=GREATEST(memory_skill_effectiveness.updated_at, excluded.updated_at)",
                            params![
                                exp.id,
                                tid,
                                amid,
                                exp.skill_id,
                                exp.candidate_id,
                                exp.source_memory_ids_json,
                                at
                            ],
                        )?;
                    }
                }
                "markInvoked" => {
                    let tid = task_id.as_deref().ok_or("missing task_id")?;
                    let amid = assistant_message_id.as_deref().ok_or("missing assistant_message_id")?;
                    let sid = skill_id.as_deref().ok_or("missing skill_id")?;
                    for exp in exposures {
                        tx.execute(
                            "INSERT INTO memory_skill_effectiveness (
                               id,task_id,assistant_message_id,skill_id,candidate_id,source_memory_ids_json,
                               exposed_at,outcome,updated_at
                             ) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?7)
                             ON CONFLICT(task_id,assistant_message_id,skill_id) DO UPDATE SET
                               candidate_id=COALESCE(memory_skill_effectiveness.candidate_id,excluded.candidate_id),
                               source_memory_ids_json=CASE
                                 WHEN memory_skill_effectiveness.source_memory_ids_json='[]' THEN excluded.source_memory_ids_json
                                 ELSE memory_skill_effectiveness.source_memory_ids_json
                               END,
                               updated_at=GREATEST(memory_skill_effectiveness.updated_at, excluded.updated_at)",
                            params![
                                exp.id,
                                tid,
                                amid,
                                exp.skill_id,
                                exp.candidate_id,
                                exp.source_memory_ids_json,
                                at
                            ],
                        )?;
                    }
                    changes = tx.execute(
                        "UPDATE memory_skill_effectiveness SET
                           invoked_at=COALESCE(invoked_at,?1),
                           invocation_kind=COALESCE(invocation_kind,?2),
                           tool_call_id=COALESCE(tool_call_id,?3),
                           updated_at=?1
                         WHERE task_id=?4 AND assistant_message_id=?5 AND skill_id=?6",
                        params![at, inv_kind, tool_call_id, tid, amid, sid],
                    )?;
                }
                "markTurnOutcome" => {
                    let tid = task_id.as_deref().ok_or("missing task_id")?;
                    let amid = assistant_message_id.as_deref().ok_or("missing assistant_message_id")?;
                    let out_str = outcome.as_deref().ok_or("missing outcome")?;
                    changes = tx.execute(
                        "UPDATE memory_skill_effectiveness SET outcome=?1,outcome_at=?2,updated_at=?2
                         WHERE task_id=?3 AND assistant_message_id=?4 AND outcome='pending'",
                        params![out_str, at, tid, amid],
                    )?;
                }
                "abortPendingForTask" => {
                    let tid = task_id.as_deref().ok_or("missing task_id")?;
                    changes = tx.execute(
                        "UPDATE memory_skill_effectiveness SET outcome='aborted',outcome_at=?1,updated_at=?1
                         WHERE task_id=?2 AND outcome='pending'",
                        params![at, tid],
                    )?;
                }
                "setFeedback" => {
                    let row_id = id.as_deref().ok_or("missing effectiveness id")?;
                    let fb_at = feedback_kind.as_ref().map(|_| at);
                    changes = tx.execute(
                        "UPDATE memory_skill_effectiveness SET feedback_kind=?1,feedback_note=?2,feedback_at=?3,updated_at=?4 WHERE id=?5",
                        params![feedback_kind, feedback_note, fb_at, at, row_id],
                    )?;
                }
                other => return Err(format!("unknown MemorySkillEffectivenessOp action: {other}").into()),
            }
            json!({ "changes": changes })
        }
    };
    tx.commit()?;
    Ok(out)
}

pub(crate) fn relocate_artifacts(tx: &Transaction<'_>, changes: Vec<ArtifactRelocationChange>) -> Result<Value> {
    let mut results = Vec::with_capacity(changes.len());
    for c in changes {
        require_artifact(tx, &c.task_id, &c.id)?;
        tx.execute(
            "UPDATE artifacts
             SET source_type = ?1, entry_file = ?2, root_dir = ?3, storage_path = ?4,
                 version = version + 1, updated_at = ?5
             WHERE id = ?6",
            params![
                c.source_type,
                c.entry_file,
                c.root_dir,
                c.storage_path,
                c.updated_at,
                c.id
            ],
        )?;
        tx.execute(
            "DELETE FROM artifact_file_dependencies WHERE artifact_id = ?1",
            [&c.id],
        )?;
        for dep in &c.dependencies {
            tx.execute(
                "INSERT INTO artifact_file_dependencies (artifact_id, file_path, dependency_kind, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    c.id,
                    dep.file_path,
                    dep.dependency_kind.as_deref().unwrap_or("runtime"),
                    c.updated_at
                ],
            )?;
        }
        let version: i64 = tx.query_row(
            "SELECT version FROM artifacts WHERE id = ?1",
            [&c.id],
            |r| r.get(0),
        )?;
        let revision = bump_artifact_revision_tx(tx, &c.task_id)?;
        results.push(json!({
            "id": c.id,
            "taskId": c.task_id,
            "version": version,
            "revision": revision,
            "updatedAt": c.updated_at,
        }));
    }
    Ok(json!({ "updated": results }))
}
