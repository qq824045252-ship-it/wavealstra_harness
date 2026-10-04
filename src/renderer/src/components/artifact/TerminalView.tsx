/**
 * TerminalView — 扩展栏「终端」（P0）
 *
 * - xterm.js + fit addon；面板 resize（ResizeObserver + debounce）→ pty resize
 * - 输出经 TerminalHost 有序 batching → onData；挂载时先订阅再 open（回放不丢）
 * - 任务切换：PTY 在主进程按 owner 保活；切回 attach 时回放 ring 尾部
 * - 空间任务：cwd = 空间绑定文件夹（workspace owner）；独立任务仍走任务权威 cwd
 * - 基础复制粘贴（Ctrl+Shift+C/V）、清屏、重启
 * - Chat Context Source：选中文本或最近输出 → 「加入对话」（显式，自动不进上下文）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "@/styles/terminal.css";
import {
  TERMINAL_SESSION_INVALID,
  createBoundedWriter,
  createInputForwarder,
} from "@/lib/terminalBridge";
import {
  TERMINAL_FONT_CANDIDATES,
  pickFirstAvailableFont,
  resolveTerminalFontOptions,
} from "@/lib/terminalFonts";
import { resolveTerminalContrastRatio, resolveTerminalTheme } from "@/lib/terminalTheme";
import { FONT_SETTINGS_EVENT, getAppliedFontSettings } from "@/lib/fontSettings";
import { resolveTerminalUiOwner, terminalUiSpawnKey } from "@/lib/terminalOwner";
import { useAppStore } from "@/store/appStore";
import {
  IconArrowUpRight,
  IconCode,
  IconEraser,
  IconFolder,
  IconRefresh,
  IconStop,
  IconX,
} from "@/components/common/icons";
import {
  sameTerminalOwner,
  terminalOwnerStoreKey,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalOwnerIds,
} from "../../../../shared/terminal-ipc";

const TERMINAL_CONTEXT_TAIL_BYTES = 8 * 1024;

function detectNerdFont(): string | null {
  return pickFirstAvailableFont(TERMINAL_FONT_CANDIDATES, (spec) => document.fonts.check(spec));
}

function applyTerminalFont(term: Terminal, nerdFont: string | null): void {
  const opts = resolveTerminalFontOptions(nerdFont, getAppliedFontSettings());
  term.options.fontFamily = opts.fontFamily;
  term.options.fontSize = opts.fontSize;
  term.options.lineHeight = opts.lineHeight;
  term.options.rescaleOverlappingGlyphs = opts.rescaleOverlappingGlyphs;
}

function applyTerminalTheme(term: Terminal, appTheme: string): void {
  term.options.theme = resolveTerminalTheme(appTheme);
  term.options.minimumContrastRatio = resolveTerminalContrastRatio(appTheme);
}

function baseNameOf(p: string | undefined): string {
  if (!p) return "";
  const parts = p.replaceAll("\\", "/").split("/");
  return parts[parts.length - 1] ?? "";
}

export default function TerminalView(): React.JSX.Element {
  const page = useAppStore((s) => s.page);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const draftSpaceId = useAppStore((s) => s.draft?.spaceId);
  const tasks = useAppStore((s) => s.tasks);
  const spaces = useAppStore((s) => s.spaces);
  const theme = useAppStore((s) => s.theme);
  const terminalSessions = useAppStore((s) => s.terminalSessions);
  const attachTerminalContext = useAppStore((s) => s.attachTerminalContext);

  const activeTask = useMemo(
    () => (activeTaskId ? tasks.find((t) => t.id === activeTaskId) : undefined),
    [activeTaskId, tasks],
  );
  const workspaceId =
    (page === "workspace" ? activeWorkspaceId : null) || activeTask?.spaceId || draftSpaceId || null;
  const space = useMemo(
    () => (workspaceId ? spaces.find((s) => s.id === workspaceId) : undefined),
    [workspaceId, spaces],
  );
  const uiOwner = useMemo(
    () =>
      resolveTerminalUiOwner({
        activeTaskId,
        activeWorkspaceId: page === "workspace" ? activeWorkspaceId : null,
        taskSpaceId: activeTask?.spaceId,
        draftSpaceId,
        space: space ? { id: space.id, path: space.path, pathMissing: space.pathMissing } : null,
      }),
    [activeTaskId, page, activeWorkspaceId, activeTask?.spaceId, draftSpaceId, space],
  );
  const spawnKey = terminalUiSpawnKey(uiOwner);
  const workspacePathKey = uiOwner.kind === "workspace" ? `${space?.path ?? ""}|${space?.pathMissing ? "1" : "0"}` : "";
  const ownerIds = useMemo((): TerminalOwnerIds | null => {
    if (!spawnKey) return null;
    if (spawnKey.startsWith("ws:")) return { workspaceId: spawnKey.slice(3) };
    if (spawnKey.startsWith("task:")) return { taskId: spawnKey.slice(5) };
    return null;
  }, [spawnKey]);
  const sessionKey = ownerIds ? terminalOwnerStoreKey(ownerIds) : null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const ownerIdsRef = useRef<TerminalOwnerIds | null>(null);
  const activeTaskIdRef = useRef<string | null>(activeTaskId ?? null);
  /** 挂载代数：每次 effect 启动/清理自增，旧 openSession 异步返回按代数丢弃 */
  const mountEpochRef = useRef(0);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState("");
  const [bindError, setBindError] = useState("");
  const [herdrLaunching, setHerdrLaunching] = useState(false);

  activeTaskIdRef.current = activeTaskId ?? null;
  ownerIdsRef.current = ownerIds;

  const sessionInfo = sessionKey ? terminalSessions[sessionKey] : undefined;
  const alive = Boolean(sessionInfo?.alive);

  const openSession = useCallback(
    async (ids: TerminalOwnerIds, cols: number, rows: number, epoch?: number): Promise<void> => {
      try {
        const info = await window.api?.terminal?.open({ ...ids, cols, rows });
        if (epoch !== undefined && epoch !== mountEpochRef.current) return;
        if (!info) return;
        sessionIdRef.current = info.sessionId;
        useAppStore.getState().setTerminalSession(info);
        setError("");
      } catch (err) {
        if (epoch !== undefined && epoch !== mountEpochRef.current) return;
        sessionIdRef.current = null;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  /* 挂载：创建 xterm + 订阅 data/exit + 打开当前 owner 会话 */
  useEffect(() => {
    if (!spawnKey || !ownerIds) return;

    const container = containerRef.current;
    if (!container || !window.api?.terminal) return;

    const epoch = ++mountEpochRef.current;
    ownerIdsRef.current = ownerIds;

    const initialFonts = resolveTerminalFontOptions(detectNerdFont(), getAppliedFontSettings());
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: initialFonts.fontSize,
      fontFamily: initialFonts.fontFamily,
      lineHeight: initialFonts.lineHeight,
      rescaleOverlappingGlyphs: initialFonts.rescaleOverlappingGlyphs,
      minimumContrastRatio: resolveTerminalContrastRatio(theme),
      scrollback: 4000,
      theme: resolveTerminalTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitAddonRef.current = fit;
    term.open(container);
    term.focus();
    try {
      fit.fit();
    } catch {
      /* 面板尚未布局完：由 ResizeObserver / lateSync 兜底 */
    }
    void document.fonts.ready.then(() => {
      if (epoch !== mountEpochRef.current) return;
      applyTerminalFont(term, detectNerdFont());
      try {
        fit.fit();
      } catch {
        /* 面板尚未布局完：由 ResizeObserver / lateSync 兜底 */
      }
    });

    const offInput = term.onData(
      createInputForwarder({
        getOwner: () => ownerIdsRef.current,
        getSessionId: () => sessionIdRef.current,
        sendInput: (req) => window.api?.terminal?.input(req),
      }),
    );

    term.attachCustomKeyEventHandler((event) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return true;
      const key = event.key.toLowerCase();
      if (key === "c") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
        return false;
      }
      if (key === "v") {
        void navigator.clipboard.readText().then((text) => term.paste(text));
        return false;
      }
      return true;
    });

    const writer = createBoundedWriter(
      (data, cb) => term.write(data, cb),
      8 * 1024 * 1024,
      () => console.warn("[terminal] 输出积压超过 8MB 安全水位，已丢弃后续输出"),
    );
    const offData = window.api.terminal.onData((ev: TerminalDataEvent) => {
      const current = ownerIdsRef.current;
      if (!current || !sameTerminalOwner(ev, current)) return;
      if (sessionIdRef.current && ev.sessionId !== sessionIdRef.current) return;
      writer.write(ev.data);
    });
    const offExit = window.api.terminal.onExit((ev: TerminalExitEvent) => {
      useAppStore.getState().applyTerminalExit(ev);
      const current = ownerIdsRef.current;
      if (!current || !sameTerminalOwner(ev, current)) return;
      if (sessionIdRef.current && ev.sessionId !== sessionIdRef.current) return;
      term.write(`\r\n\x1b[90m[进程已退出 code=${ev.exitCode ?? "?"}]\x1b[0m\r\n`);
    });

    const reportSize = (): void => {
      let dims: { cols: number; rows: number } | undefined;
      try {
        dims = fit.proposeDimensions() ?? undefined;
      } catch {
        return;
      }
      if (!dims || dims.cols <= 0 || dims.rows <= 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const current = ownerIdsRef.current;
      const sid = sessionIdRef.current;
      if (current && sid) {
        window.api?.terminal?.resize({ ...current, sessionId: sid, cols: dims.cols, rows: dims.rows });
      }
    };
    const scheduleResize = (): void => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(reportSize, 80);
    };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(container);
    window.addEventListener("resize", scheduleResize);
    const onFontSettings = (): void => {
      applyTerminalFont(term, detectNerdFont());
      scheduleResize();
    };
    window.addEventListener(FONT_SETTINGS_EVENT, onFontSettings);
    const lateSync = setTimeout(reportSize, 220);

    const initialDims = fit.proposeDimensions();
    void openSession(ownerIds, initialDims?.cols || 80, initialDims?.rows || 24, epoch);

    return () => {
      mountEpochRef.current += 1;
      sessionIdRef.current = null;
      observer.disconnect();
      window.removeEventListener("resize", scheduleResize);
      window.removeEventListener(FONT_SETTINGS_EVENT, onFontSettings);
      clearTimeout(lateSync);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      offInput.dispose();
      offData();
      offExit();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [spawnKey, workspacePathKey]);

  useEffect(() => {
    const term = termRef.current;
    if (term) applyTerminalTheme(term, theme);
  }, [theme]);

  const restart = useCallback(async () => {
    const ids = ownerIdsRef.current;
    if (!ids) return;
    const epochAtCall = mountEpochRef.current;
    sessionIdRef.current = TERMINAL_SESSION_INVALID;
    termRef.current?.reset();
    termRef.current?.clear();
    const dims = fitAddonRef.current?.proposeDimensions();
    const cols = dims?.cols || 80;
    const rows = dims?.rows || 24;
    try {
      const info = await window.api?.terminal?.restart({ ...ids, cols, rows });
      if (epochAtCall !== mountEpochRef.current) return;
      if (!info) return;
      sessionIdRef.current = info.sessionId;
      useAppStore.getState().setTerminalSession(info);
      setError("");
    } catch (err) {
      if (epochAtCall !== mountEpochRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const launchHerdr = useCallback(async () => {
    const ids = ownerIdsRef.current;
    const sessionId = sessionIdRef.current;
    if (!ids?.workspaceId || !sessionId || sessionId === TERMINAL_SESSION_INVALID) return;
    setHerdrLaunching(true);
    setError("");
    try {
      const prepared = await window.api?.terminal?.prepareHerdr({ workspaceId: ids.workspaceId });
      if (!prepared?.ok) throw new Error(prepared?.error || "Herdr workspace 准备失败");
      // Herdr workspace 已由主进程在当前 MyBuddy 空间专属 session 中准备好。
      // TUI 仍在可见 PTY 内启动；不触碰用户自己的 Herdr default session。
      if (!prepared.sessionName) throw new Error("Herdr session 准备结果无效");
      const herdrCommand = "herdr --session " + prepared.sessionName + "\r";
      window.api?.terminal?.input({ ...ids, sessionId, data: herdrCommand });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setHerdrLaunching(false);
    }
  }, []);

  const clearTerminal = useCallback(() => {
    const ids = ownerIdsRef.current;
    if (!ids || !sessionIdRef.current) return;
    termRef.current?.clear();
    window.api?.terminal?.input({
      ...ids,
      sessionId: sessionIdRef.current,
      data: "\x1b[2J\x1b[3J\x1b[H",
    });
  }, []);

  const terminateSession = useCallback(() => {
    const ids = ownerIdsRef.current;
    if (!ids) return;
    window.api?.terminal?.close(ids);
  }, []);

  const closeTerminal = useCallback(() => {
    useAppStore.getState().closePanel();
  }, []);

  const attachToChat = useCallback(async () => {
    const ids = ownerIdsRef.current;
    const taskId = activeTaskIdRef.current;
    if (!ids || !taskId) return;
    const selected = termRef.current?.getSelection()?.trim();
    if (selected) {
      attachTerminalContext({
        taskId,
        workspaceId: ids.workspaceId,
        source: "selection",
        text: selected,
      });
      return;
    }
    const tail = await window.api?.terminal?.tail({ ...ids, maxBytes: TERMINAL_CONTEXT_TAIL_BYTES });
    if (!tail?.text?.trim()) return;
    attachTerminalContext({
      taskId,
      workspaceId: ids.workspaceId,
      source: "recent-output",
      text: tail.text,
    });
  }, [attachTerminalContext]);

  const bindFolder = useCallback(async () => {
    if (uiOwner.kind !== "unbound") return;
    setBindError("");
    const result = await useAppStore.getState().relocateSpace(uiOwner.workspaceId);
    if (result.ok || result.reason === "cancel") return;
    if (result.reason === "occupied") {
      setBindError(`该文件夹已被空间「${result.otherName}」使用`);
      return;
    }
    setBindError("绑定文件夹失败，请稍后重试");
  }, [uiOwner]);

  if (uiOwner.kind === "none") {
    return (
      <div className="extension-body terminal-view">
        <div className="terminal-empty">
          <IconCode size={18} />
          <span>先选择一个任务，再打开终端</span>
        </div>
      </div>
    );
  }

  if (uiOwner.kind === "unbound") {
    const missing = uiOwner.reason === "missing-folder";
    return (
      <div className="extension-body terminal-view">
        <div className="terminal-empty">
          <IconFolder size={18} />
          <span>{missing ? "当前空间尚未绑定文件夹" : "当前空间绑定的文件夹不可用"}</span>
          <span className="terminal-empty-hint">
            {missing
              ? "绑定真实项目目录后，终端会在该目录打开，才能正确运行 herdr / git 等命令。"
              : "原文件夹可能被移动或删除。重新绑定后才会打开终端，避免在错误目录执行命令。"}
          </span>
          <button type="button" className="terminal-empty-action" onClick={() => void bindFolder()}>
            {missing ? "绑定文件夹" : "重新绑定文件夹"}
          </button>
          {bindError && <span className="terminal-empty-error">{bindError}</span>}
        </div>
      </div>
    );
  }

  const cwdLabel = baseNameOf(sessionInfo?.cwd) || (sessionKey?.slice(0, 12) ?? "");
  const shellLabel = baseNameOf(sessionInfo?.shell) || "shell";

  return (
    <div className="extension-body terminal-view">
      <div className="terminal-toolbar">
        <span className="terminal-toolbar-title" title={sessionInfo?.cwd}>
          <IconCode size={13} />
          <span className="terminal-toolbar-name">{cwdLabel}</span>
          <span className="terminal-toolbar-shell">{shellLabel}</span>
          <span className={`terminal-dot ${alive ? "alive" : "dead"}`} title={alive ? "运行中" : "已退出"} />
        </span>
        <span className="terminal-toolbar-actions">
          {uiOwner.kind === "workspace" && (
            <button
              type="button"
              className="terminal-herdr-button"
              title="在当前空间对应的 Herdr workspace 中打开"
              disabled={!alive || herdrLaunching}
              onClick={() => void launchHerdr()}
            >
              {herdrLaunching ? "启动中…" : "Herdr"}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title={
              !activeTaskId
                ? "在任务对话中才能加入聊天"
                : alive
                  ? "把选中文本（无选中则最近输出）加入聊天"
                  : "会话已退出"
            }
            disabled={!alive || !activeTaskId}
            onClick={() => void attachToChat()}
          >
            <IconArrowUpRight size={13} />
          </button>
          <button type="button" className="icon-btn" title="清屏" onClick={clearTerminal}>
            <IconEraser size={13} />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            title="终止会话（结束终端进程，可再重启）"
            disabled={!alive}
            onClick={terminateSession}
          >
            <IconStop size={13} />
          </button>
          <button type="button" className="icon-btn" title="重启终端" onClick={() => void restart()}>
            <IconRefresh size={13} />
          </button>
          {page !== "workspace" && (
          <button
            type="button"
            className="icon-btn"
            title="关闭终端（进程在后台保活，重新打开可恢复会话）"
            onClick={closeTerminal}
          >
            <IconX size={13} />
          </button>
          )}
        </span>
      </div>
      {error && <div className="terminal-error">{error}</div>}
      {sessionInfo && !alive && (
        <div className="terminal-exit-banner">
          会话已退出（code={sessionInfo.exitCode ?? "?"}）
          <button type="button" className="terminal-exit-restart" onClick={() => void restart()}>
            重启
          </button>
        </div>
      )}
      <div ref={containerRef} className="terminal-host" />
      <div className="terminal-hint">Ctrl+Shift+C 复制 · Ctrl+Shift+V 粘贴</div>
    </div>
  );
}
