/** Isolated package probe; task execution belongs to the native Durable host. */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const EXPECTED_PI_VERSION = "1.5.0";
const entry = realpathSync(resolve(process.argv[2] ?? ""));
const manifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
if (manifest.name !== "@wavealstra/pi-durable-probe" || manifest.version !== EXPECTED_PI_VERSION) throw new Error("Packaged Durable version mismatch");
const runtime = await import(pathToFileURL(entry).href);
if (runtime.VERSION !== EXPECTED_PI_VERSION) throw new Error("Native Pi version mismatch");
if (process.argv[3] === "--version") process.stdout.write(runtime.VERSION + "\n");
else if (process.argv[3] === "--verify-durable") process.stdout.write(JSON.stringify(await runtime.verifyPackagedDurable()) + "\n");
else throw new Error("Only package inspection is supported; task execution belongs to Durable");
