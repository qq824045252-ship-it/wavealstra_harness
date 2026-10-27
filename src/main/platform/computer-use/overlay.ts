import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import type { ComputerUsePhase } from "../../capabilities/ComputerUsePolicy";
import type { WindowInfo } from "./protocol";
import { supportsComputerUseActivityNotice, supportsComputerUseOverlay } from "./support";
import { createActivityNotice, type ActivityNotice } from "./linux/activityNotice";
import { createCulIndicator, type CulIndicator } from "./linux/culIndicator";

interface CursorState {
  x: number;
  y: number;
  clicking?: boolean;
}

interface OverlayState {
  taskId: string;
  target?: WindowInfo;
  screenBoundsDip?: { x: number; y: number; width: number; height: number };
  phase: ComputerUsePhase;
  action: string;
  cursor?: CursorState;
  screenCursorDip?: { x: number; y: number; clicking?: boolean };
}

type AbortHandler = (taskId: string) => void | Promise<void>;

const OVERLAY_TITLE = "__MYBUDDY_COMPUTER_USE_OVERLAY__";
const CONTROLS_TITLE = "__MYBUDDY_COMPUTER_USE_CONTROLS__";

/**
 * Windows 才是真正的 overlay（透明分层窗口 + WGC 命中测试）；平台判断收敛到
 * src/main/platform/computer-use，服务层不再直接看 process.platform。
 */
function overlaySupported(): boolean {
  return Boolean(process.versions.electron) && supportsComputerUseOverlay();
}

/**
 * Linux 上的替代：不画窗口外框，但会用 CUL 原生 indicator（layer-shell 光晕 + pill）
 * 按 phase 显示"正在操作"；indicator 不可用时回落到 `hyprctl notify`。
 * 为什么不能画外框见 `../support.ts` 里 `supportsComputerUseOverlay` 的注释
 * （会污染 agent 自己的截图、分数缩放下铺不满、CUL indicator 没有控制通道）。
 */
function activityNoticeSupported(): boolean {
  return supportsComputerUseActivityNotice();
}

function phaseLabel(phase: ComputerUsePhase): string {
  switch (phase) {
    case "observing": return "观察界面";
    case "acting": return "正在操作";
    case "verifying": return "验证结果";
    case "waiting": return "等待下一步";
    case "recovering": return "重新定位";
    case "completed": return "操作完成";
    case "failed": return "操作受阻";
  }
}

function documentUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const BORDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>${OVERLAY_TITLE}</title><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none;font-family:Inter,"Segoe UI",sans-serif}
#frame{position:absolute;inset:0;border:3px solid rgba(91,141,255,.96);border-radius:10px;box-sizing:border-box;box-shadow:inset 0 0 0 1px rgba(255,255,255,.48),0 0 18px rgba(91,141,255,.32);transition:border-color .16s ease,box-shadow .16s ease,opacity .16s ease}
#frame::before{content:"";position:absolute;inset:-3px;border-radius:10px;background:linear-gradient(90deg,rgba(91,141,255,.08),rgba(112,91,255,.26),rgba(91,141,255,.08));opacity:.45;animation:sweep 1.8s linear infinite;z-index:-1}
#cursor{position:absolute;width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,.98);border:3px solid rgba(73,116,255,.98);box-shadow:0 2px 12px rgba(20,40,100,.35);transform:translate(-50%,-50%);opacity:0;transition:left .08s linear,top .08s linear,opacity .12s ease}
#cursor::after{content:"";position:absolute;inset:-9px;border:2px solid rgba(91,141,255,.40);border-radius:50%;opacity:0}
body.clicking #cursor::after{animation:ripple .42s ease-out}
body[data-phase="verifying"] #frame{border-color:rgba(67,178,132,.98);box-shadow:inset 0 0 0 1px rgba(255,255,255,.45),0 0 18px rgba(67,178,132,.30)}
body[data-phase="recovering"] #frame{border-color:rgba(240,174,61,.98);box-shadow:inset 0 0 0 1px rgba(255,255,255,.45),0 0 18px rgba(240,174,61,.32)}
body[data-phase="failed"] #frame{border-color:rgba(232,85,85,.98);box-shadow:inset 0 0 0 1px rgba(255,255,255,.45),0 0 18px rgba(232,85,85,.30)}
body[data-phase="completed"] #frame{opacity:.58}
@keyframes ripple{0%{transform:scale(.5);opacity:.9}100%{transform:scale(1.9);opacity:0}}
@keyframes sweep{0%{transform:translateX(-45%)}100%{transform:translateX(45%)}}
</style></head><body data-phase="observing"><div id="frame"></div><div id="cursor"></div><script>
window.__setComputerOverlay=(state)=>{document.body.dataset.phase=state.phase||"observing";const c=document.getElementById("cursor");if(state.cursor){c.style.left=state.cursor.x+"px";c.style.top=state.cursor.y+"px";c.style.opacity="1"}else{c.style.opacity="0"}document.body.classList.toggle("clicking",!!state.cursor?.clicking);if(state.cursor?.clicking){setTimeout(()=>document.body.classList.remove("clicking"),430)}};
</script></body></html>`;

const CONTROLS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>${CONTROLS_TITLE}</title><style>
html,body{margin:0;background:transparent;font-family:Inter,"Segoe UI",sans-serif;overflow:hidden}
#pill{height:36px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 8px 0 12px;border-radius:18px;background:rgba(25,28,36,.92);color:#fff;box-shadow:0 5px 18px rgba(0,0,0,.22);font-size:12px;white-space:nowrap;user-select:none}
#spark{font-size:14px;color:#9bb7ff}#state{font-weight:600}#target{max-width:150px;overflow:hidden;text-overflow:ellipsis;color:rgba(255,255,255,.68)}
a{margin-left:auto;text-decoration:none;color:#fff;background:rgba(255,255,255,.13);padding:5px 10px;border-radius:12px;font-weight:600}a:hover{background:rgba(255,255,255,.22)}
body[data-phase="recovering"] #spark{color:#f0ae3d}body[data-phase="failed"] #spark{color:#e85555}body[data-phase="verifying"] #spark{color:#43b284}
</style></head><body data-phase="observing"><div id="pill"><span id="spark">✦</span><span id="state">MyBuddy 正在操作</span><span id="target"></span><a href="mybuddy-computer-use://stop">停止操作</a></div><script>
window.__setComputerControls=(state)=>{document.body.dataset.phase=state.phase||"observing";document.getElementById("state").textContent="MyBuddy · "+state.phaseLabel;document.getElementById("target").textContent=state.target||""};
</script></body></html>`;

export class ComputerUseOverlayService {
  /**
   * 平台能力探测：Windows + Electron 运行时画真正的叠加层；Linux 只有阶段通知，
   * 所以也返回 true（用户确实会看到反馈），两者都用 `present()` 驱动。
   */
  get isSupported(): boolean {
    return overlaySupported() || activityNoticeSupported();
  }

  private readonly notice: ActivityNotice = createActivityNotice();
  /** CUL 原生屏幕指示器（layer-shell 光晕 + pill）；不可用时回落到 hyprctl 通知。 */
  private readonly indicator: CulIndicator = createCulIndicator();
  /** 上次通知的阶段+目标，避免同一状态重复刷屏。 */
  private lastNotice: string | null = null;

  /**
   * Linux 的反馈：优先用 CUL 原生 indicator（屏幕边缘光晕 + pill，真实视觉反馈），
   * 不可用时回落到 `hyprctl notify`（中文文案）。
   *
   * 为什么不担心污染 agent 截图：indicator 在 CUL 截图期间被 `.capture` flock 挡住，
   * 实测返回图里指示器像素为 0（见 culIndicator.ts 的注释）。
   */
  private showNotice(state: { taskId: string; phase: ComputerUsePhase; action: string; target?: WindowInfo }): void {
    if (!activityNoticeSupported()) return;
    const target = state.target?.title || state.target?.processName;
    const terminal = state.phase === "completed" || state.phase === "failed";
    // 英文 pill 能表达过程阶段；终态同时保留中文通知。
    if (this.indicator.show(state.phase)) {
      if (terminal) {
        if (this.notice.available) this.notice.show(state.phase, target);
        this.indicator.stop();
      }
      return;
    }
    if (!this.notice.available) return;
    const key = `${state.taskId}|${state.phase}|${target ?? ""}`;
    if (this.lastNotice === key) return;
    this.lastNotice = key;
    this.notice.show(state.phase, target);
  }

  private border: ElectronBrowserWindow | null = null;
  private controls: ElectronBrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private current: OverlayState | null = null;
  private abortHandler: AbortHandler | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private hitTestTimer: NodeJS.Timeout | null = null;

  setAbortHandler(handler: AbortHandler | null): void {
    this.abortHandler = handler;
  }

  present(state: OverlayState): void {
    if (!overlaySupported()) {
      this.showNotice(state);
      return;
    }
    this.current = state;
    this.generation += 1;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.startStopHitTest();
    void this.render(state);
  }

  presentDesktop(input: { taskId: string; phase: ComputerUsePhase; action: string; xPhysical?: number; yPhysical?: number; clicking?: boolean }): void {
    if (!overlaySupported()) {
      this.showNotice({ taskId: input.taskId, phase: input.phase, action: input.action });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { screen } = require("electron") as typeof import("electron");
    let cursorDip = screen.getCursorScreenPoint();
    if (Number.isFinite(input.xPhysical) && Number.isFinite(input.yPhysical)) {
      try {
        cursorDip = screen.screenToDipPoint({ x: Number(input.xPhysical), y: Number(input.yPhysical) });
      } catch {
        // getCursorScreenPoint is already a valid DIP fallback.
      }
    }
    const display = screen.getDisplayNearestPoint(cursorDip);
    this.present({
      taskId: input.taskId,
      phase: input.phase,
      action: input.action,
      screenBoundsDip: { ...display.bounds },
      screenCursorDip: { x: cursorDip.x, y: cursorDip.y, clicking: input.clicking },
    });
  }

  settle(taskId: string, phase: "completed" | "failed", delayMs = phase === "completed" ? 900 : 1_800): void {
    if (!overlaySupported()) {
      // Linux：已完成/受阻各发一条终态通知；idle 后清掉 lastNotice，让下一轮能再提示。
      this.showNotice({ taskId, phase, action: "settle" });
      setTimeout(() => { if (this.current === null && !overlaySupported()) this.lastNotice = null; }, delayMs).unref?.();
      return;
    }
    if (this.current?.taskId !== taskId) return;
    const generation = ++this.generation;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const current = { ...this.current, phase } as OverlayState;
    this.current = current;
    void this.render(current);
    this.hideTimer = setTimeout(() => {
      if (this.generation !== generation) return;
      this.hide();
    }, delayMs);
  }

  waitForNextStep(taskId: string, delayMs = 260): void {
    if (!overlaySupported()) {
      // Linux 没有常驻 overlay，"等待下一步" 不发通知：下一步马上会发自己的。
      return;
    }
    if (this.current?.taskId !== taskId) return;
    const generation = this.generation;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.generation !== generation || this.current?.taskId !== taskId) return;
      const current = { ...this.current, phase: "waiting", cursor: undefined } as OverlayState;
      this.current = current;
      void this.render(current);
      this.hideTimer = null;
    }, delayMs);
  }

  hide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.current = null;
    this.lastNotice = null;
    this.indicator.stop();
    this.stopStopHitTest();
    if (this.controls && !this.controls.isDestroyed()) this.controls.setIgnoreMouseEvents(true, { forward: true });
    for (const win of [this.border, this.controls]) {
      if (win && !win.isDestroyed()) win.hide();
    }
  }

  dispose(): void {
    this.generation += 1;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.current = null;
    this.lastNotice = null;
    this.indicator.stop();
    this.stopStopHitTest();
    for (const win of [this.border, this.controls]) {
      if (win && !win.isDestroyed()) win.destroy();
    }
    this.border = null;
    this.controls = null;
    this.ready = null;
  }

  private async ensureWindows(): Promise<void> {
    if (!overlaySupported()) return;
    if (this.border && !this.border.isDestroyed() && this.controls && !this.controls.isDestroyed()) return;
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { BrowserWindow } = require("electron") as typeof import("electron");
      const common = {
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        show: false,
        hasShadow: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      } as const;
      const border = new BrowserWindow({ ...common, focusable: false, width: 100, height: 100, title: OVERLAY_TITLE });
      const controls = new BrowserWindow({ ...common, focusable: false, width: 330, height: 36, title: CONTROLS_TITLE });
      this.border = border;
      this.controls = controls;
      border.setIgnoreMouseEvents(true, { forward: true });
      controls.setIgnoreMouseEvents(true, { forward: true });
      border.setAlwaysOnTop(true, "screen-saver");
      controls.setAlwaysOnTop(true, "screen-saver");
      border.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      controls.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      border.setContentProtection(true);
      controls.setContentProtection(true);
      controls.webContents.on("will-navigate", (event, url) => {
        if (url !== "mybuddy-computer-use://stop") return;
        event.preventDefault();
        const taskId = this.current?.taskId;
        if (!taskId) return;
        void Promise.resolve(this.abortHandler?.(taskId)).catch((error) => {
          console.error("[ComputerUseOverlay] stop failed", error);
        });
        this.settle(taskId, "failed", 500);
      });
      await Promise.all([border.loadURL(documentUrl(BORDER_HTML)), controls.loadURL(documentUrl(CONTROLS_HTML))]);
    })().finally(() => { this.ready = null; });
    return this.ready;
  }

  private dipBounds(window: WindowInfo): { x: number; y: number; width: number; height: number } {
    // Frame the controlled window, not the whole monitor: with an attached app
    // session the user should see exactly which application is being driven.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { screen } = require("electron") as typeof import("electron");
    const rect = window.windowRect;
    try {
      const topLeft = screen.screenToDipPoint({ x: rect.left, y: rect.top });
      const bottomRight = screen.screenToDipPoint({ x: rect.right, y: rect.bottom });
      return {
        x: Math.round(topLeft.x), y: Math.round(topLeft.y),
        width: Math.max(1, Math.round(bottomRight.x - topLeft.x)),
        height: Math.max(1, Math.round(bottomRight.y - topLeft.y)),
      };
    } catch {
      const scale = window.scaleFactor || 1;
      return {
        x: Math.round(rect.left / scale), y: Math.round(rect.top / scale),
        width: Math.max(1, Math.round(rect.width / scale)), height: Math.max(1, Math.round(rect.height / scale)),
      };
    }
  }

  private cursorInScreen(window: WindowInfo, screenBounds: { x: number; y: number }, cursor?: CursorState): CursorState | undefined {
    if (!cursor) return undefined;
    // `cursor` is client DIP. Convert through the target window's physical client
    // origin into screen DIP, then normalize into the monitor overlay coordinates.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { screen } = require("electron") as typeof import("electron");
    const scale = window.scaleFactor || 1;
    const physical = {
      x: Math.round(window.clientOrigin.x + cursor.x * scale),
      y: Math.round(window.clientOrigin.y + cursor.y * scale),
    };
    try {
      const dip = screen.screenToDipPoint(physical);
      return { x: dip.x - screenBounds.x, y: dip.y - screenBounds.y, clicking: cursor.clicking };
    } catch {
      return {
        x: physical.x / scale - screenBounds.x,
        y: physical.y / scale - screenBounds.y,
        clicking: cursor.clicking,
      };
    }
  }

  private startStopHitTest(): void {
    if (this.hitTestTimer || !overlaySupported()) return;
    this.hitTestTimer = setInterval(() => {
      const controls = this.controls;
      if (!controls || controls.isDestroyed() || !controls.isVisible()) return;
      try {
        // Keep the status pill click-through except for its fixed Stop area.
        // Stop remains available during input injection; an accidental Agent
        // click there safely cancels CU instead of disabling the user's exit.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { screen } = require("electron") as typeof import("electron");
        const point = screen.getCursorScreenPoint();
        const bounds = controls.getBounds();
        const overStop = point.x >= bounds.x + bounds.width - 72
          && point.x < bounds.x + bounds.width
          && point.y >= bounds.y
          && point.y < bounds.y + bounds.height;
        controls.setIgnoreMouseEvents(!overStop, { forward: true });
      } catch {
        controls.setIgnoreMouseEvents(true, { forward: true });
      }
    }, 50);
  }

  private stopStopHitTest(): void {
    if (!this.hitTestTimer) return;
    clearInterval(this.hitTestTimer);
    this.hitTestTimer = null;
  }

  private async render(state: OverlayState): Promise<void> {
    await this.ensureWindows();
    const border = this.border;
    const controls = this.controls;
    if (!border || border.isDestroyed() || !controls || controls.isDestroyed()) return;
    if (this.current !== state) return;
    const bounds = state.screenBoundsDip ?? (state.target ? this.dipBounds(state.target) : undefined);
    if (!bounds) return;
    border.setBounds(bounds, false);
    const toolbarWidth = Math.min(360, Math.max(250, bounds.width));
    const toolbarX = Math.round(bounds.x + Math.max(0, (bounds.width - toolbarWidth) / 2));
    // Keep the controls visible: prefer just above a window-level frame, fall
    // back to inside the frame when the window touches the top edge.
    const toolbarY = bounds.y >= 44 ? bounds.y - 44 : bounds.y + 8;
    controls.setBounds({ x: toolbarX, y: toolbarY, width: toolbarWidth, height: 36 }, false);
    const cursor = state.screenCursorDip
      ? {
          x: state.screenCursorDip.x - bounds.x,
          y: state.screenCursorDip.y - bounds.y,
          clicking: state.screenCursorDip.clicking,
        }
      : state.target
        ? this.cursorInScreen(state.target, bounds, state.cursor)
        : undefined;
    const borderState = JSON.stringify({ phase: state.phase, cursor });
    const controlState = JSON.stringify({
      phase: state.phase,
      phaseLabel: phaseLabel(state.phase),
      target: (state.target?.title || state.target?.processName || "Windows").slice(0, 42),
    });
    await Promise.all([
      border.webContents.executeJavaScript(`window.__setComputerOverlay?.(${borderState})`, true).catch(() => undefined),
      controls.webContents.executeJavaScript(`window.__setComputerControls?.(${controlState})`, true).catch(() => undefined),
    ]);
    if (this.current !== state) return;
    if (!border.isVisible()) border.showInactive();
    if (!controls.isVisible()) controls.showInactive();
  }
}

export const computerUseOverlayService = new ComputerUseOverlayService();
