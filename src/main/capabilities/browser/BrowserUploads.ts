import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AutomationScope } from "../AutomationScope";
import type { BrowserDocumentContext } from "./BrowserDocumentContext";
import type { BrowserAccessibility } from "./BrowserAccessibility";

export interface BrowserUploadFile { path: string; name: string; size: number; }
export interface BrowserUploadResult { files: Array<{ name: string; size: number }>; }

/** taskRoot is a trusted host-provided capability, never accepted from page/tool input. */
export async function uploadBrowserFiles(args: {
  accessibility: BrowserAccessibility; context: BrowserDocumentContext; selector: string;
  taskRoot: string; paths: readonly string[]; scope: AutomationScope;
}): Promise<BrowserUploadResult> {
  if (!args.selector || args.selector.length > 2000) throw new Error("Invalid upload target");
  const files = await validateBrowserUploadFiles(args);
  return args.accessibility.setFiles(args.context, args.selector, files, args.scope);
}

export async function validateBrowserUploadFiles(args: {
  context: BrowserDocumentContext; taskRoot: string; paths: readonly string[]; scope: AutomationScope;
}): Promise<BrowserUploadFile[]> {
  const { scope, context } = args;
  scope.check(); context.validate();
  if (!args.taskRoot || !Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 20 || args.paths.some(path => typeof path !== "string" || !path || path.length > 4000 || path.includes("\0"))) throw new Error("Invalid upload request");
  const root = await scope.run(() => realpath(resolve(args.taskRoot)));
  const rootInfo = await scope.run(() => stat(root));
  if (!rootInfo.isDirectory()) throw new Error("Upload root is not a directory");
  const files: BrowserUploadFile[] = [];
  for (const requested of args.paths) {
    const candidate = await scope.run(() => realpath(resolve(root, requested)));
    const remainder = relative(root, candidate);
    if (!remainder || remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw new Error("Upload file is outside the task root");
    const info = await scope.run(() => stat(candidate));
    if (!info.isFile() || !Number.isSafeInteger(info.size)) throw new Error("Upload requires regular files");
    files.push({ path: candidate, name: basename(candidate), size: info.size });
    scope.check(); context.validate();
  }
  return files;
}
