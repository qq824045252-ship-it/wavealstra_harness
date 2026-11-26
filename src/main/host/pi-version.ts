import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { VERSION as RUNTIME_PI_VERSION } from "@earendil-works/pi-coding-agent";

declare const __MYBUDDY_BUNDLED_PI_VERSION__: string | undefined;

function findRepoRoot(startDir = process.cwd()): string {
  let cursor = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const probe = join(cursor, "src/main/capabilities/subagent/worker-launcher.mjs");
    if (existsSync(probe)) return cursor;
    const packagedProbe = join(cursor, "capabilities/subagent/worker-launcher.mjs");
    if (existsSync(packagedProbe)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolve(startDir);
}

/** Read the pinned Pi runtime version directly from worker-launcher.mjs (single source of truth). */
export function readExpectedPiVersion(rootDir = findRepoRoot()): string {
  const candidates = [
    join(rootDir, "src/main/capabilities/subagent/worker-launcher.mjs"),
    join(rootDir, "capabilities/subagent/worker-launcher.mjs"),
    ...(typeof __dirname === "string" ? [join(__dirname, "../capabilities/subagent/worker-launcher.mjs")] : []),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    const match = /const EXPECTED_PI_VERSION = "([^"]+)";/.exec(source);
    if (match?.[1]) return match[1];
  }
  return RUNTIME_PI_VERSION;
}

export function installedPiVersion(): string {
  const override = process.env.MYBUDDY_PI_VERSION_OVERRIDE?.trim();
  if (override) return override;
  if (typeof __MYBUDDY_BUNDLED_PI_VERSION__ === "string" && __MYBUDDY_BUNDLED_PI_VERSION__) {
    return __MYBUDDY_BUNDLED_PI_VERSION__;
  }
  const pkgPath = join(findRepoRoot(), "node_modules/@earendil-works/pi-coding-agent/package.json");
  if (existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch { /* fall through */ }
  }
  return RUNTIME_PI_VERSION;
}

export function assertExpectedPiVersion(rootDir?: string): { expected: string; actual: string } {
  const expected = readExpectedPiVersion(rootDir);
  const actual = installedPiVersion();
  if (actual !== expected) {
    throw new Error(`Pi version mismatch: expected ${expected}, got ${actual}`);
  }
  return { expected, actual };
}
