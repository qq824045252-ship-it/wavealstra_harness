import { fileUrlForAbsolutePath } from "../../../lib/browserLinks";
import { PANEL_RAIL_WIDTH, adaptivePanelWidth } from "../../../lib/panelWidth";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { getRenderHydration } from "../runtime/artifactRender";
import {
  findActiveTaskArtifact,
  findDescriptorByIdAnyTask,
} from "../selectors";
import { defaultFlyoutViewForArtifact } from "../workbench/panelPolicy";

export function createArtifactPreviewActions(
  storeContext: AppContext,
): Pick<AppActions, "openArtifact" | "closeArtifactTab"> {
  const { get, set } = storeContext;
  return {
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
        const artifact = findActiveTaskArtifact(s, id);
        const extensionView =
          s.extensionFlyoutOpen && artifact
            ? defaultFlyoutViewForArtifact(artifact)
            : s.extensionView;
        return {
          panelOpen: true,
          panelMode: "file",
          activeArtifactId: id,
          artifactTabs: s.artifactTabs.includes(id)
            ? s.artifactTabs
            : [...s.artifactTabs, id],
          extensionView,
          extensionMenuOpen: false,
          // 打开文档/网页：自动扩到阅读宽度（对齐官方半屏+ 预览）
          panelWidth: adaptivePanelWidth(artifact?.kind, s.sidebarCollapsed),
        };
      });
      // V3.5 hotfix §8：打开即触发 hydration（cache 缺失/版本过期 → readContent；
      // single-flight；二进制 Viewer 不挂载空内容，UI 层显示 loading/error）
      const descriptor = findDescriptorByIdAnyTask(get(), id);
      const cached = get().artifactRenderCache[id];
      if (
        descriptor &&
        (!cached || cached.artifactVersion !== descriptor.version)
      ) {
        void getRenderHydration(storeContext).ensure(id);
      }
    },

    closeArtifactTab: (id) => {
      set((s) => {
        const tabs = s.artifactTabs.filter((x) => x !== id);
        const active =
          s.activeArtifactId === id
            ? (tabs[tabs.length - 1] ?? null)
            : s.activeArtifactId;
        const noTabs = tabs.length === 0;
        const nextArtifact = findActiveTaskArtifact(s, active);
        return {
          artifactTabs: tabs,
          activeArtifactId: active,
          panelMode:
            noTabs && s.panelMode === "file" ? s.extensionView : s.panelMode,
          panelOpen: true,
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
