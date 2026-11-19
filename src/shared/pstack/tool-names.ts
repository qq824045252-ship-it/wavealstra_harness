const foregroundTools = new Set(["pstack_workflow", "pstack_delegate", "pstack_orchestrate", "pstack_worktrees", "pstack_watch_pr", "pstack_decision_append", "pstack_eval_save"]);
export const isPstackForegroundTool = (name: string) => foregroundTools.has(name);
