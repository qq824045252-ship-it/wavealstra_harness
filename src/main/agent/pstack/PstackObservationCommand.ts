import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalPathKey } from "../../platform/paths";

// For these playbooks the observed output is the deliverable. A prototype
// or capture reader does not need to masquerade as a test suite.
export async function isPstackObservation(playbook: string, command: string, cwd: string) {
  if (!["prototype", "runtime-forensics", "trace-forensics"].includes(playbook)) return false;
  const match = /^(node|bun|python3?|py)\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))((?:\s+[\w./-]+)*)$/.exec(command);
  if (!match) return false;
  const file = match[2] ?? match[3] ?? match[4];
  if (!/^[\p{L}\p{N}_ .\\/-]+\.(?:[cm]?js|py)$/u.test(file) || file.startsWith("-") || isAbsolute(file)) return false;
  if (/(?:^|\s)(?:-h|--help|--version)(?:\s|$)/.test(match[5])) return false;
  const target = resolve(cwd, file), subpath = relative(cwd, target);
  if (!subpath || subpath === ".." || subpath.startsWith(".." + sep) || isAbsolute(subpath)) return false;
  try {
    return (await lstat(target)).isFile() && canonicalPathKey(await realpath(target)) === canonicalPathKey(target);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
