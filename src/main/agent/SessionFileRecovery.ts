import { readFileSync } from "node:fs";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { SessionHistoryRecoveryDto } from "../../shared/agent-ipc";

interface JsonlInspection {
  invalidRecords: number;
  firstInvalidLine?: number;
  tailOnly: boolean;
  validLines: string[];
  nonEmptyLines: string[];
}

function inspectJsonl(path: string): JsonlInspection {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const invalid: number[] = [];
  const validLines: string[] = [];
  const nonEmpty: string[] = [];
  const validity: boolean[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    nonEmpty.push(lines[index]!);
    try {
      JSON.parse(line);
      validLines.push(lines[index]!);
      validity.push(true);
    } catch {
      invalid.push(index + 1);
      validity.push(false);
    }
  }
  const firstInvalidPosition = validity.findIndex((value) => !value);
  const tailOnly = firstInvalidPosition >= 0 && validity.slice(firstInvalidPosition).every((value) => !value);
  return {
    invalidRecords: invalid.length,
    firstInvalidLine: invalid[0],
    tailOnly,
    validLines,
    nonEmptyLines: nonEmpty,
  };
}

function corruptRecordsRecovery(inspection: JsonlInspection): SessionHistoryRecoveryDto | undefined {
  if (!inspection.invalidRecords) return undefined;
  return {
    kind: "corrupt-records",
    invalidRecords: inspection.invalidRecords,
    firstInvalidLine: inspection.firstInvalidLine,
    tailOnly: inspection.tailOnly,
    message: inspection.tailOnly
      ? `会话文件尾部有 ${inspection.invalidRecords} 条损坏记录，已跳过；原文件未修改。`
      : `会话文件有 ${inspection.invalidRecords} 条损坏记录，已跳过可继续读取的历史；原文件未修改。`,
  };
}

export interface OpenSessionForHistoryResult {
  manager: ReturnType<typeof SessionManager.open>;
  recovery?: SessionHistoryRecoveryDto;
  cleanup: () => void;
}

/**
 * Read-only history opening. The source JSONL is never rewritten or truncated.
 * Pi open() may repair damaged JSONL on disk. Restore its canonical entries in
 * memory instead, including migrations, and never give the reader a writable path.
 */
export function openSessionForHistory(
  sessionFile: string,
  cwdOverride?: string,
): OpenSessionForHistoryResult {
  const inspection = inspectJsonl(sessionFile);
  const diagnostic = corruptRecordsRecovery(inspection);
  const openPrefix = (lines: string[]) => {
    const entries = lines.map((line) => JSON.parse(line)) as FileEntry[];
    const header = entries[0];
    if (header?.type !== "session" || typeof header.id !== "string") {
      throw new Error("Invalid pi session header");
    }
    // Pi's branch walker follows parentId without cycle detection. Validate the
    // external file before indexing: duplicate IDs can turn a valid path cyclic.
    const seen = new Set<string>();
    for (const entry of entries.slice(1)) {
      if (entry.type === "session") throw new Error("Duplicate pi session header");
      // Legacy versions receive IDs/parents during Pi's in-memory migration.
      if ((header.version ?? 1) < 2) continue;
      if (!entry.id || seen.has(entry.id)) throw new Error("Duplicate or missing pi entry id");
      if (entry.parentId !== null && !seen.has(entry.parentId)) {
        throw new Error("Invalid pi entry parent");
      }
      seen.add(entry.id);
    }
    const manager = SessionManager.inMemory(cwdOverride ?? header.cwd, { id: header.id }, entries);
    manager.buildContextEntries();
    return manager;
  };
  try {
    const manager = openPrefix(inspection.validLines);
    return {
      manager,
      recovery: diagnostic,
      cleanup: () => {},
    };
  } catch (originalError) {
    const candidates = inspection.validLines;
    let low = 1;
    let high = candidates.length;
    let best = 0;
    let bestManager: ReturnType<typeof SessionManager.open> | undefined;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      try {
        const manager = openPrefix(candidates.slice(0, count));
        best = count;
        bestManager = manager;
        low = count + 1;
      } catch {
        high = count - 1;
      }
    }
    if (!bestManager || best === 0) {
      throw originalError;
    }
    const omitted = Math.max(inspection.invalidRecords, inspection.nonEmptyLines.length - best);
    return {
      manager: bestManager,
      recovery: {
        kind: "read-only-fallback",
        invalidRecords: omitted,
        firstInvalidLine: inspection.firstInvalidLine,
        tailOnly: inspection.tailOnly,
        message: `会话文件无法直接打开，已从可读前缀恢复历史并跳过 ${omitted} 条异常记录；原文件未修改。`,
      },
      cleanup: () => {},
    };
  }
}
