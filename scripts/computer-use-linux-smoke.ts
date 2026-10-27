/**
 * Linux（Wayland / Hyprland）Computer Use 真机冒烟。
 *
 * Windows 侧的 `computer-automation-windows-smoke.ts` 会自己拉起一个 WinForms 窗口做
 * 全链路验收；Linux 这边没有等价的「自带靶窗」手段（Wayland 下应用无法自证自己的
 * 窗口句柄，AT-SPI 也不保证暴露），所以这个脚本换成两层：
 *
 *   1. **只读层**（默认就跑）：能力探测 + doctor + list_windows + inspect_controls
 *      分页 + 截图。这些不改用户桌面状态，可以随时执行。
 *   2. **输入层**（`--allow-input` 才跑）：真的用 ydotool 按下/释放修饰键，并用
 *      `hyprctl repl hl.is_key_down()` 验证「按住状态跨进程持久」；再验证
 *      mouse_down_client / mouse_up_client 与 paste_text。默认关闭是因为它会往
 *      **当前前台窗口**发按键——脚本不应该在用户打字时突然按住 Ctrl。
 *
 * 用法：
 *   node out/tests/computer-use-linux-smoke.cjs              # 只读
 *   node out/tests/computer-use-linux-smoke.cjs --allow-input # 含输入（会按 Mod 键）
 *   node out/tests/computer-use-linux-smoke.cjs --json        # 机器可读结果
 *
 * 退出码：0 = 通过或按预期跳过；1 = 断言失败。
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { LinuxComputerUseBackend } from "../src/main/platform/computer-use/linux/LinuxComputerUseBackend";
import { resolveCulBinary } from "../src/main/platform/computer-use/linux/culBinary";
import { probeLinuxComputerUseTools } from "../src/main/platform/computer-use/support";
import { clickMask, keyChordToKeycodes } from "../src/main/platform/computer-use/linux/ydotool";
import { createHyprlandWindowControl } from "../src/main/platform/computer-use/linux/hyprlandWindows";

const execFileAsync = promisify(execFile);

const args = new Set(process.argv.slice(2));
const allowInput = args.has("--allow-input");
const asJson = args.has("--json");

type Status = "pass" | "fail" | "skip";

interface StepResult {
  name: string;
  status: Status;
  detail: string;
}

const results: StepResult[] = [];
let failures = 0;

async function step(name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, status: "pass", detail });
    if (!asJson) console.log(`PASS ${name} — ${detail}`);
  } catch (error) {
    failures += 1;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, status: "fail", detail });
    console.error(`FAIL ${name} — ${detail}`);
  }
}

async function skip(name: string, reason: string): Promise<void> {
  results.push({ name, status: "skip", detail: reason });
  if (!asJson) console.log(`SKIP ${name} — ${reason}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function commandExists(binary: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-c", `command -v ${binary}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** 读 hyprctl 的 Lua 求值结果（Hyprland 0.5x 的 `repl` 子命令）。 */
async function hyprRepl(expression: string): Promise<string> {
  const { stdout } = await execFileAsync("hyprctl", ["repl", expression], { timeout: 5_000 });
  return stdout.trim();
}

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    console.log("computer-use-linux-smoke: 跳过（不是 Linux）");
    return;
  }
  const binary = resolveCulBinary({ envBin: process.env.MYBUDDY_CUL_BIN });
  const tools = probeLinuxComputerUseTools();
  if (!asJson) {
    console.log(`[smoke] CUL 二进制：${binary ?? "（缺失）"}`);
    console.log(`[smoke] 缺失工具：${tools.missing.join(", ") || "（无）"}`);
    console.log(`[smoke] 输入层：${allowInput ? "启用（--allow-input）" : "关闭（只读）"}`);
  }
  if (!binary) {
    await skip("全部", "没有 computer-use-linux 二进制（先 pnpm install 或用 MYBUDDY_CUL_BIN 指定）");
    return finish();
  }

  const backend = new LinuxComputerUseBackend();
  try {
    await step("status() 报告 supported 且不阻塞", () => {
      const status = backend.status();
      assert(status.platform === "linux", "platform 必须是 linux");
      assert(status.backend === "linux-cul", "backend 必须是 linux-cul");
      assert(status.supported, `supported 应为 true：${status.detail}`);
      return status.detail;
    });

    await step("refreshDiagnostics() 能取到 doctor 的 readiness", async () => {
      await backend.refreshDiagnostics?.();
      const doctor = backend.cachedDoctor();
      assert(doctor, "doctor 没有缓存到结果");
      const readiness = doctor.readiness as { can_capture_screenshots?: boolean; screenshot_capture_status?: string } | undefined;
      assert(readiness, "doctor 没有 readiness 段");
      return `can_capture_screenshots=${String(readiness.can_capture_screenshots)} screenshot=${String(readiness.screenshot_capture_status)}`;
    });

    let windowHandle: string | undefined;
    await step("list_windows 列出可见窗口", async () => {
      const output = await backend.execute({ action: "list_windows" });
      const windows = output.windows ?? [];
      assert(windows.length > 0, "一个窗口都没列到（Hyprland IPC 或权限有问题）");
      const target = windows.find((item) => item.foreground) ?? windows[0];
      windowHandle = target.handle;
      return `${windows.length} 个窗口，取样「${target.title}」(${target.processName})`;
    });

    await step("inspect_controls 自动翻页收全 AT-SPI 树", async () => {
      assert(windowHandle, "没有窗口可检查");
      const output = await backend.execute({ action: "inspect_controls", windowHandle, maxNodes: 400 });
      const controls = output.controls ?? [];
      const pages = Number(output.accessibilityPages ?? 0);
      assert(pages >= 1, `accessibilityPages 应该 ≥1，实际 ${String(output.accessibilityPages)}`);
      // 翻页修复的核心断言：只要树被截断过，就必须真的多取了几页。
      if (output.truncated === true) {
        assert(pages > 1, `truncated=true 但只取了 ${pages} 页 —— 翻页没生效`);
      }
      return `${controls.length} 个控件 / ${pages} 页${output.truncated ? "（仍被截断）" : ""}`;
    });

    await step("inspect_controls 在真实 GTK 窗口上翻页拿到第 2 页控件", async () => {
      // 找一个大树窗口（Nautilus / GTK 应用）。没有就跳过 —— 这条依赖用户桌面里
      // 恰好开着某个非 Electron 应用，强制起窗口会干扰用户。
      const output = await backend.execute({ action: "list_windows" });
      const candidate = (output.windows ?? []).find((item) =>
        /nautilus|thunar|dolphin|gtk|calculator/i.test(`${item.processName} ${item.className ?? ""}`));
      if (!candidate) return "跳过（没有 GTK 类窗口可测）";
      const inspected = await backend.execute({ action: "inspect_controls", windowHandle: candidate.handle, maxNodes: 400 });
      const pages = Number(inspected.accessibilityPages ?? 0);
      const controls = inspected.controls ?? [];
      assert(pages >= 2 || inspected.truncated !== true, `${candidate.processName}: pages=${pages} truncated=${String(inspected.truncated)} 自相矛盾`);
      const interactive = controls.filter((control) => /button|grid cell|list item|entry|toggle/i.test(control.controlType ?? "")).length;
      assert(interactive > 0, `${candidate.processName}: 收全 ${controls.length} 个节点但没有可交互控件`);
      return `${candidate.processName}: ${controls.length} 个节点 / ${pages} 页 / ${interactive} 个可交互`;
    });

    await step("screenshot_window 能拿到非空 JPEG", async () => {
      assert(windowHandle, "没有窗口可截图");
      const output = await backend.execute({ action: "screenshot_window", windowHandle, clientOnly: false });
      const bytes = output.screenshot?.byteLength ?? 0;
      assert(bytes > 100, `截图只有 ${bytes} 字节`);
      return `${bytes} 字节`;
    });

    if (!allowInput) {
      await skip("key_down/key_up 按住状态跨进程持久", "需要 --allow-input（会真的按住修饰键）");
      await skip("mouse_down_client/mouse_up_client", "需要 --allow-input");
      await skip("paste_text 走 wl-copy", "需要 --allow-input");
      await skip("move_window/resize_window", "需要 --allow-input（会起一个一次性 foot 靶窗并移动它）");
    } else {
      await step("key_down/key_up 按住状态跨进程持久", async () => {
        assert(await commandExists("ydotool"), "没有 ydotool（sudo pacman -S ydotool）");
        assert(await commandExists("hyprctl"), "没有 hyprctl");
        assert(keyChordToKeycodes("Shift").length === 1, "Shift 应映射到一个 keycode");
        const before = await hyprRepl('hl.is_key_down("Shift_L")');
        assert(before === "false" || before === "0", `开始前 Shift 不该处于按下状态：${before}`);
        try {
          await backend.execute({ action: "key_down", key: "Shift" });
          const held = await hyprRepl('hl.is_key_down("Shift_L")');
          assert(held === "true" || held === "1", `key_down 之后 is_key_down 应为 true，实际 ${held}`);
        } finally {
          await backend.execute({ action: "key_up", key: "Shift" });
        }
        const released = await hyprRepl('hl.is_key_down("Shift_L")');
        assert(released === "false" || released === "0", `key_up 之后应为 false，实际 ${released}`);
        return "Shift down→true / up→false";
      });

      await step("mouse_down_client/mouse_up_client 分离可用", async () => {
        // 不下发坐标就不碰指针位置，只验证按钮边沿能被接受（0x40/0x80 掩码）。
        assert(clickMask("left", "down") === 0x40 && clickMask("left", "up") === 0x80, "按钮掩码常量不对");
        await backend.execute({ action: "mouse_down_client", button: "left" });
        await backend.execute({ action: "mouse_up_client", button: "left" });
        return "left down/up 均被接受";
      });

      await step("move_window/resize_window 走 hyprctl Lua 并回读几何", async () => {
        assert(await commandExists("hyprctl"), "没有 hyprctl");
        assert(await commandExists("foot"), "没有 foot（用来起一个一次性靶窗，不碰用户当前窗口）");
        // 用一次性 foot 窗口做靶子：move 会把窗口强制转浮窗，绝不能拿用户正在用的窗口试。
        const scratch = spawn("foot", ["--app-id=mybuddy-cu-smoke", "--title=mybuddy-cu-smoke"], {
          stdio: "ignore", detached: true,
        });
        scratch.unref();
        try {
          let target: { handle: string; x: number; y: number; width: number; height: number } | undefined;
          const control = createHyprlandWindowControl();
          const deadline = Date.now() + 8_000;
          while (Date.now() < deadline && !target) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            const listed = await backend.execute({ action: "list_windows" });
            const hit = (listed.windows ?? []).find((item) => /mybuddy-cu-smoke/i.test(`${item.title} ${item.className ?? ""}`));
            if (!hit) continue;
            const rect = await control.geometry(hit.handle);
            if (rect) target = { handle: hit.handle, ...rect };
          }
          assert(target, "8 秒内没等到 mybuddy-cu-smoke 窗口");

          // 缺参数必须被明确拒绝，不能静默成功。
          let rejected = false;
          try {
            await backend.execute({ action: "move_window", windowHandle: target.handle });
          } catch {
            rejected = true;
          }
          assert(rejected, "move_window 缺 window_x/window_y 时应报错");

          const moved = await backend.execute({
            action: "move_window", windowHandle: target.handle,
            windowX: target.x + 40, windowY: target.y + 30,
          });
          const afterMove = moved.windowGeometry as { x: number; y: number; floating: boolean } | undefined;
          assert(afterMove, "move_window 没有回读几何");
          assert(afterMove.floating, "move 之后窗口应是浮窗（平铺窗口无法移动）");
          assert(Math.abs(afterMove.x - (target.x + 40)) <= 2, `move 后 x=${afterMove.x}，期望约 ${target.x + 40}`);
          assert(Math.abs(afterMove.y - (target.y + 30)) <= 2, `move 后 y=${afterMove.y}，期望约 ${target.y + 30}`);

          const resized = await backend.execute({
            action: "resize_window", windowHandle: target.handle,
            windowWidth: target.width - 60, windowHeight: target.height - 40,
          });
          const afterResize = resized.windowGeometry as { width: number; height: number } | undefined;
          assert(afterResize, "resize_window 没有回读几何");
          assert(Math.abs(afterResize.width - (target.width - 60)) <= 2, `resize 后 width=${afterResize.width}，期望约 ${target.width - 60}`);
          assert(Math.abs(afterResize.height - (target.height - 40)) <= 2, `resize 后 height=${afterResize.height}，期望约 ${target.height - 40}`);

          return `at ${target.x},${target.y} → ${afterMove.x},${afterMove.y}；size ${target.width}x${target.height} → ${afterResize.width}x${afterResize.height}（靶窗已关闭）`;
        } finally {
          if (scratch.pid) {
            try { process.kill(-scratch.pid, "SIGTERM"); } catch { /* 已退出 */ }
          }
        }
      });

      await step("paste_text 写剪贴板再按 Ctrl+V", async () => {
        assert(await commandExists("wl-copy"), "没有 wl-copy（sudo pacman -S wl-clipboard）");
        assert(await commandExists("wl-paste"), "没有 wl-paste");
        const marker = `mybuddy-smoke-${process.pid}`;
        const output = await backend.execute({ action: "paste_text", text: marker, windowHandle });
        const pasted = output.pasted === true;
        const clipboard = (await execFileAsync("wl-paste", ["--no-newline"], { timeout: 5_000 })).stdout.trim();
        assert(clipboard === marker, `剪贴板内容不符：${clipboard}`);
        assert(pasted, `pasted 应为 true：${String(output.detail)}`);
        return `剪贴板 = ${clipboard}`;
      });
    }
  } finally {
    await backend.shutdown();
  }
  finish();
}

function finish(): void {
  if (asJson) {
    console.log(JSON.stringify({ results, failures }, null, 2));
  } else {
    const passed = results.filter((item) => item.status === "pass").length;
    const skipped = results.filter((item) => item.status === "skip").length;
    console.log(`computer-use-linux-smoke: ${passed} passed, ${skipped} skipped, ${failures} failed`);
  }
  if (failures > 0) process.exitCode = 1;
}

void main();
