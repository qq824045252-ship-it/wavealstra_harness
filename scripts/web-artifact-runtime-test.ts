/**
 * WebArtifactRuntime / ArtifactProtocol Tests — V3.5 Wave 4B（§17 安全 contract）
 *
 * 覆盖：
 *   正常路径  N1-N12：HTML/CSS/JS/SVG/PNG 二进制/nested/URL 编码文件名/
 *             managed-content 入口与子资源/Protocol 全链路/HEAD/urlFor 往返
 *   错误路径  E1-E13：404/405/400/traversal/encoded traversal/绝对路径/
 *             盘符/UNC/rootDir escape/junction escape/query-hash 剥离
 *   Runtime   B1-B4：稳定解析/version 更新读新内容/不绕过 Domain/路径合法但缺失
 *
 * 运行：pnpm test:web-artifact-runtime（esbuild bundle → node，
 *       不依赖 Electron：Protocol.handle 用标准 Request/Response 直测）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactProtocol } from "../src/main/artifact/ArtifactProtocol";
import {
  WebArtifactRuntime,
  resolveWithinRoot,
  type ArtifactSourceResolver,
  type WebResourceResult,
} from "../src/main/artifact/WebArtifactRuntime";

// ---------- 测试夹具 ----------
interface FixtureArtifact {
  type: "workspace-file" | "managed-content";
  root: string;
  entryFile?: string;
  content?: string;
  calls: { filePathOf: number; contentOf: number; rootOf: number };
}

function makeFixture(): { root: string; artifacts: Map<string, FixtureArtifact>; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-runtime-"));
  const ws = join(root, "ws");
  const mc = join(root, "mc", "art-1");
  mkdirSync(join(ws, "assets", "img"), { recursive: true });
  mkdirSync(join(ws, "nested"), { recursive: true });
  mkdirSync(mc, { recursive: true });

  writeFileSync(join(ws, "index.html"), "<!doctype html><title>ws</title>", "utf-8");
  writeFileSync(join(ws, "style.css"), "body { color: red; }", "utf-8");
  writeFileSync(join(ws, "app.js"), "console.log('hi');", "utf-8");
  writeFileSync(join(ws, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf-8");
  // 1x1 红色 PNG（最小合法字节）
  writeFileSync(
    join(ws, "assets", "img", "1x1.png"),
    Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72dfa430000000049454e44ae426082", "hex"),
  );
  writeFileSync(join(ws, "nested", "deep.txt"), "deep", "utf-8");
  writeFileSync(join(ws, "数据.txt"), "chinese filename", "utf-8");
  writeFileSync(join(mc, "index.html"), "<!doctype html><title>mc</title>", "utf-8");
  writeFileSync(join(mc, "sub.txt"), "mc sub", "utf-8");
  // root 外的敏感文件（验证 traversal 无法触达）
  writeFileSync(join(root, "secret.txt"), "TOP SECRET", "utf-8");

  const artifacts = new Map<string, FixtureArtifact>();
  const wsRec: FixtureArtifact = {
    type: "workspace-file",
    root: ws,
    entryFile: join(ws, "index.html"),
    calls: { filePathOf: 0, contentOf: 0, rootOf: 0 },
  };
  const mcRec: FixtureArtifact = {
    type: "managed-content",
    root: mc,
    content: "<!doctype html><title>mc</title>",
    calls: { filePathOf: 0, contentOf: 0, rootOf: 0 },
  };
  artifacts.set("ws-artifact", wsRec);
  artifacts.set("mc-artifact", mcRec);

  return { root, artifacts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeResolver(fx: { artifacts: Map<string, FixtureArtifact> }): ArtifactSourceResolver {
  return {
    filePathOf: (id) => {
      const a = fx.artifacts.get(id);
      if (!a) return null;
      a.calls.filePathOf += 1;
      return a.type === "workspace-file" ? (a.entryFile ?? null) : null;
    },
    contentOf: async (id) => {
      const a = fx.artifacts.get(id);
      if (!a) return null;
      a.calls.contentOf += 1;
      return a.type === "managed-content" ? (a.content ?? null) : null;
    },
    rootOf: (id) => {
      const a = fx.artifacts.get(id);
      if (!a) return null;
      a.calls.rootOf += 1;
      return a.root;
    },
  };
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const is = (r: WebResourceResult, status: number, mime?: string): boolean =>
  r.status === status && (mime === undefined || r.mimeType === mime);

async function main(): Promise<void> {
  const fx = makeFixture();
  const runtime = new WebArtifactRuntime(makeResolver(fx));
  const protocol = new ArtifactProtocol(runtime);
  const urlFor = (id: string, sub?: string): string =>
    ArtifactProtocol.urlFor(id) + (sub ? sub.replace(/^\//, "") : "");
  const get = (id: string, sub?: string): Promise<Response> =>
    protocol.handle(new Request(urlFor(id, sub), { method: "GET" }));

  try {
    // ========== 正常路径 ==========
    {
      const r = await runtime.resolve("ws-artifact", "");
      check("N1 HTML root document", is(r, 200, "text/html; charset=utf-8") && r.body === "<!doctype html><title>ws</title>");
      const r2 = await runtime.resolve("ws-artifact", "style.css");
      check("N2 CSS 相对资源", is(r2, 200, "text/css; charset=utf-8") && r2.body === "body { color: red; }");
      const r3 = await runtime.resolve("ws-artifact", "app.js");
      check("N3 JS 相对资源", is(r3, 200, "text/javascript; charset=utf-8"));
      const r4 = await runtime.resolve("ws-artifact", "assets/logo.svg");
      check("N4 SVG 相对资源", is(r4, 200, "image/svg+xml"));
      const r5 = await runtime.resolve("ws-artifact", "assets/img/1x1.png");
      check("N5 PNG 二进制资源", is(r5, 200, "image/png") && r5.body instanceof Uint8Array && (r5.body as Uint8Array).byteLength > 0);
      const r6 = await runtime.resolve("ws-artifact", "nested/deep.txt");
      check("N6 nested 相对资源", is(r6, 200, "text/plain; charset=utf-8") && r6.body === "deep");
      const r7 = await runtime.resolve("ws-artifact", "数据.txt");
      check("N7 URL 编码文件名（decode 后中文）", is(r7, 200) && r7.body === "chinese filename");
      const r8 = await runtime.resolve("mc-artifact", "");
      check("N8 managed-content 入口", is(r8, 200, "text/html; charset=utf-8") && r8.body === "<!doctype html><title>mc</title>");
      const r9 = await runtime.resolve("mc-artifact", "sub.txt");
      check("N9 managed-content 子资源", is(r9, 200) && r9.body === "mc sub");
      const resp = await get("ws-artifact", "style.css");
      check("N10 Protocol 全链路（Request→Response）", resp.status === 200 && (resp.headers.get("content-type") ?? "").startsWith("text/css") && resp.headers.get("cache-control") === "no-store" && resp.headers.get("x-content-type-options") === "nosniff");
      const head = await protocol.handle(new Request(urlFor("ws-artifact", "index.html"), { method: "HEAD" }));
      check("N11 HEAD 请求 200 无 body", head.status === 200 && (await head.text()) === "");
      const round = await get("ws-artifact");
      check("N12 urlFor 往返（id 编码/解码一致）", round.status === 200);
    }

    // ========== 错误路径 ==========
    {
      const r = await runtime.resolve("nope-artifact", "");
      check("E1 artifact 不存在 → 404", is(r, 404));
      const r2 = await runtime.resolve("ws-artifact", "missing.js");
      check("E2 资源不存在 → 404", is(r2, 404));
      const post = await protocol.handle(new Request(urlFor("ws-artifact"), { method: "POST" }));
      check("E3 非法 method → 405", post.status === 405);
      const r4 = await runtime.resolve("ws-artifact", "../secret.txt");
      check("E4 path traversal（../）→ 403", is(r4, 403));
      const enc = await get("ws-artifact", "%2e%2e/secret.txt");
      // WHATWG URL 解析期把 %2e%2e 规范化为 .. 并吞掉前段 → artifactId 变成 secret.txt → 404；
      // 无论 403 还是 404 都证明编码 traversal 无法触达 root 外内容
      check("E5 encoded traversal（%2e%2e/）被拦截", enc.status === 403 || enc.status === 404, `status=${enc.status}`);
      const r6 = await runtime.resolve("ws-artifact", "/etc/passwd");
      check("E6 绝对路径 → 403", is(r6, 403));
      const r7 = await runtime.resolve("ws-artifact", "C:/Windows/win.ini");
      check("E7 盘符跳转 → 403", is(r7, 403));
      const r8 = await runtime.resolve("ws-artifact", "//server/share/x");
      check("E8 UNC path → 403", is(r8, 403));
      const r9 = await runtime.resolve("ws-artifact", "a/../../secret.txt");
      check("E9 rootDir escape（多段 ..）→ 403", is(r9, 403));
      const q = await get("ws-artifact", "style.css?v=1#frag");
      check("E10 query/hash 剥离后正常解析", q.status === 200 && (q.headers.get("content-type") ?? "").startsWith("text/css"));
      const bad = await protocol.handle(new Request(urlFor("ws-artifact", "%zz"), { method: "GET" }));
      check("E11 malformed percent-encoding → 400", bad.status === 400);
      // junction escape（Windows junction 无需特权；其他平台 skip）
      const outside = join(fx.root, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "secret.txt"), "outside secret", "utf-8");
      const link = join(fx.artifacts.get("ws-artifact")!.root, "link");
      let junctionOk = false;
      try {
        symlinkSync(outside, link, "junction");
        junctionOk = true;
      } catch {
        /* 平台不支持 junction → skip */
      }
      if (junctionOk) {
        const r12 = await runtime.resolve("ws-artifact", "link/secret.txt");
        check("E12 junction escape → 403", is(r12, 403));
        rmSync(link, { recursive: true, force: true });
      } else {
        console.log("SKIP  E12 junction escape（平台不支持 junction）");
      }
      const r13 = await runtime.resolve("ws-artifact", "index.html/../index.html");
      check("E13 合法路径段但…(目录内 .. 归位)", is(r13, 200)); // a/.. 归位后仍在 root 内 → 200
    }

    // ========== Runtime 行为 ==========
    {
      const a = await runtime.resolve("ws-artifact", "style.css");
      const b = await runtime.resolve("ws-artifact", "style.css");
      check("B1 相同 artifactId/资源稳定解析", a.body === b.body && a.mimeType === b.mimeType);
      // version 更新（文件内容变化）→ 读取新内容（runtime 无缓存）
      const cssPath = join(fx.artifacts.get("ws-artifact")!.root, "style.css");
      writeFileSync(cssPath, "body { color: blue; }", "utf-8");
      const c = await runtime.resolve("ws-artifact", "style.css");
      check("B2 artifact 内容更新后读取新内容", c.body === "body { color: blue; }");
      writeFileSync(cssPath, "body { color: red; }", "utf-8");
      // 不绕过 Domain：workspace-file 入口经 filePathOf/rootOf，managed-content 经 contentOf
      const wsRec = fx.artifacts.get("ws-artifact")!;
      const mcRec = fx.artifacts.get("mc-artifact")!;
      const fpBefore = wsRec.calls.filePathOf;
      await runtime.resolve("ws-artifact", "");
      check("B3a 入口解析走 resolver（filePathOf 被调用）", wsRec.calls.filePathOf > fpBefore);
      const coBefore = mcRec.calls.contentOf;
      await runtime.resolve("mc-artifact", "");
      check("B3b managed-content 走 contentOf（不读磁盘）", mcRec.calls.contentOf > coBefore);
      const r = await runtime.resolve("ws-artifact", "ok-parent/../style.css");
      check("B4 目录内 .. 归位仍解析 → 200", is(r, 200));
      const r5 = await runtime.resolve("ws-artifact", "nested/missing.txt");
      check("B4b 路径合法但文件缺失 → 404", is(r5, 404));
      // resolveWithinRoot 直接单测
      const wsRoot = fx.artifacts.get("ws-artifact")!.root;
      check("B5 resolveWithinRoot 正常归位", resolveWithinRoot(wsRoot, "a/../style.css")?.endsWith("style.css") ?? false);
      check("B5b resolveWithinRoot 越界拒绝", resolveWithinRoot(wsRoot, "../x") === null);
      check("B5c resolveWithinRoot 绝对路径拒绝", resolveWithinRoot(wsRoot, "/abs") === null);
      check("B5d resolveWithinRoot 盘符拒绝", resolveWithinRoot(wsRoot, "C:\\\\x") === null);
      check("B5e resolveWithinRoot UNC 拒绝", resolveWithinRoot(wsRoot, "//srv/x") === null);
      check("B5f resolveWithinRoot null byte 拒绝", resolveWithinRoot(wsRoot, "a\u0000b") === null);
    }
  } finally {
    fx.cleanup();
  }

  const failed = results.filter(([, pass]) => !pass);
  console.log("");
  console.log(`===== WebArtifactRuntime/ArtifactProtocol: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map(([n]) => n).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[web-artifact-runtime-test] 异常:", e);
  process.exit(1);
});
