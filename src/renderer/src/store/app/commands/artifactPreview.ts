import { fileUrlForAbsolutePath } from "../../../lib/browserLinks";
import { PANEL_RAIL_WIDTH, adaptivePanelWidth } from "../../../lib/panelWidth";
import { inferArtifactKind } from "../../../lib/workspace";
import { cadCraftExtension } from "../../../../../shared/cadcraft";
import { DOTS_TASK_ID } from "../../../../../shared/dots";
import type { ArtifactKind } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { getRenderHydration } from "../runtime/artifactRender";
import {
  findActiveTaskArtifact,
  findDescriptorByIdAnyTask,
} from "../selectors";
import { defaultFlyoutViewForArtifact } from "../workbench/panelPolicy";
import type { AppState } from "../types";

function openFileTab(state: AppState, id: string, kind: ArtifactKind | undefined, tabs = state.artifactTabs): Partial<AppState> {
  return {
    panelOpen: true,
    panelMode: "file",
    activeArtifactId: id,
    artifactTabs: tabs.includes(id) ? tabs : [...tabs, id],
    extensionView: state.extensionFlyoutOpen && kind ? defaultFlyoutViewForArtifact({ kind }) : state.extensionView,
    extensionMenuOpen: false,
    panelWidth: adaptivePanelWidth(kind, state.sidebarCollapsed),
  };
}

export function createArtifactPreviewActions(
  storeContext: AppContext,
): Pick<AppActions, "openArtifact" | "openSavedArtifact" | "closeArtifactTab"> {
  const { get, set } = storeContext;
  return {
    openSavedArtifact: (file, sourceTask) => {
      const state = get();
      if (state.activeTaskId !== DOTS_TASK_ID) return;
      const id = `saved:${JSON.stringify([sourceTask.taskId, file.snapshotPath, file.name, file.manifestPath])}`;
      const kind = cadCraftExtension(file.name) ? "cad" : inferArtifactKind(file.name, "");
      const tabs = state.artifactTabs.filter(tab => tab !== state.savedArtifactTab?.artifact.id);
      get().closeExtensionFlyout();
      set(s => ({
        ...openFileTab(s, id, kind, tabs),
        savedArtifactTab: { artifact: { id, kind, name: file.name, path: file.snapshotPath, content: "" }, file, sourceTask },
      }));
    },

    openArtifact: (id) => {
      // 点击产物即收起右侧扩展栏悬浮菜单（钉住时保持打开，由 closeExtensionFlyout 内部判定）
      get().closeExtensionFlyout();
      // 有磁盘路径的 HTML：走扩展栏浏览器 file:// 直载，不再进 mybuddy-artifact 协议预览
      // （自定义协议栈导航失败 ERR_FAILED，且快照语义与外部浏览器不一致）
      const direct = findActiveTaskArtifact(get(), id);
      const directPath = direct?.kind === "html" ? direct.path?.trim() : "";
      if (directPath) {
        const fileUrl = fileUrlForAbsolutePath(directPath);
        get().setBrowserUrl(fileUrl);
        get().refreshBrowser();
        return;
      }
      set((s) => {
        const saved = s.savedArtifactTab?.artifact;
        const artifact = saved?.id === id ? saved : findActiveTaskArtifact(s, id);
        return openFileTab(s, id, artifact?.kind);
      });
      // V3.5 hotfix §8：打开即触发 hydration（cache 缺失/版本过期 → readContent；
      // single-flight；二进制 Viewer 不挂载空内容，UI 层显示 loading/error）
      const descriptor = findDescriptorByIdAnyTask(get(), id);
      const cached = get().artifactRenderCache[id];
      if (
        descriptor &&
        (!cached?.content || cached.artifactVersion !== descriptor.version)
      ) {
        void getRenderHydration(storeContext).ensure(id);
      }
    },

    closeArtifactTab: (id) => {
      set((s) => {
        if (!s.artifactTabs.includes(id)) return s;
        const tabs = s.artifactTabs.filter((x) => x !== id);
        const saved = s.savedArtifactTab?.artifact;
        const savedArtifactTab = saved?.id === id ? undefined : s.savedArtifactTab;
        if (s.activeArtifactId !== id) return { artifactTabs: tabs, savedArtifactTab };
        const active = tabs.at(-1) ?? null;
        const noTabs = tabs.length === 0;
        const nextArtifact = saved?.id === active ? saved : findActiveTaskArtifact(s, active);
        return {
          artifactTabs: tabs,
          activeArtifactId: active,
          savedArtifactTab,
          panelMode:
            noTabs && s.panelMode === "file" ? s.extensionView : s.panelMode,
          extensionFlyoutOpen: noTabs ? false : s.extensionFlyoutOpen,
          extensionMenuOpen: noTabs ? false : s.extensionMenuOpen,
          // 关完文件 → 窄轨；切换 tab → 按新类型重算
          panelWidth: noTabs
            ? PANEL_RAIL_WIDTH
            : adaptivePanelWidth(nextArtifact?.kind, s.sidebarCollapsed),
        };
      });
    },
  };
}
