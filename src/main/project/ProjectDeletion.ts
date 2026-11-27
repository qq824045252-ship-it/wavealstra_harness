import { randomUUID } from "node:crypto";
import type { CronService } from "../cron/CronService";
import type { AppDatabase } from "../db/AppDatabase";
import type { LibraryService } from "../library/LibraryService";
import { memoryWithdrawalTargets } from "../memory/MemoryForgetWatermarks";
import { RuntimeAuditUnknownOperationError, type RuntimeAuditReader } from "../platform/runtime-audit";
import type { ProjectDeletion } from "./ProjectMutation";
import type { ProjectService } from "./ProjectService";

async function deleteInRust(db: AppDatabase, runtime: RuntimeAuditReader, id: string, root: string): Promise<ProjectDeletion> {
  const operationId = randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await runtime.readProjectWithdrawal(id);
    if (!snapshot) throw new Error("项目记忆读取失败，请重试");
    const withdrawal = {
      signature: snapshot.signature, cutoffAt: Date.now(), targets: memoryWithdrawalTargets(snapshot.records),
    };
    const remove = () => runtime.deleteProject(operationId, id, root, withdrawal);
    const result = await remove().catch(error => {
      if (runtime.supervised && error instanceof RuntimeAuditUnknownOperationError) return remove();
      const receipt = db.fixtureConnection?.prepare("SELECT result_json FROM project_delete_receipts WHERE operation_id=?")
        .pluck().get(operationId) as string | undefined;
      if (!receipt) throw error;
      return JSON.parse(receipt) as ProjectDeletion;
    });
    if (result.status === "deleted") return result;
    if (result.status === "libraryScopeChanged") throw new Error("项目资料归属有冲突，无法安全删除");
  }
  throw new Error("项目记忆仍在变化，请稍后重试删除");
}

export function deleteProjectWithLifecycle(
  id: string,
  { db, projects, library, cron, cancelCadence }: {
    db: AppDatabase;
    projects: ProjectService;
    library: LibraryService;
    cron: Pick<CronService, "withPlanMaintenance" | "removeProjectData" | "publishRemovedProjectJobs">;
    cancelCadence: (id: string) => void;
  },
): Promise<void> {
  return cron.withPlanMaintenance(async () => {
    const { jobIds } = await library.withProjectLibraryDeletion(async root => {
      const runtime = db.runtimeAuditReader;
      if (runtime && await runtime.supportsProjectWrites("deletion")) return deleteInRust(db, runtime, id, root);
      if (!db.fixtureConnection) throw new Error("Core 项目删除服务尚未初始化");
      const jobIds = library.withHostProjectDeletion(id, () => {
        const removed = cron.removeProjectData(id);
        projects.delete(id);
        return removed;
      });
      return { itemIds: [], jobIds };
    });
    cancelCadence(id);
    cron.publishRemovedProjectJobs(jobIds);
  });
}
