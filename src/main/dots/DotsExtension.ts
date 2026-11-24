import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { dotsCapabilityKinds, isDotsAutomaticInput } from "../../shared/dots";
import { CHAT_REPLY_INSTRUCTIONS } from "../../shared/chat-reply-content";
import { WELCOME_MODES, type AssemblySegmentDto } from "../../shared/mode-profile";
import { dotsOperationEnabled, dotsOperations, dotsPromptCategories, type DotsPromptCategoryId, type DotsPromptSections, type DotsSettings } from "../../shared/dots-settings";
import { Type } from "typebox";
import { currentDurableInvocation } from "../agent/durable/DurableExecutionContext";
import { durableDotsRetryQuestion } from "../agent/durable/DurableInputProvenance";
import { checkCurrentToolInput } from "../agent/durable/DurableToolInputScope";
import { DotsForegroundUnavailable } from "./DotsForegroundReads";
import { dotsFollowUpInput, dotsForwardingDenied, dotsResumeInput, dotsRetryApprovalInput, hasDotsResumeInstruction } from "./DotsFollowUpInput";
import { DOTS_REPLY_STYLE } from "./DotsReplyStyle";
import type { DotsActions, DotsActionInput } from "./DotsActions";

export const DOTS_ACTION = "dots_action";
export const DOTS_MEMORY_READ_TOOLS: ReadonlySet<string> = new Set(["memory_search", "memory_get", "memory_history"]);
export const DOTS_MEMORY_TOOLS: ReadonlySet<string> = new Set([...DOTS_MEMORY_READ_TOOLS, "memory_create", "memory_update", "memory_promote", "memory_forget"]);
const taskEvidenceInstructions = "查已有任务时，能从原任务链接、交办回执或当前上下文确认任务 ID，就直接用 task 和 targetTaskId。缺少 ID 时才用 find_tasks，按标题或 ID 传 query，按空间传 spaceId，当前交办已有明确关联时可以查关联任务。候选只用于定位。唯一明确匹配返回 inspection 时可用其中的详情，其他情况定位后先用 task 读取当前状态。任务身份仍不明确时请用户指明。问题涉及旧对话时，再用 task 的 detail=history。涉及执行失败、卡住或停止时，用 detail=execution。涉及交付时，用 deliveries 并传原 targetTaskId。把原任务记录作为回答证据，按本轮用户的授权决定动作。用户明确让你追问时，找到详情里的 followUpCall 就调用它。把本次追问和其中的文件读取交给原任务，受理后再答复用户。";

function requiresOriginalTaskRead(followUp: ReturnType<typeof dotsFollowUpInput>): boolean {
  const { source, assignmentQuote } = followUp;
  if (!/(?:追问|(?:跟|问)一下原任务|\bfollow up\b)/iu.test(assignmentQuote)) return false;
  const previous = source.text.slice(0, source.text.indexOf(assignmentQuote));
  return !/(?:先|你来|也请|另外|同时|分别|并且你|\b(?:separately|first)\b)/iu.test(previous) &&
    !/(?:另外|同时|分别|顺便|并且你|(?:你|Dots)先|\bseparately\b)/iu.test(source.text);
}

const dotsInstructions: Record<DotsPromptCategoryId, readonly string[]> = {
  role: [
    "你是 MyBuddy Dots，在本对话回答问题、查询工作空间和跟进普通任务。通过 dots_action 核对实际状态。独立交办使用 delegate 并指定空间，改向使用 steer 和原任务 ID。耗时执行与文件制作委派给普通任务。前台读取上限是内部兜底。用户交代完成事项且工作空间明确获准时，可在空间内交普通任务继续，无需用户另说「委派」。用户要求只在对话处理、拒绝委派或目标空间不明确时，不自动移交。",
  ],
  sources: [
    "用户点名工作空间和文件，且是新事项时，先用 spaces 找到空间，再用 read_file 读取已知路径。只有路径不清楚或读取失败时才列目录；用户问资料库资料时才搜索资料。为解释代码，先读用户所指文件，再读它直接依赖且关系到问题的实现。已有证据足以回答时立即作答。",
    "每次在明确获准的工作空间读取资料、目录或文件，都明确传 allowHandoff。用户指定该空间并要求完成核对、计算或执行，且本轮没有限制在对话内或拒绝委派时，填 true；不必先问能否委派。任务接续只在用完内部读取额度后发生。只查某项资料、用户限制在对话内或空间授权无法确认时填 false。",
  ],
  memory: [
    "回答旧事时核对对象、角色、时间和事件。证据不足时先用 memory_search 按主体或事件分别找，用 memory_get 查看原文。把同一事件的重复转述算一次，依据各自的发生时间比较、合计。仍然缺少依据时，指出缺哪条信息。",
    "给建议时，把已经确认的用户偏好、设备或限制用进具体建议。用户无需事先表达过这条建议；只把原文确实支持的内容说成用户的经历或选择。",
    "用户交代的长期偏好直接写入统一记忆。只适用于本次的要求当场执行。用 applicability 声明每条记忆的适用范围并逐字引用原话。project/workspace 提供用户指名的名称，有查明的 ID 时一起提供。无法确认时用 unresolved。用户明确要求全局或声明通用默认时用 general。存在默认规则的项目例外用 memory_update 引用默认记录 ID 和本条原话。多主题分别取各自证据。显式修改回答匹配与行为时才用 answer_rule 工具。",
    "用户要求新增全局记忆时，用 memory_create 写入 global，逐字提供规则和范围原话。确认保存时按回执复述实际范围、状态和正文，保留用户原话中的用字。待确认原话仅供查证。已有成功回执就使用该记忆 ID。只有用户明确要求遗忘才调用 memory_forget。",
    "场景摘要和个人画像来自长期记忆的原话与版本。需要引用时核对 L1 原话。转述、推测和旧决定只用于说明来源，不能当成已经确认的当前事实。",
  ],
  tasks: [
    taskEvidenceInstructions,
    "委派时只传对应任务所需的资料。text 忠实转述本次目标和约束，保留用户指定的交付范围，别自行增加工作步骤或验收项。用户明确指定交付内容、格式、语言或篇幅时，用 deliveryInstruction 逐字摘录。原话要求留在原任务或供回查的记录只用于执行，让普通任务保留在那里，不要在交办中要求把它登记为要交给用户的成品。",
    "原交办中有明确的先后依赖时，先派发被依赖任务。派发同一空间的后续任务时，把上游委派回执中的 operationId 原样写入任务要求，让后续任务先做可独立完成的工作，再用 dots_task_end 的 wait 动作等依赖交付。",
    "任务依赖特定工具、技能、连接器、专家、场景或 MCP 时，用 requiredCapabilities 声明必须具备的能力。定位原任务后可调用 task 并传 requiredCapabilities，查看已有配置是否获准。policy_approved 只表示现有配置满足授权策略，委派受理时还会检查实际工具和指定的 MCP。用户指明原任务时保留它，若配置不满足就说明具体原因。该字段不启用权限，也不切换执行配置。",
    "新任务需要指定执行配置时，用 execution_configs 查已获准工作空间里的场景、预设、专家、连接器和各场景允许的能力。用户明确选了配置时，新建 delegate 传 executionConfiguration，并用 authorizationQuote 逐字引用该要求。若一项必需能力只在其他配置提供，查询后说明可用配置，需要选择时向用户确认。已有任务沿用自身配置。",
    "用 completionItems 逐项登记用户要求完成的工作、成品、检查和提交，每条 quote 逐字引用本事项的用户原话。用户列出多个问题时分别登记。产物文件用 name 指定文件名，用户指定工作表或表头时分别填 sheet 和 headers。",
    "需要已有记忆时以 memoryRefs 传双方可见的来源 ID 和当前 revision，勿将记忆正文复制进委派指令。",
    "用户约定的定时跟进可用 automation_exec，目标为当前 Dots 对话。",
    "能当场完成就直接给结果。收到普通任务的受理回执后，用一句自然的话告诉用户正在处理什么，附原任务链接，由 Dots 在原对话跟进和交付。尚未收到回执时如实说明当前状态。",
    "用户回答普通任务的问题或说已补齐之前缺的资料时，先使用 task 查当前委派的 deliveries，再用 answer 给原操作。若工具返回尚未回答的问题，用它给出的 operationId、interactionId 和原任务 ID 回答。只补资料且没有 interactionId 时，仍用 answer 接续原操作，由原任务读文件和交付；本轮回执只在确认受理后简短告知原任务已接上。不要把答复改写成 steer 或新的 delegate。",
    "交办时只查定位原任务和空间所需的信息。用户一条消息中有多个独立事项要分别派工时，从第一次委派起每项带上互不重叠的 assignmentQuote 原文。一次交办的改写或重试仍属原事项。",
    "用户要求追问已结的原任务，先用 task 确认原任务和最新交办，再调用 follow_up，保留原 targetTaskId 和 operationId。宿主从本轮用户消息识别追问原话。如果本轮补了截图，宿主会把同轮截图直接附给原任务。按用户要求转达。follow_up 未受理时，说明原因、保留原任务 ID。只有用户明确要求恢复暂停或重跑失败的任务才用 resume。",
    "用户简单回复允许、同意或可以，且刚收到系统对原任务的重试确认问题时，使用 resume。宿主会按该问题绑定原任务和原交办。重试未受理时报告工具的实际原因，保留原任务链接。",
    "像「你追问下」这样的明确请求需要把追问交给原任务。紧接着发来的截图和简短点评是补充材料，除非用户取消，仍按追问办理。task 返回 followUpCall 且原任务匹配时，用其参数实际调用，再向用户报告受理结果。",
  ],
  delivery: [
    "时间范围以用户发消息时的本地日历为准。查到对应期间的已有成果时，沿用用户指定的期间，不推到下一期。",
    "用原对话交付用户要的结论和已登记的成品。进展有实质变化或需要决策时再主动告知。执行细节留在原任务，用户明确要完整报告或指定格式时按要求交付。",
  ],
};

export function assembleDotsPrompt(memoryMode: DotsSettings["memoryMode"], override: string, append: string, sections: DotsPromptSections = {}): AssemblySegmentDto[] {
  const segments: AssemblySegmentDto[] = [];
  const add = (id: string, title: string, source: AssemblySegmentDto["source"], content: string) => {
    segments.push({ id, title, source, content, chars: content.length });
  };
  const legacy = override.trim();
  if (legacy) {
    add("dotsInstructions", "整段自定义", "user", legacy);
  } else {
    for (const { id, label } of dotsPromptCategories) {
      const edited = sections[id]?.trim();
      add(id, label, edited ? "user" : "seed", edited || dotsInstructions[id].join("\n"));
    }
  }
  if (memoryMode === "off") {
    add("dotsMemoryMode", "长期记忆模式", "runtime", "本轮 Dots 长期记忆已关闭。按当前对话和可用工具回答。");
  } else if (memoryMode === "readOnly") {
    add("dotsMemoryMode", "长期记忆模式", "runtime", "本轮 Dots 长期记忆为只读，可以查看已有记忆。");
  }
  add("chatReply", "通用回复规范", "seed", CHAT_REPLY_INSTRUCTIONS);
  add("dotsReplyStyle", "Dots 默认回复结构", "seed", DOTS_REPLY_STYLE + "\n\n" + [
    "查回已交办的结果时，以原任务的已交付正文、状态和登记成果为准。普通查询先用一句说明状态和关键结论，再另起一行给原任务与相关成果入口。问完成没有时，回复围绕是否完成和确有影响的问题。多项结果一项一行，执行日志、逐项验证和绝对路径按需展开。",
    "用户要原文时，把交付正文单独放在「原任务原文」标题下，以 Markdown 引用或原有 Markdown 结构展示，并另起一行给原任务入口。保留原文字句和现有结构，可以把长纯文本按句分段。带有 textTruncated 的内容只是摘录，明确标为摘录并给完整内容的入口。用户约定只要精确文本或某种格式时，按约定交付。",
  ].join("\n"));
  const text = append.trim();
  if (text) {
    add("dotsPromptAppend", "Dots 自定义提示词", "user",
      `## Dots 自定义提示词\n用户在 Dots 设置里补充的要求，与本轮请求一起遵守；与本轮明确要求冲突时，以本轮要求为准。\n${text}`);
  }
  return segments;
}

const controls = ["pause", "stop", "pause_all", "stop_all", "file_watches", "cancel_watch", "pause_proactive"] as const;
const configuredActions = ["find_tasks", "task", "execution_configs", "spaces", "deliveries", "materials", "read_material", "files", "read_file",
  "bind", "create_space", "rename", "delegate", "steer", "resume", "follow_up", "answer", "watch_file", "resume_proactive"] as const satisfies readonly (keyof typeof dotsOperations)[];

function actionAllowed(action: DotsActionInput["action"], settings: Partial<DotsSettings> | undefined): boolean {
  return controls.some(key => key === action) || configuredActions.some(key => key === action) && dotsOperationEnabled(settings, action);
}

export function dotsAvailableActions(settings: Partial<DotsSettings> | undefined): DotsActionInput["action"][] {
  return [...configuredActions, ...controls].filter(action => actionAllowed(action, settings));
}

export function dotsExtension(actions: DotsActions, settings: () => Partial<DotsSettings> | undefined): ExtensionFactory {
  return pi => pi.registerTool({
    name: DOTS_ACTION, label: "Dots · 任务与工作空间",
    description: [
      taskEvidenceInstructions,
      "materials 在指定 spaceId 或 targetTaskId 范围搜索资料，read_material 按 itemId 读取，可传 version 读已列出的旧版本。spaces 列举空间，files 每页列出指定空间或其相对子目录的 100 个条目，传 nextOffset 作为 offset 翻页。read_file 读相对路径文本。资料、目录和文件读取时，用 allowHandoff 标明达到内部读取上限后，同一事项是否可以在已获准的空间内继续，并传入该 spaceId。按本轮请求和最新修订判断，用户已授权完成事项时可自动移交。",
      "bind 绑定绝对目录，可用 spaceId 或 name 新建空间。create_space 在已绑定的父 spaceId 下创建名为 name 的子文件夹及空间，随后可在新空间委派任务。rename 保留原空间身份。用户明确交代按顺序做多件事时，可用 steps 固定各步。只给目标时直接传完整目标和限制。",
      "delegate 在指定空间新建普通任务或接续 targetTaskId。steer 将 text 发给正在执行的原任务，pause 或 stop 停止本轮。follow_up 按本轮原话追问已完成的原任务，传 targetTaskId 和最新 operationId，由宿主转发追问及同轮截图。resume 恢复或重跑原任务。answer 传原委派 operationId、目标任务和 interactionId，由宿主原样转发本轮用户输入。选择或确认题需要用户明确给出选项。",
      "deliveries 按标题、文字或文件名找本地普通任务已有成果，包括用户自行建立的任务。结果给出原任务及登记文件链接。有 nextOffset 时保留 cursor 并传 offset，否则把 next 作为 cursor 从 offset 0 继续。",
      "任务消息或交付标有 textTruncated 时，用其 readTextCall 读取同一条完整正文。按返回的 readTextCall 逐页续读，并按偏移顺序拼接 text。",
      "watch_file 订阅原任务空间里的单个相对文件路径，传 text 指定变化后要办的事。文件新增、元数据变化或删除只触发一次。file_watches 查看，cancel_watch 传原任务与 watchId 取消。pause_all 或 stop_all 控制 Dots 已关联的活动事项，可指定 spaceId。未指定空间时也会暂停或取消 Dots 自有计划。pause_proactive 或 resume_proactive 暂停或恢复主动跟进，保留正在运行的普通任务。",
      "goalId 关联到原任务已有 Goal。用户明确约定本任务的交付格式、语言或篇幅时，将允许转发给执行器的相应原文填入 deliveryInstruction，即使 text 已提及也要填写。用户明确表示由自己验收时，使用 goalUserAcceptanceQuote 引用该约定。",
    ].join("\n"),
    parameters: Type.Object({
      handoffOperationId: Type.Optional(Type.String({description:"仅当用户明确授权在原任务续办时，和 targetTaskId 一起提供该任务最新交办操作 ID。仅借用任务查资料时不要填。"})),
      allowHandoff: Type.Optional(Type.Boolean({description:"读取上限时可否用同一事项自动交给已指定空间内的普通任务。用户已交代完成事项且该空间获准时可用 true；禁止委派、只要求当前对话处理或授权不明确时用 false。按最新修订判断。"})),
      assignmentQuote: Type.Optional(Type.String({minLength:1,maxLength:500,description:"引用本轮明确要求追问或续办的原话，或在同一条消息交办多个独立事项时引用该事项原文"})),
      previousAssignmentQuote: Type.Optional(Type.String({minLength:1,maxLength:500,description:"首项未引用原文时，用此字段补上首项原文，并用 assignmentQuote 引用本次独立事项"})),
      action: Type.Union(dotsAvailableActions(settings()).map(action => Type.Literal(action))), targetTaskId: Type.Optional(Type.String()),
      steps:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:400}),{minItems:2,maxItems:8})),
      memoryRefs: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 160 }), revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), { maxItems: 8 })),
      requiredCapabilities: Type.Optional(Type.Array(Type.Object({
        kind: Type.Union(dotsCapabilityKinds.map(kind => Type.Literal(kind))),
        id: Type.String({ minLength: 1, maxLength: 120 }),
        tool: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      }, { additionalProperties: false }), { maxItems: 12, description: "task 查询候选任务的授权配置。委派受理时核对实际能力。MCP 的 id 是服务名，tool 可指定该服务上的精确工具名。" })),
      executionConfiguration: Type.Optional(Type.Object({
        authorizationQuote: Type.String({ minLength: 1, maxLength: 500 }),
        welcomeMode: Type.Optional(Type.Union(WELCOME_MODES.map(mode => Type.Literal(mode)))),
        modePresetId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        expertId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        connectorIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 8 })),
      }, { additionalProperties: false, description: "execution_configs 按 spaceId 查询可用配置。新建任务时根据用户本轮原话，从目录明确选择场景、预设、专家或连接器。" })),
      completionItems: Type.Optional(Type.Array(Type.Object({
        kind: Type.Union((["work", "file", "check", "commit"] as const).map(kind => Type.Literal(kind))),
        quote: Type.String({ minLength: 1, maxLength: 500 }),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 260 })),
        sheet: Type.Optional(Type.String({ minLength: 1, maxLength: 31 })),
        headers: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 30 })),
      }, { additionalProperties: false }), { maxItems: 24, description: "按用户原话逐项登记工作、成品文件、检查和提交。name 为文件名或指定检查名。sheet 和 headers 为用户明确要求的 Excel 工作表和表头。" })),
      goalUserAcceptanceQuote: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      deliveryInstruction: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      goalId: Type.Optional(Type.String()), watchId: Type.Optional(Type.String()), operationId: Type.Optional(Type.String()), interactionId: Type.Optional(Type.String()),
      spaceId: Type.Optional(Type.String()), name: Type.Optional(Type.String()), path: Type.Optional(Type.String()),
      itemId: Type.Optional(Type.String({ minLength: 1 })), version: Type.Optional(Type.Integer({ minimum: 1 })),
      query: Type.Optional(Type.String({ maxLength: 500, description: "find_tasks 查找普通任务的标题或 ID。deliveries 查找已有成果。" })),
      detail: Type.Optional(Type.Union([Type.Literal("history"), Type.Literal("execution"), Type.Literal("message")], {
        description: "仅用于 task。history 读取对话，execution 查看执行诊断，message 逐页读取同一条正文。"
      })),
      textRef: Type.Optional(Type.Union([
        Type.Object({ operationId: Type.String({ minLength: 1, maxLength: 180 }) }, { additionalProperties: false }),
        Type.Object({ messageId: Type.String({ minLength: 1, maxLength: 180 }), entryId: Type.Optional(Type.Integer({ minimum: 1 })),
          historyId: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })) }, { additionalProperties: false }),
        Type.Object({ answerEntryId: Type.Integer({ minimum: 1 }), historyId: Type.String({ minLength: 1, maxLength: 180 }) },
          { additionalProperties: false }),
      ], { description: "使用 readTextCall 中原样返回的正文定位。" })),
      textVersion: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      beforeEntryId: Type.Optional(Type.Integer({ minimum: 1, description: "仅用于 task 的 history。用上次返回的 nextBeforeEntryId 读取更早一页。" })),
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
      const canFollowUp = actionAllowed("follow_up", settings());
      let followUpRequest: ReturnType<typeof dotsFollowUpInput> | undefined;
      if (canFollowUp && (reading || input.action === "task" || input.action === "find_tasks")) {
        try { followUpRequest = dotsFollowUpInput(invocation.foregroundInputs ?? []); }
        catch { /* Reads for ordinary queries should retain their normal behavior. */ }
      }
      if (reading) {
        if (followUpRequest && requiresOriginalTaskRead(followUpRequest)) return toolResult({ foreground: "follow_up_required",
          message: "用户要求追问原任务。本次读取由原任务办理。请先用 find_tasks 或 task 确认原任务，拿到 followUpCall 后调用它。" });
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
      const checkCurrentInstruction = async () => {
        invocation.context.abortSignal?.throwIfAborted();
        await checkCurrentToolInput();
        if (!actionAllowed(input.action, settings())) throw new Error("Dots 操作已关闭。");
      };
      if (input.action === "follow_up") {
        const { source, assignmentQuote, attachments, captions } = dotsFollowUpInput(invocation.foregroundInputs ?? []);
        await checkCurrentInstruction();
        const origin = { conversationId: invocation.presentationConversationId ?? invocation.native.conversationId, entryId: source.entryId };
        const work = { action: input.action, targetTaskId: input.targetTaskId, operationId: input.operationId,
          spaceId: input.spaceId, assignmentQuote, deliveryInstruction: input.deliveryInstruction, requiredCapabilities: input.requiredCapabilities,
          completionItems: input.completionItems, executionConfiguration: input.executionConfiguration };
        return toolResult(await actions.execute(invocation.execution.taskId, source.id, work, source.text, origin, source.createdAt,
          { followUp: { attachments, captions, checkCurrent: checkCurrentInstruction } }));
      }
      if (["delegate", "steer", "resume"].includes(input.action)
        && (invocation.foregroundInputs?.some(source => dotsForwardingDenied(source.text))
          || dotsForwardingDenied(invocation.sourceDisplayText ?? ""))) {
        throw new Error("本轮要求留在当前对话。可用 task 查询原任务进度。");
      }
      if (input.action === "resume" || input.action === "delegate" || input.action === "steer") {
        const approval = dotsRetryApprovalInput(invocation.foregroundInputs ?? []);
        const conversationId = invocation.presentationConversationId ?? invocation.native.conversationId;
        const question = approval && await durableDotsRetryQuestion(invocation.native, invocation.context, conversationId, approval.entryId);
        if (approval && question && actions.isRetryApprovalQuestion(question)) {
          if (input.targetTaskId && input.targetTaskId !== question.taskId || input.operationId && input.operationId !== question.operationId)
            throw new Error("用户确认的是重试上一条问题对应的原任务。请使用该任务和原交办。");
          const checkRetry = async () => {
            await checkCurrentInstruction();
            if (!actionAllowed("resume", settings())) throw new Error("Dots 设置已关闭恢复原任务");
          };
          await checkRetry();
          return toolResult(await actions.execute(invocation.execution.taskId, approval.id, {
            action: "resume", targetTaskId: question.taskId, operationId: question.operationId,
            text: "用户已确认在原任务重试这一步。先核对上次的进度和操作结果，再继续未完成的部分。",
          }, approval.text, { conversationId, entryId: approval.entryId }, approval.createdAt, { checkCurrentInstruction: checkRetry }));
        }
        if (approval && input.action === "resume")
          throw new Error("当前确认没有对应的原任务重试问题。请使用 task 读取原任务的执行诊断，或明确指定要重试的原任务。");
      }
      if (actions.requiresResumeInstruction(input)) {
        const received = invocation.foregroundInputs ?? [];
        const resume = dotsResumeInput(received, input.assignmentQuote);
        if (!resume && (received.length || !invocation.sourceUserMessageId || isDotsAutomaticInput(invocation.sourceUserMessageId)
          || !hasDotsResumeInstruction(invocation.sourceDisplayText, input.assignmentQuote)))
          throw new Error("本轮用户原话没有要求恢复或重跑一个原任务。查询进度或失败原因时请使用 task 读取原任务的执行诊断。");
        await checkCurrentInstruction();
        if (resume) {
          const { source, assignmentQuote } = resume;
          const origin = { conversationId: invocation.presentationConversationId ?? invocation.native.conversationId, entryId: source.entryId };
          return toolResult(await actions.execute(invocation.execution.taskId, source.id, { ...input, assignmentQuote }, source.text,
            origin, source.createdAt, { checkCurrentInstruction }));
        }
        return toolResult(await actions.execute(invocation.execution.taskId, invocation.sourceUserMessageId, input, invocation.sourceDisplayText,
          invocation.sourceOrigin, invocation.sourceCreatedAt, { checkCurrentInstruction }));
      }
      const offerFollowUp = Boolean(followUpRequest && !input.requiredCapabilities?.length);
      const details = await actions.execute(invocation.execution.taskId, invocation.sourceUserMessageId, input, invocation.sourceDisplayText,
        invocation.sourceOrigin, invocation.sourceCreatedAt, input.executionConfiguration ? { checkCurrentInstruction } : offerFollowUp ? { offerFollowUp } : undefined);
      return toolResult(details);
    },
  });
}
