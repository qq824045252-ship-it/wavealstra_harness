import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function resolveRepoRoot(explicitRoot?: string): string {
  if (explicitRoot) return resolve(explicitRoot);
  if (typeof __dirname === "string") {
    let cursor = resolve(__dirname);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(cursor, "src/main/host/pi-node-host-entry.ts"))) return cursor;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return resolve(process.cwd());
}

interface PiNodeHostBundleMeta {
  piVersion: string;
  inputs: string[];
}

function isDevBundleFresh(outFile: string, metaFile: string, piVersion: string): boolean {
  if (!existsSync(outFile) || !existsSync(metaFile)) return false;
  try {
    const outMtime = statSync(outFile).mtimeMs;
    const parsed = JSON.parse(readFileSync(metaFile, "utf8")) as Partial<PiNodeHostBundleMeta>;
    if (parsed.piVersion !== piVersion || !Array.isArray(parsed.inputs) || parsed.inputs.length === 0) {
      return false;
    }
    return parsed.inputs.every(file => typeof file === "string" && existsSync(file) && statSync(file).mtimeMs <= outMtime);
  } catch {
    return false;
  }
}

/**
 * Resolve the isolated `pi-node-host.cjs` entry script.
 * In packaged builds (or when TypeScript sources are absent), returns the pre-built asset.
 * In unbuilt dev/test checkouts, bundles on-demand with `esbuild` and validates every
 * transitive input file via `metafile` so stale `out/main/pi-node-host.cjs` never shadows
 * edited `src/` files.
 */
export async function ensurePiNodeHostScript(explicitRoot?: string): Promise<string> {
  const root = resolveRepoRoot(explicitRoot);
  const entrySource = join(root, "src/main/host/pi-node-host-entry.ts");
  const isPackaged = process.env.MYBUDDY_IS_PACKAGED === "1";

  if (isPackaged || !existsSync(entrySource)) {
    const prebuiltCandidates = typeof __dirname === "string"
      ? [
        join(__dirname, "pi-node-host.cjs"),
        join(dirname(__dirname), "main/pi-node-host.cjs"),
      ]
      : [];
    for (const candidate of prebuiltCandidates) {
      if (existsSync(candidate)) return candidate;
    }
    const builtOutMain = join(root, "out/main/pi-node-host.cjs");
    if (existsSync(builtOutMain)) return builtOutMain;
  }

  const outFile = join(root, "out/pi-node-host/pi-node-host.cjs");
  const metaFile = join(root, "out/pi-node-host/pi-node-host.meta.json");
  const piPkgPath = join(root, "node_modules/@earendil-works/pi-coding-agent/package.json");
  const piPkg = JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string };

  if (isDevBundleFresh(outFile, metaFile, piPkg.version)) {
    return outFile;
  }

  mkdirSync(dirname(outFile), { recursive: true });
  const esbuildPkg = "esbuild";
  const { build } = (await import(/* @vite-ignore */ esbuildPkg)) as typeof import("esbuild");
  const result = await build({
    entryPoints: [entrySource],
    outfile: outFile,
    bundle: true,
    metafile: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "warning",
    define: {
      "import.meta.url": "__piImportMetaUrl",
      "__MYBUDDY_BUNDLED_PI_VERSION__": JSON.stringify(piPkg.version),
    },
    banner: {
      js: 'var __piImportMetaUrl = typeof __filename === "string" ? require("node:url").pathToFileURL(__filename).href : "";',
    },
    external: [
      "better-sqlite3",
      "jiti",
      "node-pty",
      "onnxruntime-node",
      "@napi-rs/keyring",
      "bufferutil",
      "utf-8-validate",
    ],
    alias: {
      electron: join(root, "src/main/shims/node-electron-host.ts"),
      "node:sqlite": join(root, "src/main/shims/node-sqlite.ts"),
      sqlite: join(root, "src/main/shims/node-sqlite.ts"),
      "@shared": join(root, "src/shared"),
    },
  });
  const inputs = Array.from(new Set([
    ...Object.keys(result.metafile?.inputs ?? {}).map(p => resolve(root, p)),
    piPkgPath,
  ]));
  writeFileSync(metaFile, JSON.stringify({ piVersion: piPkg.version, inputs } satisfies PiNodeHostBundleMeta), "utf8");
  return outFile;
}
