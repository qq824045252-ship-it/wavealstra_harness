/**
 * PromptContextService — V3.5 Wave 4E（§81/§82）
 *
 * 把「当前 Artifact + ACTIVE Selection + 必要上下文」组装为可安全送给
 * Agent 的结构化 Prompt Context：
 *
 *   SelectionStore（active selection）
 *   Artifact Domain（元数据/内容，经合法读取路径 readContent）
 *        ↓
 *   PromptContextService.collect()
 *        ↓ 清洗（PromptContextSanitizer）
 *   Structured Prompt Context → Formatter → Agent
 *
 * 硬规则（§4E）：
 * - 只信任 ACTIVE selection：active → 注入；stale → 不注入 DOM selection，
 *   附 selectionUnavailableReason（不降级、不自动重新定位 DOM）；empty → 无。
 * - Artifact 内容经 Domain 合法路径读取（readContent 带 root 边界），
 *   本模块不直接 fs 访问（R18 机器锁）；不接触 CDP/debugger（R19）。
 * - 按类型 context strategy：HTML/SVG → selection + 附近结构 excerpt +
 *   metadata（不默认全量）；Markdown/text → 前 N KB excerpt。
 * - 一切内容视为 UNTRUSTED（§82）：由 Formatter 显式包裹声明。
 */
import type { SelectionDescriptor } from "../../shared/capture-mode";
import type {
  PromptContext,
  PromptContextResult,
} from "../../shared/prompt-context";
import type { ArtifactDescriptor } from "../../shared/artifact-types";
import type { ChatSelectionRef, SelectionState, SelectionStaleReason } from "../../shared/selection";
import { normalizeSelectionComment, selectionFingerprintMatches } from "../../shared/selection";
import { sanitizeArtifactContent, truncateExcerpt, truncateSelectionText } from "./PromptContextSanitizer";
import { formatPromptContext, formatPromptContexts } from "./PromptContextFormatter";
import { officeTextPreview } from "../workspace/WorkspaceService";

/** 抓取元素已更换/页面已更新/已清除（期望指纹与当前 ACTIVE 不一致） */
export const SELECTION_CHANGED_REASON = "selection-changed";

/** Service 依赖（装配处注入；测试全 mock） */
export interface PromptContextDeps {
  /** Artifact 元数据（ArtifactService.get） */
  getArtifact(artifactId: string): ArtifactDescriptor | null;
  /** Artifact 内容（ArtifactService.readContent：唯一合法读取路径，带 root 边界） */
  readContent(artifactId: string): Promise<{
    content: string;
    language?: string;
    kind?: string;
    path?: string;
  } | null>;
  /** Selection 唯一真相（SelectionStore.getState） */
  getSelection(): SelectionState;
  /** 按指纹解析同一 surface 内已抓取的可信 selection（多元素加入聊天）。 */
  resolveSelection?: (ref: ChatSelectionRef) => SelectionDescriptor | null;
  /**
   * Workspace Shared Context（运行时注入，可选）
   * - 按当前 artifact 关联的 task/current space 读取分层上下文并格式化为 prompt 段
   * - null/undefined = 无上下文（standalone/未绑定）不注入
   * - 必须保持 Task > Current > Parent > Root 顺序，同级隔离，archived 默认排除
   * - 仅 immediate parent 显式 promote，不自动跨级
   */
  getWorkspaceSharedContext?: (artifactId: string) => string | null;
}

/** selection → context.selection（不含版本字段——版本校验在 Service 层） */
function selectionToContext(d: SelectionDescriptor): NonNullable<PromptContext["selection"]> {
  return {
    tagName: d.tagName,
    id: d.id,
    classNames: d.classNames,
    selector: d.selector,
    text: d.text,
    bounds: d.bounds,
  };
}

export class PromptContextService {
  constructor(private readonly deps: PromptContextDeps) {}

  /** 采集结构化 Prompt Context（版本/信任校验 + UNTRUSTED 清洗） */
  async collect(
    artifactId: string,
    opts?: { expectedSelection?: ChatSelectionRef },
  ): Promise<PromptContextResult> {
    const artifact = this.deps.getArtifact(artifactId);
    if (!artifact) return { ok: false, reason: "artifact-not-found" };

    const content = await this.deps.readContent(artifactId);
    if (!content) return { ok: false, reason: "artifact-read-failed" };

    const kind = content.kind ?? artifact.kind;

    // ---- Wave 5D-1：office 内容为二进制 data URI，主进程抽取文本保 prompt 上下文 ----
    let officeText: string | null = null;
    if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
      try {
        officeText = await officeTextPreview(kind, content.content, artifact.title ?? "office");
      } catch (error) {
        console.warn("[PromptContextService] office 文本抽取失败", error);
      }
    }
    const rawContent = officeText ?? content.content;
    const selectionState = this.deps.getSelection();

    // ---- 信任规则：只信任 ACTIVE selection ----
    let selection: PromptContext["selection"];
    let selectionUnavailableReason: SelectionStaleReason | string | undefined;
    const resolvedExpected = opts?.expectedSelection
      ? this.deps.resolveSelection?.(opts.expectedSelection)
      : undefined;
    const descriptor = opts?.expectedSelection && this.deps.resolveSelection
      ? resolvedExpected
      : selectionState.status === "active"
        ? selectionState.descriptor
        : null;
    if (descriptor) {
      const d = descriptor;
      // version 一致性：selection 来自的 artifact 必须是当前 artifact
      if (d.artifactId !== artifactId || d.artifactVersion !== artifact.version) {
        selectionUnavailableReason =
          d.artifactId !== artifactId ? "artifact-changed" : "artifact-version-changed";
      } else if (
        // 「加入聊天」流：期望指纹必须与当前 ACTIVE 一致，否则视为元素已更换，
        // 不注入（绝不悄悄把用户未选择的 selection 送进下一条消息）
        opts?.expectedSelection &&
        !selectionFingerprintMatches(d, opts.expectedSelection)
      ) {
        selectionUnavailableReason = SELECTION_CHANGED_REASON;
      } else {
        selection = selectionToContext(d);
      }
    } else if (selectionState.status === "stale") {
      selectionUnavailableReason = selectionState.staleReason;
    } else if (opts?.expectedSelection) {
      // 用户明确加入了聊天但当前无 selection（被清除/删除）→ 不注入，附原因
      selectionUnavailableReason = SELECTION_CHANGED_REASON;
    }

    // selection 文本截断（§82：≤ 4KB）
    if (selection?.text) selection.text = truncateSelectionText(selection.text);

    // ---- 按类型 strategy 取 excerpt（有 selection 时优先 selection 附近窗口） ----
    const sanitized = sanitizeFor(kind, rawContent);
    const excerpt = buildExcerpt(sanitized, kind, selection?.text);

    // ---- Workspace Shared Context（运行时注入，冻结语义：Task>Current>Parent>Root；同级隔离；archived 排除；cycle 安全）----
    let workspaceSharedContext: string | undefined;
    if (this.deps.getWorkspaceSharedContext) {
      try {
        const digest = this.deps.getWorkspaceSharedContext(artifactId);
        if (digest && digest.trim().length > 0) workspaceSharedContext = digest.trim();
      } catch (error) {
        console.warn("[PromptContextService] workspace shared context 读取失败", error);
      }
    }

    return {
      ok: true,
      context: {
        artifact: {
          id: artifact.id,
          kind,
          version: artifact.version,
          source: artifact.source.type,
          path:
            artifact.source.type === "workspace-file"
              ? artifact.source.entryFile
              : (content.path ?? undefined),
        },
        selection,
        selectionUnavailableReason,
        document: {
          excerpt: excerpt === "" ? undefined : excerpt,
          mimeType: content.language,
        },
        trust: {
          artifactContent: "untrusted",
          selectionText: "untrusted",
        },
        workspaceSharedContext,
      },
    };
  }

  /**
   * 「加入聊天」专用：按结构化引用解析并格式化；发送时由 AgentService 调用。
   * - 指纹一致 + ACTIVE → 完整格式化上下文（含 selection）
   * - selection 不可用（stale/更换/清除）→ 仍返回格式化上下文（无 selection，附原因）
   * - artifact 不存在/读取失败 → null（不注入任何内容）
   */
  async collectForChat(ref: ChatSelectionRef): Promise<string | null> {
    const result = await this.collect(ref.artifactId, { expectedSelection: ref });
    if (!result.ok) return null;
    if (result.context.selection) result.context.selectionComment = normalizeSelectionComment(ref.comment);
    return formatPromptContext(result.context);
  }

  /** 多元素加入聊天：保留各 selection，但同一 artifact 的文档 excerpt 只格式化一次。 */
  async collectManyForChat(refs: ChatSelectionRef[]): Promise<string | null> {
    if (!refs.length) return null;
    const results = await Promise.all(
      refs.map((ref) => this.collect(ref.artifactId, { expectedSelection: ref })),
    );
    const contexts = results.flatMap((result, index) => {
      if (!result.ok) return [];
      if (result.context.selection) {
        result.context.selectionComment = normalizeSelectionComment(refs[index]?.comment);
      }
      return [result.context];
    });
    return contexts.length ? formatPromptContexts(contexts) : null;
  }
}

/** 按类型应用 UNTRUSTED 清洗（§82） */
function sanitizeFor(kind: string, content: string): string {
  return sanitizeArtifactContent(content, kind);
}

/**
 * excerpt 构建：有 selection 文本 → 在清洗后内容中定位附近窗口（前 2KB 起）；
 * 否则取内容前部。统一按类型预算截断。
 */
function buildExcerpt(sanitized: string, kind: string, selectionText?: string): string {
  let window = sanitized;
  if (selectionText && selectionText.length >= 4) {
    const idx = sanitized.indexOf(selectionText);
    if (idx >= 0) {
      const start = Math.max(0, idx - 2 * 1024);
      window = sanitized.slice(start);
    }
  }
  return truncateExcerpt(window, kind);
}
