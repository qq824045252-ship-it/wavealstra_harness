import type { WorkActionDescriptor } from "../../../shared/bot-work-action";
import { conservativeDescriptor, workActionDescriptorSchema } from "../../../shared/bot-work-action";

export interface WorkActionClassificationInput {
  toolName: string;
  arguments: unknown;
  /** 结构化 MCP 身份优先于 shell 猜测。 */
  mcp?: { providerId: string; server?: string; tool?: string };
  effect?: "side-effect" | "read" | "dangerous";
  context?: { workspaceId?: string; projectId?: string; repo?: string; taskRoot?: string };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

const PROTECTED_BRANCH = /^(main|master|release\/|prod)/i;
const PROTECTED_TARGET = /(^|\/)(main|master)$/i;

/** Shell 只能保守分类；未识别的写命令不会被当成 read。 */
function classifyShell(command: string, context: WorkActionClassificationInput["context"]): WorkActionDescriptor {
  const base = { environment: "local" as const, workspaceId: context?.workspaceId, projectId: context?.projectId, repo: context?.repo,
    source: "shell" as const, tags: [] as WorkActionDescriptor["tags"] };
  const has = (pattern: RegExp) => pattern.test(command);
  const readable = /^(ls|cat|pwd|wc|stat|head|tail|grep|rg|find|echo|test|readlink|realpath|file|du|df|md5sum|sha256sum|git (status|log|diff|show|branch|remote)|sed -n|awk)\b/;
  const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  const allRead = segments.length > 0 && segments.every(segment => readable.test(segment.trim()));

  if (has(/\bgit\s+push\b/)) {
    const force = /--force\b|(^|\s)-f(\s|$)/.test(command);
    const protectedTarget = /(^|\s)(origin\s+)?(main|master)(\s|$)/.test(command) || PROTECTED_TARGET.test(command);
    return workActionDescriptorSchema.parse({ ...base, effect: "repo_write",
      operation: force ? "git_force_push" : protectedTarget ? "git_push_protected" : "git_push",
      provider: "git", target: protectedTarget ? "main" : undefined, reversibility: force ? "irreversible" : "recoverable",
      blastRadius: "project", hardGate: force || protectedTarget,
      tags: [...(force ? ["irreversible" as const] : []), ...(protectedTarget ? ["protected-target" as const] : [])] });
  }
  if (has(/\bgit\s+(commit|add|checkout|switch|merge|rebase|reset|stash|tag|cherry-pick)\b/)) {
    const destructive = has(/\b(git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+checkout\s+--\s)/);
    return workActionDescriptorSchema.parse({ ...base, effect: "repo_write", operation: destructive ? "git_destroy" : "git_commit",
      provider: "git", reversibility: destructive ? "irreversible" : "recoverable", blastRadius: "project",
      hardGate: destructive, tags: destructive ? ["destructive", "irreversible"] : [] });
  }
  if (has(/\b(gh|hub)\s+pr\s+merge\b/) || has(/\bgh\s+pr\s+(approve|review)\b/)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "repo_write", operation: has(/merge/) ? "pr_merge" : "pr_approve",
      provider: "github", reversibility: "recoverable", blastRadius: "project", hardGate: true, tags: ["protected-target"] });
  }
  if (has(/\b(npm|pnpm|yarn)\s+publish\b/) || has(/\bcargo\s+publish\b/) || has(/\bgh\s+release\s+create\b/) || has(/\bgh\s+release\s+upload\b/)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "publish", operation: "release", provider: "package",
      environment: "production", reversibility: "irreversible", blastRadius: "external", hardGate: true, tags: ["publish", "irreversible"] });
  }
  if (has(/\b(rm\s+-[a-z]*[rf]|rmdir|truncate|shred)\b/) || has(/\bgit\s+push\s+--delete\b/) || has(/\bdocker\s+(rm|rmi|volume\s+rm)\b/)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "delete", operation: "delete", reversibility: "irreversible",
      blastRadius: "project", hardGate: true, tags: ["destructive", "irreversible"] });
  }
  if (has(/\b(export|set)\s+[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)\b/) || has(/\b(op|pass|security|keychain)\b/) || has(/\.ssh\/|\.aws\/|\.config\/gh/)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "credential", operation: "use_secret", reversibility: "unknown",
      blastRadius: "account", hardGate: true, tags: ["credential"] });
  }
  if (has(/\b(curl|wget|http|https)\b/) && has(/\s(-X|--request)\s+(POST|PUT|PATCH|DELETE)\b/) || has(/\bcurl\b.*-d\s/)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "external_write", operation: "http_write", provider: "http",
      access: undefined, reversibility: "unknown", blastRadius: "external", hardGate: false, tags: ["external-side-effect"] } as never);
  }
  if (allRead) {
    return workActionDescriptorSchema.parse({ ...base, effect: "read", operation: "shell_read", reversibility: "reversible",
      blastRadius: "single", hardGate: false });
  }
  // 写文件/未知命令：明确落在 local_write，绝不降级成 read。
  const writes = /(^|\s)>{1,2}\s|(^|\s)tee\b|\bmkdir\b|\btouch\b|\bcp\b|\bmv\b|\bln\b|\bsed\s+-i\b|\bpatch\b/;
  if (writes.test(command)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "local_write", operation: "shell_write",
      reversibility: "recoverable", blastRadius: "single", hardGate: false });
  }
  return conservativeDescriptor("shell 命令无法可靠归类，按未分类外部写入处理");
}

export function classifyWorkAction(input: WorkActionClassificationInput): WorkActionDescriptor {
  const name = input.toolName.trim();
  const args = asRecord(input.arguments);
  const context = input.context;
  const common = { workspaceId: context?.workspaceId, projectId: context?.projectId, repo: context?.repo, tags: [] as WorkActionDescriptor["tags"] };

  if (input.mcp) {
    const server = input.mcp.server ?? input.mcp.providerId;
    const tool = input.mcp.tool ?? name;
    const target = str(args.channel) ?? str(args.channel_id) ?? str(args.to) ?? str(args.number) ?? str(args.repo);
    if (/slack|telegram|discord|feishu|lark|qq|weixin|wechat|dingtalk|mail|email/i.test(`${server} ${tool}`)
      || /^(send|reply|post|publish)_?message$/i.test(tool) || /send/i.test(tool)) {
      return workActionDescriptorSchema.parse({ ...common, effect: "message", operation: "send_message",
        provider: server, target, environment: "unknown", reversibility: "irreversible", blastRadius: "external",
        hardGate: false, source: "mcp", tags: ["external-side-effect"] });
    }
    if (/delete|destroy|purge|revoke/i.test(tool)) {
      return workActionDescriptorSchema.parse({ ...common, effect: "delete", operation: "mcp_delete", provider: server, target,
        environment: "unknown", reversibility: "irreversible", blastRadius: "external", hardGate: true, source: "mcp",
        tags: ["destructive", "irreversible"] });
    }
    if (input.effect === "read") {
      return workActionDescriptorSchema.parse({ ...common, effect: "read", operation: "mcp_read", provider: server, target,
        environment: "unknown", reversibility: "reversible", blastRadius: "single", hardGate: false, source: "mcp" });
    }
    return workActionDescriptorSchema.parse({ ...common, effect: "external_write", operation: `${server}:${tool}`,
      provider: server, target, environment: "unknown", reversibility: "unknown", blastRadius: "external",
      hardGate: false, source: "mcp", tags: ["external-side-effect"] });
  }

  if (name === "bash" || name === "run_command" || name === "terminal_exec") {
    const command = str(args.command) ?? str(args.cmd) ?? str(args.input) ?? "";
    return command ? classifyShell(command, context) : conservativeDescriptor("缺少命令内容，按未分类动作处理");
  }
  if (name === "write" || name === "edit" || name === "apply_patch" || name === "create_file") {
    return workActionDescriptorSchema.parse({ ...common, effect: "local_write", operation: "write_file",
      target: str(args.path) ?? str(args.file_path), environment: "local", reversibility: "recoverable",
      blastRadius: "single", hardGate: false, source: "builtin" });
  }
  if (["read", "ls", "glob", "grep", "search", "web_search", "fetch_content", "get_search_content", "source_check"].includes(name)) {
    return workActionDescriptorSchema.parse({ ...common, effect: "read", operation: name === "read" ? "read_file" : "inspect",
      target: str(args.path), environment: "local", reversibility: "reversible", blastRadius: "single",
      hardGate: false, source: "builtin" });
  }
  if (name.startsWith("computer_") || name === "ui_exec" || name === "browser_exec") {
    return workActionDescriptorSchema.parse({ ...common, effect: "physical_input", operation: name,
      environment: "local", reversibility: "unknown", blastRadius: "single", hardGate: false, source: "physical",
      tags: ["physical-input"] });
  }
  if (/subagent|delegate|team/.test(name)) {
    return workActionDescriptorSchema.parse({ ...common, effect: "local_write", operation: "delegate",
      environment: "local", reversibility: "reversible", blastRadius: "project", hardGate: false, source: "builtin" });
  }
  return conservativeDescriptor(`工具 ${name} 没有结构化分类，按未分类外部写入处理`);
}
