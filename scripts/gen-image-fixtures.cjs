/**
 * Wave 5B — Image fixtures 生成器（§87 / §28 deferred 补齐）
 *
 * 真实 Electron canvas 生成（PNG/JPEG/WebP 编码由 Chromium 完成），
 * 纯 JS 注入 EXIF APP1（Orientation=6）验证浏览器方向矫正。
 *
 * 产物（fixtures/artifacts/synthetic/）：
 *   image-basic.png        1024×768 渐变+图形（常规 PNG）
 *   image-basic.jpg        1024×768（JPEG）
 *   image-basic.webp       1024×768（WebP）
 *   image-transparent.png  800×600 半透明图形 + 实心区（棋盘格验证）
 *   透明-图片.png          同透明样本（中文文件名）
 *   spaced name.png        同透明样本（空格文件名）
 *   image-exif-rotated.jpg 600×400 横图 + EXIF Orientation=6 → 显示 400×600
 *   image-wide.png         4096×512 超宽
 *   image-tall.png         512×4096 超高
 *   image-4k.png           3840×2160（4K）
 *   image-8k.png           7680×4320（8K，33MP）
 *   image-small.png        2×2 四色像素图
 *
 * 运行：node_modules/.bin/electron.cmd scripts/gen-image-fixtures.cjs
 * 确定性：全部固定图案（渐变/网格/形状），无随机。
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync, mkdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const OUT = join(__dirname, "..", "fixtures", "artifacts", "synthetic");
mkdirSync(OUT, { recursive: true });

// ---------- EXIF 工具（纯 JS） ----------

/** 构造 EXIF APP1 段（仅 Orientation 标签，little-endian TIFF） */
function exifOrientationApp1(orientation) {
  // TIFF 头 8B + IFD0（2B count + 12B entry + 4B next）= 26B
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0);
  tiff.writeUInt16LE(0x2a00, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(1, 8); // entry count = 1
  tiff.writeUInt16LE(0x0112, 10); // tag Orientation
  tiff.writeUInt16LE(3, 12); // type SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // value
  tiff.writeUInt32LE(0, 22); // next IFD = 0
  const seg = Buffer.alloc(2 + 2 + 6 + tiff.length);
  seg.writeUInt16BE(0xffe1, 0); // APP1 marker
  seg.writeUInt16BE(seg.length - 2, 2);
  seg.write("Exif\u0000\u0000", 4);
  tiff.copy(seg, 10);
  return seg;
}

/** 在 SOI 之后插入 APP1 段 */
function injectExifOrientation(jpegBuffer, orientation) {
  if (jpegBuffer.length < 2 || jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) {
    throw new Error("not a jpeg");
  }
  return Buffer.concat([jpegBuffer.subarray(0, 2), exifOrientationApp1(orientation), jpegBuffer.subarray(2)]);
}

/** 解析 JPEG SOF 段原始尺寸（未应用方向） */
function jpegRawSize(jpegBuffer) {
  let offset = 2;
  while (offset + 4 <= jpegBuffer.length) {
    if (jpegBuffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = jpegBuffer[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const len = jpegBuffer.readUInt16BE(offset + 2);
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return { h: jpegBuffer.readUInt16BE(offset + 5), w: jpegBuffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + len;
  }
  throw new Error("no SOF found");
}

/** 从 PNG 头解析 IHDR 尺寸 / 颜色类型 */
function pngInfo(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not png");
  const w = buffer.readUInt32BE(16);
  const h = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  return { w, h, colorType };
}

// ---------- 图案绘制（确定性） ----------

function drawGradientAndShapes(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#e74c3c");
  grad.addColorStop(0.5, "#3498db");
  grad.addColorStop(1, "#2ecc71");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // 网格线（8K 下可见结构，PNG 压缩友好）
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = Math.max(1, Math.round(w / 512));
  const step = Math.max(16, Math.round(w / 24));
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // 角标（方向辨识：左上红块 / 右下黄块）
  ctx.fillStyle = "#c0392b";
  ctx.fillRect(0, 0, Math.max(24, Math.round(w * 0.06)), Math.max(24, Math.round(h * 0.06)));
  ctx.fillStyle = "#f1c40f";
  ctx.fillRect(w - Math.max(24, Math.round(w * 0.06)), h - Math.max(24, Math.round(h * 0.06)), Math.max(24, Math.round(w * 0.06)), Math.max(24, Math.round(h * 0.06)));
  // 圆
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.18, 0, Math.PI * 2);
  ctx.fill();
}

/** 大尺寸用纯色带（PNG 压缩友好，8K 下仍可见结构与方向标记） */
function drawBands(ctx, w, h) {
  const bands = ["#c0392b", "#e67e22", "#f1c40f", "#27ae60", "#2980b9", "#8e44ad", "#ecf0f1", "#2c3e50"];
  const bandH = Math.round(h / bands.length);
  bands.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, i * bandH, w, i === bands.length - 1 ? h - i * bandH : bandH);
  });
  // 白色细网格（结构可见性）
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = Math.max(2, Math.round(w / 600));
  const step = Math.max(64, Math.round(w / 20));
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // 角标
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, Math.round(w * 0.05), Math.round(h * 0.05));
  ctx.fillStyle = "#000000";
  ctx.fillRect(w - Math.round(w * 0.05), h - Math.round(h * 0.05), Math.round(w * 0.05), Math.round(h * 0.05));
}

function drawTransparent(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  // 半透明红色圆（alpha 关键区）
  ctx.fillStyle = "rgba(231, 76, 60, 0.5)";
  ctx.beginPath();
  ctx.arc(w * 0.3, h * 0.4, Math.min(w, h) * 0.22, 0, Math.PI * 2);
  ctx.fill();
  // 半透明蓝色矩形
  ctx.fillStyle = "rgba(52, 152, 219, 0.6)";
  ctx.fillRect(w * 0.55, h * 0.5, w * 0.3, h * 0.3);
  // 不透明绿色小方块（棋盘格上应有实色）
  ctx.fillStyle = "#27ae60";
  ctx.fillRect(w * 0.45, h * 0.15, w * 0.1, h * 0.1);
}

function drawExifPattern(ctx, w, h) {
  // 横图：上半红色、下半蓝色 + 左上白块（旋转后应看到白块在左上）
  ctx.fillStyle = "#e74c3c";
  ctx.fillRect(0, 0, w, h / 2);
  ctx.fillStyle = "#2980b9";
  ctx.fillRect(0, h / 2, w, h / 2);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, Math.round(w * 0.2), Math.round(h * 0.4));
}

function drawSmall(ctx, w, h) {
  const colors = ["#e74c3c", "#2ecc71", "#3498db", "#f1c40f"];
  const cell = Math.max(1, Math.floor(w / 2));
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = colors[y * 2 + x];
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
}

// ---------- 生成 ----------

app.commandLine.appendSwitch("disable-gpu");
app.on("window-all-closed", () => {});

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 200, height: 200, show: false, webPreferences: { offscreen: true } });
  await win.loadURL("about:blank");
  const web = win.webContents;

  const canvasOf = async (w, h, draw) => {
    const dataUrl = await web.executeJavaScript(
      `(() => {
        const c = document.createElement('canvas');
        c.width = ${w}; c.height = ${h};
        const ctx = c.getContext('2d');
        (${draw.toString()})(ctx, ${w}, ${h});
        return c.toDataURL();
      })()`,
    );
    return Buffer.from(dataUrl.split(",")[1], "base64");
  };

  const encode = async (w, h, draw, mime, quality) => {
    const dataUrl = await web.executeJavaScript(
      `(() => {
        const c = document.createElement('canvas');
        c.width = ${w}; c.height = ${h};
        const ctx = c.getContext('2d');
        (${draw.toString()})(ctx, ${w}, ${h});
        return c.toDataURL(${JSON.stringify(mime)}${quality ? `, ${quality}` : ""});
      })()`,
    );
    const b64 = dataUrl.split(",")[1];
    if (!b64) throw new Error(`encode failed: ${mime} ${w}x${h}`);
    return Buffer.from(b64, "base64");
  };

  const report = [];
  const write = (name, buffer) => {
    writeFileSync(join(OUT, name), buffer);
    report.push(`${name}\t${buffer.length}`);
  };

  console.log("[gen-image-fixtures] 8K canvas 生成中（约 33MP）…");
  write("image-8k.png", await canvasOf(7680, 4320, drawBands));
  write("image-4k.png", await canvasOf(3840, 2160, drawBands));
  write("image-basic.png", await canvasOf(1024, 768, drawGradientAndShapes));
  write("image-basic.jpg", await encode(1024, 768, drawGradientAndShapes, "image/jpeg", 0.92));
  write("image-basic.webp", await encode(1024, 768, drawGradientAndShapes, "image/webp", 0.9));
  write("image-transparent.png", await canvasOf(800, 600, drawTransparent));
  write("透明-图片.png", await canvasOf(800, 600, drawTransparent));
  write("spaced name.png", await canvasOf(800, 600, drawTransparent));
  write("image-wide.png", await canvasOf(4096, 512, drawGradientAndShapes));
  write("image-tall.png", await canvasOf(512, 4096, drawGradientAndShapes));
  write("image-small.png", await canvasOf(2, 2, drawSmall));

  // EXIF 旋转 JPEG：横图 + Orientation=6
  const jpeg = await encode(600, 400, drawExifPattern, "image/jpeg", 0.92);
  const raw = jpegRawSize(jpeg);
  if (raw.w !== 600 || raw.h !== 400) throw new Error(`exif base dims wrong: ${JSON.stringify(raw)}`);
  write("image-exif-rotated.jpg", injectExifOrientation(jpeg, 6));

  // 校验
  const png8k = pngInfo(await (await import("node:fs/promises")).readFile(join(OUT, "image-8k.png")));
  const pngSmall = pngInfo(await (await import("node:fs/promises")).readFile(join(OUT, "image-small.png")));
  const pngT = pngInfo(await (await import("node:fs/promises")).readFile(join(OUT, "image-transparent.png")));
  const exif = await (await import("node:fs/promises")).readFile(join(OUT, "image-exif-rotated.jpg"));
  const exifRaw = jpegRawSize(exif);
  if (png8k.w !== 7680 || png8k.h !== 4320) throw new Error("8k png dims wrong");
  if (pngSmall.w !== 2 || pngSmall.h !== 2) throw new Error("small png dims wrong");
  if (pngT.colorType !== 6) throw new Error(`transparent png must be RGBA, got colorType ${pngT.colorType}`);
  if (exifRaw.w !== 600 || exifRaw.h !== 400) throw new Error("exif injector corrupted jpeg");
  // 确认 Orientation 标签存在
  const app1 = exif.subarray(2);
  if (app1.toString("utf8", 4, 10) !== "Exif\u0000\u0000") throw new Error("exif APP1 missing");

  console.log("[gen-image-fixtures] 完成：");
  for (const line of report) console.log(`  ${line}`);
  app.exit(0);
}

run().catch((e) => {
  console.error(e);
  app.exit(1);
});
