export const NativeHooksIpc = {
  list: "native-hooks:list",
  publish: "native-hooks:publish",
  activate: "native-hooks:activate",
  receipts: "native-hooks:receipts",
} as const;

export const hookEvents = ["beforeRequest", "beforeTool", "afterTool", "beforeFinish"] as const;
export type NativeHookEvent = typeof hookEvents[number];
export const hookEventLabels: Record<NativeHookEvent, string> = {
  beforeRequest: "模型请求前", beforeTool: "工具执行前", afterTool: "工具返回后", beforeFinish: "提交答复前",
};
export type HookActor = "main" | "subagent";
export interface HookDraft {
  title: string;
  event: NativeHookEvent;
  actor: HookActor | "all";
  scope: { kind: "global" } | { kind: "task" | "workspace" | "project"; id: string };
  tool: string;
  script: string;
  cases: { input: Record<string, unknown>; expected: true | string }[];
}
export interface HookVersion { id: string; revision: number }
export interface PublishedHook extends HookVersion {
  draft: HookDraft;
  hash: string;
  enabled: boolean;
  /** Optimistic concurrency token, also changes on disable and rollback. */
  generation: number;
  versions: number[];
}
export interface NativeHookReceipt extends HookVersion {
  event: NativeHookEvent; taskId: string; conversationId: string; nativeTaskId: number;
  actor: HookActor; tool: string; callId: string; at: number;
  outcome: "pass" | "feedback" | "error"; message: string;
}
export interface NativeHooksApi {
  list(): Promise<PublishedHook[]>;
  publish(draft: HookDraft, base?: { id: string; generation: number }): Promise<PublishedHook>;
  activate(id: string, generation: number, revision: number, enabled: boolean): Promise<PublishedHook>;
  receipts(id: string): Promise<NativeHookReceipt[]>;
}

export function exampleHook(): HookDraft {
  const message = "请补上非空的文件内容，再调用 write。";
  return { title: "写入前检查空文件", event: "beforeTool", tool: "write", actor: "all", scope: { kind: "global" },
    script: `return event.args.content?.trim() ? true : "${message}";`,
    cases: [
      { input: { args: { path: "report.md", content: "" } }, expected: message },
      { input: { args: { path: "notes.txt", content: "  " } }, expected: message },
      { input: { args: { path: "report.md", content: "正文" } }, expected: true },
    ] };
}
