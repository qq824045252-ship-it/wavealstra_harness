import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComputerUseError } from "../protocol";
import { executableInPath } from "../support";
import { toCulKey } from "./culProtocol";

const execFileAsync = promisify(execFile);

/**
 * ydotool 的按住/释放分离能力。
 *
 * 为什么必须单独走 ydotool：CUL（computer-use-linux）只提供「完整 click / drag」，
 * 底层 wtype 用的是虚拟键盘协议，进程一退出就自动释放按下的键，**无法保持按住状态**；
 * 而 ydotool 直接写 uinput 事件，`42:1`（按下）/`42:0`（松开）跨进程持久。
 *
 * 实测（Omarchy / Hyprland 0.56.2 / Wayland）：
 * - `ydotool key 42:1` → `hyprctl repl 'hl.is_key_down("Shift_L")'` = true；
 *   `ydotool key 42:0` → false。
 * - `ydotool click 0x40` / `0x80` 分别是左键 down / up（0x40=down、0x80=up、
 *   低 3 位是按钮号：left=0、right=1、middle=2）。
 * - Hyprland 的 `hl.dsp.send_key_state` **不会**产生持久按键状态（实测
 *   `hl.is_key_down` 仍为 false），所以只能走 ydotool。
 * - `ydotool mousemove -a` 的坐标系是「逻辑 DIP × 2」，与 Hyprland 物理像素不等价，
 *   因此指针定位仍交给 CUL（它已按 monitors 的 scale 换算正确），ydotool 只负责
 *   按键状态与按键边沿。
 */

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
  // 媒体键（toCulKey 产出的 XF86 名字）
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

/** 单键名（CUL 规范化后的名字或单个字符）→ evdev keycode；找不到返回 undefined。 */
export function evdevKeycode(name: string): number | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 1) {
    const punctuation = PUNCTUATION_KEYCODES[trimmed];
    if (punctuation !== undefined) return punctuation;
  }
  const token = trimmed.toUpperCase().replace(/[\s-]+/g, "_");
  const direct = EVDEV_KEYCODES[token] ?? FUNCTION_KEYCODES[token];
  if (direct !== undefined) return direct;
  // 再试一次 CUL 的规范名（ArrowLeft→Left、ControlKey→Ctrl、BackSpace、Page_Up…）。
  // toCulKey 对不认识的名字会抛错，这里只当作「没找到」。
  let canonical: string;
  try {
    canonical = toCulKey(trimmed).toUpperCase().replace(/[\s-]+/g, "_");
  } catch {
    return undefined;
  }
  if (canonical === token) return undefined;
  return EVDEV_KEYCODES[canonical] ?? FUNCTION_KEYCODES[canonical];
}

/**
 * `Ctrl+Shift+T` / `Shift` / `ArrowLeft` 这样的键（或组合）→ evdev keycode 序列。
 *
 * 复用 `toCulKey` 做一次规范化（它已经认识 `ControlKey`/`ArrowLeft`/`pageup` 等
 * Windows 侧与 CUL 侧的写法），再映射到 keycode。未知键显式报错 —— 静默丢键比
 * 报错更糟：模型会以为已经按住/松开。
 */
export function keyChordToKeycodes(key: string): number[] {
  // 逐段映射（而不是先整串 toCulKey）：`toCulKey` 不认单个标点，`Ctrl+-` 会被它拒掉，
  // 而单个 token 的别名归一（ArrowLeft/ControlKey/Page_Up…）已经由 evdevKeycode 兜住。
  const tokens = key.split("+").map((part) => part.trim()).filter(Boolean);
  const codes: number[] = [];
  for (const token of tokens) {
    const code = evdevKeycode(token);
    if (code === undefined) {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", `ydotool 不认识这个键：${token}（来源 ${key}）；请用 Ctrl/Shift/Alt/Super + 字母或功能键的写法`, {
        key, token,
      });
    }
    codes.push(code);
  }
  return codes;
}

const BUTTON_NUMBERS: Record<"left" | "right" | "middle", number> = { left: 0, right: 1, middle: 2 };

/** ydotool 的按钮掩码：0x40=只按下、0x80=只松开；低位是按钮号。 */
export function clickMask(button: "left" | "right" | "middle", phase: "down" | "up"): number {
  return (phase === "down" ? 0x40 : 0x80) | BUTTON_NUMBERS[button];
}

/**
 * `key` 子命令参数：按下按原序、松开按逆序（先放的键后按，组合键语义更稳）。
 * ydotool 语法是 `<keycode>:<pressed>`。
 */
export function keyStateArgs(codes: readonly number[], pressed: boolean): string[] {
  if (codes.length === 0) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "ydotool 需要至少一个键");
  const ordered = pressed ? [...codes] : [...codes].reverse();
  return ["key", ...ordered.map((code) => `${code}:${pressed ? 1 : 0}`)];
}

export function clickStateArgs(mask: number): string[] {
  return ["click", `0x${mask.toString(16)}`];
}

/** 执行一次 ydotool 命令（可注入，测试不碰真机）。 */
export type YdotoolRunner = (args: readonly string[]) => Promise<void>;

/**
 * `/run/user/<uid>/.ydotool_socket` 是**陈旧的**（ydotoold 已退出但 socket 文件还在）时，
 * ydotool 报的是 `Connection refused` / `Please check if ydotoold is running.`。
 * 这个错误极难和「ydotool 没装」区分开，实测踩过一次（服务 start-limit-hit 后
 * socket 残留 4 小时）。所以单独识别并给出可操作的恢复命令。
 */
export const YDOTOOL_STALE_DAEMON_HINT =
  "ydotoold 没有在运行（socket 可能已陈旧）。恢复：rm -f /run/user/$(id -u)/.ydotool_socket && "
  + "systemctl --user reset-failed ydotool && systemctl --user restart ydotool";

/** ydotool 的报错是否在说「守护进程没跑」，而不是「ydotool 没装」。 */
export function isStaleDaemonError(message: string): boolean {
  return /Connection refused|ydotoold is running|failed to connect socket/i.test(message);
}

/** 把 ydotool 的原始报错翻译成可操作的 ComputerUseError。 */
export function ydotoolFailure(message: string, args: readonly string[]): ComputerUseError {
  return new ComputerUseError(
    "HOST_UNAVAILABLE",
    isStaleDaemonError(message) ? YDOTOOL_STALE_DAEMON_HINT : `ydotool 执行失败：${message}`,
    { args: [...args] },
  );
}

export function createYdotoolRunner(binPath = "ydotool", timeoutMs = 10_000): YdotoolRunner {
  return async (args) => {
    try {
      await execFileAsync(binPath, [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 });
    } catch (error) {
      throw ydotoolFailure(error instanceof Error ? error.message : String(error), args);
    }
  };
}

/**
 * ydotool 输入通道：只做「按住/松开」与「按下边沿」。
 *
 * 指针位置仍由 CUL 负责（见类头注释），所以这里没有 move。
 */
export class YdotoolInput {
  constructor(private readonly options: { runner?: YdotoolRunner; available?: () => boolean } = {}) {}

  /** ydotool 是否可用（PATH 探测；显式注入 runner 时视为可用）。 */
  get available(): boolean {
    if (this.options.runner) return true;
    if (this.options.available) return this.options.available();
    return executableInPath("ydotool") !== undefined;
  }

  private runner(): YdotoolRunner {
    if (this.options.runner) return this.options.runner;
    if (!this.available) {
      throw new ComputerUseError(
        "HOST_UNAVAILABLE",
        "按住/释放分离的输入需要 ydotool（wtype 的 -P/-p 在进程退出时会自动释放，无法保持按住）。安装：sudo pacman -S --needed ydotool && sudo systemctl enable --now ydotoold",
      );
    }
    return createYdotoolRunner();
  }

  /** 按下或松开一组键（组合键会按顺序按下、逆序松开）。 */
  async setKeysHeld(key: string, pressed: boolean): Promise<number[]> {
    const codes = keyChordToKeycodes(key);
    await this.runner()(keyStateArgs(codes, pressed));
    return codes;
  }

  /**
   * 按 evdev keycode 直接按下/松开（不做键名解析）。
   *
   * 用于「清理按住状态」：后端记录的是 keycode 集合，任务结束/动作失败时按集合释放，
   * 不需要再把 keycode 反解成键名。
   */
  async setKeycodesHeld(codes: number[], pressed: boolean): Promise<void> {
    if (codes.length === 0) return;
    await this.runner()(keyStateArgs(codes, pressed));
  }

  /** 按下/松开鼠标按钮（不移动指针）。 */
  async setButtonHeld(button: "left" | "right" | "middle", phase: "down" | "up"): Promise<void> {
    await this.runner()(clickStateArgs(clickMask(button, phase)));
  }
}
