import { z } from "zod";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

/** Parse only literal shell words and explicit separators. No evaluation, expansion or substitution. */
type ShellPart = { words: string[]; redirect?: { append: boolean; path: string } };
function literalShell(command: string): ShellPart[] | undefined {
  const tokens: string[] = [];
  let word = "", started = false, quote = "";
  const flush = () => { if (started) tokens.push(word); word = ""; started = false; };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]!;
    if (c === "`" || c === "\\" || c === "\r" || c === "\0") return undefined;
    if (c === "$" && quote !== "'") {
      if (command[i + 1] !== "?") return undefined;
      word += "$?"; started = true; i += 1; continue;
    }
    if (quote) { if (c === quote) quote = ""; else word += c; started = true; continue; }
    if (c === "'" || c === '\"') { quote = c; started = true; continue; }
    if (/[~*?{}()!<>]/.test(c) && c !== ">") return undefined;
    if (/\s/.test(c) && c !== "\n") { flush(); continue; }
    if (/[;&|>\n]/.test(c)) {
      flush();
      const pair = command.slice(i, i + 2);
      if (["&&", "||", ">>"].includes(pair)) { tokens.push(pair); i += 1; }
      else if (c === "&") return undefined;
      else tokens.push(c === "\n" ? ";" : c);
      continue;
    }
    word += c; started = true;
  }
  if (quote) return undefined;
  flush();
  const parts: ShellPart[] = []; let current: ShellPart = { words: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if ([";", "&&", "||", "|"].includes(token)) {
      if (!current.words.length) return undefined;
      parts.push(current); current = { words: [] }; continue;
    }
    if (token === ">" || token === ">>") {
      const path = tokens[++i];
      if (!path || current.redirect || /^(;|&&|\|\||\||>|>>)$/.test(path)) return undefined;
      current.redirect = { append: token === ">>", path }; continue;
    }
    // A literal token equal to a control operator is intentionally unsupported too.
    current.words.push(token);
  }
  if (current.words.length) parts.push(current);
  else if (tokens.length && tokens.at(-1) !== ";") return undefined;
  return parts.length ? parts : undefined;
}

const LOCAL_READ_FLAGS: Record<string, RegExp> = {
  ls: /^(-[alhHndrtSR1]+|--(all|almost-all|human-readable|directory|numeric-uid-gid|recursive))$/,
  cat: /^(-[AbenstuvET]+|--(number|show-all))$/,
  pwd: /^-[LP]$/, wc: /^(-[clmwL]+|--(bytes|chars|lines|words|max-line-length|files0-from))$/,
  stat: /^(-[Lt]+|--(dereference|terse))$/,
  head: /^(-[0-9]+|-n|-c)$/, tail: /^(-[0-9]+|-n|-c)$/,
  grep: /^(-[EinvHhoclFwr]+|--(fixed-strings|line-number|ignore-case))$/,
  rg: /^(-[invHhoclFw]+|--(files|hidden|line-number|no-heading))$/,
  readlink: /^-[femnqsz]+$/, realpath: /^-[emPsz]+$/,
  file: /^-[bhiL]+$/, du: /^-[abchskm]+$/, df: /^-[hTki]+$/,
  md5sum: /^-[bct]+$/, sha256sum: /^-[bct]+$/,
};
function readWords(words: string[]): boolean {
  const [name, ...args] = words;
  if (!name) return false;
  if (name === "echo") return args.every(arg => !arg.includes("$?") || arg === "$?" || arg === "exit=$?");
  if (words.some(word => word.includes("$?"))) return false;
  if (name === "git") {
    const [sub, ...rest] = args;
    if (!sub) return false;
    if (sub === "branch") return rest.length === 0 || rest.every(arg => ["--list", "-a", "-r", "-v", "-vv"].includes(arg));
    if (sub === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v");
    if (!["status", "log", "show", "rev-parse", "describe", "ls-files"].includes(sub)) return false;
    return rest.every(arg => !arg.startsWith("-") || /^(--short|--porcelain(?:=v[12])?|--oneline|--stat|--name-only|--no-patch|--show-toplevel|--abbrev-ref|--tags|--always|-n|-[0-9]+)$/.test(arg));
  }
  if (name === "curl") return args.some(arg => /^https?:\/\//.test(arg))
    && args.every(arg => /^https?:\/\//.test(arg) || /^(--silent|--show-error|--fail|--location|--head|-[sSfLI]+)$/.test(arg));
  // wget writes by default; only explicit stdout and known read flags qualify.
  if (name === "wget") return args.includes("-O") && args[args.indexOf("-O") + 1] === "-"
    && args.some(arg => /^https?:\/\//.test(arg))
    && args.every(arg => /^https?:\/\//.test(arg) || ["-O", "-", "-q", "--quiet"].includes(arg));
  if (name === "gh") {
    if (args[0] === "api") return args.length === 2 && !!args[1] && !args[1].startsWith("-");
    if (!["pr", "issue", "repo", "run", "workflow", "release"].includes(args[0] ?? "")
      || !["list", "view", "status", "diff", "checks"].includes(args[1] ?? "")) return false;
    return args.slice(2).every(arg => !arg.startsWith("-") || ["--state", "--limit", "--json", "--jq"].includes(arg));
  }
  const flags = LOCAL_READ_FLAGS[name];
  if (!flags) return false;
  let operands = false;
  return args.every(arg => { if (arg === "--") { operands = true; return true; }
    return operands || !arg.startsWith("-") || flags.test(arg); });
}

/** Every command, option and redirection must be understood, not just a command prefix. */
export function isProvablyReadOnlyShell(command: string): boolean {
  const parts = literalShell(command);
  return !!parts && parts.every(part => !part.redirect && readWords(part.words));
}

/** Shell 只能保守分类；未识别的写命令不会被当成 read。 */
function classifyShell(command: string, context: WorkActionClassificationInput["context"]): WorkActionDescriptor {
  const base = { environment: "local" as const, workspaceId: context?.workspaceId, projectId: context?.projectId, repo: context?.repo,
    source: "shell" as const, provider: "shell", tags: [] as WorkActionDescriptor["tags"] };
  const has = (pattern: RegExp) => pattern.test(command);
  if (has(/\b(export|set)\s+[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)\b/) || has(/\b(op|pass|security|keychain)\b/) || has(/\.ssh\/|\.aws\/|\.config\/gh/)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "credential", operation: "use_secret", reversibility: "unknown",
      blastRadius: "account", hardGate: true, tags: ["credential"] });
  }
  const parsed = literalShell(command);
  if (!parsed) return conservativeDescriptor("命令含无法证明的展开或语法，需要核对完整动作");
  if (parsed.length > 1 && parsed.some(part => !readWords(part.words)
    && !["mkdir", "touch", "printf", "echo"].includes(part.words[0] ?? ""))) {
    return conservativeDescriptor("复合命令包含未证明的动作，不能沿用其中一个子命令的授权");
  }


  if (has(/\bgit\s+push\b/)) {
    const exactPush = /^git\s+push\s+([A-Za-z0-9_.-]+)\s+([A-Za-z0-9_./:-]+)$/.exec(command);
    const target = exactPush ? `${exactPush[1]} ${exactPush[2]}` : undefined;
    const force = /--force\b|(^|\s)-f(\s|$)|(^|\s)\+\S+/.test(command);
    const deleting = /(^|\s)(--delete|-d|:[^\s]+)(\s|$)/.test(command);
    const protectedTarget = /(^|\s)(origin\s+)?(main|master)(\s|$)/.test(command) || PROTECTED_TARGET.test(command) || /:(?:refs\/heads\/)?(?:main|master)(?:\s|$)/.test(command);
    return workActionDescriptorSchema.parse({ ...base, effect: "repo_write",
      operation: deleting ? "git_delete_ref" : force ? "git_force_push" : protectedTarget ? "git_push_protected" : "git_push",
      provider: "git", target, reversibility: force ? "irreversible" : "recoverable",
      blastRadius: "project", hardGate: deleting || force || protectedTarget,
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
  if (has(/\b(rm\s+-[a-z]*[rf]|rmdir|truncate|shred)\b/) || has(/\bgit\s+push\s+--delete\b/) || has(/\bdocker\s+(rm|rmi|volume\s+rm)\b/)
    || has(/(^|\s)find(\s|$)[\s\S]*(^|\s)-(delete|execdir|okdir)(\s|$)/)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "delete", operation: "delete", reversibility: "irreversible",
      blastRadius: "project", hardGate: true, tags: ["destructive", "irreversible"] });
  }
  if (has(/\b(curl|wget|http|https)\b/) && has(/\s(-X|--request)\s+(POST|PUT|PATCH|DELETE)\b/) || has(/\bcurl\b.*-d\s/)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "external_write", operation: "http_write", provider: "http",
      reversibility: "unknown", blastRadius: "external", hardGate: false, tags: ["external-side-effect"] });
  }
  if (isProvablyReadOnlyShell(command)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "read", operation: "shell_read", reversibility: "reversible",
      blastRadius: "single", hardGate: false });
  }
  // 写文件/未知命令：明确落在 local_write，绝不降级成 read。
  const writes = /(^|\s)>>?\s*\S|(^|\s)tee(\s|$)|(^|\s)mkdir(\s|$)|(^|\s)touch(\s|$)|(^|\s)(cp|mv|ln)(\s|$)|(^|\s)sed\s+-i|(^|\s)patch(\s|$)|(^|\s)dd(\s|$)/;
  if (writes.test(command)) {
    return workActionDescriptorSchema.parse({ ...base, effect: "local_write", operation: "shell_write",
      reversibility: "recoverable", blastRadius: "single", hardGate: false });
  }
  return conservativeDescriptor("shell 命令无法可靠归类，按未分类外部写入处理");
}

// Progress is an internal mutation, not a read or blanket workspace write.
const progressArguments = z.object({
  workId: z.string().min(1).optional(), progressSummary: z.string().max(2000).optional(),
  status: z.literal("active").optional(),
  expectedStateVersion: z.number().int().nonnegative(), expectedIntentRevision: z.number().int().nonnegative(),
  expectedOwnerEpoch: z.number().int().nonnegative(),
  criterionUpdates: z.array(z.object({ id: z.string().min(1).max(100), evidence: z.string().max(1000).optional() }).strict()).max(12).optional(),
}).strict().refine(value => value.progressSummary !== undefined || !!value.criterionUpdates?.length);

export function classifyWorkAction(input: WorkActionClassificationInput): WorkActionDescriptor {
  const name = input.toolName.trim();
  const args = asRecord(input.arguments);
  const context = input.context;
  const common = { provider: "builtin", workspaceId: context?.workspaceId, projectId: context?.projectId, repo: context?.repo, tags: [] as WorkActionDescriptor["tags"] };

  if (input.mcp) {
    const server = input.mcp.server ?? input.mcp.providerId;
    const tool = input.mcp.tool ?? name;
    const target = str(args.channel) ?? str(args.channel_id) ?? str(args.to) ?? str(args.number) ?? str(args.repo);
    if (/delete|destroy|purge|revoke/i.test(tool)) {
      return workActionDescriptorSchema.parse({ ...common, effect: "delete", operation: "mcp_delete", provider: server, target,
        environment: "unknown", reversibility: "irreversible", blastRadius: "external", hardGate: true, source: "mcp",
        tags: ["destructive", "irreversible"] });
    }
    if (/^(send|reply|post|publish)_?message$|^chat_postMessage$/i.test(tool)) {
      return workActionDescriptorSchema.parse({ ...common, effect: "message", operation: "send_message",
        provider: server, target, environment: "unknown", reversibility: "irreversible", blastRadius: "external",
        hardGate: false, source: "mcp", tags: ["external-side-effect"] });
    }
    // read 不能只由服务器名或 HTTP 动词推定：必须是结构化分类给出的明确只读证据。
    if (input.effect === "read") {
      return workActionDescriptorSchema.parse({ ...common, effect: "read", operation: "mcp_read", provider: server, target,
        environment: "unknown", reversibility: "reversible", blastRadius: "single", hardGate: false, source: "mcp" });
    }
    return workActionDescriptorSchema.parse({ ...common, effect: "external_write", operation: `${server}:${tool}`,
      provider: server, target, environment: "unknown", reversibility: "unknown", blastRadius: "external",
      hardGate: false, source: "mcp", tags: ["external-side-effect"] });
  }

  if (name === "bash" || name === "run_command") {
    const command = str(args.command) ?? str(args.cmd) ?? str(args.input) ?? "";
    return command ? classifyShell(command, context) : conservativeDescriptor("缺少命令内容，按未分类动作处理");
  }
  if (name === "terminal_exec") {
    const action = str(args.action)?.toLowerCase();
    const command = str(args.command) ?? str(args.cmd) ?? str(args.input);
    if (!command && action && ["list", "read"].includes(action)) {
      return workActionDescriptorSchema.parse({ ...common, effect: "read", operation: "inspect", environment: "local",
        reversibility: "reversible", blastRadius: "single", hardGate: false, source: "builtin" });
    }
    return command ? classifyShell(command, context) : conservativeDescriptor("终端动作没有结构化命令，按未分类处理");
  }
  if (name === "write" || name === "edit" || name === "apply_patch" || name === "create_file") {
    return workActionDescriptorSchema.parse({ ...common, effect: "local_write", operation: "write_file",
      target: str(args.path) ?? str(args.file_path), environment: "local", reversibility: "recoverable",
      blastRadius: "single", hardGate: false, source: "builtin" });
  }
  if (name === "conversation_goal_update" && progressArguments.safeParse(args).success) {
    return workActionDescriptorSchema.parse({ ...common, effect: "work_progress", operation: "report_work_progress",
      target: str(args.workId), environment: "local", reversibility: "recoverable", blastRadius: "single",
      hardGate: false, source: "builtin" });
  }
  // Exact built-in registration in conversation-runtime-extension.ts only reads
  // current-task goal/version state. Do not infer safety from a *_get suffix:
  // goal create/update/close and unregistered/MCP names keep their own policy.
  if (name === "conversation_goal_get") {
    return workActionDescriptorSchema.parse({ ...common, effect: "read", operation: "inspect_work_goal",
      target: str(args.workId), environment: "local", reversibility: "reversible", blastRadius: "single",
      hardGate: false, source: "builtin" });
  }
  if (["read", "ls", "glob", "grep", "search", "web_search", "fetch_content", "get_search_content", "source_check"].includes(name)) {
    return workActionDescriptorSchema.parse({ ...common, effect: "read", operation: name === "read" ? "read_file" : "inspect",
      target: str(args.path), environment: "local", reversibility: "reversible", blastRadius: "single",
      hardGate: false, source: "builtin" });
  }
  if (name.startsWith("computer_") || name === "ui_exec" || name === "browser_exec") {
    const action = str(args.action) ?? str(args.operation);
    // 纯检查类动作是读取，不是物理输入；其余一律按物理输入处理（需要主人决定）。
    if (action && ["status", "read", "list", "screenshot", "describe", "inspect"].includes(action.toLowerCase())) {
      return workActionDescriptorSchema.parse({ ...common, effect: "read", operation: "inspect", environment: "local",
        reversibility: "reversible", blastRadius: "single", hardGate: false, source: "physical" });
    }
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

/** 命中 MCP 原生工具名时给出可信的服务/工具身份，不依赖模型自报字段。 */
export function mcpIdentityOf(toolName: string): { providerId: string; server: string; tool: string } | undefined {
  const match = /^mcp__([a-zA-Z0-9_]+)__([a-zA-Z0-9_]+)$/.exec(toolName.trim());
  return match ? { providerId: match[1]!, server: match[1]!, tool: match[2]! } : undefined;
}

function insideWorkspace(root: string, candidate: string): boolean {
  const rootAbs = resolve(root);
  const absolute = resolve(rootAbs, candidate);
  if (!contained(rootAbs, absolute)) return false;
  // 词法通过不等于真实位置通过：工作区内的符号链接不能把写入带出根目录。
  const realRoot = canonical(rootAbs);
  const realTarget = canonicalDeepest(absolute);
  return realRoot !== undefined && realTarget !== undefined && contained(realRoot, realTarget);
}

const contained = (rootAbs: string, absolute: string): boolean => {
  const rel = relative(rootAbs, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const canonical = (path: string): string | undefined => {
  try { return realpathSync(path); } catch { return undefined; }
};

/** 目标文件可能还不存在：解析到最近一个存在的祖先，再拼回剩余路径。 */
function canonicalDeepest(path: string): string | undefined {
  let current = path;
  for (;;) {
    const real = canonical(current);
    if (real !== undefined) {
      const suffix = relative(current, path);
      return suffix ? resolve(real, suffix) : real;
    }
    try { lstatSync(current); return undefined; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * 只有能证明“写入目标落在已授权工作区根内”的本地写才允许按范围自主执行。
 * 结构化文件工具用真实 path 参数；shell 必须是无变量/无通配/无引号/无越界路径的受支持语法。
 * 证明不了就返回 false，由策略要求主人决定，而不是猜测。
 */
export function targetsInsideWorkspace(taskRoot: string | undefined, toolName: string, args: unknown): boolean {
  if (!taskRoot) return false;
  const record = asRecord(args);
  const name = toolName.trim();
  const path = str(record.path) ?? str(record.file_path) ?? str(record.filePath);
  if (name === "write" || name === "edit" || name === "create_file") return !!path && insideWorkspace(taskRoot, path);
  if (name !== "bash" && name !== "run_command" && name !== "terminal_exec") return false;
  const command = str(record.command) ?? str(record.cmd) ?? str(record.input);
  if (!command) return false;
  const parts = literalShell(command);
  if (!parts) return false;
  return parts.every(part => {
    const [name, ...args] = part.words;
    if (part.words.some(word => word.includes("$?")) && name !== "echo") return false;
    if (part.redirect) {
      // Only literal output generators: no executable payload, extra writes or descriptor duplication.
      if (part.redirect.path.includes("$")) return false;
      if (name !== "echo" && name !== "printf") return false;
      if (name === "printf" && (args[0]?.startsWith("-") || args[0]?.includes("%n"))) return false;
      return insideWorkspace(taskRoot, part.redirect.path);
    }
    if (name === "mkdir" || name === "touch") {
      const paths: string[] = []; let operands = false;
      for (const arg of args) {
        if (!operands && arg === "--") { operands = true; continue; }
        if (!operands && arg.startsWith("-")) {
          if (name !== "mkdir" || !["-p", "--parents"].includes(arg)) return false;
        } else paths.push(arg);
      }
      return paths.length > 0 && paths.every(path => insideWorkspace(taskRoot, path));
    }
    // Reads may accompany writes, but every path-like operand must remain inside the grant.
    return readWords(part.words) && args.every(arg => !arg.includes("/") || insideWorkspace(taskRoot, arg));
  });
}
