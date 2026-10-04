import { delimiter, resolve } from "node:path";

function canonicalPathEntry(value: string): string {
  const normalized = resolve(value.trim());
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Return a cloned env with unique path entries prepended, preserving the host PATH key casing. */
export function prependEnvPath(env: NodeJS.ProcessEnv, entries: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const pathKey = Object.keys(out).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = String(out[pathKey] ?? "");
  const currentEntries = current.split(delimiter).map((item) => item.trim()).filter(Boolean);
  const seen = new Set(currentEntries.map(canonicalPathEntry));
  const additions: string[] = [];
  for (const entry of entries) {
    const value = entry?.trim();
    if (!value) continue;
    const canonical = canonicalPathEntry(value);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    additions.push(value);
  }
  if (additions.length > 0) out[pathKey] = [...additions, ...currentEntries].join(delimiter);
  return out;
}
