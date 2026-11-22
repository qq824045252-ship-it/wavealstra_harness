import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { boardViews } from "../../shared/task-board";
import { dotsOperationEnabled, dotsOperations, type DotsSettings } from "../../shared/dots-settings";
import { Type } from "typebox";
import { currentDurableInvocation } from "../agent/durable/DurableExecutionContext";
import { checkCurrentToolInput } from "../agent/durable/DurableToolInputScope";
import { DotsForegroundUnavailable } from "./DotsForegroundReads";
import type { DotsActions, DotsActionInput } from "./DotsActions";

export const DOTS_ACTION = "dots_action";
export const DOTS_MEMORY_READ_TOOLS: ReadonlySet<string> = new Set(["memory_search", "memory_get", "memory_history"]);
export const DOTS_MEMORY_TOOLS: ReadonlySet<string> = new Set([...DOTS_MEMORY_READ_TOOLS, "memory_create", "memory_update", "memory_promote", "memory_forget"]);
export const dotsInstructions = [
  "你是 MyBuddy Dots，在本对话回答问题、查看看板与工作空间、查找和控制普通任务。通过 dots_action 读取实际状态；任务或空间不明确时先查找，必要时问一个具体问题。独立交办使用 delegate 并指定空间，改向使用 steer 和原任务 ID。耗时执行与文件制作委派给普通任务。前台读取须遵循本轮范围；资料和文件工具的 allowHandoff 只在用户允许相关普通任务接续且明确工作空间时填 true。",
  "回答旧事时核对对象、角色、时间和事件。证据不足时先用 memory_search 按主体或事件分别找，用 memory_get 查看原文。把同一事件的重复转述算一次，依据各自的发生时间比较、合计。仍然缺少依据时，指出缺哪条信息。",
  "给建议时，把已经确认的用户偏好、设备或限制用进具体建议。用户无需事先表达过这条建议；只把原文确实支持的内容说成用户的经历或选择。",
  "用户交代的长期偏好直接写入统一记忆。只适用于本次的要求当场执行。用 applicability 声明每条记忆的适用范围并逐字引用原话：project/workspace 提供用户指名的名称，有查明的 ID 时一起提供；无法确认时用 unresolved；只有用户明确改变通用默认规则时才用 general。存在默认规则的项目例外用 memory_update 引用默认记录 ID 和本条原话。多主题分别取各自证据。显式修改回答匹配与行为时才用 answer_rule 工具。",
  "场景摘要和个人画像来自长期记忆的原话与版本。需要引用时核对 L1 原话。转述、推测和旧决定只用于说明来源，不能当成已经确认的当前事实。",
  "委派时只传对应任务所需的资料。用户明确指定本任务交付内容、格式、语言或篇幅时，必须用 deliveryInstruction 逐字摘录该要求。text 写执行目标与约束；不要替用户改写交付要求或把中间结果当作交付项。",
  "需要已有记忆时以 memoryRefs 传双方可见的来源 ID 和当前 revision，勿将记忆正文复制进委派指令。",
  "用户约定的定时跟进可用 automation_exec，目标为当前 Dots 对话。",
  "直接答复，委派成功时用一句话和原任务链接。",
  "交办时只查定位原任务和空间所需的信息。普通任务接单后给用户链接并结束本轮，由后台回传。用户一条消息中有多个独立事项要分别派工时，从第一次委派起每项带上互不重叠的 assignmentQuote 原文。一次交办的改写或重试仍属原事项。",
  "时间范围以用户发消息时的本地日历为准。查到对应期间的已有成果时，沿用用户指定的期间，不推到下一期。",
  "文件随任务自动显示，省去评语、复核和二次总结。",
].join("\n");

const controls = ["pause", "stop", "pause_all", "stop_all", "file_watches", "cancel_watch", "pause_proactive"] as const;
const configuredActions = ["board", "task", "spaces", "deliveries", "materials", "read_material", "files", "read_file",
  "bind", "create_space", "rename", "delegate", "steer", "resume", "answer", "watch_file", "resume_proactive"] as const satisfies readonly (keyof typeof dotsOperations)[];

function actionAllowed(action: DotsActionInput["action"], settings: Partial<DotsSettings> | undefined): boolean {
  return controls.some(key => key === action) || configuredActions.some(key => key === action) && dotsOperationEnabled(settings, action);
}

export function dotsAvailableActions(settings: Partial<DotsSettings> | undefined): DotsActionInput["action"][] {
  return [...configuredActions, ...controls].filter(action => actionAllowed(action, settings));
}

export function dotsExtension(actions: DotsActions, settings: () => Partial<DotsSettings> | undefined): ExtensionFactory {
  return pi => pi.registerTool({
    name: DOTS_ACTION, label: "Dots · 看板、空间与任务",
description: "materials 在指定 spaceId 或 targetTaskId 范围搜索资料；read_material 按 itemId 读取，可传 version 读已列出的旧版本。board 按 query 标题、spaceId 检索，task 读 targetTaskId 的进度、已有 Goal 和成果。spaces 列举空间，files 每页列出指定空间或其相对子目录的 100 个条目，传 nextOffset 作为 offset 翻页；read_file 读相对路径文本。资料、目录和文件读取时，每次用 allowHandoff 明确告诉宿主达到本轮上限后是否可自动移交，并传入已授权的 spaceId。用户明确允许自动移交时用 true，禁止或不清楚时用 false。bind 绑定绝对目录，可用 spaceId 或 name 新建空间；create_space 在已绑定的父 spaceId 下创建名为 name 的实际子文件夹和空间，随后可在返回的空间里委派任务；rename 保留原空间身份。用户明确交代按顺序做多件事时可用 steps 固定各步；只给目标时直接传完整目标和限制。delegate 在指定空间新建普通任务或接续 targetTaskId；steer 将 text 发给正在执行的原任务，pause/stop 停止本轮，resume 在原任务接续。deliveries 按标题、文字或文件名查找本地普通任务已有成果，包括用户自行建立的任务。结果给出原任务及登记文件链接；有 nextOffset 时保留 cursor 并传 offset，否则把 next 作为 cursor 从 offset 0 继续。answer 传原委派 operationId、目标任务和 interactionId；系统原样转发本轮用户输入，选择或确认题需要用户明确给出选项。watch_file 订阅原任务空间里的单个相对文件路径，传 text 指定变化后要办的事；文件新增、元数据变化或删除一次触发后结束。file_watches 查看，cancel_watch 传原任务与 watchId 取消。pause_all/stop_all 仅控制 Dots 已关联的活动事项，可指定 spaceId；不指定空间时一起暂停或取消 Dots 自有计划。pause_proactive/resume_proactive 暂停或恢复主动跟进，保留正在运行的普通任务。goalId 可将本次委派关联到指定原任务已有 Goal。用户对这一个任务明确约定交付格式、语言或篇幅时，把对应原文摘录放入 deliveryInstruction，即使 text 已提及也要填。不要引用其他交办或只让 Dots 知道的内容。仅当用户明确表示由自己验收时，使用 goalUserAcceptanceQuote 原样引用这一约定。",
    parameters: Type.Object({
      allowHandoff: Type.Optional(Type.Boolean({description:"读取上限时可否用同一事项自动交给已指定空间内的普通任务。按原始输入及最新修订判断；用户禁止委派、只要求当前对话处理或授权不明确时用 false。"})),
      assignmentQuote: Type.Optional(Type.String({minLength:1,maxLength:500})),
      previousAssignmentQuote: Type.Optional(Type.String({minLength:1,maxLength:500,description:"首项未引用原文时，用此字段补上首项原文，并用 assignmentQuote 引用本次独立事项"})),
      action: Type.Union(dotsAvailableActions(settings()).map(action => Type.Literal(action))), targetTaskId: Type.Optional(Type.String()),
      steps:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:400}),{minItems:2,maxItems:8})),
      memoryRefs: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 160 }), revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), { maxItems: 8 })),
      goalUserAcceptanceQuote: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      deliveryInstruction: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      goalId: Type.Optional(Type.String()), watchId: Type.Optional(Type.String()), operationId: Type.Optional(Type.String()), interactionId: Type.Optional(Type.String()),
      spaceId: Type.Optional(Type.String()), name: Type.Optional(Type.String()), path: Type.Optional(Type.String()),
      itemId: Type.Optional(Type.String({ minLength: 1 })), version: Type.Optional(Type.Integer({ minimum: 1 })),
      query: Type.Optional(Type.String({ maxLength: 500 })), view: Type.Optional(Type.Union(boardViews.filter(v => v !== "automation").map(v => Type.Literal(v)))),
      from: Type.Optional(Type.Integer()), until: Type.Optional(Type.Integer()),
      dateKind: Type.Optional(Type.Union((["follow", "result", "due", "updated"] as const).map(k => Type.Literal(k)))),
      cursor: Type.Optional(Type.Object({ rank: Type.Integer(), at: Type.Integer(), id: Type.String() })),
      text: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }, { additionalProperties: false }),
    execute: async (_id, input: DotsActionInput) => {
      const invocation = currentDurableInvocation();
      if (!invocation) throw new Error("缺少原生工具调用身份");
      const reading = ["files", "materials", "read_file", "read_material"].includes(input.action);
      const toolResult = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
      if (reading) {
        try {
          const result = await actions.executeForegroundRead(input, invocation.foregroundInputs ?? [],
            invocation.presentationConversationId ?? invocation.native.conversationId, invocation.execution.executionId,
            () => actionAllowed("delegate", settings()), () => actionAllowed(input.action, settings()),
            async () => { invocation.context.abortSignal?.throwIfAborted(); await checkCurrentToolInput(); });
          invocation.terminateForeground = result.terminate;
          return toolResult(result.details);
        } catch (error) {
          if (!(error instanceof DotsForegroundUnavailable)) throw error;
          invocation.context.abortSignal?.throwIfAborted();
          invocation.terminateForeground = true;
          return toolResult({ foreground: "blocked", message: error.message });
        }
      }
      if (!actionAllowed(input.action, settings())) {
        const op = configuredActions.find(key => key === input.action);
        throw new Error(op ? `Dots 设置已关闭「${dotsOperations[op][1]}」` : "Dots 操作不可用");
      }
      const details = await actions.execute(invocation.execution.taskId, invocation.sourceUserMessageId, input, invocation.sourceDisplayText, invocation.sourceOrigin, invocation.sourceCreatedAt);
      return toolResult(details);
    },
  });
}
