/**
 * Wave 1D — Current Behavior Characterization Tests（V3.5 §43-46）
 *
 * 锁"当前用户已经能得到的有价值 Artifact 产品行为"，不是新 Domain contract。
 * 重构后这些行为不能无意丢失；本测试是 Wave 2/3 的回归保险。
 *
 * 运行：pnpm test:artifact-char（esbuild bundle → node）
 * 隔离：monkey-patch os.homedir → 临时目录，不触碰真实 ~/.mybuddy 数据。
 *
 * 当前覆盖（main 侧可测）：
 *   C1  artifact-index 文件格式：JSON 合法 + task 记录为数组（migration 读取的输入契约）
 *   C2  幂等：同 path 重复 remember 不产生重复记录
 *   C3  排序：最新 remember 的记录在前（ordering，§45）
 *   C4  loadTaskArtifacts 恢复 DTO：id 确定性 / kind / name / path
 *   C5  文件缺失时跳过（history restore 健壮性）
 *   C6  未知 taskId → 空数组
 *   C7  跨重启持久化：重新 readIndex 数据仍在
 *   C8  预览内容往返：loadTaskArtifacts 的 content 与磁盘一致（truncate 边界）
 *
 * renderer 侧行为（task switch 状态 / applyAgentPatch 合并 / DetailCard 渲染）
 * 由 Wave 1E screenshot harness + 后续 E2E 覆盖，此处仅文档化清单（文件尾）。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import os from "node:os";

// ---------- 隔离：homedir → 临时目录（paths.ts 每次调用 os.homedir()，patch 生效） ----------
const tmpRoot = mkdtempSync(join(tmpdir(), "mybuddy-char-"));
os.homedir = () => tmpRoot;
mkdirSync(join(tmpRoot, ".mybuddy"), { recursive: true });

// ---------- 被测代码（与主进程同一份） ----------
// P1 起 artifact-index 是 read-only legacy 数据源（生产写入已停止）；
// C1-C3 改为直接按旧格式写 index 文件，锁定「迁移要读的文件格式」。
import { loadTaskArtifacts } from "../src/main/agent/artifact-index";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ---------- fixture 文件 ----------
const wsRoot = join(tmpRoot, "ws");
mkdirSync(join(wsRoot, "sub"), { recursive: true });
const fileA = join(wsRoot, "report.md");
const fileB = join(wsRoot, "sub", "chart.html");
const indexFile = join(tmpRoot, ".mybuddy", "artifact-index.json");

interface LegacyRecord {
  path: string;
  messageId: string;
  updatedAt: number;
}

/** 按旧版本写入格式构造 index 文件（等效老 App rememberTaskArtifact 的落盘结果：
 *  同 path 去重 + FIFO 追加）。仅用于构造迁移输入，不代表生产仍在写。 */
function appendIndexRecord(taskId: string, record: LegacyRecord): void {
  let index: Record<string, LegacyRecord[]> = {};
  try {
    index = JSON.parse(readFileSync(indexFile, "utf-8")) as Record<string, LegacyRecord[]>;
  } catch {
    /* 首次写入 */
  }
  const records = index[taskId] ?? [];
  index[taskId] = [
    ...records.filter((r) => r.path.toLowerCase() !== record.path.toLowerCase()),
    record,
  ];
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

async function main(): Promise<void> {
  writeFileSync(fileA, "# 周报\n\n| 项 | 值 |\n|---|---|\n| A | 1 |\n\n```ts\nconst x: number = 1;\n```\n", "utf-8");
  writeFileSync(fileB, "<!doctype html><html><body><h1>chart</h1></body></html>", "utf-8");

// ---------- C1/C2/C3: 旧 index 文件格式（migration 读取的输入契约） ----------
appendIndexRecord("task-1", { path: fileA, messageId: "msg-1", updatedAt: Date.now() });
const raw = readFileSync(indexFile, "utf-8");
let index: Record<string, LegacyRecord[]> = {};
try {
  index = JSON.parse(raw);
  check("C1 index 文件 JSON 合法且 task 记录为数组（旧格式）", Array.isArray(index["task-1"]));
} catch {
  check("C1 index 文件 JSON 合法且 task 记录为数组（旧格式）", false, "JSON 解析失败");
}

// ---------- C2: 同 path 记录不重复（旧写入语义，迁移读取不受重复影响） ----------
appendIndexRecord("task-1", { path: fileA, messageId: "msg-2", updatedAt: Date.now() });
const afterDup = JSON.parse(readFileSync(indexFile, "utf-8")) as Record<string, LegacyRecord[]>;
check(
  "C2 同 path 记录不重复（旧格式语义）",
  afterDup["task-1"].filter((r) => r.path === fileA).length === 1,
  `count=${afterDup["task-1"].length}`,
);

// ---------- C3: 顺序（新记录追加到末尾，FIFO；loadTaskArtifacts 按数组序返回） ----------
appendIndexRecord("task-1", { path: fileB, messageId: "msg-3", updatedAt: Date.now() });
const afterOrder = JSON.parse(readFileSync(indexFile, "utf-8")) as Record<string, LegacyRecord[]>;
check(
  "C3 新记录追加到末尾（FIFO，旧格式语义）",
  afterOrder["task-1"][afterOrder["task-1"].length - 1]?.path === fileB && afterOrder["task-1"][0]?.path === fileA,
  afterOrder["task-1"].map((r) => r.path.split(/[\\/]/).pop()).join(" → "),
);

// ---------- C4: DTO 恢复 ----------
const dtoA = (await loadTaskArtifacts("task-1")).find((a) => a.path === fileA);
check("C4a loadTaskArtifacts 恢复 name/kind", dtoA?.name === "report.md" && dtoA?.kind === "markdown", `${dtoA?.name}/${dtoA?.kind}`);
check(
  "C4b artifact id 确定性（base64url of path）",
  dtoA?.id === `indexed-task-1-${Buffer.from(fileA).toString("base64url")}`,
  dtoA?.id,
);
check("C4c content 与磁盘一致", dtoA?.content?.includes("# 周报") === true && dtoA.content?.includes("```ts") === true);

// ---------- C5: 缺失文件跳过 ----------
const fileGone = join(wsRoot, "gone.md");
writeFileSync(fileGone, "将被删除", "utf-8");
appendIndexRecord("task-1", { path: fileGone, messageId: "msg-4", updatedAt: Date.now() });
rmSync(fileGone);
const afterGone = await loadTaskArtifacts("task-1");
check("C5 文件缺失时跳过（不抛错）", !afterGone.some((a) => a.path === fileGone), `restored=${afterGone.length}`);

// ---------- C6: 未知 task ----------
check("C6 未知 taskId → 空数组", (await loadTaskArtifacts("task-unknown")).length === 0);

// ---------- C7: 跨"重启"持久化 ----------
const dtoAgain = (await loadTaskArtifacts("task-1")).find((a) => a.path === fileA);
check("C7 重新读取（模拟重启）数据仍在", dtoAgain !== undefined && dtoAgain.id === dtoA?.id);

// ---------- C8: 长文件截断边界 ----------
const longMd = join(wsRoot, "long.md");
writeFileSync(longMd, "# 长文档\n\n" + "段落内容 ".repeat(5_000) + "\n", "utf-8");
appendIndexRecord("task-1", { path: longMd, messageId: "msg-5", updatedAt: Date.now() });
const dtoLong = (await loadTaskArtifacts("task-1")).find((a) => a.path === longMd);
check("C8 长文件恢复不抛错且非空", dtoLong !== undefined && (dtoLong.content?.length ?? 0) > 0, `len=${dtoLong?.content?.length}`);

// ---------- 汇总 ----------
const failed = results.filter(([, p]) => !p);
console.log(`\n===== Characterization: ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) {
  for (const [name, , detail] of failed) console.log(`  - ${name}${detail ? ` (${detail})` : ""}`);
}

/**
 * renderer 侧待覆盖清单（Wave 1E harness + E2E 就绪后补）：
 *   R1 task switch 后 artifacts 状态保持（§23）
 *   R2 history restore 恢复 artifact 关联（§45）
 *   R3 applyAgentPatch "artifact" 事件合并语义（appStore.ts:832）
 *   R4 DetailCard PREVIEW_BOOT_SCRIPT data-* canvas 渲染（fixture: html-canvas）
 *   R5 ArtifactPanel 打开/关闭/切换不残留 WCV（§45 artifact open/close）
 *   R6 workspace change → artifact 更新（emitChangedArtifacts → task.artifacts）
 *   R7 task delete 后 artifacts 清空
 */
rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
}

void main();
