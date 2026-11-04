import {
  joinWorkspaceAbs,
  normalizeComparePath,
  toWorkspaceRelative,
} from "../../../lib/workspace";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { findDescriptorByIdAnyTask } from "../selectors";

export function createArtifactLifecycleActions(
  storeContext: AppContext,
): Pick<AppActions, "removeArtifact" | "removeArtifactsForWorkspacePath"> {
  const { get, set } = storeContext;
  return {
    removeArtifact: async (id, opts) => {
      const descriptor = findDescriptorByIdAnyTask(get(), id);
      const trashFile = opts?.trashFile !== false;
      const api = storeContext.getApi();
      if (trashFile && descriptor?.source.type === "workspace-file") {
        const root = descriptor.source.rootDir;
        const entry = descriptor.source.entryFile;
        const rel = toWorkspaceRelative(root, entry);
        if (rel && api?.trashWorkspacePath) {
          const result = await api.trashWorkspacePath(root, rel);
          if (!result.ok) {
            console.error("[removeArtifact] trash failed:", result.error);
            return false;
          }
        }
      }
      try {
        const result = await storeContext
          .getApi()
          ?.artifactDomain?.remove?.({ artifactId: id });
        if (!result?.ok) {
          // 文件已删但登记不存在：仍关掉 tab
          get().closeArtifactTab(id);
          return Boolean(result?.ok);
        }
        return true;
      } catch (err) {
        console.error("[removeArtifact] failed:", err);
        return false;
      }
    },

    removeArtifactsForWorkspacePath: async (root, relativePath) => {
      const prefix = normalizeComparePath(joinWorkspaceAbs(root, relativePath));
      const matches: string[] = [];
      for (const descriptors of Object.values(
        get().artifactProjection.artifactsByTask,
      )) {
        for (const d of descriptors) {
          if (d.source.type !== "workspace-file") continue;
          const entry = normalizeComparePath(d.source.entryFile);
          if (entry === prefix || entry.startsWith(`${prefix}/`))
            matches.push(d.id);
        }
      }
      for (const id of matches) {
        try {
          await storeContext
            .getApi()
            ?.artifactDomain?.remove?.({ artifactId: id });
        } catch (err) {
          console.warn("[removeArtifactsForWorkspacePath] skip", id, err);
        }
      }
    },
  };
}
