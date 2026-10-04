/**
 * CadToolDefinitions — Mechanical CAD 主链 native 工具 schema（FreeCAD-only）。
 *
 * 注册面（6 个）：cad_open_freecad / cad_route / cad_plan / cad_techdraw /
 * cad_fcstd_readback / cad_freecad_run。kernel 工具 schema 已随主链切换移除。
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const openFreeCadSchema = Type.Object(
  {
    model_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /** 可选：任务内任意 step/stp/fcstd 文件（相对 taskRoot 或绝对路径） */
    file: Type.Optional(Type.String({ maxLength: 1024 })),
  },
  { additionalProperties: false },
);
export type OpenFreeCadParams = Static<typeof openFreeCadSchema>;

export const routeSchema = Type.Object(
  {
    goal: Type.String({ minLength: 2, maxLength: 2000 }),
    features: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
  },
  { additionalProperties: false },
);
export type RouteParams = Static<typeof routeSchema>;

export const planSchema = Type.Object(
  {
    goal: Type.String({ minLength: 2, maxLength: 2000 }),
    /** 已有文件（任务内 step/fcstd，相对 taskRoot；无则从空白建模） */
    inputFile: Type.Optional(Type.String({ maxLength: 1024 })),
    features: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
  },
  { additionalProperties: false },
);
export type PlanParams = Static<typeof planSchema>;

export const techdrawSchema = Type.Object(
  {
    model_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /** 任务内 STEP 文件（相对 taskRoot；与 model_id 二选一） */
    step_file: Type.Optional(Type.String({ maxLength: 1024 })),
    /** 任务内 FCStd 文件（相对 taskRoot；三选一） */
    fcstd_file: Type.Optional(Type.String({ maxLength: 1024 })),
    format: Type.Optional(Type.Union([Type.Literal("svg"), Type.Literal("pdf")], { default: "svg" })),
    include_dims: Type.Optional(Type.Boolean({ default: true })),
  },
  { additionalProperties: false },
);
export type TechdrawParams = Static<typeof techdrawSchema>;

export const fcstdReadbackSchema = Type.Object(
  {
    /** 任务内 FCStd 文件（相对 taskRoot） */
    fcstd_file: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
);
export type FcstdReadbackParams = Static<typeof fcstdReadbackSchema>;

export const freeCadRunSchema = Type.Object(
  {
    /** FreeCAD Python 脚本（FreeCAD 自带 Python 3.11 环境；参数用 fc_args() 读取） */
    script: Type.String({ minLength: 1, maxLength: 50_000 }),
    args: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 32 })),
    timeout_ms: Type.Optional(Type.Number({ minimum: 1000, maximum: 600_000 })),
  },
  { additionalProperties: false },
);
export type FreeCadRunParams = Static<typeof freeCadRunSchema>;

/** ToolDefinition 工厂类型（execute 由扩展注入实现） */
export type CadToolDef = ToolDefinition<any, any, any>;
