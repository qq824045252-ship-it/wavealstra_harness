import { execFileSync } from "node:child_process";
import { resolveWhisperRuntime } from "../voice/whisperAsr";
import type { AgentLoadoutRecommendationDto } from "../../shared/agent-loadout";

export interface SkillReadinessDiagnostic {
  id: string;
  recommended: boolean;
  installed: boolean;
  policyAllowed: boolean;
  whitelisted: boolean;
  readThisTurn: boolean;
  dependency: { state: "unknown" | "passed" | "failed"; reason: string; checkedAt?: number };
  trial: { state: "unknown" | "passed" | "failed"; at?: number; evidence?: string };
  reason: string;
}

/** Recommendation, authority, discovery and execution evidence are independent facts.
 * A completed agent turn or a skill read is never proof that a dependency/trial succeeded.
 */
export function diagnoseSkillReadiness(input: {
  recommendation: AgentLoadoutRecommendationDto;
  installedIds: string[];
  whitelistIds: string[];
  readIds: string[];
  evidence?: Record<string, Pick<SkillReadinessDiagnostic, "dependency" | "trial">>;
}): SkillReadinessDiagnostic[] {
  const ids = (values: string[]) => new Set(values.map(v => v.toLowerCase()));
  const installed = ids(input.installedIds), whitelist = ids(input.whitelistIds), read = ids(input.readIds);
  return input.recommendation.capabilities.filter(c => c.kind === "skill").map(c => {
    const present = installed.has(c.id.toLowerCase());
    const allowed = !c.blocked;
    const selected = c.actual && allowed && whitelist.has(c.id.toLowerCase());
    const evidence = input.evidence?.[c.id];
    return {
      id: c.id, recommended: c.recommended, installed: present,
      policyAllowed: allowed, whitelisted: selected, readThisTurn: read.has(c.id.toLowerCase()),
      dependency: evidence?.dependency ?? { state: "unknown", reason: "尚未在目标应用环境检查依赖；推荐/安装不代表 CLI 可用" },
      trial: evidence?.trial ?? { state: "unknown" },
      reason: !present ? "not_installed" : c.blocked ? c.blockReason ?? "policy_denied"
        : !selected ? "not_in_session_whitelist" : "whitelisted; dependency and trial require separate evidence",
    };
  });
}

export function diagnoseSessionModel(input: {
  requested?: string;
  actual?: { provider: string; id: string };
  source: string;
  reasoning: string;
}) {
  const actualId = input.actual ? `${input.actual.provider}/${input.actual.id}` : undefined;
  return {
    provider: input.actual?.provider, model: input.actual?.id, actualId,
    requested: input.requested, source: input.source, reasoning: input.reasoning,
    fallbackReason: !input.requested ? "未指定可用默认；显示恢复会话或 SDK 的实际选择，请在模型设置中配置默认模型"
      : input.requested !== actualId ? "请求值与实际会话模型不同；以 actualId 为准（可能是规范化 ID 或恢复/应用失败）" : undefined,
  };
}

/** Fixed read-only probes in the application's process environment, never an install.
 * Run on explicit Inspector access, not while assembling or executing a model request.
 */
export function probeSkillDependency(id: string, cwd: string, activeTools: string[]): SkillReadinessDiagnostic["dependency"] {
  const checkedAt = Date.now();
  if (id === "officecli") {
    try {
      execFileSync("officecli", ["--version"], { cwd, env: process.env, timeout: 2500, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"] });
      return { state: "passed", reason: "目标应用进程环境 officecli --version 成功；不代表文件试运行成功", checkedAt };
    } catch {
      return { state: "failed", reason: "目标应用环境 officecli --version 失败；参见已安装 officecli/SKILL.md 的 Install，安装后重启终端/应用；未自动安装", checkedAt };
    }
  }
  if (id === "meeting-transcribe") {
    const runtime = resolveWhisperRuntime();
    return { state: runtime.available ? "unknown" : "failed", reason: runtime.detail + "；技能另需其指定的本机 ASR 服务，尚未试运行", checkedAt };
  }
  if (id === "npu-ocr") {
    return { state: "unknown", reason: "该技能依赖 SKILL.md 中的外部 OCR_NPU_CLI.exe；未配置跨平台受管入口，不能以桌面 tesseract 代替；请核对技能内 CLI 路径与模型", checkedAt };
  }
  if (id === "dimagent-debug") {
    const missing = ["read", "ui_exec", "runtime_probe"].filter(tool => !activeTools.includes(tool));
    return { state: missing.length ? "failed" : "passed", reason: missing.length
      ? "当前会话缺少 UI 调试工具：" + missing.join(", ") + "；非 UI 问题仍可使用只读复现"
      : "调试入口工具已注册；尚未进行问题复现试运行", checkedAt };
  }
  return { state: "unknown", reason: "未提供定向依赖检查", checkedAt };
}
