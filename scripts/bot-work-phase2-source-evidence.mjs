import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const paths = execFileSync("git", ["ls-files", "-z", "--modified", "--others", "--exclude-standard", "--", "src", "scripts", "package.json"],
  { cwd: root, encoding: "utf8", windowsHide: true }).split("\0").filter(Boolean);
const files = [...new Set(paths)].sort().map(path => ({ path,
  sha256: existsSync(join(root, path)) ? createHash("sha256").update(readFileSync(join(root, path))).digest("hex") : null }));
const sha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
const report = { baseCommit: git(["rev-parse", "HEAD"]), branch: git(["branch", "--show-current"]), sourceSha256: sha256, files };
const target = join(root, "out/diagnostics/bot-work-phase2/source-manifest.json");
mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ baseCommit: report.baseCommit, sourceSha256: sha256, files: files.length, target }));
