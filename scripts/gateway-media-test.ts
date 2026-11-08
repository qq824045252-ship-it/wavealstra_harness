import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withGatewayMedia, GATEWAY_MEDIA_LIMITS, GatewayMediaError } from "../src/main/gateway/GatewayMedia";
const directory = await mkdtemp(join(tmpdir(), "gateway-media-test-"));
let calls = 0;
const source = { url: "https://cdn.discordapp.com/attachments/a/b/file.png?signature=secret", name: "../pic.png",
  allowedHosts: ["cdn.discordapp.com"], fetch: (async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return new Response("image bytes");
  }) as typeof fetch };
try {
  const attachment = await withGatewayMedia([source], async ([file]) => file, { directory });
  assert.equal(attachment.name, "_pic.png");
  assert.equal(await readFile(attachment.path, "utf8"), "image bytes");
  await withGatewayMedia([source], async ([file]) => assert.equal(file.path, attachment.path), { directory });
  assert.equal((await readdir(directory)).length, 1, "content cache deduplicates retries");
  for (const url of ["http://cdn.discordapp.com/a", "https://evil.test/a", "https://cdn.discordapp.com.evil.test/a", "https://user:password@cdn.discordapp.com/a", "https://cdn.discordapp.com:444/a"]) {
    const before = calls;
    await assert.rejects(withGatewayMedia([{ ...source, url }], async () => {}, { directory }), /来源/);
    assert.equal(calls, before);
  }
  await assert.rejects(withGatewayMedia([{ ...source, expectedSize: GATEWAY_MEDIA_LIMITS.file + 1 }], async () => {}, { directory }), /大小/);
  await assert.rejects(withGatewayMedia(Array(11).fill(source), async () => {}, { directory }), /数量/);
  const failing = { ...source, fetch: (async () => { throw new Error("token=SECRET"); }) as typeof fetch };
  await assert.rejects(withGatewayMedia([failing], async () => {}, { directory }), error => error instanceof Error && !error.message.includes("SECRET"));
  await assert.rejects(withGatewayMedia([{ ...source, fetch: (async () => new Response("x", { headers: { "content-length": String(GATEWAY_MEDIA_LIMITS.file + 1) } })) as typeof fetch }], async () => {}, { directory }), /限制/);
  const newFile = { ...source, fetch: (async () => new Response("new bytes")) as typeof fetch };
  await assert.rejects(withGatewayMedia([newFile, failing], async () => {}, { directory }));
  assert.equal((await readdir(directory)).length, 1, "partial batches cleaned");
  await assert.rejects(withGatewayMedia([source], async () => { throw new Error("turn failed"); }, { directory }), /turn failed/);
  assert.equal(await readFile(attachment.path, "utf8"), "image bytes", "turn retries retain references");
  await withGatewayMedia([{ ...source, name: "a".repeat(200) + ".png" }], async ([file]) => {
    assert.ok(file.name.endsWith(".png")); assert.ok(file.path.endsWith(".png")); assert.equal(file.name.length, 180);
  }, { directory });
  await assert.rejects(withGatewayMedia([source], async () => {}, { directory: attachment.path }),
    error => error instanceof GatewayMediaError && !error.retryable && !error.message.includes(attachment.path));
  const link = join(directory, "link");
  await symlink(directory, link);
  await assert.rejects(withGatewayMedia([source], async () => {}, { directory: link }), /目录/);
  console.log("gateway-media: passed bounded downloads, trusted hosts, redaction, dedupe, rollback, retention and symlink rejection");
} finally { await rm(directory, { recursive: true, force: true }); }
