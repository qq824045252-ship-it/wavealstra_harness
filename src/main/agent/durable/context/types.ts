import type { CompactionSettings } from "@earendil-works/pi-durable";
import type { ContextManagementEngine, ContextManagementStatusDto } from "../../../../shared/context-management";

/** 产品设置里与上下文压缩有关的两项（设置页同一口径）。 */
export interface ProductCompactionSettings {
  /** 窗口比例阈值，0.1–0.9。 */
  readonly ratio: number;
  /** 绝对触发阈值；`null` 表示只按比例。 */
  readonly absoluteTokens: number | null;
}

/** 一次整理/压缩的确定性结果；`applied=false` 且 `skippedReason` 非空表示没有可整理内容。 */
export interface DurableCompactionOutcome {
  applied: boolean;
  engine: "billion-context" | "native";
  beforeTokens?: number;
  afterTokens?: number;
  estimated: boolean;
  blocks?: number;
  entryId?: number;
  skippedReason?: string;
  message?: string;
}

/** 运行时注入的上下文管理配置；由 DurableBotService 按 AppSettings 构造。 */
export interface DurableContextManagementOptions {
  /** 同步读取当前产品阈值（每次使用重新读取，支持运行中修改设置）。 */
  readonly policy: () => ProductCompactionSettings;
  /** 当前引擎：`billion-context`（分层摘要）或 `native`（Pi 原生按比例压缩）；每次使用重新读取。 */
  readonly engine?: () => ContextManagementEngine;
  /** 当前模型工具 schema 的 token 估算；缺省时使用固定保守值。 */
  readonly toolEstimateTokens?: () => number;
  /** 状态投影回调，仅用于 UI 诊断，不允许阻塞请求。 */
  readonly onStatus?: (status: ContextManagementStatusDto) => void;
}

export type { CompactionSettings };