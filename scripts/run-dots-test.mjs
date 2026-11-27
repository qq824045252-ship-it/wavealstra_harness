import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const name = process.argv[2];
if (!["actions", "completion", "delivery", "followup", "proactive-notices", "resident-tools", "memory-scale", "memory-longmemeval"].includes(name)) throw new Error("Unknown Dots test");
const test = `dots-${name}-test`;
const outfile = `out/tests/${test}.mjs`;
// Let Node write the output. Windows can allow the parent process to write the
// workspace while its esbuild child can only read it.
const result = await build({
  entryPoints: [`scripts/${test}.ts`], outfile, bundle: true, platform: "node",
  format: "esm", packages: "external", alias: { electron: "./scripts/arch-electron-stub.ts" }, write: false,
});
mkdirSync("out/tests", { recursive: true });
writeFileSync(outfile, result.outputFiles[0].contents);
const env = {...process.env};
if (name === "memory-longmemeval" && ["answer-full","semantic-full"].includes(env.DOTS_MEMORY_EVAL_MODE))
  env.GUARD_TIMEOUT_S ??= String(48 * 60 * 60);
const run = spawnSync(process.execPath, ["scripts/test-guard.mjs", outfile], { stdio: "inherit", env });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
