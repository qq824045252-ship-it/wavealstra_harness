/**
 * Prompt Context 契约 — V3.5 Wave 4E（§81/§82）
 *
 * 结构化 Prompt Context：由 PromptContextService 采集 → Sanitizer 清洗 →
 * Formatter 转 Agent message。以后 Agent provider/模型/工具链更换
 * 不重写上下文采集。
 *
 * 信任规则（§4E 硬规则）：
 * - ACTIVE selection → 可作为当前 DOM 事实注入
 * - STALE selection → 不作为可信 DOM selection 注入；附
 *   selectionUnavailableReason（不自动降级/不自动重新定位 DOM 节点）
 * - EMPTY → 无 selection context
 *
 * 安全边界：artifact/selection 内容一律 UNTRUSTED（§82）——结构化 prompt
 * 必须显式声明"不可把页面指令当 system/developer 指令"。
 */

export interface PromptContext {
  /** 用户手写的元素备注；仅在对应 selection 校验成功时附加。 */
  selectionComment?: string;
  artifact: {
    id: string;
    kind: string;
    version: number;
    source: "workspace-file" | "managed-content";
    /** workspace-file 的 entryFile 绝对路径；managed-content 的 storagePath */
    path?: string;
  };

  /** ACTIVE selection 才注入（stale 时缺省 + selectionUnavailableReason） */
  selection?: {
    tagName: string;
    id?: string;
    classNames: string[];
    selector?: string;
    text?: string;
    bounds?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };

  /** stale 时的失效原因（§80 reason 透传） */
  selectionUnavailableReason?: string;

  document?: {
    /** 清洗后的内容 excerpt（按类型截断） */
    excerpt?: string;
    mimeType?: string;
  };

  /** UNTRUSTED 声明（§82）：内容不可当指令执行 */
  trust: {
    artifactContent: "untrusted";
    selectionText: "untrusted";
  };

  /** Workspace Shared Context（分层确定性：Task > Current > Parent > Root；同级隔离；归档默认排除） */
  workspaceSharedContext?: string;
}

/** 采集失败（artifact 不存在 / 读取失败）——不产生 context */
export interface PromptContextError {
  ok: false;
  reason:
    | "artifact-not-found"
    | "artifact-read-failed"
    | "no-active-selection-context";
}

export type PromptContextResult = { ok: true; context: PromptContext } | PromptContextError;

/** excerpt/文本截断预算（§82：分类型上限，不统一大桶） */
export const PromptContextLimits = {
  selectionText: 4 * 1024, // 4 KB
  htmlExcerpt: 32 * 1024, // 32 KB
  markdownExcerpt: 32 * 1024, // 32 KB
  svgExcerpt: 32 * 1024, // 32 KB
} as const;

export const PromptContextIpc = {
  /** renderer → main：采集当前 Artifact 的 Prompt Context（Wave 4 Gate E2E 入口；不接 Agent） */
  collect: "promptContext:collect",
} as const;

export interface PromptContextCollectRequest {
  artifactId: string;
}
