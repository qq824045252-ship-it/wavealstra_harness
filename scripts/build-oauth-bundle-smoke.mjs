import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const stubDir = join(process.cwd(), "out", "tests", "oauth-stubs");
mkdirSync(stubDir, { recursive: true });
const jitiStub = join(stubDir, "jiti-static.cjs");
writeFileSync(jitiStub, "module.exports = {};\n");

await build({
  entryPoints: ["scripts/oauth-bundle-smoke.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "out/tests/oauth-bundle-smoke.cjs",
  external: ["electron", "better-sqlite3", "jiti", "node-pty", "@aws-sdk/*", "@smithy/*"],
  alias: {
    "jiti/static": jitiStub,
  },
  banner: {
    js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "import_meta_url",
  },
});

