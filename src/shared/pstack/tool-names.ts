export const PSTACK_FOREGROUND_TOOLS = ["pstack_workflow", "pstack_delegate", "pstack_orchestrate", "pstack_worktrees", "pstack_watch_pr", "pstack_decision_append", "pstack_eval_save", "pstack_statechart", "pstack_video_inspect"] as const;
const foregroundTools = new Set<string>(PSTACK_FOREGROUND_TOOLS);
export const isPstackForegroundTool = (name: string) => foregroundTools.has(name);
