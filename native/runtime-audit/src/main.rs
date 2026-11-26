mod answer_routing_data;
mod archive_selection;
mod batch1_writes;
mod batch2_writes;
mod batch3_writes;
mod batch4a_writes;
mod batch4b_bot;
mod batch4b_work;
mod batch4b_writes;
mod artifact_cleanup;
mod artifact_content;
mod artifact_snapshots;
mod artifact_write;
mod blueprint_capture;
mod blueprint_instance;
mod blueprint_storage;
mod bot_history_data;
mod branch_title;
mod business_protocol;
mod code_review_data;
mod connector_import;
mod connector_install;
mod connector_market;
mod core_lease;
mod core_supervisor;
mod cron_data;
mod cron_plan;
mod cron_scheduler;
mod cron_write;
mod db_schema;
mod diagnostics;
mod dots_file_revision;
mod dots_file_watch;
mod dots_scheduler;
mod durable;
mod durable_task_projection;
mod durable_workspace_move_data;
mod embedding_index;
mod execution_failures;
mod expert_package;
mod file_backup_list;
mod file_backup_restore;
mod gadget_files;
mod gadget_http_host;
mod gadget_materialize;
mod gadget_source_save;
mod gadget_state;
mod gateway_message_data;
mod gateway_scheduler;
mod history_lane;
mod library_backup;
mod library_delete;
mod library_index;
mod library_metadata;
mod library_note_changes;
mod library_restore;
mod library_text;
mod library_text_save;
mod material_retrieval_data;
mod memory_baselines;
mod memory_capture;
mod memory_lexical;
mod memory_organization_data;
mod memory_record_write;
mod memory_records_data;
mod memory_turn_data;
mod notification_data;
mod pi_host_supervisor;
mod plugin_catalog;
mod plugin_config;
mod project_delete;
mod project_event_data;
mod project_library_promotion;
mod project_memory_forget;
mod project_memory_write;
mod project_metadata;
mod project_pins_data;
mod project_posts_data;
mod project_write;
mod remote_control;
mod remote_image;
mod request_control;
mod scoped_notes;
mod semantic;
mod semantic_inference;
mod semantic_model;
mod snapshots;
mod soul_profile_data;
mod sqlite_rows;
mod subagent_settings_data;
mod task_board;
mod task_context_usage;
mod task_expert_binding;
mod task_list;
mod task_metadata;
mod task_records;
mod task_trash;
mod task_trash_restore;
mod usage;
mod usage_history;
mod usage_live;
mod usage_skills;
mod work_graph_data;
mod work_graph_integrity;
mod work_host_lease;
mod work_queue_data;
mod work_scheduler;
mod workbench_data;
mod workbench_write;
mod workspace_binding_data;
mod workspace_data;
mod workspace_delete;
mod workspace_labels;
mod workspace_move;
mod workspace_persistence;
mod workspace_preview;
mod workspace_scan;
mod workspace_shared_data;
mod write_gate;

use rusqlite::{Connection, OpenFlags, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    error::Error,
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

// ECMAScript whitespace, including BOM and excluding the Unicode NEL.
fn javascript_whitespace(ch: char) -> bool {
    matches!(ch,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
        '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ScopeParam {
    Text(String),
    Integer(i64),
}

#[derive(Deserialize)]
struct SqlScope {
    sql: String,
    args: Vec<ScopeParam>,
}

impl SqlScope {
    fn parameters(self) -> impl Iterator<Item = SqlValue> {
        self.args.into_iter().map(|value| match value {
            ScopeParam::Text(text) => SqlValue::Text(text),
            ScopeParam::Integer(integer) => SqlValue::Integer(integer),
        })
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Request {
    WorkHostLease {
        request: work_host_lease::Request,
    },
    HistoryLaneSupported,
    HistoryRead {
        request_id: String,
        session: String,
        #[serde(flatten)]
        action: durable::Action,
    },
    WorkspaceScanSupported,
    WorkspaceScan {
        query: workspace_scan::Query,
    },
    FileBackupListSupported,
    FileBackupRestoreSupported,
    SubagentSettingsSupported,
    SubagentSettings {
        request: subagent_settings_data::Request,
    },
    RestoreFileBackup {
        request: file_backup_restore::Request,
    },
    MaterialRetrievalSupported,
    MaterialRetrievalData {
        request: material_retrieval_data::Request,
    },
    TaskTrashRestoreSupported,
    RestoreTrashedTask {
        request: task_trash_restore::Restore,
    },
    ReadGatewayMessages {
        query: gateway_message_data::Query,
    },
    GatewayMessageWriteSupported,
    AppendGatewayMessage {
        message: gateway_message_data::Append,
    },
    CodeReviewData {
        query: code_review_data::Query,
    },
    FileBackupList {
        query: file_backup_list::Query,
    },
    DotsFileRevisionSupported,
    DotsFileRevision {
        root: PathBuf,
        file: PathBuf,
    },
    DotsFileWatchSupported,
    StartDotsFileWatch {
        id: String,
        root: PathBuf,
        file: PathBuf,
    },
    StopDotsFileWatch {
        id: String,
    },
    Snapshots {
        task_id: String,
        limit: u32,
    },
    CompactSnapshots {
        limit: u32,
    },
    MutateSnapshot {
        epoch: i64,
        write_id: String,
        mutation: snapshots::Mutation,
    },
    Diagnostics {
        task_id: String,
        limit: Option<u32>,
        offset: u64,
        captured_at: f64,
    },
    TaskList {
        dots_task_id: String,
        include_expert_bindings: bool,
    },
    WorkspaceData {
        query: workspace_data::Query,
    },
    WorkspaceMoveSupported,
    MoveWorkspaceTree {
        movement: workspace_move::Move,
    },
    SidebarArchiveSupported,
    SetSidebarArchive {
        archive: workspace_move::Archive,
    },
    WorkspaceLabelsSupported,
    WriteWorkspaceLabel {
        mutation: workspace_labels::Mutation,
    },
    WorkspacePersistenceSupported,
    WorkspaceDeleteSupported,
    WorkspaceBindingSupported,
    WorkspaceBindingSnapshot {
        id: String,
    },
    WriteWorkspaceBinding {
        mutation: workspace_binding_data::Mutation,
    },
    MemoryTurnData {
        query: memory_turn_data::Query,
        user_id: String,
    },
    MemoryRecordsData {
        query: memory_records_data::Query,
    },
    MemoryRecordWriteSupported,
    WriteMemoryRecord {
        request: memory_record_write::Request,
    },
    ProjectPinsSupported,
    ProjectPins {
        request: project_pins_data::Request,
    },
    ProjectPostsSupported,
    ProjectEventDataSupported,
    ProjectEventData {
        request: project_event_data::Request,
    },
    AnswerRoutingDataSupported,
    AnswerRoutingData {
        request: answer_routing_data::Request,
    },
    ProjectPosts {
        request: project_posts_data::Request,
    },
    WorkQueueSupported,
    ReadBotHistoryPage {
        query: bot_history_data::Query,
    },
    ReadWorkQueue {
        query: work_queue_data::Query,
    },
    MarkWorkCardRead {
        request: work_queue_data::MarkRead,
    },
    DeleteWorkspace {
        mutation: workspace_delete::Mutation,
    },
    WorkspaceSharedData {
        current_space_id: Option<String>,
        task_id: Option<String>,
        include_memories: bool,
    },
    WorkGraphSupported,
    ReadWorkGraph {
        query: work_graph_data::Query,
    },
    WriteWorkGraph {
        mutation: work_graph_data::Mutation,
    },
    WorkGraphIntegritySupported,
    ScanWorkGraphIntegrity,
    WorkGraphRepairSupported,
    ApplyWorkGraphRepair {
        preview: work_graph_integrity::RepairPreview,
    },
    NotificationDataSupported,
    NotificationData {
        query: notification_data::Query,
    },
    WriteNotification {
        mutation: notification_data::Mutation,
    },
    UpsertWorkspace {
        mutation: workspace_persistence::Mutation,
    },
    DurableTaskProjectionSupported,
    DurableTaskOriginsSupported,
    WriteDurableTaskProjection {
        request: durable_task_projection::Request,
    },
    DurableWorkspaceMoveSupported,
    WriteDurableWorkspaceMove {
        request: durable_workspace_move_data::Request,
    },
    TaskExpertBindingSupported,
    ReadTaskExpertBinding {
        task_id: String,
    },
    WriteTaskExpertBinding {
        mutation: task_expert_binding::Mutation,
    },
    SoulProfileSupported,
    SoulProfile {
        request: soul_profile_data::Request,
    },
    MemoryOrganizationProgressSupported,
    MemoryOrganizationLatest,
    WriteMemoryOrganizationProgress {
        progress: memory_organization_data::Progress,
    },
    TaskRecordsSupported,
    UpsertTaskRecord {
        mutation: task_records::Mutation,
    },
    TaskContextUsageSupported,
    WriteTaskContextUsage {
        snapshots: Vec<task_context_usage::Snapshot>,
    },
    ExecutionFailuresSupported,
    ExecutionFailures {
        task_id: String,
    },
    DismissExecutionFailure {
        task_id: String,
        id: String,
        at: i64,
    },
    WriteExecutionFailures {
        request: execution_failures::WriteRequest,
    },
    Batch1Write {
        request: batch1_writes::Request,
    },
    Batch2Write {
        request: batch2_writes::Request,
    },
    Batch3Write {
        request: batch3_writes::Request,
    },
    Batch4aWrite {
        request: batch4a_writes::Request,
    },
    Batch4bWrite {
        request: batch4b_writes::Request,
    },
    BranchTitle {
        source_title: String,
        dots_task_id: String,
    },
    ArchivedTaskCandidates {
        dots_task_id: String,
        task_ids: Vec<String>,
        space_ids: Vec<String>,
    },
    TaskTrashSupported,
    ListTrashedTasks {
        trash_root: PathBuf,
    },
    DueTrashedTasks {
        now: i64,
    },
    AlignTrashRetention {
        retention_ms: i64,
    },
    TaskTrashPurgeSupported,
    PurgeTrashedTask {
        purge: task_trash::Purge,
    },
    GadgetState {
        request: gadget_state::Request,
    },
    TaskBoard {
        query: task_board::Query,
    },
    WriteTaskBoardAction {
        input: task_board::ActionInput,
    },
    AcknowledgeTaskDone {
        task_id: String,
        at: i64,
    },
    SetTaskDueDate {
        task_id: String,
        due_at: Option<i64>,
        next_local_day: Option<i64>,
    },
    EditTaskSidebar {
        task_id: String,
        edit: task_metadata::SidebarEdit,
    },
    ArtifactSnapshots {
        task_ids: Vec<String>,
    },
    WriteArtifact {
        task_id: String,
        operation_id: String,
        mutation: artifact_write::Mutation,
    },
    ManagedArtifactFilesSupported,
    WriteManagedArtifact {
        task_id: String,
        operation_id: String,
        row: artifact_write::ArtifactRow,
        content: artifact_content::Content,
    },
    ReadManagedArtifact {
        root: PathBuf,
        storage_path: String,
        cursor: Option<String>,
        #[serde(default)]
        inline_raster: bool,
    },
    NextManagedArtifact {
        cursor: String,
    },
    CloseManagedArtifact {
        cursor: String,
    },
    WorkspaceFilePreviewSupported,
    WorkspaceFilePreview {
        root: PathBuf,
        relative_path: PathBuf,
        kind: workspace_preview::Kind,
    },
    WorkspaceArtifactStreamSupported,
    OpenWorkspaceArtifact {
        root: PathBuf,
        relative_path: PathBuf,
        cursor: Option<String>,
    },
    ManagedArtifactImageStreamSupported,
    OpenManagedArtifactImage {
        root: PathBuf,
        storage_path: String,
        cursor: Option<String>,
    },
    RemoteArtifactImageSupported,
    OpenRemoteArtifactImage {
        root: PathBuf,
        relative_path: PathBuf,
        managed: bool,
        cursor: Option<String>,
    },
    ArtifactCleanupSupported,
    CleanupArtifactFiles {
        root: PathBuf,
        cleanup: artifact_cleanup::Cleanup,
    },
    LibraryMetadata {
        query: library_metadata::Query,
    },
    WriteLibraryNote {
        change: library_note_changes::Change,
        updated_at: i64,
    },
    SaveLibraryText {
        save: library_text_save::Save,
    },
    DeleteLibrary {
        root: PathBuf,
        target: library_delete::Target,
    },
    DrainLibraryCleanup {
        root: PathBuf,
    },
    ExportLibraryBackup {
        root: PathBuf,
        owner: library_backup::Owner,
        staging: PathBuf,
    },
    PrepareLibraryRestore {
        operation_id: String,
        source: PathBuf,
    },
    RestoreLibraryBackup {
        restore: library_restore::Restore,
    },
    DiscardLibraryRestore {
        operation_id: String,
    },
    RecoverLibraryRestores {
        root: PathBuf,
    },
    ReadScopedNote {
        scope: scoped_notes::Scope,
        id: String,
    },
    SaveScopedNote {
        scope: scoped_notes::Scope,
        id: String,
        save: scoped_notes::Save,
    },
    ProjectMetadata {
        query: project_metadata::Query,
    },
    WriteProject {
        operation_id: String,
        mutation: project_write::Mutation,
    },
    PromoteProjectEventToLibrary {
        promotion: project_library_promotion::Promotion,
    },
    DeleteProject {
        operation_id: String,
        id: String,
        root: PathBuf,
        withdrawal: project_memory_forget::Withdrawal,
    },
    CronData {
        query: cron_data::Query,
    },
    WriteCronRun {
        mutation: cron_write::Mutation,
    },
    WriteCronPlan {
        mutation: cron_plan::Mutation,
    },
    WorkbenchData {
        query: workbench_data::Query,
    },
    ReadGadgetSource {
        root: PathBuf,
        id: String,
        #[serde(default)]
        inspect: bool,
    },
    ReadGadgetManifest {
        root: PathBuf,
        id: String,
    },
    CaptureBlueprintGadget {
        root: PathBuf,
        id: String,
        deny: String,
    },
    CaptureBlueprintWorkspace {
        root: PathBuf,
        paths: Vec<String>,
        deny: String,
    },
    GadgetFileMutationsSupported,
    CreateGadgetFiles {
        create: gadget_materialize::Create,
    },
    ExportGadgetFiles {
        export: gadget_materialize::Export,
    },
    ReconcileGadgetStorage {
        root: PathBuf,
    },
    ManagedStorageSupported,
    RemoveGadgetFiles {
        root: PathBuf,
        id: String,
    },
    ReconcileBlueprintStorage {
        root: PathBuf,
    },
    SaveGadgetSource {
        save: gadget_source_save::Save,
    },
    WriteWorkbench {
        operation_id: String,
        mutation: workbench_write::Mutation,
    },
    InstantiateBlueprint {
        operation_id: String,
        instance: blueprint_instance::Instance,
    },
    PluginCatalog {
        query: plugin_catalog::Query,
    },
    PluginCatalogScanSupported,
    ScanPluginCatalog {
        query: plugin_catalog::Query,
    },
    PluginConfigSupported,
    ReadPluginConfig {
        target: plugin_config::Target,
    },
    ReplacePluginConfig {
        target: plugin_config::Target,
        version: String,
        text: String,
    },
    ConnectorInstallationSupported,
    InstallConnector {
        install: connector_install::Install,
    },
    RecoverConnectorInstalls {
        root: PathBuf,
    },
    ConnectorMaintenanceSupported,
    MaintainConnectorStorage {
        task: connector_install::Maintenance,
    },
    ConnectorMarketImportSupported,
    ImportConnectorMarket {
        request: connector_import::Import,
    },
    ConnectorMarketMutationSupported,
    MutateConnectorMarket {
        action: connector_market::Action,
    },
    WriteDiagnostics {
        epoch: i64,
        sequence: i64,
        writes: Vec<diagnostics::Write>,
    },
    Durable {
        session: String,
        #[serde(flatten)]
        action: durable::Action,
    },
    Semantic {
        #[serde(flatten)]
        request: semantic::Search,
    },
    MemoryLexical {
        #[serde(flatten)]
        request: memory_lexical::Search,
    },
    MemoryLexicalScores {
        #[serde(flatten)]
        request: memory_lexical::Scoring,
    },
    MemoryBaselines {
        queries: Vec<memory_baselines::Query>,
    },
    LibraryText {
        #[serde(flatten)]
        request: library_text::Request,
    },
    PublishLibraryIndex {
        publication: library_index::Publication,
    },
    PublishLibraryDocument {
        publication: library_index::DocumentPublication,
    },
    UsageReport {
        coverage: bool,
        report: usage::Report,
    },
    UsageCsv {
        since: i64,
        coverage: bool,
    },
    UsageHistory {
        job: usage_history::Job,
    },
    CaptureMemory {
        capture: memory_capture::Capture,
    },
    NativeInferenceSupported,
    NativeEmbeddingIndexSupported,
    NativeEmbeddingPlannerSupported,
    NativeModelProbeSupported,
    SemanticModelProbe {
        probe: semantic_model::Probe,
    },
    EmbeddingIndex {
        query: embedding_index::IndexQuery,
    },
    SemanticInference {
        request: semantic_inference::Request,
    },
    StageEmbedding {
        request: embedding_index::StageRequest,
    },
    PublishEmbeddings {
        tokens: Vec<String>,
        at: i64,
    },
    DiscardEmbeddings {
        tokens: Vec<String>,
    },
    CoreCommand {
        #[serde(flatten)]
        command: business_protocol::CommandInput,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    CoreExecution {
        #[serde(flatten)]
        action: business_protocol::ExecutionRequest,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    CoreWorkScheduler {
        #[serde(flatten)]
        command: work_scheduler::Command,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    CoreCronScheduler {
        #[serde(flatten)]
        command: cron_scheduler::Command,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    CoreDotsScheduler {
        #[serde(flatten)]
        command: dots_scheduler::Command,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    CoreGatewayScheduler {
        #[serde(flatten)]
        command: gateway_scheduler::Command,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    CoreRemoteControl {
        #[serde(flatten)]
        command: remote_control::Command,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    CoreGadgetHost {
        #[serde(flatten)]
        command: gadget_http_host::Command,
    },
    CorePiHost {
        #[serde(flatten)]
        command: pi_host_supervisor::Command,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    CoreEventsSnapshot {
        domain: Option<String>,
    },
    CoreEventsReplay {
        after_seq: i64,
        core_generation: String,
        limit: Option<usize>,
    },
    CoreEventsRetention {
        limit: i64,
    },
    AssistantLifecycle {
        action: String,
        resident_enabled: Option<bool>,
        autostart_enabled: Option<bool>,
        reason: Option<String>,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    CoreExecutorPresence {
        online: bool,
        epoch: u64,
        client_id: String,
        generation: String,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
enum Data {
    Json(Value),
    PluginConfig(plugin_config::Reply),
    ConnectorInstall(connector_install::Reply),
    ConnectorImport(connector_import::Reply),
    ConnectorMarket(connector_market::Reply),
    Diagnostics(diagnostics::DiagnosticPage),
    TaskList(Vec<task_list::TaskRow>),
    WorkspaceData(workspace_data::WorkspaceData),
    WorkspaceMove(workspace_move::Reply),
    SidebarArchive(workspace_move::ArchiveReply),
    WorkspaceLabel(workspace_labels::Reply),
    WorkspacePersistence(workspace_persistence::Reply),
    WorkspaceDelete(workspace_delete::Reply),
    WorkspaceBindingSnapshot(Option<workspace_binding_data::Snapshot>),
    WorkspaceBindingWrite(workspace_binding_data::Reply),
    ProjectPosts(project_posts_data::Reply),
    ProjectEventData(project_event_data::Reply),
    AnswerRoutingData(answer_routing_data::Reply),
    ProjectPins(project_pins_data::Reply),
    WorkCardRead(work_queue_data::Reply),
    BotHistoryPage(bot_history_data::Page),
    WorkspaceSharedData(workspace_shared_data::WorkspaceSharedData),
    WorkGraph(Vec<work_graph_data::Edge>),
    WorkGraphWrite(work_graph_data::Reply),
    WorkGraphIntegrity(work_graph_integrity::Report),
    FileBackupList(Option<Vec<file_backup_list::Backup>>),
    FileBackupRestore(file_backup_restore::Reply),
    MaterialRetrievalData(material_retrieval_data::Reply),
    TaskTrashRestore(task_trash_restore::Reply),
    GatewayMessages(Option<Vec<gateway_message_data::Message>>),
    GatewayMessageWrite(gateway_message_data::WriteReply),
    WorkGraphRepair(work_graph_integrity::RepairReply),
    DurableTaskProjection(durable_task_projection::Reply),
    DurableWorkspaceMove(durable_workspace_move_data::Reply),
    TaskExpertBinding(Option<task_expert_binding::State>),
    TaskExpertBindingWrite(task_expert_binding::WriteReply),
    SoulProfile(soul_profile_data::Reply),
    MemoryRecordWrite(memory_record_write::Reply),
    NotificationWrite(notification_data::Reply),
    TaskRecord(task_records::Reply),
    TaskContextUsage(task_context_usage::Reply),
    ExecutionFailures(Vec<execution_failures::ExecutionFailureRow>),
    DismissExecutionFailure(execution_failures::DismissReply),
    ArchivedTaskCandidates(Vec<archive_selection::ArchiveTaskCandidate>),
    TrashedTasks(Vec<task_trash::TrashedTask>),
    DueTrashedTasks(Vec<task_trash::DueTask>),
    TrashRetention(task_trash::RetentionReply),
    TrashPurge(task_trash::PurgeReply),
    GadgetState(gadget_state::Reply),
    GadgetSource(gadget_files::SourceReply),
    BlueprintCapture(blueprint_capture::Reply),
    GadgetSourceSaved(gadget_source_save::Reply),
    GadgetFiles(gadget_materialize::Reply),
    TaskBoard(task_board::Page),
    ArtifactSnapshots(Vec<artifact_snapshots::Snapshot>),
    ManagedArtifactWrite(artifact_write::ManagedWrite),
    ManagedArtifactContent(artifact_content::Read),
    WorkspaceFilePreview(workspace_preview::Preview),
    WorkspaceScan(workspace_scan::Scan),
    DotsFileRevision(dots_file_revision::Revision),
    ArtifactCleanup(artifact_cleanup::Report),
    Semantic(Vec<semantic::Hit>),
    MemoryLexical(memory_lexical::Candidates),
    MemoryLexicalScores(Vec<memory_lexical::TextScore>),
    MemoryBaselines(Vec<Vec<memory_baselines::Candidate>>),
    LibraryText(library_text::Stage),
    LibraryIndex(library_index::Status),
    Embedding(semantic_inference::Embedding),
    StagedEmbedding(embedding_index::StageStatus),
    EmbeddingCounts(embedding_index::Counts),
    EmbeddingIndex(embedding_index::QueryResult),
    ModelInstallation(semantic_model::Installation),
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Reply {
    Ok { data: Data },
    Error,
}

/// The id a request was dispatched with. Absent when the caller sent none; such a
/// request is still served, and its reply simply carries no `replyId`.
type RequestId = Option<String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireReply<'a> {
    /// Every reply advertises the multiplexed history lane (origin's handshake).
    #[serde(rename = "historyLane")]
    history_lane: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_id: Option<&'a str>,
    inference: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    scan: Option<bool>,
    /// Set only by the maintenance thread, so an id-less reply still names its lane.
    #[serde(skip_serializing_if = "Option::is_none")]
    maintenance: Option<bool>,
    #[serde(flatten)]
    reply: Reply,
}

fn write_reply(id: &RequestId, result: Result<Data>, inference: bool) -> Result<()> {
    if let (Some(control), Some(id)) = (request_control::shared(), id) {
        control.finish(
            id,
            result.is_ok(),
            result
                .as_ref()
                .ok()
                .and_then(|data| serde_json::to_value(data).ok()),
            result.as_ref().err().map(ToString::to_string),
        );
        if let Some(frame) = control.terminal_override(id) {
            request_control::emit(&frame)?;
            return Ok(());
        }
    }
    let reply = match result {
        Ok(data) => Reply::Ok { data },
        Err(error) => {
            eprintln!("Runtime audit request failed: {error}");
            Reply::Error
        }
    };
    let mut output = BufWriter::new(io::stdout().lock());
    serde_json::to_writer(
        &mut output,
        &WireReply {
            history_lane: true,
            reply_id: id.as_deref(),
            inference,
            scan: None,
            maintenance: None,
            reply,
        },
    )?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

const MAX_REPLY_BYTES: usize = 32 * 1024 * 1024;

fn write_workspace_reply(id: &RequestId, data: Data) -> Result<()> {
    if let (Some(control), Some(id)) = (request_control::shared(), id) {
        control.finish(id, true, serde_json::to_value(&data).ok(), None);
    }
    let encode = |data| {
        serde_json::to_vec(&WireReply {
            history_lane: true,
            reply_id: id.as_deref(),
            inference: false,
            scan: Some(true),
            maintenance: None,
            reply: Reply::Ok { data },
        })
    };
    let oversized = match &data {
        Data::WorkspaceScan(_) => Data::WorkspaceScan(workspace_scan::Scan::NeedsHost),
        _ => Data::Json(Value::Null),
    };
    let mut line = encode(data)?;
    if line.len() >= MAX_REPLY_BYTES {
        line = encode(oversized)?;
    }
    let mut output = io::stdout().lock();
    output.write_all(&line)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn write_maintenance_reply(id: &RequestId, result: Result<Data>) -> Result<()> {
    if let (Some(control), Some(id)) = (request_control::shared(), id) {
        control.finish(
            id,
            result.is_ok(),
            result
                .as_ref()
                .ok()
                .and_then(|data| serde_json::to_value(data).ok()),
            result.as_ref().err().map(ToString::to_string),
        );
        if let Some(frame) = control.terminal_override(id) {
            request_control::emit(&frame)?;
            return Ok(());
        }
    }
    let reply = match result {
        Ok(data) => Reply::Ok { data },
        Err(error) => {
            eprintln!("Runtime audit maintenance failed: {error}");
            Reply::Error
        }
    };
    let mut output = BufWriter::new(io::stdout().lock());
    serde_json::to_writer(
        &mut output,
        &WireReply {
            history_lane: true,
            reply_id: id.as_deref(),
            inference: false,
            scan: None,
            maintenance: Some(true),
            reply,
        },
    )?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

enum WorkspaceJob {
    Scan(workspace_scan::Query),
    FileBackupList(file_backup_list::Query),
    RestoreFileBackup(file_backup_restore::Request),
    SubagentSettings(subagent_settings_data::Request),
    WorkGraphIntegrity(PathBuf),
    FileRevision {
        root: PathBuf,
        file: PathBuf,
    },
    PluginCatalog(plugin_catalog::Query),
    ReadPluginConfig(plugin_config::Target),
    ReplacePluginConfig {
        target: plugin_config::Target,
        version: String,
        text: String,
    },
    InstallConnector(connector_install::Install),
    RecoverConnectorInstalls(PathBuf),
    MaintainConnectorStorage(connector_install::Maintenance),
    ImportConnectorMarket(connector_import::Import),
    MutateConnectorMarket(connector_market::Action),
    CheckTrashedDirectories {
        root: PathBuf,
        rows: Vec<task_trash::TrashedTask>,
    },
}

type WorkspaceWorker = (
    mpsc::SyncSender<(RequestId, WorkspaceJob)>,
    thread::JoinHandle<()>,
);

fn start_workspace_scans() -> io::Result<WorkspaceWorker> {
    let (send, jobs) = mpsc::sync_channel::<(RequestId, WorkspaceJob)>(16);
    let worker = thread::Builder::new()
        .name("workspace-scan".into())
        .spawn(move || {
            for (id, job) in jobs {
                if !request_control::begin(&id) {
                    continue;
                }
                let result = match job {
                    WorkspaceJob::Scan(query) => Data::WorkspaceScan(workspace_scan::scan(query)),
                    WorkspaceJob::FileBackupList(query) => {
                        Data::FileBackupList(file_backup_list::list(query))
                    }
                    WorkspaceJob::RestoreFileBackup(request) => {
                        Data::FileBackupRestore(file_backup_restore::restore(request))
                    }
                    WorkspaceJob::SubagentSettings(request) => {
                        Data::PluginConfig(subagent_settings_data::run(request))
                    }
                    WorkspaceJob::WorkGraphIntegrity(path) => work_graph_integrity::scan(&path)
                        .map(Data::WorkGraphIntegrity)
                        .unwrap_or(Data::Json(Value::Null)),
                    WorkspaceJob::FileRevision { root, file } => {
                        Data::DotsFileRevision(dots_file_revision::read(&root, &file))
                    }
                    WorkspaceJob::PluginCatalog(query) => {
                        Data::Json(plugin_catalog::read(query).unwrap_or(Value::Null))
                    }
                    WorkspaceJob::ReadPluginConfig(target) => {
                        Data::PluginConfig(plugin_config::read(target))
                    }
                    WorkspaceJob::ReplacePluginConfig {
                        target,
                        version,
                        text,
                    } => Data::PluginConfig(plugin_config::replace(target, &version, &text)),
                    WorkspaceJob::InstallConnector(install) => {
                        Data::ConnectorInstall(connector_install::install_reply(install))
                    }
                    WorkspaceJob::RecoverConnectorInstalls(root) => {
                        Data::ConnectorInstall(connector_install::recover(&root))
                    }
                    WorkspaceJob::MaintainConnectorStorage(task) => {
                        Data::ConnectorInstall(connector_install::maintain_reply(task))
                    }
                    WorkspaceJob::ImportConnectorMarket(request) => {
                        Data::ConnectorImport(connector_import::import(request))
                    }
                    WorkspaceJob::MutateConnectorMarket(action) => {
                        Data::ConnectorMarket(connector_market::update(action))
                    }
                    WorkspaceJob::CheckTrashedDirectories { root, rows } => {
                        Data::TrashedTasks(task_trash::check_directories(&root, rows))
                    }
                };
                if write_workspace_reply(&id, result).is_err() {
                    break;
                }
            }
        })?;
    Ok((send, worker))
}

fn dispatch_workspace(
    worker: &mut Option<WorkspaceWorker>,
    id: RequestId,
    job: WorkspaceJob,
    _fallback: Data,
) -> Result<()> {
    if worker.is_none() {
        *worker = start_workspace_scans().ok();
    }
    match worker {
        Some((sender, _)) => match sender.try_send((id, job)) {
            Ok(()) => Ok(()),
            // The rejected job hands its id back, so even the fallback is correlated.
            Err(mpsc::TrySendError::Full((id, _))) => {
                request_control::overload(&id, "OVERLOADED").map_err(Into::into)
            }
            Err(mpsc::TrySendError::Disconnected((id, _))) => {
                request_control::overload(&id, "UNAVAILABLE").map_err(Into::into)
            }
        },
        None => request_control::overload(&id, "UNAVAILABLE").map_err(Into::into),
    }
}

enum InferenceJob {
    Embed(semantic_inference::Request),
    Stage(embedding_index::StageRequest),
    Probe(semantic_model::Probe),
}

fn start_inference(
    db_path: PathBuf,
    staged: Arc<embedding_index::StagedVectors>,
) -> Result<(
    mpsc::SyncSender<(RequestId, InferenceJob)>,
    thread::JoinHandle<()>,
)> {
    let (send, jobs) = mpsc::sync_channel::<(RequestId, InferenceJob)>(4);
    let worker = thread::Builder::new()
        .name("semantic-inference".into())
        .spawn(move || {
            let mut model = semantic_inference::Inference::default();
            let mut verifier = semantic_model::Verifier::default();
            let mut reader = None;
            for (id, request) in jobs {
                if !request_control::begin(&id) {
                    continue;
                }
                let result = match request {
                    InferenceJob::Embed(request) => model.run(request).map(Data::Embedding),
                    InferenceJob::Probe(probe) => {
                        Ok(Data::ModelInstallation(verifier.probe(probe)))
                    }
                    InferenceJob::Stage(request) => (|| {
                        if reader.is_none() {
                            reader = Some(read_connection(&db_path)?);
                        }
                        embedding_index::stage(
                            reader.as_ref().unwrap(),
                            &mut model,
                            &staged,
                            request,
                        )
                        .map(Data::StagedEmbedding)
                    })(),
                };
                if result.is_err() {
                    model = semantic_inference::Inference::default();
                }
                if write_reply(&id, result, true).is_err() {
                    break;
                }
            }
        })?;
    Ok((send, worker))
}

/// Long database/file work. It owns its own writer so a multi-second job never
/// waits behind, or blocks, the lane the light queries use.
enum MaintenanceJob {
    CleanupArtifactFiles {
        root: PathBuf,
        cleanup: artifact_cleanup::Cleanup,
    },
    DeleteLibrary {
        root: PathBuf,
        target: library_delete::Target,
    },
    DrainLibraryCleanup {
        root: PathBuf,
    },
    ExportLibraryBackup {
        root: PathBuf,
        owner: library_backup::Owner,
        staging: PathBuf,
    },
    PrepareLibraryRestore {
        operation_id: String,
        source: PathBuf,
    },
    DiscardLibraryRestore {
        operation_id: String,
    },
    RestoreLibraryBackup {
        restore: library_restore::Restore,
    },
    RecoverLibraryRestores {
        root: PathBuf,
    },
    DeleteProject {
        operation_id: String,
        id: String,
        root: PathBuf,
        withdrawal: project_memory_forget::Withdrawal,
    },
    PromoteProjectEventToLibrary {
        promotion: project_library_promotion::Promotion,
    },
}

type MaintenanceWorker = (
    mpsc::SyncSender<(RequestId, MaintenanceJob)>,
    thread::JoinHandle<()>,
);

fn start_maintenance(db_path: PathBuf) -> io::Result<MaintenanceWorker> {
    let (send, jobs) = mpsc::sync_channel::<(RequestId, MaintenanceJob)>(8);
    let worker = thread::Builder::new()
        .name("maintenance".into())
        .spawn(move || {
            let mut writer = None;
            let mut prepared_restore = None;
            for (id, job) in jobs {
                if !request_control::begin(&id) {
                    continue;
                }
                // A panicking job replies with an error and leaves the thread serving:
                // it must never take the shared process (or a later job) with it.
                let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_maintenance(&db_path, &mut writer, &mut prepared_restore, job)
                })) {
                    Ok(result) => result,
                    Err(_) => Err("maintenance job panicked".into()),
                };
                if result.is_err() {
                    // A half-open transaction must not outlive its job.
                    writer = None;
                    prepared_restore = None;
                }
                if write_maintenance_reply(&id, result).is_err() {
                    break;
                }
            }
        })?;
    Ok((send, worker))
}

fn dispatch_maintenance(
    worker: &mut Option<MaintenanceWorker>,
    db_path: &Path,
    id: RequestId,
    job: MaintenanceJob,
) -> Result<()> {
    if worker.is_none() {
        *worker = start_maintenance(db_path.to_path_buf()).ok();
    }
    match worker {
        Some((sender, _)) => match sender.try_send((id, job)) {
            Ok(()) => Ok(()),
            // The rejected job hands its id back, so even this reply is correlated.
            Err(mpsc::TrySendError::Full((id, _))) => {
                request_control::overload(&id, "OVERLOADED").map_err(Into::into)
            }
            Err(mpsc::TrySendError::Disconnected((id, _))) => {
                request_control::overload(&id, "UNAVAILABLE").map_err(Into::into)
            }
        },
        None => request_control::overload(&id, "UNAVAILABLE").map_err(Into::into),
    }
}

fn run_maintenance(
    db_path: &Path,
    writer: &mut Option<Connection>,
    prepared_restore: &mut Option<(String, library_restore::Backup)>,
    job: MaintenanceJob,
) -> Result<Data> {
    match job {
        MaintenanceJob::CleanupArtifactFiles { root, cleanup } => {
            artifact_cleanup::clean(write_connection(writer, db_path)?, &root, cleanup)
                .map(Data::ArtifactCleanup)
        }
        MaintenanceJob::DeleteLibrary { root, target } => {
            library_delete::delete(write_connection(writer, db_path)?, &root, target)
                .map(Data::Json)
        }
        MaintenanceJob::DrainLibraryCleanup { root } => {
            library_delete::drain(write_connection(writer, db_path)?, &root)
                .map(|completed| Data::Json(completed.into()))
        }
        MaintenanceJob::ExportLibraryBackup {
            root,
            owner,
            staging,
        } => {
            let status =
                library_backup::export(write_connection(writer, db_path)?, &root, owner, &staging)?;
            Ok(Data::Json(serde_json::to_value(status)?))
        }
        // Preparing and discarding only touch files and this thread's own state.
        MaintenanceJob::PrepareLibraryRestore {
            operation_id,
            source,
        } => Ok(Data::Json(match library_restore::prepare(&source) {
            Ok(backup) => {
                *prepared_restore = Some((operation_id, backup));
                serde_json::json!({ "status": "prepared" })
            }
            Err(error) => serde_json::json!({ "status": "rejected", "message": error.to_string() }),
        })),
        MaintenanceJob::DiscardLibraryRestore { operation_id } => {
            if prepared_restore
                .as_ref()
                .is_some_and(|(id, _)| id == &operation_id)
            {
                prepared_restore.take();
            }
            Ok(Data::Json(true.into()))
        }
        MaintenanceJob::RestoreLibraryBackup { restore } => {
            if prepared_restore
                .as_ref()
                .is_none_or(|(id, _)| id != &restore.operation_id)
            {
                return Ok(Data::Json(
                    serde_json::json!({ "status": "rejected", "message": "备份恢复已中断，请重试" }),
                ));
            }
            let (_, backup) = prepared_restore
                .take()
                .ok_or("missing prepared library backup")?;
            Ok(Data::Json(
                match library_restore::restore(write_connection(writer, db_path)?, backup, restore)
                {
                    Ok(Some(receipt)) => {
                        serde_json::json!({ "status": "restored", "receipt": receipt })
                    }
                    Ok(None) => serde_json::json!({ "status": "needsHost" }),
                    Err(error) => {
                        serde_json::json!({ "status": "rejected", "message": error.to_string() })
                    }
                },
            ))
        }
        MaintenanceJob::RecoverLibraryRestores { root } => {
            library_restore::recover(write_connection(writer, db_path)?, &root, None)
                .map(|count| Data::Json(count.into()))
        }
        MaintenanceJob::DeleteProject {
            operation_id,
            id,
            root,
            withdrawal,
        } => project_delete::delete(
            write_connection(writer, db_path)?,
            &operation_id,
            &id,
            &root,
            withdrawal,
        )
        .map(Data::Json),
        MaintenanceJob::PromoteProjectEventToLibrary { promotion } => {
            let result =
                project_library_promotion::promote(write_connection(writer, db_path)?, promotion)
                    .unwrap_or_else(|error| project_library_promotion::Reply::Rejected {
                        message: error.to_string(),
                    });
            Ok(Data::Json(serde_json::to_value(result)?))
        }
    }
}

fn read(
    db: &mut Connection,
    db_path: &Path,
    durable_sessions: &mut HashMap<String, Connection>,
    writer: &mut Option<Connection>,
    staged: &embedding_index::StagedVectors,
    executor_tracker: &business_protocol::ExecutorTracker,
    side_effects: &mut Option<business_protocol::WriteSideEffects>,
    request: Request,
) -> Result<Data> {
    if let Request::CoreCommand { command, client } = request {
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = business_protocol::execute_command(
            write_connection(writer, db_path)?,
            executor_tracker,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreExecution { action, client } = request {
        if let business_protocol::ExecutionRequest::Status { execution_id } = action {
            return business_protocol::execute_execution_read(db, &execution_id).map(Data::Json);
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = business_protocol::execute_execution(
            write_connection(writer, db_path)?,
            executor_tracker,
            &ctx,
            action,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreWorkScheduler { command, client } = request {
        if command.is_read_only() {
            return work_scheduler::execute_read(db, command).map(Data::Json);
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = work_scheduler::execute_write(
            write_connection(writer, db_path)?,
            executor_tracker,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreCronScheduler { command, client } = request {
        if command.is_read_only() {
            return cron_scheduler::execute_read(db, command).map(Data::Json);
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = cron_scheduler::execute_write(
            write_connection(writer, db_path)?,
            executor_tracker,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreDotsScheduler { command, client } = request {
        if command.is_read_only() {
            return dots_scheduler::execute_read(db, command).map(Data::Json);
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = dots_scheduler::execute_write(
            write_connection(writer, db_path)?,
            executor_tracker,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreGatewayScheduler { command, client } = request {
        if command.is_read_only() {
            return gateway_scheduler::execute_read(db, command).map(Data::Json);
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = gateway_scheduler::execute_write(
            write_connection(writer, db_path)?,
            executor_tracker,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreRemoteControl { command, client } = request {
        if command.is_read_only() {
            return remote_control::execute_read(db, command).map(Data::Json);
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = remote_control::execute_write(
            write_connection(writer, db_path)?,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CorePiHost { command, client } = request {
        if command.is_read_only() {
            return pi_host_supervisor::execute_read(db, command).map(Data::Json);
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = pi_host_supervisor::execute_write(
            write_connection(writer, db_path)?,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreEventsSnapshot { domain } = request {
        return business_protocol::events_snapshot(db, domain.as_deref()).map(Data::Json);
    }
    if let Request::CoreEventsReplay {
        after_seq,
        core_generation,
        limit,
    } = request
    {
        return business_protocol::events_replay(db, after_seq, &core_generation, limit)
            .map(Data::Json);
    }
    if let Request::CoreEventsRetention { limit } = request {
        let fx = business_protocol::execute_command(
            write_connection(writer, db_path)?,
            executor_tracker,
            &business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation()),
            business_protocol::CommandInput::SetEventRetention { limit },
        )?;
        return Ok(Data::Json(fx.data));
    }
    if let Request::AssistantLifecycle {
        action,
        resident_enabled,
        autostart_enabled,
        reason,
        client,
    } = request
    {
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = business_protocol::handle_lifecycle(
            write_connection(writer, db_path)?,
            &ctx,
            &action,
            resident_enabled,
            autostart_enabled,
            reason,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreExecutorPresence {
        online,
        epoch,
        client_id,
        generation,
    } = request
    {
        let fx = business_protocol::handle_executor_presence(
            write_connection(writer, db_path)?,
            executor_tracker,
            online,
            epoch,
            client_id,
            generation,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::WorkHostLease { request } = request {
        return Ok(Data::Json(serde_json::to_value(work_host_lease::run(
            write_connection(writer, db_path)?,
            request,
        )?)?));
    }
    if matches!(
        request,
        Request::NativeInferenceSupported
            | Request::NativeEmbeddingIndexSupported
            | Request::NativeEmbeddingPlannerSupported
            | Request::NativeModelProbeSupported
    ) {
        return Ok(Data::Json(true.into()));
    }
    if let Request::PublishEmbeddings { tokens, at } = request {
        return staged
            .publish(write_connection(writer, db_path)?, &tokens, at)
            .map(Data::EmbeddingCounts);
    }
    if let Request::DiscardEmbeddings { tokens } = request {
        staged.discard(&tokens)?;
        return Ok(Data::Json(true.into()));
    }
    if let Request::Durable { session, action } = request {
        return durable::read(durable_sessions, session, action).map(Data::Json);
    }
    if let Request::LibraryText { request } = request {
        return library_text::stage(request).map(Data::LibraryText);
    }
    if let Request::ReadGadgetSource { root, id, inspect } = request {
        return Ok(read_recovered_gadget_source(
            writer,
            db_path,
            &root,
            &id,
            || gadget_files::read_source(&root, &id, inspect),
        ));
    }
    if let Request::ReadGadgetManifest { root, id } = request {
        return Ok(read_recovered_gadget_source(
            writer,
            db_path,
            &root,
            &id,
            || gadget_files::read_manifest(&root, &id),
        ));
    }
    if let Request::CaptureBlueprintGadget { root, id, deny } = request {
        let deny = blueprint_capture::deny_pattern(&deny)?;
        return Ok(read_recovered_gadget_source(
            writer,
            db_path,
            &root,
            &id,
            || gadget_files::capture_blueprint(&root, &id, &deny),
        ));
    }
    if let Request::CaptureBlueprintWorkspace { root, paths, deny } = request {
        return Ok(Data::BlueprintCapture(blueprint_capture::workspace(
            &root, paths, &deny,
        )));
    }
    if let Request::GadgetFileMutationsSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::ManagedStorageSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::RemoveGadgetFiles { root, id } = request {
        let removed =
            gadget_files::remove_unregistered(write_connection(writer, db_path)?, &root, &id)?;
        return Ok(Data::Json(removed.into()));
    }
    if let Request::ReconcileBlueprintStorage { root } = request {
        let failures = blueprint_storage::reconcile(write_connection(writer, db_path)?, &root)?;
        return Ok(Data::Json(serde_json::to_value(failures)?));
    }
    if let Request::CreateGadgetFiles { create } = request {
        return Ok(Data::GadgetFiles(gadget_materialize::create(
            write_connection(writer, db_path)?,
            create,
        )));
    }
    if let Request::ExportGadgetFiles { export } = request {
        return Ok(Data::GadgetFiles(gadget_materialize::export(export)));
    }
    if let Request::SaveGadgetSource { save } = request {
        return Ok(Data::GadgetSourceSaved(gadget_source_save::save(
            write_connection(writer, db_path)?,
            save,
        )));
    }
    if let Request::ReconcileGadgetStorage { root } = request {
        let failed = gadget_files::reconcile(write_connection(writer, db_path)?, &root)?;
        return Ok(Data::Json(serde_json::to_value(failed)?));
    }
    if let Request::PluginCatalog { query } = request {
        return plugin_catalog::read(query).map(Data::Json);
    }
    if let Request::WorkspaceMoveSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::MoveWorkspaceTree { movement } = request {
        return Ok(Data::WorkspaceMove(workspace_move::write(
            write_connection(writer, db_path)?,
            movement,
        )));
    }
    if let Request::SidebarArchiveSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::SetSidebarArchive { archive } = request {
        return Ok(Data::SidebarArchive(workspace_move::archive(
            write_connection(writer, db_path)?,
            archive,
        )));
    }
    if let Request::WorkspaceLabelsSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if matches!(
        request,
        Request::WorkspacePersistenceSupported
            | Request::WorkspaceDeleteSupported
            | Request::WorkspaceBindingSupported
            | Request::ProjectPinsSupported
            | Request::ProjectPostsSupported
            | Request::ProjectEventDataSupported
            | Request::AnswerRoutingDataSupported
            | Request::WorkQueueSupported
            | Request::WorkGraphSupported
            | Request::WorkGraphIntegritySupported
            | Request::WorkGraphRepairSupported
            | Request::NotificationDataSupported
            | Request::DurableTaskProjectionSupported
            | Request::DurableTaskOriginsSupported
            | Request::GatewayMessageWriteSupported
            | Request::MemoryRecordWriteSupported
            | Request::FileBackupListSupported
            | Request::FileBackupRestoreSupported
            | Request::SubagentSettingsSupported
            | Request::MaterialRetrievalSupported
            | Request::TaskTrashRestoreSupported
            | Request::DurableWorkspaceMoveSupported
            | Request::TaskExpertBindingSupported
            | Request::SoulProfileSupported
            | Request::MemoryOrganizationProgressSupported
            | Request::TaskRecordsSupported
            | Request::TaskContextUsageSupported
            | Request::ExecutionFailuresSupported
    ) {
        return Ok(Data::Json(true.into()));
    }
    if let Request::UpsertWorkspace { mutation } = request {
        return Ok(Data::WorkspacePersistence(workspace_persistence::write(
            write_connection(writer, db_path)?,
            mutation,
        )));
    }
    if let Request::DeleteWorkspace { mutation } = request {
        return Ok(Data::WorkspaceDelete(workspace_delete::write(
            write_connection(writer, db_path)?,
            mutation,
        )));
    }
    if let Request::WorkspaceBindingSnapshot { id } = request {
        return workspace_binding_data::read(db, &id).map(Data::WorkspaceBindingSnapshot);
    }
    if let Request::WriteWorkspaceBinding { mutation } = request {
        return Ok(Data::WorkspaceBindingWrite(workspace_binding_data::write(
            write_connection(writer, db_path)?,
            mutation,
        )));
    }
    if let Request::MemoryTurnData { query, user_id } = request {
        return memory_turn_data::read(db, query, &user_id).map(Data::Json);
    }
    if let Request::MemoryRecordsData { query } = request {
        return memory_records_data::read(db, query).map(Data::Json);
    }
    if let Request::WriteMemoryRecord { request } = request {
        return Ok(Data::MemoryRecordWrite(memory_record_write::write(
            write_connection(writer, db_path)?,
            request,
        )));
    }
    if let Request::ProjectPins { request } = request {
        let conn = if request.is_read() {
            db
        } else {
            write_connection(writer, db_path)?
        };
        return Ok(Data::ProjectPins(project_pins_data::run(conn, request)));
    }
    if let Request::ProjectPosts { request } = request {
        let conn = if request.is_read() {
            db
        } else {
            write_connection(writer, db_path)?
        };
        return Ok(Data::ProjectPosts(project_posts_data::run(conn, request)));
    }
    if let Request::ProjectEventData { request } = request {
        let conn = if request.is_read() {
            db
        } else {
            write_connection(writer, db_path)?
        };
        return Ok(Data::ProjectEventData(project_event_data::run(
            conn, request,
        )));
    }
    if let Request::AnswerRoutingData { request } = request {
        let conn = if request.is_read() {
            db
        } else {
            write_connection(writer, db_path)?
        };
        return Ok(Data::AnswerRoutingData(answer_routing_data::run(
            conn, request,
        )));
    }
    if let Request::ReadWorkQueue { query } = request {
        return work_queue_data::read(db, query).map(Data::Json);
    }
    if let Request::ReadGatewayMessages { query } = request {
        return gateway_message_data::read(db, query).map(Data::GatewayMessages);
    }
    if let Request::AppendGatewayMessage { message } = request {
        return gateway_message_data::append(write_connection(writer, db_path)?, &message)
            .map(Data::GatewayMessageWrite);
    }
    if let Request::CodeReviewData { query } = request {
        return code_review_data::read(db, query).map(Data::Json);
    }
    if let Request::MaterialRetrievalData { request } = request {
        let conn = if request.is_read() {
            db
        } else {
            write_connection(writer, db_path)?
        };
        return Ok(Data::MaterialRetrievalData(material_retrieval_data::run(
            conn, request,
        )));
    }
    if let Request::RestoreTrashedTask { request } = request {
        return Ok(Data::TaskTrashRestore(task_trash_restore::restore(
            write_connection(writer, db_path)?,
            request,
        )));
    }
    if let Request::ReadBotHistoryPage { query } = request {
        return bot_history_data::read(db, query).map(Data::BotHistoryPage);
    }
    if let Request::MarkWorkCardRead { request } = request {
        return Ok(Data::WorkCardRead(work_queue_data::mark_read(
            write_connection(writer, db_path)?,
            request,
        )));
    }
    if let Request::WorkspaceSharedData {
        current_space_id,
        task_id,
        include_memories,
    } = request
    {
        return workspace_shared_data::read(
            db,
            current_space_id.as_deref(),
            task_id.as_deref(),
            include_memories,
        )
        .map(Data::WorkspaceSharedData);
    }
    if let Request::ReadWorkGraph { query } = request {
        return work_graph_data::read(db, query).map(Data::WorkGraph);
    }
    if let Request::WriteWorkGraph { mutation } = request {
        return Ok(Data::WorkGraphWrite(work_graph_data::write(
            write_connection(writer, db_path)?,
            mutation,
        )));
    }
    if let Request::WriteDurableTaskProjection { request } = request {
        return Ok(Data::DurableTaskProjection(durable_task_projection::write(
            write_connection(writer, db_path)?,
            &request,
        )));
    }
    if let Request::WriteDurableWorkspaceMove { request } = request {
        return Ok(Data::DurableWorkspaceMove(
            durable_workspace_move_data::write(write_connection(writer, db_path)?, &request),
        ));
    }
    if let Request::ReadTaskExpertBinding { task_id } = request {
        return task_expert_binding::read(db, &task_id).map(Data::TaskExpertBinding);
    }
    if let Request::WriteTaskExpertBinding { mutation } = request {
        return Ok(Data::TaskExpertBindingWrite(task_expert_binding::write(
            write_connection(writer, db_path)?,
            mutation,
        )));
    }
    if let Request::SoulProfile { request } = request {
        let conn = if request.is_read() {
            db
        } else {
            write_connection(writer, db_path)?
        };
        return Ok(Data::SoulProfile(soul_profile_data::run(conn, request)));
    }
    if let Request::MemoryOrganizationLatest = request {
        return memory_organization_data::latest(db).map(|run| Data::Json(run.into()));
    }
    if let Request::WriteMemoryOrganizationProgress { progress } = request {
        return memory_organization_data::write_progress(
            write_connection(writer, db_path)?,
            progress,
        )
        .map(|written| Data::Json(written.into()));
    }
    if let Request::ApplyWorkGraphRepair { preview } = request {
        return Ok(Data::WorkGraphRepair(work_graph_integrity::repair(
            write_connection(writer, db_path)?,
            &preview,
        )));
    }
    if let Request::NotificationData { query } = request {
        return notification_data::read(db, query).map(Data::Json);
    }
    if let Request::WriteNotification { mutation } = request {
        return Ok(Data::NotificationWrite(notification_data::write(
            write_connection(writer, db_path)?,
            mutation,
        )));
    }
    if let Request::UpsertTaskRecord { mutation } = request {
        return Ok(Data::TaskRecord(task_records::write(
            write_connection(writer, db_path)?,
            mutation,
        )));
    }
    if let Request::WriteTaskContextUsage { snapshots } = request {
        return Ok(Data::TaskContextUsage(task_context_usage::write(
            write_connection(writer, db_path)?,
            &snapshots,
        )));
    }
    if let Request::ExecutionFailures { task_id } = request {
        return execution_failures::list(db, &task_id).map(Data::ExecutionFailures);
    }
    if let Request::DismissExecutionFailure { task_id, id, at } = request {
        return Ok(Data::DismissExecutionFailure(execution_failures::dismiss(
            write_connection(writer, db_path)?,
            &task_id,
            &id,
            at,
        )));
    }
    if let Request::WriteExecutionFailures { request } = request {
        return execution_failures::write(write_connection(writer, db_path)?, request)
            .map(Data::Json);
    }
    if let Request::Batch1Write { request } = request {
        return batch1_writes::run(write_connection(writer, db_path)?, request).map(Data::Json);
    }
    if let Request::Batch2Write { request } = request {
        return batch2_writes::run(write_connection(writer, db_path)?, request).map(Data::Json);
    }
    if let Request::Batch3Write { request } = request {
        return batch3_writes::run(write_connection(writer, db_path)?, request).map(Data::Json);
    }
    if let Request::Batch4aWrite { request } = request {
        return batch4a_writes::run(write_connection(writer, db_path)?, request).map(Data::Json);
    }
    if let Request::Batch4bWrite { request } = request {
        return batch4b_writes::run(write_connection(writer, db_path)?, request).map(Data::Json);
    }
    if let Request::WriteWorkspaceLabel { mutation } = request {
        return Ok(Data::WorkspaceLabel(workspace_labels::write(
            write_connection(writer, db_path)?,
            mutation,
        )));
    }
    if let Request::BranchTitle {
        source_title,
        dots_task_id,
    } = request
    {
        return branch_title::next(db, &source_title, &dots_task_id)
            .map(|title| Data::Json(title.into()));
    }
    if let Request::ArchivedTaskCandidates {
        dots_task_id,
        task_ids,
        space_ids,
    } = request
    {
        return archive_selection::read(db, &dots_task_id, &task_ids, &space_ids)
            .map(Data::ArchivedTaskCandidates);
    }
    if let Request::TaskTrashSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::DueTrashedTasks { now } = request {
        return task_trash::due(db, now).map(Data::DueTrashedTasks);
    }
    if let Request::AlignTrashRetention { retention_ms } = request {
        return Ok(Data::TrashRetention(task_trash::align_retention(
            write_connection(writer, db_path)?,
            retention_ms,
        )));
    }
    if let Request::TaskTrashPurgeSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::PurgeTrashedTask { purge } = request {
        return Ok(Data::TrashPurge(task_trash::purge(
            write_connection(writer, db_path)?,
            purge,
        )));
    }
    if let Request::WorkspaceData { query } = request {
        return workspace_data::read(db, query).map(Data::WorkspaceData);
    }
    if let Request::WriteArtifact {
        task_id,
        operation_id,
        mutation,
    } = request
    {
        return artifact_write::write(
            write_connection(writer, db_path)?,
            &task_id,
            &operation_id,
            mutation,
        )
        .map(Data::Json);
    }
    if let Request::ManagedArtifactFilesSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::WriteManagedArtifact {
        task_id,
        operation_id,
        row,
        content,
    } = request
    {
        return artifact_write::write_managed(
            write_connection(writer, db_path)?,
            &task_id,
            &operation_id,
            row,
            content,
        )
        .map(Data::ManagedArtifactWrite);
    }
    if let Request::ArtifactCleanupSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::WriteCronRun { mutation } = request {
        return cron_write::write(write_connection(writer, db_path)?, mutation)
            .map(|saved| Data::Json(saved.into()));
    }
    if let Request::WriteCronPlan { mutation } = request {
        return cron_plan::write(write_connection(writer, db_path)?, mutation)
            .map(|saved| Data::Json(saved.into()));
    }
    if let Request::SaveScopedNote { scope, id, save } = request {
        return scoped_notes::save(write_connection(writer, db_path)?, scope, &id, save)
            .map(Data::Json);
    }
    if let Request::WriteLibraryNote { change, updated_at } = request {
        return library_note_changes::write(write_connection(writer, db_path)?, change, updated_at)
            .map(Data::Json);
    }
    if let Request::SaveLibraryText { save } = request {
        return library_text_save::write(write_connection(writer, db_path)?, save).map(Data::Json);
    }
    if let Request::WriteTaskBoardAction { input } = request {
        return task_board::write_action(write_connection(writer, db_path)?, input)
            .map(|()| Data::Json(true.into()));
    }
    if let Request::AcknowledgeTaskDone { task_id, at } = request {
        return task_metadata::acknowledge(write_connection(writer, db_path)?, &task_id, at)
            .map(|saved| Data::Json(saved.into()));
    }
    if let Request::SetTaskDueDate {
        task_id,
        due_at,
        next_local_day,
    } = request
    {
        let result = task_metadata::set_due_date(
            write_connection(writer, db_path)?,
            &task_id,
            due_at,
            next_local_day,
        )?;
        return Ok(Data::Json(serde_json::to_value(result)?));
    }
    if let Request::EditTaskSidebar { task_id, edit } = request {
        let result =
            task_metadata::edit_sidebar(write_connection(writer, db_path)?, &task_id, edit)?;
        return Ok(Data::Json(serde_json::to_value(result)?));
    }
    if let Request::WriteWorkbench {
        operation_id,
        mutation,
    } = request
    {
        return workbench_write::write(write_connection(writer, db_path)?, &operation_id, mutation)
            .and_then(|status| Ok(Data::Json(serde_json::to_value(status)?)));
    }
    if let Request::WriteProject {
        operation_id,
        mutation,
    } = request
    {
        return project_write::write(write_connection(writer, db_path)?, &operation_id, mutation)
            .and_then(|status| Ok(Data::Json(serde_json::to_value(status)?)));
    }
    if let Request::InstantiateBlueprint {
        operation_id,
        instance,
    } = request
    {
        return blueprint_instance::write(
            write_connection(writer, db_path)?,
            &operation_id,
            instance,
        )
        .and_then(|status| Ok(Data::Json(serde_json::to_value(status)?)));
    }
    if let Request::PublishLibraryIndex { publication } = request {
        return library_index::publish(write_connection(writer, db_path)?, publication)
            .map(Data::LibraryIndex);
    }
    if let Request::PublishLibraryDocument { publication } = request {
        return library_index::publish_document(write_connection(writer, db_path)?, publication)
            .map(Data::LibraryIndex);
    }
    if let Request::UsageReport { coverage, report } = request {
        return usage::read(db, coverage, report).map(Data::Json);
    }
    if let Request::UsageHistory { job } = request {
        return usage_history::run(writer, db_path, job).map(Data::Json);
    }
    if let Request::CaptureMemory { capture } = request {
        return memory_capture::run(write_connection(writer, db_path)?, capture)
            .map(|saved| Data::Json(saved.into()));
    }
    if let Request::CompactSnapshots { limit } = request {
        return snapshots::compact(db_path, limit).map(|migrated| Data::Json(migrated.into()));
    }
    if let Request::MutateSnapshot {
        epoch,
        write_id,
        mutation,
    } = request
    {
        return snapshots::mutate(db_path, epoch, &write_id, mutation)
            .map(|updated| Data::Json(updated.into()));
    }
    if let Request::WriteDiagnostics {
        epoch,
        sequence,
        writes,
    } = request
    {
        return diagnostics::write_batch(db_path, epoch, sequence, writes)
            .map(|()| Data::Json(true.into()));
    }
    let snapshot = db.transaction()?;
    let response = match request {
        Request::WorkHostLease { .. } => unreachable!(),
        Request::Snapshots { task_id, limit } => {
            Data::Json(snapshots::read(&snapshot, &task_id, limit)?)
        }
        Request::Diagnostics {
            task_id,
            limit,
            offset,
            captured_at,
        } => Data::Diagnostics(diagnostics::read(
            &snapshot,
            &task_id,
            limit,
            offset,
            captured_at,
        )?),
        Request::TaskList {
            dots_task_id,
            include_expert_bindings,
        } => Data::TaskList(task_list::read(
            &snapshot,
            &dots_task_id,
            include_expert_bindings,
        )?),
        Request::ArtifactSnapshots { task_ids } => {
            Data::ArtifactSnapshots(artifact_snapshots::read(&snapshot, &task_ids)?)
        }
        Request::LibraryMetadata { query } => Data::Json(library_metadata::read(&snapshot, query)?),
        Request::ExportLibraryBackup { .. } => unreachable!(),
        Request::ReadScopedNote { scope, id } => {
            Data::Json(scoped_notes::read(&snapshot, scope, &id)?)
        }
        Request::ProjectMetadata { query } => Data::Json(project_metadata::read(&snapshot, query)?),
        Request::CronData { query } => Data::Json(cron_data::read(&snapshot, query)?),
        Request::WorkbenchData { query } => Data::Json(workbench_data::read(&snapshot, query)?),
        Request::TaskBoard { query } => Data::TaskBoard(task_board::read(&snapshot, query)?),
        Request::WriteTaskBoardAction { .. } => unreachable!(),
        Request::AcknowledgeTaskDone { .. }
        | Request::SetTaskDueDate { .. }
        | Request::EditTaskSidebar { .. } => unreachable!(),
        Request::Durable { .. } | Request::HistoryRead { .. } | Request::HistoryLaneSupported => {
            unreachable!()
        }
        Request::LibraryText { .. } => unreachable!(),
        Request::ReadGadgetSource { .. }
        | Request::ReadGadgetManifest { .. }
        | Request::CaptureBlueprintGadget { .. }
        | Request::CaptureBlueprintWorkspace { .. }
        | Request::GadgetFileMutationsSupported
        | Request::CreateGadgetFiles { .. }
        | Request::ExportGadgetFiles { .. }
        | Request::ManagedStorageSupported
        | Request::RemoveGadgetFiles { .. }
        | Request::ReconcileBlueprintStorage { .. }
        | Request::ReconcileGadgetStorage { .. }
        | Request::SaveGadgetSource { .. } => unreachable!(),
        Request::PluginCatalog { .. }
        | Request::PluginCatalogScanSupported
        | Request::ScanPluginCatalog { .. }
        | Request::PluginConfigSupported
        | Request::ReadPluginConfig { .. }
        | Request::ReplacePluginConfig { .. } => unreachable!(),
        Request::ConnectorInstallationSupported
        | Request::InstallConnector { .. }
        | Request::RecoverConnectorInstalls { .. }
        | Request::ConnectorMaintenanceSupported
        | Request::MaintainConnectorStorage { .. } => unreachable!(),
        Request::ConnectorMarketImportSupported | Request::ImportConnectorMarket { .. } => {
            unreachable!()
        }
        Request::ConnectorMarketMutationSupported | Request::MutateConnectorMarket { .. } => {
            unreachable!()
        }
        Request::WorkspaceData { .. }
        | Request::WorkspaceMoveSupported
        | Request::MoveWorkspaceTree { .. }
        | Request::SidebarArchiveSupported
        | Request::SetSidebarArchive { .. }
        | Request::WorkspaceLabelsSupported
        | Request::WriteWorkspaceLabel { .. }
        | Request::WorkspacePersistenceSupported
        | Request::WorkspaceDeleteSupported
        | Request::WorkspaceBindingSupported
        | Request::WorkspaceBindingSnapshot { .. }
        | Request::WriteWorkspaceBinding { .. }
        | Request::MemoryTurnData { .. }
        | Request::MemoryRecordsData { .. }
        | Request::MemoryRecordWriteSupported
        | Request::WriteMemoryRecord { .. }
        | Request::ProjectPinsSupported
        | Request::ProjectPins { .. }
        | Request::ProjectPostsSupported
        | Request::ProjectEventDataSupported
        | Request::ProjectEventData { .. }
        | Request::AnswerRoutingDataSupported
        | Request::AnswerRoutingData { .. }
        | Request::ProjectPosts { .. }
        | Request::WorkQueueSupported
        | Request::ReadWorkQueue { .. }
        | Request::ReadGatewayMessages { .. }
        | Request::GatewayMessageWriteSupported
        | Request::AppendGatewayMessage { .. }
        | Request::CodeReviewData { .. }
        | Request::MaterialRetrievalSupported
        | Request::MaterialRetrievalData { .. }
        | Request::TaskTrashRestoreSupported
        | Request::RestoreTrashedTask { .. }
        | Request::ReadBotHistoryPage { .. }
        | Request::MarkWorkCardRead { .. }
        | Request::DeleteWorkspace { .. }
        | Request::WorkspaceSharedData { .. }
        | Request::WorkGraphSupported
        | Request::ReadWorkGraph { .. }
        | Request::WriteWorkGraph { .. }
        | Request::WorkGraphIntegritySupported
        | Request::ScanWorkGraphIntegrity
        | Request::WorkGraphRepairSupported
        | Request::ApplyWorkGraphRepair { .. }
        | Request::NotificationDataSupported
        | Request::NotificationData { .. }
        | Request::WriteNotification { .. }
        | Request::UpsertWorkspace { .. }
        | Request::DurableTaskProjectionSupported
        | Request::DurableTaskOriginsSupported
        | Request::WriteDurableTaskProjection { .. }
        | Request::DurableWorkspaceMoveSupported
        | Request::WriteDurableWorkspaceMove { .. }
        | Request::TaskExpertBindingSupported
        | Request::ReadTaskExpertBinding { .. }
        | Request::WriteTaskExpertBinding { .. }
        | Request::SoulProfileSupported
        | Request::SoulProfile { .. }
        | Request::MemoryOrganizationProgressSupported
        | Request::MemoryOrganizationLatest
        | Request::WriteMemoryOrganizationProgress { .. }
        | Request::TaskRecordsSupported
        | Request::UpsertTaskRecord { .. }
        | Request::TaskContextUsageSupported
        | Request::WriteTaskContextUsage { .. }
        | Request::ExecutionFailuresSupported
        | Request::ExecutionFailures { .. }
        | Request::DismissExecutionFailure { .. }
        | Request::WriteExecutionFailures { .. }
        | Request::Batch1Write { .. }
        | Request::Batch2Write { .. }
        | Request::Batch3Write { .. }
        | Request::Batch4aWrite { .. }
        | Request::Batch4bWrite { .. }
        | Request::BranchTitle { .. }
        | Request::ArchivedTaskCandidates { .. }
        | Request::TaskTrashSupported
        | Request::ListTrashedTasks { .. }
        | Request::DueTrashedTasks { .. }
        | Request::AlignTrashRetention { .. }
        | Request::TaskTrashPurgeSupported
        | Request::PurgeTrashedTask { .. } => unreachable!(),
        Request::GadgetState { .. }
        | Request::CoreGadgetHost { .. }
        | Request::CorePiHost { .. } => unreachable!(),
        Request::WriteArtifact { .. }
        | Request::ManagedArtifactFilesSupported
        | Request::WriteManagedArtifact { .. }
        | Request::ReadManagedArtifact { .. }
        | Request::NextManagedArtifact { .. }
        | Request::CloseManagedArtifact { .. }
        | Request::WorkspaceScanSupported
        | Request::WorkspaceScan { .. }
        | Request::FileBackupListSupported
        | Request::FileBackupList { .. }
        | Request::FileBackupRestoreSupported
        | Request::RestoreFileBackup { .. }
        | Request::SubagentSettingsSupported
        | Request::SubagentSettings { .. }
        | Request::DotsFileRevisionSupported
        | Request::DotsFileRevision { .. }
        | Request::DotsFileWatchSupported
        | Request::StartDotsFileWatch { .. }
        | Request::StopDotsFileWatch { .. }
        | Request::WorkspaceFilePreviewSupported
        | Request::WorkspaceFilePreview { .. }
        | Request::WorkspaceArtifactStreamSupported
        | Request::OpenWorkspaceArtifact { .. }
        | Request::ManagedArtifactImageStreamSupported
        | Request::OpenManagedArtifactImage { .. }
        | Request::RemoteArtifactImageSupported
        | Request::OpenRemoteArtifactImage { .. }
        | Request::ArtifactCleanupSupported
        | Request::CleanupArtifactFiles { .. } => unreachable!(),
        Request::SaveScopedNote { .. } => unreachable!(),
        Request::WriteLibraryNote { .. } => unreachable!(),
        Request::SaveLibraryText { .. } => unreachable!(),
        Request::DeleteLibrary { .. } => unreachable!(),
        Request::DrainLibraryCleanup { .. } => unreachable!(),
        Request::WriteWorkbench { .. } => unreachable!(),
        Request::WriteProject { .. } => unreachable!(),
        Request::PromoteProjectEventToLibrary { .. } => unreachable!(),
        Request::DeleteProject { .. } => unreachable!(),
        Request::InstantiateBlueprint { .. } => unreachable!(),
        Request::PrepareLibraryRestore { .. } => unreachable!(),
        Request::RestoreLibraryBackup { .. } => unreachable!(),
        Request::DiscardLibraryRestore { .. } => unreachable!(),
        Request::RecoverLibraryRestores { .. } => unreachable!(),
        Request::WriteCronRun { .. } => unreachable!(),
        Request::WriteCronPlan { .. } => unreachable!(),
        Request::PublishLibraryIndex { .. } => unreachable!(),
        Request::PublishLibraryDocument { .. } => unreachable!(),
        Request::UsageReport { .. } => unreachable!(),
        Request::UsageHistory { .. } => unreachable!(),
        Request::CaptureMemory { .. } => unreachable!(),
        Request::NativeInferenceSupported
        | Request::NativeEmbeddingIndexSupported
        | Request::NativeEmbeddingPlannerSupported
        | Request::NativeModelProbeSupported
        | Request::SemanticModelProbe { .. }
        | Request::EmbeddingIndex { .. }
        | Request::SemanticInference { .. }
        | Request::StageEmbedding { .. }
        | Request::PublishEmbeddings { .. }
        | Request::DiscardEmbeddings { .. } => unreachable!(),
        Request::UsageCsv { since, coverage } => {
            Data::Json(usage::export_csv(&snapshot, since, coverage)?.into())
        }
        Request::CompactSnapshots { .. } => unreachable!(),
        Request::MutateSnapshot { .. } => unreachable!(),
        Request::WriteDiagnostics { .. } => unreachable!(),
        Request::Semantic { request } => Data::Semantic(semantic::search(&snapshot, request)?),
        Request::MemoryLexical { request } => {
            Data::MemoryLexical(memory_lexical::search(&snapshot, request)?)
        }
        Request::MemoryLexicalScores { request } => {
            Data::MemoryLexicalScores(memory_lexical::score(&snapshot, request)?)
        }
        Request::MemoryBaselines { queries } => {
            Data::MemoryBaselines(memory_baselines::read(&snapshot, queries)?)
        }
        Request::CoreCommand { .. }
        | Request::CoreExecution { .. }
        | Request::CoreEventsSnapshot { .. }
        | Request::CoreEventsReplay { .. }
        | Request::CoreEventsRetention { .. }
        | Request::AssistantLifecycle { .. }
        | Request::CoreExecutorPresence { .. }
        | Request::CoreWorkScheduler { .. }
        | Request::CoreCronScheduler { .. }
        | Request::CoreDotsScheduler { .. }
        | Request::CoreGatewayScheduler { .. }
        | Request::CoreRemoteControl { .. } => unreachable!(),
    };
    snapshot.commit()?;
    Ok(response)
}

fn read_recovered_gadget_source(
    writer: &mut Option<Connection>,
    db_path: &Path,
    root: &Path,
    id: &str,
    read: impl FnOnce() -> gadget_files::SourceReply,
) -> Data {
    let mut recover = || -> Result<()> {
        if gadget_source_save::has_pending(root, id)? {
            let db = write_connection(writer, db_path)?;
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            gadget_source_save::recover_if_pending(&tx, root, id)?;
            tx.commit()?;
        }
        Ok(())
    };
    Data::GadgetSource(match recover() {
        Ok(()) => read(),
        Err(error) => gadget_files::SourceReply::Rejected {
            message: format!("Gadget 源码恢复失败：{error}"),
        },
    })
}

/// The one place a writer connection is configured. Both the main loop and the
/// maintenance thread open their own connection through it, so busy_timeout and
/// pragmas cannot drift between them.
fn open_write_connection(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
    )?;
    db.busy_timeout(Duration::from_millis(100))?;
    db.pragma_update(None, "foreign_keys", true)?;
    task_board::install_functions(&db)?;
    Ok(db)
}

fn write_connection<'a>(
    connection: &'a mut Option<Connection>,
    path: &Path,
) -> Result<&'a mut Connection> {
    if connection.is_none() {
        *connection = Some(open_write_connection(path)?);
    }
    connection
        .as_mut()
        .ok_or_else(|| "write connection unavailable".into())
}

fn read_connection(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_millis(500))?;
    db.pragma_update(None, "query_only", true)?;
    task_board::install_functions(&db)?;
    Ok(db)
}

fn database_write(request: &Request) -> bool {
    match request {
        Request::CoreExecution { action, .. } => !business_protocol::execution_is_read_only(action),
        Request::CoreWorkScheduler { command, .. } => !command.is_read_only(),
        Request::CoreCronScheduler { command, .. } => !command.is_read_only(),
        Request::CoreDotsScheduler { command, .. } => !command.is_read_only(),
        Request::CoreGatewayScheduler { command, .. } => !command.is_read_only(),
        Request::CoreRemoteControl { command, .. } => !command.is_read_only(),
        Request::ProjectPins { request } => !request.is_read(),
        Request::ProjectPosts { request } => !request.is_read(),
        Request::ProjectEventData { request } => !request.is_read(),
        Request::AnswerRoutingData { request } => !request.is_read(),
        Request::MaterialRetrievalData { request } => !request.is_read(),
        Request::SoulProfile { request } => !request.is_read(),
        Request::WorkHostLease { .. }
        | Request::PublishEmbeddings { .. }
        | Request::CoreCommand { .. }
        | Request::CoreEventsRetention { .. }
        | Request::AssistantLifecycle { .. }
        | Request::CoreExecutorPresence { .. }
        | Request::ReadGadgetSource { .. }
        | Request::ReadGadgetManifest { .. }
        | Request::CaptureBlueprintGadget { .. }
        | Request::RemoveGadgetFiles { .. }
        | Request::ReconcileBlueprintStorage { .. }
        | Request::CreateGadgetFiles { .. }
        | Request::SaveGadgetSource { .. }
        | Request::ReconcileGadgetStorage { .. }
        | Request::MoveWorkspaceTree { .. }
        | Request::SetSidebarArchive { .. }
        | Request::UpsertWorkspace { .. }
        | Request::DeleteWorkspace { .. }
        | Request::WriteWorkspaceBinding { .. }
        | Request::WriteMemoryRecord { .. }
        | Request::AppendGatewayMessage { .. }
        | Request::RestoreTrashedTask { .. }
        | Request::MarkWorkCardRead { .. }
        | Request::WriteWorkGraph { .. }
        | Request::WriteDurableTaskProjection { .. }
        | Request::WriteDurableWorkspaceMove { .. }
        | Request::WriteTaskExpertBinding { .. }
        | Request::WriteMemoryOrganizationProgress { .. }
        | Request::ApplyWorkGraphRepair { .. }
        | Request::WriteNotification { .. }
        | Request::UpsertTaskRecord { .. }
        | Request::WriteTaskContextUsage { .. }
        | Request::DismissExecutionFailure { .. }
        | Request::WriteExecutionFailures { .. }
        | Request::Batch1Write { .. }
        | Request::Batch2Write { .. }
        | Request::Batch3Write { .. }
        | Request::Batch4aWrite { .. }
        | Request::Batch4bWrite { .. }
        | Request::WriteWorkspaceLabel { .. }
        | Request::AlignTrashRetention { .. }
        | Request::PurgeTrashedTask { .. }
        | Request::WriteArtifact { .. }
        | Request::WriteManagedArtifact { .. }
        | Request::WriteCronRun { .. }
        | Request::WriteCronPlan { .. }
        | Request::SaveScopedNote { .. }
        | Request::WriteLibraryNote { .. }
        | Request::SaveLibraryText { .. }
        | Request::WriteTaskBoardAction { .. }
        | Request::AcknowledgeTaskDone { .. }
        | Request::SetTaskDueDate { .. }
        | Request::EditTaskSidebar { .. }
        | Request::WriteWorkbench { .. }
        | Request::WriteProject { .. }
        | Request::InstantiateBlueprint { .. }
        | Request::PublishLibraryIndex { .. }
        | Request::PublishLibraryDocument { .. }
        | Request::UsageHistory { .. }
        | Request::CaptureMemory { .. }
        | Request::CompactSnapshots { .. }
        | Request::MutateSnapshot { .. }
        | Request::WriteDiagnostics { .. } => true,
        _ => false,
    }
}
fn deferred(request: &Request) -> bool {
    database_write(request)
        || matches!(
            request,
            Request::ScanPluginCatalog { .. }
                | Request::ReadPluginConfig { .. }
                | Request::ReplacePluginConfig { .. }
                | Request::InstallConnector { .. }
                | Request::RecoverConnectorInstalls { .. }
                | Request::MaintainConnectorStorage { .. }
                | Request::ImportConnectorMarket { .. }
                | Request::MutateConnectorMarket { .. }
                | Request::WorkspaceScan { .. }
                | Request::FileBackupList { .. }
                | Request::RestoreFileBackup { .. }
                | Request::SubagentSettings { .. }
                | Request::ScanWorkGraphIntegrity
                | Request::ListTrashedTasks { .. }
                | Request::DotsFileRevision { .. }
                | Request::SemanticInference { .. }
                | Request::StageEmbedding { .. }
                | Request::SemanticModelProbe { .. }
                | Request::CleanupArtifactFiles { .. }
                | Request::DeleteLibrary { .. }
                | Request::DrainLibraryCleanup { .. }
                | Request::ExportLibraryBackup { .. }
                | Request::PrepareLibraryRestore { .. }
                | Request::DiscardLibraryRestore { .. }
                | Request::RestoreLibraryBackup { .. }
                | Request::RecoverLibraryRestores { .. }
                | Request::DeleteProject { .. }
                | Request::PromoteProjectEventToLibrary { .. }
        )
}
fn request_may_mutate(request: &Request) -> bool {
    database_write(request)
        || matches!(
            request,
            Request::GadgetState {
                request: gadget_state::Request::Access {
                    action: gadget_state::Action::Set { .. } | gadget_state::Action::Delete { .. },
                    ..
                }
            } | Request::ReplacePluginConfig { .. }
                | Request::InstallConnector { .. }
                | Request::RecoverConnectorInstalls { .. }
                | Request::MaintainConnectorStorage { .. }
                | Request::ImportConnectorMarket { .. }
                | Request::MutateConnectorMarket { .. }
                | Request::RestoreFileBackup { .. }
                | Request::SubagentSettings { .. }
                | Request::LibraryText { .. }
                | Request::ExportGadgetFiles { .. }
                | Request::CleanupArtifactFiles { .. }
                | Request::DeleteLibrary { .. }
                | Request::DrainLibraryCleanup { .. }
                | Request::ExportLibraryBackup { .. }
                | Request::PrepareLibraryRestore { .. }
                | Request::DiscardLibraryRestore { .. }
                | Request::RestoreLibraryBackup { .. }
                | Request::RecoverLibraryRestores { .. }
                | Request::DeleteProject { .. }
                | Request::PromoteProjectEventToLibrary { .. }
        )
}

fn emit_side_effects(effects: Option<business_protocol::WriteSideEffects>) {
    let Some(fx) = effects else {
        return;
    };
    for event in fx.events {
        let _ = request_control::emit(&serde_json::json!({ "coreEvent": event }));
    }
    for dispatch in fx.dispatches {
        let _ = request_control::emit(&dispatch);
    }
    if fx.shutdown_after_reply {
        let _ = request_control::emit(&serde_json::json!({ "coreShutdownRequested": true }));
    }
}

type DatabaseWriter = (
    mpsc::SyncSender<(RequestId, Request)>,
    thread::JoinHandle<()>,
);
fn start_database_writer(
    db_path: PathBuf,
    staged: Arc<embedding_index::StagedVectors>,
    executor_tracker: Arc<business_protocol::ExecutorTracker>,
) -> io::Result<DatabaseWriter> {
    let (send, jobs) = mpsc::sync_channel::<(RequestId, Request)>(32);
    let worker = thread::Builder::new()
        .name("database-writer".into())
        .spawn(move || {
            let mut reader = None;
            let mut writer = None;
            let mut sessions = HashMap::new();
            for (id, request) in jobs {
                // Wait outside the reader/input lanes. Admission remains queued until this
                // shared write boundary is available, then the deadline is checked again.
                let gate = match write_gate::enter() {
                    Ok(gate) => gate,
                    Err(error) => {
                        let _ = write_reply(&id, Err(error), false);
                        continue;
                    }
                };
                if !request_control::begin(&id) {
                    continue;
                }
                let mut side_effects = None;
                let result = (|| -> Result<Data> {
                    if reader.is_none() {
                        reader = Some(read_connection(&db_path)?);
                    }
                    read(
                        reader.as_mut().unwrap(),
                        &db_path,
                        &mut sessions,
                        &mut writer,
                        &staged,
                        &executor_tracker,
                        &mut side_effects,
                        request,
                    )
                })();
                drop(gate);
                let ok = result.is_ok();
                if write_reply(&id, result, false).is_err() {
                    break;
                }
                if ok {
                    emit_side_effects(side_effects);
                }
            }
        })?;
    Ok((send, worker))
}

fn run() -> Result<()> {
    let all = std::env::args_os().skip(1).collect::<Vec<_>>();
    // Supervisor mode owns the data directory and keeps the worker alive across clients;
    // the single-argument forms below are untouched.
    if all
        .first()
        .is_some_and(|argument| argument == "--supervise")
    {
        let [_, data_dir, db_path] = all.as_slice() else {
            return Err("expected --supervise <data directory> <database path>".into());
        };
        return core_supervisor::run(Path::new(data_dir), Path::new(db_path));
    }
    if all
        .first()
        .is_some_and(|argument| argument == "--watchdog")
    {
        let recover = all.get(3).is_some_and(|a| a == "--recover");
        if all.len() < 3 || all.len() > 4 || (all.len() == 4 && !recover) {
            return Err("expected --watchdog <data directory> <database path> [--recover]".into());
        }
        return core_supervisor::run_watchdog(Path::new(&all[1]), Path::new(&all[2]), recover);
    }
    if all
        .first()
        .is_some_and(|argument| argument == "--guard-core-database")
    {
        let [_, directory] = all.as_slice() else {
            return Err("expected --guard-core-database <data directory>".into());
        };
        return core_lease::guard_database(Path::new(directory));
    }
    if all
        .first()
        .is_some_and(|argument| argument == "--init-database")
    {
        let [_, data_dir, db_path, version] = all.as_slice() else {
            return Err("expected --init-database <data directory> <database path> <schema version>".into());
        };
        let expected: u32 = version
            .to_string_lossy()
            .parse()
            .map_err(|_| "invalid schema version")?;
        let report =
            db_schema::initialize_database(Path::new(data_dir), Path::new(db_path), expected)?;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
    let mut args = all.into_iter();
    let argument = args.next().ok_or("missing database path")?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    if argument == "--protocol-version" {
        println!("89");
        return Ok(());
    }
    let db_path = PathBuf::from(argument);
    let worker_lease = core_lease::WorkerLease::from_environment(&db_path)?;
    let mut db = read_connection(&db_path)?;
    let control = request_control::Control::open(&db_path)?;
    request_control::install(control.clone());
    let host_control = control.clone();
    let mut database_writer = None;
    let mut durable_sessions = HashMap::new();
    let mut writer = None;
    let mut inference = None;
    let mut maintenance = None;
    let mut workspace_scans = None;
    let mut dots_file_watches = None;
    let staged = Arc::new(embedding_index::StagedVectors::default());
    let executor_tracker = Arc::new(business_protocol::ExecutorTracker::new());
    let mut index_queues = embedding_index::IndexQueues::default();
    let gadget_state = Arc::new(Mutex::new(gadget_state::Store::default()));
    let mut artifact_reads = artifact_content::Reads::default();
    if std::env::var_os("MYBUDDY_HISTORY_HANDSHAKE").is_some() {
        let mut output = io::stdout().lock();
        writeln!(output, "{{\"historyReady\":true}}")?;
        output.flush()?;
    }
    // The input thread owns stdin so history reads cannot queue behind the main loop. It
    // forwards the transport id with each request, which is what lets replies be correlated.
    let (requests, input) = history_lane::route_input(control)?;
    struct SchedulerTickerGuard {
        stop: Arc<std::sync::atomic::AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }
    impl Drop for SchedulerTickerGuard {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Release);
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }
    let _scheduler_ticker = if std::env::var_os("MYBUDDY_CORE_SUPERVISED").is_some()
        && std::env::var("MYBUDDY_WORK_AUTO_TICK_MS").ok().as_deref() != Some("0")
    {
        let interval_ms = std::env::var("MYBUDDY_WORK_AUTO_TICK_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(1_000)
            .clamp(50, 30_000);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_flag = stop.clone();
        let tick_db_path = db_path.clone();
        let tick_tracker = executor_tracker.clone();
        let handle = thread::Builder::new()
            .name("work-scheduler-tick".into())
            .spawn(move || {
                let mut writer_conn: Option<rusqlite::Connection> = None;
                while !stop_flag.load(std::sync::atomic::Ordering::Acquire) {
                    if let Ok(gate) = write_gate::enter() {
                        if let Ok(conn) = write_connection(&mut writer_conn, &tick_db_path) {
                            if work_scheduler::claim_supervised_core_lease(conn).unwrap_or(false) {
                                let core_gen = business_protocol::current_core_generation();
                                let ctx = business_protocol::ClientContext::synthetic(&core_gen);
                                if let Ok(fx) = work_scheduler::execute_write(
                                    conn,
                                    &tick_tracker,
                                    &ctx,
                                    work_scheduler::Command::Tick {
                                        owner_id: Some(format!("core:{core_gen}")),
                                        now_ms: None,
                                        lease_ttl_ms: None,
                                    },
                                ) {
                                    if !fx.events.is_empty() || !fx.dispatches.is_empty() {
                                        emit_side_effects(Some(fx));
                                    }
                                }
                                if let Ok(Some(cron_fx)) = cron_scheduler::run_supervised_tick(conn, &tick_tracker) {
                                    emit_side_effects(Some(cron_fx));
                                }
                                if let Ok(Some(dots_fx)) = dots_scheduler::run_supervised_tick(conn, &tick_tracker) {
                                    emit_side_effects(Some(dots_fx));
                                }
                                if let Ok(Some(gw_fx)) = gateway_scheduler::run_supervised_tick(conn, &tick_tracker) {
                                    emit_side_effects(Some(gw_fx));
                                }
                            }
                        }
                        drop(gate);
                    }
                    let mut slept = 0u64;
                    while slept < interval_ms && !stop_flag.load(std::sync::atomic::Ordering::Acquire) {
                        let step = (interval_ms - slept).min(50);
                        thread::sleep(Duration::from_millis(step));
                        slept += step;
                    }
                }
            })
            .ok();
        Some(SchedulerTickerGuard { stop, handle })
    } else {
        None
    };
    if let Some(lease) = &worker_lease {
        lease.ready()?;
    }
    for (id, request) in requests {
        if request.as_ref().is_ok_and(database_write) {
            if database_writer.is_none() {
                database_writer = Some(start_database_writer(
                    db_path.clone(),
                    staged.clone(),
                    executor_tracker.clone(),
                )?);
            }
            let request = request.expect("validated write request");
            match database_writer.as_ref().unwrap().0.try_send((id, request)) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full((id, _))) => {
                    request_control::overload(&id, "OVERLOADED")?
                }
                Err(mpsc::TrySendError::Disconnected((id, _))) => {
                    request_control::overload(&id, "UNAVAILABLE")?
                }
            }
            continue;
        }
        if request.as_ref().is_ok_and(|request| !deferred(request)) && !request_control::begin(&id)
        {
            continue;
        }
        let job = match request {
            Ok(Request::HistoryLaneSupported) => {
                write_reply(&id, Ok(Data::Json(true.into())), false)?;
                continue;
            }
            Ok(
                Request::PluginCatalogScanSupported
                | Request::PluginConfigSupported
                | Request::ConnectorInstallationSupported
                | Request::ConnectorMaintenanceSupported
                | Request::ConnectorMarketImportSupported
                | Request::ConnectorMarketMutationSupported,
            ) => {
                write_reply(&id, Ok(Data::Json(true.into())), false)?;
                continue;
            }
            Ok(Request::ScanPluginCatalog { query }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::PluginCatalog(query),
                    Data::Json(Value::Null),
                )?;
                continue;
            }
            Ok(Request::ReadPluginConfig { target }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::ReadPluginConfig(target),
                    Data::PluginConfig(plugin_config::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::ReplacePluginConfig {
                target,
                version,
                text,
            }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::ReplacePluginConfig {
                        target,
                        version,
                        text,
                    },
                    Data::PluginConfig(plugin_config::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::InstallConnector { install }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::InstallConnector(install),
                    Data::ConnectorInstall(connector_install::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::RecoverConnectorInstalls { root }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::RecoverConnectorInstalls(root),
                    Data::ConnectorInstall(connector_install::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::MaintainConnectorStorage { task }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::MaintainConnectorStorage(task),
                    Data::ConnectorInstall(connector_install::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::ImportConnectorMarket { request }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::ImportConnectorMarket(request),
                    Data::ConnectorImport(connector_import::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::MutateConnectorMarket { action }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::MutateConnectorMarket(action),
                    Data::ConnectorMarket(connector_market::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(
                Request::WorkspaceScanSupported
                | Request::DotsFileRevisionSupported
                | Request::DotsFileWatchSupported,
            ) => {
                write_reply(&id, Ok(Data::Json(true.into())), false)?;
                continue;
            }
            Ok(Request::StartDotsFileWatch {
                id: watch,
                root,
                file,
            }) => {
                if dots_file_watches.is_none() {
                    dots_file_watches = dots_file_watch::FileWatches::new().ok();
                }
                let started = dots_file_watches
                    .as_mut()
                    .is_some_and(|watches| watches.start(watch, &root, &file));
                write_reply(&id, Ok(Data::Json(started.into())), false)?;
                continue;
            }
            Ok(Request::StopDotsFileWatch { id: watch }) => {
                if let Some(watches) = dots_file_watches.as_mut() {
                    watches.stop(&watch);
                }
                write_reply(&id, Ok(Data::Json(true.into())), false)?;
                continue;
            }
            Ok(Request::WorkspaceScan { query }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::Scan(query),
                    Data::WorkspaceScan(workspace_scan::Scan::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::FileBackupList { query }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::FileBackupList(query),
                    Data::FileBackupList(None),
                )?;
                continue;
            }
            Ok(Request::RestoreFileBackup { request }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::RestoreFileBackup(request),
                    Data::FileBackupRestore(file_backup_restore::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::SubagentSettings { request }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::SubagentSettings(request),
                    Data::PluginConfig(plugin_config::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::ScanWorkGraphIntegrity) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::WorkGraphIntegrity(db_path.clone()),
                    Data::Json(Value::Null),
                )?;
                continue;
            }
            Ok(Request::ListTrashedTasks { trash_root }) => {
                let null = Data::Json(Value::Null);
                match task_trash::list(&db) {
                    Ok(rows) => dispatch_workspace(
                        &mut workspace_scans,
                        id,
                        WorkspaceJob::CheckTrashedDirectories {
                            root: trash_root,
                            rows,
                        },
                        null,
                    )?,
                    Err(_) => write_workspace_reply(&id, null)?,
                }
                continue;
            }
            Ok(Request::DotsFileRevision { root, file }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    id,
                    WorkspaceJob::FileRevision { root, file },
                    Data::DotsFileRevision(dots_file_revision::Revision::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::SemanticInference { request }) => InferenceJob::Embed(request),
            Ok(Request::StageEmbedding { request }) => InferenceJob::Stage(request),
            Ok(Request::SemanticModelProbe { probe }) => InferenceJob::Probe(probe),
            Ok(Request::GadgetState { request }) => {
                let reply = gadget_state
                    .lock()
                    .map_err(|_| "gadget state lock")?
                    .run_for(request, id.as_deref());
                write_reply(&id, Ok(Data::GadgetState(reply)), false)?;
                continue;
            }
            Ok(Request::CoreGadgetHost { command }) => {
                let reply = gadget_http_host::handle(&gadget_state, &host_control, command);
                write_reply(&id, reply.map(Data::Json), false)?;
                continue;
            }
            Ok(Request::ReadManagedArtifact {
                root,
                storage_path,
                cursor,
                inline_raster,
            }) => {
                write_reply(
                    &id,
                    Ok(Data::ManagedArtifactContent(artifact_reads.start(
                        &root,
                        &storage_path,
                        cursor,
                        inline_raster,
                    ))),
                    false,
                )?;
                continue;
            }
            Ok(Request::NextManagedArtifact { cursor }) => {
                write_reply(
                    &id,
                    Ok(Data::ManagedArtifactContent(artifact_reads.next(&cursor))),
                    false,
                )?;
                continue;
            }
            Ok(Request::CloseManagedArtifact { cursor }) => {
                artifact_reads.close(&cursor);
                write_reply(&id, Ok(Data::Json(true.into())), false)?;
                continue;
            }
            Ok(Request::WorkspaceFilePreviewSupported) => {
                write_reply(&id, Ok(Data::Json(true.into())), false)?;
                continue;
            }
            Ok(Request::WorkspaceArtifactStreamSupported) => {
                write_reply(&id, Ok(Data::Json(true.into())), false)?;
                continue;
            }
            Ok(Request::ManagedArtifactImageStreamSupported) => {
                write_reply(&id, Ok(Data::Json(true.into())), false)?;
                continue;
            }
            Ok(Request::RemoteArtifactImageSupported) => {
                write_reply(&id, Ok(Data::Json(true.into())), false)?;
                continue;
            }
            Ok(Request::OpenRemoteArtifactImage {
                root,
                relative_path,
                managed,
                cursor,
            }) => {
                write_reply(
                    &id,
                    Ok(Data::ManagedArtifactContent(
                        artifact_reads.start_remote_image(&root, &relative_path, managed, cursor),
                    )),
                    false,
                )?;
                continue;
            }
            Ok(Request::OpenManagedArtifactImage {
                root,
                storage_path,
                cursor,
            }) => {
                write_reply(
                    &id,
                    Ok(Data::ManagedArtifactContent(artifact_reads.start_image(
                        &root,
                        &storage_path,
                        cursor,
                    ))),
                    false,
                )?;
                continue;
            }
            Ok(Request::OpenWorkspaceArtifact {
                root,
                relative_path,
                cursor,
            }) => {
                write_reply(
                    &id,
                    Ok(Data::ManagedArtifactContent(
                        artifact_reads.start_workspace(&root, &relative_path, cursor),
                    )),
                    false,
                )?;
                continue;
            }
            Ok(Request::WorkspaceFilePreview {
                root,
                relative_path,
                kind,
            }) => {
                write_reply(
                    &id,
                    Ok(Data::WorkspaceFilePreview(workspace_preview::read(
                        &root,
                        &relative_path,
                        kind,
                    ))),
                    false,
                )?;
                continue;
            }
            Ok(Request::EmbeddingIndex { query }) => {
                write_reply(
                    &id,
                    index_queues.query(&mut db, query).map(Data::EmbeddingIndex),
                    false,
                )?;
                continue;
            }
            Ok(Request::CleanupArtifactFiles { root, cleanup }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::CleanupArtifactFiles { root, cleanup },
                )?;
                continue;
            }
            Ok(Request::DeleteLibrary { root, target }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::DeleteLibrary { root, target },
                )?;
                continue;
            }
            Ok(Request::DrainLibraryCleanup { root }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::DrainLibraryCleanup { root },
                )?;
                continue;
            }
            Ok(Request::ExportLibraryBackup {
                root,
                owner,
                staging,
            }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::ExportLibraryBackup {
                        root,
                        owner,
                        staging,
                    },
                )?;
                continue;
            }
            Ok(Request::PrepareLibraryRestore {
                operation_id,
                source,
            }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::PrepareLibraryRestore {
                        operation_id,
                        source,
                    },
                )?;
                continue;
            }
            Ok(Request::DiscardLibraryRestore { operation_id }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::DiscardLibraryRestore { operation_id },
                )?;
                continue;
            }
            Ok(Request::RestoreLibraryBackup { restore }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::RestoreLibraryBackup { restore },
                )?;
                continue;
            }
            Ok(Request::RecoverLibraryRestores { root }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::RecoverLibraryRestores { root },
                )?;
                continue;
            }
            Ok(Request::DeleteProject {
                operation_id,
                id: project_id,
                root,
                withdrawal,
            }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::DeleteProject {
                        operation_id,
                        id: project_id,
                        root,
                        withdrawal,
                    },
                )?;
                continue;
            }
            Ok(Request::PromoteProjectEventToLibrary { promotion }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &db_path,
                    id,
                    MaintenanceJob::PromoteProjectEventToLibrary { promotion },
                )?;
                continue;
            }
            Ok(request) => {
                let mut side_effects = None;
                let res = read(
                    &mut db,
                    &db_path,
                    &mut durable_sessions,
                    &mut writer,
                    &staged,
                    &executor_tracker,
                    &mut side_effects,
                    request,
                );
                let ok = res.is_ok();
                write_reply(&id, res, false)?;
                if ok {
                    emit_side_effects(side_effects);
                }
                continue;
            }
            Err(error) => {
                write_reply(&id, Err(error.into()), false)?;
                continue;
            }
        };
        if inference.is_none() {
            inference = Some(start_inference(db_path.clone(), staged.clone())?);
        }
        match inference.as_ref().unwrap().0.try_send((id, job)) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full((id, _))) => request_control::overload(&id, "OVERLOADED")?,
            Err(mpsc::TrySendError::Disconnected((id, _))) => {
                request_control::overload(&id, "UNAVAILABLE")?
            }
        }
    }
    input.join().map_err(|_| "input dispatcher panicked")??;
    if let Some((sender, worker)) = database_writer {
        drop(sender);
        worker.join().map_err(|_| "database writer panicked")?;
    }
    if let Some((sender, worker)) = inference {
        drop(sender);
        worker
            .join()
            .map_err(|_| "semantic inference thread panicked")?;
    }
    if let Some((sender, worker)) = workspace_scans {
        drop(sender);
        worker
            .join()
            .map_err(|_| "workspace scan thread panicked")?;
    }
    if let Some((sender, worker)) = maintenance {
        drop(sender);
        worker.join().map_err(|_| "maintenance worker panicked")?;
    }
    gadget_http_host::stop_all();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Runtime audit read failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod request_classification_tests {
    use super::*;

    #[test]
    fn library_staging_has_durable_receipt_without_application_writer() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "operation": "libraryText", "path": "input.txt", "stagingPath": "index.db",
            "expectedSize": 0, "chunkSize": 1024, "overlap": 32
        }))
        .unwrap();
        assert!(!database_write(&request));
        let control = request_control::Control::memory();
        control
            .register(
                "staging",
                "libraryText",
                request_control::now_ms() + 30_000,
                request_may_mutate(&request),
            )
            .unwrap_or_else(|_| panic!("admit"));
        control.start("staging").unwrap_or_else(|_| panic!("start"));
        control.finish("staging", false, None, Some("copy interrupted".into()));
        assert_eq!(control.status("staging")["state"], "unknown");
        assert_eq!(control.status("staging")["durable"], true);
    }
}
