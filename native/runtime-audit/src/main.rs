mod answer_routing_data;
mod archive_selection;
mod batch1_writes;
mod batch2_writes;
mod batch3_writes;
mod batch4a_writes;
mod batch4b_bot;
mod batch4b_work;
mod batch4b_writes;
mod database;
mod memory_versioning;
mod native_hooks;
mod read_hints;
mod improvement_packages;
mod improvement_review;
mod outbox_publisher;
mod relation_catalog;
mod resource_gate;
mod search_postings;
mod snapshot_cut;
mod trigger_effects;
mod artifact_cleanup;
mod artifact_content;
mod artifact_snapshots;
mod artifact_write;
mod blueprint_capture;
mod blueprint_instance;
mod blueprint_storage;
mod bot_history_data;
mod bot_registry_data;
mod conversation_branch_data;
mod conversation_goal_write;
mod conversation_runtime_data;
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
mod dots_delegation_data;
mod dots_activity_data;
mod dots_deferred_data;
mod dots_file_revision;
mod dots_file_watch;
mod dots_file_watch_data;
mod dots_followup_data;
mod dots_foreground_data;
mod dots_proactive_data;
mod dots_reply_data;
mod dots_scheduler;
mod durable;
mod durable_task_projection;
mod task_workspace_authority;
mod durable_workspace_move_data;
mod embedding_index;
mod execution_failures;
mod expert_package;
mod external_agent_history_data;
mod file_backup_list;
mod file_backup_restore;
mod gadget_files;
mod gadget_http_host;
mod gadget_materialize;
mod gadget_source_save;
mod gadget_state;
mod goal_continuation;
mod goal_user_input;
mod gateway_admission;
mod gateway_channel_data;
mod gateway_delivery_control;
mod gateway_execution_authority;
mod gateway_message_data;
mod gateway_queue_data;
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
mod loadout_observation_data;
mod maintenance_scheduler;
mod material_retrieval_data;
mod memory_baselines;
mod memory_capture;
mod memory_extraction_queue;
mod memory_lexical;
mod memory_organization_data;
mod memory_record_write;
mod memory_records_data;
mod memory_turn_data;
mod notification_data;
mod pi_host_supervisor;
mod pi_storage;
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
mod writer_admission;
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
mod python_project_bindings;
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

use duckdb::{Connection, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    error::Error,
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const DOTS_TASK_ID: &str = "mybuddy-dots";
const DOTS_NO_CHANGE: &str = "[[dots:no-change]]";

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
            ScopeParam::Integer(integer) => SqlValue::BigInt(integer),
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
    ReadGatewayChannels {
        channel_id: Option<String>,
    },
    ReadGatewayChannelState {
        channel_id: String,
    },
    ReadDotsDelegationData {
        query: dots_delegation_data::Query,
    },
    ReadDotsReplyData {
        query: dots_reply_data::Query,
    },
    WriteDotsReplyData {
        command: dots_reply_data::Command,
    },
    ReadDotsActivityData { query: dots_activity_data::Query },
    ReadDotsDeferredData { query: dots_deferred_data::Query },
    WriteDotsDeferredData { command: dots_deferred_data::Command },
    ReadDotsFollowupData { query: dots_followup_data::Query },
    WriteDotsFollowupData { command: dots_followup_data::Command },
    ReadDotsForegroundData { query: dots_foreground_data::Query },
    WriteDotsForegroundData { command: dots_foreground_data::Command },
    ReadDotsProactiveData { query: dots_proactive_data::Query },
    WriteDotsProactiveData { command: dots_proactive_data::Command },
    ReadDotsFileWatchData { query: dots_file_watch_data::Query },
    WriteDotsFileWatchData { command: dots_file_watch_data::Command },
    WriteGatewayChannel {
        operation_id: String,
        draft: gateway_channel_data::WriteChannel,
    },
    ReadGatewayOutbox {
        delivery_id: String,
    },
    ReadGatewayInbox {
        delivery_id: String,
    },
    ReadGatewayExecutionAuthority { task_id: String },
    MaterializeGatewayTask { command: gateway_execution_authority::Materialize },
    ReadGatewayAssignment {
        origin: gateway_admission::Origin,
    },
    ReadGatewayQueue {
        query: gateway_queue_data::Query,
    },
    GatewayAdmitInbound {
        draft: gateway_admission::Admission,
    },
    GatewayDeliveryControl {
        delivery_id: String,
        operation_id: String,
        command: gateway_delivery_control::Action,
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
        write_id: String,
        mutation: snapshots::Mutation,
    },
    SnapshotReceipt {
        write_id: String,
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
    TaskRecord {
        task_id: String,
        include_expert_bindings: bool,
    },
    PythonProjectBindings {
        ancestors: Option<Vec<String>>,
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
    ReadMemoryExtractionQueue {
        task_ids: Option<Vec<String>>,
    },
    RetryMemoryExtractionQueue {
        user_id: String,
        operation_id: String,
    },
    WriteMemoryTurnExtraction {
        command: memory_turn_data::ExtractionCommand,
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
    ReadBotRegistry {
        query: bot_registry_data::Query,
    },
    ReadConversationRuntime {
        query: conversation_runtime_data::Query,
    },
    ReadGoalContinuation {
        query: goal_continuation::ReadRequest,
    },
    WriteGoalContinuation {
        command: goal_continuation::Command,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    ReadConversationBranchData {
        query: conversation_branch_data::Query,
        #[serde(rename = "__client")]
        client: Option<business_protocol::ClientContext>,
    },
    ExternalAgentHistoryPage {
        task_id: String,
        after: Option<external_agent_history_data::Cursor>,
    },
    ReadLoadoutObservations {
        task_id: String,
        limit: i64,
    },
    CreateConversationGoal {
        operation_id: String,
        draft: conversation_goal_write::CreateGoal,
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
    ReadNativeHooks {
        query: native_hooks::Query,
    },
    WriteNativeHooks {
        mutation: native_hooks::Mutation,
    },
    ReadPathHints {
        query: read_hints::Query,
    },
    WritePathHints {
        mutation: read_hints::Mutation,
    },
    ReadImprovementPackages {
        query: improvement_packages::Query,
    },
    WriteImprovementPackages {
        mutation: improvement_packages::Mutation,
    },
    ReadImprovementReview {
        query: improvement_review::Query,
    },
    WriteImprovementReview {
        mutation: improvement_review::Mutation,
    },
    UpsertWorkspace {
        mutation: workspace_persistence::Mutation,
    },
    DurableTaskProjectionSupported,
    DurableTaskOriginsSupported,
    ReadDurableTaskProjection {
        query: durable_task_projection::Query,
    },
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
    ApplicationDatabaseIdentity,
    TaskWorkspacePaths,
    ArtifactSnapshots {
        task_ids: Vec<String>,
    },
    ArtifactData {
        query: artifact_snapshots::Query,
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
        writer_id: String,
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
    UsageSessionFiles,
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
    PiStorage {
        payload: pi_storage::Invocation,
    },
    CoreMaintenanceScheduler {
        #[serde(flatten)]
        command: maintenance_scheduler::Command,
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
    WorkGraphIntegrity,
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

#[derive(Default)]
struct PoolMetrics {
    queue_managed_by_admission: bool,
    workers: AtomicUsize,
    active: AtomicUsize,
    max_active: AtomicUsize,
    queued: AtomicUsize,
    max_queued: AtomicUsize,
    completed: AtomicU64,
    overloaded: AtomicU64,
}

impl PoolMetrics {
    fn snapshot(&self) -> Value {
        serde_json::json!({
            "workers": self.workers.load(Ordering::Acquire),
            "active": self.active.load(Ordering::Acquire),
            "maxActive": self.max_active.load(Ordering::Acquire),
            "queued": self.queued.load(Ordering::Acquire),
            "maxQueued": self.max_queued.load(Ordering::Acquire),
            "completed": self.completed.load(Ordering::Acquire),
            "overloaded": self.overloaded.load(Ordering::Acquire),
        })
    }
}

static READ_POOL_METRICS: PoolMetrics = PoolMetrics {
    queue_managed_by_admission: false,
    workers: AtomicUsize::new(0),
    active: AtomicUsize::new(0),
    max_active: AtomicUsize::new(0),
    queued: AtomicUsize::new(0),
    max_queued: AtomicUsize::new(0),
    completed: AtomicU64::new(0),
    overloaded: AtomicU64::new(0),
};
static WORKSPACE_IO_METRICS: PoolMetrics = PoolMetrics {
    queue_managed_by_admission: false,
    workers: AtomicUsize::new(0),
    active: AtomicUsize::new(0),
    max_active: AtomicUsize::new(0),
    queued: AtomicUsize::new(0),
    max_queued: AtomicUsize::new(0),
    completed: AtomicU64::new(0),
    overloaded: AtomicU64::new(0),
};
static GADGET_IO_METRICS: PoolMetrics = PoolMetrics {
    queue_managed_by_admission: false,
    workers: AtomicUsize::new(0),
    active: AtomicUsize::new(0),
    max_active: AtomicUsize::new(0),
    queued: AtomicUsize::new(0),
    max_queued: AtomicUsize::new(0),
    completed: AtomicU64::new(0),
    overloaded: AtomicU64::new(0),
};
static DB_WRITE_POOL_METRICS: PoolMetrics = PoolMetrics {
    queue_managed_by_admission: true,
    workers: AtomicUsize::new(0),
    active: AtomicUsize::new(0),
    max_active: AtomicUsize::new(0),
    queued: AtomicUsize::new(0),
    max_queued: AtomicUsize::new(0),
    completed: AtomicU64::new(0),
    overloaded: AtomicU64::new(0),
};

pub fn runtime_metrics_json() -> Value {
    let (intra, inter) = semantic_inference::configured_threads();
    serde_json::json!({
        "readPool": READ_POOL_METRICS.snapshot(),
        "workspaceIo": WORKSPACE_IO_METRICS.snapshot(),
        "gadgetIo": GADGET_IO_METRICS.snapshot(),
        "databaseWriter": DB_WRITE_POOL_METRICS.snapshot(),
        "gadgetHttp": gadget_http_host::metrics_json(),
        "ort": {
            "intraThreads": intra,
            "interThreads": inter,
        },
        "ephemeralProgress": {
            "emitted": business_protocol::ephemeral_progress_emitted(),
            "dropped": core_supervisor::ephemeral_progress_dropped(),
        },
    })
}

fn configured_read_pool_workers() -> usize {
    std::env::var("MYBUDDY_READ_POOL_WORKERS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(4)
        .clamp(1, 8)
}

fn configured_workspace_io_workers() -> usize {
    std::env::var("MYBUDDY_WORKSPACE_IO_WORKERS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(2)
        .clamp(1, 4)
}

struct PoolQueue<J> {
    items: VecDeque<(RequestId, J)>,
    closed: bool,
}

struct WorkerPool<J: Send + 'static> {
    shared: Arc<(Mutex<PoolQueue<J>>, Condvar)>,
    capacity: usize,
    metrics: &'static PoolMetrics,
    handles: Vec<thread::JoinHandle<()>>,
}

impl<J: Send + 'static> WorkerPool<J> {
    fn spawn<S: Send + 'static>(
        name_prefix: &str,
        workers: usize,
        capacity: usize,
        metrics: &'static PoolMetrics,
        make_state: impl Fn() -> S,
        handler: impl Fn(&mut S, RequestId, J) -> bool + Send + Sync + 'static,
    ) -> io::Result<Self> {
        metrics.workers.store(workers, Ordering::Release);
        let shared = Arc::new((
            Mutex::new(PoolQueue {
                items: VecDeque::with_capacity(capacity.min(64)),
                closed: false,
            }),
            Condvar::new(),
        ));
        let handler = Arc::new(handler);
        let mut handles = Vec::with_capacity(workers);
        for index in 0..workers {
            let shared_c = Arc::clone(&shared);
            let handler_c = Arc::clone(&handler);
            let mut state = make_state();
            let handle = thread::Builder::new()
                .name(format!("{name_prefix}-{index}"))
                .spawn(move || {
                    loop {
                        let job = {
                            let (lock, cv) = &*shared_c;
                            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                            while guard.items.is_empty() && !guard.closed {
                                guard = cv.wait(guard).unwrap_or_else(|e| e.into_inner());
                            }
                            let popped = guard.items.pop_front();
                            if !metrics.queue_managed_by_admission {
                                metrics.queued.store(guard.items.len(), Ordering::Release);
                            }
                            popped
                        };
                        let Some((id, item)) = job else {
                            break;
                        };
                        let active = metrics.active.fetch_add(1, Ordering::AcqRel) + 1;
                        metrics.max_active.fetch_max(active, Ordering::AcqRel);
                        let keep_going = handler_c(&mut state, id, item);
                        metrics.active.fetch_sub(1, Ordering::AcqRel);
                        metrics.completed.fetch_add(1, Ordering::AcqRel);
                        if !keep_going {
                            break;
                        }
                    }
                })?;
            handles.push(handle);
        }
        Ok(Self {
            shared,
            capacity,
            metrics,
            handles,
        })
    }

    fn try_send(&self, id: RequestId, item: J) -> std::result::Result<(), (RequestId, &'static str)> {
        let (lock, cv) = &*self.shared;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        if guard.closed {
            return Err((id, "UNAVAILABLE"));
        }
        if guard.items.len() >= self.capacity {
            self.metrics.overloaded.fetch_add(1, Ordering::AcqRel);
            return Err((id, "OVERLOADED"));
        }
        guard.items.push_back((id, item));
        if !self.metrics.queue_managed_by_admission {
            let q = guard.items.len();
            self.metrics.queued.store(q, Ordering::Release);
            self.metrics.max_queued.fetch_max(q, Ordering::AcqRel);
        }
        cv.notify_one();
        Ok(())
    }

    fn shutdown(self) -> Result<()> {
        {
            let (lock, cv) = &*self.shared;
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            guard.closed = true;
            cv.notify_all();
        }
        for handle in self.handles {
            handle.join().map_err(|_| "worker pool thread panicked")?;
        }
        Ok(())
    }
}

fn start_workspace_scans(engine: Arc<database::DuckDbEngine>) -> io::Result<WorkerPool<WorkspaceJob>> {
    let workers = configured_workspace_io_workers();
    WorkerPool::spawn(
        "workspace-scan",
        workers,
        32,
        &WORKSPACE_IO_METRICS,
        move || Arc::clone(&engine),
        |engine, id, job| {
            if !request_control::begin(&id) {
                return true;
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
                WorkspaceJob::WorkGraphIntegrity => (|| -> Result<Data> {
                    let mut pooled = engine.checkout_reader(Duration::from_secs(10))?;
                    if let (Some(req_id), Some(ctrl)) = (id.as_deref(), request_control::shared()) {
                        pooled.bind_request(req_id, ctrl.clone());
                    }
                    work_graph_integrity::scan(pooled.conn_mut()).map(Data::WorkGraphIntegrity)
                })()
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
            write_workspace_reply(&id, result).is_ok()
        },
    )
}

fn dispatch_workspace(
    worker: &mut Option<WorkerPool<WorkspaceJob>>,
    engine: &Arc<database::DuckDbEngine>,
    id: RequestId,
    job: WorkspaceJob,
    _fallback: Data,
) -> Result<()> {
    if worker.is_none() {
        *worker = start_workspace_scans(Arc::clone(engine)).ok();
    }
    match worker {
        Some(pool) => match pool.try_send(id, job) {
            Ok(()) => Ok(()),
            // The rejected job hands its id back, so even the fallback is correlated.
            Err((id, code)) => request_control::overload(&id, code).map_err(Into::into),
        },
        None => request_control::overload(&id, "UNAVAILABLE").map_err(Into::into),
    }
}

fn start_read_pool(
    engine: Arc<database::DuckDbEngine>,
    gate: Arc<resource_gate::ResourceGate>,
    outbox: Arc<outbox_publisher::OutboxPublisher>,
    staged: Arc<embedding_index::StagedVectors>,
    executor_tracker: Arc<business_protocol::ExecutorTracker>,
) -> io::Result<WorkerPool<Request>> {
    let workers = engine.config().read_pool_size;
    WorkerPool::spawn(
        "read-pool",
        workers,
        64,
        &READ_POOL_METRICS,
        move || {
            (
                Arc::clone(&engine),
                Arc::clone(&gate),
                Arc::clone(&outbox),
                HashMap::<String, durable::HistorySession>::new(),
                Arc::clone(&staged),
                Arc::clone(&executor_tracker),
            )
        },
        |(engine, gate, outbox, durable_sessions, staged, tracker), id, request| {
            if !request_control::begin(&id) {
                return true;
            }
            let result = if let Request::CoreEventsSnapshot { domain } = request {
                (|| -> Result<Data> {
                    let mut pinned = snapshot_cut::StrongSnapshotCut::acquire(
                        engine,
                        gate,
                        outbox,
                        &business_protocol::current_core_generation(),
                        Duration::from_secs(30),
                        Duration::from_secs(5),
                    )?;
                    let data = business_protocol::events_snapshot(pinned.conn(), domain.as_deref())
                        .map(Data::Json);
                    let _ = pinned.release_lease();
                    data
                })()
            } else {
                (|| -> Result<Data> {
                    let mut pooled = engine.checkout_reader(Duration::from_secs(15))?;
                    if let (Some(req_id), Some(ctrl)) = (id.as_deref(), request_control::shared()) {
                        pooled.bind_request(req_id, ctrl.clone());
                    }
                    let mut side_effects = None;
                    read(
                        pooled.conn_mut(),
                        engine,
                        gate,
                        outbox,
                        durable_sessions,
                        staged,
                        tracker,
                        &mut side_effects,
                        request,
                    )
                })()
            };
            write_reply(&id, result, false).is_ok()
        },
    )
}

fn start_gadget_io_pool(gadget_state: Arc<gadget_state::Store>) -> io::Result<WorkerPool<gadget_state::Request>> {
    WorkerPool::spawn(
        "gadget-io",
        4,
        64,
        &GADGET_IO_METRICS,
        move || Arc::clone(&gadget_state),
        |store, id, request| {
            if !request_control::begin(&id) {
                return true;
            }
            let reply = store.run_for(request, id.as_deref());
            write_reply(&id, Ok(Data::GadgetState(reply)), false).is_ok()
        },
    )
}

enum InferenceJob {
    Embed(semantic_inference::Request),
    Stage(embedding_index::StageRequest),
    Probe(semantic_model::Probe),
}

fn start_inference(
    engine: Arc<database::DuckDbEngine>,
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
                        let mut reader = engine.checkout_reader(Duration::from_secs(10))?;
                        if let (Some(req_id), Some(ctrl)) = (id.as_deref(), request_control::shared())
                        {
                            reader.bind_request(req_id, ctrl.clone());
                        }
                        embedding_index::stage(
                            reader.conn(),
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

fn start_maintenance(
    engine: Arc<database::DuckDbEngine>,
    gate: Arc<resource_gate::ResourceGate>,
) -> io::Result<MaintenanceWorker> {
    let (send, jobs) = mpsc::sync_channel::<(RequestId, MaintenanceJob)>(8);
    let worker = thread::Builder::new()
        .name("maintenance".into())
        .spawn(move || {
            let mut prepared_restore = None;
            for (id, job) in jobs {
                if !request_control::begin(&id) {
                    continue;
                }
                // A panicking job replies with an error and leaves the thread serving:
                // it must never take the shared process (or a later job) with it.
                let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_maintenance(&engine, &gate, id.as_deref(), &mut prepared_restore, job)
                })) {
                    Ok(result) => result,
                    Err(_) => Err("maintenance job panicked".into()),
                };
                if result.is_err() {
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
    engine: &Arc<database::DuckDbEngine>,
    gate: &Arc<resource_gate::ResourceGate>,
    id: RequestId,
    job: MaintenanceJob,
) -> Result<()> {
    if worker.is_none() {
        *worker = start_maintenance(Arc::clone(engine), Arc::clone(gate)).ok();
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
    engine: &database::DuckDbEngine,
    gate: &resource_gate::ResourceGate,
    req_id: Option<&str>,
    prepared_restore: &mut Option<(String, library_restore::Backup)>,
    job: MaintenanceJob,
) -> Result<Data> {
    let checkout_with_gate = |domain_key: &str, also: Option<&str>| -> Result<(resource_gate::ResourceLease, database::PooledConnection)> {
        use resource_gate::{ResourceKey, ResourceRequirement};
        let mut plan = vec![
            ResourceRequirement::shared(ResourceKey::DbLifecycle),
            ResourceRequirement::shared(ResourceKey::CommitShare),
            ResourceRequirement::exclusive(ResourceKey::MaintenanceCycle(domain_key.to_owned())),
            ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), domain_key.to_owned())),
        ];
        plan.extend(also.map(|name| ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), name.to_owned()))));
        let lease = gate
            .acquire(plan, Duration::from_secs(30), || {
                req_id
                    .and_then(|id| request_control::shared().map(|c| c.is_cancelled_or_expired(id)))
                    .unwrap_or(false)
            })
            .map_err(|e| -> Box<dyn Error> { format!("Maintenance gate acquire failed: {e:?}").into() })?;
        let mut writer = engine.checkout_writer(Duration::from_secs(30))?;
        if let (Some(id), Some(ctrl)) = (req_id, request_control::shared()) {
            writer.bind_request(id, ctrl.clone());
        }
        Ok((lease, writer))
    };

    match job {
        MaintenanceJob::CleanupArtifactFiles { root, cleanup } => {
            let (_lease, mut writer) = checkout_with_gate("artifacts", None)?;
            artifact_cleanup::clean(writer.conn_mut(), &root, cleanup).map(Data::ArtifactCleanup)
        }
        MaintenanceJob::DeleteLibrary { root, target } => {
            let (_lease, mut writer) = checkout_with_gate("library", None)?;
            library_delete::delete(writer.conn_mut(), &root, target).map(Data::Json)
        }
        MaintenanceJob::DrainLibraryCleanup { root } => {
            let (_lease, mut writer) = checkout_with_gate("library", None)?;
            library_delete::drain(writer.conn_mut(), &root).map(|completed| Data::Json(completed.into()))
        }
        MaintenanceJob::ExportLibraryBackup {
            root,
            owner,
            staging,
        } => {
            let (_lease, mut writer) = checkout_with_gate("library", None)?;
            let status = library_backup::export(writer.conn_mut(), &root, owner, &staging)?;
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
            let (_lease, mut writer) = checkout_with_gate("library", None)?;
            Ok(Data::Json(
                match library_restore::restore(writer.conn_mut(), backup, restore) {
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
            let (_lease, mut writer) = checkout_with_gate("library", None)?;
            library_restore::recover(writer.conn_mut(), &root, None).map(|count| Data::Json(count.into()))
        }
        MaintenanceJob::DeleteProject {
            operation_id,
            id,
            root,
            withdrawal,
        } => {
            let (_lease, mut writer) = checkout_with_gate("projects", Some("cron"))?;
            project_delete::delete(writer.conn_mut(), &operation_id, &id, &root, withdrawal)
                .map(Data::Json)
        }
        MaintenanceJob::PromoteProjectEventToLibrary { promotion } => {
            let (_lease, mut writer) = checkout_with_gate("library", None)?;
            let result = project_library_promotion::promote(writer.conn_mut(), promotion)
                .unwrap_or_else(|error| project_library_promotion::Reply::Rejected {
                    message: error.to_string(),
                });
            Ok(Data::Json(serde_json::to_value(result)?))
        }
    }
}

fn read(
    db: &mut Connection,
    engine: &Arc<database::DuckDbEngine>,
    gate: &Arc<resource_gate::ResourceGate>,
    outbox: &Arc<outbox_publisher::OutboxPublisher>,
    durable_sessions: &mut HashMap<String, durable::HistorySession>,
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
            db,
            executor_tracker,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreExecution {
        action:
            business_protocol::ExecutionRequest::ExecutorProgress {
                execution_id,
                attempt,
                progress,
                owner_generation,
                host_generation,
                ephemeral: true,
                ..
            },
        client,
    } = request
    {
        if let Some(hg) = host_generation.as_deref()
            && pi_host_supervisor::is_generation_fenced(db, hg)
        {
            return Ok(Data::Json(serde_json::json!({
                "status": "rejected",
                "code": "STALE_HOST_GENERATION",
                "hostGeneration": hg,
            })));
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        return business_protocol::execute_ephemeral_progress(
            executor_tracker,
            &ctx,
            &execution_id,
            attempt,
            progress,
            owner_generation.as_deref(),
        )
        .map(Data::Json);
    }
    if let Request::CoreExecution { action, client } = request {
        if let business_protocol::ExecutionRequest::Status { execution_id } = action {
            return business_protocol::execute_execution_read(db, &execution_id).map(Data::Json);
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = business_protocol::execute_execution(
            db,
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
            db,
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
            db,
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
            db,
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
            db,
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
            db,
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
            db,
            executor_tracker,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::PiStorage { payload } = request {
        let may_publish_goal = matches!(&payload.action, pi_storage::Action::Commit { batches, .. }
            if batches.iter().flatten().any(|write| pi_storage::goal_user_input_task(write).is_some()));
        let result = payload.execute(db).map(Data::Json);
        if result.is_ok() && may_publish_goal {
            outbox.wake();
        }
        return result;
    }
    if let Request::CoreMaintenanceScheduler { command, client } = request {
        if command.is_read_only() {
            return maintenance_scheduler::execute_read(db, command).map(Data::Json);
        }
        let ctx = client.unwrap_or_else(|| {
            business_protocol::ClientContext::synthetic(&business_protocol::current_core_generation())
        });
        let fx = maintenance_scheduler::execute_write(
            db,
            executor_tracker,
            &ctx,
            command,
        )?;
        let data = fx.data.clone();
        *side_effects = Some(fx);
        return Ok(Data::Json(data));
    }
    if let Request::CoreEventsSnapshot { domain } = request {
        let mut pinned = snapshot_cut::StrongSnapshotCut::acquire(
            engine,
            gate,
            outbox,
            &business_protocol::current_core_generation(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )?;
        let result = business_protocol::events_snapshot(pinned.conn(), domain.as_deref()).map(Data::Json);
        let _ = pinned.release_lease();
        return result;
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
            db,
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
            db,
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
            db,
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
            db,
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
            .publish(db, &tokens, at)
            .map(Data::EmbeddingCounts);
    }
    if let Request::DiscardEmbeddings { tokens } = request {
        staged.discard(&tokens)?;
        return Ok(Data::Json(true.into()));
    }
    if let Request::Durable { session, action } = request {
        return durable::read(engine, durable_sessions, session, action).map(Data::Json);
    }
    if let Request::LibraryText { request } = request {
        return library_text::stage(request).map(Data::LibraryText);
    }
    if let Request::ReadGadgetSource { root, id, inspect } = request {
        return Ok(read_recovered_gadget_source(
            db,
            &root,
            &id,
            || gadget_files::read_source(&root, &id, inspect),
        ));
    }
    if let Request::ReadGadgetManifest { root, id } = request {
        return Ok(read_recovered_gadget_source(
            db,
            &root,
            &id,
            || gadget_files::read_manifest(&root, &id),
        ));
    }
    if let Request::CaptureBlueprintGadget { root, id, deny } = request {
        let deny = blueprint_capture::deny_pattern(&deny)?;
        return Ok(read_recovered_gadget_source(
            db,
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
            gadget_files::remove_unregistered(db, &root, &id)?;
        return Ok(Data::Json(removed.into()));
    }
    if let Request::ReconcileBlueprintStorage { root } = request {
        let failures = blueprint_storage::reconcile(db, &root)?;
        return Ok(Data::Json(serde_json::to_value(failures)?));
    }
    if let Request::CreateGadgetFiles { create } = request {
        return Ok(Data::GadgetFiles(gadget_materialize::create(
            db,
            create,
        )));
    }
    if let Request::ExportGadgetFiles { export } = request {
        return Ok(Data::GadgetFiles(gadget_materialize::export(db, export)));
    }
    if let Request::SaveGadgetSource { save } = request {
        return Ok(Data::GadgetSourceSaved(gadget_source_save::save(
            db,
            save,
        )));
    }
    if let Request::ReconcileGadgetStorage { root } = request {
        let failed = gadget_files::reconcile(db, &root)?;
        return Ok(Data::Json(serde_json::to_value(failed)?));
    }
    if let Request::PluginCatalog { query } = request {
        return plugin_catalog::read(query).map(Data::Json);
    }
    if let Request::WorkspaceFilePreview {
        root,
        relative_path,
        kind,
    } = request
    {
        return Ok(Data::WorkspaceFilePreview(workspace_preview::read(
            &root,
            &relative_path,
            kind,
        )));
    }
    if let Request::WorkspaceMoveSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::MoveWorkspaceTree { movement } = request {
        return Ok(Data::WorkspaceMove(workspace_move::write(
            db,
            movement,
        )));
    }
    if let Request::SidebarArchiveSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::SetSidebarArchive { archive } = request {
        return Ok(Data::SidebarArchive(workspace_move::archive(
            db,
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
            db,
            mutation,
        )));
    }
    if let Request::DeleteWorkspace { mutation } = request {
        return Ok(Data::WorkspaceDelete(workspace_delete::write(
            db,
            mutation,
        )));
    }
    if let Request::WorkspaceBindingSnapshot { id } = request {
        return workspace_binding_data::read(db, &id).map(Data::WorkspaceBindingSnapshot);
    }
    if let Request::WriteWorkspaceBinding { mutation } = request {
        return Ok(Data::WorkspaceBindingWrite(workspace_binding_data::write(
            db,
            mutation,
        )));
    }
    if let Request::MemoryTurnData { query, user_id } = request {
        return memory_turn_data::read(db, query, &user_id).map(Data::Json);
    }
    if let Request::ReadMemoryExtractionQueue { task_ids } = request {
        return memory_extraction_queue::snapshot(db, task_ids).map(Data::Json);
    }
    if let Request::RetryMemoryExtractionQueue { user_id, operation_id } = request {
        return memory_extraction_queue::retry(db, &user_id, &operation_id).map(Data::Json);
    }
    if let Request::WriteMemoryTurnExtraction { command, user_id } = request {
        return memory_turn_data::write_extraction(db, command, &user_id).map(Data::Json);
    }
    if let Request::MemoryRecordsData { query } = request {
        return memory_records_data::read(db, query).map(Data::Json);
    }
    if let Request::WriteMemoryRecord { request } = request {
        return Ok(Data::MemoryRecordWrite(memory_record_write::write(
            db,
            request,
        )));
    }
    if let Request::ProjectPins { request } = request {
        return Ok(Data::ProjectPins(project_pins_data::run(db, request)));
    }
    if let Request::ProjectPosts { request } = request {
        return Ok(Data::ProjectPosts(project_posts_data::run(db, request)));
    }
    if let Request::ProjectEventData { request } = request {
        return Ok(Data::ProjectEventData(project_event_data::run(
            db, request,
        )));
    }
    if let Request::AnswerRoutingData { request } = request {
        return Ok(Data::AnswerRoutingData(answer_routing_data::run(
            db, request,
        )));
    }
    if let Request::ReadWorkQueue { query } = request {
        return work_queue_data::read(db, query).map(Data::Json);
    }
    if let Request::ReadGatewayChannels { channel_id } = request {
        let channels = gateway_channel_data::read(db, channel_id)?;
        return Ok(Data::Json(serde_json::to_value(channels)?));
    }
    if let Request::ReadGatewayChannelState { channel_id } = request {
        return gateway_channel_data::read_state(db, &channel_id).map(Data::Json);
    }
    if let Request::ReadDotsDelegationData { query } = request {
        return dots_delegation_data::read(db, query).map(Data::Json);
    }
    if let Request::ReadDotsReplyData { query } = request {
        return dots_reply_data::read(db, query).map(Data::Json);
    }
    if let Request::WriteDotsReplyData { command } = request {
        return dots_reply_data::write(db, command).map(Data::Json);
    }
    if let Request::ReadDotsActivityData { query } = request {
        return dots_activity_data::read(db, query).map(Data::Json);
    }
    if let Request::ReadDotsDeferredData { query } = request {
        return dots_deferred_data::read(db, query).map(Data::Json);
    }
    if let Request::WriteDotsDeferredData { command } = request {
        return dots_deferred_data::write(db, command).map(Data::Json);
    }
    if let Request::ReadDotsFollowupData { query } = request {
        return dots_followup_data::read(db, query).map(Data::Json);
    }
    if let Request::WriteDotsFollowupData { command } = request {
        return dots_followup_data::write(db, command).map(Data::Json);
    }
    if let Request::ReadDotsForegroundData { query } = request {
        return dots_foreground_data::read(db, query).map(Data::Json);
    }
    if let Request::WriteDotsForegroundData { command } = request {
        return dots_foreground_data::write(db, command).map(Data::Json);
    }
    if let Request::ReadDotsProactiveData { query } = request {
        return dots_proactive_data::read(db, query).map(Data::Json);
    }
    if let Request::WriteDotsProactiveData { command } = request {
        return dots_proactive_data::write(db, command).map(Data::Json);
    }
    if let Request::ReadDotsFileWatchData { query } = request {
        return dots_file_watch_data::read(db, query).map(Data::Json);
    }
    if let Request::WriteDotsFileWatchData { command } = request {
        return dots_file_watch_data::write(db, command).map(Data::Json);
    }
    if let Request::WriteGatewayChannel { operation_id, draft } = request {
        let reply = gateway_channel_data::write(db, &operation_id, draft)?;
        return Ok(Data::Json(serde_json::to_value(reply)?));
    }
    if let Request::ReadGatewayOutbox { delivery_id } = request {
        return Ok(Data::Json(serde_json::to_value(gateway_delivery_control::read_outbox(db, &delivery_id)?)?));
    }
    if let Request::ReadGatewayInbox { delivery_id } = request {
        return gateway_admission::inbox(db, &delivery_id).map(Data::Json);
    }
    if let Request::ReadGatewayExecutionAuthority { task_id } = request {
        return gateway_execution_authority::read(db, &task_id).map(Data::Json);
    }
    if let Request::MaterializeGatewayTask { command } = request {
        return gateway_execution_authority::write(db, command).map(Data::Json);
    }
    if let Request::ReadGatewayAssignment { origin } = request {
        let tx = db.transaction()?;
        let value = gateway_admission::assignment(&tx, origin)?;
        tx.commit()?;
        return Ok(Data::Json(value));
    }
    if let Request::ReadGatewayQueue { query } = request {
        return gateway_queue_data::read(db, query).map(Data::Json);
    }
    if let Request::GatewayAdmitInbound { draft } = request {
        return gateway_admission::admit(db, draft).map(Data::Json);
    }
    if let Request::GatewayDeliveryControl { delivery_id, operation_id, command } = request {
        return gateway_delivery_control::run(db, &delivery_id, &operation_id, command).map(Data::Json);
    }
    if let Request::ReadGatewayMessages { query } = request {
        return gateway_message_data::read(db, query).map(Data::GatewayMessages);
    }
    if let Request::AppendGatewayMessage { message } = request {
        return gateway_message_data::append(db, &message)
            .map(Data::GatewayMessageWrite);
    }
    if let Request::CodeReviewData { query } = request {
        return code_review_data::read(db, query).map(Data::Json);
    }
    if let Request::MaterialRetrievalData { request } = request {
        return Ok(Data::MaterialRetrievalData(material_retrieval_data::run(
            db, request,
        )));
    }
    if let Request::RestoreTrashedTask { request } = request {
        return Ok(Data::TaskTrashRestore(task_trash_restore::restore(
            db,
            request,
        )));
    }
    if let Request::ReadBotHistoryPage { query } = request {
        return bot_history_data::read(db, query).map(Data::BotHistoryPage);
    }
    if let Request::ReadBotRegistry { query } = request {
        return bot_registry_data::read(db, query).map(Data::Json);
    }
    if let Request::ReadConversationRuntime { query } = request {
        return conversation_runtime_data::read(db, query).map(Data::Json);
    }
    if let Request::ReadGoalContinuation { query } = request {
        return goal_continuation::read_request(db, query).map(Data::Json);
    }
    if let Request::WriteGoalContinuation { command, client } = request {
        let Some(client) = client.filter(|client| client.role == "execution-host"
            && executor_tracker.is_online().is_some_and(|(epoch, id)| epoch == client.epoch && id == client.client_id)) else {
            return Ok(Data::Json(serde_json::json!({ "status": "rejected", "code": "executor_fenced" })));
        };
        let result = goal_continuation::write(db, command, &client)?;
        if result.get("workId").is_some() { outbox.wake(); }
        return Ok(Data::Json(result));
    }
    if let Request::ReadConversationBranchData { query, client } = request {
        return conversation_branch_data::read(db, query, client.as_ref()).map(Data::Json);
    }
    if let Request::CreateConversationGoal { operation_id, draft } = request {
        let result = conversation_goal_write::create(db, &operation_id, draft)?;
        if result["replayed"].as_bool() == Some(false) {
            outbox.wake();
        }
        return Ok(Data::Json(result));
    }
    if let Request::MarkWorkCardRead { request } = request {
        return Ok(Data::WorkCardRead(work_queue_data::mark_read(
            db,
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
            db,
            mutation,
        )));
    }
    if let Request::ReadDurableTaskProjection { query } = request {
        return durable_task_projection::read(db, query).map(Data::Json);
    }
    if let Request::WriteDurableTaskProjection { request } = request {
        return Ok(Data::DurableTaskProjection(durable_task_projection::write(
            db,
            &request,
        )));
    }
    if let Request::WriteDurableWorkspaceMove { request } = request {
        return Ok(Data::DurableWorkspaceMove(
            durable_workspace_move_data::write(db, &request),
        ));
    }
    if let Request::ReadTaskExpertBinding { task_id } = request {
        return task_expert_binding::read(db, &task_id).map(Data::TaskExpertBinding);
    }
    if let Request::WriteTaskExpertBinding { mutation } = request {
        return Ok(Data::TaskExpertBindingWrite(task_expert_binding::write(
            db,
            mutation,
        )));
    }
    if let Request::SoulProfile { request } = request {
        return Ok(Data::SoulProfile(soul_profile_data::run(db, request)));
    }
    if let Request::MemoryOrganizationLatest = request {
        return memory_organization_data::latest(db).map(|run| Data::Json(run.into()));
    }
    if let Request::WriteMemoryOrganizationProgress { progress } = request {
        return memory_organization_data::write_progress(
            db,
            progress,
        )
        .map(|written| Data::Json(written.into()));
    }
    if let Request::ApplyWorkGraphRepair { preview } = request {
        return Ok(Data::WorkGraphRepair(work_graph_integrity::repair(
            db,
            &preview,
        )));
    }
    if let Request::NotificationData { query } = request {
        return notification_data::read(db, query).map(Data::Json);
    }
    if let Request::ReadNativeHooks { query } = request {
        return native_hooks::read(db, query).map(Data::Json);
    }
    if let Request::WriteNativeHooks { mutation } = request {
        return native_hooks::write(db, mutation).map(Data::Json);
    }
    if let Request::ReadPathHints { query } = request {
        return read_hints::read(db, query).map(Data::Json);
    }
    if let Request::WritePathHints { mutation } = request {
        return read_hints::write(db, mutation).map(Data::Json);
    }
    if let Request::ReadImprovementPackages { query } = request {
        return improvement_packages::read(db, query).map(Data::Json);
    }
    if let Request::WriteImprovementPackages { mutation } = request {
        return improvement_packages::write(db, mutation).map(Data::Json);
    }
    if let Request::ReadImprovementReview { query } = request {
        return improvement_review::read(db, query).map(Data::Json);
    }
    if let Request::WriteImprovementReview { mutation } = request {
        return improvement_review::write(db, mutation).map(Data::Json);
    }
    if let Request::WriteNotification { mutation } = request {
        return Ok(Data::NotificationWrite(notification_data::write(
            db,
            mutation,
        )));
    }
    if let Request::UpsertTaskRecord { mutation } = request {
        return Ok(Data::TaskRecord(task_records::write(
            db,
            mutation,
        )));
    }
    if let Request::WriteTaskContextUsage { snapshots } = request {
        return Ok(Data::TaskContextUsage(task_context_usage::write(
            db,
            &snapshots,
        )));
    }
    if let Request::ExecutionFailures { task_id } = request {
        return execution_failures::list(db, &task_id).map(Data::ExecutionFailures);
    }
    if let Request::DismissExecutionFailure { task_id, id, at } = request {
        return Ok(Data::DismissExecutionFailure(execution_failures::dismiss(
            db,
            &task_id,
            &id,
            at,
        )));
    }
    if let Request::WriteExecutionFailures { request } = request {
        return execution_failures::write(db, request)
            .map(Data::Json);
    }
    if let Request::Batch1Write { request } = request {
        return batch1_writes::run(db, request).map(Data::Json);
    }
    if let Request::Batch2Write { request } = request {
        return batch2_writes::run(db, request).map(Data::Json);
    }
    if let Request::Batch3Write { request } = request {
        return batch3_writes::run(db, request).map(Data::Json);
    }
    if let Request::Batch4aWrite { request } = request {
        return batch4a_writes::run(db, request).map(Data::Json);
    }
    if let Request::Batch4bWrite { request } = request {
        return batch4b_writes::run(db, request).map(Data::Json);
    }
    if let Request::WriteWorkspaceLabel { mutation } = request {
        return Ok(Data::WorkspaceLabel(workspace_labels::write(
            db,
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
            db,
            retention_ms,
        )));
    }
    if let Request::TaskTrashPurgeSupported = request {
        return Ok(Data::Json(true.into()));
    }
    if let Request::PurgeTrashedTask { purge } = request {
        return Ok(Data::TrashPurge(task_trash::purge(
            db,
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
            db,
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
            db,
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
        return cron_write::write(db, mutation)
            .map(|saved| Data::Json(saved.into()));
    }
    if let Request::WriteCronPlan { mutation } = request {
        return cron_plan::write(db, mutation)
            .map(|saved| Data::Json(saved.into()));
    }
    if let Request::SaveScopedNote { scope, id, save } = request {
        return scoped_notes::save(db, scope, &id, save)
            .map(Data::Json);
    }
    if let Request::WriteLibraryNote { change, updated_at } = request {
        return library_note_changes::write(db, change, updated_at)
            .map(Data::Json);
    }
    if let Request::SaveLibraryText { save } = request {
        return library_text_save::write(db, save).map(Data::Json);
    }
    if let Request::WriteTaskBoardAction { input } = request {
        return task_board::write_action(db, input)
            .map(|()| Data::Json(true.into()));
    }
    if let Request::AcknowledgeTaskDone { task_id, at } = request {
        return task_metadata::acknowledge(db, &task_id, at)
            .map(|saved| Data::Json(saved.into()));
    }
    if let Request::SetTaskDueDate {
        task_id,
        due_at,
        next_local_day,
    } = request
    {
        let result = task_metadata::set_due_date(
            db,
            &task_id,
            due_at,
            next_local_day,
        )?;
        return Ok(Data::Json(serde_json::to_value(result)?));
    }
    if let Request::EditTaskSidebar { task_id, edit } = request {
        let result =
            task_metadata::edit_sidebar(db, &task_id, edit)?;
        return Ok(Data::Json(serde_json::to_value(result)?));
    }
    if let Request::WriteWorkbench {
        operation_id,
        mutation,
    } = request
    {
        return workbench_write::write(db, &operation_id, mutation)
            .and_then(|status| Ok(Data::Json(serde_json::to_value(status)?)));
    }
    if let Request::WriteProject {
        operation_id,
        mutation,
    } = request
    {
        return project_write::write(db, &operation_id, mutation)
            .and_then(|status| Ok(Data::Json(serde_json::to_value(status)?)));
    }
    if let Request::InstantiateBlueprint {
        operation_id,
        instance,
    } = request
    {
        return blueprint_instance::write(
            db,
            &operation_id,
            instance,
        )
        .and_then(|status| Ok(Data::Json(serde_json::to_value(status)?)));
    }
    if let Request::PublishLibraryIndex { publication } = request {
        return library_index::publish(db, publication)
            .map(Data::LibraryIndex);
    }
    if let Request::PublishLibraryDocument { publication } = request {
        return library_index::publish_document(db, publication)
            .map(Data::LibraryIndex);
    }
    if let Request::UsageReport { coverage, report } = request {
        return usage::read(db, coverage, report).map(Data::Json);
    }
    if let Request::UsageHistory { job } = request {
        return usage_history::run(db, job).map(Data::Json);
    }
    if let Request::CaptureMemory { capture } = request {
        return memory_capture::run(db, capture)
            .map(|saved| Data::Json(saved.into()));
    }
    if let Request::CompactSnapshots { limit } = request {
        return snapshots::compact(db, limit).map(|migrated| Data::Json(migrated.into()));
    }
    if let Request::MutateSnapshot {
        write_id,
        mutation,
    } = request
    {
        return snapshots::mutate(db, &write_id, mutation)
            .map(|updated| Data::Json(updated.into()));
    }
    if let Request::WriteDiagnostics {
        writer_id,
        sequence,
        writes,
    } = request
    {
        return diagnostics::write_batch(db, &writer_id, sequence, writes)
            .map(|()| Data::Json(true.into()));
    }
    let snapshot = db.transaction()?;
    let response = match request {
        Request::WorkHostLease { .. } => unreachable!(),
        Request::Snapshots { task_id, limit } => {
            Data::Json(snapshots::read(&snapshot, &task_id, limit)?)
        }
        Request::SnapshotReceipt { write_id } => Data::Json(serde_json::to_value(snapshots::receipt(&snapshot, &write_id)?)?),
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
        Request::TaskRecord { task_id, include_expert_bindings } => Data::Json(serde_json::to_value(
            task_list::read_task(&snapshot, &task_id, include_expert_bindings)?,
        )?),
        Request::ExternalAgentHistoryPage { task_id, after } => {
            Data::Json(serde_json::to_value(external_agent_history_data::read(&snapshot, &task_id, after)?)?)
        }
        Request::ReadLoadoutObservations { task_id, limit } => {
            Data::Json(loadout_observation_data::read(&snapshot, &task_id, limit)?)
        }
        Request::ApplicationDatabaseIdentity => Data::Json(serde_json::to_value(database::read_application_identity(&snapshot)?)?),
        Request::TaskWorkspacePaths => Data::Json(batch2_writes::task_workspace_paths(&snapshot)?),
        Request::PythonProjectBindings { ancestors } => {
            Data::Json(python_project_bindings::read(&snapshot, ancestors)?)
        }
        Request::ArtifactSnapshots { task_ids } => {
            Data::ArtifactSnapshots(artifact_snapshots::read(&snapshot, &task_ids)?)
        }
        Request::ArtifactData { query } => Data::Json(artifact_snapshots::read_data(&snapshot, query)?),
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
        | Request::ReadMemoryExtractionQueue { .. }
        | Request::RetryMemoryExtractionQueue { .. }
        | Request::WriteMemoryTurnExtraction { .. }
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
        | Request::ReadGatewayChannels { .. }
        | Request::ReadGatewayChannelState { .. }
        | Request::ReadDotsDelegationData { .. }
        | Request::ReadDotsReplyData { .. }
        | Request::WriteDotsReplyData { .. }
        | Request::ReadDotsActivityData { .. }
        | Request::ReadDotsDeferredData { .. }
        | Request::WriteDotsDeferredData { .. }
        | Request::ReadDotsFollowupData { .. }
        | Request::WriteDotsFollowupData { .. }
        | Request::ReadDotsForegroundData { .. }
        | Request::WriteDotsForegroundData { .. }
        | Request::ReadDotsProactiveData { .. }
        | Request::WriteDotsProactiveData { .. }
        | Request::ReadDotsFileWatchData { .. }
        | Request::WriteDotsFileWatchData { .. }
        | Request::WriteGatewayChannel { .. }
        | Request::ReadGatewayOutbox { .. }
        | Request::ReadGatewayInbox { .. }
        | Request::ReadGatewayExecutionAuthority { .. }
        | Request::MaterializeGatewayTask { .. }
        | Request::ReadGatewayAssignment { .. }
        | Request::ReadGatewayQueue { .. }
        | Request::GatewayAdmitInbound { .. }
        | Request::GatewayDeliveryControl { .. }
        | Request::ReadGatewayMessages { .. }
        | Request::GatewayMessageWriteSupported
        | Request::AppendGatewayMessage { .. }
        | Request::CodeReviewData { .. }
        | Request::MaterialRetrievalSupported
        | Request::MaterialRetrievalData { .. }
        | Request::TaskTrashRestoreSupported
        | Request::RestoreTrashedTask { .. }
        | Request::ReadBotHistoryPage { .. }
        | Request::ReadBotRegistry { .. }
        | Request::ReadConversationRuntime { .. }
        | Request::ReadGoalContinuation { .. }
        | Request::WriteGoalContinuation { .. }
        | Request::ReadConversationBranchData { .. }
        | Request::CreateConversationGoal { .. }
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
        | Request::ReadNativeHooks { .. }
        | Request::WriteNativeHooks { .. }
        | Request::ReadPathHints { .. }
        | Request::WritePathHints { .. }
        | Request::ReadImprovementPackages { .. }
        | Request::WriteImprovementPackages { .. }
        | Request::ReadImprovementReview { .. }
        | Request::WriteImprovementReview { .. }
        | Request::UpsertWorkspace { .. }
        | Request::DurableTaskProjectionSupported
        | Request::DurableTaskOriginsSupported
        | Request::ReadDurableTaskProjection { .. }
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
        | Request::CorePiHost { .. }
        | Request::PiStorage { .. } => unreachable!(),
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
        Request::UsageSessionFiles => Data::Json(serde_json::json!(crate::sqlite_rows::records(
            &snapshot, "SELECT DISTINCT session_file FROM tasks WHERE session_file IS NOT NULL ORDER BY session_file", [],
        )?)),
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
        | Request::CoreRemoteControl { .. }
        | Request::CoreMaintenanceScheduler { .. } => unreachable!(),
    };
    snapshot.commit()?;
    Ok(response)
}

fn read_recovered_gadget_source(
    db: &mut Connection,
    root: &Path,
    id: &str,
    read: impl FnOnce() -> gadget_files::SourceReply,
) -> Data {
    let mut recover = || -> Result<()> {
        if gadget_source_save::has_pending(root, id)? {
            let tx = db.transaction()?;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
enum ExecutionLane {
    Control,
    History,
    DatabaseWrite,
    ReadPool,
    GadgetIo,
    WorkspaceIo,
    Maintenance,
    Inference,
    InlineFast,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RequestClassification {
    lane: ExecutionLane,
    db_write: bool,
    may_mutate: bool,
    deferred: bool,
}

const fn class(
    lane: ExecutionLane,
    db_write: bool,
    may_mutate: bool,
    deferred: bool,
) -> RequestClassification {
    RequestClassification {
        lane,
        db_write,
        may_mutate,
        deferred,
    }
}

fn classify_request(request: &Request) -> RequestClassification {
    match request {
        Request::HistoryRead { .. } => class(ExecutionLane::History, false, false, false),
        Request::WorkspaceScan { .. }
        | Request::FileBackupList { .. }
        | Request::ScanWorkGraphIntegrity
        | Request::ListTrashedTasks { .. }
        | Request::DotsFileRevision { .. }
        | Request::ScanPluginCatalog { .. }
        | Request::ReadPluginConfig { .. } => class(ExecutionLane::WorkspaceIo, false, false, true),
        Request::RestoreFileBackup { .. }
        | Request::SubagentSettings { .. }
        | Request::ReplacePluginConfig { .. }
        | Request::InstallConnector { .. }
        | Request::RecoverConnectorInstalls { .. }
        | Request::MaintainConnectorStorage { .. }
        | Request::ImportConnectorMarket { .. }
        | Request::MutateConnectorMarket { .. } => class(ExecutionLane::WorkspaceIo, false, true, true),
        Request::CleanupArtifactFiles { .. }
        | Request::DeleteLibrary { .. }
        | Request::DrainLibraryCleanup { .. }
        | Request::ExportLibraryBackup { .. }
        | Request::PrepareLibraryRestore { .. }
        | Request::DiscardLibraryRestore { .. }
        | Request::RestoreLibraryBackup { .. }
        | Request::RecoverLibraryRestores { .. }
        | Request::DeleteProject { .. }
        | Request::PromoteProjectEventToLibrary { .. } => {
            class(ExecutionLane::Maintenance, false, true, true)
        }
        Request::SemanticInference { .. }
        | Request::StageEmbedding { .. }
        | Request::SemanticModelProbe { .. } => class(ExecutionLane::Inference, false, false, true),
        Request::CoreExecution { action, .. } => {
            if matches!(action, business_protocol::ExecutionRequest::ExecutorProgress { ephemeral: true, .. }) {
                class(ExecutionLane::InlineFast, false, false, false)
            } else if business_protocol::execution_is_read_only(action) {
                class(ExecutionLane::ReadPool, false, false, true)
            } else {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            }
        }
        Request::CoreWorkScheduler { command, .. } => {
            if !command.is_read_only() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::CoreCronScheduler { command, .. } => {
            if !command.is_read_only() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::CoreDotsScheduler { command, .. } => {
            if !command.is_read_only() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::CoreGatewayScheduler { command, .. } => {
            if !command.is_read_only() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::CoreRemoteControl { command, .. } => {
            if !command.is_read_only() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::CorePiHost { command, .. } => {
            if !command.is_read_only() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::PiStorage { payload } => {
            if !payload.action.is_read_only() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::CoreMaintenanceScheduler { command, .. } => {
            if !command.is_read_only() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::CoreGadgetHost { command } => {
            if !command.is_read_only() {
                class(ExecutionLane::InlineFast, false, true, false)
            } else {
                class(ExecutionLane::InlineFast, false, false, false)
            }
        }
        Request::ProjectPins { request } => {
            if !request.is_read() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::ProjectPosts { request } => {
            if !request.is_read() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::ProjectEventData { request } => {
            if !request.is_read() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::AnswerRoutingData { request } => {
            if !request.is_read() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::MaterialRetrievalData { request } => {
            if !request.is_read() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::SoulProfile { request } => {
            if !request.is_read() {
                class(ExecutionLane::DatabaseWrite, true, true, true)
            } else {
                class(ExecutionLane::ReadPool, false, false, true)
            }
        }
        Request::GadgetState { request } => {
            let mutates = matches!(
                request,
                gadget_state::Request::Access {
                    action: gadget_state::Action::Set { .. } | gadget_state::Action::Delete { .. },
                    ..
                }
            );
            class(ExecutionLane::GadgetIo, false, mutates, true)
        }
        Request::LibraryText { .. } => {
            class(ExecutionLane::InlineFast, false, true, false)
        }
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
        | Request::ExportGadgetFiles { .. }
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
        | Request::WriteMemoryTurnExtraction { .. }
        | Request::RetryMemoryExtractionQueue { .. }
        | Request::AppendGatewayMessage { .. }
        | Request::WriteGatewayChannel { .. }
        | Request::WriteDotsReplyData { .. }
        | Request::WriteDotsDeferredData { .. }
        | Request::WriteDotsFollowupData { .. }
        | Request::WriteDotsForegroundData { .. }
        | Request::WriteDotsProactiveData { .. }
        | Request::WriteDotsFileWatchData { .. }
        | Request::GatewayAdmitInbound { .. }
        | Request::GatewayDeliveryControl { .. }
        | Request::RestoreTrashedTask { .. }
        | Request::MarkWorkCardRead { .. }
        | Request::WriteWorkGraph { .. }
        | Request::WriteDurableTaskProjection { .. }
        | Request::WriteDurableWorkspaceMove { .. }
        | Request::WriteTaskExpertBinding { .. }
        | Request::WriteMemoryOrganizationProgress { .. }
        | Request::ApplyWorkGraphRepair { .. }
        | Request::WriteNotification { .. }
        | Request::WriteNativeHooks { .. }
        | Request::WritePathHints { .. }
        | Request::WriteImprovementPackages { .. }
        | Request::WriteImprovementReview { .. }
        | Request::CreateConversationGoal { .. }
        | Request::WriteGoalContinuation { .. }
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
        | Request::MaterializeGatewayTask { .. }
        | Request::InstantiateBlueprint { .. }
        | Request::PublishLibraryIndex { .. }
        | Request::PublishLibraryDocument { .. }
        | Request::UsageHistory { .. }
        | Request::CaptureMemory { .. }
        | Request::CompactSnapshots { .. }
        | Request::MutateSnapshot { .. }
        | Request::WriteDiagnostics { .. } => class(ExecutionLane::DatabaseWrite, true, true, true),
        Request::Snapshots { .. }
        | Request::SnapshotReceipt { .. }
        | Request::Diagnostics { .. }
        | Request::TaskList { .. }
        | Request::TaskRecord { .. }
        | Request::ExternalAgentHistoryPage { .. }
        | Request::ReadLoadoutObservations { .. }
        | Request::ApplicationDatabaseIdentity
        | Request::TaskWorkspacePaths
        | Request::PythonProjectBindings { .. }
        | Request::WorkspaceData { .. }
        | Request::WorkspaceBindingSnapshot { .. }
        | Request::MemoryTurnData { .. }
        | Request::ReadMemoryExtractionQueue { .. }
        | Request::MemoryRecordsData { .. }
        | Request::ReadBotHistoryPage { .. }
        | Request::ReadBotRegistry { .. }
        | Request::ReadConversationRuntime { .. }
        | Request::ReadGoalContinuation { .. }
        | Request::ReadConversationBranchData { .. }
        | Request::ReadWorkQueue { .. }
        | Request::WorkspaceSharedData { .. }
        | Request::ReadWorkGraph { .. }
        | Request::NotificationData { .. }
        | Request::ReadNativeHooks { .. }
        | Request::ReadPathHints { .. }
        | Request::ReadImprovementPackages { .. }
        | Request::ReadImprovementReview { .. }
        | Request::ReadDurableTaskProjection { .. }
        | Request::ReadTaskExpertBinding { .. }
        | Request::MemoryOrganizationLatest
        | Request::ExecutionFailures { .. }
        | Request::BranchTitle { .. }
        | Request::ArchivedTaskCandidates { .. }
        | Request::DueTrashedTasks { .. }
        | Request::CodeReviewData { .. }
        | Request::ReadGatewayChannels { .. }
        | Request::ReadGatewayChannelState { .. }
        | Request::ReadDotsDelegationData { .. }
        | Request::ReadDotsReplyData { .. }
        | Request::ReadDotsActivityData { .. }
        | Request::ReadDotsDeferredData { .. }
        | Request::ReadDotsFollowupData { .. }
        | Request::ReadDotsForegroundData { .. }
        | Request::ReadDotsProactiveData { .. }
        | Request::ReadDotsFileWatchData { .. }
        | Request::ReadGatewayOutbox { .. }
        | Request::ReadGatewayInbox { .. }
        | Request::ReadGatewayExecutionAuthority { .. }
        | Request::ReadGatewayAssignment { .. }
        | Request::ReadGatewayQueue { .. }
        | Request::ReadGatewayMessages { .. }
        | Request::TaskBoard { .. }
        | Request::ArtifactSnapshots { .. }
        | Request::ArtifactData { .. }
        | Request::WorkspaceFilePreview { .. }
        | Request::LibraryMetadata { .. }
        | Request::ReadScopedNote { .. }
        | Request::ProjectMetadata { .. }
        | Request::CronData { .. }
        | Request::WorkbenchData { .. }
        | Request::CaptureBlueprintWorkspace { .. }
        | Request::PluginCatalog { .. }
        | Request::Semantic { .. }
        | Request::MemoryLexical { .. }
        | Request::MemoryLexicalScores { .. }
        | Request::MemoryBaselines { .. }
        | Request::UsageReport { .. }
        | Request::UsageCsv { .. }
        | Request::UsageSessionFiles
        | Request::CoreEventsSnapshot { .. }
        | Request::CoreEventsReplay { .. } => class(ExecutionLane::ReadPool, false, false, true),
        Request::HistoryLaneSupported
        | Request::WorkspaceScanSupported
        | Request::FileBackupListSupported
        | Request::FileBackupRestoreSupported
        | Request::SubagentSettingsSupported
        | Request::MaterialRetrievalSupported
        | Request::TaskTrashRestoreSupported
        | Request::GatewayMessageWriteSupported
        | Request::DotsFileRevisionSupported
        | Request::DotsFileWatchSupported
        | Request::StartDotsFileWatch { .. }
        | Request::StopDotsFileWatch { .. }
        | Request::WorkspaceMoveSupported
        | Request::SidebarArchiveSupported
        | Request::WorkspaceLabelsSupported
        | Request::WorkspacePersistenceSupported
        | Request::WorkspaceDeleteSupported
        | Request::WorkspaceBindingSupported
        | Request::MemoryRecordWriteSupported
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
        | Request::DurableWorkspaceMoveSupported
        | Request::TaskExpertBindingSupported
        | Request::SoulProfileSupported
        | Request::MemoryOrganizationProgressSupported
        | Request::TaskRecordsSupported
        | Request::TaskContextUsageSupported
        | Request::ExecutionFailuresSupported
        | Request::TaskTrashSupported
        | Request::TaskTrashPurgeSupported
        | Request::ManagedArtifactFilesSupported
        | Request::ReadManagedArtifact { .. }
        | Request::NextManagedArtifact { .. }
        | Request::CloseManagedArtifact { .. }
        | Request::WorkspaceFilePreviewSupported
        | Request::WorkspaceArtifactStreamSupported
        | Request::OpenWorkspaceArtifact { .. }
        | Request::ManagedArtifactImageStreamSupported
        | Request::OpenManagedArtifactImage { .. }
        | Request::RemoteArtifactImageSupported
        | Request::OpenRemoteArtifactImage { .. }
        | Request::ArtifactCleanupSupported
        | Request::GadgetFileMutationsSupported
        | Request::ManagedStorageSupported
        | Request::PluginCatalogScanSupported
        | Request::PluginConfigSupported
        | Request::ConnectorInstallationSupported
        | Request::ConnectorMaintenanceSupported
        | Request::ConnectorMarketImportSupported
        | Request::ConnectorMarketMutationSupported
        | Request::Durable { .. }
        | Request::NativeInferenceSupported
        | Request::NativeEmbeddingIndexSupported
        | Request::NativeEmbeddingPlannerSupported
        | Request::NativeModelProbeSupported
        | Request::EmbeddingIndex { .. }
        | Request::DiscardEmbeddings { .. } => {
            class(ExecutionLane::InlineFast, false, false, false)
        }
    }
}

fn database_write(request: &Request) -> bool {
    classify_request(request).db_write
}

fn read_pool_op(request: &Request) -> bool {
    classify_request(request).lane == ExecutionLane::ReadPool
}

fn gadget_io_op(request: &Request) -> bool {
    classify_request(request).lane == ExecutionLane::GadgetIo
}

fn deferred(request: &Request) -> bool {
    classify_request(request).deferred
}

fn request_may_mutate(request: &Request) -> bool {
    classify_request(request).may_mutate
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

fn resource_plan_for_request(request: &Request) -> Vec<resource_gate::ResourceRequirement> {
    use resource_gate::{ResourceKey, ResourceRequirement};
    const GOAL_CONTINUATION_DOMAINS: [&str; 6] = ["batch1", "batch4b", "executor_presence", "pi_host", "tasks", "workspaces"];
    let mut plan = vec![
        ResourceRequirement::shared(ResourceKey::DbLifecycle),
        ResourceRequirement::shared(ResourceKey::CommitShare),
    ];
    match request {
        Request::CoreWorkScheduler { .. } | Request::WorkHostLease { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::PublisherOrder));
            plan.push(ResourceRequirement::exclusive(ResourceKey::ExecutionAdmission));
        }
        Request::CreateConversationGoal { operation_id, draft } => {
            plan.push(ResourceRequirement::shared(ResourceKey::ExecutionAdmission));
            for domain in ["tasks", "batch4b"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), draft.task_id.clone())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity(
                format!("conversation-goal:{}", draft.user_id), operation_id.clone(),
            )));
        }
        Request::WriteGoalContinuation { command, .. } => {
            for domain in GOAL_CONTINUATION_DOMAINS {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), command.task_id().into())));
            if !command.store_id().is_empty() {
                plan.push(ResourceRequirement::exclusive(ResourceKey::PiStore(command.store_id().into())));
            }
            if let Some(work_id) = command.work_id() {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("work".into(), work_id.into())));
            }
        }
        Request::CoreMaintenanceScheduler { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::PublisherOrder));
            plan.push(ResourceRequirement::exclusive(ResourceKey::MaintenanceCycle(
                "maintenance_scheduler".into(),
            )));
        }
        Request::PiStorage { payload } => {
            if !payload.action.is_read_only() && !payload.action.store_id().is_empty() {
                plan.push(ResourceRequirement::exclusive(ResourceKey::PiStore(
                    payload.action.store_id().to_string(),
                )));
            }
            if let pi_storage::Action::Commit { batches, .. } = &payload.action {
                for (task_id, work_id) in batches.iter().flatten().filter_map(goal_continuation::placement_resources) {
                    plan.extend(GOAL_CONTINUATION_DOMAINS.map(|domain|
                        ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into()))));
                    plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), task_id.into())));
                    plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("work".into(), work_id.into())));
                }
                if batches.iter().flatten().any(pi_storage::is_dots_cron_input) {
                    for domain in ["cron", "batch4a", "batch2", "tasks", "workspaces", "projects"] {
                        plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
                    }
                    plan.push(ResourceRequirement::shared(ResourceKey::Entity("task".into(), DOTS_TASK_ID.into())));
                }
                for task in batches.iter().flatten().filter_map(pi_storage::goal_user_input_task) {
                    plan.extend(["batch4b", "tasks", "workspaces"].map(|domain|
                        ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into()))));
                    plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), task.into())));
                }
                for (event_key, record) in batches.iter().flatten().filter_map(pi_storage::dots_outbox_entry) {
                    plan.extend(["batch2", "batch4a", "tasks", "workspaces", "work_graph"].map(|domain|
                        ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into()))));
                    if let Some(task) = record["data"]["taskId"].as_str() {
                        plan.push(ResourceRequirement::shared(ResourceKey::Entity("task".into(), task.into())));
                    }
                    plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("dots_reply".into(), event_key.into())));
                }
            }
        }
        Request::CoreCommand { .. }
        | Request::CoreExecution { .. }
        | Request::CoreEventsRetention { .. }
        | Request::AssistantLifecycle { .. }
        | Request::CoreExecutorPresence { .. }
        | Request::CoreCronScheduler { .. }
        | Request::CoreDotsScheduler { .. }
        | Request::CoreGatewayScheduler { .. }
        | Request::CoreRemoteControl { .. }
        | Request::CorePiHost { .. } => {
            let domain = match request {
                Request::CoreCommand { .. } => "core_command",
                Request::CoreExecution { .. } => "core_execution",
                Request::CoreEventsRetention { .. } => "core_events",
                Request::AssistantLifecycle { .. } => "assistant_lifecycle",
                Request::CoreExecutorPresence { .. } => "executor_presence",
                Request::CoreCronScheduler { .. } => "cron",
                Request::CoreDotsScheduler { .. } => "dots_scheduler",
                Request::CoreGatewayScheduler { .. } => "gateway_scheduler",
                Request::CoreRemoteControl { command: remote_control::Command::PublishNotification { .. }, .. } => "notifications",
                Request::CoreRemoteControl { .. } => "remote_control",
                Request::CorePiHost { .. } => "pi_host",
                _ => "core",
            };
            plan.push(ResourceRequirement::exclusive(ResourceKey::PublisherOrder));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                domain.into(),
            )));
            if matches!(request, Request::CorePiHost { command: pi_host_supervisor::Command::Bootstrap { .. }, .. }) {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "batch4b".into())));
            }
            if matches!(request, Request::CoreGatewayScheduler { command: gateway_scheduler::Command::Start { .. }, .. }) {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "gateway_delivery_recovery".into())));
            }
            if let Request::CoreExecution { action: business_protocol::ExecutionRequest::Submit { task_id, dots_recovery: Some(_), .. }, .. } = request {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "cron".into())));
                plan.extend(["batch2", "batch4a", "tasks", "workspaces", "work_graph"].map(|name|
                    ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), name.into()))));
                plan.push(ResourceRequirement::shared(ResourceKey::Entity("task".into(), task_id.clone())));
            }
            if matches!(request, Request::CoreExecution { action: business_protocol::ExecutionRequest::ExecutorSettled { .. }, .. }
                | Request::CoreExecutorPresence { .. }) {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "cron".into())));
            }
            if let Request::CoreGatewayScheduler { command: gateway_scheduler::Command::TrackOutbound { delivery_id, .. }
                | gateway_scheduler::Command::SettleUnknown { delivery_id, .. }, .. } = request {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "batch4a".into())));
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("gateway_delivery".into(), delivery_id.clone())));
            }
        }
        Request::AcknowledgeTaskDone { task_id, .. }
        | Request::SetTaskDueDate { task_id, .. }
        | Request::EditTaskSidebar { task_id, .. }
        | Request::DismissExecutionFailure { task_id, .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity(
                "task".into(),
                task_id.clone(),
            )));
        }
        Request::WriteArtifact { task_id, .. } | Request::WriteManagedArtifact { task_id, .. } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), task_id.clone())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity(
                "artifact_task".into(),
                task_id.clone(),
            )));
            if matches!(request, Request::WriteManagedArtifact { .. }) {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "artifacts".into())));
            }
            if let Request::WriteManagedArtifact { content: artifact_content::Content::Gadget { id, .. }, .. } = request {
                plan.extend(workbench_write::gadget_resources(id));
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "workspaces".into())));
            }
        }
        Request::ReadGadgetSource { id, .. }
        | Request::ReadGadgetManifest { id, .. }
        | Request::CaptureBlueprintGadget { id, .. }
        | Request::RemoveGadgetFiles { id, .. } => {
            plan.extend(workbench_write::gadget_resources(id));
        }
        Request::UpsertTaskRecord { mutation } => {
            plan.extend(["tasks", "projects"].map(|domain|
                ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into()))));
            let workspaces = ResourceKey::Namespace("domain".into(), "workspaces".into());
            plan.push(if mutation.may_create_workspace() { ResourceRequirement::exclusive(workspaces) }
                else { ResourceRequirement::shared(workspaces) });
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), mutation.task_id().into())));
        }
        Request::WriteTaskBoardAction { input } => {
            for domain in ["tasks", "workspaces"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), input.id.clone())));
            if input.id.starts_with("bot-request:") {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "batch4b".into())));
            }
        }
        Request::WriteDurableTaskProjection { request } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), request.task_id().into())));
            if matches!(request, durable_task_projection::Request::BindWorkspaceCwd { .. }) {
                for domain in ["workspaces", "batch2"] {
                    plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
                }
            }
            for directory in request.directories().into_iter().flatten() {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("durable_directory".into(), directory.into())));
            }
        }
        Request::WriteTaskContextUsage { .. }
        | Request::WriteTaskExpertBinding { .. }
        | Request::RestoreTrashedTask { .. }
        | Request::AlignTrashRetention { .. }
        | Request::WriteExecutionFailures { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "tasks".into(),
            )));
        }
        Request::PurgeTrashedTask { purge } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "snapshots".into())));
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "conversation_interactions".into())));
            if gateway_execution_authority::gateway_task_id(purge.task_id()) {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "gateway_admission".into())));
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "batch4a".into())));
            }
        }
        Request::WriteMemoryRecord { .. }
        | Request::CaptureMemory { .. }
        | Request::WriteMemoryOrganizationProgress { .. }
        | Request::PublishEmbeddings { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "memory".into(),
            )));
        }
        Request::PublishLibraryIndex { .. }
        | Request::PublishLibraryDocument { .. }
        | Request::WriteLibraryNote { .. }
        | Request::SaveLibraryText { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "library".into(),
            )));
        }
        Request::WriteProject { .. }
        | Request::ProjectPins { .. }
        | Request::ProjectPosts { .. }
        | Request::ProjectEventData { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "projects".into(),
            )));
        }
        Request::UpsertWorkspace { .. }
        | Request::DeleteWorkspace { .. }
        | Request::MoveWorkspaceTree { .. }
        | Request::SetSidebarArchive { .. }
        | Request::WriteWorkspaceLabel { .. }
        | Request::WriteWorkspaceBinding { .. }
        | Request::WriteDurableWorkspaceMove { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "workspaces".into(),
            )));
        }
        Request::WriteWorkGraph { .. }
        | Request::ApplyWorkGraphRepair { .. }
        | Request::MarkWorkCardRead { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "work_graph".into(),
            )));
        }
        Request::WriteCronPlan { mutation } => {
            plan.extend(["tasks", "projects", "workspaces"].map(|domain|
                ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into()))));
            plan.extend(mutation.guarded_tasks().map(|id| ResourceRequirement::shared(ResourceKey::Entity("task".into(), id.clone()))));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "cron".into())));
        }
        Request::WriteCronRun { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "cron".into(),
            )));
        }
        Request::WriteGatewayChannel { draft, .. } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "batch4a".into())));
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "gateway_scheduler".into())));
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "gateway_tick".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("gateway_channel".into(), draft.channel.id.clone())));
        }
        Request::WriteDotsReplyData { command } => {
            plan.extend(["batch2", "batch4a", "tasks", "workspaces", "work_graph"].map(|domain|
                ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into()))));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("dots_reply".into(), command.event_key().into())));
        }
        Request::WriteDotsForegroundData { command } => {
            for domain in ["batch4a", "answer_routing"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("dots_foreground".into(), command.input_id().into())));
        }
        Request::WriteDotsDeferredData { command } => {
            for domain in ["batch4a", "tasks", "workspaces"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), command.task_id().into())));
        }
        Request::WriteDotsFollowupData { command } => {
            let batch = ResourceKey::Namespace("domain".into(), "batch4a".into());
            plan.push(if command.links_delegation() { ResourceRequirement::exclusive(batch) } else { ResourceRequirement::shared(batch) });
            for domain in ["tasks", "workspaces"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), command.task_id().into())));
            if command.checks_dots_schedule() {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "cron".into())));
            }
        }
        Request::WriteDotsProactiveData { .. } => {
            for domain in ["batch4a", "tasks"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::shared(ResourceKey::Entity("task".into(), DOTS_TASK_ID.into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "dots_proactive".into())));
        }
        Request::WriteDotsFileWatchData { command } => {
            for domain in ["batch4a", "tasks", "workspaces"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), command.task_id().into())));
        }
        Request::GatewayDeliveryControl { delivery_id, .. } => {
            for domain in ["batch4a", "gateway_delivery_recovery"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("gateway_delivery".into(), delivery_id.clone())));
        }
        Request::GatewayAdmitInbound { .. } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "batch4a".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "gateway_admission".into())));
        }
        Request::MaterializeGatewayTask { command } => {
            for domain in ["gateway_admission", "workspaces"] {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            for domain in ["batch4a", "batch4b", "tasks", "work_graph", "gateway_scheduler", "gateway_tick"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::shared(ResourceKey::Entity("gateway_channel".into(), command.channel_id().into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), command.task_id().into())));
        }
        Request::AppendGatewayMessage { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "gateway".into(),
            )));
        }
        Request::CompactSnapshots { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "snapshots".into(),
            )));
        }
        Request::MutateSnapshot { write_id, mutation } => {
            let scope = ResourceKey::Namespace("domain".into(), "snapshots".into());
            if let Some(task_id) = mutation.task_id() {
                plan.push(ResourceRequirement::shared(scope));
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), task_id.into())));
            } else {
                plan.push(ResourceRequirement::exclusive(scope));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("snapshot_write".into(), write_id.clone())));
            if let Some((id, execution_id)) = mutation.insertion_keys() {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("runtime_snapshot".into(), id.into())));
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("snapshot_execution".into(), execution_id.into())));
            }
        }
        Request::WriteDiagnostics { writer_id, writes, .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("diagnostic_writer".into(), writer_id.clone())));
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            for write in writes {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("diagnostic_record".into(), write.record_key())));
                plan.extend(write.task_ids().map(|id| ResourceRequirement::shared(ResourceKey::Entity("task".into(), id.into()))));
            }
        }
        Request::UsageHistory { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "usage".into(),
            )));
        }
        Request::WriteNotification { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "notifications".into(),
            )));
        }
        Request::WriteNativeHooks { mutation } => {
            plan.push(ResourceRequirement::exclusive(mutation.resource()));
        }
        Request::WritePathHints { mutation } => {
            plan.push(ResourceRequirement::exclusive(mutation.resource()));
        }
        Request::WriteImprovementPackages { mutation } => {
            plan.extend(mutation.resources().into_iter().map(ResourceRequirement::exclusive));
        }
        Request::WriteImprovementReview { .. } => {
            plan.push(ResourceRequirement::exclusive(improvement_review::resource()));
        }
        Request::AnswerRoutingData { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "answer_routing".into(),
            )));
        }
        Request::MaterialRetrievalData { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "material_retrieval".into(),
            )));
        }
        Request::SoulProfile { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "soul_profile".into(),
            )));
        }
        Request::SaveScopedNote { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "scoped_notes".into(),
            )));
        }
        Request::WriteWorkbench { operation_id, mutation } => {
            plan.extend(mutation.resources(operation_id));
        }
        Request::InstantiateBlueprint { operation_id, instance } => {
            plan.extend(instance.resources(operation_id));
        }
        Request::CreateGadgetFiles { create } => plan.extend(create.resources()),
        Request::SaveGadgetSource { save } => plan.extend(save.resources()),
        Request::ExportGadgetFiles { export } => plan.extend(export.resources()),
        Request::ReconcileBlueprintStorage { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "blueprint-storage".into(),
            )));
        }
        Request::ReconcileGadgetStorage { .. } => {
            plan.push(ResourceRequirement::exclusive(workbench_write::gadget_namespace()));
        }
        Request::Batch1Write { request: batch1_writes::Request::SavePythonBinding { dir_key, .. }
            | batch1_writes::Request::RemovePythonBinding { dir_key }, } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity(
                "python-project-binding".into(), dir_key.clone(),
            )));
        }
        Request::Batch1Write { request: batch1_writes::Request::InteractionInsert { task_id, id, .. }
          | batch1_writes::Request::InteractionSettle { task_id, id, .. } } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "conversation_interactions".into())));
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), task_id.clone())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("conversation_interaction".into(), id.clone())));
            if let Request::Batch1Write { request: batch1_writes::Request::InteractionInsert { execution_id, .. } } = request {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("interaction_execution".into(), execution_id.clone())));
            }
        }
        Request::Batch1Write { request:
            batch1_writes::Request::InteractionDeleteFrom { task_id, .. }
            | batch1_writes::Request::InteractionCancelExecution { task_id, .. }
        } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "conversation_interactions".into())));
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), task_id.clone())));
        }
        Request::Batch1Write { request: batch1_writes::Request::InteractionExpireAllPending { .. } } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "conversation_interactions".into())));
        }
        Request::Batch1Write { request:
            batch1_writes::Request::LoadoutRecordTurn { task_id, .. }
            | batch1_writes::Request::LoadoutMarkSkillUsed { task_id, .. }
            | batch1_writes::Request::LoadoutMarkOutcome { task_id, .. }
            | batch1_writes::Request::LoadoutAbortPending { task_id, .. }
            | batch1_writes::Request::LoadoutClear { task_id: Some(task_id) }
        } => {
            for domain in ["tasks", "batch1", "loadout_observations"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), task_id.clone())));
        }
        Request::Batch1Write { request: batch1_writes::Request::LoadoutClear { task_id: None } } => {
            for domain in ["tasks", "loadout_observations"] {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), domain.into())));
            }
        }
        Request::Batch1Write { request:
            batch1_writes::Request::ExecutionAttemptInsert { task_id, .. }
            | batch1_writes::Request::ExecutionAttemptUpdate { task_id, .. }
            | batch1_writes::Request::ExecutionAttemptSettleDurable { task_id, .. }
        } => {
            for domain in ["tasks", "batch1", "execution_attempts"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), task_id.clone())));
        }
        Request::Batch1Write { request: batch1_writes::Request::ExecutionAttemptRecoverInterrupted { .. } } => {
            for domain in ["tasks", "execution_attempts"] {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), domain.into())));
            }
        }
        Request::Batch1Write { request:
            batch1_writes::Request::GoalActivityAdmit { task_id, .. }
            | batch1_writes::Request::GoalActivitySettle { task_id, .. }
            | batch1_writes::Request::GoalActivityRecordTool { task_id, .. }
            | batch1_writes::Request::GoalActivityRecordSkill { task_id, .. }
        } => {
            for domain in ["tasks", "batch1", "batch4b", "work_graph"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), task_id.clone())));
        }
        Request::Batch1Write { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "batch1".into(),
            )));
        }
        Request::Batch2Write { request: batch2_writes::Request::OpenDots { .. } } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), DOTS_TASK_ID.into())));
        }
        Request::Batch2Write { request: batch2_writes::Request::DeleteTask { id } } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "snapshots".into())));
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "conversation_interactions".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), id.clone())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "memory".into())));
            if gateway_execution_authority::gateway_task_id(id) {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "gateway_admission".into())));
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "batch4a".into())));
            }
        }
        Request::Batch2Write { request: batch2_writes::Request::TaskBoardNote { id, .. } } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), id.clone())));
        }
        Request::Batch2Write { request: batch2_writes::Request::CodeReviewUpsert { task_id, .. } } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.push(ResourceRequirement::shared(ResourceKey::Entity("task".into(), task_id.clone())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "batch2".into())));
        }
        Request::Batch2Write { request: batch2_writes::Request::RebindLegacyTaskWorkspacePaths { cwd_updates, trash_updates } } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
            plan.extend(batch2_writes::rebind_task_ids(cwd_updates, trash_updates).map(|id|
                ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), id.into()))));
        }
        Request::Batch2Write { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "batch2".into(),
            )));
        }
        Request::Batch3Write { request } => {
            if let Some(task_ids) = request.artifact_tasks() {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "tasks".into())));
                for id in task_ids {
                    for domain in ["task", "artifact_task"] {
                        plan.push(ResourceRequirement::exclusive(ResourceKey::Entity(domain.into(), id.into())));
                    }
                }
            } else {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "batch3".into())));
            }
        }
        Request::WriteMemoryTurnExtraction { command, .. } => {
            plan.push(ResourceRequirement::shared(ResourceKey::ExecutionAdmission));
            for domain in ["memory", "tasks", "workspaces", "projects", "batch2", "batch3", "batch4a",
                "batch4b", "work_graph", "gateway_admission", "general_write"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), command.task_id().into())));
            for (scope_type, scope_id) in command.publication_scopes() {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity(
                    format!("memory_extraction_{scope_type}"), scope_id.unwrap_or_default().into(),
                )));
            }
        }
        Request::RetryMemoryExtractionQueue { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "memory".into())));
            for domain in ["tasks", "batch2", "batch3", "workspaces"] {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
            }
        }
        Request::Batch4aWrite { .. } => {
            let domain = match request {
                Request::Batch4aWrite { request: batch4a_writes::Request::CronStartupMigrate
                    | batch4a_writes::Request::CronUpsertJob { .. }
                    | batch4a_writes::Request::CronSetEnabled { .. }
                    | batch4a_writes::Request::CronRemoveJob { .. }
                    | batch4a_writes::Request::CronInsertRun { .. }
                    | batch4a_writes::Request::CronRecoverRuns { .. }
                    | batch4a_writes::Request::CronHoldDotsSchedule { .. }
                    | batch4a_writes::Request::CronSaveDotsProvenance { .. }
                    | batch4a_writes::Request::CronRecordDotsNotice { .. }, .. } => "cron",
                _ => "batch4a",
            };
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), domain.into())));
            if let Request::Batch4aWrite { request: batch4a_writes::Request::DotsDelegationReconcile { task_id, .. }
                | batch4a_writes::Request::DotsDelegationLink { task_id, .. }, .. } = request {
                for domain in ["batch2", "tasks", "workspaces"] {
                    plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), domain.into())));
                }
                plan.push(ResourceRequirement::shared(ResourceKey::Entity("task".into(), task_id.clone())));
            }
            if matches!(request, Request::Batch4aWrite { request:
                batch4a_writes::Request::DotsDelegationLink { source_message_id, .. }
                | batch4a_writes::Request::DotsFollowupGoalAccepted { source_message_id, .. }, ..
            } if cron_scheduler::dots_run_id(source_message_id).is_some()) {
                plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "cron".into())));
            }
            if matches!(request, Request::Batch4aWrite { request: batch4a_writes::Request::GatewayDeliveryOp { op, .. } } if op == "recoverInterrupted") {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "gateway_delivery_recovery".into())));
            }
        }
        Request::Batch4bWrite { request: batch4b_writes::Request::Single(batch4b_writes::BatchOp::Bot(
            batch4b_bot::BotOp::BotUpsert(registration),
        )) } => {
            plan.push(ResourceRequirement::shared(ResourceKey::Namespace("domain".into(), "batch4b".into())));
            plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("bot".into(), registration.bot_id.clone())));
            if registration.primary {
                plan.push(ResourceRequirement::exclusive(ResourceKey::Entity("bot_primary_user".into(), registration.user_id.clone())));
            }
        }
        Request::Batch4bWrite { .. } => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "batch4b".into(),
            )));
        }
        _ => {
            plan.push(ResourceRequirement::exclusive(ResourceKey::Namespace(
                "domain".into(),
                "general_write".into(),
            )));
        }
    }
    plan
}

fn start_database_writer(
    engine: Arc<database::DuckDbEngine>,
    gate: Arc<resource_gate::ResourceGate>,
    outbox: Arc<outbox_publisher::OutboxPublisher>,
    staged: Arc<embedding_index::StagedVectors>,
    executor_tracker: Arc<business_protocol::ExecutorTracker>,
) -> io::Result<writer_admission::DatabaseWriter> {
    let workers = engine.config().write_pool_size;
    writer_admission::DatabaseWriter::spawn(
        gate.clone(),
        workers,
        move || {
            (
                Arc::clone(&engine),
                Arc::clone(&gate),
                Arc::clone(&outbox),
                HashMap::<String, durable::HistorySession>::new(),
                Arc::clone(&staged),
                Arc::clone(&executor_tracker),
            )
        },
        |(engine, gate, outbox, sessions, staged, tracker), id, request, lease| {
            if !request_control::begin(&id) {
                return true;
            }
            let mut side_effects = None;
            let result = (|| -> Result<Data> {
                if let Request::CorePiHost { command, client } = request {
                    let ctx = client.unwrap_or_else(|| {
                        business_protocol::ClientContext::synthetic(
                            &business_protocol::current_core_generation(),
                        )
                    });
                    let mut phase = pi_host_supervisor::PiHostWritePhase::new(
                        engine, lease, id.as_deref(), Duration::from_secs(30),
                    );
                    let fx = pi_host_supervisor::execute_write_in_phase(
                        &mut phase,
                        tracker,
                        &ctx,
                        command,
                    )?;
                    if fx.data["deferredGoals"].as_u64().is_some_and(|count| count > 0) {
                        outbox.wake();
                    }
                    let data = fx.data.clone();
                    side_effects = Some(fx);
                    return Ok(Data::Json(data));
                }
                let _lease = lease;
                let mut pooled = engine.checkout_writer(Duration::from_secs(30))?;
                if let (Some(req_id), Some(ctrl)) = (id.as_deref(), request_control::shared()) {
                    pooled.bind_request(req_id, ctrl.clone());
                }
                read(
                    pooled.conn_mut(),
                    engine,
                    gate,
                    outbox,
                    sessions,
                    staged,
                    tracker,
                    &mut side_effects,
                    request,
                )
            })();
            let ok = result.is_ok();
            if write_reply(&id, result, false).is_err() {
                return false;
            }
            if ok {
                emit_side_effects(side_effects);
            }
            true
        },
    )
}

struct SchedulerTickerGuard {
    stop: Arc<std::sync::atomic::AtomicBool>,
    handles: Vec<thread::JoinHandle<()>>,
}

impl SchedulerTickerGuard {
    fn new() -> Self {
        Self {
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            handles: Vec::new(),
        }
    }

    fn start(
        &mut self,
        name: &str,
        interval_ms: u64,
        mut tick: impl FnMut(&std::sync::atomic::AtomicBool) + Send + 'static,
    ) -> Result<()> {
        use std::sync::atomic::Ordering;
        let stop = Arc::clone(&self.stop);
        self.handles.push(thread::Builder::new().name(name.into()).spawn(move || {
            while !stop.load(Ordering::Acquire) {
                tick(&stop);
                let mut slept = 0;
                while slept < interval_ms && !stop.load(Ordering::Acquire) {
                    let step = (interval_ms - slept).min(50);
                    thread::sleep(Duration::from_millis(step));
                    slept += step;
                }
            }
        })?);
        Ok(())
    }
}

impl Drop for SchedulerTickerGuard {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}

fn acquire_scheduler_phase(
    gate: &resource_gate::ResourceGate,
    stop: &std::sync::atomic::AtomicBool,
    phase: &str,
) -> Option<resource_gate::ResourceLease> {
    use resource_gate::{ResourceKey, ResourceRequirement};
    gate.acquire(
        vec![
            ResourceRequirement::shared(ResourceKey::DbLifecycle),
            ResourceRequirement::shared(ResourceKey::CommitShare),
            ResourceRequirement::exclusive(ResourceKey::PublisherOrder),
            ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), phase.into())),
        ],
        Duration::from_secs(5),
        || stop.load(std::sync::atomic::Ordering::Acquire),
    ).ok()
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
        println!("118");
        return Ok(());
    }
    let db_path = PathBuf::from(argument);
    let worker_lease = core_lease::WorkerLease::from_environment(&db_path)?;
    let pool_cfg = database::DuckDbPoolConfig {
        read_pool_size: configured_read_pool_workers(),
        ..Default::default()
    };
    let (engine, _open_report) = database::DuckDbEngine::open_or_initialize(&db_path, pool_cfg)?;
    {
        let mut init_writer = engine.checkout_writer(Duration::from_secs(10))?;
        db_schema::materialize_seeds_and_repairs(init_writer.conn_mut())?;
    }
    let gate = resource_gate::ResourceGate::new(256);
    let outbox = outbox_publisher::OutboxPublisher::new();
    let control = request_control::Control::open(&db_path)?;
    request_control::install(control.clone());
    let host_control = control.clone();
    let mut database_writer: Option<writer_admission::DatabaseWriter> = None;
    let mut read_pool: Option<WorkerPool<Request>> = None;
    let mut gadget_io_pool: Option<WorkerPool<gadget_state::Request>> = None;
    let mut durable_sessions = HashMap::new();
    let mut inference = None;
    let mut maintenance = None;
    let mut workspace_scans: Option<WorkerPool<WorkspaceJob>> = None;
    let mut dots_file_watches = None;
    let staged = Arc::new(embedding_index::StagedVectors::default());
    let executor_tracker = Arc::new(business_protocol::ExecutorTracker::new());
    let mut index_queues = embedding_index::IndexQueues::default();
    let gadget_state = Arc::new(gadget_state::Store::default());
    let mut artifact_reads = artifact_content::Reads::default();
    if std::env::var_os("MYBUDDY_HISTORY_HANDSHAKE").is_some() {
        let mut output = io::stdout().lock();
        let handshake = serde_json::json!({
            "historyReady": true,
            "parallelReads": engine.config().read_pool_size,
            "parallelWrites": engine.config().write_pool_size,
            "parallelWorkspaceIo": configured_workspace_io_workers(),
        });
        serde_json::to_writer(&mut output, &handshake)?;
        writeln!(output)?;
        output.flush()?;
    }
    // The input thread owns stdin so history reads cannot queue behind the main loop. It
    // forwards the transport id with each request, which is what lets replies be correlated.
    let (requests, input) = history_lane::route_input(Arc::clone(&engine), control)?;
    outbox.subscribe(Arc::new(|events| {
        for event in events {
            let _ = request_control::emit(&serde_json::json!({ "coreEvent": event }));
        }
    }));
    let publisher_worker = outbox.start_worker(Arc::clone(&engine), Arc::clone(&gate),
        business_protocol::current_core_generation())?;
    let scheduler_ticker = if std::env::var_os("MYBUDDY_CORE_SUPERVISED").is_some()
        && std::env::var("MYBUDDY_WORK_AUTO_TICK_MS").ok().as_deref() != Some("0")
    {
        let interval_ms = std::env::var("MYBUDDY_WORK_AUTO_TICK_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(1_000)
            .clamp(50, 30_000);
        let mut ticker = SchedulerTickerGuard::new();
        let pi_engine = Arc::clone(&engine);
        let pi_gate = Arc::clone(&gate);
        let pi_tracker = executor_tracker.clone();
        ticker.start("pi-host-supervision", interval_ms, move |stop| {
            let fx = acquire_scheduler_phase(&pi_gate, stop, "pi_host_tick").and_then(|lease| {
                let mut phase = pi_host_supervisor::PiHostWritePhase::new(
                    &pi_engine, lease, None, Duration::from_secs(5),
                );
                pi_host_supervisor::supervise_tick_in_phase(&mut phase, &pi_tracker)
                    .ok()
                    .flatten()
            });
            emit_side_effects(fx);
        })?;
        let tick_engine = Arc::clone(&engine);
        let tick_gate = Arc::clone(&gate);
        let tick_tracker = executor_tracker.clone();
        ticker.start("work-scheduler-tick", interval_ms, move |stop_flag| {
            let acquire_phase = |phase: &str| acquire_scheduler_phase(&tick_gate, stop_flag, phase);
            let lease_held = acquire_phase("work_lease")
                .and_then(|_lease| {
                    let mut conn = tick_engine.checkout_writer(Duration::from_secs(5)).ok()?;
                    work_scheduler::claim_supervised_core_lease(conn.conn_mut()).ok()
                })
                .unwrap_or(false);
            if lease_held {
                let core_gen = business_protocol::current_core_generation();
                let ctx = business_protocol::ClientContext::synthetic(&core_gen);

                let work_fx = acquire_phase("work_tick").and_then(|_lease| {
                    let mut conn = tick_engine.checkout_writer(Duration::from_secs(5)).ok()?;
                    work_scheduler::execute_write(
                        conn.conn_mut(),
                        &tick_tracker,
                        &ctx,
                        work_scheduler::Command::Tick {
                            owner_id: Some(format!("core:{core_gen}")),
                            now_ms: None,
                            lease_ttl_ms: None,
                        },
                    )
                    .ok()
                });
                if work_fx
                    .as_ref()
                    .is_some_and(|fx| !fx.events.is_empty() || !fx.dispatches.is_empty())
                {
                    emit_side_effects(work_fx);
                }

                if !stop_flag.load(Ordering::Acquire) {
                    let cron_fx = acquire_phase("cron_tick").and_then(|_lease| {
                        let mut conn =
                            tick_engine.checkout_writer(Duration::from_secs(5)).ok()?;
                        cron_scheduler::run_supervised_tick(conn.conn_mut(), &tick_tracker)
                            .ok()
                            .flatten()
                    });
                    emit_side_effects(cron_fx);
                }

                if !stop_flag.load(Ordering::Acquire) {
                    let dots_fx = acquire_phase("dots_tick").and_then(|_lease| {
                        let mut conn =
                            tick_engine.checkout_writer(Duration::from_secs(5)).ok()?;
                        dots_scheduler::run_supervised_tick(conn.conn_mut(), &tick_tracker)
                            .ok()
                            .flatten()
                    });
                    emit_side_effects(dots_fx);
                }

                if !stop_flag.load(Ordering::Acquire) {
                    let gw_fx = acquire_phase("gateway_tick").and_then(|_lease| {
                        let mut conn =
                            tick_engine.checkout_writer(Duration::from_secs(5)).ok()?;
                        gateway_scheduler::run_supervised_tick(
                            conn.conn_mut(),
                            &tick_tracker,
                        )
                        .ok()
                        .flatten()
                    });
                    emit_side_effects(gw_fx);
                }

                if !stop_flag.load(Ordering::Acquire) {
                    let maint_fx = acquire_phase("maintenance_tick").and_then(|_lease| {
                        let mut conn =
                            tick_engine.checkout_writer(Duration::from_secs(5)).ok()?;
                        maintenance_scheduler::run_supervised_tick(
                            conn.conn_mut(),
                            &tick_tracker,
                        )
                        .ok()
                        .flatten()
                    });
                    emit_side_effects(maint_fx);
                }
            }
        })?;
        Some(ticker)
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
                    Arc::clone(&engine),
                    Arc::clone(&gate),
                    Arc::clone(&outbox),
                    staged.clone(),
                    executor_tracker.clone(),
                )?);
            }
            let request = request.expect("validated write request");
            if let Err((id, code)) = database_writer.as_ref().unwrap().try_send(id, request) {
                request_control::reject_pending(&id, code)?;
            }
            continue;
        }
        if request.as_ref().is_ok_and(read_pool_op) {
            if read_pool.is_none() {
                read_pool = Some(start_read_pool(
                    Arc::clone(&engine),
                    Arc::clone(&gate),
                    Arc::clone(&outbox),
                    staged.clone(),
                    executor_tracker.clone(),
                )?);
            }
            let request = request.expect("validated read request");
            if let Err((id, code)) = read_pool.as_ref().unwrap().try_send(id, request) {
                request_control::overload(&id, code)?;
            }
            continue;
        }
        if request.as_ref().is_ok_and(gadget_io_op) {
            if gadget_io_pool.is_none() {
                gadget_io_pool = Some(start_gadget_io_pool(gadget_state.clone())?);
            }
            let Ok(Request::GadgetState { request }) = request else {
                unreachable!();
            };
            if let Err((id, code)) = gadget_io_pool.as_ref().unwrap().try_send(id, request) {
                request_control::overload(&id, code)?;
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
                    &engine,
                    id,
                    WorkspaceJob::PluginCatalog(query),
                    Data::Json(Value::Null),
                )?;
                continue;
            }
            Ok(Request::ReadPluginConfig { target }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    &engine,
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
                    &engine,
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
                    &engine,
                    id,
                    WorkspaceJob::InstallConnector(install),
                    Data::ConnectorInstall(connector_install::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::RecoverConnectorInstalls { root }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    &engine,
                    id,
                    WorkspaceJob::RecoverConnectorInstalls(root),
                    Data::ConnectorInstall(connector_install::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::MaintainConnectorStorage { task }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    &engine,
                    id,
                    WorkspaceJob::MaintainConnectorStorage(task),
                    Data::ConnectorInstall(connector_install::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::ImportConnectorMarket { request }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    &engine,
                    id,
                    WorkspaceJob::ImportConnectorMarket(request),
                    Data::ConnectorImport(connector_import::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::MutateConnectorMarket { action }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    &engine,
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
                    &engine,
                    id,
                    WorkspaceJob::Scan(query),
                    Data::WorkspaceScan(workspace_scan::Scan::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::FileBackupList { query }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    &engine,
                    id,
                    WorkspaceJob::FileBackupList(query),
                    Data::FileBackupList(None),
                )?;
                continue;
            }
            Ok(Request::RestoreFileBackup { request }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    &engine,
                    id,
                    WorkspaceJob::RestoreFileBackup(request),
                    Data::FileBackupRestore(file_backup_restore::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::SubagentSettings { request }) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    &engine,
                    id,
                    WorkspaceJob::SubagentSettings(request),
                    Data::PluginConfig(plugin_config::Reply::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::ScanWorkGraphIntegrity) => {
                dispatch_workspace(
                    &mut workspace_scans,
                    &engine,
                    id,
                    WorkspaceJob::WorkGraphIntegrity,
                    Data::Json(Value::Null),
                )?;
                continue;
            }
            Ok(Request::ListTrashedTasks { trash_root }) => {
                let null = Data::Json(Value::Null);
                let rows_res = (|| -> Result<Vec<task_trash::TrashedTask>> {
                    let reader = engine.checkout_reader(Duration::from_secs(10))?;
                    task_trash::list(reader.conn())
                })();
                match rows_res {
                    Ok(rows) => dispatch_workspace(
                        &mut workspace_scans,
                        &engine,
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
                    &engine,
                    id,
                    WorkspaceJob::FileRevision { root, file },
                    Data::DotsFileRevision(dots_file_revision::Revision::NeedsHost),
                )?;
                continue;
            }
            Ok(Request::SemanticInference { request }) => InferenceJob::Embed(request),
            Ok(Request::StageEmbedding { request }) => InferenceJob::Stage(request),
            Ok(Request::SemanticModelProbe { probe }) => InferenceJob::Probe(probe),
            Ok(Request::GadgetState { .. }) => unreachable!(),
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
                let res = (|| -> Result<Data> {
                    let mut reader = engine.checkout_reader(Duration::from_secs(10))?;
                    index_queues
                        .query(reader.conn_mut(), query)
                        .map(Data::EmbeddingIndex)
                })();
                write_reply(&id, res, false)?;
                continue;
            }
            Ok(Request::CleanupArtifactFiles { root, cleanup }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &engine,
                    &gate,
                    id,
                    MaintenanceJob::CleanupArtifactFiles { root, cleanup },
                )?;
                continue;
            }
            Ok(Request::DeleteLibrary { root, target }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &engine,
                    &gate,
                    id,
                    MaintenanceJob::DeleteLibrary { root, target },
                )?;
                continue;
            }
            Ok(Request::DrainLibraryCleanup { root }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &engine,
                    &gate,
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
                    &engine,
                    &gate,
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
                    &engine,
                    &gate,
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
                    &engine,
                    &gate,
                    id,
                    MaintenanceJob::DiscardLibraryRestore { operation_id },
                )?;
                continue;
            }
            Ok(Request::RestoreLibraryBackup { restore }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &engine,
                    &gate,
                    id,
                    MaintenanceJob::RestoreLibraryBackup { restore },
                )?;
                continue;
            }
            Ok(Request::RecoverLibraryRestores { root }) => {
                dispatch_maintenance(
                    &mut maintenance,
                    &engine,
                    &gate,
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
                    &engine,
                    &gate,
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
                    &engine,
                    &gate,
                    id,
                    MaintenanceJob::PromoteProjectEventToLibrary { promotion },
                )?;
                continue;
            }
            Ok(request) => {
                let mut side_effects = None;
                let res = (|| -> Result<Data> {
                    let mut pooled = engine.checkout_reader(Duration::from_secs(10))?;
                    if let (Some(req_id), Some(ctrl)) = (id.as_deref(), request_control::shared()) {
                        pooled.bind_request(req_id, ctrl.clone());
                    }
                    read(
                        pooled.conn_mut(),
                        &engine,
                        &gate,
                        &outbox,
                        &mut durable_sessions,
                        &staged,
                        &executor_tracker,
                        &mut side_effects,
                        request,
                    )
                })();
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
            inference = Some(start_inference(Arc::clone(&engine), staged.clone())?);
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
    drop(scheduler_ticker);
    if let Some(pool) = database_writer {
        pool.shutdown()?;
    }
    if let Some((sender, worker)) = inference {
        drop(sender);
        worker
            .join()
            .map_err(|_| "semantic inference thread panicked")?;
    }
    if let Some(pool) = read_pool {
        pool.shutdown()?;
    }
    if let Some(pool) = gadget_io_pool {
        pool.shutdown()?;
    }
    if let Some(pool) = workspace_scans {
        pool.shutdown()?;
    }
    if let Some((sender, worker)) = maintenance {
        drop(sender);
        worker.join().map_err(|_| "maintenance worker panicked")?;
    }
    gadget_http_host::stop_all();
    outbox.close();
    publisher_worker.join().map_err(|_| "domain outbox publisher panicked")?;
    engine.close();
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
    fn scheduler_can_commit_while_pi_supervision_waits_for_a_process() -> Result<()> {
        use pi_host_supervisor::{AfterProcessEffect, PiHostPhase, PiHostWritePhase};
        use std::sync::mpsc::channel;

        let path = tempfile::tempdir()?;
        let (engine, _) = database::DuckDbEngine::open_or_initialize(
            path.path().join("app.duckdb"), Default::default(),
        )?;
        let gate = resource_gate::ResourceGate::new(32);
        let mut ticker = SchedulerTickerGuard::new();
        let (waiting, pi_waiting) = channel();
        let (release, wait_for_release) = channel();
        let (committed, work_committed) = channel();
        let pi_engine = Arc::clone(&engine);
        let pi_gate = Arc::clone(&gate);
        ticker.start("test-pi-supervisor", 30_000, move |stop| {
            let lease = acquire_scheduler_phase(&pi_gate, stop, "pi_host_tick").expect("Pi phase");
            let mut phase = PiHostWritePhase::new(&pi_engine, lease, None, Duration::from_secs(2));
            phase.connection().expect("Pi writer");
            phase.process_effect(AfterProcessEffect::Resume, &mut || {
                waiting.send(()).expect("report Pi wait");
                let _ = wait_for_release.recv_timeout(Duration::from_secs(10));
            }).expect("resume Pi phase");
        })?;
        pi_waiting.recv_timeout(Duration::from_secs(3))?;
        let work_engine = Arc::clone(&engine);
        ticker.start("test-work-scheduler", 30_000, move |stop| {
            let _lease = acquire_scheduler_phase(&gate, stop, "work_tick").expect("work phase");
            let mut writer = work_engine.checkout_writer(Duration::from_secs(2)).expect("work writer");
            writer.conn_mut().execute(
                "INSERT INTO tasks(id,title,updated_at) VALUES ('independent','Independent',1)", [],
            ).expect("commit independent task");
            committed.send(()).expect("report work commit");
        })?;
        work_committed.recv_timeout(Duration::from_secs(3))?;
        release.send(())?;
        drop(ticker);
        let reader = engine.checkout_reader(Duration::from_secs(2))?;
        assert_eq!(reader.conn().query_row("SELECT title FROM tasks WHERE id='independent'", [],
            |row| row.get::<_, String>(0))?, "Independent");
        Ok(())
    }

    #[test]
    fn waiting_to_bind_one_durable_task_does_not_delay_an_independent_binding() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};

        let now = request_control::now_ms();
        let dir = std::env::temp_dir().join(format!("mybuddy-binding-admission-{}-{now}", std::process::id()));
        let config = database::DuckDbPoolConfig { read_pool_size: 1, write_pool_size: 2, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        {
            let db = engine.checkout_writer(Duration::from_secs(1))?;
            db.conn().execute("INSERT INTO tasks(id,title,updated_at) VALUES ('held','Held',?1),('free','Free',?1)", [now])?;
        }
        let gate = resource_gate::ResourceGate::new(32);
        let hold = gate.acquire(vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "held".into()))],
            Duration::from_secs(1), || false).expect("hold the first task");
        let writer = start_database_writer(engine.clone(), gate, outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        for id in ["held", "free"] {
            let request = Request::WriteDurableTaskProjection { request: durable_task_projection::Request::BindBot {
                task_id: id.into(), directory: format!("store-{id}"), cwd: format!("cwd-{id}"), update_cwd_if_exists: false,
            }};
            writer.try_send(Some(format!("bind-{id}")), request).expect("enqueue binding");
        }
        let saved = || -> Result<(bool, bool)> {
            let db = engine.checkout_reader(Duration::from_secs(1))?;
            Ok(db.conn().query_row(
                "SELECT EXISTS(SELECT 1 FROM durable_bot_bindings WHERE task_id='held'),
                        EXISTS(SELECT 1 FROM durable_bot_bindings WHERE task_id='free')",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        };
        let until = std::time::Instant::now() + Duration::from_secs(4);
        let before_release = loop {
            let found = saved()?;
            if found.1 || std::time::Instant::now() >= until { break found; }
            thread::sleep(Duration::from_millis(10));
        };
        drop(hold);
        writer.shutdown()?;
        let after_release = saved()?;
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(before_release, (false, true));
        assert_eq!(after_release, (true, true));
        Ok(())
    }

    #[test]
    fn goal_waiting_for_its_task_does_not_hold_another_goals_write() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};

        let now = request_control::now_ms();
        let dir = std::env::temp_dir().join(format!("mybuddy-goal-admission-{}-{now}", std::process::id()));
        let config = database::DuckDbPoolConfig { read_pool_size: 1, write_pool_size: 2, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        {
            let mut db = engine.checkout_writer(Duration::from_secs(1))?;
            db.conn().execute("INSERT INTO tasks(id,title,updated_at) VALUES ('held','Held',?1),('free','Free',?1)", [now])?;
            let bot = serde_json::from_value(serde_json::json!({
                "op":"botUpsert", "botId":"bot", "userId":"user", "primary":true, "operationId":"register",
                "displayName":"Bot", "responsibilitySummary":"", "expertProfileJson":"{}", "memoryScopeJson":"{}",
                "authorizationJson":"{}", "foregroundAllowedToolsJson":"[]", "notificationPolicyJson":"{}",
                "status":"active", "now":now, "activeVersion":1, "expertId":"expert", "sourceRevision":"v1",
                "systemPromptHash":"hash", "allowedMcpIdsJson":"[]", "allowedSkillIdsJson":"[]",
                "allowedConnectorIdsJson":"[]", "skillPackagesJson":"[]"
            }))?;
            assert_eq!(batch4b_writes::run(db.conn_mut(), bot)?["ok"], true);
            db.conn().execute(
                "INSERT INTO bot_message_execution_settings VALUES ('from-history','bot','{}',?1)",
                [r#"{"expertId":"frozen-expert","version":2}"#],
            )?;
            db.conn().execute("INSERT INTO conversation_goal_usage_events VALUES ('old-turn','free',137,?1)", [now])?;
        }
        let gate = resource_gate::ResourceGate::new(32);
        let hold = gate.acquire(vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "held".into()))],
            Duration::from_secs(1), || false).expect("hold the first task");
        let writer = start_database_writer(engine.clone(), gate, outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        for id in ["held", "free"] {
            let source = (id == "free").then(|| serde_json::json!({
                "taskId":id, "conversationId":"history", "messageId":"from-history", "role":"user", "text":"Check the snapshot"
            }));
            let request: Request = serde_json::from_value(serde_json::json!({
                "operation":"createConversationGoal", "operationId":format!("create-{id}"),
                "draft":{"userId":"user", "taskId":id, "defaultBotId":"bot", "title":id, "criteria":[], "source":source}
            }))?;
            writer.try_send(Some(format!("goal-{id}")), request).expect("enqueue goal");
        }
        let states = || -> Result<(bool, bool)> {
            let db = engine.checkout_reader(Duration::from_secs(1))?;
            Ok(db.conn().query_row("SELECT EXISTS(SELECT 1 FROM work_conversations WHERE conversation_id='held'),
                EXISTS(SELECT 1 FROM work_conversations WHERE conversation_id='free')",
                [], |row| Ok((row.get(0)?, row.get(1)?)))?)
        };
        let until = std::time::Instant::now() + Duration::from_secs(4);
        let before_release = loop {
            let committed = states()?;
            if committed.1 || std::time::Instant::now() >= until { break committed; }
            thread::sleep(Duration::from_millis(10));
        };
        drop(hold);
        writer.shutdown()?;
        let after_release = states()?;
        let (expert, usage): (String, i64) = {
            let db = engine.checkout_reader(Duration::from_secs(1))?;
            db.conn().query_row(
                "SELECT json_extract_string(s.expert_snapshot_json, '$.expertId'), g.usage_cursor
                 FROM conversation_goal_continuations g JOIN work_intent_snapshots s USING (work_id)
                 WHERE g.task_id='free'",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            )?
        };
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(before_release, (false, true));
        assert_eq!(after_release, (true, true));
        assert_eq!((expert.as_str(), usage), ("frozen-expert", 137));
        Ok(())
    }

    #[test]
    fn blocked_gateway_channel_leaves_another_channel_free_to_commit() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};

        let now = request_control::now_ms();
        let dir = std::env::temp_dir().join(format!("mybuddy-gateway-channel-admission-{}-{now}", std::process::id()));
        let config = database::DuckDbPoolConfig { read_pool_size: 1, write_pool_size: 2, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        let gate = resource_gate::ResourceGate::new(32);
        let hold = gate.acquire(
            vec![ResourceRequirement::exclusive(ResourceKey::Entity("gateway_channel".into(), "held".into()))],
            Duration::from_secs(1), || false,
        ).expect("hold the first channel");
        let writer = start_database_writer(engine.clone(), gate, outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        for id in ["held", "free"] {
            let request: Request = serde_json::from_value(serde_json::json!({
                "operation": "writeGatewayChannel", "operationId": format!("save-{id}"),
                "draft": { "channel": { "id": id, "type": "telegram", "name": id, "connected": true, "configJson": "{}" }, "expected": null },
            }))?;
            writer.try_send(Some(format!("channel-{id}")), request).expect("enqueue channel write");
        }
        let states = || -> Result<(bool, bool)> {
            let reader = engine.checkout_reader(Duration::from_secs(1))?;
            Ok(reader.conn().query_row(
                "SELECT EXISTS(SELECT 1 FROM gateway_channels WHERE id='held'), EXISTS(SELECT 1 FROM gateway_channels WHERE id='free')",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let before_release = loop {
            let committed = states()?;
            if committed.1 || std::time::Instant::now() >= deadline { break committed; }
            thread::sleep(Duration::from_millis(10));
        };
        drop(hold);
        writer.shutdown()?;
        let after_release = states()?;
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(before_release, (false, true));
        assert_eq!(after_release, (true, true));
        Ok(())
    }

    #[test]
    fn blocked_gateway_execution_claim_leaves_another_delivery_ready() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};

        let dir = std::env::temp_dir().join(format!("mybuddy-gateway-delivery-{}-{}", std::process::id(), request_control::now_ms()));
        let config = database::DuckDbPoolConfig { read_pool_size: 1, write_pool_size: 2, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        {
            let db = engine.checkout_writer(Duration::from_secs(1))?;
            for id in ["held", "free"] {
                db.conn().execute(
                    "INSERT INTO gateway_inbox(delivery_id,platform,channel_id,account_key,chat_id,session_key,message_id,
                        payload_json,payload_hash,status,receipt_mode,created_at,updated_at)
                     VALUES (?1,'telegram','channel','account','chat','chat',?1,'{}','fixture','pending','pi-durable',1,1)", [id],
                )?;
            }
        }
        let gate = resource_gate::ResourceGate::new(32);
        let hold = gate.acquire(vec![ResourceRequirement::exclusive(ResourceKey::Entity("gateway_delivery".into(), "held".into()))],
            Duration::from_secs(1), || false).expect("hold candidate delivery");
        let writer = start_database_writer(engine.clone(), gate, outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        for id in ["held", "free"] {
            let request = serde_json::from_value(serde_json::json!({
                "operation": "gatewayDeliveryControl", "deliveryId": id, "operationId": "claim",
                "command": { "action": "claimExecution" },
            }))?;
            writer.try_send(Some(format!("delivery-{id}")), request).expect("enqueue delivery claim");
        }
        let states = || -> Result<(i64, i64)> {
            let reader = engine.checkout_reader(Duration::from_secs(1))?;
            Ok(reader.conn().query_row("SELECT sum(retry_count) FILTER (WHERE delivery_id='held')::BIGINT,
                     sum(retry_count) FILTER (WHERE delivery_id='free')::BIGINT FROM gateway_inbox",
                [], |r| Ok((r.get(0)?,r.get(1)?)))?)
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let before_release = loop {
            let count = states()?;
            if count.1 == 1 || std::time::Instant::now() >= deadline { break count; }
            thread::sleep(Duration::from_millis(10));
        };
        drop(hold);
        writer.shutdown()?;
        let after_release = states()?;
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(before_release, (0, 1));
        assert_eq!(after_release, (1, 1));
        Ok(())
    }

    #[test]
    fn interaction_waiting_for_its_task_does_not_hold_the_writer() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};

        let now = request_control::now_ms();
        let dir = std::env::temp_dir().join(format!("mybuddy-interaction-admission-{}-{now}", std::process::id()));
        let config = database::DuckDbPoolConfig { read_pool_size: 1, write_pool_size: 2, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        {
            let db = engine.checkout_writer(Duration::from_secs(1))?;
            db.conn().execute("INSERT INTO tasks(id,title,updated_at) VALUES ('held','Held',?1),('free','Free',?1)", [now])?;
        }
        let gate = resource_gate::ResourceGate::new(32);
        let hold = gate.acquire(vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "held".into()))],
            Duration::from_secs(1), || false).expect("hold the first task");
        let writer = start_database_writer(engine.clone(), gate, outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        for id in ["held", "free"] {
            let request: Request = serde_json::from_value(serde_json::json!({
                "operation":"batch1Write", "request": { "kind":"interactionInsert", "id":id, "taskId":id,
                    "executionId":id, "assistantMessageId":"message", "kindName":"short_text", "title":id,
                    "optionsJson":"[]", "allowCustom":1, "status":"pending", "version":1, "createdAt":now }
            }))?;
            writer.try_send(Some(format!("interaction-{id}")), request).expect("enqueue interaction");
        }
        let states = || -> Result<(bool, bool)> {
            let db = engine.checkout_reader(Duration::from_secs(1))?;
            Ok(db.conn().query_row("SELECT EXISTS(SELECT 1 FROM conversation_interactions WHERE task_id='held'),
                EXISTS(SELECT 1 FROM conversation_interactions WHERE task_id='free')", [], |row| Ok((row.get(0)?, row.get(1)?)))?)
        };
        let until = std::time::Instant::now() + Duration::from_secs(4);
        let before_release = loop {
            let committed = states()?;
            if committed.1 || std::time::Instant::now() >= until { break committed; }
            thread::sleep(Duration::from_millis(10));
        };
        drop(hold);
        writer.shutdown()?;
        let after_release = states()?;
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(before_release, (false, true));
        assert_eq!(after_release, (true, true));
        Ok(())
    }

    #[test]
    fn one_bot_waiting_for_its_role_does_not_delay_another_users_registration() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};

        let now = request_control::now_ms();
        let dir = std::env::temp_dir().join(format!("mybuddy-bot-admission-{}-{now}", std::process::id()));
        let config = database::DuckDbPoolConfig { read_pool_size: 1, write_pool_size: 2, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        let gate = resource_gate::ResourceGate::new(32);
        let hold = gate.acquire(vec![ResourceRequirement::exclusive(ResourceKey::Entity("bot_primary_user".into(), "held".into()))],
            Duration::from_secs(1), || false).expect("hold the first user's primary role");
        let writer = start_database_writer(engine.clone(), gate, outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        for id in ["held", "free"] {
            let request: Request = serde_json::from_value(serde_json::json!({
                "operation":"batch4bWrite", "request": { "op":"botUpsert", "botId":id, "userId":id, "primary":true, "operationId":format!("op-{id}"),
                    "displayName":id, "responsibilitySummary":"", "expertProfileJson":"{}", "memoryScopeJson":"{}",
                    "authorizationJson":"{}", "foregroundAllowedToolsJson":"[]", "notificationPolicyJson":"{}",
                    "status":"active", "now":now, "activeVersion":1, "expertId":"expert", "sourceRevision":"v1",
                    "systemPromptHash":"hash", "allowedMcpIdsJson":"[]", "allowedSkillIdsJson":"[]",
                    "allowedConnectorIdsJson":"[]", "skillPackagesJson":"[]" }
            }))?;
            writer.try_send(Some(format!("register-{id}")), request).expect("enqueue bot registration");
        }
        let roles = || -> Result<(Option<bool>, Option<bool>)> {
            let db = engine.checkout_reader(Duration::from_secs(1))?;
            Ok((bot_registry_data::bot(db.conn(), "held")?["is_primary"].as_bool(),
                bot_registry_data::bot(db.conn(), "free")?["is_primary"].as_bool()))
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let before_release = loop {
            let registered = roles()?;
            if registered.1.is_some() || std::time::Instant::now() >= deadline { break registered; }
            thread::sleep(Duration::from_millis(10));
        };
        drop(hold);
        writer.shutdown()?;
        let after_release = roles()?;
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(before_release, (None, Some(true)));
        assert_eq!(after_release, (Some(true), Some(true)));
        Ok(())
    }

    #[test]
    fn snapshot_waiting_on_one_task_does_not_hold_the_writer_for_another() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};
        use serde_json::json;

        let now = request_control::now_ms();
        let dir = std::env::temp_dir().join(format!("mybuddy-snapshot-admission-{}-{now}", std::process::id()));
        let config = database::DuckDbPoolConfig { write_pool_size: 2, read_pool_size: 1, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        {
            let db = engine.checkout_writer(Duration::from_secs(1))?;
            db.conn().execute("INSERT INTO tasks(id,title,updated_at) VALUES ('held','Held',?1),('free','Free',?1)", [now])?;
        }
        let gate = resource_gate::ResourceGate::new(32);
        let held = gate.acquire(vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "held".into()))],
            Duration::from_secs(1), || false).expect("hold the original task's write scope");
        let writer = start_database_writer(engine.clone(), gate, outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        for id in ["held", "free"] {
            let request: Request = serde_json::from_value(json!({
                "operation":"mutateSnapshot", "writeId": format!("save-{id}"),
                "mutation": { "kind":"insert", "snapshot": { "id":id, "executionId":id, "taskId":id,
                    "userMessageId":"u", "assistantMessageId":"a", "createdAt":now, "startedAt":now, "schemaVersion":3,
                    "mode":"general", "instructions":"[]", "capabilities":"[]", "warnings":"[]",
                    "materialUsage":"{}", "status":"running", "assemblyHash":"hash", "storageBytes":0 } }
            }))?;
            writer.try_send(Some(format!("save-{id}")), request).expect("enqueue snapshot mutation");
        }
        let read_receipts = || -> Result<(Option<usize>, Option<usize>)> {
            let db = engine.checkout_reader(Duration::from_secs(1))?;
            Ok((snapshots::receipt(db.conn(), "save-held")?, snapshots::receipt(db.conn(), "save-free")?))
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let before_release = loop {
            let receipts = read_receipts()?;
            if receipts.1.is_some() || std::time::Instant::now() >= deadline { break receipts; }
            thread::sleep(Duration::from_millis(10));
        };
        drop(held);
        writer.shutdown()?;
        let after_release = read_receipts()?;
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(before_release, (None, Some(1)));
        assert_eq!(after_release, (Some(1), Some(1)));
        Ok(())
    }

    #[test]
    fn artifact_writer_admits_an_independent_task_while_one_is_held() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};
        use serde_json::json;

        let now = request_control::now_ms();
        let dir = std::env::temp_dir().join(format!("mybuddy-artifact-admission-{}-{now}", std::process::id()));
        let config = database::DuckDbPoolConfig { write_pool_size: 2, read_pool_size: 1, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        {
            let db = engine.checkout_writer(Duration::from_secs(1))?;
            db.conn().execute("INSERT INTO tasks(id,title,updated_at) VALUES ('held','Held',?1),('free','Free',?1)", [now])?;
        }
        let gate = resource_gate::ResourceGate::new(32);
        let make_request = |task_id: &str| -> Result<Request> {
            Ok(serde_json::from_value(json!({
                "operation": "writeManagedArtifact", "taskId": task_id, "operationId": format!("register-{task_id}"),
                "content": { "kind": "text", "content": format!("artifact for {task_id}") },
                "row": { "id": task_id, "task_id": task_id, "kind": "markdown", "source_type": "managed-content",
                    "root_dir": dir.join("artifacts"), "storage_path": format!("{task_id}/{task_id}/index.md"),
                    "version": 1, "capabilities_json": "{}", "created_at": now, "updated_at": now },
            }))?)
        };
        let held = make_request("held")?;
        let hold = gate.acquire(resource_plan_for_request(&held), Duration::from_secs(1), || false)
            .expect("hold the first task's managed write resources");
        let gc_key = ResourceRequirement::exclusive(ResourceKey::Namespace("domain".into(), "artifacts".into()));
        assert!(gate.acquire(vec![gc_key], Duration::from_millis(15), || false).is_err());
        let writer = start_database_writer(engine.clone(), gate, outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        writer.try_send(Some("held-artifact-write".into()), held).expect("enqueue held write");
        writer.try_send(Some("free-artifact-write".into()), make_request("free")?).expect("enqueue unrelated write");
        let read_receipts = || -> Result<(bool, bool)> {
            let db = engine.checkout_reader(Duration::from_secs(1))?;
            Ok((artifact_write::read_receipt(db.conn(), "held", "register-held")?.is_some(),
                artifact_write::read_receipt(db.conn(), "free", "register-free")?.is_some()))
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let before_release = loop {
            let receipts = read_receipts()?;
            if receipts.1 || std::time::Instant::now() >= deadline { break receipts; }
            thread::sleep(Duration::from_millis(10));
        };
        drop(hold);
        writer.shutdown()?;
        let after_release = read_receipts()?;
        let saved = std::fs::read_to_string(dir.join("artifacts/free/free/index.md"))?;
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(before_release, (false, true));
        assert_eq!(after_release, (true, true));
        assert_eq!(saved, "artifact for free");
        Ok(())
    }

    #[test]
    fn independent_gadget_metadata_commits_while_a_source_lock_is_held() -> Result<()> {
        let now = request_control::now_ms();
        let dir = std::env::temp_dir().join(format!("mybuddy-workbench-admission-{}-{now}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let config = database::DuckDbPoolConfig { write_pool_size: 2, read_pool_size: 1, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        {
            let db = engine.checkout_writer(Duration::from_secs(1))?;
            db.conn().execute("INSERT INTO gadgets(id,name,scope_type,type,manifest_path,source_path,created_at,updated_at)
                VALUES ('gdt-held','Original','global','web','manifest-a','source-a',?1,?1),
                       ('gdt-free','Original','global','web','manifest-b','source-b',?1,?1)", [now])?;
        }
        let gate = resource_gate::ResourceGate::new(32);
        let source: Request = serde_json::from_value(serde_json::json!({
            "operation": "saveGadgetSource", "save": { "root": "unused", "id": "gdt-held", "operationId": "pending-save",
                "updatedAt": now, "token": "test-token", "files": [] },
        }))?;
        let lock = gate.acquire(resource_plan_for_request(&source), Duration::from_secs(1), || false)
            .expect("hold the resources held by a source write");
        let writer = start_database_writer(engine.clone(), gate, outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        for (id, name) in [("gdt-held", "Held edit"), ("gdt-free", "Independent edit")] {
            let request: Request = serde_json::from_value(serde_json::json!({
                "operation": "writeWorkbench", "operationId": format!("patch-{id}"),
                "mutation": { "kind": "updateGadget", "id": id, "name": name, "updatedAt": now },
            }))?;
            writer.try_send(Some(format!("patch-{id}")), request).expect("enqueue Gadget edit");
        }
        let get_names = || -> Result<(String,String)> {
            let db = engine.checkout_reader(Duration::from_secs(1))?;
            Ok(db.conn().query_row("SELECT (SELECT name FROM gadgets WHERE id='gdt-held'),
                (SELECT name FROM gadgets WHERE id='gdt-free')", [], |row| Ok((row.get(0)?, row.get(1)?)))?)
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let before_release = loop {
            let names = get_names()?;
            if names.1 == "Independent edit" || std::time::Instant::now() >= deadline { break names; }
            thread::sleep(Duration::from_millis(10));
        };
        drop(lock);
        writer.shutdown()?;
        let after_release = get_names()?;
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(before_release, ("Original".into(), "Independent edit".into()));
        assert_eq!(after_release, ("Held edit".into(), "Independent edit".into()));
        Ok(())
    }

    #[test]
    fn board_action_waiting_on_one_task_does_not_block_another_task() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};

        let now = request_control::now_ms();
        let dir = std::env::temp_dir().join(format!("mybuddy-board-admission-{}-{now}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let config = database::DuckDbPoolConfig { write_pool_size: 2, read_pool_size: 1, ..Default::default() };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        {
            let database = engine.checkout_writer(Duration::from_secs(1))?;
            database.conn().execute(
                "INSERT INTO tasks(id,title,updated_at) VALUES ('board-busy','Busy',?1),('board-free','Free',?1)", [now],
            )?;
        }
        let gate = resource_gate::ResourceGate::new(32);
        let hold = gate.acquire(vec![ResourceRequirement::exclusive(ResourceKey::Entity("task".into(), "board-busy".into()))],
            Duration::from_secs(1), || false).expect("hold the original task's write scope");
        let writer = start_database_writer(engine.clone(), gate.clone(), outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()), Arc::new(business_protocol::ExecutorTracker::new()))?;
        for (index, (id, action)) in [("board-busy", "today"), ("board-busy", "clear"), ("board-busy", "visit"),
            ("board-free", "today")].into_iter().enumerate() {
            let request: Request = serde_json::from_value(serde_json::json!({
                "operation": "writeTaskBoardAction", "input": { "id": id, "action": action, "now": now },
            }))?;
            writer.try_send(Some(format!("board-action-{index}")), request).expect("enqueue board action");
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let plans_at_barrier = loop {
            let reader = engine.checkout_reader(Duration::from_secs(1))?;
            let plans: (i64, i64) = reader.conn().query_row(
                "SELECT count(*) FILTER (WHERE id='board-free'),count(*) FILTER (WHERE id='board-busy') FROM task_board_plans",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if plans.0 != 0 || std::time::Instant::now() >= deadline { break plans; }
            drop(reader);
            thread::sleep(Duration::from_millis(10));
        };
        drop(hold);
        writer.shutdown()?;
        let after_release: (i64, i64) = {
            let reader = engine.checkout_reader(Duration::from_secs(1))?;
            reader.conn().query_row("SELECT (SELECT count(*) FROM task_board_plans WHERE id='board-busy'),
                (SELECT count(*) FROM task_board_days WHERE id='board-busy' AND kind='visit')", [],
                |row| Ok((row.get(0)?, row.get(1)?)))?
        };
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(plans_at_barrier, (1, 0), "independent plan must commit before the conflicting action begins");
        assert_eq!(after_release, (0, 1), "clear follows today and the same task records a visit after release");
        Ok(())
    }

    #[test]
    fn blocked_store_writes_leave_a_worker_available_for_an_independent_store() -> Result<()> {
        use resource_gate::{ResourceKey, ResourceRequirement};

        let dir = std::env::temp_dir().join(format!(
            "mybuddy-writer-admission-{}-{}",
            std::process::id(),
            request_control::now_ms(),
        ));
        std::fs::create_dir_all(&dir)?;
        let config = database::DuckDbPoolConfig {
            write_pool_size: 2,
            read_pool_size: 1,
            ..Default::default()
        };
        let (engine, _) = database::DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), config)?;
        let gate = resource_gate::ResourceGate::new(32);
        let hold = gate.acquire(
            vec![ResourceRequirement::exclusive(ResourceKey::PiStore("busy".into()))],
            Duration::from_secs(1),
            || false,
        ).expect("hold the busy store until the independent write commits");
        let writer = start_database_writer(
            engine.clone(),
            gate.clone(),
            outbox_publisher::OutboxPublisher::new(),
            Arc::new(embedding_index::StagedVectors::default()),
            Arc::new(business_protocol::ExecutorTracker::new()),
        )?;
        for (index, store) in ["busy", "busy", "busy", "independent"].into_iter().enumerate() {
            let request: Request = serde_json::from_value(serde_json::json!({
                "operation": "piStorage",
                "payload": { "action": "openWriter", "storeId": store },
            }))?;
            writer.try_send(Some(format!("writer-admission-{index}")), request)
                .expect("writes fit in the admission queue");
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let committed_before_release = loop {
            let reader = engine.checkout_reader(Duration::from_secs(1))?;
            let stores: i64 = reader.conn().query_row(
                "SELECT COUNT(*) FROM durable_stores WHERE store_id = 'independent'",
                [],
                |row| row.get(0),
            )?;
            if stores == 1 || std::time::Instant::now() >= deadline {
                break stores;
            }
            drop(reader);
            thread::sleep(Duration::from_millis(10));
        };
        drop(hold);
        writer.shutdown()?;
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        assert_eq!(committed_before_release, 1);
        Ok(())
    }

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

    #[test]
    fn pi_host_and_gadget_host_requests_are_classified_for_writer_and_receipts() {
        let pi_status: Request = serde_json::from_value(serde_json::json!({
            "operation": "corePiHost", "action": "status"
        }))
        .unwrap();
        assert!(!database_write(&pi_status));
        assert!(!request_may_mutate(&pi_status));

        let pi_verify: Request = serde_json::from_value(serde_json::json!({
            "operation": "corePiHost", "action": "verifyLease", "hostGeneration": "g-1"
        }))
        .unwrap();
        assert!(!database_write(&pi_verify));
        assert!(!request_may_mutate(&pi_verify));

        for write_payload in [
            serde_json::json!({
                "operation": "corePiHost",
                "action": "launch",
                "executable": "node",
                "scriptPath": "host.cjs",
                "dataDirectory": "/tmp/d",
                "dbPath": "/tmp/d/app.db",
                "storageRoot": "/tmp/d/durable",
                "piVersion": "1.5.0",
                "expectedPiVersion": "1.5.0"
            }),
            serde_json::json!({
                "operation": "corePiHost",
                "action": "register",
                "hostId": "h-1",
                "pid": 123,
                "hostGeneration": "g-1",
                "storageRoot": "/tmp/d/durable",
                "piVersion": "1.5.0",
                "expectedPiVersion": "1.5.0"
            }),
            serde_json::json!({
                "operation": "corePiHost",
                "action": "heartbeat",
                "hostId": "h-1",
                "pid": 123,
                "hostGeneration": "g-1"
            }),
            serde_json::json!({
                "operation": "corePiHost",
                "action": "stop"
            }),
            serde_json::json!({
                "operation": "corePiHost",
                "action": "fenceGeneration",
                "hostGeneration": "g-1"
            }),
        ] {
            let req: Request = serde_json::from_value(write_payload).unwrap();
            assert!(database_write(&req));
            assert!(request_may_mutate(&req));
            assert!(deferred(&req));
        }

        for read_gadget in [
            serde_json::json!({ "operation": "coreGadgetHost", "action": "supported" }),
            serde_json::json!({ "operation": "coreGadgetHost", "action": "list" }),
            serde_json::json!({ "operation": "coreGadgetHost", "action": "health", "gadgetId": "g-1" }),
        ] {
            let req: Request = serde_json::from_value(read_gadget).unwrap();
            assert!(!database_write(&req));
            assert!(!request_may_mutate(&req));
        }

        for mut_gadget in [
            serde_json::json!({
                "operation": "coreGadgetHost",
                "action": "startStatic",
                "gadgetId": "g-1",
                "name": "G1",
                "sourcePath": "/tmp/src",
                "dataPath": "/tmp/data",
                "entry": "index.html",
                "sdkSource": "",
                "token": "t",
                "generation": "gen"
            }),
            serde_json::json!({ "operation": "coreGadgetHost", "action": "stopStatic", "gadgetId": "g-1" }),
            serde_json::json!({ "operation": "coreGadgetHost", "action": "stopAll" }),
            serde_json::json!({ "operation": "coreGadgetHost", "action": "revokeGeneration", "generation": "gen" }),
            serde_json::json!({
                "operation": "coreGadgetHost",
                "action": "registerBackend",
                "gadgetId": "g-2",
                "generation": "gen",
                "pid": 456,
                "kind": "node"
            }),
            serde_json::json!({
                "operation": "coreGadgetHost",
                "action": "unregisterBackend",
                "gadgetId": "g-2",
                "generation": "gen"
            }),
        ] {
            let req: Request = serde_json::from_value(mut_gadget).unwrap();
            assert!(!database_write(&req));
            assert!(request_may_mutate(&req));
        }
    }
}
