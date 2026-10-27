import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComputerUseError } from "../protocol";

const execFileAsync = promisify(execFile);

/**
 * Hyprland 的窗口几何控制（`hl.dsp.window.*`，Hyprland ≥ 0.50 的 Lua API）。
 *
 * 为什么不用 CUL 的 `move_window`/`resize_window`：CUL 在 Hyprland 上直接失败——
 *   `{"backend":"hyprland","implemented":true,"ok":false,"message":"Window backend hyprland
 *     cannot move windows; move_window needs the computer-use-linux GNOME Shell extension
 *     or a generic X11/EWMH session."}`
 * 它只有 GNOME Shell 扩展和 X11/EWMH（wmctrl）两条路，Hyprland 两条都不走。
 *
 * 实测要点（Hyprland 0.56.2）：
 * - **必须 `hl.dispatch(...)`**：`hl.dsp.window.move({...})` 只构造 dispatcher 对象，不执行。
 *   这是最容易踩的坑——只写 `hl.dsp` 会「返回成功但什么都没发生」。
 * - **平铺窗口不能 move/resize**：先 `hl.dsp.window.float({mode:"toggle"})` 转浮窗。
 * - `hl.dsp.window.set_prop` 在 0.56.2 上是**静默空操作**（连不存在的 prop 名都返回 ok），
 *   所以没法用它在目标窗口上画高亮边框；状态反馈走 `hyprctl notify`（见 indicator.ts）。
 * - 坐标是**逻辑（布局）像素**，与 `hyprctl clients` 的 `at`/`size` 同域，不是物理像素。
 *
 * 地址换算：CUL 的 `window_id` 就是 Hyprland 窗口指针的十进制表示
 * （实测 `94718514217904` == `0x56255f64c3b0`），这里转回 `0x...` 给 Lua 用。
 */

export type HyprctlRunner = (args: string[]) => Promise<string>;

export function createHyprctlRunner(timeoutMs = 5_000): HyprctlRunner {
  return async (args) => {
    const { stdout } = await execFileAsync("hyprctl", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  };
}

/** CUL 的十进制 window_id → Hyprland 的 `0x...` 地址。非法输入返回 undefined。 */
export function hyprlandAddressFromHandle(handle: string): string | undefined {
  const trimmed = String(handle ?? "").trim();
  // 已经是 0x... 形式就归一化（大写去重），否则按十进制解析。
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return `0x${BigInt(trimmed).toString(16)}`;
  if (!/^\d+$/.test(trimmed)) return undefined;
  try {
    return `0x${BigInt(trimmed).toString(16)}`;
  } catch {
    return undefined;
  }
}

const FIND_WINDOW_LUA = (address: string) => `
local target = nil
for _, w in ipairs(hl.get_windows()) do
  if string.lower(tostring(w.address)) == "${address}" then target = w end
end
if target == nil then return "missing" end`;

const clampInt = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(value)));

/**
 * 构造「把窗口移到 (x, y)」的 Lua 脚本。
 *
 * 平铺窗口先转浮窗——Hyprland 对平铺窗口的 move 会被布局忽略。已经浮动的窗口不重复 toggle，
 * 否则会把用户原本的浮窗变回平铺。
 */
export function buildMoveScript(address: string, x: number, y: number): string {
  const left = clampInt(x, -32_000, 32_000);
  const top = clampInt(y, -32_000, 32_000);
  return `${FIND_WINDOW_LUA(address)}
if not target.floating then hl.dispatch(hl.dsp.window.float({window = target, mode = "toggle"})) end
hl.dispatch(hl.dsp.window.move({window = target, x = ${left}, y = ${top}}))
return "moved"`;
}

export function buildResizeScript(address: string, width: number, height: number): string {
  const w = clampInt(width, 1, 32_000);
  const h = clampInt(height, 1, 32_000);
  return `${FIND_WINDOW_LUA(address)}
if not target.floating then hl.dispatch(hl.dsp.window.float({window = target, mode = "toggle"})) end
hl.dispatch(hl.dsp.window.resize({window = target, x = ${w}, y = ${h}}))
return "resized"`;
}

export interface HyprlandWindowRect {
  /** 逻辑（布局）像素，frame 左上角。 */
  x: number;
  y: number;
  width: number;
  height: number;
  floating: boolean;
}

/** 读回窗口几何，用于「动作是否真的生效」的断言（不靠猜）。 */
export function buildReadGeometryScript(address: string): string {
  return `${FIND_WINDOW_LUA(address)}
return tostring(target.at.x) .. "," .. tostring(target.at.y) .. "," ..
  tostring(target.size.x) .. "," .. tostring(target.size.y) .. "," ..
  tostring(target.floating)`;
}

export function parseGeometry(raw: string): HyprlandWindowRect | undefined {
  const parts = String(raw ?? "").trim().split(",");
  if (parts.length !== 5) return undefined;
  const [x, y, width, height] = parts.slice(0, 4).map((part) => Number(part.trim()));
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return undefined;
  return { x, y, width, height, floating: parts[4].trim() === "true" };
}

async function runRepl(runner: HyprctlRunner, script: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "动作在发出前被取消");
  try {
    return (await runner(["repl", script])).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // hyprctl 对 Lua 运行时错误是「exit 0 + stderr」还是非零退出，各版本不一致；
    // 两条路都归一到一条可诊断的错误里，不要把原始 Lua 栈直接抛给模型。
    if (/not a Hyprland|HYPRLAND_INSTANCE_SIGNATURE|command not found|ENOENT/i.test(message)) {
      throw new ComputerUseError("HOST_UNAVAILABLE", `hyprctl 不可用：${message}`, { script: script.slice(0, 200) });
    }
    throw new ComputerUseError("HOST_PROTOCOL_ERROR", `hyprctl repl 失败：${message}`, { script: script.slice(0, 200) });
  }
}

export interface HyprlandWindowControl {
  move(handle: string, x: number, y: number, signal?: AbortSignal): Promise<HyprlandWindowRect | undefined>;
  resize(handle: string, width: number, height: number, signal?: AbortSignal): Promise<HyprlandWindowRect | undefined>;
  geometry(handle: string, signal?: AbortSignal): Promise<HyprlandWindowRect | undefined>;
}

/**
 * 可注入 `runner` 的 Hyprland 几何控制器：单测传假 runner，真机走 `hyprctl`。
 * 每次都读回几何，返回值就是「合成器实际采纳的值」，不是请求值。
 */
export function createHyprlandWindowControl(runner: HyprctlRunner = createHyprctlRunner()): HyprlandWindowControl {
  const addressOrThrow = (handle: string): string => {
    const address = hyprlandAddressFromHandle(handle);
    if (!address) {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", `无法把 window_handle「${handle}」换算成 Hyprland 窗口地址`, { handle });
    }
    return address;
  };
  const apply = async (
    handle: string,
    script: string,
    signal?: AbortSignal,
  ): Promise<HyprlandWindowRect | undefined> => {
    const address = addressOrThrow(handle);
    const result = await runRepl(runner, script, signal);
    if (result === "missing") {
      throw new ComputerUseError("WINDOW_NOT_FOUND", `Hyprland 里找不到窗口 ${address}（可能已关闭）`, { handle, address });
    }
    // 动作已下发，读回真实几何作为结果证据。
    const readBack = await runRepl(runner, buildReadGeometryScript(address), signal).catch(() => "");
    return parseGeometry(readBack);
  };
  return {
    move: (handle, x, y, signal) => apply(handle, buildMoveScript(addressOrThrow(handle), x, y), signal),
    resize: (handle, width, height, signal) => apply(handle, buildResizeScript(addressOrThrow(handle), width, height), signal),
    geometry: async (handle, signal) => {
      const address = addressOrThrow(handle);
      return parseGeometry(await runRepl(runner, buildReadGeometryScript(address), signal));
    },
  };
}
