import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentService } from "../src/main/agent/AgentService";
import type { DurableDomainTools } from "../src/main/agent/durable/DurableDomainTools";

// Keep ordinary file tools and explicit shell paths inside this comparison's
// profile. A shell path check is a diagnostic guard, not an OS sandbox.
export function restrictLivePaths(agent: AgentService, root: string, cwd: string, realHome: string) {
  const posix = (path: string) => path.replaceAll("\\", "/").toLowerCase();
  const unix = (path: string) => path.replace(/^([a-z]):\//, "/$1/");
  const home = posix(realHome), inside = posix(root);
  const aliases = [inside, unix(inside), "/tmp/" + basename(inside)];
  const fileTools = new Set(["write", "edit", "read", "find", "grep", "ls"]);
  function sharedShellPath(args: Record<string, unknown>) {
    let command = posix(Object.values(args).filter(v => typeof v === "string").join(" "));
    // Match an actual path segment, so another task with a longer name never
    // inherits permission. Worktree siblings are under this same profile.
    for (const alias of aliases) {
      const literal = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      command = command.replace(new RegExp(literal + "(?=/|[\\s'\";)]|$)", "g"), "<case>");
    }
    return command.includes(home + "/") || command.includes(unix(home) + "/") ||
      /(?:^|[\s'"=<>|;&(])\/tmp(?:\/|[\s'")]|$)/.test(command);
  }
  type Factory = (...args: unknown[]) => Promise<DurableDomainTools>;
  const factory = Reflect.get(agent, "durableTaskTools") as Factory;
  Object.defineProperty(agent, "durableTaskTools", {value:async (...args: unknown[]) => {
    const domain = await factory.apply(agent,args), original = domain.toolHooks;
    domain.toolHooks = {...original, beforeTool: async (call, api, context) => {
      if (fileTools.has(call.name) && typeof call.arguments.path === "string") {
        const path = call.arguments.path, normalized = posix(path);
        const alias = aliases.find(a => normalized === a || normalized.startsWith(a + "/"));
        const target = alias ? resolve(root, normalized.slice(alias.length + 1)) : path.startsWith("~/") ? resolve(root, path.slice(2)) : resolve(cwd,path);
        const rel = relative(root,target);
        if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return {block:"Use the files in this disposable profile and workspace."};
      }
      if (["bash","powershell","terminal_exec"].includes(call.name) && sharedShellPath(call.arguments))
        return {block:"Use the isolated TMPDIR, task directory or this case's MyBuddy profile. Shared user directories are outside this comparison."};
      return original?.beforeTool?.(call,api,context);
    }};
    return domain;
  }});
}
