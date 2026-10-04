/**
 * CadTypes — Mechanical CAD 主链数据契约（Main 侧）。
 *
 * 主链：LLM → Mechanical CAD 情景/Tag → FreeCAD Skill/Policy
 * → FreeCAD MCP（uvx freecad-mcp ↔ GUI addon）+ native 薄工具（cad_freecad_run /
 * cad_techdraw / cad_fcstd_readback / cad_open_freecad / cad_route / cad_plan）
 * → FreeCAD Runtime（FreeCADRuntime provider + FreeCadInterop.runScript）→
 * inspect/verify/export（fcstd_readback 结构化摘要 + TechDraw + get_view 截图）。
 */

/** 任务工作区内 CAD 目录名（cad/<modelId>/ 为历史目录，保留不删） */
export const CAD_DIR_NAME = "cad";

/** 工具执行选项（超时 / abort / 产物溯源） */
export interface CadCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  producer?: { messageId?: string; toolCallId?: string };
}

export const CAD_DEFAULT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// 主链（FreeCAD）类型
// ---------------------------------------------------------------------------

/** CAD 引擎：主链单一引擎 FreeCAD */
export type CadEngineId = "freecad";

export interface CadAvailability {
  freecad: boolean;
}

/** cad_route 决策（主链恒为 freecad；reason/matchedCapabilities 供 Agent 判断能力覆盖） */
export interface CadRouteDecision {
  engine: CadEngineId;
  score: number;
  reason: string;
  matchedCapabilities: string[];
  availableEngines: CadAvailability;
  override?: CadEngineId;
}

/** cad_plan 结构化计划：read → spec → build → verify → export（FreeCAD 原生工作流） */
export interface CadPlan {
  goal: string;
  enginePlan: {
    engine: CadEngineId;
    reason: string;
    capabilities: string[];
    steps: string[];
  };
  modelingSteps: Array<{
    step: string;
    tool: string;
    args: Record<string, unknown>;
  }>;
  /** 验证计划：以 cad_fcstd_readback 结构化输出为 gate（与 readback 真实字段对齐） */
  verifyPlan: {
    tool: "cad_fcstd_readback";
    gates: string[];
    gate: "required";
  };
  deliveryPlan: {
    formats: string[];
    artifacts: string[];
  };
}

/** FreeCAD 受管脚本执行结果 */
export interface FreeCadRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * FCStd 受管结构化读回结果（对象/类型/参数/State/草图约束状态 + STEP 导出）。
 * 字段可获取性：FreeCAD API 无法稳定提供的字段返回 null（unknown），绝不伪造。
 */
export interface FcstdReadbackResult {
  summary: {
    fcstd: string;
    valid: boolean;
    document: string;
    /** document.recompute() 后是否仍有失败（null=API 不可得） */
    recomputeErrors: boolean | null;
    objectCount: number;
    shapeObjectCount: number;
    typeCounts: Record<string, number>;
    objects: Array<{
      name: string;
      label: string;
      type: string;
      /** 对象 State（如 'Invalid'/'Touched'/'RecomputeFailed'；FreeCAD 原样列表） */
      state: string[];
      params: Record<string, unknown>;
      /** Sketcher::SketchObject：几何/约束计数与求解状态（null=非草图或 API 不可得） */
      sketch?: {
        geometryCount: number;
        constraintCount: number;
        /** 冲突/冗余约束（FreeCAD 1.1+ ConflictingConstraints/RedundantConstraints；旧版 hasConflicts/hasRedundancies；null=API 不可得） */
        conflicts: boolean | null;
        redundancies: boolean | null;
        /** 求解状态文本（1.1+ getStatusString()："Valid" 等；旧版 solve() 消息；空=不可得） */
        solveStatus: string;
        /** 明确 fully constrained 时为 true；明确非全约束为 false；无法判定为 null（1.1+ FullyConstrained 属性） */
        fullyConstrained: boolean | null;
        /** 自由度（1.1+ DoF 属性；0=全约束；null=API 不可得） */
        DoF: number | null;
      } | null;
      shape?: { valid: boolean; solids: number; faces: number; edges: number; volume: number | null };
    }>;
    stepFile: string;
    stepBytes: number;
  };
  files: Record<string, string>;
  exitCode: number;
  engine: string;
}

/** TechDraw 结果 */
export interface TechDrawResult {
  files: Record<string, string>;
  format: string;
  exitCode: number;
  engine: string;
}
