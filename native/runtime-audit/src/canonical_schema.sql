CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT,
        parent_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , archived INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS workspace_notes (
        workspace_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS workspace_icons (
        workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        shape TEXT NOT NULL,
        color TEXT NOT NULL
      );

CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        space_id TEXT,
        project_id TEXT,
        status TEXT,
        updated_at INTEGER NOT NULL,
        session_file TEXT,
        cwd TEXT,
        welcome_mode TEXT,
        model_id TEXT,
        permission_mode TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        expert_id TEXT,
        mode_preset_id TEXT,
        context_used_tokens INTEGER,
        context_window_tokens INTEGER,
        context_cache_hit_rate REAL,
        start_at INTEGER,
        due_at INTEGER,
        space_sort_order INTEGER NOT NULL DEFAULT 0,
        is_favorited INTEGER NOT NULL DEFAULT 0,
        external_agent_pin_json TEXT,
        done_acked_at INTEGER,
        FOREIGN KEY (space_id) REFERENCES spaces(id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
      );

CREATE TABLE IF NOT EXISTS task_write_grants (
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, path),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS soul (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        alias TEXT NOT NULL,
        persona TEXT NOT NULL
      );

CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_expr TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        space_id TEXT,
        cwd TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        execution_json TEXT
      , permission_mode TEXT, model_id TEXT, expert_id TEXT, skill_ids_json TEXT NOT NULL DEFAULT '[]', connector_ids_json TEXT NOT NULL DEFAULT '[]', effective_from INTEGER, effective_to INTEGER, welcome_mode TEXT, project_id TEXT);

CREATE TABLE IF NOT EXISTS cron_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        task_id TEXT,
        FOREIGN KEY (job_id) REFERENCES cron_jobs(id)
      );

CREATE TABLE IF NOT EXISTS gateway_sidebar_conversations (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL
      );

CREATE TABLE IF NOT EXISTS gateway_channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        connected INTEGER NOT NULL DEFAULT 0,
        status_text TEXT
      );

CREATE TABLE IF NOT EXISTS gateway_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        chat_id TEXT NOT NULL DEFAULT '',
        direction TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        instructions TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        resource_budget_chars INTEGER NOT NULL DEFAULT 128000,
        template_id TEXT
      , default_space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL, goal TEXT, current_stage TEXT);

CREATE TABLE IF NOT EXISTS project_notes (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS project_write_receipts (
        operation_id TEXT NOT NULL UNIQUE
      );

CREATE TABLE IF NOT EXISTS project_delete_receipts (
        operation_id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL CHECK (json_valid(result_json))
      );

CREATE TABLE IF NOT EXISTS project_expert_policy (
        project_id TEXT PRIMARY KEY,
        allow_json TEXT NOT NULL DEFAULT '[]',
        deny_json TEXT NOT NULL DEFAULT '[]',
        recommended_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_skill_policy (
        project_id TEXT PRIMARY KEY,
        prefer_json TEXT NOT NULL DEFAULT '[]',
        demote_json TEXT NOT NULL DEFAULT '[]',
        hide_json TEXT NOT NULL DEFAULT '[]',
        allow_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_connector_policy (
        project_id TEXT PRIMARY KEY,
        allow_json TEXT NOT NULL DEFAULT '[]',
        deny_json TEXT NOT NULL DEFAULT '[]',
        recommended_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_mcp_policy (
        project_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'hard',
        allow_json TEXT NOT NULL DEFAULT '[]',
        deny_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_resources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'file', 'url', 'folder')),
        title TEXT NOT NULL,
        value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES project_resources(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_posts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_todos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        assignee TEXT,
        priority TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        start_at INTEGER,
        due_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS runtime_audit_payloads (
        hash TEXT PRIMARY KEY NOT NULL,
        body TEXT NOT NULL
      ) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS runtime_snapshot_writer (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL,
        write_id TEXT NOT NULL,
        result INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS task_runtime_context_snapshots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        welcome_mode TEXT NOT NULL,
        tag_id TEXT,
        project_id TEXT,
        project_updated_at INTEGER,
        resolved_instructions_json TEXT NOT NULL,
        resolved_capabilities_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        execution_id TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        assembly_hash TEXT,
        model_id TEXT,
        permission_mode TEXT,
        storage_bytes INTEGER NOT NULL DEFAULT 0, material_usage_json TEXT, working_directory TEXT, instructions_hash TEXT REFERENCES runtime_audit_payloads(hash), capabilities_hash TEXT REFERENCES runtime_audit_payloads(hash),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS task_execution_workspace_state (
        task_id TEXT PRIMARY KEY,
        directory_name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        trashed_at INTEGER,
        purge_after INTEGER,
        trash_path TEXT
      );

CREATE TABLE IF NOT EXISTS cad_models (
    model_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    graph_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'custom',
    title TEXT,
    model_dir TEXT NOT NULL,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    tags_json TEXT NOT NULL DEFAULT '[]',
    features_json TEXT NOT NULL DEFAULT '[]',
    outputs_json TEXT NOT NULL DEFAULT '{}',
    validation_json TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS task_code_review (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      target_key TEXT NOT NULL,
      root_entity TEXT NOT NULL,
      path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
      before_present INTEGER NOT NULL,
      before_stamp TEXT NOT NULL,
      before_bytes BLOB,
      before_mode INTEGER,
      after_present INTEGER NOT NULL,
      after_stamp TEXT NOT NULL,
      after_bytes BLOB,
      after_mode INTEGER,
      additions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      stats_available INTEGER NOT NULL,
      capture_reason TEXT,
      failure_reason TEXT,
      restoring INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, target_key)
    );

CREATE TABLE IF NOT EXISTS project_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        ref TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        triage_status TEXT NOT NULL DEFAULT 'open'
          CHECK (triage_status IN ('open', 'dismissed')),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_event_promotions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_title TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('memory', 'todo', 'library')),
        target_id TEXT NOT NULL,
        target_title TEXT,
        promoted_by TEXT NOT NULL CHECK (promoted_by IN ('user', 'agent')),
        note TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS library_spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
        project_id TEXT,
        workspace_id TEXT CHECK (workspace_id IS NULL OR (project_id IS NULL AND kind = 'team')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS library_collections (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (space_id) REFERENCES library_spaces(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES library_collections(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS library_items (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        collection_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('markdown', 'html', 'csv', 'office', 'pdf', 'image', 'file', 'url')),
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        owner TEXT NOT NULL DEFAULT '',
        favorite INTEGER NOT NULL DEFAULT 0,
        url TEXT,
        source_type TEXT NOT NULL DEFAULT 'created',
        source_task_id TEXT,
        source_artifact_id TEXT,
        original_path TEXT,
        content_hash TEXT,
        extract_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_visited_at INTEGER, trashed_at INTEGER, note_metadata TEXT,
        FOREIGN KEY (space_id) REFERENCES library_spaces(id) ON DELETE CASCADE,
        FOREIGN KEY (collection_id) REFERENCES library_collections(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS library_versions (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        path TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        source_task_id TEXT,
        created_at INTEGER NOT NULL, snapshot BLOB,
        FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS library_text_saves (
        item_id TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        root TEXT NOT NULL,
        path TEXT NOT NULL,
        old_content BLOB,
        old_hash TEXT,
        new_hash TEXT NOT NULL,
        committed INTEGER NOT NULL CHECK (committed IN (0,1))
      );

CREATE TABLE IF NOT EXISTS library_file_cleanup (
        root TEXT NOT NULL,
        space_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        filename TEXT,
        PRIMARY KEY (root, space_id, item_id)
      );

CREATE TABLE IF NOT EXISTS library_restore_files (
        root TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        PRIMARY KEY (root, item_id)
      );

CREATE TABLE IF NOT EXISTS library_restore_receipts (
        root TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        result_json TEXT NOT NULL
      );

CREATE TABLE IF NOT EXISTS task_library_references (
        task_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        project_id TEXT,
        added_at INTEGER NOT NULL,
        added_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (task_id, item_id),
        FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_context_pins (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        note TEXT,
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE (project_id, item_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_reviews (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        reviewed_at INTEGER NOT NULL,
        note TEXT,
        created_by TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS project_action_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK (action_type IN ('locate_task', 'locate_plan', 'update_plan_status', 'needs_confirmation')),
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        executable INTEGER NOT NULL DEFAULT 0,
        target_ref TEXT,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'stale', 'obsolete')),
        fingerprint TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        applied_result TEXT,
        UNIQUE (project_id, fingerprint),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(
          item_id UNINDEXED,
          title,
          filename,
          body,
          tokenize = 'trigram'
        );

CREATE TABLE IF NOT EXISTS usage_events (
        entry_id TEXT PRIMARY KEY,
        task_id TEXT,
        session_file TEXT,
        source_kind TEXT NOT NULL DEFAULT 'main',
        source_detail TEXT,
        provider TEXT,
        model TEXT,
        response_model TEXT,
        ts INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        cache_write_1h INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_total REAL NOT NULL DEFAULT 0,
        cost_input REAL NOT NULL DEFAULT 0,
        cost_output REAL NOT NULL DEFAULT 0,
        cost_cache_read REAL NOT NULL DEFAULT 0,
        cost_cache_write REAL NOT NULL DEFAULT 0,
        stop_reason TEXT,
        error_message TEXT,
        request_started_at INTEGER,
        first_response_at INTEGER,
        completed_at INTEGER,
        ttft_ms INTEGER,
        decode_ms INTEGER,
        generation_tps REAL,
        model_wall_ms INTEGER,
        response_id TEXT,
        turn_index INTEGER,
        user_turn INTEGER,
        backfilled INTEGER NOT NULL DEFAULT 0
      );

CREATE TABLE IF NOT EXISTS usage_backfill_state (
        session_file TEXT PRIMARY KEY,
        last_entry_id TEXT,
        file_size INTEGER,
        file_mtime INTEGER,
        user_messages INTEGER,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        source_type TEXT NOT NULL,
        source_id TEXT,
        task_id TEXT,
        project_id TEXT,
        workspace_id TEXT,
        dedupe_key TEXT,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        dismissed_at INTEGER
      );

CREATE TABLE IF NOT EXISTS workspace_library_links (
        workspace_id TEXT NOT NULL,
        library_space_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, library_space_id)
      );

CREATE TABLE IF NOT EXISTS workspace_library_collection_links (
        workspace_id TEXT NOT NULL,
        library_space_id TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, collection_id)
      );

CREATE TABLE IF NOT EXISTS python_project_bindings (
        dir_key TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        python_path TEXT NOT NULL,
        python_version TEXT,
        manifest_path TEXT,
        bound_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS library_chunks (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        char_offset INTEGER NOT NULL,
        hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE VIRTUAL TABLE IF NOT EXISTS library_chunks_fts USING fts5(
          item_id UNINDEXED,
          chunk_id UNINDEXED,
          content,
          tokenize = 'trigram'
        );

CREATE TABLE IF NOT EXISTS library_chunk_embeddings (
        chunk_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        chunk_hash TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chunk_id, model_id, model_version)
      );

CREATE TABLE IF NOT EXISTS semantic_index_jobs (
        job_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
        last_chunk_id TEXT,
        processed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS material_retrieval_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      mode TEXT NOT NULL CHECK (mode IN ('keyword', 'hybrid')),
      decision_model TEXT
    );

CREATE TABLE IF NOT EXISTS material_retrieval_spaces (
      id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('keyword', 'hybrid'))
    );

CREATE TABLE IF NOT EXISTS material_retrieval_projects (
      id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('keyword', 'hybrid'))
    );

CREATE TABLE IF NOT EXISTS work_graph_edges (
        id            TEXT PRIMARY KEY,
        from_type     TEXT NOT NULL,
        from_id       TEXT NOT NULL,
        relation      TEXT NOT NULL,
        to_type       TEXT NOT NULL,
        to_id         TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE(from_type, from_id, relation, to_type, to_id)
      );

CREATE TABLE IF NOT EXISTS gadgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace', 'task')),
        scope_id TEXT,
        type TEXT NOT NULL DEFAULT 'web' CHECK (type IN ('web')),
        manifest_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        created_by_task_id TEXT,
        blueprint_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (scope_type = 'global' AND scope_id IS NULL) OR
          (scope_type = 'workspace' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0) OR
          (scope_type = 'task' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0)
        )
      );

CREATE TABLE IF NOT EXISTS gadget_source_commits (
        gadget_id TEXT NOT NULL PRIMARY KEY REFERENCES gadgets(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL
      );

CREATE TABLE IF NOT EXISTS blueprints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('workspace', 'gadget', 'composite')),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS workbench_write_receipts (
        operation_id TEXT NOT NULL UNIQUE
      );

CREATE TABLE IF NOT EXISTS blueprint_instance_receipts (
        operation_id TEXT NOT NULL UNIQUE,
        result_json TEXT NOT NULL CHECK (json_valid(result_json))
      );

CREATE TABLE IF NOT EXISTS memory_forget_watermarks (
        scope_type TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT '', cutoff_at INTEGER NOT NULL, allowed_message_id TEXT,
        PRIMARY KEY(scope_type, scope_id)
      );

CREATE TABLE IF NOT EXISTS memory_forget_targets (
        scope_type TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL, text_length INTEGER NOT NULL, cutoff_at INTEGER NOT NULL,
        value_fingerprint TEXT, guard_fingerprint TEXT, guard_length INTEGER,
        allowed_message_id TEXT,
        PRIMARY KEY(scope_type, scope_id, fingerprint)
      );

CREATE TABLE IF NOT EXISTS memory_forget_receipts (
        scope_type TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT '', source_message_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL, PRIMARY KEY(scope_type,scope_id,source_message_id,request_fingerprint)
      );

CREATE TABLE IF NOT EXISTS memory_organization_runs (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        state_json TEXT NOT NULL CHECK (json_valid(state_json))
      );

CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('identity','preference','fact','decision','constraint','risk','open_question','progress','procedure')),
        title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','resolved','invalid')),
        importance INTEGER NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 3),
        confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
        explicit INTEGER NOT NULL DEFAULT 0 CHECK (explicit IN (0,1)),
        source_type TEXT NOT NULL DEFAULT 'agent' CHECK (source_type IN ('user','agent','tool','library','event','manual','import')),
        source_id TEXT, source_task_id TEXT, valid_from INTEGER, valid_until INTEGER,
        content_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_recalled_at INTEGER, recall_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
      );

CREATE TABLE IF NOT EXISTS memory_scopes (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project','task','bot','team','conversation','work')),
        scope_id TEXT, binding TEXT NOT NULL DEFAULT 'owned' CHECK (binding IN ('owned','promoted')), created_at INTEGER NOT NULL,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0)),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('conversation','message','task','artifact','library_item','library_chunk','project_event','agent_run','external')),
        ref_id TEXT NOT NULL, ref_title TEXT, excerpt TEXT, created_at INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS memory_revisions (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL, importance INTEGER NOT NULL, confidence REAL NOT NULL, valid_from INTEGER, valid_until INTEGER,
        changed_by TEXT NOT NULL, change_reason TEXT, created_at INTEGER NOT NULL, UNIQUE(memory_id, revision),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS memory_relations (
        id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN ('SUPERSEDES','CONTRADICTS','SUPPORTS','DUPLICATE_OF','DERIVED_FROM')),
        to_memory_id TEXT NOT NULL, created_at INTEGER NOT NULL, CHECK (from_memory_id <> to_memory_id),
        UNIQUE(from_memory_id, relation, to_memory_id),
        FOREIGN KEY (from_memory_id) REFERENCES memory_records(id) ON DELETE CASCADE,
        FOREIGN KEY (to_memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT NOT NULL, model_id TEXT NOT NULL, model_version TEXT NOT NULL, content_hash TEXT NOT NULL,
        dimension INTEGER NOT NULL, embedding BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (memory_id, model_id, model_version),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT,
        confidence REAL NOT NULL, importance INTEGER NOT NULL, explicit INTEGER NOT NULL DEFAULT 0,
        operation_hint TEXT NOT NULL CHECK (operation_hint IN ('create','update','supersede','resolve','forget')), replaces TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','rejected','needs_review')), raw_json TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_memory_id TEXT,
        FOREIGN KEY (resolved_memory_id) REFERENCES memory_records(id) ON DELETE SET NULL
      );

CREATE TABLE IF NOT EXISTS memory_turns (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        user_message_id TEXT,
        assistant_message_id TEXT,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        extraction_state TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_state IN ('pending','processing','completed','failed','skipped')),
        extracted_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
      );

CREATE TABLE IF NOT EXISTS memory_pipeline_state (
        task_id TEXT PRIMARY KEY,
        captured_turns INTEGER NOT NULL DEFAULT 0,
        turns_since_l1 INTEGER NOT NULL DEFAULT 0,
        last_l1_at INTEGER,
        last_l2_at INTEGER,
        last_l3_at INTEGER,
        l1_run_count INTEGER NOT NULL DEFAULT 0,
        l2_run_count INTEGER NOT NULL DEFAULT 0,
        l3_run_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS memory_projection_dismissals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('scenario','profile')),
        title TEXT NOT NULL DEFAULT '',
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        dismissed_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS memory_projection_proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('scenario','profile')),
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS memory_skill_effectiveness (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        candidate_id TEXT,
        source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
        exposed_at INTEGER NOT NULL,
        invoked_at INTEGER,
        invocation_kind TEXT CHECK (invocation_kind IS NULL OR invocation_kind IN ('read','command')),
        tool_call_id TEXT,
        outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','completed','failed','aborted')),
        outcome_at INTEGER,
        feedback_kind TEXT CHECK (feedback_kind IS NULL OR feedback_kind IN ('helpful','needs_revision','incorrect')),
        feedback_note TEXT,
        feedback_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(task_id,assistant_message_id,skill_id),
        CHECK ((invoked_at IS NULL AND invocation_kind IS NULL) OR (invoked_at IS NOT NULL AND invocation_kind IS NOT NULL)),
        CHECK ((feedback_kind IS NULL AND feedback_at IS NULL) OR (feedback_kind IS NOT NULL AND feedback_at IS NOT NULL))
      );

CREATE TABLE IF NOT EXISTS memory_skill_revision_candidates (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        base_candidate_id TEXT,
        base_version TEXT NOT NULL,
        base_content_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','ready','rejected','materialized','stale')),
        issue_summary TEXT NOT NULL,
        base_description TEXT NOT NULL,
        base_instructions TEXT NOT NULL,
        proposed_description TEXT NOT NULL,
        proposed_instructions TEXT NOT NULL,
        negative_feedback_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(negative_feedback_ids_json)),
        source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
        feedback_signature TEXT NOT NULL,
        needs_revision_count INTEGER NOT NULL DEFAULT 0 CHECK (needs_revision_count >= 0),
        incorrect_count INTEGER NOT NULL DEFAULT 0 CHECK (incorrect_count >= 0),
        failed_invocation_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_invocation_count >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        materialized_candidate_id TEXT,
        materialized_version TEXT
      );

CREATE TABLE IF NOT EXISTS memory_capture_receipts (
    source_key TEXT PRIMARY KEY, memory_id TEXT NOT NULL, content_hash TEXT NOT NULL,
    suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)), updated_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS "memory_skill_candidates" (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','ready','rejected','materialized','stale')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project','bot')),
        scope_id TEXT,
        source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
        source_signature TEXT NOT NULL,
        support_count INTEGER NOT NULL DEFAULT 0 CHECK (support_count >= 0),
        distinct_task_count INTEGER NOT NULL DEFAULT 0 CHECK (distinct_task_count >= 0),
        completed_task_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_task_count >= 0 AND completed_task_count <= distinct_task_count),
        evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
        confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
        score REAL NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 1),
        installed_skill_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
      );

CREATE TABLE IF NOT EXISTS memory_scenarios (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project') OR (scope_type='task' AND scope_id='mybuddy-dots')),
        scope_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale')),
        source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
      );

CREATE TABLE IF NOT EXISTS memory_core_profiles (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project') OR (scope_type='task' AND scope_id='mybuddy-dots')),
        scope_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale')),
        source_scenario_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_scenario_ids_json)),
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
      );

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          memory_id UNINDEXED,
          title,
          content,
          tokenize = 'trigram'
        );

CREATE TABLE IF NOT EXISTS memory_search_epoch(id INTEGER PRIMARY KEY CHECK(id=1),text_version INTEGER NOT NULL,vector_version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS agent_loadout_observations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
        recommended_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recommended_json)),
        actual_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actual_json)),
        matched_actual_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(matched_actual_json)),
        not_selected_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(not_selected_json)),
        blocked_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocked_json)),
        used_skill_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(used_skill_ids_json)),
        outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','completed','failed','aborted')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(task_id, assistant_message_id)
      );

CREATE TABLE IF NOT EXISTS conversation_branches (
        child_task_id            TEXT PRIMARY KEY,
        parent_task_id           TEXT NOT NULL,
        root_task_id             TEXT NOT NULL,
        parent_title_snapshot    TEXT NOT NULL,
        source_session_file      TEXT NOT NULL,
        source_leaf_entry_id     TEXT NOT NULL,
        source_user_message_index INTEGER NOT NULL,
        request_id               TEXT NOT NULL UNIQUE,
        source_position          TEXT NOT NULL
          CHECK (source_position IN ('after_user', 'after_reply')),
        workspace_strategy       TEXT NOT NULL
          CHECK (workspace_strategy IN ('shared_space', 'current_snapshot', 'conversation_only')),
        created_at               INTEGER NOT NULL,
        FOREIGN KEY (child_task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS execution_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL,
    assistant_message_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','passed','failed','inconclusive')),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );

CREATE TABLE IF NOT EXISTS conversation_interactions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('confirm','single_select','multi_select','short_text','long_text')),
        title TEXT NOT NULL,
        description TEXT,
        options_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options_json)),
        min_selections INTEGER,
        max_selections INTEGER,
        allow_custom INTEGER NOT NULL DEFAULT 0 CHECK (allow_custom IN (0,1)),
        custom_placeholder TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','resolved','cancelled','expired')),
        answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS bots (
      bot_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      responsibility_summary TEXT NOT NULL DEFAULT '',
      expert_profile_json TEXT NOT NULL CHECK (json_valid(expert_profile_json)),
      memory_scope_json TEXT NOT NULL CHECK (json_valid(memory_scope_json)),
      authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
      foreground_allowed_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(foreground_allowed_tools_json)),
      notification_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(notification_policy_json)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS bot_channel_bindings (
      channel_type TEXT NOT NULL CHECK (channel_type IN ('desktop','mobile','remote','gateway')),
      channel_identifier TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      bound_at INTEGER NOT NULL,
      PRIMARY KEY (channel_type, channel_identifier),
      FOREIGN KEY (bot_id) REFERENCES bots(bot_id) ON DELETE RESTRICT
    );

CREATE TABLE IF NOT EXISTS bot_expert_versions (
      bot_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      state TEXT NOT NULL CHECK (state IN ('pending','active','superseded')),
      expert_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      system_prompt_hash TEXT NOT NULL,
      configuration_json TEXT CHECK (configuration_json IS NULL OR json_valid(configuration_json)),
      skill_packages_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_packages_json)),
      allowed_mcp_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_mcp_ids_json)),
      allowed_skill_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_skill_ids_json)),
      allowed_connector_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_connector_ids_json)),
      staged_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      adopted_at INTEGER,
      PRIMARY KEY (bot_id, version),
      FOREIGN KEY (bot_id) REFERENCES bots(bot_id) ON DELETE RESTRICT
    );

CREATE TABLE IF NOT EXISTS works (
      work_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      workspace_path TEXT,
      source_message_id TEXT,
      legacy_task_id TEXT,
      owner_bot_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL DEFAULT 1 CHECK (owner_epoch > 0),
      intent_revision INTEGER NOT NULL DEFAULT 1 CHECK (intent_revision > 0),
      source_version INTEGER NOT NULL DEFAULT 1 CHECK (source_version > 0),
      title TEXT NOT NULL,
      goal_description TEXT,
      constraints_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(constraints_json)),
      criteria_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criteria_json)),
      authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
      active_intent_snapshot_id TEXT NOT NULL,
      input_snapshot_id TEXT NOT NULL,
      goal_sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(goal_sources_json)),
      mode TEXT NOT NULL DEFAULT 'once' CHECK (mode IN ('once','watch')),
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','paused','closing','closed')),
      pending_conclusion TEXT CHECK (pending_conclusion IS NULL OR pending_conclusion IN ('succeeded','cancelled','ended_unsuccessfully')),
      cancel_requested_at INTEGER,
      closure_conclusion TEXT CHECK (closure_conclusion IS NULL OR closure_conclusion IN ('succeeded','cancelled','ended_unsuccessfully')),
      closure_summary TEXT,
      accepted_deliverable_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(accepted_deliverable_ids_json)),
      active_execution_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(active_execution_ids_json)),
      progress_summary TEXT,
      watch_rule_json TEXT CHECK (watch_rule_json IS NULL OR json_valid(watch_rule_json)),
      state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
      created_by TEXT NOT NULL CHECK (created_by IN ('user','bot')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      close_operation_id TEXT, deadline_at INTEGER, deadline_revision INTEGER NOT NULL DEFAULT 1, deadline_set_at INTEGER, causal_policy_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (owner_bot_id) REFERENCES bots(bot_id) ON DELETE RESTRICT
    );

CREATE TABLE IF NOT EXISTS work_intent_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      source_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      goal_description TEXT,
      constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
      criteria_json TEXT NOT NULL CHECK (json_valid(criteria_json)),
      authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
      expert_snapshot_json TEXT NOT NULL CHECK (json_valid(expert_snapshot_json)),
      input_snapshot_id TEXT NOT NULL,
      goal_sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(goal_sources_json)),
      created_by TEXT NOT NULL CHECK (created_by IN ('user','bot')),
      source_message_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (work_id, intent_revision, source_version)
    );

CREATE TABLE IF NOT EXISTS work_conversations (
      work_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      channel_type TEXT NOT NULL DEFAULT 'desktop',
      last_referenced_at INTEGER NOT NULL,
      PRIMARY KEY (work_id, conversation_id)
    );

CREATE TABLE IF NOT EXISTS work_message_refs (
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE RESTRICT,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (work_id, conversation_id, message_id)
    );

CREATE TABLE IF NOT EXISTS work_participants (
      work_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('collaborator','worker','watcher')),
      delegated_scope_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(delegated_scope_json)),
      expert_snapshot_json TEXT NOT NULL CHECK (json_valid(expert_snapshot_json)),
      added_at INTEGER NOT NULL,
      PRIMARY KEY (work_id, bot_id)
    );

CREATE TABLE IF NOT EXISTS work_execution_bindings (
      binding_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      durable_store_key TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      input_snapshot_id TEXT NOT NULL,
      expert_snapshot_json TEXT NOT NULL CHECK (json_valid(expert_snapshot_json)),
      delegated_scope_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(delegated_scope_json)),
      workspace_binding TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','submitted','running','completed','failed','stopped','unknown','invalidated')),
      attempt_id TEXT,
      submission_receipt TEXT,
      settlement_note TEXT,
      admitted_at INTEGER NOT NULL,
      submitted_at INTEGER,
      invalidated_at INTEGER,
      settled_at INTEGER, inbox_event_id TEXT,
      UNIQUE (work_id, operation_id)
    );

CREATE TABLE IF NOT EXISTS work_action_admissions (
      admission_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      binding_id TEXT,
      operation_id TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('admitted','consumed','released','unknown')),
      intent_revision INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      admitted_at INTEGER NOT NULL,
      settled_at INTEGER,
      UNIQUE (work_id, operation_id, admission_id)
    );

CREATE TABLE IF NOT EXISTS work_deliverables (
      deliverable_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      producer_bot_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      input_snapshot_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','superseded')),
      summary TEXT NOT NULL,
      artifact_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_refs_json)),
      evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json)),
      uncovered_scope_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(uncovered_scope_json)),
      uncovered_criterion_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(uncovered_criterion_ids_json)),
      is_speculation INTEGER NOT NULL DEFAULT 0 CHECK (is_speculation IN (0,1)),
      has_write_conflicts INTEGER NOT NULL DEFAULT 0 CHECK (has_write_conflicts IN (0,1)),
      rejected_reason TEXT,
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      reviewed_by_bot_id TEXT
    );

CREATE TABLE IF NOT EXISTS work_evidence (
      evidence_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      deliverable_id TEXT,
      execution_id TEXT,
      criterion_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criterion_ids_json)),
      kind TEXT NOT NULL CHECK (kind IN ('automated_test','tool_receipt','inspection','artifact','real_environment','user_attestation')),
      provenance TEXT NOT NULL CHECK (provenance IN ('execution','user','system')),
      source_ref TEXT NOT NULL,
      source_sha TEXT,
      input_snapshot_id TEXT NOT NULL,
      environment TEXT,
      intent_revision INTEGER NOT NULL,
      detail TEXT,
      recorded_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS work_blockers (
      blocker_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      reported_by_bot_id TEXT,
      reason TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('external_effect','backpressure','write_conflict','operational')),
      unknown_external_effect_ref TEXT,
      waiting_for_user_input INTEGER NOT NULL DEFAULT 0 CHECK (waiting_for_user_input IN (0,1)),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared')),
      created_at INTEGER NOT NULL,
      cleared_at INTEGER
    , reason_code TEXT, details_json TEXT NOT NULL DEFAULT '{}', source_ref TEXT, subscription_id TEXT, causal_chain_id TEXT);

CREATE TABLE IF NOT EXISTS work_operation_receipts (
      user_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      work_id TEXT,
      operation_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_snapshot_json TEXT NOT NULL CHECK (json_valid(result_snapshot_json)),
      outbox_event_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, operation_id)
    );

CREATE TABLE IF NOT EXISTS work_host_lease (
      lease_id TEXT PRIMARY KEY CHECK (lease_id = 'singleton'),
      authority_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      released_at INTEGER
    );

CREATE TABLE IF NOT EXISTS work_telemetry_state (
      work_id TEXT PRIMARY KEY,
      active_execution_id TEXT,
      streaming_text TEXT,
      tokens_per_second REAL,
      last_heartbeat_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS work_source_events (
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source_version TEXT,
      causal_event_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
      received_at INTEGER NOT NULL, occurred_at INTEGER, target_key TEXT, payload_bytes INTEGER NOT NULL DEFAULT 0, adapter TEXT, trusted_origin TEXT,
      PRIMARY KEY (source, source_event_id)
    );

CREATE TABLE IF NOT EXISTS work_events_inbox (
      event_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      work_id TEXT NOT NULL,
      subscription_id TEXT,
      intent_revision INTEGER NOT NULL,
      state_version INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      source_version TEXT,
      causal_event_id TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','skipped','blocked','processed')),
      merged_count INTEGER NOT NULL DEFAULT 1,
      merge_deadline_at INTEGER,
      received_at INTEGER NOT NULL,
      processed_at INTEGER
    , queued_while_paused INTEGER NOT NULL DEFAULT 0 CHECK(queued_while_paused IN (0,1)), batch_id TEXT, batch_deadline_at INTEGER, frozen_at INTEGER, frozen_payload_json TEXT, claim_version INTEGER NOT NULL DEFAULT 0, target_key TEXT, process_reason TEXT);

CREATE TABLE IF NOT EXISTS work_events_outbox (
      event_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      work_id TEXT NOT NULL,
      binding_id TEXT,
      intent_revision INTEGER NOT NULL,
      state_version INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      causal_event_id TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','attempted','delivered','unknown','invalidated')),
      attempt_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );

CREATE TABLE IF NOT EXISTS work_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      source TEXT NOT NULL,
      filter_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filter_json)),
      catch_up_policy TEXT NOT NULL CHECK (catch_up_policy IN ('latest','each','skip')),
      max_merge_wait_ms INTEGER NOT NULL,
      max_queue_depth INTEGER NOT NULL,
      stop_condition_text TEXT,
      timezone TEXT,
      cron_expression TEXT,
      next_wake_at INTEGER,
      last_processed_source_version TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      stopped_at INTEGER
    , schedule_revision INTEGER NOT NULL DEFAULT 1, config_revision INTEGER NOT NULL DEFAULT 1, source_target TEXT, version_mode TEXT NOT NULL DEFAULT 'readback', dst_policy TEXT NOT NULL DEFAULT 'first-valid', max_backlog_events INTEGER NOT NULL DEFAULT 400, max_backlog_bytes INTEGER NOT NULL DEFAULT 8388608, last_checked_at INTEGER, stopped_reason TEXT, config_json TEXT NOT NULL DEFAULT '{}');

CREATE TABLE IF NOT EXISTS work_notifications (
      notification_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      semantic_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('result','blocked','closed','handoff','summary')),
      title TEXT NOT NULL,
      body TEXT,
      state_version INTEGER NOT NULL,
      intent_revision INTEGER NOT NULL,
      delivery TEXT NOT NULL DEFAULT 'pending' CHECK (delivery IN ('pending','sent','unknown','failed')),
      channel TEXT,
      idempotency_key TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      external_receipt TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    , card_key TEXT, target_key TEXT, effect_key TEXT);

CREATE TABLE IF NOT EXISTS bot_conversations (
      conversation_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(bot_id), user_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, current_request_id TEXT, archived_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    , team_id TEXT, ingress_kind TEXT NOT NULL DEFAULT 'desktop' CHECK(ingress_kind IN ('desktop','gateway')), source_kind TEXT NOT NULL DEFAULT 'user' CHECK(source_kind IN ('user','peer')));

CREATE TABLE IF NOT EXISTS bot_messages (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES bot_conversations(conversation_id), bot_id TEXT NOT NULL,
      request_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled','unknown','failed')),
      work_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(work_ids_json)), error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(conversation_id,request_id,role)
    );

CREATE TABLE IF NOT EXISTS bot_message_revisions (
      message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS bot_request_runs (
      message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      runtime_key TEXT NOT NULL UNIQUE, context_json TEXT NOT NULL CHECK(json_valid(context_json)),
      transcript_json TEXT CHECK(transcript_json IS NULL OR json_valid(transcript_json)),
      created_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS bot_message_activity (
      message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      activity_json TEXT NOT NULL CHECK(json_valid(activity_json))
    );

CREATE TABLE IF NOT EXISTS bot_message_attachments (
      message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      attachments_json TEXT NOT NULL CHECK(json_valid(attachments_json))
    );

CREATE TABLE IF NOT EXISTS bot_work_attachments (
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
      input_snapshot_id TEXT NOT NULL, attachments_json TEXT NOT NULL CHECK(json_valid(attachments_json)),
      PRIMARY KEY(work_id, input_snapshot_id)
    );

CREATE TABLE IF NOT EXISTS bot_work_user_inputs (
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
      source_message_id TEXT NOT NULL, intent_revision INTEGER NOT NULL, source_version INTEGER NOT NULL,
      messages_json TEXT NOT NULL CHECK(json_valid(messages_json)),
      references_json TEXT NOT NULL CHECK(json_valid(references_json)),
      PRIMARY KEY(work_id, source_message_id)
    );

CREATE TABLE IF NOT EXISTS bot_work_feedback (
      message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json))
    );

CREATE TABLE IF NOT EXISTS bot_send_receipts (
      user_id TEXT NOT NULL, bot_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES bot_conversations(conversation_id),
      user_message_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL, selected_work_id TEXT,
      reference_message_id TEXT, PRIMARY KEY(user_id,bot_id,request_id)
    );

CREATE TABLE IF NOT EXISTS bot_cancel_intents (
      conversation_id TEXT NOT NULL REFERENCES bot_conversations(conversation_id), request_id TEXT NOT NULL,
      confirmed_at INTEGER, PRIMARY KEY(conversation_id,request_id)
    );

CREATE TABLE IF NOT EXISTS work_dispatch_requests (
      operation_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id), task_id TEXT NOT NULL UNIQUE,
      bot_id TEXT NOT NULL, intent_revision INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','dispatched','cancelled','blocked')),
      error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    , continuation_plan_id TEXT REFERENCES work_continuation_plans(plan_id), inbox_event_id TEXT);

CREATE TABLE IF NOT EXISTS bot_work_reads (
      conversation_id TEXT NOT NULL REFERENCES bot_conversations(conversation_id), request_id TEXT NOT NULL,
      work_id TEXT NOT NULL REFERENCES works(work_id), guard_json TEXT NOT NULL CHECK(json_valid(guard_json)),
      PRIMARY KEY(conversation_id,request_id,work_id)
    );

CREATE TABLE IF NOT EXISTS work_native_inbox (
      fact_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id),
      namespace_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      received_at INTEGER NOT NULL, consumed_at INTEGER, consume_error TEXT
    );

CREATE TABLE IF NOT EXISTS work_native_cursors (
      binding_id TEXT PRIMARY KEY REFERENCES work_execution_bindings(binding_id), fact_id TEXT NOT NULL,
      read_failures INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS work_native_recovery (
      binding_id TEXT PRIMARY KEY REFERENCES work_execution_bindings(binding_id), failures INTEGER NOT NULL DEFAULT 0,
      cycle_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      first_failure_at INTEGER NOT NULL, last_error TEXT NOT NULL, exhausted_at INTEGER
    );

CREATE TABLE IF NOT EXISTS work_projection_streams (
      user_id TEXT PRIMARY KEY, epoch TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))), sequence INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE IF NOT EXISTS work_projection_events (
      user_id TEXT NOT NULL, sequence INTEGER NOT NULL, work_id TEXT NOT NULL,
      PRIMARY KEY(user_id,sequence)
    );

CREATE TABLE IF NOT EXISTS work_subitem_results (
    fact_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id), binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id),
    item_id TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), deliverable_id TEXT REFERENCES work_deliverables(deliverable_id),
    created_at INTEGER NOT NULL, UNIQUE(binding_id,item_id)
  );

CREATE TABLE IF NOT EXISTS work_continuation_plans (
    plan_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id), source_binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id),
    operation_id TEXT NOT NULL, intent_revision INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL, owner_bot_id TEXT NOT NULL,
    gap_items_json TEXT NOT NULL CHECK(json_valid(gap_items_json)), reason TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','dispatched','settled','cancelled')), created_at INTEGER NOT NULL,
    UNIQUE(work_id,operation_id)
  );

CREATE TABLE IF NOT EXISTS work_continuation_gaps (
    gap_key TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES work_continuation_plans(plan_id)
  );

CREATE TABLE IF NOT EXISTS work_artifact_dependencies (
    binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id), path TEXT NOT NULL,
    work_id TEXT NOT NULL REFERENCES works(work_id), fingerprint_json TEXT NOT NULL CHECK(json_valid(fingerprint_json)),
    invalidated_at INTEGER, PRIMARY KEY(binding_id,path)
  );

CREATE TABLE IF NOT EXISTS work_generated_artifacts (
    binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id) ON DELETE CASCADE,
    path TEXT NOT NULL, digest TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    PRIMARY KEY(binding_id,path,digest)
  );

CREATE TABLE IF NOT EXISTS work_paused_source_routes (
    source TEXT NOT NULL, source_event_id TEXT NOT NULL, subscription_id TEXT NOT NULL REFERENCES work_subscriptions(subscription_id),
    catch_up_policy TEXT NOT NULL CHECK(catch_up_policy IN ('latest','each','skip')), inbox_event_id TEXT REFERENCES work_events_inbox(event_id),
    PRIMARY KEY(source,source_event_id,subscription_id), FOREIGN KEY(source,source_event_id) REFERENCES work_source_events(source,source_event_id)
  );

CREATE TABLE IF NOT EXISTS work_collaboration_messages (
      message_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id),
      sender_bot_id TEXT, sender_kind TEXT NOT NULL CHECK(sender_kind IN ('user','bot','worker')),
      user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('delegate','accepted','question','result','blocked','change','cancel','handoff')),
      payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      intent_revision INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS work_handoff_preparations (
      preparation_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id), target_bot_id TEXT NOT NULL REFERENCES bots(bot_id),
      state_version INTEGER NOT NULL, owner_epoch INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS work_delegation_adoptions (
      binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id), owner_epoch INTEGER NOT NULL,
      adopted_by_bot_id TEXT NOT NULL REFERENCES bots(bot_id), intent_revision INTEGER NOT NULL,
      input_snapshot_id TEXT NOT NULL, delegated_scope_json TEXT NOT NULL CHECK(json_valid(delegated_scope_json)),
      operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(binding_id,owner_epoch)
    );

CREATE TABLE IF NOT EXISTS work_notification_identity (
      notification_id TEXT PRIMARY KEY REFERENCES work_notifications(notification_id), input_snapshot_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL, sender_bot_id TEXT NOT NULL,
      semantic_validity TEXT NOT NULL DEFAULT 'active' CHECK(semantic_validity IN ('active','superseded','cancelled'))
    );

CREATE TABLE IF NOT EXISTS work_notification_attempts (
      attempt_id TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES work_notifications(notification_id),
      ordinal INTEGER NOT NULL CHECK(ordinal>0), channel TEXT NOT NULL,
      -- Attempt-local identity. Safe retries reuse provider_effect_key instead of minting a new one.
      idempotency_key TEXT NOT NULL,
      provider_effect_key TEXT, payload_hash TEXT,
      delivery_guarantee TEXT, claim_generation INTEGER NOT NULL DEFAULT 1 CHECK(claim_generation>0),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), status TEXT NOT NULL CHECK(status IN ('unknown','sent','missing','failed')),
      claimed_at INTEGER NOT NULL, settled_at INTEGER, receipt TEXT, UNIQUE(notification_id,ordinal)
    );

CREATE TABLE IF NOT EXISTS work_subscription_cursors (
      subscription_id TEXT NOT NULL,
      source TEXT NOT NULL,
      target_key TEXT NOT NULL,
      highest_accepted_version TEXT,
      highest_consumed_version TEXT,
      highest_frozen_version TEXT,
      replay_cursor TEXT,
      enumeration_watermark TEXT,
      accepted_events INTEGER NOT NULL DEFAULT 0,
      consumed_events INTEGER NOT NULL DEFAULT 0,
      accepted_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subscription_id, source, target_key)
    );

CREATE TABLE IF NOT EXISTS work_ingress_routes (
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      inbox_event_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending','accepted','merged','skipped','blocked','duplicate','rejected')),
      reason_code TEXT,
      source_version TEXT,
      trust TEXT NOT NULL DEFAULT 'adapter' CHECK (trust IN ('adapter','host','system')),
      accepted_at INTEGER NOT NULL,
      PRIMARY KEY (source, source_event_id, subscription_id),
      FOREIGN KEY (source, source_event_id) REFERENCES work_source_events(source, source_event_id)
    );

CREATE TABLE IF NOT EXISTS work_schedule_ticks (
      tick_id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL,
      logical_slot_key TEXT NOT NULL,
      planned_at INTEGER NOT NULL,
      effective_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','dispatched','skipped','blocked')),
      merged_from_slot_keys_json TEXT NOT NULL DEFAULT '[]',
      inbox_event_id TEXT,
      offline_gap_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (subscription_id, schedule_revision, logical_slot_key)
    );

CREATE TABLE IF NOT EXISTS work_offline_gaps (
      gap_id TEXT PRIMARY KEY,
      host_session_id TEXT NOT NULL,
      subscription_id TEXT,
      work_id TEXT,
      offline_gap_from INTEGER NOT NULL,
      offline_gap_to INTEGER NOT NULL,
      detected_by TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('evidence','inferred')),
      policy TEXT NOT NULL CHECK (policy IN ('latest','each','skip')),
      policy_revision INTEGER NOT NULL,
      source_cursor TEXT,
      queryable INTEGER NOT NULL DEFAULT 0 CHECK (queryable IN (0,1)),
      recovered_count INTEGER NOT NULL DEFAULT 0,
      merged_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER,
      unknown_count INTEGER,
      state TEXT NOT NULL CHECK (state IN ('open','recovering','recovered','unqueryable')),
      continuation_cursor TEXT,
      gap_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (host_session_id, subscription_id, offline_gap_from)
    );

CREATE TABLE IF NOT EXISTS work_causal_chains (
      chain_id TEXT PRIMARY KEY,
      root_event_id TEXT NOT NULL,
      parent_chain_id TEXT,
      parent_causal_event_id TEXT,
      origin_work_id TEXT NOT NULL,
      origin_bot_id TEXT,
      target_work_id TEXT NOT NULL,
      target_subscription_id TEXT,
      source TEXT NOT NULL,
      source_event_id TEXT,
      input_snapshot_id TEXT,
      target_state_hash TEXT,
      depth INTEGER NOT NULL CHECK (depth >= 0),
      hops INTEGER NOT NULL CHECK (hops >= 0),
      dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
      admission_key TEXT NOT NULL UNIQUE,
      decision TEXT NOT NULL CHECK (decision IN ('admitted','blocked-loop','blocked-depth','blocked-hops','unknown-attribution')),
      reason_code TEXT,
      created_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS work_watch_host_state (
      authority_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      last_scan_at INTEGER,
      last_scan_cursor TEXT,
      active_since INTEGER,
      last_seen_at INTEGER NOT NULL,
      suspend_evidence TEXT,
      stopped_at INTEGER,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS work_deadline_instances (
      work_id TEXT NOT NULL,
      deadline_revision INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('armed','followed-up','cancelled')),
      inbox_event_id TEXT,
      created_at INTEGER NOT NULL,
      followed_at INTEGER,
      PRIMARY KEY (work_id, deadline_revision, deadline_at)
    );

CREATE TABLE IF NOT EXISTS work_result_cards (
      card_key TEXT PRIMARY KEY,
      semantic_card_key TEXT NOT NULL UNIQUE,
      work_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('accepted_result','closure_succeeded','closure_cancelled','closure_failed','blocked_escalation','owner_summary')),
      previous_card_key TEXT,
      intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
      input_snapshot_id TEXT NOT NULL,
      origin_owner_epoch INTEGER NOT NULL CHECK (origin_owner_epoch > 0),
      canonical_outcome_hash TEXT NOT NULL,
      canonical_outcome_json TEXT NOT NULL CHECK (json_valid(canonical_outcome_json)),
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      deliverable_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(deliverable_ids_json)),
      evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
      source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
      artifact_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_refs_json)),
      unverified_scope_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unverified_scope_json)),
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      read_by_user_id TEXT,
      read_version INTEGER NOT NULL DEFAULT 0 CHECK (read_version >= 0),
      CHECK (read_at IS NULL OR read_by_user_id IS NOT NULL)
    );

CREATE TABLE IF NOT EXISTS work_notification_effects (
      effect_key TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL REFERENCES work_notifications(notification_id),
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
      channel TEXT NOT NULL,
      target_key TEXT,
      delivery_guarantee TEXT NOT NULL CHECK (delivery_guarantee IN ('idempotent-queryable','idempotent-unqueryable','best-effort-unqueryable')),
      supports_idempotency_key INTEGER NOT NULL CHECK (supports_idempotency_key IN (0,1)),
      supports_receipt_query INTEGER NOT NULL CHECK (supports_receipt_query IN (0,1)),
      authorization_kind TEXT NOT NULL CHECK (authorization_kind IN ('initial','manual-resend')),
      authorization_operation_id TEXT NOT NULL,
      authorization_reason TEXT,
      resend_of_attempt_id TEXT,
      created_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS gateway_work_targets (
      target_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      connection_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      target_json TEXT NOT NULL CHECK (json_valid(target_json)),
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, conversation_id, source_message_id)
    );

CREATE TABLE IF NOT EXISTS work_owner_summaries (
      work_id TEXT PRIMARY KEY,
      intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
      input_snapshot_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL CHECK (owner_epoch > 0),
      digest TEXT NOT NULL,
      card_key TEXT,
      pending_decision_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_decision_codes_json)),
      handled_watermark_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(handled_watermark_json)),
      updated_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS gateway_inbox (
      delivery_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','reply_pending','completed','blocked','unknown')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
      receipt_mode TEXT NOT NULL CHECK(receipt_mode IN ('pi-durable','none')),
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(channel_id,account_key,chat_id,message_id)
    );

CREATE TABLE IF NOT EXISTS gateway_outbox (
      delivery_id TEXT PRIMARY KEY REFERENCES gateway_inbox(delivery_id) ON DELETE CASCADE,
      reply_text TEXT NOT NULL,
      reply_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','blocked','failed','unknown')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER
    );

CREATE TABLE IF NOT EXISTS gateway_conversation_routes (
      seq INTEGER PRIMARY KEY,
      scope_id TEXT NOT NULL,
      delivery_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('turn','new','obsolete_new')),
      accepted_at INTEGER NOT NULL,
      UNIQUE(scope_id, delivery_key)
    );

CREATE TABLE IF NOT EXISTS work_effect_retirement_audit (
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, provenance_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(entity_type,entity_id)
  );

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    space_id TEXT,
    kind TEXT NOT NULL,
    source_type TEXT NOT NULL,
    entry_file TEXT,
    root_dir TEXT NOT NULL,
    storage_path TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    title TEXT,
    mime_type TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , created_by_message_id TEXT, created_by_tool_call_id TEXT);

CREATE TABLE IF NOT EXISTS artifact_task_revisions (
    task_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS artifact_write_receipts (
    task_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    result_json TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS artifact_task_state (
    task_id TEXT PRIMARY KEY,
    legacy_migrated_at INTEGER
  );

CREATE TABLE IF NOT EXISTS artifact_message_refs (
    task_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    tool_call_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, message_id, artifact_id, relation),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS artifact_file_dependencies (
    artifact_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    dependency_kind TEXT NOT NULL DEFAULT 'runtime',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, file_path),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS library_index_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS notification_activation_targets (
      notification_id TEXT PRIMARY KEY, target_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS dots_foreground_reads (
      input_id TEXT NOT NULL, call_id TEXT NOT NULL, source TEXT NOT NULL, description TEXT NOT NULL,
      characters INTEGER NOT NULL, excerpt TEXT, PRIMARY KEY(input_id,call_id));

CREATE TABLE IF NOT EXISTS dots_foreground_policies (
        input_id TEXT PRIMARY KEY, policy TEXT NOT NULL, exhausted INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS dots_foreground_handoffs (
        input_id TEXT PRIMARY KEY, data TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS answer_rules (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT REFERENCES memory_records(id) ON DELETE CASCADE, source_hash TEXT, enabled INTEGER NOT NULL, config TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS answer_rule_uses (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, input_id TEXT NOT NULL,
        rule_id TEXT NOT NULL REFERENCES answer_rules(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        title TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL,
        PRIMARY KEY(task_id, input_id, rule_id, revision));

CREATE TABLE IF NOT EXISTS answer_rule_turns (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, input_id TEXT NOT NULL,
        rule_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, at INTEGER NOT NULL,
        detail TEXT NOT NULL, phrase TEXT NOT NULL, evidence TEXT, scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'applied', snapshot TEXT,
        PRIMARY KEY(task_id, input_id));

CREATE TABLE IF NOT EXISTS answer_rule_versions (
        rule_id TEXT NOT NULL REFERENCES answer_rules(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        at INTEGER NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', config TEXT NOT NULL,
        PRIMARY KEY(rule_id, revision));

CREATE TABLE IF NOT EXISTS execution_failures (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, cause_code TEXT NOT NULL,
      record_json TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER
    , dismissed_at INTEGER);

CREATE TABLE IF NOT EXISTS conversation_goal_generations (
      task_id TEXT NOT NULL, conversation_id TEXT NOT NULL, generation_id INTEGER NOT NULL,
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
      metadata TEXT NOT NULL CHECK(json_valid(metadata)),
      outcome TEXT,
      PRIMARY KEY(task_id, conversation_id, generation_id)
    );

CREATE TABLE IF NOT EXISTS conversation_goal_auxiliary_scopes (
      execution_scope TEXT PRIMARY KEY, task_id TEXT NOT NULL, conversation_id TEXT NOT NULL, generation_id INTEGER NOT NULL,
      FOREIGN KEY(task_id, conversation_id, generation_id) REFERENCES conversation_goal_generations(task_id, conversation_id, generation_id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS conversation_goal_learned_skills (
      task_id TEXT NOT NULL, conversation_id TEXT NOT NULL, generation_id INTEGER NOT NULL,
      evidence_key TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      PRIMARY KEY(task_id, conversation_id, generation_id, evidence_key),
      FOREIGN KEY(task_id, conversation_id, generation_id) REFERENCES conversation_goal_generations(task_id, conversation_id, generation_id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS conversation_goal_saved_artifact_verification (
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL,
      verified_at INTEGER NOT NULL,
      PRIMARY KEY(work_id,artifact_id)
    );

CREATE TABLE IF NOT EXISTS task_expert_bindings (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      desired_json TEXT, active_json TEXT,
      desired_skills_json TEXT NOT NULL DEFAULT '[]', active_skills_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS cron_run_inputs (
      run_id TEXT PRIMARY KEY REFERENCES cron_runs(id) ON DELETE CASCADE, request_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS dots_schedule_origins(job_id TEXT PRIMARY KEY REFERENCES cron_jobs(id) ON DELETE CASCADE,
        source TEXT NOT NULL, conversation INTEGER NOT NULL, entry INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS dots_schedule_scopes(job_id TEXT PRIMARY KEY REFERENCES cron_jobs(id) ON DELETE CASCADE,
        task_id TEXT, space_id TEXT);

CREATE TABLE IF NOT EXISTS dots_schedule_holds(job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
        holder TEXT NOT NULL, PRIMARY KEY(job_id,holder));

CREATE TABLE IF NOT EXISTS dots_schedule_notices(job_id TEXT PRIMARY KEY REFERENCES cron_jobs(id) ON DELETE CASCADE,
        occurrence INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS external_agent_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'acp',
        status TEXT NOT NULL,
        cwd TEXT NOT NULL,
        session_id TEXT,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        display_text TEXT,
        attachments_json TEXT,
        final_text TEXT NOT NULL DEFAULT '',
        thinking_text TEXT NOT NULL DEFAULT '',
        tools_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        continued_from_run_id TEXT,
        continuation_mode TEXT, output_cursor INTEGER NOT NULL DEFAULT 0, artifact_refs_json TEXT NOT NULL DEFAULT '[]', resume_supported INTEGER NOT NULL DEFAULT 0, cancellation_evidence TEXT, cancel_supported INTEGER NOT NULL DEFAULT 1, verification_status TEXT NOT NULL DEFAULT 'not_verified', recovery_state TEXT NOT NULL DEFAULT 'none', recovery_message TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS task_request_diagnostics (
      request_id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));

CREATE TABLE IF NOT EXISTS task_tool_diagnostics (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));

CREATE TABLE IF NOT EXISTS scope_tool_diagnostics (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,started_at INTEGER NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)));

CREATE TABLE IF NOT EXISTS bot_gateway_conversations (
    conversation_id TEXT PRIMARY KEY REFERENCES bot_conversations(conversation_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, bot_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    connection_key TEXT NOT NULL, chat_id TEXT NOT NULL, audience TEXT NOT NULL CHECK(audience IN ('private','shared'))
  );

CREATE TABLE IF NOT EXISTS bot_turn_origins (
    user_message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    origin_json TEXT NOT NULL CHECK(json_valid(origin_json))
  );

CREATE TABLE IF NOT EXISTS bot_gateway_references (
    user_message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
    context_text TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS work_execution_metrics(
      binding_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, value_json TEXT, dirty INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS work_execution_usage(
      binding_id TEXT NOT NULL, call_key TEXT NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(binding_id,call_key));

CREATE TABLE IF NOT EXISTS work_execution_timings(binding_id TEXT NOT NULL,message_id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(binding_id,message_id));

CREATE TABLE IF NOT EXISTS conversation_goal_sources (
      work_id TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
      source_json TEXT NOT NULL CHECK(json_valid(source_json))
    );

CREATE TABLE IF NOT EXISTS work_teams (
    work_id TEXT PRIMARY KEY REFERENCES works(work_id), user_id TEXT NOT NULL,
    operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
    intent_revision INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(user_id,operation_id));

CREATE TABLE IF NOT EXISTS work_team_ownership (
      work_id TEXT PRIMARY KEY REFERENCES work_teams(work_id), team_id TEXT NOT NULL, team_name TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS work_team_record_visibility (
      work_id TEXT PRIMARY KEY REFERENCES work_teams(work_id), removed_at INTEGER, removal_requested_at INTEGER);

CREATE TABLE IF NOT EXISTS work_team_executions (
      work_id TEXT NOT NULL REFERENCES work_teams(work_id), ordinal INTEGER NOT NULL,
      bot_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      responsibility TEXT NOT NULL, scopes_json TEXT NOT NULL, input_json TEXT,
      error TEXT, cancelled INTEGER NOT NULL DEFAULT 0, reported INTEGER NOT NULL DEFAULT 0, reported_binding_id TEXT, original_input_json TEXT,
      PRIMARY KEY(work_id,ordinal));

CREATE TABLE IF NOT EXISTS work_team_workspaces (
      work_id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL, entity TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS work_team_execution_history (
      task_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, input_json TEXT, execution_json TEXT NOT NULL, archived_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS work_team_templates (
      template_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, name TEXT NOT NULL, plan_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      deleted_at INTEGER, UNIQUE(user_id,operation_id));

CREATE TABLE IF NOT EXISTS work_team_recovery_attempts (
      recovery_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      role TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      input_snapshot_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      source_binding_id TEXT,
      generation INTEGER NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending','claimed','dispatched','completed','stopped')),
      failure_class TEXT NOT NULL,
      failure_message TEXT NOT NULL,
      progress_hash TEXT,
      outcome TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      binding_id TEXT,
      claimed_at INTEGER,
      dispatched_at INTEGER,
      settled_at INTEGER,
      created_at INTEGER NOT NULL, missing_json TEXT,
      UNIQUE(work_id,task_id,source_key),
      UNIQUE(work_id,task_id,generation));

CREATE TABLE IF NOT EXISTS work_team_watch_cycles (
      work_id TEXT NOT NULL, inbox_event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(work_id,sequence));

CREATE TABLE IF NOT EXISTS bot_identity_roles (
      user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role='primary'),
      bot_id TEXT NOT NULL UNIQUE REFERENCES bots(bot_id) ON DELETE CASCADE,
      assigned_at INTEGER NOT NULL, PRIMARY KEY(user_id,role));

CREATE TABLE IF NOT EXISTS bot_collaborations (
        collaboration_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        source_bot_id TEXT NOT NULL, source_conversation_id TEXT NOT NULL,
        target_bot_id TEXT NOT NULL, initiation_key TEXT NOT NULL UNIQUE,
        initiation_hash TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        work_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        status TEXT NOT NULL, times_json TEXT NOT NULL CHECK(json_valid(times_json)),
        next_ordinal INTEGER NOT NULL DEFAULT 0
      );

CREATE TABLE IF NOT EXISTS bot_collaboration_requests (
        collaboration_id TEXT NOT NULL REFERENCES bot_collaborations(collaboration_id) ON DELETE RESTRICT,
        conversation_id TEXT NOT NULL, request_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL,
        PRIMARY KEY(collaboration_id,request_id)
      );

CREATE TABLE IF NOT EXISTS bot_collaboration_messages (
        message_id TEXT PRIMARY KEY, collaboration_id TEXT NOT NULL REFERENCES bot_collaborations(collaboration_id) ON DELETE RESTRICT,
        operation_key TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_hash TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK(json_valid(value_json)), UNIQUE(collaboration_id,operation_key),
        UNIQUE(collaboration_id,ordinal)
      );

CREATE TABLE IF NOT EXISTS bot_collaboration_events (
        event_id TEXT PRIMARY KEY, collaboration_id TEXT NOT NULL REFERENCES bot_collaborations(collaboration_id) ON DELETE RESTRICT,
        operation_key TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_hash TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK(json_valid(value_json)), UNIQUE(collaboration_id,operation_key),
        UNIQUE(collaboration_id,ordinal)
      );

CREATE TABLE IF NOT EXISTS bot_collaboration_previews (
        collaboration_id TEXT NOT NULL REFERENCES bot_collaborations(collaboration_id) ON DELETE RESTRICT,
        exchange_id TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        PRIMARY KEY(collaboration_id,exchange_id)
      );

CREATE TABLE IF NOT EXISTS bot_collaboration_message_order (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE REFERENCES bot_collaboration_messages(message_id) ON DELETE CASCADE
      );

CREATE TABLE IF NOT EXISTS bot_foreground_metrics(message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE, value_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS bot_foreground_usage(message_id TEXT NOT NULL REFERENCES bot_messages(message_id) ON DELETE CASCADE, generation_id INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(message_id,generation_id));

CREATE TABLE IF NOT EXISTS bot_peer_calls (
      call_id TEXT PRIMARY KEY, parent_message_id TEXT NOT NULL REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      value_json TEXT NOT NULL CHECK(json_valid(value_json))
    );

CREATE TABLE IF NOT EXISTS bot_peer_inputs (
      user_message_id TEXT PRIMARY KEY, assistant_message_id TEXT NOT NULL UNIQUE,
      origin_json TEXT NOT NULL CHECK(json_valid(origin_json))
    );

CREATE TABLE IF NOT EXISTS bot_peer_deliveries (
      operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, origin_json TEXT NOT NULL CHECK(json_valid(origin_json)),
      text TEXT NOT NULL, target_bot_id TEXT NOT NULL, conversation_id TEXT, request_id TEXT NOT NULL UNIQUE,
      accepted_message_id TEXT, cancelled_at INTEGER, error TEXT,
      journal_message_id TEXT, observed_status TEXT, returned_at INTEGER
    );

CREATE TABLE IF NOT EXISTS bot_message_segments (
      message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      segments_json TEXT NOT NULL CHECK(json_valid(segments_json))
    );

CREATE TABLE IF NOT EXISTS bot_message_tools (
      message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      tools_json TEXT NOT NULL CHECK(json_valid(tools_json))
    );

CREATE TABLE IF NOT EXISTS bot_clarification_answers (
      question_message_id TEXT NOT NULL REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL, answer_message_id TEXT NOT NULL REFERENCES bot_messages(message_id) ON DELETE CASCADE,
      PRIMARY KEY(question_message_id,goal_id));

CREATE TABLE IF NOT EXISTS bot_message_execution_settings (message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE, bot_id TEXT NOT NULL, settings_json TEXT NOT NULL, profile_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS bot_execution_settings (
      bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE, revision INTEGER NOT NULL, settings_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS bot_work_settings (
      work_id TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE, settings_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS bot_workspace_navigation_spaces (
      space_id TEXT PRIMARY KEY, auto_name TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS conversation_goal_continuations (
    work_id TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    attempt_serial INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    tokens_budget INTEGER,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    usage_cursor INTEGER NOT NULL DEFAULT 0,
    progress_fingerprint TEXT,
    progress_stalls INTEGER NOT NULL DEFAULT 0,
    run_cursor INTEGER NOT NULL DEFAULT 0,
    last_token_at INTEGER,
    last_continuation_at INTEGER,
    state TEXT NOT NULL DEFAULT 'idle'
      CHECK (state IN ('idle','igniting','deferred','exhausted')),
    defer_reason TEXT
      CHECK (defer_reason IS NULL OR defer_reason IN
        ('user_interrupt','turn_aborted','run_failed','restart','no_progress','manual_stop','attempts','budget')),
    deferred_at INTEGER,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS conversation_goal_usage_events (
    event_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS conversation_goal_last_check (
    work_id TEXT PRIMARY KEY REFERENCES conversation_goal_continuations(work_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('settled','resumed','continued')),
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS conversation_goal_last_wake (
    work_id TEXT PRIMARY KEY REFERENCES conversation_goal_continuations(work_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('settled','resumed','continued')),
    at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS work_gap_coverages (
      fact_id TEXT NOT NULL REFERENCES work_subitem_results(fact_id),
      work_id TEXT NOT NULL REFERENCES works(work_id), operation_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at INTEGER NOT NULL,
      PRIMARY KEY(fact_id,operation_id)
    );

CREATE TABLE IF NOT EXISTS work_record_archive (
      work_id TEXT PRIMARY KEY REFERENCES works(work_id), archived_at INTEGER NOT NULL, deleted_at INTEGER);

CREATE TABLE IF NOT EXISTS work_source_associations (
      user_id TEXT NOT NULL, source_key TEXT NOT NULL, source_version TEXT NOT NULL,
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
      previous_work_id TEXT, source_revision INTEGER, observed_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,source_key,source_version));

CREATE TABLE IF NOT EXISTS work_automatic_completion (
      binding_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, consumed_at INTEGER, recovered INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS work_automatic_completion_deliveries (binding_id TEXT PRIMARY KEY, summary TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'completed', goal_reviewed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS work_completion_review_evidence (binding_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS work_automatic_recovery (
    source_binding_id TEXT PRIMARY KEY REFERENCES work_execution_bindings(binding_id),
    plan_id TEXT NOT NULL, fingerprint TEXT NOT NULL, mode TEXT NOT NULL,
    created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS work_terminal_evidence_reads (
      binding_id TEXT PRIMARY KEY REFERENCES work_execution_bindings(binding_id), version INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS work_continuation_progress (
    binding_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, intent_revision INTEGER NOT NULL,
    input_snapshot_id TEXT NOT NULL, fingerprint TEXT NOT NULL, recorded_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS task_board_days(
        id TEXT NOT NULL,kind TEXT NOT NULL,day TEXT NOT NULL,at INTEGER NOT NULL,detail TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(id,kind,day)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS task_board_plans(id TEXT PRIMARY KEY, day TEXT, later_until INTEGER, deferred_at INTEGER);

CREATE TABLE IF NOT EXISTS dots_delegations(
      seq INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', text TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, supersedes INTEGER NOT NULL DEFAULT 0, interaction_id TEXT, request_json TEXT, space_id TEXT, space_path TEXT, cwd TEXT, goal_id TEXT);

CREATE TABLE IF NOT EXISTS dots_tool_observations(
        operation_id TEXT PRIMARY KEY, at INTEGER NOT NULL, tool TEXT NOT NULL, phase TEXT NOT NULL,
        next_at INTEGER, last_report_at INTEGER);

CREATE TABLE IF NOT EXISTS dots_verified_progress(
        operation_id TEXT NOT NULL, identity TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(operation_id,identity));

CREATE TABLE IF NOT EXISTS dots_tool_observation_receipts(
        operation_id TEXT NOT NULL, conversation TEXT NOT NULL, tool_task INTEGER NOT NULL, phase TEXT NOT NULL,
        PRIMARY KEY(operation_id,conversation,tool_task,phase));

CREATE TABLE IF NOT EXISTS dots_control_receipts(operation_id TEXT PRIMARY KEY,target_task_id TEXT NOT NULL,outcome TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS dots_target_controls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,operation_id TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS dots_dependency_waits(operation_id TEXT PRIMARY KEY, prerequisite_id TEXT NOT NULL,
        title TEXT NOT NULL, deadline_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS dots_verified_commits(operation_id TEXT PRIMARY KEY,sha TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS dots_reply_origins(source TEXT PRIMARY KEY, conversation INTEGER NOT NULL, entry INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS dots_followup_plans(operation_id TEXT PRIMARY KEY,plan TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS dots_followup_requests(operation_id TEXT PRIMARY KEY, request TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS dots_reply_events(event_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL, task_id TEXT NOT NULL,
        status TEXT NOT NULL, interaction_id TEXT, snapshot TEXT NOT NULL, reply TEXT, settled INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS dots_deferred_requirements (id TEXT PRIMARY KEY, conversationId INTEGER NOT NULL, taskId TEXT NOT NULL, prerequisiteId TEXT NOT NULL, text TEXT NOT NULL, operationId TEXT, applied INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS dots_control_batches(id TEXT PRIMARY KEY, selection TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS dots_proactive_pauses(scope TEXT PRIMARY KEY,timer_ids TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS dots_continuation_targets(source TEXT NOT NULL,task_id TEXT NOT NULL,
        prior_operation_id TEXT,assignment_quote TEXT,PRIMARY KEY(source,task_id));

CREATE TABLE IF NOT EXISTS dots_file_watches(
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,space_id TEXT NOT NULL,root TEXT NOT NULL,file TEXT NOT NULL,
      instruction TEXT NOT NULL,source TEXT NOT NULL,baseline TEXT NOT NULL,input_version TEXT NOT NULL,
      state TEXT NOT NULL,note TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS dots_file_watch_notices(watch_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(watch_id,revision));

CREATE TABLE IF NOT EXISTS dots_report_text (
      delivery_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL, text TEXT NOT NULL
    );

CREATE TABLE IF NOT EXISTS dots_proactive_delivery (
      delivery_key TEXT PRIMARY KEY, source TEXT NOT NULL, text TEXT NOT NULL, queued_at INTEGER NOT NULL,
      message_id TEXT, workspace TEXT, archived_at INTEGER, archive_retry_at INTEGER
    );

CREATE TABLE IF NOT EXISTS bot_gateway_continuations(delivery_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE);

CREATE TABLE IF NOT EXISTS gateway_memory_isolation (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), installed_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS gateway_dots_bindings (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, connection_key TEXT NOT NULL, sender_id TEXT NOT NULL,
        active INTEGER NOT NULL, bound_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS gateway_dots_admissions (
        channel_id TEXT NOT NULL, connection_key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
        binding_id TEXT REFERENCES gateway_dots_bindings(id), PRIMARY KEY(channel_id, connection_key, chat_id, message_id)
      );

CREATE TABLE IF NOT EXISTS gateway_dots_tasks (
        task_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES gateway_dots_bindings(id)
      );

CREATE TABLE IF NOT EXISTS work_closure_review_corrections (binding_id TEXT PRIMARY KEY, action TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS work_report_contexts (binding_id TEXT PRIMARY KEY, context_json TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS durable_bot_bindings (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, backend TEXT NOT NULL CHECK(backend = 'pi-durable'), directory TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS durable_bot_memory_projection (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, entry_id INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS durable_bot_workspace_moves (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, from_cwd TEXT NOT NULL, to_cwd TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS durable_bot_message_workspaces (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, message_id TEXT NOT NULL, cwd TEXT NOT NULL, PRIMARY KEY(task_id, message_id));

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_order ON cron_runs(job_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_order ON cron_runs(started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_gateway_messages_chat
        ON gateway_messages(channel_id, chat_id, created_at);

CREATE INDEX IF NOT EXISTS idx_project_posts_project
        ON project_posts(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_todos_project
        ON project_todos(project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_runtime_snapshots_task
        ON task_runtime_context_snapshots(task_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name
        ON projects(name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_project_resources_project
        ON project_resources(project_id, sort_order ASC, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runtime_snapshots_execution
        ON task_runtime_context_snapshots(execution_id);

CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_instructions_hash
        ON task_runtime_context_snapshots(instructions_hash) WHERE instructions_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_capabilities_hash
        ON task_runtime_context_snapshots(capabilities_hash) WHERE capabilities_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_inline_payloads
        ON task_runtime_context_snapshots(id) WHERE instructions_hash IS NULL OR capabilities_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_spaces_root_name ON spaces(name COLLATE NOCASE) WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_spaces_child_name ON spaces(parent_id, name COLLATE NOCASE) WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_spaces_parent ON spaces(parent_id);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);

CREATE INDEX IF NOT EXISTS idx_task_execution_workspace_state_state
        ON task_execution_workspace_state(state);

CREATE INDEX IF NOT EXISTS idx_cad_models_task ON cad_models(task_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cad_models_graph ON cad_models(graph_id);

CREATE INDEX IF NOT EXISTS idx_task_code_review_status ON task_code_review(task_id, status);

CREATE INDEX IF NOT EXISTS idx_project_events_project
        ON project_events(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_events_ref
        ON project_events(project_id, source, ref);

CREATE INDEX IF NOT EXISTS idx_pep_event
        ON project_event_promotions(project_id, event_id);

CREATE INDEX IF NOT EXISTS idx_pep_target
        ON project_event_promotions(project_id, target_kind, target_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pep_event_kind
        ON project_event_promotions(project_id, event_id, target_kind);

CREATE UNIQUE INDEX IF NOT EXISTS uq_library_spaces_workspace
      ON library_spaces(workspace_id) WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_library_collections_space
        ON library_collections(space_id, parent_id, name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_library_items_space
        ON library_items(space_id, collection_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_items_visited
        ON library_items(last_visited_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_versions_item
        ON library_versions(item_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_library_text_saves_pending
        ON library_text_saves(root) WHERE committed=0;

CREATE INDEX IF NOT EXISTS idx_task_library_refs_task
        ON task_library_references(task_id, added_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_library_refs_item
        ON task_library_references(item_id);

CREATE INDEX IF NOT EXISTS idx_project_context_pins_project
        ON project_context_pins(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_context_pins_item
        ON project_context_pins(item_id);

CREATE INDEX IF NOT EXISTS idx_project_reviews_project
        ON project_reviews(project_id, reviewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_actions_project
        ON project_action_proposals(project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);

CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_file, ts);

CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, dismissed_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications(source_type, source_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_library_links_workspace
        ON workspace_library_links(workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_library_links_library
        ON workspace_library_links(library_space_id);

CREATE INDEX IF NOT EXISTS idx_workspace_library_collection_links_workspace
        ON workspace_library_collection_links(workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_library_collection_links_library
        ON workspace_library_collection_links(library_space_id);

CREATE INDEX IF NOT EXISTS idx_workspace_library_collection_links_collection
        ON workspace_library_collection_links(collection_id);

CREATE INDEX IF NOT EXISTS idx_python_project_bindings_bound_at
        ON python_project_bindings(bound_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_chunks_item
        ON library_chunks(item_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_library_chunks_hash
        ON library_chunks(hash);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_hash
        ON library_chunk_embeddings(chunk_hash);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model
        ON library_chunk_embeddings(model_id, model_version);

CREATE INDEX IF NOT EXISTS idx_wge_from ON work_graph_edges(from_type, from_id);

CREATE INDEX IF NOT EXISTS idx_wge_to   ON work_graph_edges(to_type, to_id);

CREATE INDEX IF NOT EXISTS idx_wge_rel  ON work_graph_edges(relation);

CREATE INDEX IF NOT EXISTS idx_gadgets_scope ON gadgets(scope_type, scope_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_gadgets_created_by_task ON gadgets(created_by_task_id);

CREATE INDEX IF NOT EXISTS idx_gadgets_blueprint ON gadgets(blueprint_id);

CREATE INDEX IF NOT EXISTS idx_blueprints_kind_updated ON blueprints(kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_records_status_updated ON memory_records(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_records_kind_updated ON memory_records(kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_records_hash ON memory_records(content_hash);

CREATE INDEX IF NOT EXISTS idx_memory_records_source_task ON memory_records(source_task_id);

CREATE INDEX IF NOT EXISTS idx_memory_records_dots_projection
        ON memory_records(kind, updated_at DESC, id)
        WHERE (source_task_id='mybuddy-dots' OR json_extract(metadata_json, '$.dotsPrivateGateway')=1)
          AND status='active' AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_records_dots_projection_due
        ON memory_records(valid_from)
        WHERE (source_task_id='mybuddy-dots' OR json_extract(metadata_json, '$.dotsPrivateGateway')=1)
          AND status='active' AND valid_until IS NULL AND valid_from IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_scope_binding ON memory_scopes(memory_id, scope_type, COALESCE(scope_id,''), binding);

CREATE INDEX IF NOT EXISTS idx_memory_scopes_lookup ON memory_scopes(scope_type, scope_id, memory_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_evidence_ref ON memory_evidence(memory_id, evidence_kind, ref_id);

CREATE INDEX IF NOT EXISTS idx_memory_evidence_ref ON memory_evidence(evidence_kind, ref_id);

CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_memory_id, relation);

CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_memory_id, relation);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_hash ON memory_embeddings(content_hash);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_task ON memory_candidates(task_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_turn_assistant_message ON memory_turns(assistant_message_id) WHERE assistant_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_turns_task_time ON memory_turns(task_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_turns_state ON memory_turns(extraction_state, captured_at);

CREATE INDEX IF NOT EXISTS idx_memory_turns_task_hash ON memory_turns(task_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_memory_projection_proposals_status ON memory_projection_proposals(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_skill_effectiveness_skill ON memory_skill_effectiveness(skill_id, invoked_at DESC, exposed_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_skill_effectiveness_task ON memory_skill_effectiveness(task_id, exposed_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_skill_effectiveness_feedback ON memory_skill_effectiveness(feedback_kind, feedback_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_skill_revision_identity ON memory_skill_revision_candidates(skill_id,COALESCE(base_candidate_id,''),base_content_hash,feedback_signature);

CREATE INDEX IF NOT EXISTS idx_memory_skill_revision_status ON memory_skill_revision_candidates(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_skill_revision_skill ON memory_skill_revision_candidates(skill_id, base_candidate_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_skill_candidates_status ON memory_skill_candidates(status, score DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_skill_candidates_scope ON memory_skill_candidates(scope_type, scope_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_scenarios_scope ON memory_scenarios(scope_type, scope_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_core_profiles_scope ON memory_core_profiles(scope_type, scope_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_loadout_task_created
        ON agent_loadout_observations(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_branches_parent
        ON conversation_branches(parent_task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conversation_branches_root
        ON conversation_branches(root_task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_execution_attempt_scope
    ON execution_attempts(task_id, execution_id, assistant_message_id, target);

CREATE INDEX IF NOT EXISTS idx_conversation_interactions_task_message
        ON conversation_interactions(task_id, assistant_message_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_interactions_pending_execution
        ON conversation_interactions(execution_id)
        WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_bots_user_status ON bots(user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_expert_pending
      ON bot_expert_versions(bot_id) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_works_owner_lifecycle ON works(owner_bot_id, lifecycle);

CREATE INDEX IF NOT EXISTS idx_works_user_lifecycle ON works(user_id, lifecycle, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_works_legacy_task ON works(legacy_task_id, lifecycle);

CREATE INDEX IF NOT EXISTS idx_works_user_summary_page ON works(user_id, updated_at DESC, work_id);

CREATE INDEX IF NOT EXISTS idx_work_summary_subitems ON work_subitem_results(work_id, binding_id);

CREATE INDEX IF NOT EXISTS idx_work_summary_continuations ON work_continuation_plans(work_id, source_binding_id);

CREATE INDEX IF NOT EXISTS idx_work_conversations_conv
      ON work_conversations(conversation_id, last_referenced_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_bindings_work
      ON work_execution_bindings(work_id, status, admitted_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_binding_namespace
      ON work_execution_bindings(task_id, durable_store_key, conversation_id, operation_id);

CREATE INDEX IF NOT EXISTS idx_work_admissions_open
      ON work_action_admissions(work_id, state);

CREATE INDEX IF NOT EXISTS idx_work_deliverables_work
      ON work_deliverables(work_id, status, intent_revision);

CREATE INDEX IF NOT EXISTS idx_work_evidence_work ON work_evidence(work_id, criterion_ids_json);

CREATE INDEX IF NOT EXISTS idx_work_evidence_snapshot ON work_evidence(work_id, input_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_work_blockers_work_status ON work_blockers(work_id, status);

CREATE INDEX IF NOT EXISTS idx_work_receipts_work ON work_operation_receipts(work_id, created_at);

CREATE INDEX IF NOT EXISTS idx_work_inbox_pending
      ON work_events_inbox(work_id, status, received_at);

CREATE INDEX IF NOT EXISTS idx_work_inbox_subscription
      ON work_events_inbox(subscription_id, status, received_at);

CREATE INDEX IF NOT EXISTS idx_work_outbox_pending ON work_events_outbox(delivery_status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_work_outbox_created ON work_events_outbox(work_id) WHERE event_type='work.created';

CREATE INDEX IF NOT EXISTS idx_work_subscriptions_work ON work_subscriptions(work_id, stopped_at);

CREATE INDEX IF NOT EXISTS idx_work_subscriptions_source_active ON work_subscriptions(source, stopped_at, created_at);

CREATE INDEX IF NOT EXISTS idx_work_subscriptions_wake ON work_subscriptions(next_wake_at);

CREATE INDEX IF NOT EXISTS idx_work_notifications_work ON work_notifications(work_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_pending_dispatch ON work_dispatch_requests(work_id,intent_revision,input_snapshot_id) WHERE state='pending';

CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_personal_live ON bot_conversations(user_id,bot_id) WHERE archived_at IS NULL AND team_id IS NULL AND ingress_kind='desktop' AND source_kind='user';

CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_team_live ON bot_conversations(user_id,team_id) WHERE archived_at IS NULL AND team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_collaboration_order ON work_collaboration_messages(work_id,created_at,message_id);

CREATE INDEX IF NOT EXISTS idx_work_ingress_routes_subscription
      ON work_ingress_routes(subscription_id, state, accepted_at);

CREATE INDEX IF NOT EXISTS idx_work_ingress_routes_inbox
      ON work_ingress_routes(inbox_event_id);

CREATE INDEX IF NOT EXISTS idx_work_schedule_ticks_work
      ON work_schedule_ticks(work_id, status, effective_at);

CREATE INDEX IF NOT EXISTS idx_work_offline_gaps_work
      ON work_offline_gaps(work_id, state, offline_gap_from);

CREATE INDEX IF NOT EXISTS idx_work_causal_chains_state
      ON work_causal_chains(target_work_id, target_state_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_work_causal_chains_root
      ON work_causal_chains(root_event_id);

CREATE INDEX IF NOT EXISTS idx_work_deadline_instances_pending
      ON work_deadline_instances(state, deadline_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_blocker_reason
      ON work_blockers(work_id, reason_code) WHERE status='open' AND reason_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_inbox_batch
      ON work_events_inbox(batch_id, status, merge_deadline_at);

CREATE INDEX IF NOT EXISTS idx_work_inbox_target
      ON work_events_inbox(subscription_id, target_key, status, received_at);

CREATE INDEX IF NOT EXISTS idx_work_result_cards_work
      ON work_result_cards(work_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_result_cards_outcome
      ON work_result_cards(work_id, intent_revision, input_snapshot_id, canonical_outcome_hash);

CREATE INDEX IF NOT EXISTS idx_work_result_cards_unread
      ON work_result_cards(user_id, read_at) WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_work_notification_effects_notification
      ON work_notification_effects(notification_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_notification_effect_initial
      ON work_notification_effects(notification_id) WHERE authorization_kind = 'initial';

CREATE INDEX IF NOT EXISTS idx_gateway_work_targets_conversation
      ON gateway_work_targets(user_id, conversation_id, source_message_id);

CREATE INDEX IF NOT EXISTS gateway_inbox_resume ON gateway_inbox(channel_id,account_key,status,created_at,delivery_id);

CREATE INDEX IF NOT EXISTS gateway_inbox_retention ON gateway_inbox(status,updated_at,delivery_id);

CREATE INDEX IF NOT EXISTS gateway_outbox_retry ON gateway_outbox(status,next_attempt_at,delivery_id);

CREATE INDEX IF NOT EXISTS idx_gateway_conversation_current ON gateway_conversation_routes(scope_id, kind, seq DESC);

CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE INDEX IF NOT EXISTS idx_artifacts_space ON artifacts(space_id);

CREATE INDEX IF NOT EXISTS idx_artifact_message_refs_task
    ON artifact_message_refs(task_id, message_id);

CREATE INDEX IF NOT EXISTS idx_artifact_message_refs_artifact
    ON artifact_message_refs(task_id, artifact_id);

CREATE INDEX IF NOT EXISTS idx_artifact_file_deps_artifact
    ON artifact_file_dependencies(artifact_id);

CREATE INDEX IF NOT EXISTS answer_rules_scope ON answer_rules(enabled, project_id);

CREATE INDEX IF NOT EXISTS answer_rule_uses_recent ON answer_rule_uses(at DESC);

CREATE INDEX IF NOT EXISTS answer_rule_turns_recent ON answer_rule_turns(at DESC);

CREATE INDEX IF NOT EXISTS answer_rule_turns_source_history ON answer_rule_turns(task_id,rule_id,at DESC);

CREATE INDEX IF NOT EXISTS answer_rule_versions_recent ON answer_rule_versions(rule_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_execution_failures_task ON execution_failures(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_goal_generations_work ON conversation_goal_generations(work_id);

CREATE INDEX IF NOT EXISTS idx_external_agent_runs_task_started
        ON external_agent_runs(task_id, started_at);

CREATE INDEX IF NOT EXISTS idx_task_request_diagnostics ON task_request_diagnostics(task_id, started_at);

CREATE INDEX IF NOT EXISTS idx_task_tool_diagnostics ON task_tool_diagnostics(task_id, started_at);

CREATE INDEX IF NOT EXISTS idx_scope_tool_diagnostics ON scope_tool_diagnostics(task_id,started_at);

CREATE INDEX IF NOT EXISTS idx_task_request_scope ON task_request_diagnostics(json_extract(record_json,'$.executionScope'),started_at);

CREATE INDEX IF NOT EXISTS idx_task_diagnostic_waits ON conversation_interactions(task_id, execution_id);

CREATE INDEX IF NOT EXISTS idx_bot_turn_origins_conversation ON bot_turn_origins(conversation_id);

CREATE INDEX IF NOT EXISTS idx_work_team_ownership_team ON work_team_ownership(team_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_team_template_name ON work_team_templates(user_id,name) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_work_team_recovery_state
      ON work_team_recovery_attempts(work_id,state,created_at);

CREATE INDEX IF NOT EXISTS idx_bot_collaboration_source
        ON bot_collaborations(user_id,source_bot_id,created_at DESC,collaboration_id DESC);

CREATE INDEX IF NOT EXISTS idx_bot_collaboration_target
        ON bot_collaborations(user_id,target_bot_id,created_at DESC,collaboration_id DESC);

CREATE INDEX IF NOT EXISTS idx_bot_collaboration_conversation
        ON bot_collaborations(user_id,source_conversation_id,created_at DESC,collaboration_id DESC);

CREATE INDEX IF NOT EXISTS idx_bot_collaboration_request_user_message ON bot_collaboration_requests(user_message_id);

CREATE INDEX IF NOT EXISTS idx_bot_collaboration_request_assistant ON bot_collaboration_requests(assistant_message_id);

CREATE INDEX IF NOT EXISTS idx_bot_collaboration_message_page ON bot_collaboration_messages(collaboration_id,ordinal DESC);

CREATE INDEX IF NOT EXISTS idx_bot_collaboration_event_page ON bot_collaboration_events(collaboration_id,ordinal DESC);

CREATE INDEX IF NOT EXISTS idx_bot_peer_calls_parent ON bot_peer_calls(parent_message_id);

CREATE INDEX IF NOT EXISTS idx_bot_peer_pending ON bot_peer_deliveries(user_id) WHERE accepted_message_id IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bot_peer_journal ON bot_peer_deliveries(journal_message_id);

CREATE INDEX IF NOT EXISTS idx_bot_peer_collaboration ON bot_peer_deliveries(user_id,json_extract(origin_json,'$.collaborationId'),json_extract(origin_json,'$.kind'));

CREATE INDEX IF NOT EXISTS idx_bot_peer_assistant ON bot_peer_deliveries(accepted_message_id);

CREATE INDEX IF NOT EXISTS idx_bot_peer_input_source ON bot_peer_inputs(json_extract(origin_json,'$.sourceConversationId'),json_extract(origin_json,'$.kind'));

CREATE INDEX IF NOT EXISTS idx_bot_messages_conversation_ordinal ON bot_messages(conversation_id,ordinal);

CREATE INDEX IF NOT EXISTS idx_bot_messages_conversation_request ON bot_messages(conversation_id,request_id);

CREATE INDEX IF NOT EXISTS idx_bot_peer_inputs_assistant ON bot_peer_inputs(assistant_message_id);

CREATE INDEX IF NOT EXISTS idx_bot_collaboration_requests_assistant ON bot_collaboration_requests(assistant_message_id);

CREATE INDEX IF NOT EXISTS idx_goal_continuations_task
    ON conversation_goal_continuations(task_id, state);

CREATE INDEX IF NOT EXISTS idx_goal_usage_task ON conversation_goal_usage_events(task_id);

CREATE INDEX IF NOT EXISTS work_source_associations_latest ON work_source_associations(user_id,source_key,observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_board_days_time ON task_board_days(kind,at DESC,id);

CREATE INDEX IF NOT EXISTS idx_board_task_date ON tasks(due_at,id) WHERE archived=0 AND due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_board_task_update ON tasks(updated_at DESC,id);

CREATE INDEX IF NOT EXISTS idx_board_task_status ON tasks(status,updated_at DESC,id);

CREATE INDEX IF NOT EXISTS idx_board_task_pin ON tasks(is_favorited,updated_at DESC,id) WHERE is_favorited=1;

CREATE INDEX IF NOT EXISTS idx_board_request_key ON bot_send_receipts(('bot-request:'||bot_id||':'||request_id));

CREATE INDEX IF NOT EXISTS idx_board_receipt_assistant ON bot_send_receipts(assistant_message_id);

CREATE INDEX IF NOT EXISTS idx_board_pending_question ON conversation_interactions(status,task_id,created_at);

CREATE INDEX IF NOT EXISTS idx_board_terminal_notice ON notifications(task_id,created_at DESC) WHERE type IN ('task.failed','task.completed');

CREATE INDEX IF NOT EXISTS idx_board_cron_task ON cron_runs(task_id,started_at DESC);

CREATE INDEX IF NOT EXISTS idx_board_cron_job ON cron_runs(job_id,started_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS idx_board_cron_started ON cron_runs(started_at DESC,id);

CREATE INDEX IF NOT EXISTS dots_observation_due ON dots_tool_observations(next_at) WHERE next_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS dots_verified_progress_latest ON dots_verified_progress(operation_id,at DESC);

CREATE INDEX IF NOT EXISTS dots_dependency_prerequisite ON dots_dependency_waits(prerequisite_id);

CREATE INDEX IF NOT EXISTS dots_delegations_task_sequence ON dots_delegations(task_id,seq);

CREATE INDEX IF NOT EXISTS dots_delegations_pending ON dots_delegations(task_id,seq) WHERE status IN ('pending','running','blocked');

CREATE INDEX IF NOT EXISTS dots_delegations_source ON dots_delegations(source_message_id);

CREATE INDEX IF NOT EXISTS dots_reply_pending ON dots_reply_events(task_id) WHERE settled=0;

CREATE INDEX IF NOT EXISTS dots_reply_operation ON dots_reply_events(operation_id);

CREATE INDEX IF NOT EXISTS dots_report_operation ON dots_report_text(operation_id);

CREATE UNIQUE INDEX IF NOT EXISTS gateway_dots_active_binding ON gateway_dots_bindings(channel_id) WHERE active=1;

CREATE TRIGGER IF NOT EXISTS runtime_snapshot_delete_payloads
      AFTER DELETE ON task_runtime_context_snapshots
      WHEN OLD.instructions_hash IS NOT NULL OR OLD.capabilities_hash IS NOT NULL
      BEGIN
        DELETE FROM runtime_audit_payloads
        WHERE hash IN (OLD.instructions_hash, OLD.capabilities_hash)
          AND NOT EXISTS (SELECT 1 FROM task_runtime_context_snapshots WHERE instructions_hash = runtime_audit_payloads.hash)
          AND NOT EXISTS (SELECT 1 FROM task_runtime_context_snapshots WHERE capabilities_hash = runtime_audit_payloads.hash);
      END;

CREATE TRIGGER IF NOT EXISTS memory_organization_forget AFTER DELETE ON memory_records BEGIN
        DELETE FROM memory_organization_runs WHERE EXISTS (
          SELECT 1 FROM json_each(state_json, '$.sourceIds') WHERE value = OLD.id
        );
      END;

CREATE TRIGGER IF NOT EXISTS memory_records_fts_ai AFTER INSERT ON memory_records BEGIN
          INSERT INTO memory_fts(memory_id,title,content) VALUES (new.id,new.title,new.content);
        END;

CREATE TRIGGER IF NOT EXISTS memory_records_fts_au AFTER UPDATE OF title,content ON memory_records BEGIN
          DELETE FROM memory_fts WHERE memory_id=old.id;
          INSERT INTO memory_fts(memory_id,title,content) VALUES (new.id,new.title,new.content);
        END;

CREATE TRIGGER IF NOT EXISTS memory_records_fts_ad AFTER DELETE ON memory_records BEGIN
          DELETE FROM memory_fts WHERE memory_id=old.id;
        END;

CREATE TRIGGER IF NOT EXISTS memory_records_search_INSERT AFTER INSERT ON memory_records
        BEGIN UPDATE memory_search_epoch SET text_version=text_version+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS memory_records_search_DELETE AFTER DELETE ON memory_records
        BEGIN UPDATE memory_search_epoch SET text_version=text_version+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS memory_records_search_UPDATE AFTER UPDATE OF title,content,content_hash,kind,status,importance,updated_at,valid_from,valid_until ON memory_records
        BEGIN UPDATE memory_search_epoch SET text_version=text_version+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS memory_scopes_search_INSERT AFTER INSERT ON memory_scopes
        BEGIN UPDATE memory_search_epoch SET text_version=text_version+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS memory_scopes_search_DELETE AFTER DELETE ON memory_scopes
        BEGIN UPDATE memory_search_epoch SET text_version=text_version+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS memory_scopes_search_UPDATE AFTER UPDATE OF memory_id,scope_type,scope_id,binding ON memory_scopes
        BEGIN UPDATE memory_search_epoch SET text_version=text_version+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS memory_embeddings_search_INSERT AFTER INSERT ON memory_embeddings
        BEGIN UPDATE memory_search_epoch SET vector_version=vector_version+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS memory_embeddings_search_DELETE AFTER DELETE ON memory_embeddings
        BEGIN UPDATE memory_search_epoch SET vector_version=vector_version+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS memory_embeddings_search_UPDATE AFTER UPDATE OF memory_id,embedding,dimension,content_hash,model_id,model_version ON memory_embeddings
        BEGIN UPDATE memory_search_epoch SET vector_version=vector_version+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS bot_message_insert_revision AFTER INSERT ON bot_messages BEGIN
      INSERT INTO bot_message_revisions(message_id,revision) VALUES (NEW.message_id,1)
      ON CONFLICT(message_id) DO UPDATE SET revision=revision+1;
    END;

CREATE TRIGGER IF NOT EXISTS bot_message_update_revision AFTER UPDATE ON bot_messages BEGIN
      INSERT INTO bot_message_revisions(message_id,revision) VALUES (NEW.message_id,1)
      ON CONFLICT(message_id) DO UPDATE SET revision=revision+1;
    END;

CREATE TRIGGER IF NOT EXISTS bot_feedback_update_revision AFTER UPDATE ON bot_work_feedback BEGIN
      INSERT INTO bot_message_revisions(message_id,revision) VALUES (NEW.message_id,1)
      ON CONFLICT(message_id) DO UPDATE SET revision=revision+1;
    END;

CREATE TRIGGER IF NOT EXISTS bot_feedback_insert_revision AFTER INSERT ON bot_work_feedback BEGIN
      INSERT INTO bot_message_revisions(message_id,revision) VALUES (NEW.message_id,1)
      ON CONFLICT(message_id) DO UPDATE SET revision=revision+1;
    END;

CREATE TRIGGER IF NOT EXISTS projection_event_retention AFTER INSERT ON work_projection_events BEGIN
      DELETE FROM work_projection_events
        WHERE user_id=NEW.user_id AND sequence<=NEW.sequence-10000;
    END;

CREATE TRIGGER IF NOT EXISTS projection_work_insert AFTER INSERT ON works BEGIN
      INSERT OR IGNORE INTO work_projection_streams(user_id) VALUES (NEW.user_id);
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=NEW.user_id;
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=NEW.user_id;
    END;

CREATE TRIGGER IF NOT EXISTS projection_work_update AFTER UPDATE ON works BEGIN
      INSERT OR IGNORE INTO work_projection_streams(user_id) VALUES (NEW.user_id);
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=NEW.user_id;
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=NEW.user_id;
    END;

CREATE TRIGGER IF NOT EXISTS projection_work_delete AFTER DELETE ON works BEGIN
      INSERT OR IGNORE INTO work_projection_streams(user_id) VALUES (OLD.user_id);
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=OLD.user_id;
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=OLD.user_id;
    END;

CREATE TRIGGER IF NOT EXISTS projection_notification_update AFTER UPDATE ON work_notifications BEGIN
      INSERT OR IGNORE INTO work_projection_streams(user_id) VALUES ((SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS work_notification_snapshot AFTER INSERT ON work_notifications BEGIN
      INSERT INTO work_notification_identity(notification_id,input_snapshot_id,owner_epoch,sender_bot_id)
        SELECT NEW.notification_id,input_snapshot_id,owner_epoch,owner_bot_id FROM works WHERE work_id=NEW.work_id;
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_subitem_results_INSERT AFTER INSERT ON work_subitem_results
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_subitem_results_UPDATE AFTER UPDATE ON work_subitem_results
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_subitem_results_DELETE AFTER DELETE ON work_subitem_results
      WHEN (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_continuation_plans_INSERT AFTER INSERT ON work_continuation_plans
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_continuation_plans_UPDATE AFTER UPDATE ON work_continuation_plans
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_continuation_plans_DELETE AFTER DELETE ON work_continuation_plans
      WHEN (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_artifact_dependencies_INSERT AFTER INSERT ON work_artifact_dependencies
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_artifact_dependencies_UPDATE AFTER UPDATE ON work_artifact_dependencies
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_artifact_dependencies_DELETE AFTER DELETE ON work_artifact_dependencies
      WHEN (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_generated_artifacts_INSERT AFTER INSERT ON work_generated_artifacts
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_generated_artifacts_UPDATE AFTER UPDATE ON work_generated_artifacts
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_generated_artifacts_DELETE AFTER DELETE ON work_generated_artifacts
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_collaboration_messages_INSERT AFTER INSERT ON work_collaboration_messages
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_collaboration_messages_UPDATE AFTER UPDATE ON work_collaboration_messages
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_collaboration_messages_DELETE AFTER DELETE ON work_collaboration_messages
      WHEN (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_handoff_preparations_INSERT AFTER INSERT ON work_handoff_preparations
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_handoff_preparations_UPDATE AFTER UPDATE ON work_handoff_preparations
      WHEN (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_handoff_preparations_DELETE AFTER DELETE ON work_handoff_preparations
      WHEN (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_delegation_adoptions_INSERT AFTER INSERT ON work_delegation_adoptions
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_delegation_adoptions_UPDATE AFTER UPDATE ON work_delegation_adoptions
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=NEW.binding_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_delegation_adoptions_DELETE AFTER DELETE ON work_delegation_adoptions
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_execution_bindings WHERE binding_id=OLD.binding_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_notification_identity_INSERT AFTER INSERT ON work_notification_identity
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_notification_identity_UPDATE AFTER UPDATE ON work_notification_identity
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_notification_identity_DELETE AFTER DELETE ON work_notification_identity
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_notification_attempts_INSERT AFTER INSERT ON work_notification_attempts
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_notification_attempts_UPDATE AFTER UPDATE ON work_notification_attempts
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase3_projection_work_notification_attempts_DELETE AFTER DELETE ON work_notification_attempts
      WHEN (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_schedule_ticks_INSERT AFTER INSERT ON work_schedule_ticks
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_schedule_ticks_UPDATE AFTER UPDATE ON work_schedule_ticks
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_schedule_ticks_DELETE AFTER DELETE ON work_schedule_ticks
      WHEN OLD.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_offline_gaps_INSERT AFTER INSERT ON work_offline_gaps
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_offline_gaps_UPDATE AFTER UPDATE ON work_offline_gaps
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_offline_gaps_DELETE AFTER DELETE ON work_offline_gaps
      WHEN OLD.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_causal_chains_INSERT AFTER INSERT ON work_causal_chains
      WHEN NEW.target_work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.target_work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.target_work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.target_work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.target_work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.target_work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.target_work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_causal_chains_UPDATE AFTER UPDATE ON work_causal_chains
      WHEN NEW.target_work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.target_work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.target_work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.target_work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.target_work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.target_work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.target_work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_causal_chains_DELETE AFTER DELETE ON work_causal_chains
      WHEN OLD.target_work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=OLD.target_work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.target_work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.target_work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.target_work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.target_work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.target_work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_ingress_routes_INSERT AFTER INSERT ON work_ingress_routes
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_ingress_routes_UPDATE AFTER UPDATE ON work_ingress_routes
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_ingress_routes_DELETE AFTER DELETE ON work_ingress_routes
      WHEN OLD.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_events_inbox_INSERT AFTER INSERT ON work_events_inbox
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_events_inbox_UPDATE AFTER UPDATE ON work_events_inbox
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_events_inbox_DELETE AFTER DELETE ON work_events_inbox
      WHEN OLD.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_subscriptions_INSERT AFTER INSERT ON work_subscriptions
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_subscriptions_UPDATE AFTER UPDATE ON work_subscriptions
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase4_projection_work_subscriptions_DELETE AFTER DELETE ON work_subscriptions
      WHEN OLD.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase5_projection_work_result_cards_INSERT AFTER INSERT ON work_result_cards
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase5_projection_work_result_cards_UPDATE AFTER UPDATE ON work_result_cards
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase5_projection_work_result_cards_DELETE AFTER DELETE ON work_result_cards
      WHEN OLD.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase5_projection_work_owner_summaries_INSERT AFTER INSERT ON work_owner_summaries
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase5_projection_work_owner_summaries_UPDATE AFTER UPDATE ON work_owner_summaries
      WHEN NEW.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=NEW.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=NEW.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,NEW.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=NEW.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase5_projection_work_owner_summaries_DELETE AFTER DELETE ON work_owner_summaries
      WHEN OLD.work_id IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=OLD.work_id) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=OLD.work_id)
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,OLD.work_id FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=OLD.work_id);
    END;

CREATE TRIGGER IF NOT EXISTS phase5_projection_work_notification_effects_INSERT AFTER INSERT ON work_notification_effects
      WHEN (SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id) IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase5_projection_work_notification_effects_UPDATE AFTER UPDATE ON work_notification_effects
      WHEN (SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id) IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=NEW.notification_id));
    END;

CREATE TRIGGER IF NOT EXISTS phase5_projection_work_notification_effects_DELETE AFTER DELETE ON work_notification_effects
      WHEN (SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id) IS NOT NULL AND (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id)) IS NOT NULL BEGIN
      INSERT INTO work_projection_streams(user_id) SELECT (SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id))
        WHERE NOT EXISTS (SELECT 1 FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id)));
      UPDATE work_projection_streams SET sequence=sequence+1 WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id));
      INSERT INTO work_projection_events(user_id,sequence,work_id)
        SELECT user_id,sequence,(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id) FROM work_projection_streams WHERE user_id=(SELECT user_id FROM works WHERE work_id=(SELECT work_id FROM work_notifications WHERE notification_id=OLD.notification_id));
    END;

CREATE TRIGGER IF NOT EXISTS bot_collaboration_message_order_insert AFTER INSERT ON bot_collaboration_messages BEGIN
        INSERT INTO bot_collaboration_message_order(message_id) VALUES (NEW.message_id);
      END;

CREATE TRIGGER IF NOT EXISTS bot_collaboration_source_revision AFTER UPDATE OF work_id,updated_at,status,times_json ON bot_collaborations BEGIN
        UPDATE bot_message_revisions SET revision=revision+1 WHERE message_id IN (
          SELECT user_message_id FROM bot_collaboration_requests WHERE collaboration_id=NEW.collaboration_id
          UNION SELECT assistant_message_id FROM bot_collaboration_requests WHERE collaboration_id=NEW.collaboration_id
        );
        UPDATE bot_conversations SET revision=revision+1 WHERE conversation_id IN (
          SELECT conversation_id FROM bot_collaboration_requests WHERE collaboration_id=NEW.collaboration_id
        );
      END;

CREATE TRIGGER IF NOT EXISTS bot_collaboration_link_revision AFTER INSERT ON bot_collaboration_requests BEGIN
        UPDATE bot_message_revisions SET revision=revision+1
          WHERE message_id IN (NEW.user_message_id,NEW.assistant_message_id);
        UPDATE bot_conversations SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
      END;

CREATE TRIGGER IF NOT EXISTS bot_collaboration_work_revision AFTER UPDATE ON works BEGIN
        UPDATE bot_collaborations SET updated_at=MAX(updated_at,NEW.updated_at) WHERE work_id=NEW.work_id;
      END;

CREATE TRIGGER IF NOT EXISTS bot_peer_call_insert AFTER INSERT ON bot_peer_calls BEGIN
      UPDATE bot_message_revisions SET revision=revision+1 WHERE message_id=NEW.parent_message_id;
      UPDATE bot_conversations SET revision=revision+1 WHERE conversation_id=(SELECT conversation_id FROM bot_messages WHERE message_id=NEW.parent_message_id);
    END;

CREATE TRIGGER IF NOT EXISTS bot_peer_call_update AFTER UPDATE ON bot_peer_calls BEGIN
      UPDATE bot_message_revisions SET revision=revision+1 WHERE message_id=NEW.parent_message_id;
      UPDATE bot_conversations SET revision=revision+1 WHERE conversation_id=(SELECT conversation_id FROM bot_messages WHERE message_id=NEW.parent_message_id);
    END;

CREATE TRIGGER IF NOT EXISTS board_task_end_insert AFTER INSERT ON tasks WHEN NEW.status IN ('completed','failed') BEGIN
        INSERT INTO task_board_days(id,kind,day,at,detail)
    SELECT NEW.id,'result',date((NEW.updated_at)/1000.0,'unixepoch','localtime'),NEW.updated_at,substr('',1,120) WHERE 1
    ON CONFLICT(id,kind,day) DO UPDATE SET at=excluded.at,detail=excluded.detail WHERE excluded.at>=task_board_days.at; END;

CREATE TRIGGER IF NOT EXISTS board_task_end_update AFTER UPDATE OF status ON tasks WHEN NEW.status IN ('completed','failed') AND OLD.status IS NOT NEW.status BEGIN
        INSERT INTO task_board_days(id,kind,day,at,detail)
    SELECT NEW.id,'result',date((max(NEW.updated_at,CAST(unixepoch('subsec')*1000 AS INTEGER)))/1000.0,'unixepoch','localtime'),max(NEW.updated_at,CAST(unixepoch('subsec')*1000 AS INTEGER)),substr('',1,120) WHERE 1
    ON CONFLICT(id,kind,day) DO UPDATE SET at=excluded.at,detail=excluded.detail WHERE excluded.at>=task_board_days.at; END;

CREATE TRIGGER IF NOT EXISTS board_artifact_created AFTER INSERT ON artifacts BEGIN
        INSERT INTO task_board_days(id,kind,day,at,detail)
    SELECT NEW.task_id,'result',date((NEW.updated_at)/1000.0,'unixepoch','localtime'),NEW.updated_at,substr(coalesce(NEW.title,''),1,120) WHERE 1
    ON CONFLICT(id,kind,day) DO UPDATE SET at=excluded.at,detail=excluded.detail WHERE excluded.at>=task_board_days.at; END;

CREATE TRIGGER IF NOT EXISTS board_artifact_version AFTER UPDATE OF version ON artifacts WHEN NEW.version>OLD.version BEGIN
        INSERT INTO task_board_days(id,kind,day,at,detail)
    SELECT NEW.task_id,'result',date((NEW.updated_at)/1000.0,'unixepoch','localtime'),NEW.updated_at,substr(coalesce(NEW.title,''),1,120) WHERE 1
    ON CONFLICT(id,kind,day) DO UPDATE SET at=excluded.at,detail=excluded.detail WHERE excluded.at>=task_board_days.at; END;

CREATE TRIGGER IF NOT EXISTS board_question_answer AFTER UPDATE OF status ON conversation_interactions
        WHEN NEW.status='resolved' AND OLD.status='pending' AND NEW.resolved_at IS NOT NULL BEGIN
        INSERT INTO task_board_days(id,kind,day,at,detail)
    SELECT NEW.task_id,'follow',date((NEW.resolved_at)/1000.0,'unixepoch','localtime'),NEW.resolved_at,substr(NEW.title,1,120) WHERE 1
    ON CONFLICT(id,kind,day) DO UPDATE SET at=excluded.at,detail=excluded.detail WHERE excluded.at>=task_board_days.at; END;

CREATE TRIGGER IF NOT EXISTS board_request_follow AFTER INSERT ON bot_send_receipts BEGIN
        INSERT INTO task_board_days(id,kind,day,at,detail)
    SELECT 'bot-request:'||r.bot_id||':'||r.request_id,'follow',date((u.created_at)/1000.0,'unixepoch','localtime'),u.created_at,substr(u.text,1,120) FROM bot_send_receipts r JOIN bot_conversations c ON c.conversation_id=r.conversation_id
  JOIN bot_messages u ON u.message_id=r.user_message_id JOIN bot_messages a ON a.message_id=r.assistant_message_id
  WHERE r.user_id='user-local-primary' AND c.user_id=r.user_id AND c.conversation_id NOT GLOB 'bot-inbox-*' AND c.source_kind='user' AND c.ingress_kind='desktop' AND NOT EXISTS (SELECT 1 FROM bot_peer_inputs p WHERE p.assistant_message_id=a.message_id) AND r.rowid=NEW.rowid
    ON CONFLICT(id,kind,day) DO UPDATE SET at=excluded.at,detail=excluded.detail WHERE excluded.at>=task_board_days.at; END;

CREATE TRIGGER IF NOT EXISTS board_peer_origin AFTER INSERT ON bot_peer_inputs BEGIN
        DELETE FROM task_board_days WHERE kind='follow' AND id IN (SELECT 'bot-request:'||r.bot_id||':'||r.request_id FROM bot_send_receipts r WHERE r.assistant_message_id=NEW.assistant_message_id); END;

CREATE TRIGGER IF NOT EXISTS board_request_result AFTER UPDATE OF status ON bot_messages
        WHEN NEW.role='assistant' AND NEW.status IN ('completed','failed') AND OLD.status IS NOT NEW.status BEGIN
        INSERT INTO task_board_days(id,kind,day,at,detail)
    SELECT 'bot-request:'||r.bot_id||':'||r.request_id,'result',date((NEW.updated_at)/1000.0,'unixepoch','localtime'),NEW.updated_at,substr('',1,120) FROM bot_send_receipts r JOIN bot_conversations c ON c.conversation_id=r.conversation_id
  JOIN bot_messages u ON u.message_id=r.user_message_id JOIN bot_messages a ON a.message_id=r.assistant_message_id
  WHERE r.user_id='user-local-primary' AND c.user_id=r.user_id AND c.conversation_id NOT GLOB 'bot-inbox-*' AND a.message_id=NEW.message_id
    ON CONFLICT(id,kind,day) DO UPDATE SET at=excluded.at,detail=excluded.detail WHERE excluded.at>=task_board_days.at; END;

CREATE TRIGGER IF NOT EXISTS board_task_delete AFTER DELETE ON tasks BEGIN
        DELETE FROM task_board_days WHERE id=OLD.id; DELETE FROM task_board_plans WHERE id=OLD.id; END;

CREATE TRIGGER IF NOT EXISTS board_request_delete AFTER DELETE ON bot_send_receipts BEGIN
        DELETE FROM task_board_days WHERE id='bot-request:'||OLD.bot_id||':'||OLD.request_id;
        DELETE FROM task_board_plans WHERE id='bot-request:'||OLD.bot_id||':'||OLD.request_id; END;

CREATE TABLE IF NOT EXISTS runtime_diagnostic_writer (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, sequence INTEGER NOT NULL);
