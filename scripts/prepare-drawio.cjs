'use strict';

const { createHash } = require("node:crypto");
const { createReadStream, createWriteStream } = require("node:fs");
const { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");
const release = require("../vendor/drawio/release.json");

const assets = resolve(__dirname, "../vendor/drawio/assets");
const destination = join(assets, "web");

function option(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag);
  return value;
}

async function verify(directory) {
  await Promise.all(release.files.map(file => access(join(directory, file))));
  if ((await readFile(join(directory, "mybuddy-release"), "utf8")).trim() !== release.sha256) {
    throw new Error("Unexpected Draw.io release in " + directory);
  }
}

function extract(archive, directory) {
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(error); return; }
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", entry => {
        const name = entry.fileName;
        if (name.endsWith("/") || /^(?:WEB-INF|META-INF)\//.test(name)) { zip.readEntry(); return; }
        const path = join(directory, name);
        if (name.split("/").some(part => !part || part === "." || part === ".." || /[:\\]/.test(part))) {
          zip.close();
          reject(new Error("Invalid Draw.io release entry " + name));
          return;
        }
        void mkdir(dirname(path), { recursive: true }).then(() => new Promise((resolve, reject) => {
          zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
        })).then(stream => pipeline(stream, createWriteStream(path, { flags: "wx" }))).then(
          () => zip.readEntry(), error => { zip.close(); reject(error); },
        );
      });
      zip.readEntry();
    });
  });
}

async function main() {
  const checkPath = option("--verify-assets");
  if (checkPath) { await verify(resolve(checkPath)); return; }
  if (await verify(destination).then(() => true, () => false)) return;
  await mkdir(assets, { recursive: true });
  const temporary = await mkdtemp(join(assets, ".prepare-"));
  try {
    const supplied = option("--archive");
    const archive = supplied ? resolve(supplied) : join(temporary, "draw.war");
    if (!supplied) {
      const response = await fetch(release.url, { signal: AbortSignal.timeout(600000) });
      if (!response.ok || !response.body) throw new Error("Draw.io download returned HTTP " + response.status);
      await pipeline(response.body, createWriteStream(archive, { flags: "wx" }));
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== release.sha256) throw new Error("Draw.io release SHA-256 mismatch");
    const web = join(temporary, "web");
    await extract(archive, web);
    await writeFile(join(web, "mybuddy-release"), release.sha256 + "\n");
    await verify(web);
    await rm(destination, { recursive: true, force: true });
    await rename(web, destination);
    console.log("Prepared Draw.io " + release.version);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
