import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { durableWorktreeAllocation, prepareSubagentWorkspace, repositoryAllowsGitIsolation } from "../capabilities/subagent/worktree";
import type { AppDatabase } from "../db/AppDatabase";
import { getMyBuddyDir } from "../paths";
import { isPathInsideOrEqual, normalizePathForComparison } from "./TaskExecutionWorkspace";
import type { PrepareTaskWorktreeRequest } from "../../shared/agent-ipc";
import { isTaskWorktreeId } from "../../shared/task-worktree";

function worktreeBase(): string {
  return join(getMyBuddyDir(), "task-worktrees");
}

/** The receipt is written by the Git provisioner. Renderer input never supplies a cwd. */
export function resolveTaskWorktreeCwd(taskId: string): string {
  try {
    const allocation = durableWorktreeAllocation(realpathSync(worktreeBase()), taskId);
    const root = join(allocation, "worktree");
    const receiptPath = join(allocation, "receipt.json");
    const receipt: { state?: unknown; root?: unknown; cwd?: unknown } = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.state !== "ready" || receipt.root !== root || typeof receipt.cwd !== "string"
      || !isPathInsideOrEqual(root, receipt.cwd)
      || normalizePathForComparison(realpathSync(root)) !== normalizePathForComparison(root)
      || normalizePathForComparison(realpathSync(receipt.cwd)) !== normalizePathForComparison(receipt.cwd)
      || !lstatSync(join(root, ".git")).isFile() || !statSync(receipt.cwd).isDirectory()) {
      throw new Error(`工作树记录或目录无效：${receiptPath}`);
    }
    return receipt.cwd;
  } catch (error) {
    throw new Error("此对话的 Git 工作树已不可用，请检查工作树目录。", { cause: error });
  }
}

const preparing = new Set<string>();

export async function prepareTaskGitWorktree(db: AppDatabase, { taskId, spaceId }: PrepareTaskWorktreeRequest): Promise<void> {
  if (!isTaskWorktreeId(taskId) || typeof spaceId !== "string" || !spaceId) {
    throw new Error("新任务工作树参数无效");
  }
  if (db.getTask(taskId) || preparing.has(taskId)) throw new Error("只能为尚未发送的新对话创建工作树");
  if (db.isSpaceEffectiveArchived(spaceId)) throw new Error("请选择未归档的 Git 工作空间");
  const cwd = db.resolveWorkspaceExecutionPath(spaceId, { requireExisting: true });
  if (!cwd) throw new Error("请选择绑定 Git 仓库的工作空间");
  preparing.add(taskId);
  try {
    if (!await repositoryAllowsGitIsolation(cwd)) throw new Error("仓库规则禁止创建 Git 工作树");
    await prepareSubagentWorkspace({
      cwd, isolation: "worktree", parallel: false, writable: true, branchNamespace: "task",
      baseDir: worktreeBase(), operationId: taskId,
      authorizeGitIsolation: () => !db.getTask(taskId) && !db.isSpaceEffectiveArchived(spaceId)
        && db.resolveWorkspaceExecutionPath(spaceId, { requireExisting: true }) === cwd,
    });
  } catch (error) {
    if (error instanceof Error && /requires a clean repository|Repository became dirty/.test(error.message)) {
      throw new Error("Git 仓库有未提交的更改。请先提交或暂存更改，再发送消息。", { cause: error });
    }
    if (error instanceof Error && error.message.includes("requires a Git working tree")) {
      throw new Error("所选工作空间不在 Git 仓库中。", { cause: error });
    }
    throw error;
  } finally {
    preparing.delete(taskId);
  }
}
