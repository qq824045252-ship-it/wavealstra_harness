import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../../shared/agent-ipc";

export interface PermissionBridge {
  /** Legacy mode callback retained for extension compatibility. */
  getPermissionMode: () => PermissionMode;
  /** Legacy callback; the retired extension does not invoke it. */
  requestApproval: (info: {
    toolCallId: string;
    toolName: string;
    summary: string;
    detail?: string;
    dangerous: boolean;
  }) => Promise<boolean>;
}

/** Compatibility factory: application tool approval has been retired. */
export function createPermissionExtension(_bridge: PermissionBridge): ExtensionFactory {
  return (_pi: ExtensionAPI) => {};
}
