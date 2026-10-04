/** A configured execution location is unavailable. Never retry by creating it. */
export class WorkspacePathError extends Error {
  readonly recovery = "requires-user-action" as const;
  readonly phase = "prepare" as const;
  readonly sideEffects = "none" as const;
  constructor(readonly spaceId: string, readonly path: string | undefined, readonly causeCode: "workspace-path-missing" | "workspace-path-invalid" | "workspace-binding-missing" | "workspace-binding-cycle") {
    super(`工作文件夹不可用${path ? `：${path}` : ""}。请恢复原目录，或在所属项目「资料」或文件夹设置中重新关联位置后重试。执行尚未开始。`);
    this.name = "WorkspacePathError";
  }
}
