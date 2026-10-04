/**
 * Terminal renderer 接线单元测试（P0 输入链路回归 + 字体探测 + 输出水位）
 *
 * 回归点：TerminalView 的 term.onData → window.api.terminal.input 转发曾缺失，
 * 导致「TerminalHost 测试全绿但终端无法输入」。这里用纯函数 + fake 目标直接
 * 覆盖转发逻辑：任何删除/破坏输入接线都会红。
 *
 * 运行：pnpm run test:terminal（与 host 测试串联）
 */
import assert from "node:assert/strict";
import {
  TERMINAL_SESSION_INVALID,
  createBoundedWriter,
  createInputForwarder,
} from "../src/renderer/src/lib/terminalBridge";
import { resolveTerminalUiOwner, terminalOwnerIdsOf } from "../src/renderer/src/lib/terminalOwner";
import {
  TERMINAL_FONT_CANDIDATES,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_MIN_FONT_SIZE,
  buildTerminalFontFamily,
  pickFirstAvailableFont,
  resolveTerminalFontOptions,
  resolveTerminalFontSize,
} from "../src/renderer/src/lib/terminalFonts";
import {
  DARK_TERMINAL_CONTRAST_RATIO,
  LIGHT_TERMINAL_CONTRAST_RATIO,
  LIGHT_TERMINAL_THEME,
  resolveTerminalContrastRatio,
  resolveTerminalTheme,
} from "../src/renderer/src/lib/terminalTheme";

/* ------------------------------------------------------------------ */
/* fake 目标                                                           */
/* ------------------------------------------------------------------ */

interface FakeTargetState {
  owner: { taskId?: string; workspaceId?: string } | null;
  sessionId: string | null;
}

function makeTarget(state: FakeTargetState): {
  target: Parameters<typeof createInputForwarder>[0];
  sent: Array<{ taskId?: string; workspaceId?: string; sessionId: string; data: string }>;
} {
  const sent: Array<{ taskId?: string; workspaceId?: string; sessionId: string; data: string }> = [];
  return {
    target: {
      getOwner: () => state.owner,
      getSessionId: () => state.sessionId,
      sendInput: (req) => sent.push(req),
    },
    sent,
  };
}

/* ------------------------------------------------------------------ */
/* 用例                                                               */
/* ------------------------------------------------------------------ */

interface Case {
  name: string;
  run(): void;
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function test(name: string, run: () => void): void {
  results.push({ name, ok: true });
  try {
    run();
  } catch (err) {
    results[results.length - 1].ok = false;
    results[results.length - 1].detail = err instanceof Error ? err.message : String(err);
  }
}

test("输入桥接: 任务与会话就绪 → 原样转发（Enter/Backspace/Ctrl+C 等）", () => {
  const state: FakeTargetState = { owner: { taskId: "t1" }, sessionId: "s1" };
  const { target, sent } = makeTarget(state);
  const forward = createInputForwarder(target);

  forward("ls\r"); // Enter
  forward("a\x7f"); // 字符 + Backspace
  forward("\x03"); // Ctrl+C
  assert.deepEqual(sent, [
    { taskId: "t1", sessionId: "s1", data: "ls\r" },
    { taskId: "t1", sessionId: "s1", data: "a\x7f" },
    { taskId: "t1", sessionId: "s1", data: "\x03" },
  ]);
});

test("输入桥接: owner 未就绪 → 丢弃", () => {
  const state: FakeTargetState = { owner: null, sessionId: "s1" };
  const { target, sent } = makeTarget(state);
  createInputForwarder(target)("hello");
  assert.equal(sent.length, 0);
});

test("输入桥接: sessionId 未 attach（null 回放窗口）→ 丢弃", () => {
  const state: FakeTargetState = { owner: { taskId: "t1" }, sessionId: null };
  const { target, sent } = makeTarget(state);
  createInputForwarder(target)("hello");
  assert.equal(sent.length, 0);
});

test("输入桥接: sessionId 失效哨兵（restart 窗口）→ 丢弃", () => {
  const state: FakeTargetState = { owner: { taskId: "t1" }, sessionId: TERMINAL_SESSION_INVALID };
  const { target, sent } = makeTarget(state);
  createInputForwarder(target)("hello");
  assert.equal(sent.length, 0);
});

test("输入桥接: 通过 getter 读实时 ref，会话切换后转发到新会话", () => {
  const state: FakeTargetState = { owner: { taskId: "t1" }, sessionId: "s-old" };
  const { target, sent } = makeTarget(state);
  const forward = createInputForwarder(target);

  forward("a");
  state.sessionId = "s-new"; // restart 后新 sessionId
  forward("b");
  state.owner = { taskId: "t2" }; // 切任务
  forward("c");
  assert.deepEqual(
    sent.map((r) => `${r.taskId}/${r.sessionId}/${r.data}`),
    ["t1/s-old/a", "t1/s-new/b", "t2/s-new/c"],
  );
});

test("输入桥接: workspace owner 转发 workspaceId（不带 taskId）", () => {
  const state: FakeTargetState = { owner: { workspaceId: "ws1" }, sessionId: "s1" };
  const { target, sent } = makeTarget(state);
  createInputForwarder(target)("herdr\r");
  assert.deepEqual(sent, [{ workspaceId: "ws1", sessionId: "s1", data: "herdr\r" }]);
});

test("UI owner: 独立任务 → task；绑定空间 → workspace；未绑定不 spawn", () => {
  assert.equal(resolveTerminalUiOwner({ activeTaskId: null }).kind, "none");
  assert.deepEqual(resolveTerminalUiOwner({ activeTaskId: "t1" }), { kind: "task", taskId: "t1" });
  assert.deepEqual(
    resolveTerminalUiOwner({
      activeTaskId: "t1",
      taskSpaceId: "ws1",
      space: { id: "ws1", path: "C:\\Users\\servi\\Desktop\\mybuddy" },
    }),
    { kind: "workspace", workspaceId: "ws1" },
  );
  assert.deepEqual(
    resolveTerminalUiOwner({
      activeTaskId: "t1",
      taskSpaceId: "ws1",
      space: { id: "ws1" },
    }),
    { kind: "unbound", workspaceId: "ws1", reason: "missing-folder" },
  );
  assert.deepEqual(
    resolveTerminalUiOwner({
      activeTaskId: "t1",
      taskSpaceId: "ws1",
      space: { id: "ws1", path: "C:\\gone", pathMissing: true },
    }),
    { kind: "unbound", workspaceId: "ws1", reason: "folder-unavailable" },
  );
  assert.equal(
    terminalOwnerIdsOf({ kind: "unbound", workspaceId: "ws1", reason: "missing-folder" }),
    null,
  );
  assert.deepEqual(terminalOwnerIdsOf({ kind: "workspace", workspaceId: "ws1" }), { workspaceId: "ws1" });
});

test("UI owner: 无任务也能从 Workspace 打开终端（cwd 不依赖 taskId）", () => {
  const bound = { id: "ws1", path: "C:\\Users\\servi\\Desktop\\mybuddy" };
  assert.deepEqual(
    resolveTerminalUiOwner({ activeWorkspaceId: "ws1", space: bound }),
    { kind: "workspace", workspaceId: "ws1" },
  );
  assert.deepEqual(
    resolveTerminalUiOwner({ draftSpaceId: "ws1", space: bound }),
    { kind: "workspace", workspaceId: "ws1" },
  );
  assert.deepEqual(
    resolveTerminalUiOwner({
      activeTaskId: "t-other",
      taskSpaceId: "ws-other",
      activeWorkspaceId: "ws1",
      space: bound,
    }),
    { kind: "workspace", workspaceId: "ws1" },
  );
  assert.deepEqual(
    resolveTerminalUiOwner({ activeWorkspaceId: "ws1", space: { id: "ws1" } }),
    { kind: "unbound", workspaceId: "ws1", reason: "missing-folder" },
  );
});

test("输出水位: 正常写入计数并随回调扣减", () => {
  let wrote: string[] = [];
  let lastCb: (() => void) | null = null;
  const writer = createBoundedWriter(
    (data, cb) => {
      wrote.push(data);
      lastCb = cb ?? null;
    },
    10,
  );
  writer.write("abc");
  writer.write("def");
  assert.equal(writer.pendingBytes(), 6);
  assert.deepEqual(wrote, ["abc", "def"]);
  lastCb?.(); // xterm 解析完成 → 扣减第一块
  assert.equal(writer.pendingBytes(), 3);
  lastCb?.();
  assert.equal(writer.pendingBytes(), 0);
});

test("输出水位: 超限丢弃后续数据，排空后自动恢复", () => {
  const dropped: string[] = [];
  const cbs: Array<() => void> = [];
  const writer = createBoundedWriter(
    (data, cb) => {
      cbs.push(cb ?? (() => {}));
    },
    10,
    () => dropped.push("warn"),
  );
  writer.write("x".repeat(12)); // 首个数据入队 → pending=12 越过水位
  assert.equal(writer.pendingBytes(), 12);
  writer.write("y".repeat(12)); // 超限：丢弃
  writer.write("z".repeat(12)); // 丢弃
  assert.equal(writer.pendingBytes(), 12);
  assert.deepEqual(dropped, ["warn"]); // 仅告警一次

  // 排空后恢复
  cbs.forEach((cb) => cb());
  assert.equal(writer.pendingBytes(), 0);
  writer.write("ok");
  assert.equal(writer.pendingBytes(), 2);
});

test("字体探测: 返回候选列表中第一个可用字体", () => {
  const available = new Set(["MesloLGM Nerd Font Mono"]);
  const picked = pickFirstAvailableFont(TERMINAL_FONT_CANDIDATES, (spec) =>
    available.has(spec.slice(spec.indexOf('"') + 1, spec.lastIndexOf('"'))),
  );
  assert.equal(picked, "MesloLGM Nerd Font Mono");
});

test("字体探测: 全部不可用 → null；check 抛错跳过", () => {
  assert.equal(pickFirstAvailableFont(TERMINAL_FONT_CANDIDATES, () => false), null);
  assert.equal(
    pickFirstAvailableFont(["Bad Font", "Good Font"], (spec) => {
      if (spec.includes("Bad")) throw new Error("boom");
      return true;
    }),
    "Good Font",
  );
});

test("字体探测: 候选至少包含 CaskaydiaCove 与 MesloLGM Mono（防误删）", () => {
  assert.ok(TERMINAL_FONT_CANDIDATES.includes("CaskaydiaCove Nerd Font Mono"));
  assert.ok(TERMINAL_FONT_CANDIDATES.includes("CaskaydiaCove Nerd Font"));
  assert.ok(TERMINAL_FONT_CANDIDATES.includes("MesloLGM Nerd Font Mono"));
});

test("字体探测: Mono 变体排在非 Mono 前面（防图标撑破格子叠到 CJK）", () => {
  const mono = TERMINAL_FONT_CANDIDATES.indexOf("CaskaydiaCove Nerd Font Mono");
  const regular = TERMINAL_FONT_CANDIDATES.indexOf("CaskaydiaCove Nerd Font");
  assert.ok(mono >= 0 && regular >= 0 && mono < regular);
});

test("字体堆栈: Nerd Font 放首位；CJK 轮廓字体在 monospace 之前", () => {
  const withNerd = buildTerminalFontFamily("CaskaydiaCove Nerd Font Mono");
  assert.ok(withNerd.startsWith('"CaskaydiaCove Nerd Font Mono", '));
  assert.ok(withNerd.includes('"Cascadia Mono"'));
  assert.ok(withNerd.includes('"Microsoft YaHei"'));
  assert.ok(withNerd.endsWith(", monospace"));
  const nerdAt = withNerd.indexOf("CaskaydiaCove Nerd Font Mono");
  const cjkAt = withNerd.indexOf("Microsoft YaHei");
  const monoAt = withNerd.lastIndexOf("monospace");
  assert.ok(nerdAt < cjkAt && cjkAt < monoAt);

  const noNerd = buildTerminalFontFamily(null);
  assert.ok(noNerd.startsWith('"Cascadia Mono"'));
  assert.ok(noNerd.includes('"Microsoft YaHei"'));
  assert.equal(noNerd.includes("CaskaydiaCove"), false);
});

test("字体堆栈: 用户代码字体插在 Nerd Font 之后，不得抢测量第一位", () => {
  const stack = buildTerminalFontFamily("CaskaydiaCove Nerd Font Mono", '"Cascadia Code"');
  assert.ok(stack.startsWith('"CaskaydiaCove Nerd Font Mono", "Cascadia Code", '));
});

test("终端字号: 低于下限抬到 14；更大代码字号原样跟随", () => {
  assert.equal(resolveTerminalFontSize(12), TERMINAL_MIN_FONT_SIZE);
  assert.equal(resolveTerminalFontSize(13), TERMINAL_MIN_FONT_SIZE);
  assert.equal(resolveTerminalFontSize(16), 16);
  assert.equal(resolveTerminalFontSize(Number.NaN), TERMINAL_MIN_FONT_SIZE);
});

test("终端渲染选项: 行高/重叠缩放与字号下限一并生效", () => {
  const opts = resolveTerminalFontOptions("CaskaydiaCove Nerd Font Mono", {
    codeFontSize: 13,
    codeFontFamily: '"Cascadia Code"',
  });
  assert.equal(opts.fontSize, TERMINAL_MIN_FONT_SIZE);
  assert.equal(opts.lineHeight, TERMINAL_LINE_HEIGHT);
  assert.equal(opts.rescaleOverlappingGlyphs, true);
  assert.ok(opts.fontFamily.startsWith('"CaskaydiaCove Nerd Font Mono", "Cascadia Code", '));
});

function hexLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const toLin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLin((n >> 16) & 255) + 0.7152 * toLin((n >> 8) & 255) + 0.0722 * toLin(n & 255);
}

function contrastRatio(a: string, b: string): number {
  const l1 = hexLuminance(a);
  const l2 = hexLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

test("浅色主题: 黄/亮黄/亮白对白底达到 AA，避免 cline 看不清", () => {
  const bg = LIGHT_TERMINAL_THEME.background!;
  assert.ok(contrastRatio(LIGHT_TERMINAL_THEME.foreground!, bg) >= 7);
  assert.ok(contrastRatio(LIGHT_TERMINAL_THEME.yellow!, bg) >= 4.5);
  assert.ok(contrastRatio(LIGHT_TERMINAL_THEME.brightYellow!, bg) >= 4.5);
  assert.ok(contrastRatio(LIGHT_TERMINAL_THEME.brightWhite!, bg) >= 4.5);
  assert.ok(contrastRatio(LIGHT_TERMINAL_THEME.white!, bg) >= 4.5);
  assert.notEqual(LIGHT_TERMINAL_THEME.brightYellow, "#fce94f");
  assert.notEqual(LIGHT_TERMINAL_THEME.brightWhite, "#eeeeec");
});

test("主题对比度: 浅色拉到 7 校正真彩色亮黄；深色保持 1", () => {
  assert.equal(resolveTerminalContrastRatio("light"), LIGHT_TERMINAL_CONTRAST_RATIO);
  assert.equal(resolveTerminalContrastRatio("dark"), DARK_TERMINAL_CONTRAST_RATIO);
  assert.equal(resolveTerminalTheme("light").brightYellow, LIGHT_TERMINAL_THEME.brightYellow);
  assert.equal(resolveTerminalTheme("dark").background, "#1e1e1e");
});

/* ------------------------------------------------------------------ */
/* 运行                                                               */
/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log(`\n${"-".repeat(72)}`);
console.log(`terminal-bridge: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  for (const f of failed) console.error(`FAILED: ${f.name} — ${f.detail}`);
  process.exitCode = 1;
}
