import type { ToolRegistration } from "@earendil-works/pi-durable";

export const SHELL_TERMINAL_GUIDANCE = "This tool runs non-interactively with piped streams, not a PTY. First inspect partial effects and the target CLI's help for explicit non-interactive options that express the user's intended choices. Launcher options are separate: npx -y accepts npm's package confirmation; it does not pass --yes to the target CLI. Preserve the authorized install scope and target; never add --global/-g, all agents or all skills merely to suppress a prompt. Only when the target CLI still needs interactive input, use terminal_exec when available: open, input the command with \\r, read the screen, then input responses and close. Do not infer that the machine lacks a terminal from a non-TTY error. Never blindly replay a possibly mutating command.";

const SKILLS_NONINTERACTIVE_GUIDANCE = "For SKILLS_PROMPT_REQUIRES_TTY, check the skills CLI's own --yes/-y and explicit --agent/--skill choices. Put target CLI options after the skills command, not only before it as npx options. Select project or global installation only from the user's intended scope; --global/-g is not a generic TTY fix. This advice does not change or rerun the failed command.";
const BASH_VERIFICATION_GUIDANCE = 'Leave a test as the final command so Bash returns its status. For filtered output, enable `set -o pipefail`. To print the status of any test or test pipeline, save it immediately with `status=$?` and finish with `exit "$status"`. A trailing `echo` alone hides a failing test. Isolate a failing case before rerunning the suite. If a check returns blocked_same_failure, read its existing report and investigate or report the failure. Only recheck after a relevant change or an explicit user request. If a test writes a report before the launcher exits, read the assertion and cleanup results separately.';
const VERIFICATION_OUTCOME_GUIDANCE = 'For a structured verification summary, use one overall outcome from each invocation receipt (for example, the outcome in VERIFICATION_RESULT), in execution order. Use individual stage statuses to explain the cause. For a reused check, its current receipt records the reuse and the saved report describes the original execution. Read back any result file and verify its values against the receipts.';

const requiresTerminal = /SKILLS_PROMPT_REQUIRES_TTY|(?:stdin|input|standard input|device) (?:is |isn't |is not |not )+(?:a )?(?:tty|terminal)|(?:requires?|must have|needs?) (?:an? )?(?:interactive )?(?:tty|terminal)|not a tty/i;

/** Add recovery advice, never rerun a command or replace its original outcome. */
export function withShellTerminalGuidance(tool: ToolRegistration): ToolRegistration {
  if (tool.name !== "bash" && tool.name !== "powershell") return tool;
  const shellDescription = `${tool.description}\n${SHELL_TERMINAL_GUIDANCE}\n${VERIFICATION_OUTCOME_GUIDANCE}`;
  const description = tool.name === "bash" ? `${shellDescription}\n${BASH_VERIFICATION_GUIDANCE}` : shellDescription;
  return { ...tool, description,
    execute: async (args, api, context) => {
      const result = await tool.execute(args, api, context);
      const structured = result.structuredOutput;
      const text = [result.output?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "",
        structured && typeof structured === "object" && "output" in structured && typeof structured.output === "string" ? structured.output : ""].join("\n");
      // Some wrappers print a child's failure while themselves exiting zero.
      if (!requiresTerminal.test(text)) return result;
      const advice = "[shell-terminal-recovery] This invocation reported a non-TTY/interactive-input requirement. It does not establish that the machine or MyBuddy has no PTY. " + SHELL_TERMINAL_GUIDANCE
        + (text.includes("SKILLS_PROMPT_REQUIRES_TTY") ? " " + SKILLS_NONINTERACTIVE_GUIDANCE : "");
      if (result.output) return { ...result, output: [...result.output, { type: "text" as const, text: advice }] };
      // Native shells stream their output through api.output, not result.output.
      api.output("\n" + advice);
      return result;
    },
  };
}
