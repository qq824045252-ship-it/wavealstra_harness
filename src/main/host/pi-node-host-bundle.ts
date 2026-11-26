import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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

/**
 * Resolve the isolated `pi-node-host.cjs` entry script.
 * In packaged builds or built `out/main`, returns the pre-built asset.
 * In unbuilt dev/test checkouts, bundles on-demand with `esbuild` so `pnpm dev` / `test:*`
 * never requires `pnpm build`.
 */
export async function ensurePiNodeHostScript(explicitRoot?: string): Promise<string> {
  const prebuiltCandidates = typeof __dirname === "string"
    ? [
      join(__dirname, "pi-node-host.cjs"),
      join(dirname(__dirname), "main/pi-node-host.cjs"),
    ]
    : [];
  for (const candidate of prebuiltCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const root = resolveRepoRoot(explicitRoot);
  const builtOutMain = join(root, "out/main/pi-node-host.cjs");
  if (existsSync(builtOutMain)) return builtOutMain;

  const entrySource = join(root, "src/main/host/pi-node-host-entry.ts");
  const outFile = join(root, "out/pi-node-host/pi-node-host.cjs");
  const sourceFiles = [
    entrySource,
    join(root, "src/main/host/PiNodeHost.ts"),
    join(root, "src/main/host/ExecutionHostBridge.ts"),
    join(root, "src/main/host/pi-node-host-bundle.ts"),
    join(root, "src/main/host/pi-version.ts"),
    join(root, "src/main/shims/node-electron-host.ts"),
    join(root, "src/main/agent/durable/DurableBotService.ts"),
    join(root, "src/main/agent/durable/DurableTaskProjection.ts"),
    join(root, "src/main/agent/AgentService.ts"),
  ];
  const latestSourceMtime = Math.max(
    0,
    ...sourceFiles.map(file => (existsSync(file) ? statSync(file).mtimeMs : 0)),
  );
  const outMtime = existsSync(outFile) ? statSync(outFile).mtimeMs : 0;
  if (existsSync(outFile) && outMtime >= latestSourceMtime) {
    return outFile;
  }

  mkdirSync(dirname(outFile), { recursive: true });
  const piPkg = JSON.parse(
    readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"),
  ) as { version: string };
  const esbuildPkg = "esbuild";
  const { build } = (await import(/* @vite-ignore */ esbuildPkg)) as typeof import("esbuild");
  await build({
    entryPoints: [entrySource],
    outfile: outFile,
    bundle: true,
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
  return outFile;
}
