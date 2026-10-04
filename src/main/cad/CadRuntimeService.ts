/**
 * CadRuntimeService — Mechanical CAD 主链 facade（FreeCAD-only）。
 *
 * 职责收敛为 FreeCAD 主链所需的最小服务面：
 * - 后端 = FreeCadInterop（FreeCADCmd 直连）+ CadArtifactService（产物注册）；
 * - techdraw / fcstdReadback：结构化 FreeCAD 能力（脚本资产 freecad-scripts.ts）；
 * - 无 worker/runnerDir/repository（kernel 已拆除；cad_models 表 dormant）。
 * cad_freecad_run / cad_open_freecad 由扩展直接走 FreeCadInterop（不经本服务）。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { FreeCadInterop } from "./FreeCadInterop";
import { CAD_DIR_NAME, type CadCallOptions, type FcstdReadbackResult, type TechDrawResult } from "./CadTypes";
import type { CadArtifactService } from "./CadArtifactService";

/** 结构化工具错误 */
export class CadToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "CadToolError";
  }
}

export interface CadRuntimeServiceOptions {
  /** 产物注册（ArtifactService façade） */
  artifacts?: CadArtifactService | null;
  /** FreeCAD 互操作（techdraw/fcstdReadback 的后端） */
  interop?: FreeCadInterop | null;
}

export class CadRuntimeService {
  private readonly artifacts: CadArtifactService | null;
  private readonly interop: FreeCadInterop | null;
  private shuttingDown = false;

  constructor(options: CadRuntimeServiceOptions = {}) {
    this.artifacts = options.artifacts ?? null;
    this.interop = options.interop ?? null;
  }

  /** FreeCAD 可用性（FreeCADCmd 可发现即可用；MCP 侧由 ProfessionalToolRuntime 单独健康检查） */
  get installed(): boolean {
    return this.interop?.available ?? false;
  }

  get activeTaskCount(): number {
    return 0;
  }

  /** 任务删除/归档后回收（无 worker；保留幂等契约） */
  async releaseTask(_taskId: string): Promise<void> {
    return;
  }

  /** before-quit：清理（无 worker；保留幂等契约） */
  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
  }

  /**
   * TechDraw 工程图（真实 FreeCAD TechDraw 对象 → SVG + FCStd；FreeCADCmd 直连）。
   * input.modelId 兼容历史 cad/<modelId>/model.step（遗留目录）。
   */
  async techdraw(
    taskId: string,
    taskRoot: string,
    input: { stepFile?: string; modelId?: string; fcstdFile?: string; format?: string; includeDims?: boolean },
    _freecadCmd?: string,
    options: CadCallOptions = {},
  ): Promise<TechDrawResult> {
    const interop = this.interop;
    if (!interop) throw new CadToolError("FreeCAD 互操作未就绪", "freecad_unavailable");
    this.assertNotShuttingDown();
    const inputPath = input.modelId
      ? resolve(taskRoot, CAD_DIR_NAME, input.modelId, "model.step")
      : input.fcstdFile
        ? resolve(taskRoot, input.fcstdFile)
        : input.stepFile
          ? resolve(taskRoot, input.stepFile)
          : null;
    if (!inputPath || !existsSync(inputPath)) {
      throw new CadToolError("techdraw 需要 stepFile/modelId/fcstdFile 且文件存在", "invalid_params");
    }
    const outDir = resolve(taskRoot, CAD_DIR_NAME, "_techdraw");
    const result = await interop.techdraw(inputPath, outDir, {
      format: input.format ?? "svg",
      includeDims: input.includeDims ?? true,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (this.artifacts) {
      await this.artifacts.registerTechDrawArtifacts(taskId, taskRoot, result.files, options.producer);
    }
    return result as TechDrawResult;
  }

  /**
   * FCStd 受管结构化读回（FreeCADCmd 直连）：对象/类型/参数/形状摘要 + STEP 导出。
   * 非完整参数化读回——参数化语义保留在源 FCStd。
   */
  async fcstdReadback(
    taskId: string,
    taskRoot: string,
    fcstdFile: string,
    _freecadCmd?: string,
    options: CadCallOptions = {},
  ): Promise<FcstdReadbackResult> {
    const interop = this.interop;
    if (!interop) throw new CadToolError("FreeCAD 互操作未就绪", "freecad_unavailable");
    this.assertNotShuttingDown();
    const abs = resolve(taskRoot, fcstdFile);
    const outDir = resolve(taskRoot, CAD_DIR_NAME, "_fcstd_readback");
    const result = await interop.fcstdReadback(abs, outDir, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (this.artifacts) {
      await this.artifacts.registerFcstdReadbackArtifacts(taskId, taskRoot, result as FcstdReadbackResult, options.producer);
    }
    return result as FcstdReadbackResult;
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) {
      throw new CadToolError("CAD runtime 正在关闭", "shutting_down");
    }
  }
}
