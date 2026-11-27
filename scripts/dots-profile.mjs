import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { acquireCoreDatabaseGuard } from "../src/main/platform/core-client.ts";
const executable = fileURLToPath(new URL(process.platform === "win32"
  ? "../out/native/win-x64/mybuddy-runtime-audit.exe" : "../out/native/linux-x64/mybuddy-runtime-audit", import.meta.url));
const verifyDatabase = (...paths) => promisify(execFile)(executable, ["--verify-cold-profile", ...paths]);
import { claimDurableStorageLease, isDurableLeaseFile } from "../src/main/agent/durable/DurableStorageLease.ts";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../src/shared/database-version.ts";

const format = "mybuddy-cold-profile-v2";
const usage = "pnpm dots:profile backup <资料目录> <新备份目录> | verify <备份目录> | restore <备份目录> <新资料目录> [--known-profile <较新资料目录>]";

function inside(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

async function newDirectory(source, requested, build) {
  const parent = await realpath(dirname(resolve(requested)));
  const destination = join(parent, basename(resolve(requested)));
  if (inside(source, destination) || inside(destination, source)) throw new Error("源目录和目标目录必须分开");
  async function requireAbsent() {
    try { await lstat(destination); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    throw new Error("目标已存在。请选择新目录");
  }
  await requireAbsent();
  const temporary = await mkdtemp(join(parent, ".mybuddy-snapshot-"));
  let published = false;
  try {
    const result = await build(temporary);
    await requireAbsent();
    await rename(temporary, destination);
    published = true;
    return result;
  } finally { if (!published) await rm(temporary, { recursive: true, force: true }); }
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// A snapshot stores internal links as metadata. No copy or verification ever follows a directory link.
async function inventory(root, capturing = false) {
  const entries = [];
  async function walk(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), key = prefix + name;
      if (capturing && (!prefix || /^durable\/[a-f0-9]{64}\/$/.test(prefix)) && isDurableLeaseFile(name)) continue;
      if (capturing && !prefix && /^app\.db(?:-wal|-shm|-journal)?$/.test(name)) continue;
      if (capturing && !prefix && ["core.lock","core-worker.lock","core.json","core.lease","core-status.json"].includes(name)) continue;
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        entries.push({ key, type: "dir" });
        await walk(path, key + "/");
      } else if (stat.isFile()) {
        entries.push({ key, type: "file", size: stat.size, sha256: await digest(path) });
      } else if (stat.isSymbolicLink() && capturing) {
        const target = await realpath(path);
        if (!inside(root, target)) throw new Error("需要单独备份的外部链接：" + path);
        const targetStat = await lstat(target);
        if (!targetStat.isDirectory() && !targetStat.isFile()) throw new Error("不支持的链接目标：" + path);
        entries.push({ key, type: "link", target: relative(root, target).split(sep).join("/"), directory: targetStat.isDirectory() });
      } else throw new Error("快照包含不支持的文件类型：" + path);
    }
  }
  await walk(root, "");
  return entries;
}

async function copyEntries(from, to, entries) {
  for (const entry of entries) {
    const path = join(to, entry.key);
    if (entry.type === "dir") await mkdir(path);
    if (entry.type === "file") await copyFile(join(from, entry.key), path);
  }
}

function identical(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function checkLinks(links, entries) {
  if (!Array.isArray(links)) throw new Error("链接清单无效");
  const kinds = new Map(entries.map(e => [e.key, e.type]));
  kinds.set("", "dir");
  const names = new Set(kinds.keys());
  for (const link of links) {
    if (!link || typeof link.key !== "string" || typeof link.target !== "string" ||
        link.type !== "link" || typeof link.directory !== "boolean") throw new Error("链接清单无效");
    for (const name of [link.key, link.target]) {
      if (name === "" && name === link.target) continue;
      if (name.includes("\\") || name.includes(":") || name.includes("\0") || name.split("/").some(part => !part || part === "." || part === ".."))
        throw new Error("链接路径无效");
    }
    if (["app.duckdb","app.duckdb.wal"].includes(link.key)) throw new Error("数据库入口不能是链接");
    const parent = link.key.split("/").slice(0, -1).join("/");
    if (names.has(link.key) || kinds.get(parent) !== "dir" || kinds.get(link.target) !== (link.directory ? "dir" : "file"))
      throw new Error("链接与快照内容不匹配");
    names.add(link.key);
  }
}

export async function verifyProfile(backup) {
  const root = await realpath(backup);
  if (!identical((await readdir(root)).sort(), ["data", "manifest.json"])) throw new Error("备份目录内容不完整");
  if (!(await lstat(join(root, "data"))).isDirectory() || !(await lstat(join(root, "manifest.json"))).isFile()) throw new Error("备份入口无效");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.format !== format || manifest.schema !== CURRENT_DATABASE_SCHEMA_VERSION) throw new Error("备份格式与当前版本不匹配");
  const entries = await inventory(join(root, "data"));
  if (!identical(entries, manifest.entries)) throw new Error("备份文件与校验清单不符");
  checkLinks(manifest.links, entries);
  if (!entries.some(e => e.key === "app.duckdb" && e.type === "file")) throw new Error("缺少 app.duckdb");
  await verifyDatabase(join(root, "data", "app.duckdb"));
  return manifest;
}

export async function backupProfile(profile, destination) {
  const root = await realpath(profile);
  if (!(await lstat(join(root, "app.duckdb"))).isFile()) throw new Error("资料目录缺少 app.duckdb");
  const lease = claimDurableStorageLease(root);
  let guard;
  try {
    guard = await acquireCoreDatabaseGuard(executable,root);
    return await newDirectory(root, destination, async temporary => {
      const data = join(temporary, "data");
      await mkdir(data, { mode: 0o700 });
      const source = await inventory(root, true);
      await copyEntries(root, data, source);
      const entries = await inventory(data);
      if (!identical(entries, source.filter(e => e.type !== "link")) || !identical(await inventory(root,true), source))
        throw new Error("复制期间资料发生变化");
      const manifest = { format, schema: CURRENT_DATABASE_SCHEMA_VERSION, originalPath: root,
        capturedAt: new Date().toISOString(), entries, links: source.filter(e => e.type === "link") };
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
      return verifyProfile(temporary);
    });
  } finally { try { await guard?.release(); } finally { lease.release(); } }
}

export async function restoreProfile(backup, destination, knownProfile) {
  const root = await realpath(backup);
  const manifest = await verifyProfile(root);
  const known = knownProfile && await realpath(knownProfile);
  if (known && !(await lstat(join(known, "app.duckdb"))).isFile()) throw new Error("对照资料缺少 app.duckdb");
  const lease = known && claimDurableStorageLease(known);
  let guard;
  try {
    if (known) guard = await acquireCoreDatabaseGuard(executable,known);
    return await newDirectory(root, destination, async temporary => {
      if (known && inside(known, temporary)) throw new Error("恢复目标应位于对照资料目录之外");
      await copyEntries(join(root, "data"), temporary, manifest.entries);
      if (!identical(await inventory(temporary), manifest.entries)) throw new Error("还原文件校验失败");
      await verifyDatabase(join(temporary,"app.duckdb"), ...(known ? [join(known,"app.duckdb")] : []));
      for (const link of manifest.links) {
        const path = join(temporary, link.key), target = join(temporary, link.target);
        await symlink(relative(dirname(path), target) || ".", path, link.directory ? "dir" : "file");
      }
      return manifest;
    });
  } finally { try { await guard?.release(); } finally { lease?.release(); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, ...args] = process.argv.slice(2);
    const commands = { backup: backupProfile, verify: verifyProfile, restore: restoreProfile };
    if (action === "restore" && args.length === 4 && args[2] === "--known-profile") args.splice(2, 1);
    else if (!Object.hasOwn(commands, action) || args.length !== (action === "verify" ? 1 : 2)) throw new Error(usage);
    const manifest = await commands[action](...args);
    console.log(JSON.stringify({ action, capturedAt: manifest.capturedAt, originalPath: manifest.originalPath,
      entries: manifest.entries.length, internalLinks: manifest.links.length, schema: manifest.schema }, null, 2));
    if (action === "restore") console.log("本次还原反映快照时点；如有后续遗忘，请在离线资料中重新执行并核对后再上线。");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
