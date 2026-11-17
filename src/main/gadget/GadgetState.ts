import type { GadgetJson, GadgetStoredValue, GadgetValues } from "../../shared/gadget-backend";

/** Serialized into the owned Node host. Keep runtime dependencies inside this function. */
export function createGadgetState(dataPath: string, defaults: Record<string, unknown>): {
  storage: GadgetValues;
  config: GadgetValues;
} {
  const fs: typeof import("node:fs") = require("node:fs");
  const path: typeof import("node:path") = require("node:path");
  const crypto: typeof import("node:crypto") = require("node:crypto");
  const statePath = path.join(dataPath, ".mybuddy-state.json");
  const maxBytes = 20 * 1024 * 1024;
  type Entries = Record<string, GadgetStoredValue>;
  type State = { storage: Entries; config: Entries };
  function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
  function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function json(value: unknown, depth = 0): GadgetJson {
    if (depth > 64) return fail("INVALID_JSON", "JSON 嵌套过深");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((item) => json(item, depth + 1));
    if (record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, json(child, depth + 1)]));
    }
    return fail("INVALID_JSON", "只能保存 JSON 数据");
  }
  function entries(value: unknown): Entries {
    if (!record(value)) return fail("STORAGE_CORRUPT", "Gadget 持久数据格式无效");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (!record(entry) || typeof entry.revision !== "string" || !("value" in entry)) {
        return fail("STORAGE_CORRUPT", "Gadget 持久数据条目无效");
      }
      return [key, { value: json(entry.value), revision: entry.revision }];
    }));
  }
  const realData = fs.realpathSync(dataPath);
  if (fs.lstatSync(dataPath).isSymbolicLink()) fail("STORAGE_UNSAFE", "Gadget data 不得是符号链接");
  function assertPath(): void {
    if (fs.lstatSync(dataPath).isSymbolicLink() || fs.realpathSync(dataPath) !== realData) {
      fail("STORAGE_UNSAFE", "Gadget data 路径已改变");
    }
    if (fs.existsSync(statePath) && (!fs.lstatSync(statePath).isFile() || fs.lstatSync(statePath).isSymbolicLink())) {
      fail("STORAGE_UNSAFE", "Gadget 数据文件必须是普通文件");
    }
  }
  function load(): State {
    assertPath();
    if (!fs.existsSync(statePath)) return { storage: {}, config: {} };
    if (fs.statSync(statePath).size > maxBytes) return fail("STORAGE_LIMIT", "Gadget 持久数据超过 20 MiB");
    const raw: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!record(raw)) return fail("STORAGE_CORRUPT", "Gadget 持久数据格式无效");
    return { storage: entries(raw.storage), config: entries(raw.config) };
  }
  let state = load();
  const checkedDefaults = json(defaults);
  const defaultValues: Record<string, unknown> = record(checkedDefaults) ? checkedDefaults : fail("INVALID_CONFIG", "Gadget 默认配置无效");
  function save(next: State): void {
    assertPath();
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > maxBytes || Object.keys(next.storage).length + Object.keys(next.config).length > 2048) {
      fail("STORAGE_LIMIT", "Gadget 持久数据超过容量限制");
    }
    const temp = `${statePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, serialized, { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, statePath);
      state = next;
    } finally { fs.rmSync(temp, { force: true }); }
  }
  function keyName(key: string): void {
    if (typeof key !== "string" || !key || key.length > 240 || /[\x00-\x1f]/.test(key)) fail("INVALID_KEY", "Gadget 数据 key 无效");
  }
  function bucket(kind: "storage" | "config"): GadgetValues {
    function read(key: string): GadgetStoredValue {
      keyName(key);
      const saved = Object.hasOwn(state[kind], key) ? state[kind][key] : undefined;
      if (saved) return { value: json(saved.value), revision: saved.revision };
      const fallback = kind === "config" && Object.hasOwn(defaultValues, key) ? defaultValues[key] : null;
      return { value: json(fallback), revision: null };
    }
    function check(key: string, expectedRevision: string | null | undefined): void {
      if (expectedRevision !== undefined && read(key).revision !== expectedRevision) {
        fail("REVISION_CONFLICT", "数据已被修改，请重新读取后再保存");
      }
    }
    return {
      async get(key) { return read(key).value; },
      async read(key) { return read(key); },
      async set(key, value, expectedRevision) {
        keyName(key); check(key, expectedRevision);
        const saved = { value: json(value), revision: crypto.randomUUID() };
        save({ ...state, [kind]: { ...state[kind], [key]: saved } });
        return { value: json(saved.value), revision: saved.revision };
      },
      async delete(key, expectedRevision) {
        keyName(key); check(key, expectedRevision);
        const next = { ...state[kind] };
        delete next[key];
        save({ ...state, [kind]: next });
      },
      async keys() {
        return [...new Set([...Object.keys(state[kind]), ...(kind === "config" ? Object.keys(defaultValues) : [])])].sort();
      },
    };
  }
  return { storage: bucket("storage"), config: bucket("config") };
}
