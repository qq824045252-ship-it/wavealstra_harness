import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import releases from "../../../vendor/craft-office/releases.json";
import gridcraft from "../../../vendor/craft-office/gridcraft-custom.json";
import type { LocalCapabilityCheckResult } from "../capabilities/BuiltinCapabilityRuntime";
import type { OfficeKind } from "./OfficeFile";

export const officeEngineByKind = { word: "wordcraft", excel: "gridcraft", ppt: "deckcraft" } as const;
const formatKinds = Object.keys(officeEngineByKind) as OfficeKind[];
const bridgeFiles = ["bridge.html", "bridge.js", "document.js", "readonly.js"];
export const officeStaticFiles: Record<string, readonly string[]> = {
  host: ["index.html", "host.js", "host.css"],
  craft: [...bridgeFiles, ...formatKinds.map((kind) => `${kind}.js`)],
  fonts: ["NotoSansCJKsc-Regular.otf"],
};

const engines = { ...releases, gridcraft };
const formats: Record<OfficeKind, string> = { word: "Word (DOCX)", excel: "Excel (XLSX)", ppt: "PowerPoint (PPTX)" };

export function isOfficeEngineAsset(group: string, name: string): boolean {
  if (!Object.hasOwn(engines, group)) return false;
  return name === "index.html" || /^snippets\/[a-z0-9_-]+\/[a-zA-Z0-9_-]+\.js$/.test(name)
    || /^[a-zA-Z0-9_-]+\.(wasm|js|ico)$/.test(name);
}

async function unreadableFiles(root: string, group: string, names: readonly string[]): Promise<string[]> {
  const results = await Promise.all(names.map(async (name) => {
    try { return (await readFile(join(root, group, name))).length ? undefined : name; }
    catch { return name; }
  }));
  return results.filter((name) => name !== undefined);
}

async function invalidEngineAssets(root: string, engine: keyof typeof engines): Promise<string[]> {
  const runtimeFiles = Object.entries(engines[engine].files).filter(([name]) => isOfficeEngineAsset(engine, name));
  const results = await Promise.all(runtimeFiles.map(async ([name, expected]) => {
    try {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(join(root, engine, name))) hash.update(chunk);
      return hash.digest("hex") === expected ? undefined : name;
    } catch { return name; }
  }));
  return results.filter((name) => name !== undefined);
}

export async function checkOfficeUseAssets(runtime: string, editor: string): Promise<LocalCapabilityCheckResult> {
  const [host, bridge] = await Promise.all([
    unreadableFiles(editor, "host", officeStaticFiles.host),
    unreadableFiles(editor, "craft", bridgeFiles),
  ]);
  if (host.length || bridge.length) {
    return { state: "missing-dependency", detail: `Office 编辑器组件缺失或无法读取：${[...host, ...bridge].join("、")}。` };
  }

  const fontCheck = unreadableFiles(runtime, "fonts", officeStaticFiles.fonts);
  const results = await Promise.all(formatKinds.map(async (kind) => {
    const [engine, adapter, fonts] = await Promise.all([
      invalidEngineAssets(runtime, officeEngineByKind[kind]),
      unreadableFiles(editor, "craft", [`${kind}.js`]),
      kind === "excel" ? [] : fontCheck,
    ]);
    return { format: formats[kind], failures: [...engine, ...adapter, ...fonts] };
  }));
  const ready = results.filter(({ failures }) => !failures.length);
  const failed = results.filter(({ failures }) => failures.length);
  const passedDetail = ready.length ? `本地资源校验通过：${ready.map(({ format }) => format).join("、")}。` : "";
  const failedDetail = failed.map(({ format, failures }) => `${format} 的资源缺失或损坏：${failures.join("、")}。`).join(" ");
  return {
    state: !ready.length ? "missing-dependency" : failed.length ? "degraded" : "ready",
    detail: [passedDetail, failedDetail].filter(Boolean).join(" "),
  };
}
