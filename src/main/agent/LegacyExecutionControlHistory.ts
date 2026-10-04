import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Exact migration of retired host directives, not a general conversation filter.
 * Pi's append-only session history is untouched. Real user/tool messages are preserved.
 */
export function projectLegacyExecutionControlHistory(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const projected: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role !== "custom") { projected.push(message); continue; }
    if (message.customType === "mybuddy_completion_gate" || message.customType === "mybuddy_completion_gate_blocked") {
      changed = true;
      continue;
    }
    if (message.customType === "mybuddy_request_user_input_recovery") {
      changed = true;
      // This old synthetic message may be the only record of a real user answer.
      // Preserve that answer as evidence, but discard its automatic continuation instructions.
      const details = message.details as { answer?: unknown; request?: unknown } | undefined;
      if (details && Object.prototype.hasOwnProperty.call(details, "answer")) {
        projected.push({ ...message, customType: "mybuddy.legacy-user-answer",
          content: `历史交互的用户回答（仅作记录）：${JSON.stringify(details.answer)}` });
      }
      continue;
    }
    projected.push(message);
  }
  return changed ? projected : messages;
}
