import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startParitySite } from "./browser-parity-site.mjs";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
async function run(command, args, options = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, env, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}

const packageManager = env.npm_execpath;
if (!packageManager) throw Error("Run with pnpm -s test:browser-ego-parity");
const space = env.MYBUDDY_EGO_TEST_SPACE;
if (space && !/^\d+$/.test(space)) throw Error("Expected a numeric fixture task space");
const dir = join(resolve("out/diagnostics/browser-ego-parity"), new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(dir, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "mybuddy-ego-compare-"));
const site = await startParitySite();
async function egoRound(name, script) {
  const path = join(scratch, name + ".mjs"); await writeFile(path, script, "utf8");
  return run("ego-browser", ["nodejs", "-e", "await import(" + JSON.stringify(pathToFileURL(path).href) + ")"]);
}
try {
  const sdk = new URL("./browser-ego-parity.mjs", import.meta.url).href;
  const taskIdFile = join(scratch, "task-space");
  const script = [
    `import { runEgoParity } from ${JSON.stringify(sdk)};`,
    "import { writeFile } from 'node:fs/promises';",
    `const task = await taskSpace(${space ? Number(space) : JSON.stringify("MyBuddy browser parity")});`,
    `await writeFile(${JSON.stringify(taskIdFile)}, String(task.spaceId));`,
    `const results = await runEgoParity(task, ${JSON.stringify(site.url)}, ${JSON.stringify(scratch)});`,
    "console.log(results);",
  ].join("\n");
  if (await egoRound("compare", script)) throw Error("ego-browser did not complete its comparison");
  const ego = JSON.parse(await readFile(join(scratch, "ego.json"), "utf8"));
  const id = (await readFile(taskIdFile, "utf8")).trim();
  if (!/^\d+$/.test(id)) throw Error("Invalid fixture task space ID");
  if (ego.every(row => row.pass) && await egoRound("finish", `await (await taskSpace(${Number(id)})).finish({keep:[]});`)) throw Error("Could not close fixture space " + id);
  await writeFile(join(dir, "ego.json"), JSON.stringify(ego, null, 2));
  const reportPath = join(dir, "mybuddy.json");
  const args = ["-s", "test:browser-parity-electron"];
  const useNode = /\.[cm]?js$/i.test(packageManager);
  const exit = await run(useNode ? process.execPath : packageManager, useNode ? [packageManager, ...args] : args, {
    env: { ...env, MYBUDDY_BROWSER_PARITY_URL: site.url, MYBUDDY_BROWSER_PARITY_REPORT: reportPath, MYBUDDY_BROWSER_PARITY_FULL: "1" },
  });
  const app = JSON.parse(await readFile(reportPath, "utf8"));
  const names = [...new Set([...ego, ...app].map(row => row.name))];
  const cases = names.map(name => ({ name, ego: ego.find(row => row.name === name)?.pass ?? null, mybuddy: app.find(row => row.name === name)?.pass ?? null }));
  const passed = !exit && cases.length > 0 && cases.every(row => row.ego === true && row.mybuddy === true);
  const report = { date: new Date().toISOString(), site: site.url, passed, cases };
  await writeFile(join(dir, "comparison.json"), JSON.stringify(report, null, 2));
  console.log("Comparison report", join(dir, "comparison.json"));
  if (!passed) process.exitCode = 1;
} finally { site.close(); }
