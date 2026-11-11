import type { ToolExecutionResult } from "@earendil-works/pi-durable";

const MAX_DIAGNOSTICS = 8;
const MAX_MESSAGE_LENGTH = 1200;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only explicit error fields are eligible, never arbitrary tool output or details dumps. */
function diagnosticText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim()
    .replace(/\bhttps?:\/\/[^\s'"<>]+/gi, raw => {
      try {
        const url = new URL(raw);
        url.username = ""; url.password = ""; url.search = ""; url.hash = "";
        return url.toString();
      } catch { return "[URL]"; }
    })
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(password|passwd|token|api[_-]?key|secret|authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .slice(0, MAX_MESSAGE_LENGTH);
}

export function durableToolDiagnosticMessages(result: ToolExecutionResult): string[] | undefined {
  const messages = (result.diagnostics ?? []).slice(0, MAX_DIAGNOSTICS).map(item => {
    const code = diagnosticText(item.code);
    const message = diagnosticText(item.message);
    // Renderer classification treats these canonical markers as command status or
    // informational reading hints, not a failed host/degraded execution.
    if (code && ["exit_code", "image", "truncated", "full_output"].includes(code)) return code;
    return diagnosticText(code && message && code !== message ? `${code}: ${message}` : message ?? code);
  }).filter((message): message is string => Boolean(message));
  if (!result.isError) return messages.length ? messages : undefined;
  if (messages.length) return messages;
  const details = record(result.details);
  const code = diagnosticText(details?.code);
  const error = diagnosticText(details?.error);
  const cause = diagnosticText(record(details?.details)?.cause);
  // Older built-in results already contain an explicit error and Chromium cause, but
  // do not have Pi diagnostics. Do not copy page text, images, or arbitrary JSON.
  return [diagnosticText([code, error, cause && cause !== error ? cause : undefined].filter(Boolean).join(" — "))
    ?? "工具执行失败（未提供结构化错误原因）"];
}

/** Extension results predate Pi diagnostics; accept only the diagnostic contract. */
export function durableExtensionDiagnostics(result: unknown): ToolExecutionResult["diagnostics"] {
  const values = record(result)?.diagnostics;
  if (!Array.isArray(values)) return undefined;
  const diagnostics: NonNullable<ToolExecutionResult["diagnostics"]>[number][] = [];
  for (const value of values.slice(0, MAX_DIAGNOSTICS)) {
    const item = record(value);
    const severity = item?.severity;
    const message = diagnosticText(item?.message);
    if (!message || (severity !== "info" && severity !== "warn" && severity !== "error")) continue;
    diagnostics.push({ severity, message, code: diagnosticText(item?.code) });
  }
  return diagnostics.length ? diagnostics : undefined;
}
