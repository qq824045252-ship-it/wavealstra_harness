import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore } from "@/store/appStore";
import {
  degradationPolicy,
  languageBadge,
  plainLineToHtml,
  tokenLineToHtml,
  tokenizeCode,
  CHUNK_SIZE,
  type CodeTheme,
  type TokenizedCode,
} from "@/lib/codeHighlight";
import { prewarmHighlighter } from "@/lib/codeHighlight";
import {
  loadMonaco,
  monacoLanguageFor,
  type MonacoModule,
  type MonacoSession,
} from "@/lib/monacoLazy";
import { IconCheck, IconCopy, IconPencil } from "@/components/common/icons";
import { FONT_SETTINGS_EVENT, getAppliedFontSettings, type AppliedFontSettings } from "@/lib/fontSettings";

interface Props {
  content: string;
  language?: string;
}

/** 超过该行数时启用虚拟列表，避免大文件挂载整棵 DOM */
const VIRTUALIZE_THRESHOLD = 200;

/** 提前预热 Shiki grammar（模块加载即触发，不阻塞渲染） */
void prewarmHighlighter();

interface LineProps {
  index: number;
  html: string;
}

function CodeLine({ index, html }: LineProps): React.JSX.Element {
  return (
    <div className="code-line">
      <span className="code-lineno">{index + 1}</span>
      <span
        className="code-line-content shiki-line"
        dangerouslySetInnerHTML={{ __html: html || " " }}
      />
    </div>
  );
}

/**
 * Wave 5A — 代码 Artifact 视图
 *
 * 静态查看：Shiki（JS RegExp engine，§52 冻结决策）+ 双主题（github-light/dark）
 *   - 首帧永远先出纯文本（虚拟列表），tokenize 在后台完成
 *   - >2k 行分块换入高亮；>30k 行 / >3MB 完全禁用高亮（纯文本）
 * 编辑模式：仅用户点击「编辑」才 dynamic import Monaco（§53 冻结决策）
 *   - 1MB+ 降级禁用；退出/卸载必须 dispose（1G 实测内存回收）
 */
export default function CodeView({ content, language }: Props): React.JSX.Element {
  const theme = useAppStore((s) => s.theme);
  const [codeFontSize, setCodeFontSize] = useState(() => getAppliedFontSettings().codeFontSize);

  useEffect(() => {
    const onFontSettings = (event: Event): void => {
      setCodeFontSize((event as CustomEvent<AppliedFontSettings>).detail.codeFontSize);
    };
    window.addEventListener(FONT_SETTINGS_EVENT, onFontSettings);
    return () => window.removeEventListener(FONT_SETTINGS_EVENT, onFontSettings);
  }, []);
  const rawLines = useMemo(() => content.replace(/\n$/, "").split("\n"), [content]);
  const useVirtual = rawLines.length > VIRTUALIZE_THRESHOLD;
  const parentRef = useRef<HTMLDivElement>(null);
  const editContainerRef = useRef<HTMLDivElement | null>(null);
  const monacoSessionRef = useRef<MonacoSession | null>(null);

  const [tokens, setTokens] = useState<TokenizedCode | null>(null);
  const [revealedLines, setRevealedLines] = useState(0);
  const [highlighting, setHighlighting] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [monacoApi, setMonacoApi] = useState<MonacoModule | null>(null);
  const [copied, setCopied] = useState(false);

  const policy = useMemo(
    () => degradationPolicy(rawLines.length, content.length),
    [rawLines.length, content.length],
  );

  // content 变化 → 重置 tokenize 状态，并强制退出编辑态（内容已更新）
  useEffect(() => {
    setTokens(null);
    setRevealedLines(0);
    setHighlighting(false);
    setEditMode(false);
  }, [content, language]);

  // 后台 tokenize + 分块 reveal（首帧纯文本先行）
  useEffect(() => {
    if (policy.plainText) return;
    let cancelled = false;
    let intervalId: number | null = null;
    setHighlighting(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await tokenizeCode(content, language);
        if (cancelled) return;
        setTokens(result);
        setHighlighting(false);
        if (!result.failed && !policy.chunkedSwap) {
          setRevealedLines(Number.MAX_SAFE_INTEGER);
          return;
        }
        // 分块换入（failed 时仅首块，其余保持纯文本）
        const total = rawLines.length;
        let revealed = Math.min(CHUNK_SIZE, total);
        setRevealedLines(revealed);
        if (result.failed) return;
        intervalId = window.setInterval(() => {
          revealed = Math.min(revealed + CHUNK_SIZE, total);
          setRevealedLines(revealed);
          if (revealed >= total && intervalId !== null) window.clearInterval(intervalId);
        }, 16);
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [content, language, policy.plainText, policy.chunkedSwap, rawLines.length]);

  // 编辑态 Monaco：进入 → 立即 lazy load（不依赖容器 DOM，解决首帧 ref 空竞态）
  useEffect(() => {
    if (!editMode) return;
    let cancelled = false;
    setEditLoading(true);
    loadMonaco()
      .then((monaco) => {
        if (!cancelled) setMonacoApi(monaco);
      })
      .catch((error) => {
        console.error("[CodeView] Monaco load failed", error);
        if (!cancelled) setEditMode(false);
      })
      .finally(() => {
        if (!cancelled) setEditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editMode]);

  // 容器挂载（含二次进入）或 monaco 就绪 → 创建 editor（幂等，sessionRef 防重复）
  const ensureMonacoEditor = (): void => {
    if (!editMode || !monacoApi || !editContainerRef.current) return;
    if (monacoSessionRef.current) return;
    const container = editContainerRef.current;
    const model = monacoApi.editor.createModel(content, monacoLanguageFor(language));
    const editor = monacoApi.editor.create(container, {
      model,
      theme: theme === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      fontSize: codeFontSize,
      fontFamily: "var(--font-mono)",
      minimap: { enabled: true, maxColumn: 80 },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      wordWrap: "off",
      tabSize: 2,
      renderWhitespace: "none",
      padding: { top: 12, bottom: 12 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    monacoSessionRef.current = {
      editor,
      model,
      dispose: () => {
        editor.dispose();
        model.dispose();
      },
    };
  };

  // 退出编辑态 / 卸载 → 释放 editor + model（1G：必须 dispose，否则内存不回收）
  useEffect(() => {
    if (editMode) return;
    const session = monacoSessionRef.current;
    if (session) {
      session.dispose();
      monacoSessionRef.current = null;
    }
  }, [editMode]);

  useEffect(() => {
    return () => {
      monacoSessionRef.current?.dispose();
      monacoSessionRef.current = null;
    };
  }, []);

  // 编辑态内主题切换 → 同步 Monaco 主题
  useEffect(() => {
    if (!editMode || !monacoApi) return;
    monacoApi.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }, [theme, editMode, monacoApi]);

  useEffect(() => {
    monacoSessionRef.current?.editor.updateOptions({
      fontSize: codeFontSize,
      fontFamily: "var(--font-mono)",
    });
  }, [codeFontSize]);

  const codeTheme: CodeTheme = theme === "dark" ? "dark" : "light";
  const tokenLines = tokens?.lines ?? null;
  const tokenFailed = tokens?.failed ?? false;

  const getHtml = (index: number): string => {
    const line = rawLines[index] ?? "";
    // 未知语言（xml 等）tokenize 会返回空 lines；不能当成功高亮，否则预览整页空白
    if (tokenLines && tokenLines.length > 0 && !tokenFailed && index < revealedLines) {
      const html = tokenLineToHtml(tokenLines[index] ?? [], codeTheme);
      return html || plainLineToHtml(line);
    }
    return plainLineToHtml(line);
  };

  const copy = (): void => {
    void navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const virtualizer = useVirtualizer({
    count: rawLines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => codeFontSize * 1.65,
    overscan: 40,
    enabled: useVirtual,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [codeFontSize, virtualizer]);

  const toolbar = (
    <div className="code-view-toolbar">
      <span className="code-view-badge">{languageBadge(language)}</span>
      <span className="code-view-stats">
        {rawLines.length.toLocaleString()} 行
        {highlighting && !policy.plainText && (
          <span className="code-view-status">高亮中…</span>
        )}
        {policy.plainText && (
          <span className="code-view-status" title={policy.reason ?? undefined}>
            纯文本
          </span>
        )}
      </span>
      <div className="code-view-actions">
        <button type="button" className="code-view-btn" data-action="copy" onClick={copy} title="复制代码">
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
        <button
          type="button"
          className="code-view-btn"
          data-action="edit"
          onClick={() => setEditMode(true)}
          disabled={policy.editDisabled}
          title={policy.editDisabled ? policy.reason ?? "编辑不可用" : "用 Monaco 编辑（首次加载较慢）"}
        >
          <IconPencil size={13} />
          {editMode ? "编辑中" : "编辑"}
        </button>
      </div>
    </div>
  );

  if (editMode) {
    return (
      <div className="code-view code-view--edit">
        <div className="code-view-toolbar code-view-toolbar--edit">
          <span className="code-view-badge">Monaco</span>
          <span className="code-view-stats">
            编辑预览（Wave 5A：内容不写回，可复制/下载）
          </span>
          <div className="code-view-actions">
            <button type="button" className="code-view-btn" data-action="copy-edit" onClick={copy} title="复制代码">
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
              {copied ? "已复制" : "复制"}
            </button>
            <button
              type="button"
              className="code-view-btn"
              data-action="exit-edit"
              onClick={() => setEditMode(false)}
              title="退出编辑（释放 Monaco）"
            >
              退出编辑
            </button>
          </div>
        </div>
        {editLoading ? (
          <div className="code-view-edit-loading">正在加载编辑器（首次约 0.5-1s）…</div>
        ) : (
          <div
            ref={(el) => {
              editContainerRef.current = el;
              if (el) ensureMonacoEditor();
            }}
            className="code-view-edit-container"
          />
        )}
      </div>
    );
  }

  if (!useVirtual) {
    return (
      <div className="code-view">
        {toolbar}
        <div className="code-view-body">
          {rawLines.map((_, i) => (
            <CodeLine key={i} index={i} html={getHtml(i)} />
          ))}
        </div>
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} className="code-view code-view--virtual">
      {toolbar}
      <div className="code-view-virtual-inner" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => (
          <div
            key={item.key}
            className="code-view-virtual-row"
            style={{
              height: item.size,
              transform: `translateY(${item.start}px)`,
            }}
          >
            <CodeLine index={item.index} html={getHtml(item.index)} />
          </div>
        ))}
      </div>
    </div>
  );
}
