import type { ArtifactDescriptor } from "../../../../../shared/artifact-types";
import { buildRegistration } from "../../../lib/artifactIngest";
import { fileUrlForAbsolutePath } from "../../../lib/browserLinks";
import { fileNameFromPath, parentDir } from "../../../lib/localFilePath";
import { adaptivePanelWidth } from "../../../lib/panelWidth";
import {
  inferArtifactKind,
  languageFromName,
  normalizeComparePath,
} from "../../../lib/workspace";
import type { AppActions } from "../actions";
import { guessCanvasArtifactName } from "../artifacts/artifactName";
import type { AppContext } from "../context";
import { getRenderHydration } from "../runtime/artifactRender";
import { findDescriptorByIdAnyTask } from "../selectors";
import { defaultFlyoutViewForArtifact } from "../workbench/panelPolicy";

export function createFileArtifactsActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "openLocalFile"
  | "openLocalFolder"
  | "openWorkspaceFile"
  | "openLocalAbsoluteFile"
  | "openWorkspaceFolder"
  | "ensureCanvasArtifact"
> {
  const { get, set } = storeContext;
  return {
    openLocalFile: async () => {
      const file = await storeContext.getApi()?.pickLocalFile?.();
      if (!file) return;

      const kind = file.kind;
      const language =
        file.language ??
        (kind === "code" ? languageFromName(file.name) : undefined);
      const taskId = get().activeTaskId;
      if (!taskId) return;
      const task = get().tasks.find((t) => t.id === taskId);
      const workspaceRoot =
        task?.cwd ?? get().spaces.find((sp) => sp.id === task?.spaceId)?.path;

      // 3C：Artifact create 唯一通道 = artifactDomain.register（不再直接写 task.artifacts）；
      // workspace root 内 → workspace-file；root 外 → managed-content copy（安全边界）
      let descriptor: ArtifactDescriptor | null = null;
      try {
        descriptor =
          (await storeContext.getApi()?.artifactDomain?.register(
            buildRegistration(taskId, {
              name: file.name,
              kind,
              content: file.content,
              language,
              path: file.path,
              workspaceRoot,
            }),
          )) ?? null;
      } catch (err) {
        console.error("[openLocalFile] register 失败:", err);
        return;
      }
      if (!descriptor) return;

      // 渲染缓存（内容快照，非真相；派生视图由此补 content；version 绑定 hotfix）
      get().cacheArtifactRender(descriptor.id, {
        name: file.name,
        kind,
        content: file.content,
        language,
        path: file.path,
        artifactVersion: descriptor.version,
      });

      const tabs = get().artifactTabs.includes(descriptor.id)
        ? get().artifactTabs
        : [...get().artifactTabs, descriptor.id];
      set({
        panelOpen: true,
        panelMode: "file",
        activeArtifactId: descriptor.id,
        artifactTabs: tabs,
        extensionView: defaultFlyoutViewForArtifact({ kind }),
        extensionFlyoutOpen: get().extensionFlyoutOpen,
        panelWidth: adaptivePanelWidth(kind, get().sidebarCollapsed),
      });
    },

    openLocalFolder: async () => {
      const folder = await storeContext.getApi()?.pickLocalFolder?.();
      if (!folder) return;
      const spaceId = await get().addSpaceFromPath(folder.path, folder.name);
      const taskId = get().activeTaskId;
      if (taskId) get().bindTaskSpace(taskId, spaceId);
    },

    openWorkspaceFile: async (relativePath, name) => {
      const state = get();
      const task = state.tasks.find((item) => item.id === state.activeTaskId);
      const root =
        task?.cwd ??
        state.spaces.find((space) => space.id === task?.spaceId)?.path;
      if (!root) return;
      const taskId = state.activeTaskId;
      if (!taskId) return;
      const file = await storeContext
        .getApi()
        ?.readWorkspaceFile(root, relativePath);
      if (!file) return;
      const kind = file.kind;
      const language =
        file.language ?? (kind === "code" ? languageFromName(name) : undefined);
      const normTarget = file.path.replace(/\\/g, "/").toLowerCase();

      // 3C：已注册（同 path）→ 复用 + 统一 hydration；否则 register（workspace-file，root=workspace root）
      const existing = state.artifactProjection.artifactsByTask[taskId]?.find(
        (d) =>
          d.source.type === "workspace-file" &&
          d.source.entryFile.replace(/\\/g, "/").toLowerCase() === normTarget,
      );
      let artifactId: string;
      if (existing) {
        artifactId = existing.id;
        // V3.5 hotfix：统一经 hydration 层 readContent（版本绑定 + single-flight + stale 防御）
        void getRenderHydration(storeContext).ensure(artifactId);
      } else {
        let descriptor: ArtifactDescriptor | null = null;
        try {
          descriptor =
            (await storeContext.getApi()?.artifactDomain?.register(
              buildRegistration(taskId, {
                name,
                kind,
                content: file.content,
                language,
                path: file.path,
                workspaceRoot: root,
              }),
            )) ?? null;
        } catch (err) {
          console.error("[openWorkspaceFile] register 失败:", err);
          return;
        }
        if (!descriptor) return;
        artifactId = descriptor.id;
        // 内容已在手（同流程读盘）→ 直接 version 绑定入缓存（hotfix §5.2）
        get().cacheArtifactRender(artifactId, {
          name,
          kind,
          content: file.content,
          language,
          path: file.path,
          artifactVersion: descriptor.version,
        });
      }

      // 有磁盘路径的 HTML：工作区双击同样走扩展栏浏览器，不进协议预览
      if (kind === "html" && file.path?.trim()) {
        const fileUrl = fileUrlForAbsolutePath(file.path.trim());
        get().setBrowserUrl(fileUrl);
        get().refreshBrowser();
        return;
      }

      const tabs = get().artifactTabs.includes(artifactId)
        ? get().artifactTabs
        : [...get().artifactTabs, artifactId];
      set({
        panelOpen: true,
        panelMode: "file",
        activeArtifactId: artifactId,
        artifactTabs: tabs,
        extensionView: "workspace",
        extensionFlyoutOpen: false,
        panelWidth: adaptivePanelWidth(kind, get().sidebarCollapsed),
      });
    },

    openLocalAbsoluteFile: async (absPath) => {
      const path = absPath.trim();
      if (!path) return;
      const taskId = get().activeTaskId;
      if (!taskId) return;
      const name = fileNameFromPath(path);
      const norm = normalizeComparePath(path);
      const existing = get().artifactProjection.artifactsByTask[taskId]?.find(
        (d) => {
          if (d.source.type === "workspace-file") {
            return normalizeComparePath(d.source.entryFile) === norm;
          }
          return (
            typeof d.capabilities?.diskPath === "string" &&
            normalizeComparePath(d.capabilities.diskPath) === norm
          );
        },
      );
      if (existing) {
        get().openArtifact(existing.id);
        return;
      }
      const parent = parentDir(path);
      let file: {
        name: string;
        kind: import("../../../types").ArtifactKind;
        content: string;
        language?: string;
        path: string;
      } | null = null;
      try {
        file =
          (await storeContext.getApi()?.readWorkspaceFile(parent, name)) ??
          null;
      } catch (err) {
        console.warn("[openLocalAbsoluteFile] read failed", path, err);
      }
      const kind = file?.kind ?? inferArtifactKind(name, file?.content ?? "");
      const language =
        file?.language ??
        (kind === "code" ? languageFromName(name) : undefined);
      const content = file?.content ?? "";
      const resolvedPath = file?.path || path;
      let descriptor: ArtifactDescriptor | null = null;
      try {
        descriptor =
          (await storeContext.getApi()?.artifactDomain?.register(
            buildRegistration(taskId, {
              name,
              kind,
              content: content || " ",
              language,
              path: resolvedPath,
              workspaceRoot: parent,
            }),
          )) ?? null;
      } catch (err) {
        console.error("[openLocalAbsoluteFile] register 失败:", err);
        return;
      }
      if (!descriptor) return;
      get().cacheArtifactRender(descriptor.id, {
        name,
        kind,
        content,
        language,
        path: resolvedPath,
        artifactVersion: descriptor.version,
      });
      // 有磁盘路径的 HTML：走扩展栏浏览器 file:// 直载（existing 分支已由 openArtifact 覆盖）
      if (kind === "html" && resolvedPath.trim()) {
        const fileUrl = fileUrlForAbsolutePath(resolvedPath.trim());
        get().setBrowserUrl(fileUrl);
        get().refreshBrowser();
        return;
      }
      const tabs = get().artifactTabs.includes(descriptor.id)
        ? get().artifactTabs
        : [...get().artifactTabs, descriptor.id];
      set({
        panelOpen: true,
        panelMode: "file",
        activeArtifactId: descriptor.id,
        artifactTabs: tabs,
        extensionView: defaultFlyoutViewForArtifact({ kind }),
        extensionFlyoutOpen: get().extensionFlyoutOpen,
        panelWidth: adaptivePanelWidth(kind, get().sidebarCollapsed),
      });
      if (!content) void getRenderHydration(storeContext).ensure(descriptor.id);
    },

    openWorkspaceFolder: async (relativePath?: string, taskId?: string) => {
      const state = get();
      const id = taskId ?? state.activeTaskId;
      if (!id) return;
      const task = state.tasks.find((item) => item.id === id);
      // cwd 优先；否则回落到所属空间 path（侧栏「打开文件夹」常用路径）
      const root =
        task?.cwd?.trim() ||
        state.spaces
          .find((space) => space.id === task?.spaceId)
          ?.path?.trim() ||
        "";
      if (!root) {
        console.warn("[openWorkspaceFolder] 任务无工作区路径", id);
        return;
      }
      const sep = root.includes("\\") ? "\\" : "/";
      const normalized = relativePath
        ?.replace(/[/\\]+/g, sep)
        .replace(new RegExp(`^${sep === "\\" ? "\\\\" : "/"}+`), "");
      const path = normalized
        ? `${root.replace(/[/\\]+$/, "")}${sep}${normalized}`
        : root;
      try {
        await storeContext.getApi()?.openFolder?.(path);
      } catch (err) {
        console.error("[openWorkspaceFolder] 打开失败:", path, err);
      }
    },

    ensureCanvasArtifact: async ({
      messageId,
      content,
      kind,
      preferredName,
      open = false,
    }) => {
      const taskId = get().activeTaskId;
      if (!taskId || !content.trim()) return null;
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return null;

      const ext = kind === "svg" ? "svg" : "html";
      const baseName = (
        preferredName?.trim() || guessCanvasArtifactName(content, kind)
      ).replace(/[\\/:*?"<>|]+/g, "_");
      const name = baseName.toLowerCase().endsWith(`.${ext}`)
        ? baseName
        : `${baseName}.${ext}`;

      // 同内容 + 同名 → 复用（幂等，旧语义保留）；否则注册
      const cache = get().artifactRenderCache;
      const existingId = Object.entries(cache).find(
        ([, p]) => p.name === name && p.content === content,
      )?.[0];
      let artifactId: string;
      if (existingId) {
        artifactId = existingId;
        // 幂等复用：校正 version 绑定（descriptor 已存在则与当前版本对齐）
        const existingDescriptor = findDescriptorByIdAnyTask(get(), artifactId);
        if (existingDescriptor) {
          const payload = get().artifactRenderCache[artifactId];
          if (payload) {
            get().cacheArtifactRender(artifactId, {
              ...payload,
              artifactVersion: existingDescriptor.version,
            });
          }
        }
      } else {
        // 3C：canvas 类产物 = managed-content html + capabilities（不新造 canvas kind）
        let descriptor: ArtifactDescriptor | null = null;
        try {
          descriptor =
            (await storeContext.getApi()?.artifactDomain?.register({
              taskId,
              kind: kind === "svg" ? "svg" : "html",
              title: name,
              capabilities: {
                executable: true,
                interactive: true,
                originalKind: kind,
              },
              content,
            })) ?? null;
        } catch (err) {
          console.error("[ensureCanvasArtifact] register 失败:", err);
          return null;
        }
        if (!descriptor) return null;
        artifactId = descriptor.id;
        get().cacheArtifactRender(artifactId, {
          name,
          kind,
          content,
          language: kind,
          artifactVersion: descriptor.version,
        });
      }

      // message 关联（不再写 task.artifacts；派生视图由 created 事件驱动）
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === messageId
                    ? {
                        ...m,
                        artifactIds: [
                          ...new Set([...(m.artifactIds ?? []), artifactId]),
                        ],
                      }
                    : m,
                ),
                updatedAt: Date.now(),
              }
            : t,
        ),
      }));
      if (!open) return artifactId;
      const tabs = get().artifactTabs.includes(artifactId)
        ? get().artifactTabs
        : [...get().artifactTabs, artifactId];
      set({
        panelOpen: true,
        panelMode: "file",
        activeArtifactId: artifactId,
        artifactTabs: tabs,
        extensionView: "overview",
        extensionFlyoutOpen: false,
        panelWidth: adaptivePanelWidth(kind, get().sidebarCollapsed),
      });
      return artifactId;
    },
  };
}
