/**
 * 产物黑白名单「显示过滤」集成测试（V3.6）
 *
 * 验证产品行为（renderer appStore 真实 selector + projection + 策略缓存）：
 *   A. 产物面板 / 消息芯片（selectVisibleActiveTaskArtifacts）按模式黑白名单过滤：
 *      deny 命中隐藏 / allow 非空未命中隐藏 / 无扩展名（canvas 类）白名单下隐藏
 *   B. 变更显示数据源（selectActiveTaskArtifacts 全量）不受过滤影响
 *   C. 策略未缓存 / 黑白名单为空 → 不过滤（显示全部）
 *   D. 多任务多模式：各自按自己任务的 mode 策略过滤（FilesPage 语义）
 *
 * 运行：pnpm test:artifact-policy-display（纯 node）
 */
import { useAppStore, selectActiveTaskArtifacts, selectVisibleActiveTaskArtifacts } from "../src/renderer/src/store/appStore";
import { fileBadgeExt } from "../src/renderer/src/components/common/FileBadge";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
import type { ModeArtifactPolicy } from "../src/shared/mode-profile";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const TASK_A = "task-office";
const TASK_B = "task-coding";

function makeDescriptor(id: string, entryFile: string | null, taskId = TASK_A): ArtifactDescriptor {
  return {
    id,
    taskId,
    kind: entryFile?.endsWith(".py") ? "code" : entryFile?.endsWith(".md") ? "markdown" : "html",
    source: entryFile
      ? { type: "workspace-file", entryFile, rootDir: "C:/ws" }
      : { type: "managed-content", storagePath: `${taskId}/${id}/index.html`, rootDir: "C:/storage" },
    version: 1,
    capabilities: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 办公任务：report.py（deny 命中）+ report.md（正常）+ canvas（managed-content 无扩展名） */
const OFFICE_DESCRIPTORS = [
  makeDescriptor("art-py", "C:/ws/report.py"),
  makeDescriptor("art-md", "C:/ws/report.md"),
  makeDescriptor("art-canvas", null),
];
/** 编码任务：全量放行 */
const CODING_DESCRIPTORS = [
  makeDescriptor("art-ts", "C:/ws/app.ts", TASK_B),
  makeDescriptor("art-readme", "C:/ws/README.md", TASK_B),
];

const OFFICE_POLICY: ModeArtifactPolicy = { mode: "hard", allow: [], deny: ["py", "ts"] };

function resetStore(): void {
  useAppStore.setState({
    activeTaskId: TASK_A,
    tasks: [
      {
        id: TASK_A,
        title: "办公任务",
        welcomeMode: "working",
        messages: [],
        updatedAt: 1,
      } as never,
      {
        id: TASK_B,
        title: "编码任务",
        welcomeMode: "coding",
        messages: [],
        updatedAt: 1,
      } as never,
    ],
    artifactProjection: {
      artifactsByTask: { [TASK_A]: OFFICE_DESCRIPTORS, [TASK_B]: CODING_DESCRIPTORS },
      artifactRevisions: { [TASK_A]: 1, [TASK_B]: 1 },
      artifactLoadState: { [TASK_A]: "ready", [TASK_B]: "ready" },
    },
    artifactPolicies: { working: OFFICE_POLICY },
    artifactRenderCache: {},
  });
}

function names(list: Array<{ id: string }>): string {
  return list.map((a) => a.id).join(",");
}

async function main(): Promise<void> {
  // A1：deny 命中隐藏（面板过滤版）；全量不变（变更显示）
  resetStore();
  const visibleA = selectVisibleActiveTaskArtifacts(useAppStore.getState());
  const fullA = selectActiveTaskArtifacts(useAppStore.getState());
  check(
    "A1 面板过滤: deny py → report.py 隐藏，md/canvas 保留",
    names(visibleA) === "art-md,art-canvas",
    names(visibleA),
  );
  check(
    "A1 变更显示: 全量仍含 report.py",
    names(fullA) === "art-py,art-md,art-canvas",
    names(fullA),
  );

  // A2：allow 白名单（仅 md/docx）→ md 可见；py 与无扩展名 canvas 都隐藏
  useAppStore.setState({
    artifactPolicies: {
      working: { mode: "hard", allow: ["md", "docx"], deny: [] },
    },
  });
  const visibleA2 = selectVisibleActiveTaskArtifacts(useAppStore.getState());
  const fullA2 = selectActiveTaskArtifacts(useAppStore.getState());
  check(
    "A2 面板过滤: allow [md,docx] → 仅 report.md 可见",
    names(visibleA2) === "art-md",
    names(visibleA2),
  );
  check(
    "A2 变更显示: 全量 3 个不受白名单影响",
    names(fullA2) === "art-py,art-md,art-canvas",
    names(fullA2),
  );

  // A3：策略未缓存（如首次进入还没拉到 policy）→ 扩展名不过滤，仍隐藏 CAD 临时脚本
  useAppStore.setState({ artifactPolicies: {} });
  const visibleA3 = selectVisibleActiveTaskArtifacts(useAppStore.getState());
  check(
    "A3 未缓存 policy → 扩展名不过滤（显示全部业务产物）",
    names(visibleA3) === "art-py,art-md,art-canvas",
    names(visibleA3),
  );

  // A4：黑白名单皆空 → 不过滤
  useAppStore.setState({
    artifactPolicies: { working: { mode: "hard", allow: [], deny: [] } },
  });
  const visibleA4 = selectVisibleActiveTaskArtifacts(useAppStore.getState());
  check("A4 黑白名单空 → 不过滤", names(visibleA4) === "art-py,art-md,art-canvas", names(visibleA4));

  // A5：FreeCAD MCP 临时脚本即使黑白名单皆空也不进产物面板 / 芯片
  useAppStore.setState({
    artifactProjection: {
      artifactsByTask: {
        [TASK_A]: [
          ...OFFICE_DESCRIPTORS,
          makeDescriptor("art-fc-py", "C:/ws/fc_mswgcza1.py"),
          makeDescriptor("art-fc-json", "C:/ws/fc_mswgcza1.args.json"),
          makeDescriptor("art-cad", "C:/ws/lego_car.fcstd"),
        ],
        [TASK_B]: CODING_DESCRIPTORS,
      },
      artifactRevisions: { [TASK_A]: 2, [TASK_B]: 1 },
      artifactLoadState: { [TASK_A]: "ready", [TASK_B]: "ready" },
    },
  });
  const visibleA5 = selectVisibleActiveTaskArtifacts(useAppStore.getState());
  const fullA5 = selectActiveTaskArtifacts(useAppStore.getState());
  check(
    "A5 面板/芯片: fc_*.py / fc_*.args.json 隐藏，CAD 成品保留",
    names(visibleA5) === "art-py,art-md,art-canvas,art-cad",
    names(visibleA5),
  );
  check(
    "A5 变更显示: 全量仍含 FreeCAD 临时脚本",
    names(fullA5) === "art-py,art-md,art-canvas,art-fc-py,art-fc-json,art-cad",
    names(fullA5),
  );
  // 恢复 A 组描述符，避免影响后续多任务用例
  useAppStore.setState({
    artifactProjection: {
      artifactsByTask: { [TASK_A]: OFFICE_DESCRIPTORS, [TASK_B]: CODING_DESCRIPTORS },
      artifactRevisions: { [TASK_A]: 1, [TASK_B]: 1 },
      artifactLoadState: { [TASK_A]: "ready", [TASK_B]: "ready" },
    },
  });

  // A6：PPTD 多文件项目只展示 manifest / PPTX / 项目外来源图；pages/media/QA 中间文件聚合隐藏
  useAppStore.setState({
    activeTaskId: TASK_A,
    artifactPolicies: { working: { mode: "hard", allow: [], deny: [] } },
    artifactProjection: {
      artifactsByTask: {
        [TASK_A]: [
          makeDescriptor("art-pptd", "C:/ws/deck/deck.pptd"),
          makeDescriptor("art-page", "C:/ws/deck/pages/001.page"),
          makeDescriptor("art-media", "C:/ws/deck/media/hero.png"),
          makeDescriptor("art-qa", "C:/ws/deck/.qa-images/overview.jpg"),
          makeDescriptor("art-generated", "C:/ws/generated/image/hero.png"),
          makeDescriptor("art-pptx", "C:/ws/deck/deck.pptx"),
        ],
        [TASK_B]: CODING_DESCRIPTORS,
      },
      artifactRevisions: { [TASK_A]: 3, [TASK_B]: 1 },
      artifactLoadState: { [TASK_A]: "ready", [TASK_B]: "ready" },
    },
  });
  const visibleA6 = selectVisibleActiveTaskArtifacts(useAppStore.getState());
  const fullA6 = selectActiveTaskArtifacts(useAppStore.getState());
  check(
    "A6 PPTD 聚合: pages/media/QA 隐藏，manifest/PPTX/来源图保留",
    names(visibleA6) === "art-pptd,art-generated,art-pptx",
    names(visibleA6),
  );
  check("A6 变更显示仍保留 PPTD 内部文件", fullA6.length === 6, names(fullA6));
  useAppStore.setState({
    artifactProjection: {
      artifactsByTask: { [TASK_A]: OFFICE_DESCRIPTORS, [TASK_B]: CODING_DESCRIPTORS },
      artifactRevisions: { [TASK_A]: 1, [TASK_B]: 1 },
      artifactLoadState: { [TASK_A]: "ready", [TASK_B]: "ready" },
    },
  });

  // B1：切换 activeTask 到 coding（无 policy 缓存）→ 全量
  useAppStore.setState({
    activeTaskId: TASK_B,
    artifactPolicies: { working: OFFICE_POLICY },
  });
  const visibleB = selectVisibleActiveTaskArtifacts(useAppStore.getState());
  check("B1 coding 任务（无缓存）→ 不过滤", names(visibleB) === "art-ts,art-readme", names(visibleB));

  // B2：coding 也配了 deny ts → 按自己任务的 mode 过滤（FilesPage 每任务独立策略）
  useAppStore.setState({
    artifactPolicies: { working: OFFICE_POLICY, coding: { mode: "hard", allow: [], deny: ["ts"] } },
  });
  const visibleB2 = selectVisibleActiveTaskArtifacts(useAppStore.getState());
  check(
    "B2 coding 任务 deny ts → app.ts 隐藏、README 保留",
    names(visibleB2) === "art-readme",
    names(visibleB2),
  );

  // B3：回切办公任务 → 按 working 策略过滤
  useAppStore.setState({ activeTaskId: TASK_A });
  const visibleB3 = selectVisibleActiveTaskArtifacts(useAppStore.getState());
  check(
    "B3 切回办公任务 → 按 working 策略过滤",
    names(visibleB3) === "art-md,art-canvas",
    names(visibleB3),
  );

  check("I1 CAD 成品扩展名 → fcstd/step/stl", fileBadgeExt("lego_car.fcstd") === "fcstd" && fileBadgeExt("lego_car.step") === "step" && fileBadgeExt("lego_car.stl") === "stl");
  check("I2 普通脚本仍按末段扩展名", fileBadgeExt("model.py") === "py" && fileBadgeExt("data.json") === "json");

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n[artifact-policy-display-test] ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

void main();
