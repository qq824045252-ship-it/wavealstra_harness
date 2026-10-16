/**
 * 永久资产断言：pi image-resize worker 与 photon wasm 被 emit 进 out/main，
 * 且运行时可真实工作（worker 加载後能完成 resize），wasm 字节级等于包源。
 *
 * 断言点：
 * 1. out/main/image-resize-worker.js / out/main/photon_rs_bg.wasm 存在且非空；
 * 2. worker 是 CJS（可被 new Worker 直接加载，主包无 "type": "module"）；
 * 3. wasm 文件头为 \0asm，且 SHA-256 与 photon-node 包内源文件完全一致；
 * 4. package.json 的 asarUnpack 覆盖这两个产物路径；
 * 5. 出 main 打包 index.js 的运行时查找仍引用这两个文件名（不漂移）；
 * 6. 功能级：用 Worker 跑 out/main/image-resize-worker.js，100x200 PNG 缩到
 *    maxWidth=40 后返回 wasResized=true 且 width<=40（证明 wasm 在 out/main 可读）。
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { Worker } from "node:worker_threads";

const root = resolve(__dirname, "..", ".."); // 入参 --outfile 固定 out/tests/*.cjs，向上两级 = 工作区根
const outMain = join(root, "out", "main");

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error("image-resize 资产断言失败: " + message);
  }
}

function makePng(width: number, height: number): Buffer {
  // 最小合法 PNG（RGB, 8bit)，内容为可变灰度，压缩后仍远小于 maxBytes。
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const at = rowStart + 1 + x * 3;
      raw[at] = x & 0xff;
      raw[at + 1] = y & 0xff;
      raw[at + 2] = 0x80;
    }
  }
  const idat = deflateSync(raw);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 标准 PNG CRC32
let crcTable: number[] | null = null;
function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable.push(c);
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

async function main(): Promise<void> {
  const workerPath = join(outMain, "image-resize-worker.js");
  const wasmPath = join(outMain, "photon_rs_bg.wasm");
  const workerSource = readFileSync(workerPath);
  const wasmOut = readFileSync(wasmPath);
  console.log(
    "[out/main]",
    "image-resize-worker.js =", workerSource.length, "B;",
    "photon_rs_bg.wasm =", wasmOut.length, "B",
  );
  assert(workerSource.length > 0, "worker 非空");
  assert(wasmOut.length > 0, "wasm 非空");

  // 2. worker 是 CJS：无顶层 ESM import/export（否则无 "type" 的包内会被当作 cjs 解析失败）
  const workerText = workerSource.toString("utf8");
  assert(!/(^|\n)import\s[^\n(]*\bfrom\b/.test(workerText), "worker 输出应为 CJS 而非顶层 ESM import");
  assert(workerText.includes("parentPort"), "worker 保留 parentPort 消息逻辑");

  // 3. wasm 头与字节级一致性（SHA-256 与源一致；源从 pi 依赖图解析）
  assert(wasmOut.subarray(0, 4).toString("hex") === "0061736d", "wasm 文件头 \\0asm");
  const rootRequire = createRequire(join(root, "package.json"));
  const piRoot = realpathSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent"));
  const piRequire = createRequire(join(piRoot, "package.json"));
  const wasmSourcePath = join(
    dirname(piRequire.resolve("@silvia-odwyer/photon-node/package.json")),
    "photon_rs_bg.wasm",
  );
  const wasmSource = readFileSync(wasmSourcePath);
  const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");
  const outputHash = sha256(wasmOut);
  assert(wasmOut.length === wasmSource.length, `wasm 字节数一致 (${wasmOut.length} vs ${wasmSource.length})`);
  assert(outputHash === sha256(wasmSource), "wasm SHA-256 与包源一致");
  console.log("[wasm]", wasmSource.length, "B  sha256 =", outputHash.slice(0, 16) + "...");

  // 3b. subagent runtime chunks 同款 wasm 缺口（photon_rs-*.mjs 以 __dirname=chunks/ 查找）
  const subagentRuntimeWasmPath = join(outMain, "capabilities", "subagent", "runtime", "chunks", "photon_rs_bg.wasm");
  const subagentRuntimeWasm = readFileSync(subagentRuntimeWasmPath);
  assert(subagentRuntimeWasm.length === wasmSource.length, `subagent runtime chunks wasm 字节数一致 (${subagentRuntimeWasm.length})`);
  assert(sha256(subagentRuntimeWasm) === outputHash, "subagent runtime chunks wasm SHA-256 与包源一致");
  const runtimeChunks = readdirSync(join(outMain, "capabilities", "subagent", "runtime", "chunks")).filter((name) => name.startsWith("photon_rs-") && name.endsWith(".mjs"));
  assert(runtimeChunks.length > 0, "subagent runtime photon chunk 存在");
  const runtimeChunkText = readFileSync(join(outMain, "capabilities", "subagent", "runtime", "chunks", runtimeChunks[0]!), "utf8");
  assert(runtimeChunkText.includes('"photon_rs_bg.wasm"'), "subagent runtime photon chunk 引用 photon_rs_bg.wasm 文件名");
  console.log("[subagent-runtime]", runtimeChunks.join(","), "+ photon_rs_bg.wasm =", subagentRuntimeWasm.length, "B");

  // 4. asarUnpack 覆盖两个产物
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { build?: { asarUnpack?: string[] } };
  const unpack = pkg.build?.asarUnpack ?? [];
  assert(unpack.includes("out/main/image-resize-worker.js"), "asarUnpack 含 out/main/image-resize-worker.js");
  assert(unpack.includes("out/main/photon_rs_bg.wasm"), "asarUnpack 含 out/main/photon_rs_bg.wasm");
  console.log("[asarUnpack]", unpack.filter((p) => p.startsWith("out/main/image-resize") || p.includes("photon")).join(", "));

  // 5. 主包运行时查找文件名未漂移
  const mainIndex = readFileSync(join(outMain, "index.js"), "utf8");
  assert(mainIndex.includes('"./image-resize-worker.js"'), "主包以 ./image-resize-worker.js 相对 __filename 查找 worker");
  assert(mainIndex.includes('"photon_rs_bg.wasm"'), "主包引用 photon_rs_bg.wasm 文件名");
  const loaderChunks = readdirSync(outMain).filter((name) => name.startsWith("photon_rs-"));
  assert(loaderChunks.length === 1, "主包 photon loader chunk 恰好一个: " + loaderChunks.join(","));

  // 6. 功能级：worker 真实加载 wasm 完成一次 resize
  const png = makePng(100, 200);
  const result = await new Promise<{ result?: { width?: number; height?: number; wasResized?: boolean; data?: string; mimeType?: string }; error?: string }>((resolvePromise, rejectPromise) => {
    const worker = new Worker(workerPath);
    worker.once("message", (message: { result?: unknown; error?: string }) => {
      worker.terminate().catch(() => undefined);
      if (message.error) {
        rejectPromise(new Error("worker 返回错误: " + message.error));
      } else {
        resolvePromise(message as { result?: { width?: number; height?: number; wasResized?: boolean; data?: string; mimeType?: string } });
      }
    });
    worker.once("error", rejectPromise);
    const transferable = new Uint8Array(png);
    worker.postMessage({ inputBytes: transferable, mimeType: "image/png", options: { maxWidth: 40, maxHeight: 40 } }, [transferable.buffer]);
  });
  const resized = result.result;
  assert(resized, "worker 返回 resize 结果");
  assert(resized.wasResized === true, "wasResized=true");
  assert((resized.width ?? Infinity) <= 40, `width<=40 (实际 ${resized.width})`);
  assert((resized.height ?? Infinity) <= 40, `height<=40 (实际 ${resized.height})`);
  assert(!!resized.data && resized.mimeType === "image/png", "返回 PNG base64 数据");
  console.log("[worker]", `100x200 -> ${resized.width}x${resized.height}, wasResized=${resized.wasResized}, mimeType=${resized.mimeType}`);
  console.log("PASS image-resize-assets");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
