/**
 * Wave 5 Real Open — 真实 Product Path E2E harness（V3.5 hotfix §19-24）
 *
 * 与 wave5a-preview-entry 不同：本页加载 **真实 appStore**（不 mock），
 * 渲染真实 ArtifactPanel；window.api 由测试 preload（真实 IPC 通道）提供。
 *
 * 链路：Artifact Domain(真实 main service) → IPC → projection 事件/snapshot →
 * openArtifact → ensureArtifactRenderPayload → readContent → renderCache →
 * ArtifactPanel → 真实 Viewer。
 *
 * window.__open 测试钩子：
 *   open(id)          → store.openArtifact（生产路径）
 *   ensure(id)        → store.ensureArtifactRenderPayload（可直接断言 cache）
 *   hydrate()         → store.hydrateArtifacts("t1")
 *   state()           → { cache, loads, errors, activeId, panelMode, loadState }
 *   applyRemoved(id)  → store.applyArtifactRemoved（驱动 removed 事件）
 *   applyUpdated(id, version, descriptor) → store.applyArtifactUpdated
 */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import ArtifactPanel from "@/components/artifact/ArtifactPanel";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";

const api = (window as unknown as { api?: Record<string, unknown> }).api;

declare global {
  interface Window {
    __open?: unknown;
  }
}

// 种子任务（真实 App 由 db.listTasks 提供；E2E 直接注入，与 store 语义一致）
useAppStore.setState({
  tasks: [
    {
      id: "t1",
      title: "Office E2E",
      spaceId: "s1",
      status: "active",
      updatedAt: Date.now(),
      messages: [],
      modelId: "m1",
      permissionMode: "default",
      archived: false,
    } as never,
  ],
  activeTaskId: "t1",
  panelOpen: true,
  panelMode: "file",
});

// 事件订阅（镜像 App.tsx initRuntime 的 wiring）
const dom = api?.artifactDomain as
  | {
      onCreated?: (cb: (ev: unknown) => void) => () => void;
      onUpdated?: (cb: (ev: unknown) => void) => () => void;
      onRemoved?: (cb: (ev: unknown) => void) => () => void;
    }
  | undefined;
if (dom) {
  dom.onCreated?.((ev) => useAppStore.getState().applyArtifactCreated(ev as never));
  dom.onUpdated?.((ev) => useAppStore.getState().applyArtifactUpdated(ev as never));
  dom.onRemoved?.((ev) => useAppStore.getState().applyArtifactRemoved(ev as never));
}

function Harness(): React.JSX.Element {
  useEffect(() => {
    void useAppStore.getState().hydrateArtifacts("t1");
  }, []);
  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ArtifactPanel />
    </div>
  );
}

window.__open = {
  open: (id: string): void => useAppStore.getState().openArtifact(id),
  ensure: (id: string): Promise<unknown> => useAppStore.getState().ensureArtifactRenderPayload(id),
  hydrate: (): Promise<void> => useAppStore.getState().hydrateArtifacts("t1"),
  state: (): unknown => {
    const s = useAppStore.getState();
    return {
      cache: s.artifactRenderCache,
      loads: s.artifactRenderLoadState,
      errors: s.artifactRenderErrors,
      activeId: s.activeArtifactId,
      panelMode: s.panelMode,
      tabs: s.artifactTabs,
      descriptors: s.artifactProjection.artifactsByTask,
    };
  },
  applyRemoved: (id: string): void =>
    useAppStore.getState().applyArtifactRemoved({
      artifactId: id,
      taskId: "t1",
      revision: Date.now(),
    } as never),
  applyUpdated: (artifactId: string, version: number, descriptor: ArtifactDescriptor): void =>
    useAppStore.getState().applyArtifactUpdated({
      artifactId,
      taskId: "t1",
      version,
      revision: Date.now(),
      descriptor,
    } as never),
};

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<Harness />);
