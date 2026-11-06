/**
 * 产物图片 URL 契约测试：版本化缓存 + 单一解析真源
 *
 * 背景：虚拟列表滚出 overscan 会卸载 <img>。若协议响应 `no-store`，或 URL 不带
 * 版本号导致无法用缓存键，滚回来必然重新发协议请求 + 重新解码位图，把"图片不再
 * 以 base64 过 IPC"的收益按滚动次数乘回去。
 *
 * 覆盖：
 *   U1-U7：URL 生成/解析往返、query 白名单、无 variant 的宿主 URL
 *   C1-C6：协议缓存头（版本匹配 → immutable；无版本 / 版本落后 → no-store；非法参数 → 400）
 *   E1-E3：行高估算与 markdown 图片引用同源（同一份正则，不各写一份）
 *
 * 运行：pnpm test:artifact-image-cache
 * （esbuild bundle → node；Protocol.handle 用标准 Request/Response 直测，不依赖 Electron）
 */
import {
  artifactImageMeta,
  artifactImageUrl,
  isArtifactImageUrl,
  parseArtifactImageUrl,
} from "../src/shared/artifact-ipc";
import { ArtifactProtocol } from "../src/main/artifact/ArtifactProtocol";
import type { WebArtifactRuntime } from "../src/main/artifact/WebArtifactRuntime";
import { estimateMessageHeight } from "../src/renderer/src/lib/messageSizeEstimate";
import { markdownImageSources } from "../src/renderer/src/lib/markdownImages";
import type { ChatMessage } from "../src/renderer/src/types";

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
}

const ARTIFACT_ID = "art:img/1";
/** 协议层只用到 runtime.resolve（非图片 URL 路径）；本测试不触发它 */
const runtimeStub = {
  resolve: async () => ({ status: 404, mimeType: "text/plain", body: null, cachePolicy: "no-store" }),
} as unknown as WebArtifactRuntime;

/** 图片变体解析器：故意返回一个固定版本，用来验证"URL 版本与真实版本比对" */
function makeProtocol(currentVersion: number) {
  return new ArtifactProtocol(
    runtimeStub,
    async (_id, _variant) => ({
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      version: currentVersion,
    }),
  );
}

async function main(): Promise<void> {
  // ========== U1-U7：URL 与解析 ==========
  {
    const url = artifactImageUrl(ARTIFACT_ID, "thumb", {
      mime: "image/png",
      bytes: 4096,
      width: 800,
      height: 600,
      version: 7,
    });
    check("U1 URL 携带版本参数", url.includes("v=7"), url);
    const parsed = parseArtifactImageUrl(url);
    check(
      "U2 解析往返",
      parsed?.artifactId === ARTIFACT_ID &&
        parsed.variant === "thumb" &&
        parsed.meta.version === 7 &&
        parsed.meta.bytes === 4096 &&
        parsed.meta.width === 800 &&
        parsed.meta.height === 600 &&
        parsed.meta.mime === "image/png",
      JSON.stringify(parsed),
    );
    check("U3 版本缺失时不应写 v=", !artifactImageUrl(ARTIFACT_ID, "thumb").includes("v="));
    check(
      "U4 无参数 URL 的 meta 不含版本",
      parseArtifactImageUrl(artifactImageUrl(ARTIFACT_ID, "full"))?.meta.version === undefined,
    );
    check(
      "U5 未知 query 参数被拒（白名单单一真源）",
      parseArtifactImageUrl(`${artifactImageUrl(ARTIFACT_ID, "thumb")}&evil=1`) === null,
    );
    check(
      "U6 无 variant 的宿主 URL 可解析为引用，但不能当图片源",
      parseArtifactImageUrl(ArtifactProtocol.urlFor(ARTIFACT_ID))?.variant === null &&
        !isArtifactImageUrl(ArtifactProtocol.urlFor(ARTIFACT_ID)),
    );
    check(
      "U7 artifactImageMeta 与解析同源",
      artifactImageMeta(artifactImageUrl(ARTIFACT_ID, "full", { version: 3 })).version === 3,
    );
  }

  // ========== C1-C6：协议缓存头 ==========
  {
    const request = (query: string) =>
      new Request(
        `mybuddy-artifact://local/${encodeURIComponent(ARTIFACT_ID)}/?variant=thumb&${query}`,
        { method: "GET" },
      );

    const fresh = await makeProtocol(7).handle(request("v=7"));
    check(
      "C1 版本匹配 → 200 + immutable 长缓存",
      fresh.status === 200 && fresh.headers.get("cache-control") === "private, max-age=31536000, immutable",
      `${fresh.status} ${fresh.headers.get("cache-control")}`,
    );

    const noVersion = await makeProtocol(7).handle(request("mime=image%2Fpng"));
    check(
      "C2 无版本参数 → 200 + no-store（避免新字节钉在旧 URL）",
      noVersion.status === 200 && noVersion.headers.get("cache-control") === "no-store",
      `${noVersion.status} ${noVersion.headers.get("cache-control")}`,
    );

    const stale = await makeProtocol(8).handle(request("v=7"));
    check(
      "C3 URL 版本落后于 descriptor → no-store",
      stale.status === 200 && stale.headers.get("cache-control") === "no-store",
      `${stale.status} ${stale.headers.get("cache-control")}`,
    );

    const badParam = await makeProtocol(7).handle(request("v=7&evil=1"));
    check("C4 未知 query 参数 → 400", badParam.status === 400, String(badParam.status));

    const multiSegment = await makeProtocol(7).handle(
      new Request(
        `mybuddy-artifact://local/${encodeURIComponent(ARTIFACT_ID)}/print/?variant=thumb`,
        { method: "GET" },
      ),
    );
    check("C5 多段路径不是图片 URL → 400（不落到子资源路由）", multiSegment.status === 400, String(multiSegment.status));

    const head = await makeProtocol(7).handle(
      new Request(`mybuddy-artifact://local/${encodeURIComponent(ARTIFACT_ID)}/?variant=full&v=7`, {
        method: "HEAD",
      }),
    );
    check(
      "C6 HEAD 走同一缓存策略且无 body",
      head.status === 200 && head.body === null && head.headers.get("cache-control")?.includes("immutable") === true,
      `${head.status} ${head.headers.get("cache-control")}`,
    );
  }

  // ========== E1-E3：行高估算与 markdown 图片引用同源 ==========
  {
    const assistant = (text: string): ChatMessage =>
      ({
        role: "assistant",
        blocks: [],
        finalBlocks: [{ type: "text", text }],
        streaming: false,
        artifactIds: [],
      }) as unknown as ChatMessage;
    const oneImage = "x![](a.png)";
    const threeImages = "x![](a.png)![](b.png)![](c.png)";
    // 文本都只占一行：差值应正好是 3 张图的预估高度
    const delta = estimateMessageHeight(assistant(threeImages)) - estimateMessageHeight(assistant("x"));
    check("E1 三张图让估算高度增加 3×240", delta === 720, String(delta));
    check(
      "E2 估算的图片数与 markdownImageSources 完全一致（单一真源）",
      markdownImageSources(oneImage).length === 1 && markdownImageSources(threeImages).length === 3,
    );
    const htmlImages = 'x<img src="a.png"><img src="b.png">';
    const htmlDelta = estimateMessageHeight(assistant(htmlImages)) - estimateMessageHeight(assistant("x"));
    check("E3 HTML img 写法也计入估算", htmlDelta === 480 && markdownImageSources(htmlImages).length === 2, String(htmlDelta));
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  }
  console.log(
    `===== artifact-image-cache: ${results.length - failed.length}/${results.length} 通过 =====`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

void main();
