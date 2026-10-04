/**
 * Artifact Render Hydration — 单元/契约测试（V3.5 hotfix §25 H1-H12）
 *
 * 直接测 lib/renderHydration.ts（纯逻辑 + 可注入依赖），无需 Electron：
 *  - H1  cache miss → readContent
 *  - H2  cache hit + version same → 不重复读取
 *  - H3  version mismatch → reload
 *  - H4  concurrent → single-flight（readContent 只调 1 次）
 *  - H5  readContent null → error
 *  - H6  empty binary → error（空内容不得进入 ready）
 *  - H7  stale promise → discard + 按新版本重试
 *  - H8  artifact updated → invalidate（版本移动才失效；同版本保留）
 *  - H9  artifact removed → clear
 *  - H10 removed during hydration → 不复活
 *  - H11 workspace-file → payload.path = entryFile
 *  - H12 managed-content → payload.path = response.path
 *
 * 运行：pnpm test:artifact-render-hydration
 */
import { createRenderHydration } from "../src/renderer/src/lib/renderHydration";
import type { ArtifactDescriptor, ArtifactSource } from "../src/shared/artifact-types";
import type { ArtifactDomainReadContentResponse } from "../src/shared/artifact-ipc";
import type {
  ArtifactRenderLoadState,
  RenderHydrationDeps,
} from "../src/renderer/src/lib/renderHydration";
import type { ArtifactRenderPayload } from "../src/renderer/src/lib/artifactIngest";

let passed = 0;
let failed = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (pass) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

function D(id = "a1", source?: ArtifactSource, over: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  return {
    taskId: "t1",
    kind: "office",
    source:
      source ?? { type: "workspace-file", entryFile: "C:/ws/office/样本.pptx", rootDir: "C:/ws" },
    version: 1,
    capabilities: { originalKind: "pptx" },
    title: "样本",
    createdAt: 1,
    updatedAt: 1,
    ...over,
    id,
  };
}

interface Harness {
  hydration: ReturnType<typeof createRenderHydration>;
  readCalls: Array<{ id: string; version: number }>;
  setRead: (
    fn: (artifactId: string, version: number) => Promise<ArtifactDomainReadContentResponse | null>,
  ) => void;
  getCache: (id: string) => ArtifactRenderPayload | undefined;
  getState: (id: string) => ArtifactRenderLoadState | undefined;
  getError: (id: string) => string | undefined;
  removeDescriptor: (id: string) => void;
  bumpVersion: (id: string, version: number) => void;
  setDescriptor: (id: string, d: ArtifactDescriptor) => void;
}

function makeHarness(): Harness {
  const descriptors = new Map<string, ArtifactDescriptor>();
  let cache: Record<string, ArtifactRenderPayload> = {};
  const loadStates: Record<string, ArtifactRenderLoadState> = {};
  const errors: Record<string, string | undefined> = {};
  const readCalls: Harness["readCalls"] = [];
  let readImpl: (
    id: string,
    version: number,
  ) => Promise<ArtifactDomainReadContentResponse | null> = async (id) => ({
    content: `data:application/test;base64,UEsDB-${id}`,
  });

  const deps: RenderHydrationDeps = {
    findDescriptor: (id) => descriptors.get(id) ?? null,
    getCache: (id) => cache[id],
    setCache: (id, payload) => {
      cache = { ...cache, [id]: payload };
    },
    removeCache: (id) => {
      if (!(id in cache)) return;
      const next = { ...cache };
      delete next[id];
      cache = next;
    },
    setLoadState: (id, state, error) => {
      loadStates[id] = state;
      errors[id] = error;
    },
    clearState: (id) => {
      delete loadStates[id];
      delete errors[id];
    },
    readContent: async (id) => {
      const d = descriptors.get(id);
      readCalls.push({ id, version: d?.version ?? -1 });
      return readImpl(id, d?.version ?? -1);
    },
    log: () => {},
  };

  const hydration = createRenderHydration(deps);
  return {
    hydration,
    readCalls,
    setRead: (fn) => {
      readImpl = fn;
    },
    getCache: (id) => cache[id],
    getState: (id) => loadStates[id],
    getError: (id) => errors[id],
    removeDescriptor: (id) => descriptors.delete(id),
    bumpVersion: (id, version) => {
      const d = descriptors.get(id);
      if (d) descriptors.set(id, { ...d, version });
    },
    setDescriptor: (id, d) => {
      descriptors.set(id, d);
    },
  };
}

async function main(): Promise<void> {
  // H1: cache miss → readContent + cache + ready
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    const r = await h.hydration.ensure("a1");
    check("H1 readContent 调用 1 次", h.readCalls.length === 1, String(h.readCalls.length));
    check("H1 返回 payload", r?.content.startsWith("data:application/test;base64,UEsDB") === true);
    check("H1 cache 已写入且 version 绑定", h.getCache("a1")?.artifactVersion === 1);
    check("H1 loadState ready", h.getState("a1") === "ready");
  }
  // H2: cache hit + version same → 不重复读取
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    await h.hydration.ensure("a1");
    await h.hydration.ensure("a1");
    await h.hydration.ensure("a1");
    check("H2 readContent 仍只 1 次", h.readCalls.length === 1, String(h.readCalls.length));
  }
  // H3: version mismatch → reload
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    await h.hydration.ensure("a1");
    h.bumpVersion("a1", 2);
    const r = await h.hydration.ensure("a1");
    check("H3 重新 readContent", h.readCalls.length === 2, String(h.readCalls.length));
    check(
      "H3 payload 新版本",
      r?.artifactVersion === 2 && h.getCache("a1")?.artifactVersion === 2,
      JSON.stringify(r?.artifactVersion),
    );
  }
  // H4: concurrent → single-flight
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    const all = await Promise.all([
      h.hydration.ensure("a1"),
      h.hydration.ensure("a1"),
      h.hydration.ensure("a1"),
      h.hydration.ensure("a1"),
      h.hydration.ensure("a1"),
    ]);
    check("H4 readContent 只 1 次", h.readCalls.length === 1, String(h.readCalls.length));
    check("H4 全部返回 payload", all.every((x) => x?.artifactVersion === 1));
  }
  // H5: readContent null + 无磁盘路径 → error（不生成伪内容）
  {
    const h = makeHarness();
    h.setDescriptor("a1", D("a1", { type: "managed-content", storagePath: "x", rootDir: "y" }));
    h.setRead(async () => null);
    const r = await h.hydration.ensure("a1");
    check("H5 返回 null", r === null);
    check("H5 loadState error", h.getState("a1") === "error");
    check("H5 cache 未写入", h.getCache("a1") === undefined);
    check("H5 error 有原因", h.getError("a1") !== undefined);
  }
  // H5b: workspace-file 读空仍保留 path（供拖出）
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    h.setRead(async () => null);
    const r = await h.hydration.ensure("a1");
    check("H5b 空文件仍返回 payload", r?.path === "C:/ws/office/样本.pptx");
    check("H5b loadState error", h.getState("a1") === "error");
    check("H5b cache 有 path", h.getCache("a1")?.path === "C:/ws/office/样本.pptx");
  }
  // H6: empty binary 无路径 → error
  {
    const h = makeHarness();
    h.setDescriptor("a1", D("a1", { type: "managed-content", storagePath: "x", rootDir: "y" }));
    h.setRead(async () => ({ content: "" }));
    const r = await h.hydration.ensure("a1");
    check("H6 空内容 → null", r === null);
    check("H6 loadState error", h.getState("a1") === "error");
    check("H6 cache 未写入", h.getCache("a1") === undefined);
  }
  // H7: stale promise → discard + 按新版本重试
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    let release: ((v: ArtifactDomainReadContentResponse | null) => void) | null = null;
    const gate = new Promise<ArtifactDomainReadContentResponse | null>((r) => {
      release = r;
    });
    let call = 0;
    h.setRead(async (_id, version) => {
      call += 1;
      if (call === 1) return gate; // 第一次读取挂起
      return { content: `data:application/test;base64,UEsDB-v${version}` };
    });
    const p = h.hydration.ensure("a1");
    // 读取挂起期间版本移动 1 → 8
    h.bumpVersion("a1", 8);
    release!({ content: "data:application/test;base64,UEsDB-OLD-v1" });
    const r = await p;
    check("H7 stale 结果被丢弃（最终缓存 v8）", h.getCache("a1")?.artifactVersion === 8);
    check("H7 结果含 v8 内容", r?.content.includes("v8") === true);
    check("H7 读取 2 次（v1 丢弃 + v8 重试）", h.readCalls.length === 2, String(h.readCalls.length));
    check("H7 loadState ready", h.getState("a1") === "ready");
  }
  // H8: artifact updated → invalidate（版本移动才失效；同版本保留）
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    await h.hydration.ensure("a1");
    h.hydration.invalidate("a1", 1);
    check("H8 同版本不失效", h.getCache("a1") !== undefined);
    h.hydration.invalidate("a1", 2);
    check("H8 版本移动 → cache 清除", h.getCache("a1") === undefined);
  }
  // H9: artifact removed → clear
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    await h.hydration.ensure("a1");
    h.hydration.clear("a1");
    check("H9 cache 清除", h.getCache("a1") === undefined);
    check("H9 loadState 清除", h.getState("a1") === undefined);
    check("H9 error 清除", h.getError("a1") === undefined);
  }
  // H10: removed during hydration → 不复活
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    let release: ((v: ArtifactDomainReadContentResponse | null) => void) | null = null;
    h.setRead(
      () =>
        new Promise<ArtifactDomainReadContentResponse | null>((r) => {
          release = r;
        }),
    );
    const p = h.hydration.ensure("a1");
    h.removeDescriptor("a1");
    release!({ content: "data:application/test;base64,UEsDB-late" });
    const r = await p;
    check("H10 返回 null", r === null);
    check("H10 cache 未复活", h.getCache("a1") === undefined);
  }
  // H11: workspace-file → payload.path = entryFile
  {
    const h = makeHarness();
    h.setDescriptor("a1", D());
    h.setRead(async () => ({ content: "data:application/test;base64,UEsDB-x", kind: "pptx" }));
    const r = await h.hydration.ensure("a1");
    check("H11 path = entryFile", r?.path === "C:/ws/office/样本.pptx", r?.path ?? "");
    check("H11 kind 细分 originalKind", r?.kind === "pptx");
  }
  // H12: managed-content → payload.path = response.path
  {
    const h = makeHarness();
    h.setDescriptor(
      "a1",
      D("a1", {
        type: "managed-content",
        storagePath: "t/a1/f",
        rootDir: "C:/data/artifacts",
      }, { capabilities: {} }),
    );
    h.setRead(async () => ({
      content: "data:application/test;base64,UEsDB-x",
      path: "C:/data/artifacts/t/a1/f",
    }));
    const r = await h.hydration.ensure("a1");
    check("H12 path = response.path", r?.path === "C:/data/artifacts/t/a1/f", r?.path ?? "");
    check("H12 kind 兜底 docx（无 originalKind）", r?.kind === "docx");
  }

  console.log(`\n结果: ${passed}/${passed + failed} PASS`);
  if (failed > 0) process.exit(1);
}

void main();
