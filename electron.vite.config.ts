import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { buildSubagentRuntime } from "./scripts/build-subagent-runtime.mjs";
import { buildPiCodemodeAssets } from "./scripts/build-pi-codemode-assets.mjs";
import { buildPiImageResizeAssets } from "./scripts/build-pi-image-resize-assets.mjs";
import { buildLinuxComputerUseAssets } from "./scripts/build-linux-computer-use.mjs";

const sqliteStub = resolve(__dirname, "src/main/shims/node-sqlite.ts");

/** Electron 无 node:sqlite；把 undici 等对它的 require 改成 stub */
function shimNodeSqlite(): Plugin {
  return {
    name: "shim-node-sqlite",
    enforce: "pre",
    resolveId(id) {
      if (id === "node:sqlite" || id === "sqlite") return sqliteStub;
      return null;
    },
    renderChunk(code) {
      if (!code.includes("node:sqlite")) return null;
      const stubCode = `
var __nodeSqliteStub = {
  DatabaseSync: class DatabaseSync { constructor() { throw new Error("node:sqlite is not available in Electron"); } },
  StatementSync: class StatementSync { constructor() { throw new Error("node:sqlite is not available in Electron"); } }
};
`.trim();
      const next = code
        .replace(
          /(?:const|var|let)\s+(\w+)\s*=\s*require\(["']node:sqlite["']\);?/g,
          "const $1 = __nodeSqliteStub;",
        )
        .replace(/require\(["']node:sqlite["']\)/g, "__nodeSqliteStub");
      if (next === code) return null;
      return { code: `${stubCode}\n${next}`, map: null };
    },
  };
}

export default defineConfig({
  main: {
    // 二次 vite 版本的类型系统差异（electron-vite 嵌套 vite vs 项目根 vite）
    // 使 Plugin 类型互不兼容，收窄为 never 消除误报，运行行为不变
    plugins: [shimNodeSqlite() as never, {
      name: "durable-runtime-assets",
      async generateBundle() {
        for (const asset of await buildSubagentRuntime(__dirname)) this.emitFile(asset);
        for (const asset of await buildPiCodemodeAssets(__dirname)) this.emitFile(asset);
        for (const asset of await buildPiImageResizeAssets(__dirname)) this.emitFile(asset);
        for (const asset of await buildLinuxComputerUseAssets(__dirname)) this.emitFile(asset);
        for (const fileName of ["capabilities/subagent/worker-launcher.mjs"]) {
          const outputName = fileName;
          this.emitFile({ type: "asset", fileName: outputName, source: readFileSync(resolve(__dirname, "src/main", fileName), "utf8") });
        }
      },
    }],
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    build: {
      // electron-vite 5 externalizes dependencies by default. Pi's ESM runtime
      // must remain bundled; only the native modules below are external.
      externalizeDeps: false,
      rollupOptions: {
        output: {
          // Rollup's const namespace helper uses for...in, but node:stream
          // inherits enumerable EventEmitter properties with no own descriptor.
          // The var helper uses Object.keys and preserves native live bindings.
          generatedCode: { constBindings: false },
        },
        // 原生模块不能打进 bundle；安装包只带这几个 node_modules。
        // pi-coding-agent / pi-ai 全量打进 out/main（含全部 OAuth + Bedrock，
        // 见 src/main/pi-bundled-runtime.ts）。磁盘扩展走 inline factory。
        external: ["better-sqlite3", "electron", "jiti", "node-pty", "onnxruntime-node", "@napi-rs/keyring", "bufferutil", "utf-8-validate"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          selectionPopover: resolve(__dirname, "src/preload/selectionPopover.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    build: {
      rollupOptions: {
        onwarn(warning, warn) {
          // markstream-react 2.0.13 still ships a few misplaced @__PURE__ comments.
          // Rollup discards only those invalid annotations; keep every other warning visible.
          if (warning.code === "INVALID_ANNOTATION" && warning.id?.includes("markstream-react")) return;
          warn(warning);
        },
      },
    },
    plugins: [react() as never],
  },
});
