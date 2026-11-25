import type { BotHistoryRequest } from "../../../shared/bot-conversation";

export type RuntimeBotHistoryQuery = Omit<BotHistoryRequest, "inbox"> & { userId: string };

export interface RuntimeBotHistoryFacts {
  team_id: string | null;
  user_id: string | null;
  reference_message_id: string | null;
  revision: number;
  attachments_json: string | null;
  metadata_json: string | null;
  activity_json: string | null;
  segments_json: string | null;
  tool_task_id: string | null;
  tools_json: string | null;
}

export interface RuntimeBotHistoryRow extends RuntimeBotHistoryFacts {
  message_id: string;
  conversation_id: string;
  bot_id: string;
  request_id: string;
  ordinal: number;
  role: string;
  text: string;
  status: string;
  work_ids_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export type RuntimeBotHistoryPage =
  | { kind: "ready"; conversationId: string; revision: number; archived: boolean; rows: RuntimeBotHistoryRow[]; before: number | null }
  | { kind: "missing" }
  | { kind: "scopeMismatch" }
  | { kind: "needsHost" };
