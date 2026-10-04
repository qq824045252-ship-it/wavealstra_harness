import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact } from "@/types";
import { useAppStore } from "@/store/appStore";
import {
  artifactToRefFile,
  copyArtifact,
  downloadArtifact,
  findTextMatches,
  isTextualArtifact,
  openArtifactInSystem,
  revealArtifactInFolder,
  scrollArtifactBodyToOffset,
} from "@/lib/artifactActions";
import { canNativeDrag, startNativeFileDrag } from "@/lib/nativeFileDrag";
import {
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconDownload,
  IconOpenExternal,
  IconMore,
  IconSearch,
  IconX,
} from "@/components/common/icons";

interface Props {
  artifact: Artifact;
}

export default function FileActionBar({ artifact }: Props): React.JSX.Element {
  const attachArtifactToChat = useAppStore((s) => s.attachArtifactToChat);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [openHint, setOpenHint] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const canSearch = isTextualArtifact(artifact.kind) && Boolean(artifact.content);
  const matches = useMemo(
    () => (searchOpen && canSearch ? findTextMatches(artifact.content, query) : []),
    [artifact.content, canSearch, query, searchOpen],
  );

  // 切换产物时关闭搜索 / 重置提示
  useEffect(() => {
    setSearchOpen(false);
    setQuery("");
    setMatchIndex(0);
    setCopied(false);
    setSent(false);
    setOpenHint("");
    setMoreOpen(false);
  }, [artifact.id]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchOpen]);

  // 命中列表变化时钳制当前索引
  useEffect(() => {
    if (matches.length === 0) {
      setMatchIndex(0);
      return;
    }
    setMatchIndex((i) => Math.min(i, matches.length - 1));
  }, [matches.length]);

  // 跳转到当前命中
  useEffect(() => {
    if (!searchOpen || matches.length === 0) return;
    const m = matches[matchIndex];
    if (!m) return;
    scrollArtifactBodyToOffset(m.index, artifact.content.length);
  }, [artifact.content.length, matchIndex, matches, searchOpen]);

  // 点击外部关闭「更多」菜单
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  // Ctrl/Cmd+F 打开文档内搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        const panel = document.querySelector(".artifact-panel");
        if (!panel) return;
        e.preventDefault();
        if (!canSearch) return;
        setSearchOpen(true);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSearch, searchOpen]);

  const goMatch = useCallback(
    (delta: number): void => {
      if (matches.length === 0) return;
      setMatchIndex((i) => (i + delta + matches.length) % matches.length);
    },
    [matches.length],
  );

  const handleOpenFile = useCallback(async (): Promise<void> => {
    setOpenHint("");
    const ok = await openArtifactInSystem(artifact);
    if (!ok) {
      setOpenHint(artifact.path ? "打开失败" : "无磁盘路径，无法打开");
      window.setTimeout(() => setOpenHint(""), 2500);
    }
  }, [artifact]);

  const handleReveal = useCallback(async (): Promise<void> => {
    setMoreOpen(false);
    setOpenHint("");
    const ok = await revealArtifactInFolder(artifact);
    if (!ok) {
      setOpenHint(artifact.path ? "定位失败" : "无磁盘路径，无法定位");
      window.setTimeout(() => setOpenHint(""), 2500);
    }
  }, [artifact]);

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await copyArtifact(artifact);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setOpenHint("复制失败");
      window.setTimeout(() => setOpenHint(""), 2000);
    }
  }, [artifact]);

  const handleDownload = useCallback((): void => {
    if (!artifact.content) {
      setOpenHint("内容尚未加载");
      window.setTimeout(() => setOpenHint(""), 2000);
      return;
    }
    downloadArtifact(artifact);
  }, [artifact]);

  const handleSendToChat = useCallback((): void => {
    const ok = attachArtifactToChat(artifactToRefFile(artifact));
    if (!ok) {
      setOpenHint("发送失败");
      window.setTimeout(() => setOpenHint(""), 2000);
      return;
    }
    setSent(true);
    setOpenHint("已加入对话");
    window.setTimeout(() => {
      setSent(false);
      setOpenHint("");
    }, 1800);
  }, [artifact, attachArtifactToChat]);

  const toggleSearch = (): void => {
    if (!canSearch) {
      setOpenHint("当前类型不支持全文搜索");
      window.setTimeout(() => setOpenHint(""), 2000);
      return;
    }
    setSearchOpen((v) => {
      if (v) setQuery("");
      return !v;
    });
  };

  const pathTitle = artifact.path
    ? `用系统默认应用打开\n${artifact.path}`
    : "用系统默认应用打开（无磁盘路径）";
  const dragEnabled = canNativeDrag(artifact.path);

  return (
    <div className="extension-file-action-wrap">
      <div className="extension-file-action-bar">
        <span
          className={`extension-file-action-name${dragEnabled ? " is-draggable" : ""}`}
          title={
            dragEnabled
              ? `${artifact.path}\n可拖到桌面或其它应用`
              : artifact.path || artifact.name
          }
          draggable={dragEnabled}
          onDragStart={(e) => {
            if (!startNativeFileDrag(e, artifact.path)) e.preventDefault();
          }}
        >
          {artifact.name}
        </span>
        {openHint && <span className="extension-file-action-hint">{openHint}</span>}
        <div className="extension-file-action-tools">
          <button
            type="button"
            className={`icon-btn ${searchOpen ? "active" : ""}`}
            title={canSearch ? "搜索 (Ctrl+F)" : "当前类型不支持全文搜索"}
            onClick={toggleSearch}
            disabled={!canSearch && !searchOpen}
          >
            <IconSearch size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={pathTitle}
            onClick={() => void handleOpenFile()}
            disabled={!artifact.path}
          >
            <IconOpenExternal size={15} />
          </button>
          <button
            type="button"
            className={`icon-btn ${sent ? "active" : ""}`}
            title={
              artifact.path
                ? `发送到对话\n${artifact.path}`
                : "发送到对话（作为引用文件加入输入框）"
            }
            onClick={handleSendToChat}
          >
            {sent ? <IconCheck size={15} /> : <IconArrowUpRight size={15} />}
          </button>
          <button
            type="button"
            className="icon-btn"
            title={copied ? "已复制" : "复制"}
            onClick={() => void handleCopy()}
          >
            {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="下载"
            onClick={handleDownload}
            disabled={!artifact.content}
          >
            <IconDownload size={15} />
          </button>
          <div className="extension-file-more" ref={moreRef}>
            <button
              type="button"
              className={`icon-btn ${moreOpen ? "active" : ""}`}
              title="更多"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <IconMore size={15} />
            </button>
            {moreOpen && (
              <div className="extension-file-more-menu" role="menu">
                <button
                  type="button"
                  className="extension-file-more-item"
                  role="menuitem"
                  disabled={!artifact.path}
                  onClick={() => void handleReveal()}
                >
                  在资源管理器中显示
                </button>
                <button
                  type="button"
                  className="extension-file-more-item"
                  role="menuitem"
                  disabled={!artifact.path}
                  onClick={() => {
                    setMoreOpen(false);
                    void handleOpenFile();
                  }}
                >
                  用系统应用打开
                </button>
                {artifact.path && (
                  <button
                    type="button"
                    className="extension-file-more-item"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      void navigator.clipboard.writeText(artifact.path ?? "");
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    复制文件路径
                  </button>
                )}
                <button
                  type="button"
                  className="extension-file-more-item"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    handleSendToChat();
                  }}
                >
                  发送到对话
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {searchOpen && (
        <div className="extension-file-search-bar">
          <IconSearch size={14} className="extension-file-search-icon" />
          <input
            ref={searchInputRef}
            className="extension-file-search-input"
            value={query}
            placeholder="在文档中搜索…"
            aria-label="在文档中搜索"
            onChange={(e) => {
              setQuery(e.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goMatch(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                setSearchOpen(false);
                setQuery("");
              }
            }}
          />
          <span className="extension-file-search-count" aria-live="polite">
            {query.trim()
              ? matches.length > 0
                ? `${matchIndex + 1}/${matches.length}`
                : "无结果"
              : ""}
          </span>
          <button
            type="button"
            className="icon-btn"
            title="上一个 (Shift+Enter)"
            disabled={matches.length === 0}
            onClick={() => goMatch(-1)}
          >
            <IconChevronUp size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="下一个 (Enter)"
            disabled={matches.length === 0}
            onClick={() => goMatch(1)}
          >
            <IconChevronDown size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="关闭搜索"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
          >
            <IconX size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
