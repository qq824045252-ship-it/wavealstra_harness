/**
 * ArtifactRefreshCoordinator — V3.5 Wave 2（§67-72）
 *
 * 不重造第二套 workspace diff：直接消费现有 AgentService.emitChangedArtifacts
 * 的产物（升级为统一 WorkspaceChangedEvent，§67/§68）。
 *
 * 正式链（§68）：
 *   AgentService.emitChangedArtifacts
 *     → WorkspaceChangedEvent { taskId, cwd, changedFiles }
 *     → ArtifactRefreshCoordinator.onWorkspaceChanged
 *     → ArtifactService.markFilesChanged
 *     → Repository version++（transaction，重启后正确）
 *     → Registry invalidation/update
 *     → artifact:updated（ArtifactUpdatedEvent）
 *
 * Renderer refresh policy（§71）：各 Renderer 自行决定（reload text / version URL / …）。
 * 不采用 pendingCaptureReload（原 pendingDesignReload）作为最终架构（§72）：Capture request（原 Design request）只是 Artifact 修改的一种来源。
 */
import type { ArtifactUpdatedEvent, WorkspaceChangedEvent } from "../../shared/artifact-types";
import { ArtifactService } from "./ArtifactService";

export class ArtifactRefreshCoordinator {
  constructor(private readonly service: ArtifactService) {}

  /** Refresh 输入（§68 契约）；返回 artifact:updated 列表 */
  async onWorkspaceChanged(event: WorkspaceChangedEvent): Promise<ArtifactUpdatedEvent[]> {
    if (!event.taskId || !Array.isArray(event.changedFiles)) return [];
    return this.service.markFilesChanged(event);
  }
}
