import { workShellRead } from "./WorkShellRead";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import { fileResourceIdentity } from "../../platform/resource-identity";
import { heldInputCleanupGeneration } from "../../platform/computer-use/heldInput";
import { fileResource, resourceOwnerKey, type ResourceLease, WorkResourceGate, type WorkResource, type WorkResourceOwner } from "./WorkResourceGate";

export interface ToolResourceContext {
  taskId: string; conversationId: string; nativeTaskId: string; taskRoot: string;
}
export interface ToolResourceCall {
  call: ToolHookCall; context: ToolResourceContext; sideEffect: boolean; paths: string[];
}
const containers = new Set(["codemode", "execute_code", "subagent", "subagent_list", "subagent_steer", "multi_model_consult"]);
const pathsOf = z.object({ path: z.string().optional(), file_path: z.string().optional(), filePath: z.string().optional(),
  filename: z.string().optional(), fileName: z.string().optional() }).passthrough();
const actionOf = z.object({ action: z.string().optional(), key: z.string().optional(), button: z.string().optional(),
  actions: z.array(z.unknown()).optional() }).passthrough();
const idOf = (owner: WorkResourceOwner, call: ToolHookCall, context: ToolResourceContext) =>
  `resource:${resourceOwnerKey(owner)}:${context.nativeTaskId}:${call.id}`;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function boundedShellRead(call: ToolHookCall): string | undefined {
  if (!/^(bash|shell|shell_exec|terminal_exec|exec_command)$/.test(call.name)) return undefined;
  const value = z.object({ command: z.string().optional() }).passthrough().parse(call.arguments).command;
  if (!value || /[;&|<>`$\r\n]/.test(value)) return undefined;
  // This is deliberately a tiny complete-command grammar, never a general shell safety claim.
  const match = /^(?:cat|type|Get-Content)(?:\s+-LiteralPath)?\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s]+))\s*$/i.exec(value.trim());
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** Every leaf tool uses the same persistent gate, including ordinary Tasks and owned children. */
export class WorkToolResourcePolicy {
  private readonly calls = new Map<string, { lease: ResourceLease; observed: WorkResource[]; owner: WorkResourceOwner; input: ToolResourceCall; boundedRead: boolean; opaqueObservation: boolean }>();
  private readonly held = new Map<string, { lease: ResourceLease; controls: Set<string>; cleanupGeneration: number }>();
  constructor(private readonly gate: WorkResourceGate, private readonly owner: (context: ToolResourceContext) => WorkResourceOwner,
    private readonly options: { allowGitBranchOrWorktree?: () => boolean } = {}) {}

  before(input: ToolResourceCall): string | undefined {
    const { call, context, sideEffect } = input;
    if (containers.has(call.name)) return undefined;
    const owner = this.owner(context);
    const command = z.object({ command: z.string().optional(), args: z.array(z.string()).optional() }).passthrough().parse(call.arguments);
    const commandText = command.command ?? (call.name === "git" ? `git ${(command.args ?? []).join(" ")}` : "");
    if (this.options.allowGitBranchOrWorktree?.() === false
      && /\bgit\s+(?:-[^\s]+\s+)*(?:worktree|branch|checkout\s+[^\n]*-[bB]|switch\s+[^\n]*-[cC])/i.test(commandText))
      return "当前 Work 授权禁止创建或切换分支/worktree；请调整为已有 shared 工作区计划";
    const actionId = idOf(owner, call, context);
    const args = pathsOf.parse(call.arguments);
    if (!sideEffect && call.name.startsWith("mcp__") && input.paths.length === 0
      && (args.path || args.file_path || args.filePath || args.filename || args.fileName))
      return "MCP 读取缺少可信路径适配器，不能产生无法复核的旧版本；请改用内置 read 或已登记的读取入口";
    const resources: WorkResource[] = [];
    const bounded = workShellRead(call.name, call.arguments);
    const shellRead = bounded?.path ?? boundedShellRead(call);
    const filePaths = shellRead ? [shellRead] : input.paths.length ? input.paths : ["read", "write", "edit"].includes(call.name)
      ? [args.path ?? args.file_path].filter((path): path is string => Boolean(path)) : [];
    for (const path of filePaths) {
      // Only trusted adapters supply paths; resolve relative names against the actual child workspace.
      const resource = fileResource(requireAbsolute(context.taskRoot, path), sideEffect && !shellRead ? "write" : "read");
      if (sideEffect && !shellRead) resource.expectedVersion = this.gate.observed(owner, resource) ?? resource.expectedVersion;
      resources.push(resource);
    }
    const desktop = /computer|desktop|cua|glimpse/i.test(call.name);
    const browser = /browser/i.test(call.name);
    if (desktop || browser) {
      resources.push({ kind: "desktop", scope: "physical-input", key: "host-session", mode: sideEffect ? "write" : "read" });
      if (browser) resources.push({ kind: "browser", scope: "browser-session", key: "host-profile", mode: sideEffect ? "write" : "read" });
    }
    if (!resources.length) resources.push({ kind: "host", scope: "local-host", key: "unclassified-tool", mode: sideEffect ? "write" : "read" });
    const coarse = resources.some(resource => resource.kind === "host");
    const opaque = this.gate.opaqueObservation(owner);
    if (opaque && sideEffect && !shellRead) {
      if (coarse) return `原 ${opaque.tool_name} 返回了范围未核实的观察；不能据此继续不受限命令。`
        + `恢复方式：用内置 read 指定明确文件路径重新读取；需要行数时，在读到的完整内容上统计，截断时先分段读完。`
        + `列目录可用 bash 的 ls "./dir"（单个明确字面路径，不带选项）。wc -l 和 ls -1 即使补上路径也不属于可信读取。`
        + `修改请使用明确目标路径的内置 write/edit，覆盖已有文件前逐个重新读取；这不会解除任意 Shell 命令限制。`;
      for (const resource of resources) if (resource.path && resource.entity && !this.gate.observedAfter(owner, resource, opaque.sequence))
        return `已有不透明观察；覆盖现有文件 ${resource.path} 前，必须通过可信读取入口（内置 read）以该明确路径重新读取目标版本，再用同一路径的内置 write/edit 修改。`
          + `读取其他文件或列目录不能代替该目标的重读，也不会解除任意 Shell 命令限制。`;
    }
    if (coarse && sideEffect) {
      for (const observed of this.gate.observedResources(owner)) {
        if (fileResourceIdentity(observed.path).version !== observed.version) return `version_conflict: 先前读取的文件已变化：${observed.path}`;
      }
    }
    const action = actionOf.parse(call.arguments).action ?? "";
    if (/key_down|mouse_down/.test(action) && actionOf.parse(call.arguments).actions) return "按下输入必须独立执行并以显式 up 或已确认清理结算";
    let previous = (desktop || browser) ? this.held.get(resourceOwnerKey(owner)) : undefined;
    if (previous && (this.gate.leaseState(previous.lease) === "released" || previous.cleanupGeneration !== heldInputCleanupGeneration(owner.taskId))) {
      this.held.delete(resourceOwnerKey(owner)); previous = undefined;
    }
    const admission = previous ? { ok: true as const, lease: previous.lease } : this.gate.acquire({ actionId, owner, resources });
    if (!admission.ok) return admission.reason;
    const cleanup = previous && /^(key_up|mouse_up|mouse_up_client)$/.test(action);
    const denied = cleanup ? this.gate.validateSettlement(admission.lease) : this.gate.validateVersions(admission.lease);
    if (denied) { if (!previous) this.gate.release(admission.lease, "not_started", denied); return denied; }
    const opaqueObservation = !bounded && coarse && (/^(bash|shell|shell_exec|terminal_exec|exec_command)$/.test(call.name) || call.name.startsWith("mcp__"));
    this.calls.set(actionId, { lease: admission.lease, observed: resources.filter(resource => resource.path), owner, input, boundedRead: Boolean(shellRead), opaqueObservation });
    return undefined;
  }

  async beforeWait(input: ToolResourceCall, signal?: AbortSignal): Promise<string | undefined> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const denied = this.before(input);
      if (!denied || !denied.includes("等待共享资源在途操作结算")) return denied;
      if (Date.now() >= deadline || signal?.aborted) {
        this.gate.cancelWaiting({ actionId: idOf(this.owner(input.context), input.call, input.context) });
        return signal?.aborted ? "资源等待已取消，未执行新动作" : "资源等待已超时，未执行新动作";
      }
      try { await this.gate.waitForChange(signal); }
      catch { this.gate.cancelWaiting({ actionId: idOf(this.owner(input.context), input.call, input.context) }); return "资源等待已取消，未执行新动作"; }
    }
  }

  refuse(input: ToolResourceCall, reason: string): boolean {
    if (containers.has(input.call.name)) return false;
    const owner = this.owner(input.context);
    return this.gate.recordNotStarted(idOf(owner, input.call, input.context), owner, reason);
  }
  wasNotStarted(input: ToolResourceCall): boolean {
    if (containers.has(input.call.name)) return false;
    const owner = this.owner(input.context);
    return this.gate.wasNotStarted(idOf(owner, input.call, input.context), owner);
  }

  after(input: ToolResourceCall, outcome: "consumed" | "released" | "unknown"): void {
    const owner = this.owner(input.context);
    const actionId = idOf(owner, input.call, input.context);
    const state = this.calls.get(actionId);
    if (!state) return; // Validation/blocking can produce afterTool without admission.
    this.calls.delete(actionId);
    // Persist the version that produced the read, even if the resource changed during it.
    // Omitting that observation would let a later write silently adopt the new content.
    if (!input.sideEffect || state.boundedRead) for (const resource of state.observed) this.gate.observe(owner, resource);
    if (state.opaqueObservation) this.gate.noteOpaqueObservation(owner, input.call.name);
    const action = actionOf.parse(input.call.arguments);
    const key = resourceOwnerKey(owner);
    if (outcome === "unknown") {
      this.gate.release(state.lease, "unknown", "工具中断或效果/输入队列未确认");
      return;
    }
    const isDown = /^(key_down|mouse_down|mouse_down_client)$/.test(action.action ?? "");
    const isUp = /^(key_up|mouse_up|mouse_up_client)$/.test(action.action ?? "");
    const control = action.action?.startsWith("key_") ? `key:${action.key ?? "unknown"}` : `mouse:${action.button ?? "left"}`;
    if (isDown && outcome === "consumed") {
      const held = this.held.get(key) ?? { lease: state.lease, controls: new Set<string>(), cleanupGeneration: heldInputCleanupGeneration(owner.taskId) };
      held.controls.add(control); this.held.set(key, held);
      this.gate.markInputHeld(state.lease, [...held.controls]);
      // Lease remains persistent across calls. Expiry quarantines it instead of handing input over.
      return;
    }
    const held = this.held.get(key);
    if (held && isUp && outcome === "consumed") held.controls.delete(control);
    if (held?.controls.size) { this.gate.markInputHeld(state.lease, [...held.controls]); return; }
    this.held.delete(key);
    if (isUp && this.gate.leaseState(state.lease) === "quarantined") return; // Input cleanup cannot settle a different unknown effect.
    if (outcome === "consumed" && input.sideEffect && !state.boundedRead) {
      for (const resource of state.observed) {
        const current = fileResource(resource.path ?? resource.key, "read");
        // A read whose source changed mid-read cannot become a reusable write baseline.
        if (input.sideEffect && !state.boundedRead) this.gate.observe(owner, current);
      }
    }
    this.gate.release(state.lease, outcome === "consumed" ? "confirmed" : "not_started");
  }

  /** Only a verified backend cleanup receipt may release held physical input. */
  settleInput(owner: WorkResourceOwner, evidence: { queueDrained: boolean; inputReleased: boolean; receipt: string }): boolean {
    const key = resourceOwnerKey(owner), held = this.held.get(key);
    if (!held || !evidence.queueDrained || !evidence.inputReleased || !evidence.receipt) return false;
    this.held.delete(key);
    return this.gate.release(held.lease, "confirmed", `backend-cleanup:${digest(evidence.receipt)}`);
  }
}

function requireAbsolute(root: string, path: string): string { return resolve(root, path); }
