/**
 * Compile-time Subagent capability.
 *
 * Product-owned implementation: statically bundled into Main and registered
 * through the MyBuddy capability composition root. It is never discovered from
 * ~/.mybuddy/plugins/extensions and cannot be replaced by executable disk extensions.
 */
import { durableSubagentIpcBackend } from "../agent/durable/DurableSubagents";
import { setSubagentIpcBackend } from "../agent/subagent-ipc-host";

export function installBuiltinSubagentIpc(): void {
  setSubagentIpcBackend(durableSubagentIpcBackend);
}
