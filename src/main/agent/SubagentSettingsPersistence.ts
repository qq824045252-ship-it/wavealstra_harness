import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RuntimeSubagentSettingsRequest =
  | { kind: "read"; root: string }
  | { kind: "replace"; root: string; version: string; text: string };

export type RuntimeSubagentSettingsReply =
  | { status: "observed"; version: string; text: string | null }
  | { status: "saved" | "changed" | "needsHost" }
  | { status: "failed"; message: string };

export interface SubagentSettingsWorker {
  readonly supervised?: boolean;
  subagentSettings(request: RuntimeSubagentSettingsRequest): Promise<RuntimeSubagentSettingsReply | undefined>;
}

type Observation = {
  path: string;
  text: string | null;
} & (
  | { kind: "host" }
  | { kind: "native"; worker: SubagentSettingsWorker; root: string; version: string }
);

const changed = "Subagent settings changed elsewhere. Reload the model settings before saving.";

function readSubagentSettingsOnHost(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function observeSubagentSettings(root: string, worker?: SubagentSettingsWorker): Promise<Observation> {
  const path = join(root, "subagent.json");
  const before = await worker?.subagentSettings({ kind: "read", root });
  if (worker && before?.status === "observed") {
    return { kind: "native", worker, root, path, text: before.text, version: before.version };
  }
  if (worker?.supervised) {
    throw new Error("未收到子代理设置读取确认，无法进入只读宿主机回退");
  }
  return { kind: "host", path, text: readSubagentSettingsOnHost(path) };
}

export async function replaceSubagentSettings(observed: Observation, text: string): Promise<void> {
  if (observed.kind === "native") {
    const { worker, root, version } = observed;
    const result = await worker.subagentSettings({ kind: "replace", root, version, text });
    if (result?.status === "saved") return;
    if (result?.status === "changed") throw new Error(changed);
    if (result?.status === "failed") throw new Error(`无法保存子代理设置：${result.message}`);
    throw new Error("未收到子代理设置保存确认，请刷新查看当前状态");
  }
  if (readSubagentSettingsOnHost(observed.path) !== observed.text) throw new Error(changed);
  const temporary = `${observed.path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
    renameSync(temporary, observed.path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
