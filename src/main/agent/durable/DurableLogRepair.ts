import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * 受损 Durable JSONL 日志的确定性修复。
 *
 * 背景（真实事故）：@earendil-works/pi-durable 的 JSONL 存储**没有跨进程锁**
 * （README: "One process owns a storage at a time; there is no cross-process locking."）。
 * 当第二个 MyBuddy 实例（例如打包版 + dev 版同时运行）恢复同一个 Bot 会话时，两个写入者
 * 各自从自己的计数继续提交，main.jsonl 里出现**重复的 commit seq**。
 * `JsonlStorage.recover()` 要求 seq 严格递增，于是整个目录直接打不开：
 * `DurableBotService.history()` 抛错 → 渲染层拿不到消息 → Bot 会话永远显示空白。
 *
 * 修复策略：保留「文件顺序中第一次出现」的提交（与 recover 的严格递增读法一致），
 * 丢弃后续重复 seq 的杂散提交；sidecar 记录只保留被有效提交确认过的 (seq, ordinal)。
 * 修复前把原始文件整份复制到 `repair-backup-<时间戳>/`，可人工回退。
 */

const MAIN_FILE = "main.jsonl";
const SIDECAR_FILE = /^(?:doc|task)-(?:0|[1-9]\d*)\.jsonl$/;
const FORMAT_VERSION = 1;

export interface DurableLogRepairReport {
  directory: string;
  backupDirectory: string;
  keptMainCommits: number;
  droppedMainCommits: number;
  droppedSidecarRecords: number;
  rewrittenSidecarFiles: string[];
  lastKeptSeq: number;
}

interface MainMarker {
  seq: number;
  writes: Array<{ type: string; id?: number; ordinal?: number; record?: { id?: number } }>;
}

interface SidecarRecord {
  seq: number;
  ordinal: number;
}

function splitLines(text: string): string[] {
  return text.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line).filter(line => line.length > 0);
}

function parseCommitLine(text: string): MainMarker | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const marker = value as { format?: unknown; type?: unknown; seq?: unknown; writes?: unknown };
  if (marker.format !== FORMAT_VERSION || marker.type !== "commit") return undefined;
  if (!Number.isSafeInteger(marker.seq) || (marker.seq as number) < 1) return undefined;
  if (!Array.isArray(marker.writes)) return undefined;
  const writes = marker.writes.filter((write): write is MainMarker["writes"][number] =>
    typeof write === "object" && write !== null && typeof (write as { type?: unknown }).type === "string");
  return { seq: marker.seq as number, writes };
}

function parseSidecarLine(text: string): SidecarRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { format?: unknown; type?: unknown; seq?: unknown; ordinal?: unknown };
  if (record.format !== FORMAT_VERSION || record.type !== "record") return undefined;
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 1) return undefined;
  if (!Number.isSafeInteger(record.ordinal) || (record.ordinal as number) < 0) return undefined;
  return { seq: record.seq as number, ordinal: record.ordinal as number };
}

/** sidecar 的确认键与 JsonlStorage 内部一致：文件 + commit seq + ordinal。 */
export function confirmedSidecarKeys(kept: readonly { seq: number; writes: MainMarker["writes"] }[]): Set<string> {
  const keys = new Set<string>();
  for (const marker of kept) {
    for (const write of marker.writes) {
      const ordinal = Number.isSafeInteger(write.ordinal) ? (write.ordinal as number) : 0;
      if (write.type === "document.create" && Number.isSafeInteger(write.record?.id)) keys.add(`doc-${write.record!.id}.jsonl:${marker.seq}:${ordinal}`);
      else if (write.type === "document.change" && Number.isSafeInteger(write.id)) keys.add(`doc-${write.id}.jsonl:${marker.seq}:${ordinal}`);
      else if (write.type === "task.sidecar" && Number.isSafeInteger(write.id)) keys.add(`task-${write.id}.jsonl:${marker.seq}:${ordinal}`);
    }
  }
  return keys;
}

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.repair-tmp`;
  const handle = openSync(temporary, "w");
  try {
    writeSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * 修复一个 Durable 目录里的非单调提交序列。
 * 返回 undefined 表示日志本来就是对的（不写盘、不改动任何文件）。
 */
export function repairDurableJsonlLog(directory: string): DurableLogRepairReport | undefined {
  const mainPath = join(directory, MAIN_FILE);
  if (!existsSync(mainPath)) return undefined;

  const keptMain: Array<{ text: string; value: MainMarker }> = [];
  let droppedMainCommits = 0;
  let previousSeq = 0;
  for (const text of splitLines(readFileSync(mainPath, "utf8"))) {
    const value = parseCommitLine(text);
    if (!value || value.seq <= previousSeq) {
      droppedMainCommits++;
      continue;
    }
    previousSeq = value.seq;
    keptMain.push({ text, value });
  }

  const confirmed = confirmedSidecarKeys(keptMain.map(line => line.value));
  const rewrittenContents = new Map<string, string>();
  let droppedSidecarRecords = 0;
  for (const file of readdirSync(directory).filter(name => SIDECAR_FILE.test(name)).sort()) {
    const keptRecords: string[] = [];
    let dropped = 0;
    let previous: SidecarRecord | undefined;
    for (const text of splitLines(readFileSync(join(directory, file), "utf8"))) {
      const record = parseSidecarLine(text);
      const ordered = record !== undefined && (previous === undefined
        || record.seq > previous.seq
        || (record.seq === previous.seq && record.ordinal > previous.ordinal));
      if (!record || !ordered || !confirmed.has(`${file}:${record.seq}:${record.ordinal}`)) {
        dropped++;
        continue;
      }
      previous = record;
      keptRecords.push(text);
    }
    if (dropped === 0) continue;
    droppedSidecarRecords += dropped;
    rewrittenContents.set(file, keptRecords.length > 0 ? `${keptRecords.join("\n")}\n` : "");
  }

  if (droppedMainCommits === 0 && droppedSidecarRecords === 0) return undefined;

  const backupDirectory = join(directory, `repair-backup-${backupStamp()}`);
  mkdirSync(backupDirectory, { recursive: true });
  for (const file of [MAIN_FILE, ...rewrittenContents.keys()]) {
    const source = join(directory, file);
    if (existsSync(source)) copyFileSync(source, join(backupDirectory, file));
  }
  if (droppedMainCommits > 0) {
    writeAtomic(mainPath, keptMain.length > 0 ? `${keptMain.map(line => line.text).join("\n")}\n` : "");
  }
  for (const [file, content] of rewrittenContents) writeAtomic(join(directory, file), content);

  return {
    directory,
    backupDirectory,
    keptMainCommits: keptMain.length,
    droppedMainCommits,
    droppedSidecarRecords,
    rewrittenSidecarFiles: [...rewrittenContents.keys()],
    lastKeptSeq: previousSeq,
  };
}

/** 修复报告里可回收的临时备份（仅用于测试/诊断，不参与主流程）。 */
export function removeRepairBackup(report: DurableLogRepairReport): void {
  const backup = report.backupDirectory;
  if (!existsSync(backup)) return;
  for (const name of readdirSync(backup)) {
    try {
      unlinkSync(join(backup, name));
    } catch {
      /* best effort */
    }
  }
}
