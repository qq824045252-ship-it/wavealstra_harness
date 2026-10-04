export type ConversationInteractionKind =
  | "confirm"
  | "single_select"
  | "multi_select"
  | "short_text"
  | "long_text";

export interface ConversationInteractionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  disabled?: boolean;
}

export type ConversationInteractionStatus = "pending" | "resolved" | "cancelled" | "expired";
export type ConversationInteractionAnswer = boolean | string | string[];

export interface ConversationInteractionDto {
  id: string;
  taskId: string;
  executionId: string;
  assistantMessageId: string;
  kind: ConversationInteractionKind;
  title: string;
  description?: string;
  options: ConversationInteractionOption[];
  minSelections?: number;
  maxSelections?: number;
  allowCustom?: boolean;
  customPlaceholder?: string;
  status: ConversationInteractionStatus;
  answer?: ConversationInteractionAnswer;
  version: number;
  createdAt: number;
  resolvedAt?: number;
}

export interface ConversationInteractionRequest {
  title: string;
  description?: string;
  kind: ConversationInteractionKind;
  options?: ConversationInteractionOption[];
  minSelections?: number;
  maxSelections?: number;
  allowCustom?: boolean;
  customPlaceholder?: string;
}

export interface ConversationInteractionRespondRequest {
  interactionId: string;
  answer: ConversationInteractionAnswer;
}

export type ConversationInteractionMutationResult =
  | { ok: true; interaction: ConversationInteractionDto }
  | { ok: false; code: "not_found" | "already_resolved" | "invalid_answer"; message: string };
