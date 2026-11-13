import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { builtinBotAvatars, avatarManifestSchema } from "../src/shared/bot-avatar";
import { inspectAvatarRaster } from "../src/shared/bot-avatar-raster";
const root = join(process.cwd(),"src/renderer/src/assets/bot-avatars");
let bytesTotal=0;
const files = new Set<string>();
for (const entry of builtinBotAvatars) {
  assert(entry.approval.trim(),"Each asset needs provenance and a review reference");
  for (const kind of ["poster","animation"] as const) {
    const resource=entry[kind]; if (!resource) continue;
    const bytes=readFileSync(join(root,resource.file));
    assert.equal(bytes.length,resource.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"),resource.sha256);
    const info=inspectAvatarRaster(bytes);
    assert(info.width <= 256 && info.height <= 256,"Built-ins must fit 256 × 256");
    if (kind === "poster") {assert.equal(info.type,"png");assert.equal(info.frames,1);assert(bytes.length <= 128*1024);}
    else {
      assert.equal(info.type,"gif");assert(info.frames >= 2 && info.frames <= 48);assert(info.durationMs >= 200 && info.durationMs <= 10000);
      assert(bytes.includes(Buffer.from("NETSCAPE2.0\x03\x01\x00\x00\x00","latin1")),"Built-in GIF must loop forever");
      const poster=inspectAvatarRaster(readFileSync(join(root,entry.poster.file)));
      assert.equal(info.width,poster.width);assert.equal(info.height,poster.height);
    }
    if (!files.has(resource.file)) bytesTotal+=bytes.length;
    files.add(resource.file);
  }
}
assert(bytesTotal <= 32*1024*1024,"Catalog byte budget");
assert.deepEqual(new Set(readdirSync(root).filter(name => /\.(png|gif|webp)$/.test(name))),files,"No unreviewed bundled raster assets");
assert(!avatarManifestSchema.safeParse({version:1,entries:[...builtinBotAvatars,...builtinBotAvatars]}).success,"Reject duplicate stable IDs");
assert(!avatarManifestSchema.safeParse({version:1,entries:[{...builtinBotAvatars[0],poster:{...builtinBotAvatars[0].poster,file:"../outside.png"}}]}).success,"Reject traversal");
assert(!avatarManifestSchema.safeParse({version:1,entries:[{...builtinBotAvatars[0],poster:{...builtinBotAvatars[0].poster,file:"https://example.test/a.png"}}]}).success,"Reject external assets");
console.log(`[bot-avatar-assets] PASS: ${builtinBotAvatars.length} manifest entries, ${bytesTotal} bytes; hashes, closed paths, posters, loop/frame/pixel/byte budgets; provenance recorded; engineering fixtures remain separate from the admitted catalog`);
