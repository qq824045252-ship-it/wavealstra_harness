import type {
  ConversationInteractionKind,
  ConversationInteractionOption,
  ConversationInteractionRequest,
} from "./conversation-interaction";

const OPEN = "<request_user_input>";
const CLOSE = "</request_user_input>";
const KINDS = new Set<ConversationInteractionKind>([
  "confirm",
  "single_select",
  "multi_select",
  "short_text",
  "long_text",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined | null {
  return value === undefined ? undefined : typeof value === "string" ? value : null;
}

function booleanOrUndefined(value: unknown): boolean | undefined | null {
  return value === undefined ? undefined : typeof value === "boolean" ? value : null;
}

function integerOrUndefined(value: unknown): number | undefined | null {
  return value === undefined
    ? undefined
    : Number.isInteger(value) && typeof value === "number"
      ? value
      : null;
}

function parseOption(value: unknown): ConversationInteractionOption | undefined {
  const input = record(value);
  if (!input || typeof input.id !== "string" || typeof input.label !== "string") return undefined;
  const description = stringOrUndefined(input.description);
  const recommended = booleanOrUndefined(input.recommended);
  const disabled = booleanOrUndefined(input.disabled);
  if (description === null || recommended === null || disabled === null) return undefined;
  return {
    id: input.id,
    label: input.label,
    ...(description !== undefined ? { description } : {}),
    ...(recommended !== undefined ? { recommended } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  };
}

export function parseRequestUserInputRequest(value: unknown): ConversationInteractionRequest | undefined {
  const input = record(value);
  if (!input || typeof input.title !== "string" || typeof input.kind !== "string") return undefined;
  if (!KINDS.has(input.kind as ConversationInteractionKind)) return undefined;

  const description = stringOrUndefined(input.description);
  const customPlaceholder = stringOrUndefined(input.customPlaceholder);
  const allowCustom = booleanOrUndefined(input.allowCustom);
  const minSelections = integerOrUndefined(input.minSelections);
  const maxSelections = integerOrUndefined(input.maxSelections);
  if (
    description === null ||
    customPlaceholder === null ||
    allowCustom === null ||
    minSelections === null ||
    maxSelections === null
  ) return undefined;

  let options: ConversationInteractionOption[] | undefined;
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || input.options.length > 20) return undefined;
    options = [];
    for (const item of input.options) {
      const parsed = parseOption(item);
      if (!parsed) return undefined;
      options.push(parsed);
    }
  }

  return {
    title: input.title,
    kind: input.kind as ConversationInteractionKind,
    ...(description !== undefined ? { description } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(minSelections !== undefined ? { minSelections } : {}),
    ...(maxSelections !== undefined ? { maxSelections } : {}),
    ...(allowCustom !== undefined ? { allowCustom } : {}),
    ...(customPlaceholder !== undefined ? { customPlaceholder } : {}),
  };
}

function lastDirectiveStart(text: string): number {
  const expression = /(^|\r?\n)[ \t]*<request_user_input>/g;
  let match: RegExpExecArray | null;
  let start = -1;
  while ((match = expression.exec(text)) !== null) {
    start = match.index + match[1]!.length;
  }
  return start;
}

export interface RequestUserInputFallback {
  request: ConversationInteractionRequest;
  visibleText: string;
}

/**
 * Recover only a terminal, line-delimited pseudo tool call.
 * Arbitrary XML-looking prose is left alone; malformed JSON is never executed.
 */
export function extractRequestUserInputFallback(text: string): RequestUserInputFallback | undefined {
  const start = lastDirectiveStart(text);
  if (start < 0) return undefined;
  const openAt = text.indexOf(OPEN, start);
  if (openAt < 0) return undefined;
  const closeAt = text.indexOf(CLOSE, openAt + OPEN.length);
  if (closeAt < 0) return undefined;
  if (text.slice(closeAt + CLOSE.length).trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(openAt + OPEN.length, closeAt).trim());
  } catch {
    return undefined;
  }
  const request = parseRequestUserInputRequest(parsed);
  if (!request) return undefined;
  return { request, visibleText: text.slice(0, start).trimEnd() };
}

/**
 * During streaming, hide a reserved pseudo-call as soon as its opening tag arrives.
 * Once streaming ends, hide it only when the complete payload is valid and recoverable.
 */
export function requestUserInputDisplayText(text: string, streaming: boolean): string {
  const recovered = extractRequestUserInputFallback(text);
  if (recovered) return recovered.visibleText;
  if (!streaming) return text;
  const start = lastDirectiveStart(text);
  return start >= 0 ? text.slice(0, start).trimEnd() : text;
}
