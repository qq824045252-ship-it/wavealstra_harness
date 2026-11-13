import type { ToolRegistration } from "@earendil-works/pi-durable";

export const SHELL_TERMINAL_GUIDANCE = "This tool runs non-interactively with piped streams, not a PTY. First inspect partial effects and the target CLI's help for explicit non-interactive options that express the user's intended choices. Launcher options are separate: npx -y accepts npm's package confirmation; it does not pass --yes to the target CLI. Preserve the authorized install scope and target; never add --global/-g, all agents or all skills merely to suppress a prompt. Only when the target CLI still needs interactive input, use terminal_exec when available: open, input the command with \\r, read the screen, then input responses and close. Do not infer that the machine lacks a terminal from a non-TTY error. Never blindly replay a possibly mutating command.";

const SKILLS_NONINTERACTIVE_GUIDANCE = "For SKILLS_PROMPT_REQUIRES_TTY, check the skills CLI's own --yes/-y and explicit --agent/--skill choices. Put target CLI options after the skills command, not only before it as npx options. Select project or global installation only from the user's intended scope; --global/-g is not a generic TTY fix. This advice does not change or rerun the failed command.";

const requiresTerminal = /SKILLS_PROMPT_REQUIRES_TTY|(?:stdin|input|standard input|device) (?:is |isn't |is not |not )+(?:a )?(?:tty|terminal)|(?:requires?|must have|needs?) (?:an? )?(?:interactive )?(?:tty|terminal)|not a tty/i;

/** Add recovery advice, never rerun a command or replace its original outcome. */
export function withShellTerminalGuidance(tool: ToolRegistration): ToolRegistration {
  if (tool.name !== "bash" && tool.name !== "powershell") return tool;
  return { ...tool, description: `${tool.description}\n${SHELL_TERMINAL_GUIDANCE}`,
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
