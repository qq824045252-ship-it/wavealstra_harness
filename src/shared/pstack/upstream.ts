/** The upstream contract audited for the native MyBuddy adaptation. */
export const PSTACK_UPSTREAM = {
  version: "0.15.48",
  commit: "9e278fe4d4ecd8bfe98b1b79bf4be662efb338cc",
  repository: "https://github.com/cursor/plugins",
  directory: "pstack",
} as const;

export const PSTACK_UPSTREAM_COMMANDS = [
  "architect", "arena", "automate-me", "benchmark-checklist", "blast-radius", "bro", "correct",
  "create-formal-verification-skill", "create-verification-skill", "figure-it-out", "how",
  "in-your-own-words", "interrogate", "ketchup", "ketchup-video", "maintain-formal-verification-skill",
  "maintain-verification-skill", "make-bot-ui", "no-comments", "poteto-help", "poteto-mode", "recall",
  "reframe", "reflect", "setup-pstack", "sharpen", "show-me-your-work", "statechart", "swarm", "tdd",
  "teach", "technical-writing", "typescript-best-practices", "unslop", "why",
] as const;

export const PSTACK_UPSTREAM_PLAYBOOKS = [
  "authoring-a-skill", "autonomous-run", "autopilot-full", "autopilot-stack", "babysit", "bug-fix",
  "eval", "feature", "hillclimb", "investigation", "multi-phase-plan", "opening-a-pr", "pause-safely",
  "perf-issue", "prototype", "refactoring", "runtime-forensics", "session-pickup", "shipping",
  "trace-forensics", "visual-parity", "worktree-cleanup",
] as const;

/** Native persisted orchestration remains available independently of upstream routing. */
export const PSTACK_EXTENSION_PLAYBOOKS = ["orchestrate"] as const;

/** These methods can finish from the user's supplied text without a workspace observation. */
export const PSTACK_TEXT_ONLY_METHODS: readonly string[] = ["in-your-own-words", "sharpen"];

/** Read-only routes do not grant extra tools or permission to change the workspace. */
export const PSTACK_READ_ONLY_METHODS: readonly string[] = [
  ...PSTACK_TEXT_ONLY_METHODS, "reframe", "ketchup", "how", "why", "teach", "recall", "poteto-help", "bro", "interrogate",
];
