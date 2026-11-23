import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { HookDraft } from "../../../shared/native-hooks";
import type { ImprovementKind } from "../../../shared/native-improvement";
import { pathKey } from "../../platform/paths";

export const cards: Record<ImprovementKind, [string, string, string, string]> = {
  childDelivery: ["子代理交接失败、受阻或超时", "派发已有终态回执，需要核查交接要求、执行过程和返回结果。", "根据原始证据决定调整委派、角色能力或工具。", "用相同交接要求重放，并验证父会话收到所需结果。"],
  childSteer: ["子代理插话未获回答", "原生回执显示插话未处理或处理后未回答。", "核对输入何时进入会话、当时的执行状态及失败原因。", "复验同一请求的提交、放入上下文和回答回执。"],
  readPath: ["同名文件的已验证位置", "读取遇到文件不存在，随后在本任务的另一相对路径成功读取同名文件。", "下次按名称查找时，先核实位置并提供给代理。直接读指定路径失败时也提供备选位置。", "下一次查找直接读到目标文件。位置失效或发现冲突时撤回提示。"],
  scope: ["收窄范围后遗漏交付要求", "用户纠正了上轮对范围调整的理解。", "在新的范围调整处重核原交付与验收。", "下一次调整仍保留适用的交付要求。"],
  retry: ["相同文件读取连续失败", "连续两次使用相同参数并得到相同错误。", "在下一步提示核对路径、权限或输入的新证据。", "后续读取成功，或明确报告具体阻塞。"],
  readback: ["交付前漏了要求的文件回读", "已经写入目标文件，完成答复前缺少用户要求的回读。", "对明确要求写后回读的单文件任务核验实际调用。", "同一轮最后一次成功写入后成功读取同一文件，再结束。"],
  redundant: ["相同读取连续三次得到相同结果", "可能重复取证，周期轮询也可能合理。", "检查工具返回及技能步骤，确定是否可以复用本轮结果。", "在同类任务中减少一次读取，同时保留同等交付证据。"],
  handoff: ["用户要求接手已交回的工作", "上一条答复提出再次确认，用户随后要求继续执行。", "检查任务授权和缺少的信息，再决定是否调整协作约定。", "授权完整时完成操作，确有待选事项时仍询问。"],
  correction: ["用户指出上轮交付有误", "需要结合所指对象和原始要求判断原因。", "从来源核查工具、技能、项目约定、事实记忆或源码。", "从纠正前的输入重放，并添加一个不适用案例。"],
  recovery: ["失败后换用其他输入并读取成功", "改变读取参数后，同轮出现成功回执。原因仍需核实。", "核对两次调用是否在处理同一问题，再考虑修正工具说明或技能。", "换一个同类输入，从第一步起就选对参数。"],
  deliveryContract: ["文档交付后仍需补齐明确要求", "原始任务已写明必需章节或附件，用户在完成答复后指出遗漏。", "在原生会话结束前按本轮明确的交付清单核验实际文件，提示具体缺项并继续处理。", "不经用户提醒补齐原例和同类变体。完整文档以及未要求附件的任务正常结束。"],
  oscillation: ["相同两种工具输入反复切换", "四次相邻调用形成来回切换，两个输入分别重复得到相同错误。", "核查这两种输入的使用前提，要求先获取能区分原因的新证据。", "遇到原错误后核对不同证据，再根据结果选择下一步。"],
  progress: ["用户反复追问同一任务进度", "可定位到相邻两次进度追问，中间缺少已完成操作或明确的阻塞回执。", "核对原生执行和等待原因，找出当时已有的可报告状态或可以继续的操作。", "同类任务实际推进或报告具体等待原因，用户无需再次催问。"],
  sequence: ["机械取证步骤具有重复封装机会", "连续只读步骤已完成且耗时达到阈值，重复样本需要对照参数和返回结果。", "核对重复步骤是否在不同任务承担同一用途，再考虑低风险脚本或技能。", "同类任务以更少操作获得相同可核对结果；需要独立核验时照常运行。"],
};

export function improvementProblemClass(kind: ImprovementKind) {
  switch (kind) {
    case "scope": case "correction": return "用户纠正";
    case "handoff": case "childSteer": return "无必要的停等";
    case "retry": case "oscillation": case "recovery": case "readPath": return "执行震荡";
    case "readback": case "deliveryContract": case "progress": case "childDelivery": return "进度与完成失真";
    case "redundant": case "sequence": return "高频高成本流程";
  }
}

export function rankImprovementCandidate(
  kind: ImprovementKind, count: number, scope: HookDraft["scope"]["kind"], repairMs = 0,
): number {
  const observedCost = Number.isFinite(repairMs) ? Math.max(0, Math.min(repairMs, 300_000)) : 0;
  const certainty = { deliveryContract: 8, readback: 7, readPath: 7, scope: 6, retry: 5, oscillation: 5,
    correction: 3, progress: 3, sequence: 3, handoff: 3, redundant: 2, recovery: 2, childDelivery: 2, childSteer: 2 }[kind];
  const reach = scope === "task" ? 0 : 2;
  return 3 * Math.log2(1 + Math.max(count, 0)) + 2 * Math.log2(1 + observedCost / 10_000) + reach + certainty;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v)).digest("hex");
}
export function messageText(content: Message["content"]): string {
  return typeof content === "string" ? content : content.flatMap(p => p.type === "text" ? [p.text] : []).join("\n");
}
export function requestFeatures(text: string) {
  text = text.replace(/\x60{3}[\s\S]*?(?:\x60{3}|$)/g,"").replace(/^\s*>.*$/gm,"").trim();
  const cancelled = /(?:停下|取消|不用继续|不要继续|只要(?:概要|概括|一句话)|不(?:必|用|要|需要)(?:再)?(?:回读|读回|验证)|跳过(?:回读|验证)|(?:不要|不必|无需)(?:再)?(?:收窄|缩小|限定|只改)|do not|don't|skip verification|cancel)/i.test(text)
    || /^(?:举例|示例|假设|如果|如何|怎么|是否|例如|how (?:would|do)|for example)/i.test(text) || /[?？]$/.test(text);
  const paths: string[] = [];
  const outsideQuotes = text.replace(/[\x60"'“「]([^\x60"'”」\r\n]{1,240}\.[a-zA-Z0-9]{1,12})[\x60"'”」]/g, (_all,path: string) => { paths.push(path); return " "; });
  for (const m of outsideQuotes.matchAll(/(?<![A-Za-z0-9_./\\:-])([A-Za-z0-9_-]+(?:[./\\-][A-Za-z0-9_-]+)*\.[a-zA-Z][a-zA-Z0-9]{0,11})(?![A-Za-z0-9_./\\:-])/g)) paths.push(m[1]);
  const target = new Set(paths);
  const write = text.search(/(?:写入|生成|保存|\bwrite\b|\bsave\b)/i);
  const verify = text.search(/(?:回读|读回|\bread (?:it |the file )?back\b)/i);
  return {
    scopeChange: !cancelled && /(?:范围|实施范围|scope).{0,10}(?:限定|收窄|缩小|限于|固定|仅限)|(?:只改|只实现|narrow the scope to)/i.test(text),
    explicitRetry: /(?:重试|反复读取|轮询|再试|retry|poll)/i.test(text),
    target: !cancelled && target.size === 1 && write >= 0 && verify > write ? paths[0] : "",
  };
}
export function scopeCorrection(text: string): boolean {
  return /(?:漏掉|遗漏|漏了|删掉了|弄丢|原先.{0,12}没了)/.test(text)
    && /(?:验收|交付要求|里程碑|完整规划)/.test(text);
}
export function requirementTopics(text: string): string[] {
  return ["验收", "交付", "里程碑", "完整规划"].filter(topic => text.includes(topic));
}
export const asksHandoff = (s: string) => /(?:需要我(?:继续|执行)|要我(?:继续|执行)吗|是否(?:继续|需要我)|shall I (?:proceed|continue))/i.test(s);
export const reportsBlocker = (s: string) => /(?:无法|失败|未完成|未能|不可用|权限不足|未获授权|未验证|未回读|blocked|failed|unable|cannot|could not)/i.test(s);
export const asksProgress = (s: string) =>
  /^(?:(?:请|麻烦|please)\s*)?(?:现在(?:做到哪|进展(?:如何|怎样))|进度(?:如何|怎样|呢|到哪)|(?:做|弄|跑)完了(?:吗|没)|怎么还没(?:好|完|动)|到哪一步了|(?:any\s+)?(?:progress|status)(?:\s+update)?|are you done)[？?。.!！\s]*$/i.test(s.trim());
export const claimsDelivery = (s: string) =>
  !reportsBlocker(s) && /(?:^|[。！!\n])\s*(?:已(?:经)?(?:完成|交付|生成|写入)|交付完成|完成了|完成[。！!\s]*$|done\b|completed\b|delivered\b)/i.test(s.trim());

export type ReadResult = { args: string; result: string; error: boolean };
export const sameRead = (a?: ReadResult, b?: ReadResult) => Boolean(a && b && a.args === b.args && a.result === b.result && a.error === b.error);

// Inspect only the two adjacent completed serial calls. Concurrent, unmatched and intervening calls break the sequence.
export function repeatedReadFailure(messages: readonly Message[]): boolean {
  const tail = messages.slice(-4);
  if (tail.length !== 4) return false;
  const reads: ReadResult[] = [];
  for (const offset of [0, 2]) {
    const call = tail[offset], result = tail[offset + 1];
    if (call.role !== "assistant" || result.role !== "toolResult" || result.toolName !== "read" || !result.isError) return false;
    const calls = call.content.filter(p => p.type === "toolCall");
    if (calls.length !== 1 || calls[0].name !== "read" || calls[0].id !== result.toolCallId) return false;
    reads.push({ args: fingerprint(calls[0].arguments), result: fingerprint(result.content), error: true });
  }
  return sameRead(reads[0], reads[1]);
}
export interface ReadbackTool { tool: string; path?: string; requestedPath?: string; version?: string; isError: boolean }

export function sameReadbackPath(left?: string, right?: string, cwd?: string): boolean {
  return !!left && !!right && (left === right || (!!cwd && pathKey(resolve(cwd, left)) === pathKey(resolve(cwd, right))));
}

export function matchesReadbackTarget(target: string, tool: ReadbackTool, cwd?: string): boolean {
  return !!target && !!tool.path && (target === tool.requestedPath || sameReadbackPath(target, tool.path, cwd));
}

export function confirmsReadback(write: Pick<ReadbackTool, "path" | "version">, read: ReadbackTool, cwd?: string): boolean {
  return sameReadbackPath(write.path, read.path, cwd) && (!write.version || !read.version || write.version === read.version);
}
// Native Code Mode records start and completion order. An overlapping read cannot certify the new bytes.
export function nestedReadbackTools(details: unknown): ReadbackTool[] {
  if (!details || typeof details !== "object" || !("fileOperations" in details) || !Array.isArray(details.fileOperations)) return [];
  const writes = new Map<string,number>();
  const evidence: ReadbackTool[] = [];
  for (const f of details.fileOperations) {
    if (!f || typeof f.path !== "string" || !Number.isInteger(f.start) || !Number.isInteger(f.finish) || f.isError !== false) continue;
    if (f.tool === "write" || f.tool === "edit") writes.set(f.path,f.finish);
    else if (f.tool !== "read" || f.start < (writes.get(f.path) ?? 0)) continue;
    evidence.push({ tool: f.tool, path: f.path, requestedPath: typeof f.requestedPath === "string" ? f.requestedPath : undefined,
      version: typeof f.version === "string" ? f.version : undefined, isError: false });
  }
  return evidence;
}
export function readbackState(target: string, tools: readonly ReadbackTool[], cwd?: string): "none" | "written" | "verified" {
  let state: "none" | "written" | "verified" = "none";
  let write: ReadbackTool | undefined;
  for (const t of tools) {
    if (t.isError || !matchesReadbackTarget(target, t, cwd)) continue;
    if (t.tool === "write" || t.tool === "edit") { state = "written"; write = t; }
    else if (t.tool === "read" && write) state = confirmsReadback(write, t, cwd) ? "verified" : "written";
  }
  return state;
}

const scopeNote = "对照上轮原始要求，保留仍适用的交付物、里程碑和验收条件，只调整用户本次指定的范围。";
const retryNote = "两次相同的 read 收到了同一错误。请先核对区分原因的新证据，再决定是否重试；若缺权限，请报告实际阻塞。";
const fileNote = "本轮已写入指定文件。请按用户要求回读同一文件，再根据回读结果交付；若无法读取，说明具体阻塞。";
export function improvementDraft(kind: ImprovementKind, scope: HookDraft["scope"]): HookDraft | undefined {
  const common = { title: cards[kind][0], scope, actor: "all" as const, tool: "" };
  if (kind === "scope") return { ...common, event: "beforeRequest", script: "return event.scopeChange && event.hasPriorAnswer ? " + JSON.stringify(scopeNote) + " : true;",
    cases: [{ input: { scopeChange: true, hasPriorAnswer: true }, expected: scopeNote }, { input: { scopeChange: true }, expected: true }, { input: { hasPriorAnswer: true }, expected: true }] };
  if (kind === "retry") return { ...common, event: "beforeRequest", script: "return event.repeatedReadFailure && !event.explicitRetry ? " + JSON.stringify(retryNote) + " : true;",
    cases: [{ input: { repeatedReadFailure: true }, expected: retryNote }, { input: { repeatedReadFailure: true, explicitRetry: true }, expected: true }, { input: {}, expected: true }] };
  if (kind === "readback") return { ...common, event: "beforeFinish", script: "return event.readback === 'written' && !event.reportedBlocker && !event.historyTruncated ? " + JSON.stringify(fileNote) + " : true;",
    cases: [{ input: { readback: "written" }, expected: fileNote }, { input: { readback: "verified" }, expected: true },
      { input: { readback: "written", reportedBlocker: true }, expected: true }, { input: { readback: "written", historyTruncated: true }, expected: true }, { input: {}, expected: true }] };
}
