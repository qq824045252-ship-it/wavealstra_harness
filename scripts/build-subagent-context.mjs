/** Bundle shared policy and provider factories without a second Pi SDK. */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildSubagentContext(root = dirname(dirname(fileURLToPath(import.meta.url)))) {
  for (const [entry, filename] of [
    ["src/main/agent/EphemeralContextProjection.ts", "context-projection.mjs"],
    ["src/main/agent/providers/command-code.ts", "command-code.mjs"],
    ["src/main/agent/CacheRequestTracer.ts", "cache-request-trace.mjs"],
    ["src/shared/subagent-execution-policy.ts", "execution-policy.mjs"],
  ]) {
    const outfile = join(root, "src/main/capabilities/subagent/vendor", filename);
    const result = await build({
      entryPoints: [join(root, entry)],
      outfile, bundle: true, platform: "node", format: "esm", target: "node20",
      packages: filename === "execution-policy.mjs" ? "bundle" : "external", write: false, metafile: true, legalComments: "none", logLevel: "silent",
    });
    // All Pi runtime objects belong to the CLI's
    // existing native modules; a new runtime import would split their identities.
    for (const output of Object.values(result.metafile.outputs)) {
      if (output.imports.some((entry) => entry.external && !entry.path.startsWith("node:"))) {
        throw new Error("子代理上下文产物不得引入独立运行时依赖");
      }
    }
    mkdirSync(dirname(outfile), { recursive: true });
    writeFileSync(outfile, result.outputFiles[0].text.replace(/[ \t]+$/gm, "").replace(/\r\n/g, "\n"));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await buildSubagentContext();
