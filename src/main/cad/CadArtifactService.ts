/**
 * CadArtifactService — Mechanical CAD 产物注册 façade（FreeCAD 主链）。
 *
 * 注册策略（文件即真相，全部 workspace-file 不复制内容）：
 * - TechDraw：techdraw.svg（svg）+ techdraw.fcstd（code）
 * - FCStd 读回：readback.json（结构化摘要）+ readback.step（受管导入桥）
 * 相同 entryFile 幂等（重复注册 → 返回已有 id，不产生 duplicate row）。
 * kernel 产物（model.py/model.json/validation/GLB/重建/装配）注册已随主链切换移除。
 */
import { isAbsolute, join } from "node:path";
import type { ArtifactService } from "../artifact/ArtifactService";
import type { FcstdReadbackResult } from "./CadTypes";

export interface CadArtifactServiceOptions {
  artifactService: ArtifactService;
  /** 注册后附加的 message/toolCall 溯源（可选） */
  producer?: { messageId?: string; toolCallId?: string };
}

export class CadArtifactService {
  private readonly service: ArtifactService;

  constructor(options: CadArtifactServiceOptions) {
    this.service = options.artifactService;
  }

  /** 注册单个 workspace-file artifact（幂等；支持绝对路径或 taskRoot 相对路径） */
  private async registerFile(input: {
    taskId: string;
    taskRoot: string;
    modelId: string;
    file: string;
    kind: "code" | "image" | "html" | "svg";
    originalKind: string;
    title: string;
    producer?: { messageId?: string; toolCallId?: string };
    /** 附加 capability（如 validationPassed） */
    extraCapabilities?: Record<string, unknown>;
  }): Promise<string | null> {
    const { taskId, taskRoot, modelId, file, kind, originalKind, title } = input;
    const abs = isAbsolute(file) ? file : join(taskRoot, file);
    const existing = this.service.findByEntryFile(taskId, abs);
    if (existing) return existing.id;
    try {
      const descriptor = await this.service.register({
        taskId,
        kind,
        title: `${title}（${originalKind}）`,
        capabilities: { originalKind, modelId, cad: true, ...input.extraCapabilities },
        workspaceFile: { entryFile: abs, rootDir: taskRoot },
        producerMessageId: input.producer?.messageId,
        producerToolCallId: input.producer?.toolCallId,
      });
      return descriptor.id;
    } catch (error) {
      console.warn(`[CadArtifactService] artifact 注册失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** TechDraw 产物：techdraw.svg（svg kind）+ techdraw.fcstd */
  async registerTechDrawArtifacts(
    taskId: string,
    taskRoot: string,
    files: Record<string, string>,
    producer?: { messageId?: string; toolCallId?: string },
  ): Promise<string[]> {
    const registered: string[] = [];
    const candidates = [
      { key: "svg", kind: "svg" as const, originalKind: "techdraw-svg" },
      { key: "fcstd", kind: "code" as const, originalKind: "techdraw-fcstd" },
    ];
    for (const candidate of candidates) {
      const abs = files[candidate.key];
      if (!abs) continue;
      const id = await this.registerFile({
        taskId, taskRoot, modelId: "techdraw", file: abs, kind: candidate.kind, originalKind: candidate.originalKind,
        title: `TechDraw 工程图`, producer,
      });
      if (id) registered.push(id);
    }
    return registered;
  }

  /** FCStd 读回产物：readback.json（结构化摘要）+ readback.step（受管导入桥） */
  async registerFcstdReadbackArtifacts(
    taskId: string,
    taskRoot: string,
    result: FcstdReadbackResult,
    producer?: { messageId?: string; toolCallId?: string },
  ): Promise<string[]> {
    const registered: string[] = [];
    const candidates = [
      { key: "readback" as const, file: `cad/_fcstd_readback/readback.json`, kind: "code" as const, originalKind: "fcstd-readback" },
      { key: "step" as const, file: `cad/_fcstd_readback/readback.step`, kind: "code" as const, originalKind: "fcstd-readback-step" },
    ];
    for (const candidate of candidates) {
      const abs = result.files[candidate.key];
      if (!abs) continue;
      const id = await this.registerFile({
        taskId, taskRoot, modelId: "fcstd-readback", file: abs, kind: candidate.kind, originalKind: candidate.originalKind,
        title: `FCStd 读回摘要`, producer,
      });
      if (id) registered.push(id);
    }
    return registered;
  }
}
