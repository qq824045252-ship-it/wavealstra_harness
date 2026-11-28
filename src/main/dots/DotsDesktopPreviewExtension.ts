import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DOTS_TASK_ID, isDotsAutomaticInput } from "../../shared/dots";
import { DOTS_DESKTOP_PREVIEW } from "../../shared/dots-settings";
import { currentDurableInvocation } from "../agent/durable/DurableExecutionContext";
import { checkCurrentToolInput } from "../agent/durable/DurableToolInputScope";
import type { ArtifactService } from "../artifact/ArtifactService";
import type { VisionCapabilityProvider } from "../capabilities/BuiltinCapabilityRuntime";
import { visionAwareImageResult } from "../capabilities/builtin-capability-extension";
import { MediaArtifactMaterializer } from "../capabilities/MediaArtifactMaterializer";
import type { DotsDesktopPreview } from "./DotsDesktopPreview";

const declined = [
  /(?:只|仅)(?:做|在(?:当前|本)对话里?)?(?:讨论|聊)|(?:进入?|切到|切回|改为)讨论/u,
  /(?:别|不要|不用|无需|不必|不需要|暂不|先不|禁止)\s*(?:实际)?(?:打开|启动|运行|预览|操作|截图|开窗口)/u,
  /\b(?:(?:do not|don't)\s+(?:open|launch|run|preview)|discussion only|just explain)\b/iu,
];
const previewTarget = "(?:MyBuddy|Dots|worktree|工作树|分支|界面|窗口|预览|新版|集成版)";
const previewAction = "(?:打开|启动|运行|跑|预览|看(?:看|下|一眼))";
const requestPrefix = "^(?:(?:你|请|麻烦|直接|现在|再|先|帮我|给我|自己|亲自)[\\s,，]*)*";
const requestBody = [
  `${previewAction}.{0,36}${previewTarget}`,
  `(?:把|从|用|在).{0,36}${previewTarget}.{0,20}${previewAction}`,
  "看(?:看|下|一眼).{0,12}(?:你改的|改动效果)",
].join("|");
const requested = new RegExp(`${requestPrefix}(?:${requestBody})`, "iu");
const englishRequest = /^(?:please\s+)?(?:open|launch|start|run|preview)\b.{0,45}\b(?:worktree|MyBuddy|Dots|preview|branch)\b/iu;
const inquiry = /(?:是什么意思|意味着什么|会发生什么|怎么做|有什么影响|如何操作|how (?:do|would|should) I|what happens if)/iu;

function previewDecision(text: string): "open" | "decline" | undefined {
  const clauses = text.normalize("NFKC").replace(/“[^”]*”|「[^」]*」|`[^`]*`|"[^"]*"/gu, "").split(/[。;；!！?？\n]/u);
  if (clauses.some(clause => declined.some(rule => rule.test(clause)))) return "decline";
  if (clauses.some(clause => !inquiry.test(clause) && (requested.test(clause.trim()) || englishRequest.test(clause.trim())))) return "open";
}

interface PreviewOptions {
  preview: DotsDesktopPreview;
  enabled: () => boolean;
  workspace: (spaceId: string) => string | Promise<string>;
  artifactService: () => ArtifactService | null;
  vision: () => VisionCapabilityProvider | null;
}

export function dotsDesktopPreviewExtension(options: PreviewOptions): ExtensionFactory {
  const materializer = new MediaArtifactMaterializer(options.artifactService);
  return pi => pi.registerTool({
    name: DOTS_DESKTOP_PREVIEW,
    label: "核对桌面预览",
    description: "用户本轮要求打开或亲自查看 MyBuddy 新版时，从已授权、已绑定的 spaceId 打开已有 Git 工作树的隔离桌面预览。worktree 只接受 Git 已登记的分支名或路径。返回实际版本和 Dots 窗口截图。先从原任务或当前对话确认目标，无需建任务。用户只讨论、只问进度或拒绝打开时不要调用。",
    parameters: Type.Object({
      spaceId: Type.String({ minLength: 1, maxLength: 200 }),
      worktree: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    }, { additionalProperties: false }),
    execute: async (toolCallId, input, signal, _onUpdate, ctx) => {
      const invocation = currentDurableInvocation();
      const decisions = invocation?.foregroundInputs?.flatMap(item => {
        const decision = previewDecision(item.text);
        return decision && !isDotsAutomaticInput(item.id) ? [decision] : [];
      });
      if (invocation?.execution.taskId !== DOTS_TASK_ID || decisions?.at(-1) !== "open") {
        throw new Error("本轮没有打开或查看桌面预览的用户指令。");
      }
      if (!options.enabled()) throw new Error("Dots 设置已关闭「桌面预览」。");
      const workspaceRoot = await options.workspace(input.spaceId);
      const check = async () => {
        signal?.throwIfAborted();
        await checkCurrentToolInput();
        if (!options.enabled() || await options.workspace(input.spaceId) !== workspaceRoot) {
          throw new Error("桌面预览的工作空间或授权已变更。");
        }
      };
      const { screenshot, ...receipt } = await options.preview.open({ workspaceRoot, worktree: input.worktree, beforeLaunch: check }, signal);
      await check();
      const context = { taskId: DOTS_TASK_ID, taskRoot: invocation.cwd, toolCallId,
        producerMessageId: invocation.execution.assistantMessageId, signal };
      const saved = await materializer.materialize("image", {
        provider: "mybuddy-desktop-preview",
        items: [{ bytes: screenshot, mimeType: "image/png", fileName: `dots-preview-${receipt.commit.slice(0, 8)}.png` }],
      }, context, "Dots 桌面预览");
      return visionAwareImageResult({
        summary: "已打开指定工作树的隔离 MyBuddy 预览，并截取实际 Dots 窗口。",
        details: { ...receipt, imagePaths: saved.paths, artifactId: saved.artifacts[0]?.id },
        images: [{ path: saved.paths[0], bytes: screenshot, mimeType: "image/png" }],
        model: ctx.model, vision: options.vision(), context,
        prompt: "读取 MyBuddy Dots 预览截图，描述画面中与本轮验收直接相关的内容。仅依据可见画面。",
      });
    },
  });
}
