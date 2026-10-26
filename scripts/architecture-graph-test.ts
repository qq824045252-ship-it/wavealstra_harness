/**
 * architecture-graph-test.ts — 架构图门禁（分层 / 运行期依赖环 / 文件行数棘轮 / preload 契约）。
 *
 * 背景（审计 artifacts/audit-2026-10-26/architecture-debt.md §3）：
 *   仓库没有 ESLint / dependency-cruiser / madge，`test:architecture` 的 N7–N14 是对
 *   **已知分解成果**的源码文本护栏，不是对结构本身的普遍约束。于是三类高风险事实
 *   只能靠人记住：①renderer 不得 import 主进程；②运行期 JS 依赖不得成环；③巨型文件不得
 *   继续膨胀。本脚本用仓库已有的 `@babel/parser` 建真实 import 图，把「惯例」变成「保证」。
 *
 * 设计（ratchet，基线只允许收紧）：
 *   - scripts/architecture-graph-baseline.json 记录**当前存量例外**（越层 1 条、运行期环 1 个、
 *     大文件行数）。基线内 → PASS；出现基线外的新现象 → FAIL 并给出精确位置。
 *   - 基线里已消失的例外 → 打印 "建议删除基线条目"（不失败），避免基线腐烂成白名单。
 *   - 本脚本**只读**：不写仓库任何文件；基线的更新只能人工改 JSON（或用 `--print-baseline`
 *     打印建议值后人工写入），避免"测试自己改基线"式的假绿。
 *
 * 检查项：
 *   0. 图完整性：所有源文件必须可解析（解析失败 = 图可能漏边 = 不允许假绿）。
 *   1. 层间导入：src/renderer ↛ src/main|src/preload；src/preload ↛ src/main|src/renderer；
 *      src/shared ↛ 三端；shared/src（workspace）↛ src/**；app/remote ↛ src/main|src/renderer。
 *   2. 运行期依赖环：剔除 `import type` / `export type`（编译期擦除）后的强连通分量（Tarjan）。
 *   3. 文件行数棘轮：基线内文件 +maxGrowth(200) 行失败；基线外新文件 >maxNew(2500) 失败。
 *   4. preload 契约（可选）：src/preload/index.ts 的 `api` 键集合 == index.d.ts 的
 *      `PreloadApi` 键集合；无法解析时打印 SKIP（不计入 PASS，绝不假绿）。
 *
 * 运行（与其它 test:* 一致：esbuild 打包 → test-guard）：
 *   esbuild scripts/architecture-graph-test.ts --bundle --platform=node --format=cjs \
 *     --outfile=out/tests/architecture-graph-test.cjs \
 *     && node scripts/test-guard.mjs out/tests/architecture-graph-test.cjs
 *
 * 其它模式：
 *   node out/tests/architecture-graph-test.cjs --print-baseline   # 打印建议基线（不写文件）
 *   node out/tests/architecture-graph-test.cjs --explain          # 打印每项检查的明细
 *   node out/tests/architecture-graph-test.cjs --check-baseline   # 只校验基线文件本身可读/可解释
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import type { ParserPlugin } from "@babel/parser";

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, "scripts", "architecture-graph-baseline.json");
const ARGS = new Set(process.argv.slice(2));
const EXPLAIN = ARGS.has("--explain");
const PRINT_BASELINE = ARGS.has("--print-baseline");
const CHECK_BASELINE = ARGS.has("--check-baseline");

const SIZE_BASELINE_FLOOR = 1000; // 行：只有 >=1000 行的文件进入行数基线
const GROWTH_ALLOWANCE = 200; // 行：基线内文件允许的增长
const NEW_FILE_LIMIT = 2500; // 行：基线外新文件的上限

// ---------------------------------------------------------------- 扫描与解析

/** 只扫源码树；`app/remote/android`、构建产物、发布目录一律跳过。 */
const SCAN_ROOTS = ["src", "app"];
const SKIP_DIRS = new Set([
  "node_modules", "out", "dist", "build", "release", "coverage", ".git",
  "android", "ios", "vendor",
]);
const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;

interface SourceFile {
  abs: string;
  rel: string; // 仓库相对路径，统一用 "/"
  lines: number;
}

function walk(dirAbs: string, out: SourceFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dirAbs, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(abs, out);
    } else if (SOURCE_EXT.test(name)) {
      const text = readFileSync(abs, "utf8");
      out.push({ abs, rel: toPosix(relative(ROOT, abs)), lines: countLines(text) });
    }
  }
}

/** 与 `wc -l` 对齐：只数换行符（末行无换行则不额外计一行）。 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n : n + 1;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

const PARSE_OPTS = {
  sourceType: "module" as const,
  errorRecovery: false,
  plugins: [
    "typescript",
    "jsx",
    "decorators-legacy",
    "importAttributes",
    "explicitResourceManagement",
  ] as ParserPlugin[],
};

interface Edge {
  from: string;
  to: string;
  spec: string;
  line: number;
  typeOnly: boolean;
}

interface ScanResult {
  files: SourceFile[];
  edges: Edge[];
  parseErrors: Array<{ rel: string; message: string }>;
  unresolved: Array<{ rel: string; line: number; spec: string }>;
  externals: Set<string>;
  virtualSpecs: Set<string>;
}

/** 解析模块说明符 → 仓库内文件相对路径；裸包名返回 null（外部依赖）。 */
function resolveSpec(fromRel: string, spec: string): string | null {
  const fromAbs = join(ROOT, fromRel);
  const candidates: string[] = [];
  if (spec.startsWith(".")) {
    candidates.push(resolve(dirname(fromAbs), spec));
  } else if (spec.startsWith("@/")) {
    candidates.push(join(ROOT, "src/renderer/src", spec.slice(2)));
  } else if (spec.startsWith("@shared/")) {
    candidates.push(join(ROOT, "src/shared", spec.slice(8)));
  } else if (spec === "@mybuddy/shared") {
    candidates.push(join(ROOT, "shared/src/index.ts"));
  } else if (spec.startsWith("@mybuddy/shared/")) {
    candidates.push(join(ROOT, "shared/src", spec.slice(16)));
  } else {
    return null; // 裸包（node_modules / node: 内建）
  }
  for (const c of candidates) {
    for (const suffix of ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"]) {
      const f = c + suffix;
      if (existsSync(f) && statSync(f).isFile()) return toPosix(relative(ROOT, f));
    }
  }
  return null;
}

function scan(): ScanResult {
  const files: SourceFile[] = [];
  for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const edges: Edge[] = [];
  const parseErrors: Array<{ rel: string; message: string }> = [];
  const unresolved: Array<{ rel: string; line: number; spec: string }> = [];
  const externals = new Set<string>();
  const virtualSpecs = new Set<string>();

  for (const f of files) {
    if (f.rel.endsWith(".d.ts")) continue; // 环境声明不参与依赖图（但参与行数棘轮）
    const code = readFileSync(f.abs, "utf8");
    let ast: ReturnType<typeof parse>;
    try {
      ast = parse(code, PARSE_OPTS);
    } catch (err) {
      parseErrors.push({ rel: f.rel, message: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const push = (spec: unknown, line: number, typeOnly: boolean): void => {
      if (typeof spec !== "string" || spec.length === 0) return;
      // Vite 虚拟模块（?asset / ?worker&inline / virtual:xxx）是构建期资源，不是源码依赖：
      // 既不能解析成文件，也不该算「内部路径解析不到」。单独计数，避免图完整性检查误报。
      if (isVirtualSpec(spec)) {
        virtualSpecs.add(spec.startsWith("virtual:") ? "virtual:*" : spec.slice(spec.indexOf("?")));
        return;
      }
      const target = resolveSpec(f.rel, spec);
      if (target) edges.push({ from: f.rel, to: target, spec, line, typeOnly });
      else if (!isInternalLooking(spec)) externals.add(bareName(spec));
      else unresolved.push({ rel: f.rel, line, spec });
    };

    for (const node of ast.program.body) {
      switch (node.type) {
        case "ImportDeclaration": {
          const allType =
            node.importKind === "type" ||
            (node.specifiers.length > 0 &&
              node.specifiers.every((s) => (s as { importKind?: string }).importKind === "type"));
          push(node.source.value, node.loc?.start.line ?? 0, allType);
          break;
        }
        case "ExportNamedDeclaration":
        case "ExportAllDeclaration": {
          if (node.source) {
            const typeOnly = (node as { exportKind?: string }).exportKind === "type";
            push(node.source.value, node.loc?.start.line ?? 0, typeOnly);
          }
          break;
        }
        case "TSImportEqualsDeclaration": {
          const ref = node.moduleReference;
          if (ref.type === "TSExternalModuleReference" && ref.expression.type === "StringLiteral") {
            push(ref.expression.value, node.loc?.start.line ?? 0, false);
          }
          break;
        }
        default:
          break;
      }
    }

    // 动态 import() / require()：都是运行期依赖。
    walkAst(ast.program, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as unknown as {
        arguments?: Array<{ type?: string; value?: unknown }>;
        callee?: { type?: string; name?: string };
        loc?: { start: { line: number } };
      };
      const arg = call.arguments?.[0];
      if (!arg || arg.type !== "StringLiteral" || typeof arg.value !== "string") return;
      const callee = call.callee;
      const isDynamicImport = callee?.type === "Import";
      const isRequire = callee?.type === "Identifier" && callee.name === "require";
      if (isDynamicImport || isRequire) push(arg.value, call.loc?.start.line ?? 0, false);
    });
  }

  return { files, edges, parseErrors, unresolved, externals, virtualSpecs };
}

/** Vite 虚拟模块说明符：`x?asset` / `x?worker&inline` / `virtual:…` / `\0…`。 */
function isVirtualSpec(spec: string): boolean {
  return spec.includes("?") || spec.startsWith("virtual:") || spec.startsWith("\0");
}

/** 相对/别名写法但解析不到 → 视为"内部路径可疑"，要报出来（裸包名不算）。 */
function isInternalLooking(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("@shared/") || spec.startsWith("@mybuddy/shared");
}

function bareName(spec: string): string {
  if (spec.startsWith("node:")) return spec;
  return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
}

/** 通用 AST 遍历（只走对象/数组，不依赖 @babel/traverse）。 */
function walkAst(node: unknown, cb: (n: { type: string; [k: string]: unknown }) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walkAst(n, cb);
    return;
  }
  const typed = node as { type?: unknown; [k: string]: unknown };
  if (typeof typed.type !== "string") return;
  cb(typed as { type: string; [k: string]: unknown });
  for (const key of Object.keys(typed)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
    const value = typed[key];
    if (value && typeof value === "object") walkAst(value, cb);
  }
}

// ---------------------------------------------------------------- 检查实现

interface Violation {
  /** 稳定 key：用于与基线比对（同一条例外跨运行不变） */
  key: string;
  /** 人读位置：相对路径:行 → 目标 */
  detail: string;
  /** 额外信息（越层的 spec、环成员等） */
  extra?: string;
}

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  violations: Violation[];
  notes: string[];
  /** true = 允许通过基线记录"既有例外"；false = 必须修代码（基线不能合法化） */
  tracked: boolean;
}

/** 1) 层间导入。返回基线外的越层（含 type-only，因为分层是"引用了就跨界"，与运行期无关）。 */
const LAYER_RULES: Array<{ from: string; to: string[]; why: string }> = [
  { from: "src/renderer/", to: ["src/main/", "src/preload/"], why: "renderer 只能经 preload 白名单访问主进程" },
  { from: "src/preload/", to: ["src/renderer/", "src/main/"], why: "preload 不得依赖两端实现" },
  { from: "src/shared/", to: ["src/main/", "src/renderer/", "src/preload/"], why: "shared 是被三端依赖的底层契约，不得反向依赖" },
  { from: "shared/src/", to: ["src/"], why: "workspace shared 包不得依赖桌面端源码" },
  { from: "app/remote/", to: ["src/main/", "src/renderer/"], why: "移动端只能消费 @mybuddy/shared 契约；共享组件应先下沉" },
];

function checkLayers(scanResult: ScanResult, baseline: Baseline): CheckResult {
  const violations: Violation[] = [];
  const notes: string[] = [];
  for (const e of scanResult.edges) {
    for (const rule of LAYER_RULES) {
      if (!e.from.startsWith(rule.from)) continue;
      if (!rule.to.some((p) => e.to.startsWith(p))) continue;
      violations.push({
        key: `layer:${e.from}->${e.to}`,
        detail: `${e.from}:${e.line} → ${e.to}`,
        extra: `${rule.why}（spec: ${e.spec}）`,
      });
    }
  }
  const allowed = new Set(baseline.layers.allow.map((a) => a.key));
  const outside = violations.filter((v) => !allowed.has(v.key));
  const seen = new Set<string>();
  for (const v of outside) if (!seen.has(v.key)) seen.add(v.key);
  const stale = [...allowed].filter((k) => !violations.some((v) => v.key === k));
  if (stale.length) notes.push(`基线里 ${stale.length} 条越层例外已消失，建议删除：${stale.join(", ")}`);
  return {
    name: `层间导入（${LAYER_RULES.length} 条禁止方向）`,
    status: outside.length ? "fail" : "pass",
    violations: outside.filter((v, i, arr) => arr.findIndex((x) => x.key === v.key) === i),
    notes,
    tracked: true,
  };
}

/** 2) 运行期依赖环（剔除 type-only 边后的 SCC）。 */
function checkCycles(scanResult: ScanResult, baseline: Baseline): CheckResult {
  const nodes = scanResult.files.filter((f) => !f.rel.endsWith(".d.ts")).map((f) => f.rel);
  const index = new Map(nodes.map((n, i) => [n, i]));
  const adj = new Map<string, string[]>();
  for (const e of scanResult.edges) {
    if (e.typeOnly) continue;
    if (!index.has(e.from) || !index.has(e.to)) continue;
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const sccs = tarjan(nodes, adj).filter((c) => c.length > 1);
  const keyOf = (members: string[]): string => `cycle:${[...members].sort().join("|")}`;
  const allowed = new Map(baseline.runtimeCycles.allow.map((a) => [a.key, a]));
  const current = sccs.map((members) => ({
    members: [...members].sort(),
    key: keyOf(members),
    detail: `环（${members.length} 文件）：${[...members].sort().join(" ↔ ")}`,
  }));
  const outside = current.filter((c) => !allowed.has(c.key));
  const stale = [...allowed.keys()].filter((k) => !current.some((c) => c.key === k));
  const notes: string[] = [];
  if (stale.length) notes.push(`基线里 ${stale.length} 个环已消失（好），建议删除基线条目`);
  if (EXPLAIN) for (const c of current) notes.push(`现有环 ${c.key}${allowed.has(c.key) ? "（基线内，待拆）" : "（基线外！）"}`);
  return {
    name: "运行期依赖环（剔除 import type）",
    status: outside.length ? "fail" : "pass",
    violations: outside.map((c) => ({ key: c.key, detail: c.detail })),
    notes,
    tracked: true,
  };
}

/** Tarjan 强连通分量（迭代写法，避免大图递归栈溢出）。 */
function tarjan(nodes: string[], adj: Map<string, string[]>): string[][] {
  let counter = 0;
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  for (const start of nodes) {
    if (indexOf.has(start)) continue;
    const work: Array<{ node: string; childIndex: number }> = [{ node: start, childIndex: 0 }];
    indexOf.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const children = adj.get(frame.node) ?? [];
      if (frame.childIndex < children.length) {
        const child = children[frame.childIndex]!;
        frame.childIndex++;
        if (!indexOf.has(child)) {
          indexOf.set(child, counter);
          low.set(child, counter);
          counter++;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, childIndex: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, indexOf.get(child)!));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!;
          low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        }
        if (low.get(frame.node) === indexOf.get(frame.node)) {
          const component: string[] = [];
          for (;;) {
            const popped = stack.pop()!;
            onStack.delete(popped);
            component.push(popped);
            if (popped === frame.node) break;
          }
          result.push(component);
        }
      }
    }
  }
  return result;
}

/** 3) 文件行数棘轮。 */
function checkFileSizes(scanResult: ScanResult, baseline: Baseline): CheckResult {
  const violations: Violation[] = [];
  const notes: string[] = [];
  const entries = baseline.fileSizes.entries;
  const current = new Map(scanResult.files.map((f) => [f.rel, f.lines]));
  for (const f of scanResult.files) {
    const recorded = entries[f.rel];
    if (recorded === undefined) {
      if (f.lines > NEW_FILE_LIMIT) {
        violations.push({
          key: `size:new:${f.rel}`,
          detail: `${f.rel} 新文件 ${f.lines} 行 > 上限 ${NEW_FILE_LIMIT}`,
        });
      }
      continue;
    }
    if (f.lines > recorded + GROWTH_ALLOWANCE) {
      violations.push({
        key: `size:grow:${f.rel}`,
        detail: `${f.rel} ${recorded} → ${f.lines} 行（+${f.lines - recorded} > 允许 ${GROWTH_ALLOWANCE}）`,
      });
    } else if (f.lines < recorded) {
      notes.push(`${f.rel} 已从 ${recorded} 降到 ${f.lines} 行，可下调基线`);
    }
  }
  const stale = Object.keys(entries).filter((p) => !current.has(p));
  if (stale.length) notes.push(`基线里 ${stale.length} 个文件已不存在，建议删除：${stale.join(", ")}`);
  return {
    name: `文件行数棘轮（基线 ${Object.keys(entries).length} 个文件，+${GROWTH_ALLOWANCE} 行 / 新文件 ≤${NEW_FILE_LIMIT}）`,
    status: violations.length ? "fail" : "pass",
    violations,
    notes,
    tracked: true,
  };
}

/** 4) preload 契约：api 对象键集合 vs 手写 PreloadApi 接口键集合。 */
function checkPreloadContract(baseline: Baseline): CheckResult {
  const implPath = join(ROOT, "src/preload/index.ts");
  const dtsPath = join(ROOT, "src/preload/index.d.ts");
  const skip = (reason: string): CheckResult => ({
    name: "preload 契约（api 键集合 vs PreloadApi）",
    status: "skip",
    violations: [],
    notes: [`SKIP：${reason}`],
    tracked: false,
  });
  if (!existsSync(implPath) || !existsSync(dtsPath)) return skip("preload 入口或 index.d.ts 不存在");
  let implKeys: Set<string>;
  let dtsKeys: Set<string>;
  try {
    implKeys = preloadApiKeys(readFileSync(implPath, "utf8"));
    dtsKeys = preloadApiKeysFromDts(readFileSync(dtsPath, "utf8"));
  } catch (err) {
    return skip(`解析失败（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (implKeys.size === 0) return skip("未能在 src/preload/index.ts 定位 `const api = {…}`");
  if (dtsKeys.size === 0) return skip("未能在 src/preload/index.d.ts 定位 `interface PreloadApi`");

  const violations: Violation[] = [];
  const onlyImpl = [...implKeys].filter((k) => !dtsKeys.has(k)).sort();
  const onlyDts = [...dtsKeys].filter((k) => !implKeys.has(k)).sort();
  for (const k of onlyImpl) {
    violations.push({ key: `preload:only-impl:${k}`, detail: `index.ts 暴露但 index.d.ts 缺失：${k}` });
  }
  for (const k of onlyDts) {
    violations.push({ key: `preload:only-dts:${k}`, detail: `index.d.ts 声明但 index.ts 未暴露：${k}` });
  }
  const notes: string[] = [];
  const recorded = baseline.preloadContract.keys;
  if (implKeys.size !== recorded) {
    notes.push(
      `契约键数 ${recorded} → ${implKeys.size}：确认是预期新增/删除后更新基线 preloadContract.keys（仅提示，不失败）`,
    );
  }
  return {
    name: `preload 契约（${implKeys.size} 键一致）`,
    status: violations.length ? "fail" : "pass",
    violations,
    notes,
    tracked: false,
  };
}

function preloadApiKeys(code: string): Set<string> {
  const ast = parse(code, PARSE_OPTS);
  const keys = new Set<string>();
  walkAst(ast.program, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const id = node.id as { type?: string; name?: string } | undefined;
    const init = node.init as { type?: string; properties?: Array<{ type: string; key?: { type?: string; name?: string; value?: unknown } }> } | undefined;
    if (id?.name !== "api" || init?.type !== "ObjectExpression" || !init.properties) return;
    for (const prop of init.properties) {
      if (prop.type !== "ObjectProperty" || !prop.key) continue;
      if (prop.key.type === "Identifier" && prop.key.name) keys.add(prop.key.name);
      else if (prop.key.type === "StringLiteral" && typeof prop.key.value === "string") keys.add(prop.key.value);
    }
  });
  return keys;
}

function preloadApiKeysFromDts(code: string): Set<string> {
  const ast = parse(code, PARSE_OPTS);
  const keys = new Set<string>();
  for (const raw of ast.program.body) {
    const node = (raw as { declaration?: unknown }).declaration ?? raw;
    const decl = node as {
      type?: string;
      id?: { name?: string };
      body?: { body?: Array<{ key?: { type?: string; name?: string; value?: unknown } }> };
    };
    if (decl.type !== "TSInterfaceDeclaration" || decl.id?.name !== "PreloadApi") continue;
    for (const member of decl.body?.body ?? []) {
      const key = member.key;
      if (!key) continue;
      if (key.type === "Identifier" && key.name) keys.add(key.name);
      else if (key.type === "StringLiteral" && typeof key.value === "string") keys.add(key.value);
    }
  }
  return keys;
}

// ---------------------------------------------------------------- 基线

interface Baseline {
  $comment?: string;
  $source?: { head?: string; generatedAt?: string; generator?: string } & Record<string, unknown>;
  layers: { allow: Array<{ key: string; detail?: string; note?: string }> };
  runtimeCycles: { allow: Array<{ key: string; members?: string[]; note?: string }> };
  fileSizes: { maxGrowth: number; maxNew: number; floor: number; entries: Record<string, number> };
  preloadContract: { keys: number };
}

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(`缺少基线文件 ${relative(ROOT, BASELINE_PATH)}；先跑 --print-baseline 生成并由人工写入`);
  }
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  if (!parsed.layers || !Array.isArray(parsed.layers.allow)) throw new Error("基线缺少 layers.allow");
  if (!parsed.runtimeCycles || !Array.isArray(parsed.runtimeCycles.allow)) throw new Error("基线缺少 runtimeCycles.allow");
  if (!parsed.fileSizes || typeof parsed.fileSizes.entries !== "object") throw new Error("基线缺少 fileSizes.entries");
  if (!parsed.preloadContract) throw new Error("基线缺少 preloadContract");
  return parsed;
}

/** 由当前扫描结果推导"建议基线"，保留既有条目的 note（说明为什么允许）。 */
function buildBaseline(scanResult: ScanResult, previous: Baseline | null): Baseline {
  const layerViolations = new Map<string, Violation>();
  for (const e of scanResult.edges) {
    for (const rule of LAYER_RULES) {
      if (!e.from.startsWith(rule.from)) continue;
      if (!rule.to.some((p) => e.to.startsWith(p))) continue;
      const key = `layer:${e.from}->${e.to}`;
      if (!layerViolations.has(key)) {
        layerViolations.set(key, {
          key,
          detail: `${e.from}:${e.line} → ${e.to}`,
          extra: rule.why,
        });
      }
    }
  }
  const prevLayerNotes = new Map((previous?.layers.allow ?? []).map((a) => [a.key, a.note ?? ""]));
  const prevCycleNotes = new Map((previous?.runtimeCycles.allow ?? []).map((a) => [a.key, a.note ?? ""]));

  const nodes = scanResult.files.filter((f) => !f.rel.endsWith(".d.ts")).map((f) => f.rel);
  const index = new Set(nodes);
  const adj = new Map<string, string[]>();
  for (const e of scanResult.edges) {
    if (e.typeOnly || !index.has(e.from) || !index.has(e.to)) continue;
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const cycles = tarjan(nodes, adj)
    .filter((c) => c.length > 1)
    .map((members) => ({ members: [...members].sort() }));

  const entries: Record<string, number> = {};
  const prevEntries = previous?.fileSizes.entries ?? {};
  for (const f of scanResult.files) {
    const recorded = prevEntries[f.rel];
    if (f.lines >= SIZE_BASELINE_FLOOR || recorded !== undefined) entries[f.rel] = f.lines;
  }
  const sortedEntries: Record<string, number> = {};
  for (const key of Object.keys(entries).sort((a, b) => entries[b]! - entries[a]! || a.localeCompare(b))) {
    sortedEntries[key] = entries[key]!;
  }

  const implPath = join(ROOT, "src/preload/index.ts");
  const dtsPath = join(ROOT, "src/preload/index.d.ts");
  let preloadKeys = previous?.preloadContract.keys ?? 0;
  try {
    preloadKeys = preloadApiKeys(readFileSync(implPath, "utf8")).size;
  } catch {
    /* 保留旧值；--print-baseline 会在 stderr 提示 */
  }

  return {
    $comment:
      "架构图门禁棘轮基线（scripts/architecture-graph-test.ts）。只允许记录**既有**例外：新增越层/新增运行期环/" +
      "文件超限都必须先在代码上解决，确属有意设计才写进这里，并在 note 里写明原因与处置计划。" +
      "基线只允许收紧：条目消失后请删除对应条目（脚本会打印建议）。人工更新，禁止让测试自己改写。" +
      "更新流程：①node out/tests/architecture-graph-test.cjs --print-baseline > /tmp/b.json；" +
      "②把差异人工合并进本文件（保留既有 note 与各段 $comment）；" +
      "③把 $source.head 改成当前 git rev-parse --short HEAD，generatedAt 改成当前时间。",
    $source: {
      head: previous?.$source?.head ?? "UNKNOWN",
      generatedAt: new Date().toISOString(),
      generator: "scripts/architecture-graph-test.ts --print-baseline",
      fileCount: scanResult.files.length,
      edgeCount: scanResult.edges.length,
    },
    layers: {
      allow: [...layerViolations.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((v) => ({
          key: v.key,
          detail: v.detail,
          note: prevLayerNotes.get(v.key) || "新增例外：需人工确认原因（当前未填写）",
        })),
    },
    runtimeCycles: {
      allow: cycles.map((c) => ({
        key: `cycle:${c.members.join("|")}`,
        members: c.members,
        note:
          prevCycleNotes.get(`cycle:${c.members.join("|")}`) ||
          "新增例外：需人工确认原因（当前未填写）",
      })),
    },
    fileSizes: {
      maxGrowth: GROWTH_ALLOWANCE,
      maxNew: NEW_FILE_LIMIT,
      floor: SIZE_BASELINE_FLOOR,
      entries: sortedEntries,
    },
    preloadContract: { keys: preloadKeys },
  };
}

// ---------------------------------------------------------------- 主流程

function main(): void {
  const started = Date.now();
  const previous = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline)
    : null;

  if (CHECK_BASELINE) {
    const b = loadBaseline();
    console.log(`[architecture-graph] 基线可解析：越层 ${b.layers.allow.length} 条、环 ${b.runtimeCycles.allow.length} 个、大文件 ${Object.keys(b.fileSizes.entries).length} 个`);
    console.log("[architecture-graph] PASS（仅校验基线文件）");
    return;
  }

  const scanResult = scan();
  if (PRINT_BASELINE) {
    console.log(JSON.stringify(buildBaseline(scanResult, previous), null, 2));
    return;
  }

  const baseline = loadBaseline();
  console.log(
    `[architecture-graph] 扫描 ${scanResult.files.length} 个源文件 / ${scanResult.edges.length} 条依赖边 ` +
      `（外部包 ${scanResult.externals.size} 个，未解析内部路径 ${scanResult.unresolved.length} 条）`,
  );

  const results: CheckResult[] = [
    checkGraphCompleteness(scanResult),
    checkLayers(scanResult, baseline),
    checkCycles(scanResult, baseline),
    checkFileSizes(scanResult, baseline),
    checkPreloadContract(baseline),
  ];

  let failed = 0;
  let passed = 0;
  let skipped = 0;
  for (const r of results) {
    const tag = r.status === "pass" ? "PASS" : r.status === "skip" ? "SKIP" : "FAIL";
    console.log(`${tag} ${r.name}`);
    for (const v of r.violations) {
      console.log(`   + ${v.detail}${v.extra ? `  [${v.extra}]` : ""}`);
    }
    for (const n of r.notes) console.log(`   · ${n}`);
    if (r.status === "fail") failed++;
    else if (r.status === "skip") skipped++;
    else passed++;
  }

  if (failed > 0) {
    const failedResults = results.filter((r) => r.status === "fail");
    console.log("");
    console.log("如何处置：");
    if (failedResults.some((r) => !r.tracked)) {
      console.log("  · 本脚本无法解析/无法验证的项（图完整性、preload 契约）：必须修代码或修解析，不能写进基线；");
    }
    if (failedResults.some((r) => r.tracked)) {
      console.log("  · 优先改代码（拆环 / 下沉共享组件 / 拆分巨型文件），不要先改基线；");
      console.log("  · 确属有意设计：把上面的条目写进 scripts/architecture-graph-baseline.json 的对应 allow 数组，");
      console.log("    并在 note 里写清原因与处置计划（基线条目会在每次运行输出里列出，保持可见）；");
      console.log("  · 基线只允许收紧：条目消失后请删除（脚本会打印建议）。");
    }
    console.log(`[architecture-graph] FAIL ${failed} 项检查未通过（耗时 ${Date.now() - started}ms）`);
    process.exit(1);
  }

  console.log(
    `[architecture-graph] PASS ${passed}/${results.length} 项检查` +
      (skipped ? `（${skipped} SKIP：未验证，勿当作通过）` : "") +
      ` · 基线例外：越层 ${baseline.layers.allow.length}、运行期环 ${baseline.runtimeCycles.allow.length}、` +
      `大文件 ${Object.keys(baseline.fileSizes.entries).length}（耗时 ${Date.now() - started}ms）`,
  );
}

/** 0) 图完整性：解析失败/内部路径解析不到 → 图可能漏边，不允许假绿。 */
function checkGraphCompleteness(scanResult: ScanResult): CheckResult {
  const violations: Violation[] = [];
  for (const e of scanResult.parseErrors) {
    violations.push({ key: `parse:${e.rel}`, detail: `${e.rel} 解析失败：${e.message}` });
  }
  for (const u of scanResult.unresolved) {
    violations.push({ key: `unresolved:${u.rel}:${u.line}`, detail: `${u.rel}:${u.line} 内部路径解析不到：${u.spec}` });
  }
  // 反假绿：cwd 不对（如在其它目录运行）时扫描结果会接近空，此时不能让检查"空过"。
  if (scanResult.files.length < 300 || scanResult.edges.length < 500) {
    violations.push({
      key: "scan:too-small",
      detail: `扫描结果异常：${scanResult.files.length} 个文件 / ${scanResult.edges.length} 条边（预期 ≥300 / ≥500），检查是否在仓库根目录运行`,
    });
  }
  const notes = EXPLAIN
    ? [
        `外部依赖 ${scanResult.externals.size} 个（不参与分层判定）`,
        `Vite 虚拟模块 ${scanResult.virtualSpecs.size} 类（${[...scanResult.virtualSpecs].join(", ")}；不参与依赖图）`,
      ]
    : [];
  return {
    name: "图完整性（可解析、内部路径可达）",
    status: violations.length ? "fail" : "pass",
    violations,
    notes,
    tracked: false,
  };
}

try {
  main();
} catch (err) {
  // 基线缺失/损坏、扫描根不存在等环境问题：明确 FAIL，不要以未捕获异常的形式模糊退出。
  console.error(`[architecture-graph] FAIL 运行环境异常：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
