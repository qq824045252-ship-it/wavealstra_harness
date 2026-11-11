import { createHash } from "node:crypto";
import { z } from "zod";

const availableFile = z.object({ ref: z.string().min(1), name: z.string() }).passthrough();

/** Transport-only aliases for the host's current openable-file registry. Never
 * derive authority from report text, evidence paths, basenames or fuzzy matches. */
export function workResultArtifactSelection(input: {
  eventId: string; botId: string; context: Record<string, unknown>; personalPreferences?: string;
}) {
  // Capture the input before any async model work. Only host retry clocks are
  // excluded from identity: callers regenerate these without new evidence.
  const reviewContext: Record<string, unknown> = JSON.parse(JSON.stringify(input.context));
  const { reviewAt: _reviewAt, ...identityContext } = reviewContext;
  if (identityContext.temporalContext && typeof identityContext.temporalContext === "object") {
    const { reviewAt: _temporalReviewAt, ...temporalContext } = identityContext.temporalContext as Record<string, unknown>;
    identityContext.temporalContext = temporalContext;
  }
  const key = createHash("sha256").update(JSON.stringify([
    "work-result-artifact-selection-v1", input.botId, input.eventId, identityContext, input.personalPreferences ?? null,
  ])).digest("hex");
  const refs = new Set<string>();
  const selectors = new Map<string, string>();
  const availableFiles = Array.isArray(reviewContext.availableFiles) ? reviewContext.availableFiles.flatMap(value => {
    const parsed = availableFile.safeParse(value);
    if (!parsed.success || refs.has(parsed.data.ref)) return [];
    refs.add(parsed.data.ref);
    const selectionId = `file-${key.slice(0, 16)}-${refs.size}`;
    selectors.set(selectionId, parsed.data.ref);
    return [{ ...parsed.data, selectionId }];
  }) : [];
  return {
    key,
    context: { ...reviewContext, availableFiles } as Record<string, unknown> & { availableFiles: typeof availableFiles },
    resolve(selected: readonly string[] | undefined): string[] | undefined {
      if (selected === undefined) return undefined; // Preserve renderer default selection.
      return [...new Set(selected.flatMap(value => {
        const ref = selectors.get(value) ?? (refs.has(value) ? value : undefined);
        return ref === undefined ? [] : [ref];
      }))];
    },
  };
}

export const WORK_RESULT_ARTIFACT_SELECTION_INSTRUCTIONS = `availableFiles 是宿主核对过、仅属于本次交付的可打开文件。需要选择主要成品时，按用户首先该看的顺序把对应 selectionId 逐字放入 artifactRefs 数组；selectionId 只是本轮精确文件选择标识，宿主会还原真实 ref。不要抄写磁盘路径，不改写标识，不按文件名猜文件，也不使用旧轮次标识。ref 和 artifactEvidence 仍是实际文件及内容证据，标识不证明目标完成；正文不要输出 selectionId。没有相关可用文件时 artifactRefs 为空数组。`;
