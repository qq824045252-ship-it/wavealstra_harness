import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvedPathKey } from "../platform/paths";

export function isChatAttachment(context: ExtensionContext, requested: string): boolean {
  const key = resolvedPathKey(requested);
  return context.sessionManager.getBranch().some(entry => {
    if (entry.type !== "custom" || entry.customType !== "user") return false;
    const data = entry.data as { mybuddyInput?: { attachments?: unknown } } | undefined;
    const attachments = data?.mybuddyInput?.attachments;
    return Array.isArray(attachments) && attachments.some(item =>
      item && typeof item.path === "string" && isAbsolute(item.path) && resolvedPathKey(item.path) === key);
  });
}
