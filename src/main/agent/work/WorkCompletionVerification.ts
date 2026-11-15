import { z } from "zod";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import { WORK_VERIFICATION_MAX_CHECKS, WORK_VERIFICATION_MAX_REFS, workVerificationSchema,
  type WorkVerificationDto, type WorkVerificationCheck } from "../../../shared/bot-work-verification";

const frozenContext = z.object({
  reviewTarget: z.object({
    kind: z.literal("single_work_delegation"),
    provenance: z.literal("host_persisted_execution_input_not_new_user_authorization"),
    workId: z.string(), bindingId: z.string(), intentRevision: z.number(), inputSnapshotId: z.string(), ownerEpoch: z.number(),
  }),
  criteria: z.array(z.unknown()).optional(), artifactEvidence: z.array(z.unknown()).optional(),
  temporalContext: z.object({ reviewAt: z.string().optional(), historicalRecovery: z.boolean().optional() }).optional(),
});
const criterionSchema = z.object({
  id: z.string(), text: z.string(), origin: z.literal("assistant_proposal").optional(),
  status: z.string(), requiredIntentRevision: z.number(), verifiedIntentRevision: z.number().optional(),
  requiresRealEnvironmentCheck: z.boolean().optional(), requiredEnvironment: z.string().optional(),
  evidenceRefs: z.array(z.string()), waivedReason: z.string().optional(), waivedByUserId: z.string().optional(),
});
const artifactSchema = z.object({
  ref: z.string(), name: z.string(), state: z.string(), trust: z.literal("untrusted_artifact_content"),
  registeredDigest: z.string().optional(), truncated: z.boolean().optional(),
  reason: z.string().optional(), placeholderIndicators: z.array(z.string()).optional(),
  omittedEvidenceCount: z.number().int().nonnegative().optional(),
});
const rowLimit = WORK_VERIFICATION_MAX_CHECKS / 2;
const text = (value: string, fallback: string) => value.trim().slice(0, 1000) || fallback;
function refs(values: readonly string[]): Pick<WorkVerificationCheck, "evidenceRefs" | "omittedEvidenceRefs"> {
  const unique = [...new Set(values.filter(value => value.trim()))];
  const shown = unique.filter(value => value.length <= 4000).slice(0, WORK_VERIFICATION_MAX_REFS);
  return { evidenceRefs: shown, omittedEvidenceRefs: unique.length - shown.length };
}
function unknownCheck(kind: WorkVerificationCheck["kind"], index: number): WorkVerificationCheck {
  return { id: `${kind}:${index}`, kind, label: kind === "criterion" ? "检查项记录不完整" : "文件核对记录不完整",
    state: "unverified", summary: "保存的记录不足，不能据此确认已经核对。", limitations: [], evidenceRefs: [], omittedEvidenceRefs: 0 };
}
function criterionCheck(value: unknown, index: number, intentRevision: number): WorkVerificationCheck {
  const parsed = criterionSchema.safeParse(value);
  if (!parsed.success) return unknownCheck("criterion", index);
  const item = parsed.data;
  const check: WorkVerificationCheck = { id: `criterion:${index}`, kind: "criterion",
    origin: item.origin ?? "task_requirement", label: text(item.text, "未命名检查项"), state: "unverified",
    summary: "尚未登记本版本的核对结果。", limitations: [], ...refs(item.evidenceRefs) };
  if (item.text.trim().length > 1000) check.limitations.push("检查项文字较长，此处只显示前 1000 字。");
  if (item.origin === "assistant_proposal") check.limitations.push("这是助理建议的检查项，不新增用户验收要求。");
  const current = item.requiredIntentRevision === intentRevision && item.verifiedIntentRevision === item.requiredIntentRevision;
  if (item.status === "satisfied" && current && item.evidenceRefs.some(ref => ref.trim())) {
    check.state = "verified";
    check.summary = "保存记录中已有本版本的核对结果和证据引用。";
  } else if (item.status === "satisfied") {
    check.summary = "已有满足标记，但版本或证据引用不足，不能确认本版本已核对。";
  } else if (item.status === "failed" && item.requiredIntentRevision === intentRevision) {
    check.state = "failed"; check.summary = "本版本的保存记录标记为未通过。";
  } else if (item.status === "blocked") {
    check.summary = "检查受阻，尚未确认满足要求。";
  } else if (item.status === "waived" && item.requiredIntentRevision === intentRevision
    && item.waivedByUserId?.trim() && item.waivedReason?.trim()) {
    check.state = "waived"; check.summary = "保存记录中有用户豁免，此项未作为已通过检查。";
    check.limitations.push(`记录的豁免原因：${item.waivedReason.trim().slice(0, 800)}`);
  }
  if (item.requiresRealEnvironmentCheck || item.requiredEnvironment?.trim()) {
    const environment = item.requiredEnvironment?.trim().slice(0, 160);
    check.limitations.push(`要求真实环境${environment ? `（${environment}）` : ""}检查；${check.state === "verified"
      ? "此处展示已有登记，没有重新执行实测。" : "此记录不证明真实环境实测已通过。"}`);
  }
  return check;
}

const unavailableReasons: Record<string, string> = {
  "No immutable registered snapshot": "缺少已登记的不可变文件版本。",
  "Review text budget exhausted": "本次核对的正文额度已用完，该文件内容未纳入核对。",
  "Not a regular file or exceeds 1 MiB inspection limit": "文件类型或大小超出本次读取范围。",
  "Binary or unsupported text encoding": "文件是二进制内容或使用不支持的文本编码，需另行检查。",
  "Binary content requires separate verification": "二进制内容需要使用对应工具另行检查。",
  "Registered snapshot cannot be read": "已登记的文件版本未能读取。",
};
function artifactCheck(value: unknown, index: number): WorkVerificationCheck {
  const parsed = artifactSchema.safeParse(value);
  if (!parsed.success) return unknownCheck("artifact", index);
  const item = parsed.data;
  const check: WorkVerificationCheck = { id: `artifact:${index}`, kind: "artifact", label: text(item.name, "未命名文件"),
    state: "unavailable", summary: "此文件没有可用的读取核对记录。", limitations: [], ...refs([item.ref]) };
  const hasDigest = /^[a-f0-9]{64}$/i.test(item.registeredDigest ?? "");
  if (item.state === "text" && hasDigest && item.ref.trim()) {
    check.state = "read"; check.summary = "已读取保存版本并核对 SHA-256 摘要。";
    check.limitations.push("读取与版本一致性不代表文件内容满足任务要求。");
  } else if (item.state === "empty") {
    check.state = "empty"; check.summary = "读取记录显示文本为空，不能据此确认任务完成。";
  } else if (item.state === "changed") {
    check.state = "changed"; check.summary = "保存版本与登记的大小或摘要不一致，未将变化后的内容作为核对依据。";
  } else {
    check.summary = unavailableReasons[item.reason ?? ""] ?? "没有足够的保存版本读取与摘要记录，内容尚未核对。";
  }
  if (item.truncated) check.limitations.push("提供给核对的正文有截断，未覆盖完整内容。");
  if (item.placeholderIndicators?.length) check.limitations.push("读取记录发现占位标记；是否合理仍取决于任务要求，不能仅凭标记判定失败。");
  return check;
}

/** Call only with the frozen context whose fingerprint the result coordinator
 * just rechecked. Never reopen files or copy artifact text into the projection. */
export function completionVerification(binding: Pick<WorkExecutionBindingDto,
  "bindingId" | "workId" | "intentRevision" | "inputSnapshotId" | "ownerEpoch">, context: unknown): WorkVerificationDto | undefined {
  const parsed = frozenContext.safeParse(context);
  if (!parsed.success) return undefined;
  const saved = parsed.data, target = saved.reviewTarget;
  if (target.workId !== binding.workId || target.bindingId !== binding.bindingId || target.intentRevision !== binding.intentRevision
    || target.inputSnapshotId !== binding.inputSnapshotId || target.ownerEpoch !== binding.ownerEpoch) return undefined;
  const criteria = saved.criteria ?? [], artifacts = saved.artifactEvidence ?? [];
  const omittedArtifacts = artifacts.reduce<number>((maximum, item) => {
    const parsed = artifactSchema.safeParse(item);
    return Math.max(maximum, parsed.success ? parsed.data.omittedEvidenceCount ?? 0 : 0);
  }, 0);
  const reviewedAt = z.string().datetime().safeParse(saved.temporalContext?.reviewAt);
  const result = workVerificationSchema.safeParse({ version: 1,
    workId: binding.workId, executionId: binding.bindingId, intentRevision: binding.intentRevision,
    inputSnapshotId: binding.inputSnapshotId, ownerEpoch: binding.ownerEpoch,
    ...(reviewedAt.success ? { reviewedAt: reviewedAt.data } : {}),
    historicalExecution: saved.temporalContext?.historicalRecovery === true,
    checks: [...criteria.slice(0, rowLimit).map((item, index) => criterionCheck(item, index, binding.intentRevision)),
      ...artifacts.slice(0, rowLimit).map(artifactCheck)],
    omittedCount: Math.max(0, criteria.length - rowLimit) + Math.max(0, artifacts.length - rowLimit) + omittedArtifacts,
  });
  return result.success ? result.data : undefined;
}
