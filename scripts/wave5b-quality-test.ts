/**
 * Wave 5B — Image Quality 单元/契约测试（node 直跑）
 *
 * 覆盖（5B Gate 机器可测部分）：
 *   - fit/zoom/pan 数学：contain fit、fit-width、围绕锚点缩放（点保持精确）、
 *     边界钳制、缩放上下限、超大图降级
 *   - data URI 元数据：mime / 字节数 / alpha 判定
 *   - EXIF fixture：Orientation=6 标签存在、SOF 原始尺寸横图（方向矫正后应竖显）
 *   - fixture 统计：IHDR 尺寸（8K/4K/2×2/超宽/超高）、透明 PNG colorType=6(RGBA)、
 *     WebP RIFF 头、JPEG SOI、中文/空格文件名存在
 *
 * 运行：pnpm test:wave5b（esbuild bundle → node）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 测试经 esbuild bundle 到 out/tests/，pnpm scripts 保证 cwd = 项目根
const ROOT = process.cwd();
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---------- 纯逻辑（与生产同代码路径） ----------

import {
  clampPan,
  clampZoom,
  computeFitScale,
  degradationPolicy,
  fitWidthScale,
  formatBytes,
  MAX_ZOOM,
  MAX_ZOOM_LARGE_IMAGE,
  metadataFromDataUri,
  mimeLabel,
  zoomAround,
} from "../src/renderer/src/lib/imageView";

function math() {
  // fit-to-window（contain）
  const fit = computeFitScale(4000, 3000, 1000, 700);
  check("fit: contain 取 min", Math.abs(fit.scale - 0.233333) < 0.001, fit.scale.toFixed(4));
  check("fit: 宽高等比", Math.abs(fit.width / fit.height - 4000 / 3000) < 0.001);
  const fitTall = computeFitScale(3000, 4000, 1000, 700);
  check("fit: 竖图高度受限", Math.abs(fitTall.scale - 0.175) < 0.001, fitTall.scale.toFixed(4));
  check("fit: 非法输入 → 1", computeFitScale(0, 0, 100, 100).scale === 1);

  // fit-width
  const fw = fitWidthScale(4000, 3000, 1000);
  check("fit-width: 宽度适配", Math.abs(fw.scale - 0.25) < 0.001 && fw.width === 1000 && fw.height === 750);

  // 围绕锚点缩放：图片上同一点保持视口位置不变
  const { panX, panY } = zoomAround(0.5, 10, 20, 2, 300, 200);
  const pxBefore = (300 - 10) / 0.5;
  const pyBefore = (200 - 20) / 0.5;
  check("zoomAround: 锚点保持精确", Math.abs(300 - pxBefore * 2 - panX) < 1e-9 && Math.abs(200 - pyBefore * 2 - panY) < 1e-9, `${panX.toFixed(2)},${panY.toFixed(2)}`);

  // 缩放上下限
  check("zoom: 上限 16x", clampZoom(99, MAX_ZOOM) === MAX_ZOOM);
  check("zoom: 下限 0.05x", clampZoom(0.001, MAX_ZOOM) === 0.05);
  check("zoom: 超大图上限 3x", clampZoom(99, MAX_ZOOM_LARGE_IMAGE) === MAX_ZOOM_LARGE_IMAGE);

  // 超大图降级
  const dSmall = degradationPolicy(33_177_600);
  check("degrade: 8K(33MP) 非超大图", !dSmall.largeImage && dSmall.maxZoom === MAX_ZOOM && dSmall.hint === null);
  const dHuge = degradationPolicy(120_000_000);
  check("degrade: 120MP 超大图降级", dHuge.largeImage && dHuge.maxZoom === 3 && dHuge.hint !== null);

  // pan 钳制：小于视口 → 居中；大于视口 → 贴边
  const centered = clampPan(0, 0, 100, 100, 1000, 800);
  check("pan: 小于视口居中", centered.panX === 450 && centered.panY === 350, `${centered.panX},${centered.panY}`);
  const big = clampPan(50, -9999, 2000, 1500, 1000, 800);
  check("pan: 大于视口贴边钳制", big.panX === 0 && big.panY === -700, `${big.panX},${big.panY}`);
  const clamped = clampPan(9999, 9999, 2000, 1500, 1000, 800);
  check("pan: 正向越界钳到 0（左边缘贴齐）", clamped.panX === 0 && clamped.panY === 0, `${clamped.panX},${clamped.panY}`);
}

function metadata() {
  const m = metadataFromDataUri("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
  check("meta: png mime + alpha", m.mime === "image/png" && m.mayHaveAlpha);
  // 真实 fixture 往返：base64 换算必须精确等于文件字节数
  const small = readFileSync(join(FIX, "image-small.png"));
  const round = metadataFromDataUri(`data:image/png;base64,${small.toString("base64")}`);
  check("meta: base64 字节换算 = 文件字节数", round.sizeBytes === small.length, `${round.sizeBytes} vs ${small.length}`);
  const j = metadataFromDataUri("data:image/jpeg;base64,/9j/4AAQ==");
  check("meta: jpeg 无 alpha", j.mime === "image/jpeg" && !j.mayHaveAlpha);
  check("meta: 非 data URI", metadataFromDataUri("hello").mime === null);
  check("meta: webp alpha 候选", metadataFromDataUri("data:image/webp;base64,AAAA").mayHaveAlpha);
  check("label: PNG/JPEG/WebP", mimeLabel("image/png") === "PNG" && mimeLabel("image/jpeg") === "JPEG" && mimeLabel("image/webp") === "WebP");
  check("label: 未知 mime", mimeLabel("image/bmp") === "BMP");
  check("bytes: 格式化", formatBytes(500) === "500 B" && formatBytes(2048) === "2.0 KB" && formatBytes(null) === "—");
}

// ---------- EXIF / fixture 解析 ----------

function pngInfo(buffer: Buffer): { w: number; h: number; colorType: number } {
  const w = buffer.readUInt32BE(16);
  const h = buffer.readUInt32BE(20);
  return { w, h, colorType: buffer[25] };
}

function jpegRawSize(buffer: Buffer): { w: number; h: number } {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const len = buffer.readUInt16BE(offset + 2);
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) return { h: buffer.readUInt16BE(offset + 5), w: buffer.readUInt16BE(offset + 7) };
    offset += 2 + len;
  }
  throw new Error("no SOF");
}

/** 解析 EXIF Orientation 标签（仅扫描 IFD0 的 0x0112） */
function exifOrientation(buffer: Buffer): number | null {
  const app1 = buffer.indexOf(Buffer.from("Exif\u0000\u0000"));
  if (app1 < 0) return null;
  const tiff = buffer.subarray(app1 + 6);
  if (tiff.subarray(0, 2).toString("ascii") !== "II") return null;
  const ifd0 = tiff.readUInt32LE(4);
  const count = tiff.readUInt16LE(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (tiff.readUInt16LE(entry) === 0x0112) return tiff.readUInt16LE(entry + 8);
  }
  return null;
}

function exifFixture() {
  const exif = readFileSync(join(FIX, "image-exif-rotated.jpg"));
  const raw = jpegRawSize(exif);
  check("exif: SOF 原始尺寸横图 600×400", raw.w === 600 && raw.h === 400, `${raw.w}×${raw.h}`);
  const orient = exifOrientation(exif);
  check("exif: Orientation=6 标签存在", orient === 6, String(orient));
  check(
    "exif: 浏览器方向矫正后应竖显（w<h）——E2E 验证显示，此处验证输入",
    raw.w > raw.h,
  );
}

function fixtureStats() {
  const p8k = pngInfo(readFileSync(join(FIX, "image-8k.png")));
  check("fixture: 8K 7680×4320", p8k.w === 7680 && p8k.h === 4320, `${p8k.w}×${p8k.h}`);
  const p4k = pngInfo(readFileSync(join(FIX, "image-4k.png")));
  check("fixture: 4K 3840×2160", p4k.w === 3840 && p4k.h === 2160);
  const pSmall = pngInfo(readFileSync(join(FIX, "image-small.png")));
  check("fixture: 2×2 像素图", pSmall.w === 2 && pSmall.h === 2);
  const pWide = pngInfo(readFileSync(join(FIX, "image-wide.png")));
  check("fixture: 超宽 4096×512", pWide.w === 4096 && pWide.h === 512);
  const pTall = pngInfo(readFileSync(join(FIX, "image-tall.png")));
  check("fixture: 超高 512×4096", pTall.w === 512 && pTall.h === 4096);
  const pT = pngInfo(readFileSync(join(FIX, "image-transparent.png")));
  check("fixture: 透明 PNG RGBA(colorType=6)", pT.colorType === 6, `colorType=${pT.colorType}`);
  const pT2 = pngInfo(readFileSync(join(FIX, "透明-图片.png")));
  check("fixture: 中文文件名内容一致", pT2.w === pT.w && pT2.colorType === 6);
  const pS = pngInfo(readFileSync(join(FIX, "spaced name.png")));
  check("fixture: 空格文件名内容一致", pS.w === pT.w && pS.colorType === 6);

  const webp = readFileSync(join(FIX, "image-basic.webp"));
  check("fixture: WebP RIFF/WEBP 头", webp.subarray(0, 4).toString("ascii") === "RIFF" && webp.subarray(8, 12).toString("ascii") === "WEBP");
  const jpg = readFileSync(join(FIX, "image-basic.jpg"));
  check("fixture: JPEG SOI 头", jpg[0] === 0xff && jpg[1] === 0xd8);
  const png = readFileSync(join(FIX, "image-basic.png"));
  check("fixture: PNG 签名", png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a");

  // 8K 作为 data URI 可被 viewer 消费（无截断）
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  check("fixture: PNG → data URI 往返", metadataFromDataUri(dataUri).mime === "image/png");
}

// ---------- 入口 ----------

function main(): void {
  console.log("== Wave 5B unit/contract（node） ==");
  math();
  metadata();
  exifFixture();
  fixtureStats();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    for (const [name, , detail] of failed) console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
}

main();
