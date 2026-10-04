/**
 * Compile-time Subagent capability.
 *
 * Product-owned implementation: statically bundled into Main and registered
 * through the MyBuddy capability composition root. It is never discovered from
 * ~/.mybuddy/plugins/extensions and cannot be replaced by executable disk extensions.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import subagentFactory, { installHostIpc } from "./subagent/index";

export function createBuiltinSubagentExtension(): ExtensionFactory {
  return subagentFactory as ExtensionFactory;
}

export function installBuiltinSubagentIpc(): void {
  installHostIpc();
}
