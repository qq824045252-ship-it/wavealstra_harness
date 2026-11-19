import type { EntryRecord } from "@earendil-works/pi-durable";
import type { WorkflowRun } from "./PstackState";

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
export type ReviewCheck = { toolTaskId: number; entry: number; command: string; exitCode: number; passed: boolean; output: string; truncated: boolean };

/** Present only authentic results of a host verify operation from this run,
 * bound to the current task workspace. Ordinary shell prose has no version. */
export function currentVerificationEvidence(run: WorkflowRun, fingerprint: string, entries: readonly EntryRecord[]): ReviewCheck[] {
  const checks = new Map<string, ReviewCheck>();
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result" || entry.byTaskId === undefined || !run.operations.includes(entry.byTaskId)) continue;
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult" || message.toolName !== "pstack_workflow") continue;
      const text = message.content.map(c => c.type === "text" ? c.text : "").join("");
      if (!text.includes('"toolTaskId"')) continue;
      let item: unknown;
      try { item = JSON.parse(text); } catch { continue; }
      if (!object(item) || typeof item.command !== "string" || typeof item.toolTaskId !== "number" || typeof item.exitCode !== "number" ||
        typeof item.passed !== "boolean" || item.unchanged !== true || !object(item.output) || typeof item.output.output !== "string") continue;
      const last = run.verification;
      const version = item.fingerprint ?? (last?.toolTaskId === item.toolTaskId && last.command === item.command ? last.fingerprint : undefined);
      if (version !== fingerprint) continue;
      const raw = item.output.output, excerpt = raw.length > 1600 ? raw.slice(0, 900) + "\n[…]\n" + raw.slice(-650) : raw;
      checks.delete(item.command);
      checks.set(item.command, { entry:entry.id, toolTaskId:item.toolTaskId, command:item.command, exitCode:item.exitCode,
        passed:item.passed && !message.isError && item.exitCode === 0, output:excerpt, truncated:raw.length !== excerpt.length || item.output.truncated === true });
    }
  }
  return [...checks.values()].slice(-8);
}
