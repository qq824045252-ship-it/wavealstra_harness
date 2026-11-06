/**
 * Chromium 侧协议缓存验证：版本化 URL + immutable 到底省掉了哪一层请求。
 *
 * 为什么要这条：`cache-control` 只是响应头，unit test 只能断言头内容。而同一个
 * document 里重新挂载同一个 <img> 会命中 Chromium 的图片解码缓存，无论头部写什么
 * ——所以「同 document 二次挂载」区分不出 no-store 与 immutable，必须跨 document 比。
 *
 * 对照组 = `no-store`，实验组 = 版本化 URL + immutable，各自：
 *   挂载 → 重新加载页面（新 document）→ 再挂载 → 统计回主进程的请求次数
 *   no-store：第二次仍回主进程（没存任何东西）
 *   immutable：第二次命中协议缓存（不回主进程）
 * 再验证版本号变化会让 URL 改变、必须重新取字节。
 *
 * 运行：pnpm test:artifact-image-cache-electron
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow, app, protocol } from "electron";

/** 1×1 透明 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const hits: Record<string, number> = { cached: 0, nostore: 0 };

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mybuddy-artifact",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

function mountImage(url: string): string {
  return `new Promise((resolve) => {
    const img = document.createElement('img');
    img.src = ${JSON.stringify(url)};
    img.onload = () => { img.remove(); resolve('ok'); };
    img.onerror = () => { img.remove(); resolve('error'); };
    document.body.appendChild(img);
  })`;
}

async function main(): Promise<void> {
  await app.whenReady();
  protocol.handle("mybuddy-artifact", async (request) => {
    const url = new URL(request.url);
    const zone = url.pathname.includes("nostore") ? "nostore" : "cached";
    hits[zone] = (hits[zone] ?? 0) + 1;
    return new Response(PNG, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "cache-control":
          zone === "nostore" ? "no-store" : "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  });

  const dir = mkdtempSync(join(tmpdir(), "artifact-cache-"));
  const page = join(dir, "index.html");
  writeFileSync(page, "<!doctype html><meta charset=utf-8><body></body>", "utf8");

  const win = new BrowserWindow({ show: false });
  const failures: string[] = [];
  const expect = (name: string, ok: boolean, detail: string): void => {
    console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
    if (!ok) failures.push(name);
  };

  try {
    const mount = (zone: "cached" | "nostore", version: number): Promise<string> =>
      win.webContents.executeJavaScript(
        mountImage(`mybuddy-artifact://local/${zone}/?variant=thumb&v=${version}`),
      ) as Promise<string>;
    /** 新 document：清掉文档级图片缓存，只留下 HTTP/协议缓存可复用 */
    const newDocument = async (): Promise<void> => {
      const loaded = new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
      await win.loadFile(page);
      await loaded;
    };

    await newDocument();

    // ---- 对照组：no-store 跨 document 也必须重新请求 ----
    await mount("nostore", 1);
    await newDocument();
    await mount("nostore", 1);
    expect(
      "no-store：新 document 再挂载仍回主进程（基线）",
      hits.nostore === 2,
      `主进程请求次数=${hits.nostore}（期望 2）`,
    );

    // ---- 实验组：版本化 + immutable ----
    await mount("cached", 1);
    await newDocument();
    await mount("cached", 1);
    expect(
      "版本化 immutable：新 document 再挂载命中协议缓存，不回主进程",
      hits.cached === 1,
      `主进程请求次数=${hits.cached}（期望 1）`,
    );

    // ---- 版本滚动：URL 变化必须重新取字节（不能把旧字节钉在新 URL 上） ----
    await newDocument();
    await mount("cached", 2);
    expect(
      "版本号变化 → 新 URL → 重新回主进程",
      hits.cached === 2,
      `主进程请求次数=${hits.cached}（期望 2）`,
    );
  } finally {
    win.destroy();
    rmSync(dir, { recursive: true, force: true });
    if (failures.length > 0) {
      console.log(`===== artifact-image-cache-electron: 失败 ${failures.length} 项 =====`);
      process.exitCode = 1;
    } else {
      console.log("===== artifact-image-cache-electron: 3/3 通过 =====");
    }
    setTimeout(() => app.quit(), 50);
  }
}

void main();
