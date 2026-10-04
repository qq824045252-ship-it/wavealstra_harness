/**
 * Wave 5A — 预览页 appStore mock（仅测试打包使用，esbuild alias 替换真实 store）
 *
 * 真实 store 在模块初始化时可能触达 window.api / IPC，预览页（fixtures/golden-pages）
 * 只渲染视图组件，不接主进程。aligned 真实 store 的 hook 签名。
 */
import { create } from "zustand";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
import type { ArtifactRenderPayload } from "../src/renderer/src/lib/artifactIngest";

interface MockState {
  theme: "light" | "dark";
  tasks: Array<{ id: string; cwd?: string }>;
  artifactProjection: {
    artifactsByTask: Record<string, ArtifactDescriptor[]>;
    artifactRevisions: Record<string, number>;
    artifactLoadState: Record<string, "unloaded" | "loading" | "ready" | "error">;
  };
  artifactRenderCache: Record<string, ArtifactRenderPayload>;
  artifactRenderLoadState: Record<string, "unloaded" | "loading" | "ready" | "error">;
  openArtifact: (id: string) => void;
  ensureArtifactRenderPayload: (id: string) => Promise<ArtifactRenderPayload | null>;
  ensureCanvasArtifact: () => void;
}

export const useAppStore = create<MockState>(() => ({
  theme: "light",
  tasks: [],
  artifactProjection: { artifactsByTask: {}, artifactRevisions: {}, artifactLoadState: {} },
  artifactRenderCache: {},
  artifactRenderLoadState: {},
  openArtifact: () => {},
  ensureArtifactRenderPayload: async () => null,
  ensureCanvasArtifact: () => {},
}));

// 与真实 store 一致：selector 必须返回稳定引用（useSyncExternalStore 要求）
const EMPTY_ARTIFACTS: unknown[] = [];
export const selectActiveTaskArtifacts = (): unknown[] => EMPTY_ARTIFACTS;
export const useActiveTaskArtifacts = (): unknown[] => EMPTY_ARTIFACTS;

export function sizeLabel(content: string): string {
  if (content.length < 1024) return `${content.length} B`;
  if (content.length < 1024 * 1024) return `${(content.length / 1024).toFixed(1)} KB`;
  return `${(content.length / 1024 / 1024).toFixed(1)} MB`;
}
