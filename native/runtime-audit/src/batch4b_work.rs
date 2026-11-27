use crate::Result;
use duckdb::{Connection, OptionalExt, Transaction, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum WorkOp {
    #[serde(rename_all = "camelCase")]
    WorkInsert {
        work_id: String,
        user_id: String,
        project_id: Option<String>,
        workspace_path: Option<String>,
        source_message_id: Option<String>,
        legacy_task_id: Option<String>,
        owner_bot_id: String,
        owner_epoch: i64,
        intent_revision: i64,
        source_version: i64,
        title: String,
        goal_description: Option<String>,
        constraints_json: String,
        criteria_json: String,
        authorization_json: String,
        active_intent_snapshot_id: String,
        input_snapshot_id: String,
        goal_sources_json: String,
        mode: String,
        lifecycle: String,
        pending_conclusion: Option<String>,
        cancel_requested_at: Option<i64>,
        closure_conclusion: Option<String>,
        closure_summary: Option<String>,
        accepted_deliverable_ids_json: String,
        active_execution_ids_json: String,
        progress_summary: Option<String>,
        watch_rule_json: Option<String>,
        deadline_at: Option<i64>,
        deadline_revision: i64,
        deadline_set_at: Option<i64>,
        causal_policy_json: String,
        state_version: i64,
        created_by: String,
        created_at: i64,
        updated_at: i64,
        closed_at: Option<i64>,
        close_operation_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkUpdate {
        work_id: String,
        project_id: Option<String>,
        workspace_path: Option<String>,
        source_message_id: Option<String>,
        legacy_task_id: Option<String>,
        owner_bot_id: String,
        owner_epoch: i64,
        intent_revision: i64,
        source_version: i64,
        title: String,
        goal_description: Option<String>,
        constraints_json: String,
        criteria_json: String,
        authorization_json: String,
        active_intent_snapshot_id: String,
        input_snapshot_id: String,
        goal_sources_json: String,
        mode: String,
        lifecycle: String,
        pending_conclusion: Option<String>,
        cancel_requested_at: Option<i64>,
        closure_conclusion: Option<String>,
        closure_summary: Option<String>,
        accepted_deliverable_ids_json: String,
        active_execution_ids_json: String,
        progress_summary: Option<String>,
        watch_rule_json: Option<String>,
        deadline_at: Option<i64>,
        deadline_revision: i64,
        deadline_set_at: Option<i64>,
        causal_policy_json: String,
        state_version: i64,
        updated_at: i64,
        closed_at: Option<i64>,
        close_operation_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkGoalSourceInsert {
        work_id: String,
        source_json: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkConversationLink {
        work_id: String,
        conversation_id: String,
        channel_type: String,
        last_referenced_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkIntentSnapshotInsert {
        snapshot_id: String,
        work_id: String,
        intent_revision: i64,
        source_version: i64,
        title: String,
        goal_description: Option<String>,
        constraints_json: String,
        criteria_json: String,
        authorization_json: String,
        expert_snapshot_json: String,
        input_snapshot_id: String,
        goal_sources_json: String,
        created_by: String,
        source_message_id: Option<String>,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkParticipantUpsert {
        work_id: String,
        bot_id: String,
        role: String,
        delegated_scope_json: String,
        expert_snapshot_json: String,
        added_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkParticipantDelete { work_id: String, bot_id: String },
    #[serde(rename_all = "camelCase")]
    WorkReceiptInsert {
        user_id: String,
        operation_id: String,
        work_id: Option<String>,
        operation_type: String,
        payload_hash: String,
        result_snapshot_json: String,
        outbox_event_id: Option<String>,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkBindingInsert {
        binding_id: String,
        work_id: String,
        operation_id: String,
        bot_id: String,
        task_id: String,
        durable_store_key: String,
        conversation_id: String,
        intent_revision: i64,
        owner_epoch: i64,
        input_snapshot_id: String,
        expert_snapshot_json: String,
        delegated_scope_json: String,
        workspace_binding: String,
        status: String,
        attempt_id: Option<String>,
        submission_receipt: Option<String>,
        settlement_note: Option<String>,
        admitted_at: i64,
        submitted_at: Option<i64>,
        invalidated_at: Option<i64>,
        settled_at: Option<i64>,
        inbox_event_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkBindingUpdate {
        binding_id: String,
        status: String,
        attempt_id: Option<String>,
        submission_receipt: Option<String>,
        settlement_note: Option<String>,
        submitted_at: Option<i64>,
        invalidated_at: Option<i64>,
        settled_at: Option<i64>,
        inbox_event_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkAdmissionInsert {
        admission_id: String,
        work_id: String,
        binding_id: Option<String>,
        operation_id: String,
        action_kind: String,
        state: String,
        intent_revision: i64,
        owner_epoch: i64,
        admitted_at: i64,
        settled_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkAdmissionUpdateState {
        admission_id: String,
        state: String,
        settled_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkDeliverableInsert {
        deliverable_id: String,
        work_id: String,
        producer_bot_id: String,
        execution_id: String,
        intent_revision: i64,
        owner_epoch: i64,
        input_snapshot_id: String,
        status: String,
        summary: String,
        artifact_refs_json: String,
        evidence_refs_json: String,
        uncovered_scope_json: String,
        uncovered_criterion_ids_json: String,
        is_speculation: i64,
        has_write_conflicts: i64,
        rejected_reason: Option<String>,
        created_at: i64,
        reviewed_at: Option<i64>,
        reviewed_by_bot_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkDeliverableUpdateReview {
        deliverable_id: String,
        status: String,
        reviewed_at: Option<i64>,
        reviewed_by_bot_id: Option<String>,
        rejected_reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkDeliverablesSupersedeProposed {
        work_id: String,
        intent_revision: i64,
        input_snapshot_id: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkEvidenceInsert {
        evidence_id: String,
        work_id: String,
        deliverable_id: Option<String>,
        execution_id: Option<String>,
        criterion_ids_json: String,
        kind: String,
        provenance: String,
        source_ref: String,
        source_sha: Option<String>,
        input_snapshot_id: String,
        environment: Option<String>,
        intent_revision: i64,
        detail: Option<String>,
        recorded_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkBlockerInsert {
        blocker_id: String,
        work_id: String,
        reported_by_bot_id: Option<String>,
        reason: String,
        kind: String,
        unknown_external_effect_ref: Option<String>,
        reason_code: Option<String>,
        details_json: String,
        source_ref: Option<String>,
        subscription_id: Option<String>,
        causal_chain_id: Option<String>,
        waiting_for_user_input: i64,
        status: String,
        created_at: i64,
        cleared_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkBlockerUpdate {
        blocker_id: String,
        work_id: String,
        mode: String,
        reason: Option<String>,
        details_json: Option<String>,
        source_ref: Option<String>,
        subscription_id: Option<String>,
        causal_chain_id: Option<String>,
        cleared_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkSubscriptionUpsert {
        subscription_id: String,
        work_id: String,
        source: String,
        filter_json: String,
        catch_up_policy: String,
        max_merge_wait_ms: i64,
        max_queue_depth: i64,
        stop_condition_text: Option<String>,
        timezone: Option<String>,
        cron_expression: Option<String>,
        next_wake_at: Option<i64>,
        last_processed_source_version: Option<String>,
        schedule_revision: i64,
        config_revision: i64,
        source_target: Option<String>,
        version_mode: String,
        dst_policy: String,
        max_backlog_events: i64,
        max_backlog_bytes: i64,
        last_checked_at: Option<i64>,
        stopped_reason: Option<String>,
        config_json: String,
        created_at: i64,
        updated_at: i64,
        stopped_at: Option<i64>,
        is_update: bool,
    },
    #[serde(rename_all = "camelCase")]
    WorkSubscriptionsStopForWork { work_id: String, now: i64 },
    #[serde(rename_all = "camelCase")]
    WorkSourceEventInsert {
        source: String,
        source_event_id: String,
        event_type: String,
        source_version: Option<String>,
        causal_event_id: Option<String>,
        payload_json: String,
        received_at: i64,
        occurred_at: Option<i64>,
        target_key: Option<String>,
        payload_bytes: i64,
        adapter: Option<String>,
        trusted_origin: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkInboxInsert {
        event_id: String,
        dedupe_key: String,
        source: String,
        source_event_id: String,
        event_type: String,
        work_id: String,
        subscription_id: Option<String>,
        intent_revision: i64,
        state_version: i64,
        owner_epoch: i64,
        source_version: Option<String>,
        causal_event_id: Option<String>,
        payload_json: String,
        status: String,
        merged_count: i64,
        merge_deadline_at: Option<i64>,
        received_at: i64,
        processed_at: Option<i64>,
        batch_id: Option<String>,
        batch_deadline_at: Option<i64>,
        frozen_at: Option<i64>,
        frozen_payload_json: Option<String>,
        claim_version: i64,
        target_key: Option<String>,
        process_reason: Option<String>,
        queued_while_paused: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkInboxUpdate {
        mode: String,
        event_id: Option<String>,
        subscription_id: Option<String>,
        work_id: Option<String>,
        event_type: Option<String>,
        source_version: Option<String>,
        causal_event_id: Option<String>,
        payload_json: Option<String>,
        status: Option<String>,
        merge_deadline_at: Option<i64>,
        merged_count: Option<i64>,
        target_key: Option<String>,
        batch_id: Option<String>,
        batch_deadline_at: Option<i64>,
        now: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkOutboxInsert {
        event_id: String,
        dedupe_key: String,
        event_type: String,
        work_id: String,
        binding_id: Option<String>,
        intent_revision: i64,
        state_version: i64,
        owner_epoch: i64,
        request_id: String,
        causal_event_id: Option<String>,
        payload_json: String,
        delivery_status: String,
        attempt_id: Option<String>,
        attempt_count: i64,
        created_at: i64,
        delivered_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkOutboxUpdate {
        event_id: String,
        mode: String,
        attempt_id: Option<String>,
        status: Option<String>,
        now: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkNotificationInsert {
        notification_id: String,
        work_id: String,
        semantic_key: String,
        kind: String,
        title: String,
        body: Option<String>,
        state_version: i64,
        intent_revision: i64,
        delivery: String,
        channel: Option<String>,
        idempotency_key: Option<String>,
        attempt_count: i64,
        external_receipt: Option<String>,
        read_at: Option<i64>,
        created_at: i64,
        sent_at: Option<i64>,
        card_key: Option<String>,
        effect_key: Option<String>,
        target_key: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkNotificationUpdate {
        notification_id: String,
        mode: String,
        delivery: Option<String>,
        channel: Option<String>,
        attempt_count: Option<i64>,
        external_receipt: Option<String>,
        sent_at: Option<i64>,
        idempotency_key: Option<String>,
        card_key: Option<String>,
        effect_key: Option<String>,
        target_key: Option<String>,
        read_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkNotificationIdentityUpdate {
        mode: String,
        work_id: Option<String>,
        notification_id: Option<String>,
        intent_revision: Option<i64>,
        input_snapshot_id: Option<String>,
        owner_epoch: Option<i64>,
        sender_bot_id: Option<String>,
        semantic_validity: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkNotificationEffectInsert {
        effect_key: String,
        notification_id: String,
        payload_hash: String,
        payload_json: String,
        channel: String,
        target_key: Option<String>,
        delivery_guarantee: String,
        supports_idempotency_key: i64,
        supports_receipt_query: i64,
        authorization_kind: String,
        authorization_operation_id: String,
        authorization_reason: Option<String>,
        resend_of_attempt_id: Option<String>,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkNotificationAttemptWrite {
        mode: String,
        attempt_id: String,
        notification_id: Option<String>,
        ordinal: Option<i64>,
        channel: Option<String>,
        idempotency_key: Option<String>,
        provider_effect_key: Option<String>,
        payload_hash: Option<String>,
        delivery_guarantee: Option<String>,
        claim_generation: Option<i64>,
        payload_json: Option<String>,
        status: Option<String>,
        now: Option<i64>,
        receipt: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkTelemetryUpsert {
        work_id: String,
        execution_id: Option<String>,
        streaming_text: Option<String>,
        tokens_per_second: Option<f64>,
        now: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkExecMetricsBegin {
        binding_id: String,
        task_id: String,
        conversation_id: String,
        started_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkExecMetricsUsageUpsert {
        binding_id: String,
        call_key: String,
        value_json: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkExecMetricsTimingUpsert {
        binding_id: String,
        message_id: String,
        value_json: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkExecMetricsSetValue {
        binding_id: String,
        value_json: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkExecMetricsClearDirty { binding_id: String },
    #[serde(rename_all = "camelCase")]
    WorkProjectionStreamEnsure { user_id: String },
    #[serde(rename_all = "camelCase")]
    WorkResultCardInsert {
        card_key: String,
        semantic_card_key: String,
        work_id: String,
        user_id: String,
        kind: String,
        intent_revision: i64,
        input_snapshot_id: String,
        origin_owner_epoch: i64,
        canonical_outcome_hash: String,
        canonical_outcome_json: String,
        title: String,
        summary: String,
        deliverable_ids_json: String,
        evidence_ids_json: String,
        source_refs_json: String,
        artifact_refs_json: String,
        unverified_scope_json: String,
        created_at: i64,
        previous_card_key: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkResultCardMarkRead { card_key: String, user_id: String, read_at: i64 },
    #[serde(rename_all = "camelCase")]
    WorkOwnerSummaryUpsert {
        work_id: String,
        intent_revision: i64,
        input_snapshot_id: String,
        owner_epoch: i64,
        digest: String,
        card_key: Option<String>,
        pending_decision_codes_json: String,
        handled_watermark_json: String,
        updated_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkRecordArchiveWrite {
        work_id: String,
        mode: String,
        archived_at: Option<i64>,
        deleted_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkSourceAssociationInsert {
        user_id: String,
        source_key: String,
        source_version: String,
        work_id: String,
        previous_work_id: Option<String>,
        source_revision: Option<i64>,
        observed_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkSubitemResultWrite {
        fact_id: String,
        work_id: String,
        binding_id: String,
        item_id: String,
        result_json: String,
        deliverable_id: Option<String>,
        created_at: i64,
        overwrite: bool,
    },
    #[serde(rename_all = "camelCase")]
    WorkContinuationPlanWrite {
        mode: String,
        plan_id: Option<String>,
        work_id: Option<String>,
        source_binding_id: Option<String>,
        operation_id: Option<String>,
        intent_revision: Option<i64>,
        input_snapshot_id: Option<String>,
        owner_epoch: Option<i64>,
        owner_bot_id: Option<String>,
        gap_items_json: Option<String>,
        reason: Option<String>,
        created_at: Option<i64>,
        task_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkContinuationGapInsert { gap_key: String, plan_id: String },
    #[serde(rename_all = "camelCase")]
    WorkDispatchRequestUpdate {
        mode: String,
        plan_id: Option<String>,
        bot_id: Option<String>,
        work_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkAutoRecoveryInsert {
        source_binding_id: String,
        plan_id: String,
        fingerprint: String,
        mode: String,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkTerminalEvidenceReadUpsert { binding_id: String },
    #[serde(rename_all = "camelCase")]
    WorkAutoCompletionWrite {
        mode: String,
        binding_id: Option<String>,
        work_id: Option<String>,
        summary: Option<String>,
        outcome: Option<String>,
        goal_reviewed: Option<i64>,
        fingerprint: Option<String>,
        now: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkArtifactDependencyWrite {
        mode: String,
        binding_id: String,
        path: String,
        work_id: Option<String>,
        fingerprint_json: Option<String>,
        now: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkGeneratedArtifactUpsert {
        binding_id: String,
        path: String,
        digest: String,
        payload_json: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkContinuationProgressUpsert {
        binding_id: String,
        work_id: String,
        intent_revision: i64,
        input_snapshot_id: String,
        fingerprint: String,
        recorded_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkCausalChainInsert {
        chain_id: String,
        root_event_id: String,
        parent_chain_id: Option<String>,
        parent_causal_event_id: Option<String>,
        origin_work_id: String,
        origin_bot_id: Option<String>,
        target_work_id: String,
        target_subscription_id: Option<String>,
        source: String,
        source_event_id: String,
        input_snapshot_id: String,
        target_state_hash: String,
        depth: i64,
        hops: i64,
        dispatch_count: i64,
        admission_key: String,
        decision: String,
        reason_code: Option<String>,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkClosureReviewCorrectionInsert {
        operation_id: String,
        work_id: String,
        binding_id: String,
        original_close_operation_id: String,
        original_conclusion: String,
        original_summary: Option<String>,
        original_closed_at: i64,
        evidence_json: String,
        decision_json: String,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkCollaborationMessageInsert {
        message_id: String,
        work_id: String,
        sender_bot_id: Option<String>,
        sender_kind: String,
        user_id: String,
        kind: String,
        payload_hash: String,
        payload_json: String,
        intent_revision: i64,
        input_snapshot_id: String,
        owner_epoch: i64,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkHandoffPreparationInsert {
        preparation_id: String,
        work_id: String,
        target_bot_id: String,
        state_version: i64,
        owner_epoch: i64,
        input_snapshot_id: String,
        snapshot_json: String,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkDelegationAdoptionInsert {
        binding_id: String,
        owner_epoch: i64,
        adopted_by_bot_id: String,
        intent_revision: i64,
        input_snapshot_id: String,
        delegated_scope_json: String,
        operation_id: String,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkNativeInboxWrite {
        mode: String,
        fact_id: String,
        binding_id: Option<String>,
        namespace_hash: Option<String>,
        payload_json: Option<String>,
        now: Option<i64>,
        consume_error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkNativeRecoveryWrite {
        mode: String,
        binding_id: String,
        now: Option<i64>,
        last_error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkReportContextInsert {
        binding_id: String,
        work_id: String,
        task_id: String,
        intent_revision: i64,
        owner_epoch: i64,
        input_snapshot_id: String,
        context_json: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkSubscriptionCursorUpsert {
        subscription_id: String,
        source: String,
        target_key: String,
        highest_accepted_version: Option<String>,
        highest_consumed_version: Option<String>,
        highest_frozen_version: Option<String>,
        replay_cursor: Option<String>,
        enumeration_watermark: Option<String>,
        accepted_events: i64,
        consumed_events: i64,
        accepted_bytes: i64,
        updated_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkIngressRouteWrite {
        mode: String,
        source: Option<String>,
        source_event_id: Option<String>,
        subscription_id: String,
        work_id: Option<String>,
        target_key: Option<String>,
        inbox_event_id: Option<String>,
        state: Option<String>,
        reason_code: Option<String>,
        source_version: Option<String>,
        trust: Option<String>,
        accepted_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkPausedSourceRouteWrite {
        source: String,
        source_event_id: String,
        subscription_id: String,
        catch_up_policy: String,
        inbox_event_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkScheduleTickWrite {
        mode: String,
        tick_id: Option<String>,
        subscription_id: Option<String>,
        work_id: Option<String>,
        schedule_revision: Option<i64>,
        logical_slot_key: Option<String>,
        planned_at: Option<i64>,
        effective_at: Option<i64>,
        status: Option<String>,
        inbox_event_id: Option<String>,
        merged_from_slot_keys_json: Option<String>,
        created_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    WorkDeadlineInstanceWrite {
        mode: String,
        work_id: String,
        deadline_revision: Option<i64>,
        deadline_at: Option<i64>,
        state: Option<String>,
        inbox_event_id: Option<String>,
        now: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkOfflineGapWrite {
        mode: String,
        gap_id: Option<String>,
        host_session_id: Option<String>,
        subscription_id: Option<String>,
        work_id: Option<String>,
        offline_gap_from: Option<i64>,
        offline_gap_to: Option<i64>,
        detected_by: Option<String>,
        confidence: Option<String>,
        policy: Option<String>,
        policy_revision: Option<i64>,
        source_cursor: Option<String>,
        queryable: Option<i64>,
        recovered_count_delta: Option<i64>,
        merged_count_delta: Option<i64>,
        skipped_count: Option<i64>,
        unknown_count: Option<i64>,
        state: Option<String>,
        continuation_cursor: Option<String>,
        gap_reason: Option<String>,
        next_wake_at: Option<i64>,
        now: i64,
    },
    #[serde(rename_all = "camelCase")]
    WorkWatchHostStateWrite {
        mode: String,
        authority_id: String,
        session_id: Option<String>,
        last_scan_at: Option<i64>,
        last_scan_cursor: Option<String>,
        active_since: Option<i64>,
        last_seen_at: Option<i64>,
        suspend_evidence: Option<String>,
        stopped_at: Option<i64>,
        updated_at: i64,
    },
}

fn has_column(conn: &Connection, table: &str, col: &str) -> Result<bool> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='main' AND table_name=?1 AND column_name=?2",
        params![table, col],
        |row| row.get(0),
    )?;
    Ok(found > 0)
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    crate::database::table_exists(conn, table)
}

pub fn apply_tx(tx: &Transaction<'_>, op: WorkOp) -> Result<Value> {
    let conn: &Connection = tx;
    match op {
        WorkOp::WorkInsert {
            work_id,
            user_id,
            project_id,
            workspace_path,
            source_message_id,
            legacy_task_id,
            owner_bot_id,
            owner_epoch,
            intent_revision,
            source_version,
            title,
            goal_description,
            constraints_json,
            criteria_json,
            authorization_json,
            active_intent_snapshot_id,
            input_snapshot_id,
            goal_sources_json,
            mode,
            lifecycle,
            pending_conclusion,
            cancel_requested_at,
            closure_conclusion,
            closure_summary,
            accepted_deliverable_ids_json,
            active_execution_ids_json,
            progress_summary,
            watch_rule_json,
            deadline_at,
            deadline_revision,
            deadline_set_at,
            causal_policy_json,
            state_version,
            created_by,
            created_at,
            updated_at,
            closed_at,
            close_operation_id,
        } => {
            let has_budget = has_column(conn, "works", "budget_json")?;
            let (cols, vals) = if has_budget {
                (",budget_json", ",'{}'")
            } else {
                ("", "")
            };
            conn.execute(
                &format!(
                    "INSERT INTO works (
                        work_id,user_id,project_id,workspace_path,source_message_id,legacy_task_id,
                        owner_bot_id,owner_epoch,intent_revision,source_version,title,goal_description,
                        constraints_json,criteria_json,authorization_json,active_intent_snapshot_id,
                        input_snapshot_id,goal_sources_json,mode,lifecycle,pending_conclusion,cancel_requested_at,
                        closure_conclusion,closure_summary,accepted_deliverable_ids_json,active_execution_ids_json,
                        progress_summary,watch_rule_json,deadline_at,deadline_revision,deadline_set_at,
                        causal_policy_json,state_version,created_by,created_at,updated_at,closed_at,close_operation_id{cols}
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38{vals})"
                ),
                params![
                    work_id, user_id, project_id, workspace_path, source_message_id, legacy_task_id,
                    owner_bot_id, owner_epoch, intent_revision, source_version, title, goal_description,
                    constraints_json, criteria_json, authorization_json, active_intent_snapshot_id,
                    input_snapshot_id, goal_sources_json, mode, lifecycle, pending_conclusion, cancel_requested_at,
                    closure_conclusion, closure_summary, accepted_deliverable_ids_json, active_execution_ids_json,
                    progress_summary, watch_rule_json, deadline_at, deadline_revision, deadline_set_at,
                    causal_policy_json, state_version, created_by, created_at, updated_at, closed_at, close_operation_id
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkUpdate {
            work_id,
            project_id,
            workspace_path,
            source_message_id,
            legacy_task_id,
            owner_bot_id,
            owner_epoch,
            intent_revision,
            source_version,
            title,
            goal_description,
            constraints_json,
            criteria_json,
            authorization_json,
            active_intent_snapshot_id,
            input_snapshot_id,
            goal_sources_json,
            mode,
            lifecycle,
            pending_conclusion,
            cancel_requested_at,
            closure_conclusion,
            closure_summary,
            accepted_deliverable_ids_json,
            active_execution_ids_json,
            progress_summary,
            watch_rule_json,
            deadline_at,
            deadline_revision,
            deadline_set_at,
            causal_policy_json,
            state_version,
            updated_at,
            closed_at,
            close_operation_id,
        } => {
            conn.execute(
                "UPDATE works SET
                    project_id=?1, workspace_path=?2, source_message_id=?3, legacy_task_id=?4,
                    owner_bot_id=?5, owner_epoch=?6, intent_revision=?7, source_version=?8,
                    title=?9, goal_description=?10, constraints_json=?11, criteria_json=?12,
                    authorization_json=?13, active_intent_snapshot_id=?14, input_snapshot_id=?15,
                    goal_sources_json=?16, mode=?17, lifecycle=?18, pending_conclusion=?19,
                    cancel_requested_at=?20, closure_conclusion=?21, closure_summary=?22,
                    accepted_deliverable_ids_json=?23, active_execution_ids_json=?24,
                    progress_summary=?25, watch_rule_json=?26, deadline_at=?27,
                    deadline_revision=?28, deadline_set_at=?29, causal_policy_json=?30,
                    state_version=?31, updated_at=?32, closed_at=?33, close_operation_id=?34
                 WHERE work_id=?35",
                params![
                    project_id, workspace_path, source_message_id, legacy_task_id, owner_bot_id, owner_epoch,
                    intent_revision, source_version, title, goal_description, constraints_json, criteria_json,
                    authorization_json, active_intent_snapshot_id, input_snapshot_id, goal_sources_json, mode,
                    lifecycle, pending_conclusion, cancel_requested_at, closure_conclusion, closure_summary,
                    accepted_deliverable_ids_json, active_execution_ids_json, progress_summary, watch_rule_json,
                    deadline_at, deadline_revision, deadline_set_at, causal_policy_json, state_version,
                    updated_at, closed_at, close_operation_id, work_id
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkGoalSourceInsert {
            work_id,
            source_json,
        } => {
            conn.execute(
                "INSERT INTO conversation_goal_sources VALUES(?1,?2)",
                params![work_id, source_json],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkConversationLink {
            work_id,
            conversation_id,
            channel_type,
            last_referenced_at,
        } => {
            conn.execute(
                "INSERT INTO work_conversations (work_id,conversation_id,channel_type,last_referenced_at)
                 VALUES (?1,?2,?3,?4)
                 ON CONFLICT(work_id,conversation_id) DO UPDATE SET
                   channel_type=excluded.channel_type, last_referenced_at=excluded.last_referenced_at",
                params![work_id, conversation_id, channel_type, last_referenced_at],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkIntentSnapshotInsert {
            snapshot_id,
            work_id,
            intent_revision,
            source_version,
            title,
            goal_description,
            constraints_json,
            criteria_json,
            authorization_json,
            expert_snapshot_json,
            input_snapshot_id,
            goal_sources_json,
            created_by,
            source_message_id,
            created_at,
        } => {
            conn.execute(
                "INSERT INTO work_intent_snapshots (
                    snapshot_id,work_id,intent_revision,source_version,title,goal_description,constraints_json,
                    criteria_json,authorization_json,expert_snapshot_json,input_snapshot_id,goal_sources_json,
                    created_by,source_message_id,created_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                params![
                    snapshot_id, work_id, intent_revision, source_version, title, goal_description,
                    constraints_json, criteria_json, authorization_json, expert_snapshot_json,
                    input_snapshot_id, goal_sources_json, created_by, source_message_id, created_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkParticipantUpsert {
            work_id,
            bot_id,
            role,
            delegated_scope_json,
            expert_snapshot_json,
            added_at,
        } => {
            conn.execute(
                "INSERT INTO work_participants (work_id,bot_id,role,delegated_scope_json,expert_snapshot_json,added_at)
                 VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(work_id,bot_id) DO UPDATE SET
                   role=excluded.role, delegated_scope_json=excluded.delegated_scope_json,
                   expert_snapshot_json=excluded.expert_snapshot_json",
                params![work_id, bot_id, role, delegated_scope_json, expert_snapshot_json, added_at],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkParticipantDelete { work_id, bot_id } => {
            conn.execute(
                "DELETE FROM work_participants WHERE work_id=?1 AND bot_id=?2",
                params![work_id, bot_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkReceiptInsert {
            user_id,
            operation_id,
            work_id,
            operation_type,
            payload_hash,
            result_snapshot_json,
            outbox_event_id,
            created_at,
        } => {
            conn.execute(
                "INSERT INTO work_operation_receipts
                 (user_id,operation_id,work_id,operation_type,payload_hash,result_snapshot_json,outbox_event_id,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    user_id, operation_id, work_id, operation_type, payload_hash,
                    result_snapshot_json, outbox_event_id, created_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkBindingInsert {
            binding_id,
            work_id,
            operation_id,
            bot_id,
            task_id,
            durable_store_key,
            conversation_id,
            intent_revision,
            owner_epoch,
            input_snapshot_id,
            expert_snapshot_json,
            delegated_scope_json,
            workspace_binding,
            status,
            attempt_id,
            submission_receipt,
            settlement_note,
            admitted_at,
            submitted_at,
            invalidated_at,
            settled_at,
            inbox_event_id,
        } => {
            conn.execute(
                "INSERT INTO work_execution_bindings (
                    binding_id,work_id,operation_id,bot_id,task_id,durable_store_key,conversation_id,intent_revision,
                    owner_epoch,input_snapshot_id,expert_snapshot_json,delegated_scope_json,workspace_binding,
                    status,attempt_id,submission_receipt,settlement_note,admitted_at,submitted_at,invalidated_at,settled_at,inbox_event_id
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
                params![
                    binding_id, work_id, operation_id, bot_id, task_id, durable_store_key, conversation_id,
                    intent_revision, owner_epoch, input_snapshot_id, expert_snapshot_json, delegated_scope_json,
                    workspace_binding, status, attempt_id, submission_receipt, settlement_note, admitted_at,
                    submitted_at, invalidated_at, settled_at, inbox_event_id
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkBindingUpdate {
            binding_id,
            status,
            attempt_id,
            submission_receipt,
            settlement_note,
            submitted_at,
            invalidated_at,
            settled_at,
            inbox_event_id,
        } => {
            conn.execute(
                "UPDATE work_execution_bindings SET status=?1, attempt_id=?2,
                 submission_receipt=?3, settlement_note=?4, submitted_at=?5,
                 invalidated_at=?6, settled_at=?7, inbox_event_id=?8 WHERE binding_id=?9",
                params![
                    status, attempt_id, submission_receipt, settlement_note,
                    submitted_at, invalidated_at, settled_at, inbox_event_id, binding_id
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkAdmissionInsert {
            admission_id,
            work_id,
            binding_id,
            operation_id,
            action_kind,
            state,
            intent_revision,
            owner_epoch,
            admitted_at,
            settled_at,
        } => {
            conn.execute(
                "INSERT INTO work_action_admissions
                 (admission_id,work_id,binding_id,operation_id,action_kind,state,intent_revision,owner_epoch,admitted_at,settled_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    admission_id, work_id, binding_id, operation_id, action_kind,
                    state, intent_revision, owner_epoch, admitted_at, settled_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkAdmissionUpdateState {
            admission_id,
            state,
            settled_at,
        } => {
            conn.execute(
                "UPDATE work_action_admissions SET state=?1, settled_at=?2 WHERE admission_id=?3",
                params![state, settled_at, admission_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkDeliverableInsert {
            deliverable_id,
            work_id,
            producer_bot_id,
            execution_id,
            intent_revision,
            owner_epoch,
            input_snapshot_id,
            status,
            summary,
            artifact_refs_json,
            evidence_refs_json,
            uncovered_scope_json,
            uncovered_criterion_ids_json,
            is_speculation,
            has_write_conflicts,
            rejected_reason,
            created_at,
            reviewed_at,
            reviewed_by_bot_id,
        } => {
            conn.execute(
                "INSERT INTO work_deliverables (
                    deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,
                    status,summary,artifact_refs_json,evidence_refs_json,uncovered_scope_json,uncovered_criterion_ids_json,is_speculation,
                    has_write_conflicts,rejected_reason,created_at,reviewed_at,reviewed_by_bot_id
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
                params![
                    deliverable_id, work_id, producer_bot_id, execution_id, intent_revision, owner_epoch,
                    input_snapshot_id, status, summary, artifact_refs_json, evidence_refs_json,
                    uncovered_scope_json, uncovered_criterion_ids_json, is_speculation, has_write_conflicts,
                    rejected_reason, created_at, reviewed_at, reviewed_by_bot_id
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkDeliverableUpdateReview {
            deliverable_id,
            status,
            reviewed_at,
            reviewed_by_bot_id,
            rejected_reason,
        } => {
            conn.execute(
                "UPDATE work_deliverables SET status=?1, reviewed_at=?2,
                 reviewed_by_bot_id=?3, rejected_reason=?4 WHERE deliverable_id=?5",
                params![status, reviewed_at, reviewed_by_bot_id, rejected_reason, deliverable_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkDeliverablesSupersedeProposed {
            work_id,
            intent_revision,
            input_snapshot_id,
        } => {
            conn.execute(
                "UPDATE work_deliverables SET status='superseded'
                 WHERE work_id=?1 AND status='proposed' AND (
                   intent_revision != ?2 OR input_snapshot_id != ?3 OR EXISTS (
                     SELECT 1 FROM work_execution_bindings b
                     WHERE b.binding_id=work_deliverables.execution_id AND b.work_id=work_deliverables.work_id
                       AND (b.invalidated_at IS NOT NULL OR b.status='invalidated')
                   )
                 )",
                params![work_id, intent_revision, input_snapshot_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkEvidenceInsert {
            evidence_id,
            work_id,
            deliverable_id,
            execution_id,
            criterion_ids_json,
            kind,
            provenance,
            source_ref,
            source_sha,
            input_snapshot_id,
            environment,
            intent_revision,
            detail,
            recorded_at,
        } => {
            conn.execute(
                "INSERT INTO work_evidence (
                    evidence_id,work_id,deliverable_id,execution_id,criterion_ids_json,kind,provenance,source_ref,
                    source_sha,input_snapshot_id,environment,intent_revision,detail,recorded_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![
                    evidence_id, work_id, deliverable_id, execution_id, criterion_ids_json, kind, provenance,
                    source_ref, source_sha, input_snapshot_id, environment, intent_revision, detail, recorded_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkBlockerInsert {
            blocker_id,
            work_id,
            reported_by_bot_id,
            reason,
            kind,
            unknown_external_effect_ref,
            reason_code,
            details_json,
            source_ref,
            subscription_id,
            causal_chain_id,
            waiting_for_user_input,
            status,
            created_at,
            cleared_at,
        } => {
            conn.execute(
                "INSERT INTO work_blockers (
                    blocker_id,work_id,reported_by_bot_id,reason,kind,unknown_external_effect_ref,
                    reason_code,details_json,source_ref,subscription_id,causal_chain_id,
                    waiting_for_user_input,status,created_at,cleared_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                params![
                    blocker_id, work_id, reported_by_bot_id, reason, kind, unknown_external_effect_ref,
                    reason_code, details_json, source_ref, subscription_id, causal_chain_id,
                    waiting_for_user_input, status, created_at, cleared_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkBlockerUpdate {
            blocker_id,
            work_id,
            mode,
            reason,
            details_json,
            source_ref,
            subscription_id,
            causal_chain_id,
            cleared_at,
        } => {
            match mode.as_str() {
                "clear" => {
                    conn.execute(
                        "UPDATE work_blockers SET status='cleared', cleared_at=?1 WHERE blocker_id=?2 AND work_id=?3 AND status='open'",
                        params![cleared_at, blocker_id, work_id],
                    )?;
                }
                "respond" => {
                    conn.execute(
                        "UPDATE work_blockers SET details_json=?1,status='cleared',cleared_at=?2 WHERE blocker_id=?3 AND work_id=?4 AND status='open'",
                        params![details_json, cleared_at, blocker_id, work_id],
                    )?;
                }
                "reopen" => {
                    conn.execute(
                        "UPDATE work_blockers SET status='open',cleared_at=NULL WHERE blocker_id=?1 AND work_id=?2 AND kind!='external_effect' AND unknown_external_effect_ref IS NULL",
                        params![blocker_id, work_id],
                    )?;
                }
                "causalReopen" => {
                    conn.execute(
                        "UPDATE work_blockers SET reason=?1,details_json=?2,causal_chain_id=?3,status='open',cleared_at=NULL WHERE blocker_id=?4",
                        params![reason, details_json, causal_chain_id, blocker_id],
                    )?;
                }
                "gapReopen" => {
                    conn.execute(
                        "UPDATE work_blockers SET details_json=?1,source_ref=?2,subscription_id=?3,status='open',cleared_at=NULL WHERE blocker_id=?4",
                        params![details_json, source_ref, subscription_id, blocker_id],
                    )?;
                }
                other => return Err(format!("unknown WorkBlockerUpdate mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkSubscriptionUpsert {
            subscription_id,
            work_id,
            source,
            filter_json,
            catch_up_policy,
            max_merge_wait_ms,
            max_queue_depth,
            stop_condition_text,
            timezone,
            cron_expression,
            next_wake_at,
            last_processed_source_version,
            schedule_revision,
            config_revision,
            source_target,
            version_mode,
            dst_policy,
            max_backlog_events,
            max_backlog_bytes,
            last_checked_at,
            stopped_reason,
            config_json,
            created_at,
            updated_at,
            stopped_at,
            is_update,
        } => {
            if is_update {
                conn.execute(
                    "UPDATE work_subscriptions SET filter_json=?1, catch_up_policy=?2,
                     max_merge_wait_ms=?3, max_queue_depth=?4, stop_condition_text=?5,
                     timezone=?6, cron_expression=?7, next_wake_at=?8,
                     last_processed_source_version=?9, schedule_revision=?10,
                     config_revision=?11, source_target=?12, version_mode=?13,
                     dst_policy=?14, max_backlog_events=?15, max_backlog_bytes=?16,
                     last_checked_at=?17, stopped_reason=?18, config_json=?19,
                     updated_at=?20, stopped_at=?21 WHERE subscription_id=?22",
                    params![
                        filter_json, catch_up_policy, max_merge_wait_ms, max_queue_depth, stop_condition_text,
                        timezone, cron_expression, next_wake_at, last_processed_source_version,
                        schedule_revision, config_revision, source_target, version_mode, dst_policy,
                        max_backlog_events, max_backlog_bytes, last_checked_at, stopped_reason,
                        config_json, updated_at, stopped_at, subscription_id
                    ],
                )?;
            } else {
                conn.execute(
                    "INSERT INTO work_subscriptions (
                        subscription_id,work_id,source,filter_json,catch_up_policy,max_merge_wait_ms,max_queue_depth,
                        stop_condition_text,timezone,cron_expression,next_wake_at,last_processed_source_version,
                        schedule_revision,config_revision,source_target,version_mode,dst_policy,max_backlog_events,
                        max_backlog_bytes,last_checked_at,stopped_reason,config_json,created_at,updated_at,stopped_at
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
                    params![
                        subscription_id, work_id, source, filter_json, catch_up_policy, max_merge_wait_ms,
                        max_queue_depth, stop_condition_text, timezone, cron_expression, next_wake_at,
                        last_processed_source_version, schedule_revision, config_revision, source_target,
                        version_mode, dst_policy, max_backlog_events, max_backlog_bytes, last_checked_at,
                        stopped_reason, config_json, created_at, updated_at, stopped_at
                    ],
                )?;
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkSubscriptionsStopForWork { work_id, now } => {
            conn.execute(
                "UPDATE work_subscriptions SET stopped_at=?1, updated_at=?1 WHERE work_id=?2 AND stopped_at IS NULL",
                params![now, work_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkSourceEventInsert {
            source,
            source_event_id,
            event_type,
            source_version,
            causal_event_id,
            payload_json,
            received_at,
            occurred_at,
            target_key,
            payload_bytes,
            adapter,
            trusted_origin,
        } => {
            let changes = conn.execute(
                "INSERT INTO work_source_events
                 (source,source_event_id,event_type,source_version,causal_event_id,payload_json,received_at,
                  occurred_at,target_key,payload_bytes,adapter,trusted_origin)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT DO NOTHING",
                params![
                    source, source_event_id, event_type, source_version, causal_event_id, payload_json,
                    received_at, occurred_at, target_key, payload_bytes, adapter, trusted_origin
                ],
            )?;
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkInboxInsert {
            event_id,
            dedupe_key,
            source,
            source_event_id,
            event_type,
            work_id,
            subscription_id,
            intent_revision,
            state_version,
            owner_epoch,
            source_version,
            causal_event_id,
            payload_json,
            status,
            merged_count,
            merge_deadline_at,
            received_at,
            processed_at,
            batch_id,
            batch_deadline_at,
            frozen_at,
            frozen_payload_json,
            claim_version,
            target_key,
            process_reason,
            queued_while_paused,
        } => {
            let changes = conn.execute(
                "INSERT INTO work_events_inbox (
                    event_id,dedupe_key,source,source_event_id,event_type,work_id,subscription_id,intent_revision,
                    state_version,owner_epoch,source_version,causal_event_id,payload_json,status,merged_count,
                    merge_deadline_at,received_at,processed_at,batch_id,batch_deadline_at,frozen_at,frozen_payload_json,
                    claim_version,target_key,process_reason,queued_while_paused
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26) ON CONFLICT DO NOTHING",
                params![
                    event_id, dedupe_key, source, source_event_id, event_type, work_id, subscription_id,
                    intent_revision, state_version, owner_epoch, source_version, causal_event_id,
                    payload_json, status, merged_count, merge_deadline_at, received_at, processed_at,
                    batch_id, batch_deadline_at, frozen_at, frozen_payload_json, claim_version,
                    target_key, process_reason, queued_while_paused.unwrap_or(0)
                ],
            )?;
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkInboxUpdate {
            mode,
            event_id,
            subscription_id,
            work_id,
            event_type,
            source_version,
            causal_event_id,
            payload_json,
            status,
            merge_deadline_at,
            merged_count,
            target_key,
            batch_id,
            batch_deadline_at,
            now,
        } => {
            let changes = match mode.as_str() {
                "mergeLatest" => conn.execute(
                    "UPDATE work_events_inbox SET event_type=?1, source_version=?2, causal_event_id=?3,
                     payload_json=?4, status='merged', merged_count=merged_count+1 WHERE event_id=?5",
                    params![event_type, source_version, causal_event_id, payload_json, event_id],
                )?,
                "setStatus" => conn.execute(
                    "UPDATE work_events_inbox SET status=?1, processed_at=?2 WHERE event_id=?3",
                    params![status, now, event_id],
                )?,
                "freeze" => {
                    let c = conn.execute(
                        "UPDATE work_events_inbox SET frozen_at=?1,frozen_payload_json=payload_json,
                         claim_version=claim_version+1,process_reason='merge-deadline' WHERE event_id=?2 AND frozen_at IS NULL",
                        params![now, event_id],
                    )?;
                    conn.execute(
                        "UPDATE work_events_inbox SET batch_deadline_at=merge_deadline_at WHERE event_id=?1 AND batch_deadline_at IS NULL",
                        params![event_id],
                    )?;
                    c
                }
                "mergeOpenBatch" => conn.execute(
                    "UPDATE work_events_inbox SET event_type=?1,source_version=?2,source_event_id=COALESCE(?3,source_event_id),
                     causal_event_id=?4,payload_json=?5,merged_count=merged_count+1,target_key=?6 WHERE event_id=?7
                     AND frozen_at IS NULL AND status='merged'",
                    params![event_type, source_version, batch_id, causal_event_id, payload_json, target_key, event_id],
                )?,
                "refillBlocked" => conn.execute(
                    "UPDATE work_events_inbox SET status='pending',payload_json=?1,process_reason='backlog-refill'
                     WHERE event_id=?2 AND status='blocked'",
                    params![payload_json, event_id],
                )?,
                "markQueuedWhilePaused" => conn.execute(
                    "UPDATE work_events_inbox SET queued_while_paused=1 WHERE event_id=?1",
                    params![event_id],
                )?,
                "clearQueuedWhilePaused" => conn.execute(
                    "UPDATE work_events_inbox SET queued_while_paused=0 WHERE work_id=?1 AND subscription_id=?2",
                    params![work_id, subscription_id],
                )?,
                "mergePausedLatest" => conn.execute(
                    "UPDATE work_events_inbox SET payload_json=?1,status='merged',merge_deadline_at=?2,merged_count=?3,
                     target_key=?4,source_version=?5,batch_id=?6,batch_deadline_at=?7,claim_version=claim_version+1 WHERE event_id=?8",
                    params![payload_json, merge_deadline_at, merged_count, target_key, source_version, batch_id, batch_deadline_at, event_id],
                )?,
                "discardPendingSchedule" => conn.execute(
                    "UPDATE work_events_inbox SET status='skipped',processed_at=?1
                     WHERE subscription_id=?2 AND event_type='work.tick' AND status IN ('pending','merged','blocked')",
                    params![now, subscription_id],
                )?,
                "coalesceTick" => conn.execute(
                    "UPDATE work_events_inbox SET status='skipped',processed_at=?1,process_reason='schedule-latest-coalesced' WHERE event_id=?2",
                    params![now, event_id],
                )?,
                other => return Err(format!("unknown WorkInboxUpdate mode: {other}").into()),
            };
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkOutboxInsert {
            event_id,
            dedupe_key,
            event_type,
            work_id,
            binding_id,
            intent_revision,
            state_version,
            owner_epoch,
            request_id,
            causal_event_id,
            payload_json,
            delivery_status,
            attempt_id,
            attempt_count,
            created_at,
            delivered_at,
        } => {
            conn.execute(
                "INSERT INTO work_events_outbox (
                    event_id,dedupe_key,event_type,work_id,binding_id,intent_revision,state_version,owner_epoch,
                    request_id,causal_event_id,payload_json,delivery_status,attempt_id,attempt_count,created_at,delivered_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                params![
                    event_id, dedupe_key, event_type, work_id, binding_id, intent_revision, state_version,
                    owner_epoch, request_id, causal_event_id, payload_json, delivery_status, attempt_id,
                    attempt_count, created_at, delivered_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkOutboxUpdate {
            event_id,
            mode,
            attempt_id,
            status,
            now,
        } => {
            match mode.as_str() {
                "attempt" => {
                    conn.execute(
                        "UPDATE work_events_outbox SET delivery_status='attempted', attempt_id=?1, attempt_count=attempt_count+1 WHERE event_id=?2",
                        params![attempt_id, event_id],
                    )?;
                }
                "delivered" => {
                    conn.execute(
                        "UPDATE work_events_outbox SET delivery_status='delivered', delivered_at=?1 WHERE event_id=?2",
                        params![now, event_id],
                    )?;
                }
                "status" => {
                    conn.execute(
                        "UPDATE work_events_outbox SET delivery_status=?1 WHERE event_id=?2",
                        params![status, event_id],
                    )?;
                }
                other => return Err(format!("unknown WorkOutboxUpdate mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkNotificationInsert {
            notification_id,
            work_id,
            semantic_key,
            kind,
            title,
            body,
            state_version,
            intent_revision,
            delivery,
            channel,
            idempotency_key,
            attempt_count,
            external_receipt,
            read_at,
            created_at,
            sent_at,
            card_key,
            effect_key,
            target_key,
        } => {
            let changes = conn.execute(
                "INSERT INTO work_notifications (
                    notification_id,work_id,semantic_key,kind,title,body,state_version,intent_revision,delivery,
                    channel,idempotency_key,attempt_count,external_receipt,read_at,created_at,sent_at,card_key,effect_key,target_key
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19) ON CONFLICT DO NOTHING",
                params![
                    notification_id, work_id, semantic_key, kind, title, body, state_version, intent_revision,
                    delivery, channel, idempotency_key, attempt_count, external_receipt, read_at,
                    created_at, sent_at, card_key, effect_key, target_key
                ],
            )?;
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkNotificationUpdate {
            notification_id,
            mode,
            delivery,
            channel,
            attempt_count,
            external_receipt,
            sent_at,
            idempotency_key,
            card_key,
            effect_key,
            target_key,
            read_at,
        } => {
            match mode.as_str() {
                "links" => {
                    conn.execute(
                        "UPDATE work_notifications SET card_key=COALESCE(?1,card_key), effect_key=COALESCE(?2,effect_key),
                         target_key=COALESCE(?3,target_key) WHERE notification_id=?4",
                        params![card_key, effect_key, target_key, notification_id],
                    )?;
                }
                "delivery" => {
                    conn.execute(
                        "UPDATE work_notifications SET delivery=?1, channel=COALESCE(?2,channel),
                         attempt_count=COALESCE(?3,attempt_count), external_receipt=COALESCE(?4,external_receipt),
                         sent_at=COALESCE(?5,sent_at), idempotency_key=COALESCE(?6,idempotency_key) WHERE notification_id=?7",
                        params![delivery, channel, attempt_count, external_receipt, sent_at, idempotency_key, notification_id],
                    )?;
                }
                "read" => {
                    conn.execute(
                        "UPDATE work_notifications SET read_at=?1 WHERE notification_id=?2",
                        params![read_at, notification_id],
                    )?;
                }
                other => return Err(format!("unknown WorkNotificationUpdate mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkNotificationIdentityUpdate {
            mode,
            work_id,
            notification_id,
            intent_revision,
            input_snapshot_id,
            owner_epoch,
            sender_bot_id,
            semantic_validity,
        } => {
            match mode.as_str() {
                "supersedeByWork" => {
                    conn.execute(
                        "UPDATE work_notification_identity SET semantic_validity='superseded' WHERE notification_id IN (
                           SELECT n.notification_id FROM work_notifications n WHERE n.work_id=?1 AND n.kind='result'
                           AND (n.intent_revision<>?2 OR work_notification_identity.input_snapshot_id<>?3))",
                        params![work_id, intent_revision, input_snapshot_id],
                    )?;
                }
                "cancelPendingByWork" => {
                    conn.execute(
                        "UPDATE work_notification_identity SET semantic_validity='cancelled' WHERE notification_id IN (
                           SELECT notification_id FROM work_notifications WHERE work_id=?1 AND kind='result')",
                        params![work_id],
                    )?;
                }
                "setValidityByWork" => {
                    conn.execute(
                        "UPDATE work_notification_identity SET semantic_validity=?1 WHERE notification_id IN (
                           SELECT notification_id FROM work_notifications WHERE work_id=?2 AND kind='result')",
                        params![semantic_validity, work_id],
                    )?;
                }
                "supersedeAllByWork" => {
                    conn.execute(
                        "UPDATE work_notification_identity SET semantic_validity='superseded' WHERE notification_id IN (
                           SELECT notification_id FROM work_notifications WHERE work_id=?1)",
                        params![work_id],
                    )?;
                }
                "setOwner" => {
                    conn.execute(
                        "UPDATE work_notification_identity SET owner_epoch=?1,sender_bot_id=?2 WHERE notification_id=?3",
                        params![owner_epoch, sender_bot_id, notification_id],
                    )?;
                }
                "setValidity" => {
                    conn.execute(
                        "UPDATE work_notification_identity SET semantic_validity=?1 WHERE notification_id=?2",
                        params![semantic_validity, notification_id],
                    )?;
                }
                other => return Err(format!("unknown WorkNotificationIdentityUpdate mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkNotificationEffectInsert {
            effect_key,
            notification_id,
            payload_hash,
            payload_json,
            channel,
            target_key,
            delivery_guarantee,
            supports_idempotency_key,
            supports_receipt_query,
            authorization_kind,
            authorization_operation_id,
            authorization_reason,
            resend_of_attempt_id,
            created_at,
        } => {
            conn.execute(
                "INSERT INTO work_notification_effects (
                    effect_key,notification_id,payload_hash,payload_json,channel,target_key,delivery_guarantee,
                    supports_idempotency_key,supports_receipt_query,authorization_kind,authorization_operation_id,
                    authorization_reason,resend_of_attempt_id,created_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) ON CONFLICT DO NOTHING",
                params![
                    effect_key, notification_id, payload_hash, payload_json, channel, target_key,
                    delivery_guarantee, supports_idempotency_key, supports_receipt_query,
                    authorization_kind, authorization_operation_id, authorization_reason,
                    resend_of_attempt_id, created_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkNotificationAttemptWrite {
            mode,
            attempt_id,
            notification_id,
            ordinal,
            channel,
            idempotency_key,
            provider_effect_key,
            payload_hash,
            delivery_guarantee,
            claim_generation,
            payload_json,
            status,
            now,
            receipt,
        } => {
            let changes = match mode.as_str() {
                "insert" => conn.execute(
                    "INSERT INTO work_notification_attempts(attempt_id,notification_id,ordinal,channel,idempotency_key,
                     provider_effect_key,payload_hash,delivery_guarantee,claim_generation,payload_json,status,claimed_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'unknown',?11)",
                    params![
                        attempt_id, notification_id, ordinal, channel, idempotency_key,
                        provider_effect_key, payload_hash, delivery_guarantee, claim_generation,
                        payload_json, now
                    ],
                )?,
                "receiptProgress" => conn.execute(
                    "UPDATE work_notification_attempts SET receipt=?1 WHERE attempt_id=?2 AND status='unknown'
                     AND provider_effect_key=?3 AND claim_generation=?4 AND payload_hash=?5",
                    params![receipt, attempt_id, provider_effect_key, claim_generation, payload_hash],
                )?,
                "settle" => conn.execute(
                    "UPDATE work_notification_attempts SET status=?1,settled_at=?2,receipt=COALESCE(?3,receipt)
                     WHERE attempt_id=?4 AND status='unknown' AND claim_generation=?5 AND payload_hash=?6
                       AND provider_effect_key=?7 AND channel=?8",
                    params![
                        status, now, receipt, attempt_id, claim_generation.unwrap_or(1),
                        payload_hash, provider_effect_key, channel
                    ],
                )?,
                other => return Err(format!("unknown WorkNotificationAttemptWrite mode: {other}").into()),
            };
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkTelemetryUpsert {
            work_id,
            execution_id,
            streaming_text,
            tokens_per_second,
            now,
        } => {
            conn.execute(
                "INSERT INTO work_telemetry_state
                 (work_id,active_execution_id,streaming_text,tokens_per_second,last_heartbeat_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?5)
                 ON CONFLICT(work_id) DO UPDATE SET
                   active_execution_id=COALESCE(excluded.active_execution_id, work_telemetry_state.active_execution_id),
                   streaming_text=COALESCE(excluded.streaming_text, work_telemetry_state.streaming_text),
                   tokens_per_second=COALESCE(excluded.tokens_per_second, work_telemetry_state.tokens_per_second),
                   last_heartbeat_at=excluded.last_heartbeat_at, updated_at=excluded.updated_at",
                params![work_id, execution_id, streaming_text, tokens_per_second, now],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkExecMetricsBegin {
            binding_id,
            task_id,
            conversation_id,
            started_at,
        } => {
            conn.execute(
                "INSERT INTO work_execution_metrics(binding_id,task_id,conversation_id,started_at) VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                params![binding_id, task_id, conversation_id, started_at],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkExecMetricsUsageUpsert {
            binding_id,
            call_key,
            value_json,
        } => {
            conn.execute(
                "INSERT INTO work_execution_usage VALUES(?1,?2,?3)
                 ON CONFLICT(binding_id,call_key) DO UPDATE SET value_json=excluded.value_json",
                params![binding_id, call_key, value_json],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkExecMetricsTimingUpsert {
            binding_id,
            message_id,
            value_json,
        } => {
            conn.execute(
                "INSERT INTO work_execution_timings VALUES(?1,?2,?3)
                 ON CONFLICT(binding_id,message_id) DO UPDATE SET value_json=excluded.value_json",
                params![binding_id, message_id, value_json],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkExecMetricsSetValue {
            binding_id,
            value_json,
        } => {
            conn.execute(
                "UPDATE work_execution_metrics SET value_json=?1,dirty=1 WHERE binding_id=?2",
                params![value_json, binding_id],
            )?;
            if table_exists(conn, "work_projection_streams")? {
                if let Some((user_id, work_id)) = conn
                    .query_row(
                        "SELECT w.user_id,w.work_id FROM works w JOIN work_execution_bindings b ON b.work_id=w.work_id WHERE b.binding_id=?1",
                        [&binding_id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )
                    .optional()?
                {
                    conn.execute(
                        "INSERT INTO work_projection_streams(user_id) VALUES(?1) ON CONFLICT DO NOTHING",
                        [&user_id],
                    )?;
                    conn.execute(
                        "UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=?1",
                        [&user_id],
                    )?;
                    conn.execute(
                        "INSERT INTO work_projection_events(user_id,sequence,work_id) SELECT user_id,sequence,?1 FROM work_projection_streams WHERE user_id=?2",
                        params![work_id, user_id],
                    )?;
                }
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkExecMetricsClearDirty { binding_id } => {
            let changes = conn.execute(
                "UPDATE work_execution_metrics SET dirty=0 WHERE binding_id=?1 AND dirty=1",
                [binding_id],
            )?;
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkProjectionStreamEnsure { user_id } => {
            conn.execute(
                "INSERT INTO work_projection_streams(user_id) VALUES (?1) ON CONFLICT DO NOTHING",
                [user_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkResultCardInsert {
            card_key,
            semantic_card_key,
            work_id,
            user_id,
            kind,
            intent_revision,
            input_snapshot_id,
            origin_owner_epoch,
            canonical_outcome_hash,
            canonical_outcome_json,
            title,
            summary,
            deliverable_ids_json,
            evidence_ids_json,
            source_refs_json,
            artifact_refs_json,
            unverified_scope_json,
            created_at,
            previous_card_key,
        } => {
            conn.execute(
                "INSERT INTO work_result_cards (
                    card_key,semantic_card_key,work_id,user_id,kind,intent_revision,input_snapshot_id,origin_owner_epoch,
                    canonical_outcome_hash,canonical_outcome_json,title,summary,deliverable_ids_json,evidence_ids_json,
                    source_refs_json,artifact_refs_json,unverified_scope_json,created_at,previous_card_key,read_version
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,0) ON CONFLICT DO NOTHING",
                params![
                    card_key, semantic_card_key, work_id, user_id, kind, intent_revision, input_snapshot_id,
                    origin_owner_epoch, canonical_outcome_hash, canonical_outcome_json, title, summary,
                    deliverable_ids_json, evidence_ids_json, source_refs_json, artifact_refs_json,
                    unverified_scope_json, created_at, previous_card_key
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkResultCardMarkRead {
            card_key,
            user_id,
            read_at,
        } => {
            let changes = conn.execute(
                "UPDATE work_result_cards SET read_at=?1, read_by_user_id=?2, read_version=read_version+1
                 WHERE card_key=?3 AND (read_at IS NULL OR read_at < ?1)",
                params![read_at, user_id, card_key],
            )?;
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkOwnerSummaryUpsert {
            work_id,
            intent_revision,
            input_snapshot_id,
            owner_epoch,
            digest,
            card_key,
            pending_decision_codes_json,
            handled_watermark_json,
            updated_at,
        } => {
            conn.execute(
                "INSERT INTO work_owner_summaries (work_id,intent_revision,input_snapshot_id,owner_epoch,digest,
                 card_key,pending_decision_codes_json,handled_watermark_json,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(work_id) DO UPDATE SET
                 intent_revision=excluded.intent_revision, input_snapshot_id=excluded.input_snapshot_id,
                 owner_epoch=excluded.owner_epoch, digest=excluded.digest, card_key=excluded.card_key,
                 pending_decision_codes_json=excluded.pending_decision_codes_json,
                 handled_watermark_json=excluded.handled_watermark_json, updated_at=excluded.updated_at",
                params![
                    work_id, intent_revision, input_snapshot_id, owner_epoch, digest,
                    card_key, pending_decision_codes_json, handled_watermark_json, updated_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkRecordArchiveWrite {
            work_id,
            mode,
            archived_at,
            deleted_at,
        } => {
            match mode.as_str() {
                "clear" => {
                    conn.execute("DELETE FROM work_record_archive WHERE work_id=?1", [&work_id])?;
                }
                "archive" => {
                    conn.execute(
                        "INSERT INTO work_record_archive(work_id,archived_at) VALUES (?1,?2) ON CONFLICT(work_id) DO NOTHING",
                        params![work_id, archived_at],
                    )?;
                }
                "delete" => {
                    conn.execute(
                        "INSERT INTO work_record_archive(work_id,archived_at,deleted_at) VALUES (?1,?2,?3)
                         ON CONFLICT(work_id) DO UPDATE SET deleted_at=excluded.deleted_at",
                        params![work_id, archived_at, deleted_at],
                    )?;
                }
                "restore" => {
                    conn.execute(
                        "UPDATE work_record_archive SET deleted_at=NULL WHERE work_id=?1",
                        [&work_id],
                    )?;
                }
                other => return Err(format!("unknown WorkRecordArchiveWrite mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkSourceAssociationInsert {
            user_id,
            source_key,
            source_version,
            work_id,
            previous_work_id,
            source_revision,
            observed_at,
        } => {
            conn.execute(
                "INSERT INTO work_source_associations(user_id,source_key,source_version,work_id,previous_work_id,source_revision,observed_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    user_id, source_key, source_version, work_id, previous_work_id, source_revision, observed_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkSubitemResultWrite {
            fact_id,
            work_id,
            binding_id,
            item_id,
            result_json,
            deliverable_id,
            created_at,
            overwrite,
        } => {
            if overwrite {
                conn.execute(
                    "INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,deliverable_id,created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)
                     ON CONFLICT(fact_id) DO UPDATE SET result_json=excluded.result_json,deliverable_id=excluded.deliverable_id",
                    params![fact_id, work_id, binding_id, item_id, result_json, deliverable_id, created_at],
                )?;
            } else {
                conn.execute(
                    "INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
                    params![fact_id, work_id, binding_id, item_id, result_json, created_at],
                )?;
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkContinuationPlanWrite {
            mode,
            plan_id,
            work_id,
            source_binding_id,
            operation_id,
            intent_revision,
            input_snapshot_id,
            owner_epoch,
            owner_bot_id,
            gap_items_json,
            reason,
            created_at,
            task_id,
        } => {
            match mode.as_str() {
                "insert" => {
                    conn.execute(
                        "INSERT INTO work_continuation_plans(plan_id,work_id,source_binding_id,operation_id,intent_revision,input_snapshot_id,owner_epoch,owner_bot_id,gap_items_json,reason,state,created_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11)",
                        params![
                            plan_id, work_id, source_binding_id, operation_id, intent_revision,
                            input_snapshot_id, owner_epoch, owner_bot_id, gap_items_json, reason, created_at
                        ],
                    )?;
                }
                "reassign" => {
                    conn.execute(
                        "UPDATE work_continuation_plans SET owner_bot_id=?1,owner_epoch=?2,state='pending',reason=?3 WHERE plan_id=?4",
                        params![owner_bot_id, owner_epoch, reason, plan_id],
                    )?;
                }
                "settleForTask" => {
                    conn.execute(
                        "UPDATE work_continuation_plans SET state='settled' WHERE plan_id=(SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?1) AND state='dispatched'",
                        params![task_id],
                    )?;
                }
                other => return Err(format!("unknown WorkContinuationPlanWrite mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkContinuationGapInsert { gap_key, plan_id } => {
            conn.execute(
                "INSERT INTO work_continuation_gaps(gap_key,plan_id) VALUES (?1,?2) ON CONFLICT DO NOTHING",
                params![gap_key, plan_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkDispatchRequestUpdate {
            mode,
            plan_id,
            bot_id,
            work_id,
        } => {
            match mode.as_str() {
                "reassignPlan" => {
                    conn.execute(
                        "UPDATE work_dispatch_requests SET bot_id=?1,state='pending',attempts=0,error=NULL WHERE continuation_plan_id=?2 AND state!='dispatched'",
                        params![bot_id, plan_id],
                    )?;
                }
                "cancelOnHandoff" => {
                    if table_exists(conn, "work_dispatch_requests")? {
                        conn.execute(
                            "UPDATE work_dispatch_requests SET state='cancelled',error='等待新负责人重新核对派发计划'
                             WHERE work_id=?1 AND bot_id=?2 AND state IN ('pending','blocked') AND NOT EXISTS (
                               SELECT 1 FROM work_execution_bindings b WHERE b.work_id=work_dispatch_requests.work_id
                               AND b.operation_id='dispatch:' || work_dispatch_requests.operation_id)",
                            params![work_id, bot_id],
                        )?;
                    }
                }
                other => return Err(format!("unknown WorkDispatchRequestUpdate mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkAutoRecoveryInsert {
            source_binding_id,
            plan_id,
            fingerprint,
            mode,
            created_at,
        } => {
            conn.execute(
                "INSERT INTO work_automatic_recovery(source_binding_id,plan_id,fingerprint,mode,created_at) VALUES (?1,?2,?3,?4,?5)",
                params![source_binding_id, plan_id, fingerprint, mode, created_at],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkTerminalEvidenceReadUpsert { binding_id } => {
            conn.execute(
                "INSERT INTO work_terminal_evidence_reads(binding_id,version) VALUES (?1,1) ON CONFLICT(binding_id) DO UPDATE SET version=1",
                [binding_id],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkAutoCompletionWrite {
            mode,
            binding_id,
            work_id,
            summary,
            outcome,
            goal_reviewed,
            fingerprint,
            now,
        } => {
            let changes = match mode.as_str() {
                "observe" => conn.execute(
                    "INSERT INTO work_automatic_completion(binding_id,work_id) VALUES (?1,?2) ON CONFLICT DO NOTHING",
                    params![binding_id, work_id],
                )?,
                "recoverUnreviewed" => conn.execute(
                    "INSERT INTO work_automatic_completion(binding_id,work_id,recovered)
                     SELECT b.binding_id,w.work_id,1 FROM works w JOIN work_execution_bindings b ON b.work_id=w.work_id
                     WHERE w.lifecycle='active' AND w.mode='once' AND w.cancel_requested_at IS NULL
                       AND b.bot_id=w.owner_bot_id AND b.owner_epoch=w.owner_epoch
                       AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id
                       AND b.invalidated_at IS NULL AND b.status='completed'
                       AND EXISTS (SELECT 1 FROM work_native_inbox n WHERE n.binding_id=b.binding_id AND n.consumed_at IS NOT NULL)
                       AND NOT EXISTS (SELECT 1 FROM work_execution_bindings newer WHERE newer.work_id=w.work_id
                         AND newer.bot_id=w.owner_bot_id AND newer.intent_revision=w.intent_revision
                         AND newer.input_snapshot_id=w.input_snapshot_id AND newer.invalidated_at IS NULL
                         AND newer.admitted_at>b.admitted_at) ON CONFLICT DO NOTHING",
                    [],
                )?,
                "recordDelivery" => {
                    let c = conn.execute(
                        "INSERT INTO work_automatic_completion_deliveries(binding_id,summary,outcome,goal_reviewed) VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                        params![binding_id, summary, outcome, goal_reviewed],
                    )?;
                    if c > 0 {
                        if let Some(fp) = fingerprint {
                            conn.execute(
                                "INSERT INTO work_completion_review_evidence(binding_id,fingerprint) VALUES (?1,?2)
                                 ON CONFLICT(binding_id) DO UPDATE SET fingerprint=excluded.fingerprint",
                                params![binding_id, fp],
                            )?;
                        }
                    }
                    c
                }
                "resetEvidenceMismatch" => {
                    conn.execute(
                        "DELETE FROM work_automatic_completion_deliveries WHERE binding_id=?1",
                        [&binding_id],
                    )?;
                    conn.execute(
                        "DELETE FROM work_completion_review_evidence WHERE binding_id=?1",
                        [&binding_id],
                    )?;
                    if table_exists(conn, "work_completion_turns")? {
                        conn.execute(
                            "UPDATE work_completion_turns SET state='queued',decision_json=NULL,retry_at=0,error='evidence changed after delivery' WHERE binding_id=?1",
                            [&binding_id],
                        )?;
                    }
                    1
                }
                "consume" => conn.execute(
                    "UPDATE work_automatic_completion SET consumed_at=?1 WHERE binding_id=?2",
                    params![now, binding_id],
                )?,
                other => return Err(format!("unknown WorkAutoCompletionWrite mode: {other}").into()),
            };
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkArtifactDependencyWrite {
            mode,
            binding_id,
            path,
            work_id,
            fingerprint_json,
            now,
        } => {
            let changes = match mode.as_str() {
                "insert" => conn.execute(
                    "INSERT INTO work_artifact_dependencies(binding_id,path,work_id,fingerprint_json) VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                    params![binding_id, path, work_id, fingerprint_json],
                )?,
                "invalidate" => conn.execute(
                    "UPDATE work_artifact_dependencies SET invalidated_at=?1 WHERE binding_id=?2 AND path=?3",
                    params![now, binding_id, path],
                )?,
                "invalidateIfNull" => conn.execute(
                    "UPDATE work_artifact_dependencies SET invalidated_at=COALESCE(invalidated_at,?1) WHERE binding_id=?2 AND path=?3",
                    params![now, binding_id, path],
                )?,
                other => return Err(format!("unknown WorkArtifactDependencyWrite mode: {other}").into()),
            };
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkGeneratedArtifactUpsert {
            binding_id,
            path,
            digest,
            payload_json,
        } => {
            let changes = conn.execute(
                "INSERT INTO work_generated_artifacts(binding_id,path,digest,payload_json)
                 VALUES (?1,?2,?3,?4) ON CONFLICT(binding_id,path,digest) DO UPDATE SET payload_json=excluded.payload_json
                 WHERE COALESCE(json_extract_string(excluded.payload_json,'$.sourceEntryId'),'') > COALESCE(json_extract_string(work_generated_artifacts.payload_json,'$.sourceEntryId'),'')",
                params![binding_id, path, digest, payload_json],
            )?;
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkContinuationProgressUpsert {
            binding_id,
            work_id,
            intent_revision,
            input_snapshot_id,
            fingerprint,
            recorded_at,
        } => {
            conn.execute(
                "INSERT INTO work_continuation_progress(binding_id,work_id,intent_revision,input_snapshot_id,fingerprint,recorded_at)
                 VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(binding_id) DO UPDATE SET fingerprint=excluded.fingerprint,recorded_at=excluded.recorded_at",
                params![binding_id, work_id, intent_revision, input_snapshot_id, fingerprint, recorded_at],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkCausalChainInsert {
            chain_id,
            root_event_id,
            parent_chain_id,
            parent_causal_event_id,
            origin_work_id,
            origin_bot_id,
            target_work_id,
            target_subscription_id,
            source,
            source_event_id,
            input_snapshot_id,
            target_state_hash,
            depth,
            hops,
            dispatch_count,
            admission_key,
            decision,
            reason_code,
            created_at,
        } => {
            conn.execute(
                "INSERT INTO work_causal_chains
                 (chain_id,root_event_id,parent_chain_id,parent_causal_event_id,origin_work_id,origin_bot_id,
                  target_work_id,target_subscription_id,source,source_event_id,input_snapshot_id,target_state_hash,
                  depth,hops,dispatch_count,admission_key,decision,reason_code,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
                params![
                    chain_id, root_event_id, parent_chain_id, parent_causal_event_id, origin_work_id,
                    origin_bot_id, target_work_id, target_subscription_id, source, source_event_id,
                    input_snapshot_id, target_state_hash, depth, hops, dispatch_count, admission_key,
                    decision, reason_code, created_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkClosureReviewCorrectionInsert {
            operation_id,
            work_id,
            binding_id,
            original_close_operation_id,
            original_conclusion,
            original_summary,
            original_closed_at,
            evidence_json,
            decision_json,
            created_at,
        } => {
            conn.execute(
                "INSERT INTO work_closure_review_corrections VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    operation_id, work_id, binding_id, original_close_operation_id,
                    original_conclusion, original_summary, original_closed_at,
                    evidence_json, decision_json, created_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkCollaborationMessageInsert {
            message_id,
            work_id,
            sender_bot_id,
            sender_kind,
            user_id,
            kind,
            payload_hash,
            payload_json,
            intent_revision,
            input_snapshot_id,
            owner_epoch,
            created_at,
        } => {
            conn.execute(
                "INSERT INTO work_collaboration_messages(message_id,work_id,sender_bot_id,sender_kind,user_id,kind,payload_hash,
                 payload_json,intent_revision,input_snapshot_id,owner_epoch,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    message_id, work_id, sender_bot_id, sender_kind, user_id, kind,
                    payload_hash, payload_json, intent_revision, input_snapshot_id, owner_epoch, created_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkHandoffPreparationInsert {
            preparation_id,
            work_id,
            target_bot_id,
            state_version,
            owner_epoch,
            input_snapshot_id,
            snapshot_json,
            created_at,
        } => {
            conn.execute(
                "INSERT INTO work_handoff_preparations(preparation_id,work_id,target_bot_id,state_version,
                 owner_epoch,input_snapshot_id,snapshot_json,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT DO NOTHING",
                params![
                    preparation_id, work_id, target_bot_id, state_version,
                    owner_epoch, input_snapshot_id, snapshot_json, created_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkDelegationAdoptionInsert {
            binding_id,
            owner_epoch,
            adopted_by_bot_id,
            intent_revision,
            input_snapshot_id,
            delegated_scope_json,
            operation_id,
            created_at,
        } => {
            conn.execute(
                "INSERT INTO work_delegation_adoptions(binding_id,owner_epoch,adopted_by_bot_id,intent_revision,
                 input_snapshot_id,delegated_scope_json,operation_id,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    binding_id, owner_epoch, adopted_by_bot_id, intent_revision,
                    input_snapshot_id, delegated_scope_json, operation_id, created_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkNativeInboxWrite {
            mode,
            fact_id,
            binding_id,
            namespace_hash,
            payload_json,
            now,
            consume_error,
        } => {
            match mode.as_str() {
                "receive" => {
                    conn.execute(
                        "INSERT INTO work_native_inbox(fact_id,binding_id,namespace_hash,payload_json,received_at)
                         VALUES (?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",
                        params![fact_id, binding_id, namespace_hash, payload_json, now],
                    )?;
                    conn.execute(
                        "INSERT INTO work_native_cursors(binding_id,fact_id,updated_at) VALUES (?1,?2,?3)
                         ON CONFLICT(binding_id) DO UPDATE SET fact_id=excluded.fact_id,read_failures=0,updated_at=excluded.updated_at",
                        params![binding_id, fact_id, now],
                    )?;
                }
                "pendingAdoption" => {
                    conn.execute(
                        "UPDATE work_native_inbox SET consume_error=?1 WHERE fact_id=?2 AND consumed_at IS NULL",
                        params![consume_error, fact_id],
                    )?;
                }
                "consumed" => {
                    conn.execute(
                        "UPDATE work_native_inbox SET consumed_at=?1,consume_error=NULL WHERE fact_id=?2",
                        params![now, fact_id],
                    )?;
                }
                "consumeError" => {
                    conn.execute(
                        "UPDATE work_native_inbox SET consume_error=?1 WHERE fact_id=?2",
                        params![consume_error, fact_id],
                    )?;
                }
                other => return Err(format!("unknown WorkNativeInboxWrite mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkNativeRecoveryWrite {
            mode,
            binding_id,
            now,
            last_error,
        } => {
            match mode.as_str() {
                "allowInspect" => {
                    conn.execute(
                        "UPDATE work_native_recovery SET failures=0,exhausted_at=NULL,first_failure_at=?1 WHERE binding_id=?2",
                        params![now, binding_id],
                    )?;
                }
                "delete" => {
                    conn.execute("DELETE FROM work_native_recovery WHERE binding_id=?1", [&binding_id])?;
                }
                "readFailed" => {
                    conn.execute(
                        "INSERT INTO work_native_recovery(binding_id,failures,first_failure_at,last_error) VALUES (?1,1,?2,?3)
                         ON CONFLICT(binding_id) DO UPDATE SET failures=failures+1,last_error=excluded.last_error,
                         exhausted_at=CASE WHEN failures>=4 OR excluded.first_failure_at-first_failure_at>=90000 THEN excluded.first_failure_at ELSE exhausted_at END",
                        params![binding_id, now, last_error],
                    )?;
                }
                other => return Err(format!("unknown WorkNativeRecoveryWrite mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkReportContextInsert {
            binding_id,
            work_id,
            task_id,
            intent_revision,
            owner_epoch,
            input_snapshot_id,
            context_json,
        } => {
            conn.execute(
                "INSERT INTO work_report_contexts (binding_id,work_id,task_id,intent_revision,owner_epoch,input_snapshot_id,context_json)
                 VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT DO NOTHING",
                params![binding_id, work_id, task_id, intent_revision, owner_epoch, input_snapshot_id, context_json],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkSubscriptionCursorUpsert {
            subscription_id,
            source,
            target_key,
            highest_accepted_version,
            highest_consumed_version,
            highest_frozen_version,
            replay_cursor,
            enumeration_watermark,
            accepted_events,
            consumed_events,
            accepted_bytes,
            updated_at,
        } => {
            conn.execute(
                "INSERT INTO work_subscription_cursors
                 (subscription_id,source,target_key,highest_accepted_version,highest_consumed_version,highest_frozen_version,
                  replay_cursor,enumeration_watermark,accepted_events,consumed_events,accepted_bytes,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                 ON CONFLICT(subscription_id,source,target_key) DO UPDATE SET
                   highest_accepted_version=excluded.highest_accepted_version,
                   highest_consumed_version=excluded.highest_consumed_version,
                   highest_frozen_version=excluded.highest_frozen_version,
                   replay_cursor=excluded.replay_cursor,enumeration_watermark=excluded.enumeration_watermark,
                   accepted_events=excluded.accepted_events,consumed_events=excluded.consumed_events,
                   accepted_bytes=excluded.accepted_bytes,updated_at=excluded.updated_at",
                params![
                    subscription_id, source, target_key, highest_accepted_version, highest_consumed_version,
                    highest_frozen_version, replay_cursor, enumeration_watermark, accepted_events,
                    consumed_events, accepted_bytes, updated_at
                ],
            )?;
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkIngressRouteWrite {
            mode,
            source,
            source_event_id,
            subscription_id,
            work_id,
            target_key,
            inbox_event_id,
            state,
            reason_code,
            source_version,
            trust,
            accepted_at,
        } => {
            match mode.as_str() {
                "upsert" => {
                    conn.execute(
                        "INSERT INTO work_ingress_routes
                         (source,source_event_id,subscription_id,work_id,target_key,inbox_event_id,state,reason_code,source_version,trust,accepted_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                         ON CONFLICT(source,source_event_id,subscription_id) DO UPDATE SET
                           work_id=excluded.work_id,target_key=excluded.target_key,
                           inbox_event_id=COALESCE(excluded.inbox_event_id,work_ingress_routes.inbox_event_id),
                           state=excluded.state,reason_code=excluded.reason_code,source_version=excluded.source_version,
                           trust=excluded.trust,accepted_at=excluded.accepted_at",
                        params![
                            source, source_event_id, subscription_id, work_id, target_key, inbox_event_id,
                            state, reason_code, source_version, trust, accepted_at
                        ],
                    )?;
                }
                "markProcessed" => {
                    conn.execute(
                        "UPDATE work_ingress_routes SET reason_code='processed' WHERE inbox_event_id=?1 AND subscription_id=?2",
                        params![inbox_event_id, subscription_id],
                    )?;
                }
                "pausedBacklogUpdate" => {
                    conn.execute(
                        "UPDATE work_ingress_routes SET inbox_event_id=?1,state=?2,reason_code=?3
                         WHERE source=?4 AND source_event_id=?5 AND subscription_id=?6",
                        params![inbox_event_id, state, reason_code, source, source_event_id, subscription_id],
                    )?;
                }
                "deleteRejected" => {
                    conn.execute(
                        "DELETE FROM work_ingress_routes WHERE subscription_id=?1 AND state='rejected'",
                        [subscription_id],
                    )?;
                }
                other => return Err(format!("unknown WorkIngressRouteWrite mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkPausedSourceRouteWrite {
            source,
            source_event_id,
            subscription_id,
            catch_up_policy,
            inbox_event_id,
        } => {
            conn.execute(
                "INSERT INTO work_paused_source_routes(source,source_event_id,subscription_id,catch_up_policy) VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                params![source, source_event_id, subscription_id, catch_up_policy],
            )?;
            if let Some(eid) = inbox_event_id {
                conn.execute(
                    "UPDATE work_paused_source_routes SET inbox_event_id=?1 WHERE source=?2 AND source_event_id=?3 AND subscription_id=?4",
                    params![eid, source, source_event_id, subscription_id],
                )?;
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkScheduleTickWrite {
            mode,
            tick_id,
            subscription_id,
            work_id,
            schedule_revision,
            logical_slot_key,
            planned_at,
            effective_at,
            status,
            inbox_event_id,
            merged_from_slot_keys_json,
            created_at,
        } => {
            let changes = match mode.as_str() {
                "insert" => conn.execute(
                    "INSERT INTO work_schedule_ticks
                     (tick_id,subscription_id,work_id,schedule_revision,logical_slot_key,planned_at,effective_at,status,merged_from_slot_keys_json,created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'[]',?9) ON CONFLICT DO NOTHING",
                    params![tick_id, subscription_id, work_id, schedule_revision, logical_slot_key, planned_at, effective_at, status, created_at],
                )?,
                "dispatched" => conn.execute(
                    "UPDATE work_schedule_ticks SET status='dispatched',inbox_event_id=?1 WHERE tick_id=?2",
                    params![inbox_event_id, tick_id],
                )?,
                "mergedSlots" => conn.execute(
                    "UPDATE work_schedule_ticks SET merged_from_slot_keys_json=?1 WHERE tick_id=?2",
                    params![merged_from_slot_keys_json, tick_id],
                )?,
                "skipByInbox" => conn.execute(
                    "UPDATE work_schedule_ticks SET status='skipped' WHERE inbox_event_id=?1",
                    params![inbox_event_id],
                )?,
                other => return Err(format!("unknown WorkScheduleTickWrite mode: {other}").into()),
            };
            Ok(json!({ "ok": true, "changes": changes }))
        }
        WorkOp::WorkDeadlineInstanceWrite {
            mode,
            work_id,
            deadline_revision,
            deadline_at,
            state,
            inbox_event_id,
            now,
        } => {
            match mode.as_str() {
                "insertArmed" => {
                    conn.execute(
                        "INSERT INTO work_deadline_instances
                         (work_id,deadline_revision,deadline_at,state,created_at) VALUES (?1,?2,?3,'armed',?4) ON CONFLICT DO NOTHING",
                        params![work_id, deadline_revision, deadline_at, now],
                    )?;
                }
                "followedUp" => {
                    conn.execute(
                        "UPDATE work_deadline_instances SET state='followed-up',inbox_event_id=COALESCE(?1,inbox_event_id),followed_at=?2
                         WHERE work_id=?3 AND deadline_revision=?4 AND deadline_at=?5",
                        params![inbox_event_id, now, work_id, deadline_revision, deadline_at],
                    )?;
                }
                "rearm" => {
                    conn.execute(
                        "UPDATE work_deadline_instances SET state='cancelled' WHERE work_id=?1 AND state='armed'",
                        [&work_id],
                    )?;
                    if let (Some(rev), Some(at)) = (deadline_revision, deadline_at) {
                        conn.execute(
                            "INSERT INTO work_deadline_instances
                             (work_id,deadline_revision,deadline_at,state,created_at) VALUES (?1,?2,?3,'armed',?4) ON CONFLICT DO NOTHING",
                            params![work_id, rev, at, now],
                        )?;
                    }
                }
                other => {
                    let _ = state;
                    return Err(format!("unknown WorkDeadlineInstanceWrite mode: {other}").into());
                }
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkOfflineGapWrite {
            mode,
            gap_id,
            host_session_id,
            subscription_id,
            work_id,
            offline_gap_from,
            offline_gap_to,
            detected_by,
            confidence,
            policy,
            policy_revision,
            source_cursor,
            queryable,
            recovered_count_delta,
            merged_count_delta,
            skipped_count,
            unknown_count,
            state,
            continuation_cursor,
            gap_reason,
            next_wake_at,
            now,
        } => {
            match mode.as_str() {
                "insert" => {
                    conn.execute(
                        "INSERT INTO work_offline_gaps
                         (gap_id,host_session_id,subscription_id,work_id,offline_gap_from,offline_gap_to,detected_by,confidence,
                          policy,policy_revision,source_cursor,queryable,recovered_count,merged_count,skipped_count,unknown_count,
                          state,continuation_cursor,gap_reason,created_at,updated_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,0,0,NULL,?13,NULL,?14,?15,?15) ON CONFLICT DO NOTHING",
                        params![
                            gap_id, host_session_id, subscription_id, work_id, offline_gap_from, offline_gap_to,
                            detected_by, confidence, policy, policy_revision, source_cursor, queryable, state, gap_reason, now
                        ],
                    )?;
                }
                "update" => {
                    conn.execute(
                        "UPDATE work_offline_gaps SET queryable=?1,state=?2,
                         recovered_count=recovered_count+?3,
                         merged_count=merged_count+?4,
                         skipped_count=?5,
                         unknown_count=?6,
                         continuation_cursor=?7,
                         gap_reason=?8,
                         updated_at=?9 WHERE gap_id=?10",
                        params![
                            queryable.unwrap_or(1), state, recovered_count_delta.unwrap_or(0),
                            merged_count_delta.unwrap_or(0), skipped_count, unknown_count,
                            continuation_cursor, gap_reason, now, gap_id
                        ],
                    )?;
                }
                "settleCron" => {
                    conn.execute(
                        "UPDATE work_offline_gaps SET queryable=1,state='recovered',
                         gap_reason='已按策略恢复调度槽；业务来源需由后续检查读取',updated_at=?1
                         WHERE subscription_id=?2 AND state IN ('open','recovering','unqueryable')
                           AND (?3 IS NULL OR offline_gap_to<?3)",
                        params![now, subscription_id, next_wake_at],
                    )?;
                }
                other => return Err(format!("unknown WorkOfflineGapWrite mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
        WorkOp::WorkWatchHostStateWrite {
            mode,
            authority_id,
            session_id,
            last_scan_at,
            last_scan_cursor,
            active_since,
            last_seen_at,
            suspend_evidence,
            stopped_at,
            updated_at,
        } => {
            match mode.as_str() {
                "upsert" => {
                    conn.execute(
                        "INSERT INTO work_watch_host_state
                         (authority_id,session_id,last_scan_at,last_scan_cursor,active_since,last_seen_at,suspend_evidence,stopped_at,updated_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
                         ON CONFLICT(authority_id) DO UPDATE SET session_id=excluded.session_id,last_scan_at=excluded.last_scan_at,
                           last_scan_cursor=COALESCE(excluded.last_scan_cursor, work_watch_host_state.last_scan_cursor),
                           active_since=excluded.active_since,last_seen_at=excluded.last_seen_at,
                           suspend_evidence=excluded.suspend_evidence,stopped_at=excluded.stopped_at,updated_at=excluded.updated_at",
                        params![
                            authority_id, session_id, last_scan_at, last_scan_cursor,
                            active_since, last_seen_at, suspend_evidence, stopped_at, updated_at
                        ],
                    )?;
                }
                "updateCursor" => {
                    conn.execute(
                        "UPDATE work_watch_host_state SET last_scan_cursor=?1 WHERE authority_id=?2",
                        params![last_scan_cursor, authority_id],
                    )?;
                }
                "markStopped" => {
                    conn.execute(
                        "UPDATE work_watch_host_state SET stopped_at=?1,updated_at=?2 WHERE authority_id=?3",
                        params![stopped_at.unwrap_or(updated_at), updated_at, authority_id],
                    )?;
                }
                other => return Err(format!("unknown WorkWatchHostStateWrite mode: {other}").into()),
            }
            Ok(json!({ "ok": true }))
        }
    }
}
