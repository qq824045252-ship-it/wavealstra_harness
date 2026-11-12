import type { WorkExecutionBindingDto } from "../../../shared/bot-work";

const interactiveLifecycleTools = new Set([
  "conversation_goal_create", "conversation_goal_update", "conversation_goal_propose_complete",
]);

/** Runtime preparation precedes binding. Re-read at each tool permission phase. */
export function workExecutionToolAllowed(name: string, binding: () => WorkExecutionBindingDto | undefined): boolean {
  return !interactiveLifecycleTools.has(name) || binding() === undefined;
}
