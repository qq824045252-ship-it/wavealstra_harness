import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComputerUseError } from "../protocol";
import { executableInPath } from "../support";
import { InputGuardian, type InputGuardianApi } from "./inputGuardian";
import { errorText, normalizeKey, throwIfCancelled } from "./nativeHelpers";

const execFileAsync = promisify(execFile);
/** ydotool injects evdev key/button edges only; compositor IPC owns pointer position. */
/** evdev keycode（`/usr/include/linux/input-event-codes.h` 的 `KEY_*`）。 */
export const EVDEV_KEYCODES: Record<string, number> = {
  // 修饰键
  CTRL: 29, SHIFT: 42, ALT: 56, ALTGR: 100, SUPER: 125,
  // 编辑/导航
  RETURN: 28, ENTER: 28, ESCAPE: 1, ESC: 1, TAB: 15, BACKSPACE: 14, SPACE: 57,
  DELETE: 111, INSERT: 110, HOME: 102, END: 107,
  PAGE_UP: 104, PAGEUP: 104, PAGE_DOWN: 109, PAGEDOWN: 109,
  UP: 103, DOWN: 108, LEFT: 105, RIGHT: 106,
  PRINT: 99, CAPS_LOCK: 58, NUMLOCK: 69, NUM_LOCK: 69, SCROLL_LOCK: 70,
  MENU: 127, PAUSE: 119, COMPOSE: 127,
  // 标点
  MINUS: 12, EQUAL: 13, LEFTBRACE: 26, RIGHTBRACE: 27, SEMICOLON: 39,
  APOSTROPHE: 40, GRAVE: 41, BACKSLASH: 43, COMMA: 51, DOT: 52, SLASH: 53,
  // 数字行
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  // 字母
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36, K: 37, L: 38,
  M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20, U: 22, V: 47, W: 17, X: 45,
  Y: 21, Z: 44,
  // 媒体键（normalizeKey 产出的 XF86 名字）
  XF86AUDIOPLAY: 164, XF86AUDIOSTOP: 166, XF86AUDIONEXT: 163,
  XF86AUDIOPREV: 165, XF86AUDIORAISEVOLUME: 115, XF86AUDIOLOWERVOLUME: 114,
  XF86AUDIOMUTE: 113,
};

/** F1–F24（59–68、87–88、183–194）。 */
const FUNCTION_KEYCODES: Record<string, number> = {
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  F11: 87, F12: 88, F13: 183, F14: 184, F15: 185, F16: 186, F17: 187, F18: 188,
  F19: 189, F20: 190, F21: 191, F22: 192, F23: 193, F24: 194,
};

/**
 * 单字符标点 → evdev keycode。
 *
 * 必须单独一张表：`-` 既是否定符号又是键名，归一化时会被压成 `_`（`EVDEV_KEYCODES`
 * 里是 `MINUS`），所以单字符要先按原样查，再走「长名字 → 下划线」那条路。
 */
const PUNCTUATION_KEYCODES: Record<string, number> = {
  "-": 12, "=": 13, "[": 26, "]": 27, ";": 39, "'": 40, "`": 41, "\\": 43,
  ",": 51, ".": 52, "/": 53,
};

/** 单键名（Linux 规范化后的名字或单个字符）→ evdev keycode；找不到返回 undefined。 */
export function evdevKeycode(name: string): number | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 1) {
    const punctuation = PUNCTUATION_KEYCODES[trimmed];
    if (punctuation !== undefined) return punctuation;
  }
  const token = trimmed.toUpperCase().replace(/[\s-]+/g, "_");
  const direct = EVDEV_KEYCODES[token] ?? FUNCTION_KEYCODES[token];
  if (direct !== undefined) return direct;
  // 再试一次 Linux 的规范名（ArrowLeft→Left、ControlKey→Ctrl、BackSpace、Page_Up…）。
  // normalizeKey 对不认识的名字会抛错，这里只当作「没找到」。
  let canonical: string;
  try {
    canonical = normalizeKey(trimmed).toUpperCase().replace(/[\s-]+/g, "_");
  } catch {
    return undefined;
  }
  if (canonical === token) return undefined;
  return EVDEV_KEYCODES[canonical] ?? FUNCTION_KEYCODES[canonical];
}

/**
 * `Ctrl+Shift+T` / `Shift` / `ArrowLeft` 这样的键（或组合）→ evdev keycode 序列。
 *
 * 复用 `normalizeKey` 做一次规范化（它已经认识 `ControlKey`/`ArrowLeft`/`pageup` 等
 * Windows 侧与 Linux 侧的写法），再映射到 keycode。未知键显式报错 —— 静默丢键比
 * 报错更糟：模型会以为已经按住/松开。
 */
export function keyChordToKeycodes(key: string): number[] {
  // 逐段映射（而不是先整串 normalizeKey）：`normalizeKey` 不认单个标点，`Ctrl+-` 会被它拒掉，
  // 而单个 token 的别名归一（ArrowLeft/ControlKey/Page_Up…）已经由 evdevKeycode 兜住。
  const tokens = key.split("+").map((part) => part.trim()).filter(Boolean);
  if (!tokens.length || tokens.length > 16 || key.split("+").some(t => !t.trim())) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "key 必须含有有效按键，最多 16 个");
  const codes: number[] = [];
  for (const token of tokens) {
    const code = evdevKeycode(token);
    if (code === undefined) {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", `ydotool 不认识这个键：${token}（来源 ${key}）；请用 Ctrl/Shift/Alt/Super + 字母或功能键的写法`, {
        key, token,
      });
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

const BUTTON_NUMBERS: Record<"left" | "right" | "middle", number> = { left: 0, right: 1, middle: 2 };

/** ydotool 的按钮掩码：0x40=只按下、0x80=只松开；低位是按钮号。 */
export function clickMask(button: "left" | "right" | "middle", phase: "down" | "up"): number {
  const index = button === "left" ? 0 : button === "right" ? 1 : 2;
  return (phase === "down" ? 0x40 : 0x80) | index;
}
export function keyStateArgs(codes: readonly number[], pressed: boolean): string[] {
  return ["key", ...(pressed ? codes : [...codes].reverse()).map(code => `${code}:${pressed ? 1 : 0}`)];
}
export function clickStateArgs(mask: number): string[] { return ["click", `0x${mask.toString(16)}`]; }
export type YdotoolRunner = (args: readonly string[], signal?: AbortSignal) => Promise<void>;
export function ydotoolFailure(error: unknown, args: readonly string[]): ComputerUseError {
  const message = errorText(error);
  return new ComputerUseError("HOST_UNAVAILABLE", `ydotool 输入失败：${message}。请检查用户可访问的 ydotoold 套接字及 /dev/uinput 权限；已提交输入不会自动重试。`, { args, executed: "unknown" });
}
export function createYdotoolRunner(binPath = "ydotool", timeoutMs = 10_000): YdotoolRunner {
  return async (args, signal) => {
    throwIfCancelled(signal);
    try { await execFileAsync(binPath, [...args], { encoding: "utf8", timeout: timeoutMs, signal, maxBuffer: 64 * 1024 }); }
    catch (error) {
      if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "输入进程已取消；已发送事件可能生效，不能重放", { args, executed: "unknown" });
      throw ydotoolFailure(error, args);
    }
  };
}
export class YdotoolInput {
  private readonly guardian?: InputGuardianApi;
  constructor(private readonly options: { runner?: YdotoolRunner; available?: () => boolean; guardian?: InputGuardianApi; onUnexpectedExit?: (error: ComputerUseError) => void } = {}) {
    this.guardian = options.guardian ?? (options.runner ? undefined : new InputGuardian({ onUnexpectedExit: options.onUnexpectedExit }));
  }
  get available(): boolean { return this.options.available?.() ?? Boolean(this.options.runner || executableInPath("ydotool")); }
  private runner(): YdotoolRunner {
    if (!this.available) throw new ComputerUseError("HOST_UNAVAILABLE", "此输入需要 ydotool 及可访问的 ydotoold；请安装 ydotool 并配置用户输入权限");
    return this.options.runner ?? createYdotoolRunner();
  }
  async probe(): Promise<{ available: boolean; verified: boolean; reason?: string; checkedAt: number }> {
    const checkedAt = Date.now();
    if (!this.available) return { available: false, verified: false, checkedAt, reason: "找不到 ydotool" };
    try {
      // Upstream Client/ydotool.c connects to the configured daemon before running
      // debug; tool_debug emits no uinput events. A filesystem stat cannot prove access.
      await this.runner()(["debug"]);
      await this.guardian?.probe();
      return { available: true, verified: false, checkedAt, reason: "已连接 ydotoold，清理守护进程就绪；应用效果仍需每次动作读回" };
    } catch (error) { return { available: false, verified: false, checkedAt, reason: errorText(error) }; }
  }
  async shutdown(): Promise<void> { await this.guardian?.shutdown(); }

  async setKeysHeld(key: string, pressed: boolean, signal?: AbortSignal): Promise<number[]> {
    const codes = keyChordToKeycodes(key); await this.setKeycodesHeld(codes, pressed, signal); return codes;
  }
  async setKeycodesHeld(codes: readonly number[], pressed: boolean, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal); if (!codes.length) return;
    const runner = this.runner();
    if (this.guardian) await this.guardian.setHeld(codes, [], pressed, signal);
    else await runner(keyStateArgs(codes, pressed), signal);
  }
  async setButtonHeld(button: "left" | "right" | "middle", phase: "down" | "up", signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const runner = this.runner();
    if (this.guardian) await this.guardian.setHeld([], [BUTTON_NUMBERS[button]], phase === "down", signal);
    else await runner(clickStateArgs(clickMask(button, phase)), signal);
  }
  async scroll(horizontalNotches: number, verticalNotches: number, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    if (![horizontalNotches, verticalNotches].every(Number.isInteger)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "滚轮增量必须是整数刻度");
    if (horizontalNotches || verticalNotches) {
      const runner = this.runner();
      if (this.guardian) await this.guardian.scroll(horizontalNotches, verticalNotches, signal);
      else await runner(["mousemove", "--wheel", "-x", String(horizontalNotches), "-y", String(verticalNotches)], signal);
    }
  }
}
