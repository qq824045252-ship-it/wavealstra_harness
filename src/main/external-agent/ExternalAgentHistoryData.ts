export interface ExternalAgentHistoryRow {
  id: string;
  task_id: string;
  agent_id: string;
  agent_name: string;
  status: string;
  cwd: string;
  session_id: string | null;
  user_message_id: string;
  assistant_message_id: string;
  prompt: string;
  display_text: string | null;
  attachments_json: string | null;
  final_text: string;
  thinking_text: string;
  tools_json: string;
  started_at: number;
  completed_at: number | null;
  error: string | null;
  continued_from_run_id: string | null;
  continuation_mode: string | null;
  output_cursor: number;
  artifact_refs_json: string;
  resume_supported: number;
  cancel_supported: number;
  cancellation_evidence: string | null;
  verification_status: string;
  recovery_state: string;
  recovery_message: string | null;
}

export interface ExternalAgentHistoryCursor {
  startedAt: number;
  runId: string;
}

export interface ExternalAgentHistoryPage {
  rows: ExternalAgentHistoryRow[];
  nextCursor: ExternalAgentHistoryCursor | null;
}
