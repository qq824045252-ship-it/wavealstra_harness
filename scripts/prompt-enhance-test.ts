/**
 * Prompt Enhance（增强提示词）定向测试 —— 统一收口后的唯一测试入口。
 *
 * A) 策略纯函数：canTriggerEnhance 门控（chat/new-task 双 surface）/ resolveUndo 撤销判定 /
 *    buildFingerprint stale 指纹（expertIds/allowedSkillNames canonical sort、expertId 一致性；
 *    与 ChatInput / usePromptEnhance 共用同一纯函数）；
 * B) 清洗器：sanitizeEnhancedPrompt 前缀 + 围栏剥离；
 * C) 主进程 System Prompt 语义红线静态契约（ENHANCE_SYSTEM_ROLE 防退化成「AI 帮我丰富一下」；
 *    不再虚假宣称可用的对话上下文——本功能不注入任何对话历史）；
 * D) 主进程安全红线（inMemory + 空工具白名单 + 并发上限 + finally 释放 + surface 校验 +
 *    new-task 显式 expertId 主进程校验后注入、默认链仅兜底）
 *    与 renderer 可信边界（IPC 只传 id 级字段，不拼 expert/skill 全文进 prompt；
 *    hook 内部真实 enhancing/BTW 门控、ChatInput 阻止 Enhance 与发送/continue 并发）；
 * E) 统一文案契约（types.ts 6 常量精确字符串 + ChatInput 不再含旧文案）；
 * F) 通道与 preload 桥：enhance:prompt 唯一通道，与 agent/btw 隔离；preload 暴露 enhance.prompt。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentIpc, BtwIpc, EnhanceIpc } from "../src/shared/agent-ipc";
import { sanitizeEnhancedPrompt } from "../src/shared/prompt-enhance";
import {
  buildFingerprint,
  canTriggerEnhance,
  resolveUndo,
} from "../src/renderer/src/features/prompt-enhance/policy";
import {
  ENHANCE_ENHANCING_LABEL,
  ENHANCE_FAILED_NOTICE,
  ENHANCE_LABEL,
  ENHANCE_RESTORE_LABEL,
  ENHANCE_STALE_NOTICE,
  ENHANCE_UNDO_BLOCKED_NOTICE,
} from "../src/renderer/src/features/prompt-enhance/types";

let passed = 0;
function ok(cond: unknown, label: string): void {
  assert.ok(cond, label);
  passed += 1;
}

// ---- A. 策略纯函数 ----
{
  // 1. 触发门控
  const chatCtx = { surface: "chat" as const, taskId: "task-1" };
  const baseGate = { enhancing: false, btwActive: false };
  ok(canTriggerEnhance({ ...baseGate, text: "  ", context: chatCtx }) === false, "A1.1 空白文本不可触发");
  ok(canTriggerEnhance({ ...baseGate, text: "", context: chatCtx }) === false, "A1.2 空文本不可触发");
  ok(
    canTriggerEnhance({ ...baseGate, text: "帮我写一个登录页", context: chatCtx, enhancing: true }) === false,
    "A1.3 增强中禁止再次触发（单飞）",
  );
  ok(
    canTriggerEnhance({ ...baseGate, text: "帮我写一个登录页", context: chatCtx, btwActive: true }) === false,
    "A1.4 BTW 激活时不可触发（语义互斥）",
  );
  ok(
    canTriggerEnhance({ ...baseGate, text: "帮我写一个登录页", context: chatCtx }) === true,
    "A1.5 主任务回复/流式中仍可触发（入口已在工具栏，不再与流式条争位）",
  );
  ok(
    canTriggerEnhance({ ...baseGate, text: "帮我写一个登录页", context: { surface: "chat" } }) === false,
    "A1.6 chat 无 taskId 不可触发（主进程会拒绝无任务请求）",
  );
  ok(
    canTriggerEnhance({ ...baseGate, text: "帮我写一个登录页", context: chatCtx }) === true,
    "A1.7 chat 有 taskId 可触发",
  );
  ok(
    canTriggerEnhance({ ...baseGate, text: "帮我写一个登录页", context: { surface: "new-task" } }) === true,
    "A1.8 new-task 只要文本非空即可触发（顶层新建任务，无 projectId/spaceId）",
  );
  ok(
    canTriggerEnhance({
      ...baseGate,
      text: "帮我写一个登录页",
      context: { surface: "new-task", projectId: "proj-1", spaceId: "space-1" },
    }) === true,
    "A1.9 new-task 带 projectId/spaceId 同样可触发",
  );
  ok(
    canTriggerEnhance({ ...baseGate, text: "  x  ", context: chatCtx }) === true,
    "A1.10 trim 后非空即可触发",
  );

  // 2. 撤销判定
  const undo = { original: "写一个登录页", applied: "写一个带手机号验证码登录的登录页，包含表单校验与错误提示" };
  ok(resolveUndo(null, "任意文本").kind === "noop", "A2.1 无 undo 状态 → noop");
  const restored = resolveUndo(undo, undo.applied);
  ok(restored.kind === "restore" && restored.text === undo.original, "A2.2 当前文本仍等于 applied → 恢复原文");
  const blocked = resolveUndo(undo, "用户自己改过的文本");
  ok(
    blocked.kind === "blocked" && blocked.message === ENHANCE_UNDO_BLOCKED_NOTICE,
    "A2.3 用户已编辑 → blocked 且文案为统一常量 ENHANCE_UNDO_BLOCKED_NOTICE",
  );

  // 3. stale 指纹
  const ctxA = { surface: "chat" as const, taskId: "task-1" };
  const ctxB = { surface: "chat" as const, taskId: "task-2" };
  ok(buildFingerprint(ctxA, "写一个登录页") === buildFingerprint(ctxA, "写一个登录页"), "A3.1 同输入同输出（确定性）");
  ok(
    buildFingerprint(ctxA, "写一个登录页") !== buildFingerprint(ctxA, "写一个带验证码的登录页"),
    "A3.2 sourceText 变化 → 指纹变化",
  );
  ok(buildFingerprint(ctxA, "写一个登录页") !== buildFingerprint(ctxB, "写一个登录页"), "A3.3 taskId 变化 → 指纹变化");
  // canonical sort：数组顺序不影响指纹，且不修改原数组
  const orderCtxA = {
    surface: "new-task" as const,
    expertIds: ["expert-b", "expert-a"],
    allowedSkillNames: ["skill-z", "skill-a"],
  };
  const orderCtxB = {
    surface: "new-task" as const,
    expertIds: ["expert-a", "expert-b"],
    allowedSkillNames: ["skill-a", "skill-z"],
  };
  ok(
    buildFingerprint(orderCtxA, "写一个登录页") === buildFingerprint(orderCtxB, "写一个登录页"),
    "A3.4 expertIds/allowedSkillNames 顺序无关（canonical sort）",
  );
  ok(
    orderCtxA.expertIds.join(",") === "expert-b,expert-a" &&
      orderCtxA.allowedSkillNames.join(",") === "skill-z,skill-a",
    "A3.5 canonical sort 不修改原数组",
  );
  ok(
    buildFingerprint({ ...ctxA, expertId: "expert-1" }, "写一个登录页") !==
      buildFingerprint({ ...ctxA, expertId: "expert-2" }, "写一个登录页"),
    "A3.6 显式 expertId 变化 → 指纹变化（指纹中的 expert 与 IPC 发送值一致）",
  );
  ok(
    buildFingerprint(ctxA, "写一个登录页") !== buildFingerprint({ ...ctxA, expertId: "expert-1" }, "写一个登录页"),
    "A3.7 无显式 expert → 有显式 expert 指纹变化（选择专家后旧结果判定 stale）",
  );
}

// ---- B. 清洗器（共享纯函数）----
{
  ok(sanitizeEnhancedPrompt("增强后的提示词：写一个登录页") === "写一个登录页", "B1 前缀「增强后的提示词：」剥离");
  ok(sanitizeEnhancedPrompt("增强后的Prompt: 写一个登录页") === "写一个登录页", "B2 前缀「增强后的Prompt:」剥离（英文冒号）");
  ok(sanitizeEnhancedPrompt("改写结果：写一个登录页") === "写一个登录页", "B3 前缀「改写结果：」剥离");
  ok(sanitizeEnhancedPrompt("Enhanced prompt: 写一个登录页") === "写一个登录页", "B4 前缀「Enhanced prompt:」剥离（英文不区分大小写）");
  ok(sanitizeEnhancedPrompt("完善后的提示词：写一个登录页") === "写一个登录页", "B5 前缀「完善后的提示词：」剥离");
  ok(sanitizeEnhancedPrompt("优化后的提示词：写一个登录页") === "写一个登录页", "B6 前缀「优化后的提示词：」剥离");
  ok(
    sanitizeEnhancedPrompt("```\n写一个登录页\n```") === "写一个登录页",
    "B7 成对反引号围栏剥离",
  );
  ok(
    sanitizeEnhancedPrompt("~~~\n写一个登录页\n~~~") === "写一个登录页",
    "B8 成对波浪线围栏剥离",
  );
  ok(
    sanitizeEnhancedPrompt("```\n写一个登录页") === "```\n写一个登录页",
    "B9 不成对反引号围栏不剥离",
  );
  ok(
    sanitizeEnhancedPrompt("~~~\n写一个登录页") === "~~~\n写一个登录页",
    "B10 不成对波浪线围栏不剥离",
  );
}

const repo = process.cwd();
const agentService = readFileSync(join(repo, "src/main/agent/AgentService.ts"), "utf8");
const promptEnhancementService = readFileSync(join(repo, "src/main/agent/PromptEnhancementService.ts"), "utf8");
const mainIndex = readFileSync(join(repo, "src/main/index.ts"), "utf8");
const preload = readFileSync(join(repo, "src/preload/index.ts"), "utf8");
const chatInput = readFileSync(join(repo, "src/renderer/src/components/chat/ChatInput.tsx"), "utf8");
const usePromptEnhance = readFileSync(join(repo, "src/renderer/src/features/prompt-enhance/usePromptEnhance.ts"), "utf8");
const policySrc = readFileSync(join(repo, "src/renderer/src/features/prompt-enhance/policy.ts"), "utf8");

// ---- C. System Prompt 语义红线静态契约 ----
{
  const match = promptEnhancementService.match(/const ENHANCE_SYSTEM_ROLE = `([\s\S]*?)`;/);
  ok(!!match, "C1 ENHANCE_SYSTEM_ROLE 常量存在（模板字符串）");
  const sysRole = match?.[1] ?? "";
  ok(sysRole.includes("Prompt Enhance"), "C2 角色头含「Prompt Enhance」");
  ok(sysRole.includes("你不是任务执行者"), "C3 明确「你不是任务执行者」");
  ok(sysRole.includes("绝对禁止"), "C4 存在「绝对禁止」清单");
  const forbiddenPhrases = [
    "回答用户的问题",
    "完成用户请求的任务",
    "提供最终解决方案",
    "替用户进行产品设计",
    "业务事实",
    "功能清单",
    "最终技术方案",
    "分析结论",
    "伪装成用户 Prompt",
  ];
  for (let i = 0; i < forbiddenPhrases.length; i += 1) {
    ok(sysRole.includes(forbiddenPhrases[i]!), `C${5 + i} 禁止清单含「${forbiddenPhrases[i]}」`);
  }
  ok(sysRole.includes("任何未知信息都必须保持未知"), "C14 未知信息保持未知（不虚构）");
  ok(sysRole.includes("不要为了让 Prompt 看起来更完整而猜测缺失信息"), "C15 不猜测缺失信息");
  ok(sysRole.includes("信息来源优先级"), "C16 存在「信息来源优先级」约束");
  ok(!sysRole.includes("已明确的对话上下文"), "C16a System Prompt 不再宣称可用的对话上下文（P2-1）");
  ok(!sysRole.includes("当前明确上下文"), "C16b 优先级链不再引用虚构的「当前明确上下文」");
  ok(sysRole.includes("不提供对话历史或任务记忆"), "C16c 明确声明不提供对话历史/任务记忆（未知保持未知）");
  ok(sysRole.includes("只输出"), "C17 输出约束：只输出");
  ok(sysRole.includes("不要解释"), "C18 输出约束：不要解释");
  ok(sysRole.includes("不要加标题"), "C19 输出约束：不要加标题");
  ok(sysRole.includes("不要使用代码围栏"), "C20 输出约束：不要使用代码围栏");
}

// ---- D. 主进程安全红线 + renderer 可信边界 ----
{
  const enhanceStart = promptEnhancementService.indexOf("async enhance(");
  ok(enhanceStart >= 0, "D1 PromptEnhancementService.enhance exists");
  const enhanceEnd = promptEnhancementService.indexOf("private resolveWorkspaceCwd(");
  const enhanceSection = promptEnhancementService.slice(
    enhanceStart,
    enhanceEnd > enhanceStart ? enhanceEnd : enhanceStart + 6000,
  );
  ok(
    /this\.deps\.generate\(/.test(enhanceSection) && /kind: "prompt-enhance"/.test(agentService),
    "D2 enhance service uses the durable auxiliary execution bridge",
  );
  ok(/MAX_CONCURRENT/.test(promptEnhancementService), "D3 dedicated service owns concurrency cap");
  ok(
    /this\.inflight \+= 1/.test(enhanceSection) && /this\.inflight -= 1/.test(enhanceSection),
    "D4 concurrency counter increments/decrements in service",
  );
  ok(/finally \{\s*this\.inflight -= 1;/.test(enhanceSection), "D5 concurrency counter releases in finally");
  ok(
    promptEnhancementService.includes('throw new Error("chat surface 需要有效 taskId")') &&
      promptEnhancementService.includes('throw new Error("new-task surface 不应携带 taskId")'),
    "D6 PromptEnhancementService validates chat/new-task taskId semantics",
  );
  ok(/任务不存在/.test(enhanceSection), "D7 chat surface requires an existing task");
  ok(
    /return this\.promptEnhancement\.enhance\(req\)/.test(agentService),
    "D7a AgentService enhancePrompt is a thin service facade",
  );
  ok(
    mainIndex.includes("new-task surface 不应携带 taskId") && mainIndex.includes("chat surface 需要有效 taskId"),
    "D8 IPC handler surface validation remains aligned",
  );
  // renderer 不自行构造可信 prompt：只传 id 级字段
  ok(/window\.api\?\.enhance\?\.prompt/.test(usePromptEnhance), "D9 renderer 经 window.api.enhance.prompt 桥发送");
  const payloadStart = usePromptEnhance.indexOf("await enhanceApi({");
  const payloadEnd = usePromptEnhance.indexOf("});", payloadStart);
  ok(payloadStart > 0 && payloadEnd > payloadStart, "D10 存在 IPC payload 构造块");
  const payload = usePromptEnhance.slice(payloadStart, payloadEnd);
  for (const field of ["surface", "input", "taskId", "projectId", "spaceId", "mode", "tag", "expertId", "modelId"]) {
    ok(payload.includes(field), `D11 payload 含 id 级字段 ${field}`);
  }
  ok(
    !/expertIds|allowedSkillNames|conversationContext/.test(payload),
    "D12 payload 不含 expertIds/allowedSkillNames/conversationContext（不传政策/全文）",
  );
  ok(/expertId: reqContext\.expertId/.test(payload), "D12a new-task 显式 expertId 随 IPC 发送（仅 id）");
  ok(/statusRef\.current === "enhancing"/.test(usePromptEnhance), "D12b hook 门控使用真实 enhancing 状态");
  ok(!/enhancing: false/.test(usePromptEnhance), "D12c hook 不再硬编码 enhancing:false 假防御");
  ok(/isBtwActive/.test(usePromptEnhance), "D12d hook 内部防御性拒绝 BTW 态（isBtwActive 注入）");
  ok(
    /expertId: req\.expertId/.test(enhanceSection),
    "D12e enhancePrompt 把 req.expertId 传入 new-task 环境构建",
  );
  const newTaskEnvStart = promptEnhancementService.indexOf("private buildEnvironmentContextForNewTask(");
  const newTaskEnvEnd = promptEnhancementService.indexOf("private buildEnvironmentLines(");
  ok(
    newTaskEnvStart >= 0 && newTaskEnvEnd > newTaskEnvStart,
    "D12f new-task 环境构建段存在",
  );
  const newTaskEnvSection = promptEnhancementService.slice(newTaskEnvStart, newTaskEnvEnd);
  ok(
    /isRuntimeAvailable\(explicitExpertId\)/.test(newTaskEnvSection),
    "D12g 主进程校验显式 expert 真实存在/可用后才注入",
  );
  ok(
    /if \(!expertId\) expertId = normalizeSingleExpertId\(recent\?\.expertId\) \?\? null/.test(newTaskEnvSection),
    "D12h 默认链（最近项目任务 expert）仅兜底：显式 expert 已注入时绝不覆盖",
  );
  ok(
    /typeof req\.expertId !== "string"/.test(mainIndex) && mainIndex.includes("expertId 非法"),
    "D12i IPC handler 对 expertId 做 shape 校验（非字符串/空/超长拒绝）",
  );
  ok(
    /hasStreamingDraft[\s\S]{0,160}!btwActive[\s\S]{0,160}enhance\.status !== "enhancing"/.test(chatInput),
    "D12j enhancing 期间流式 continue 按钮不渲染（不与 Enhance 并发）",
  );
  ok(
    chatInput.includes('if (enhance.status === "enhancing") return;'),
    "D12k send() 内部防御：enhancing 期间任何入口（含 continue 直调）都阻止发送",
  );
  const typesSrc = readFileSync(
    join(repo, "src/renderer/src/features/prompt-enhance/types.ts"),
    "utf8",
  );
  ok(!/conversationContext/.test(typesSrc), "D12l types.ts 已删除未实现的 conversationContext 死字段");
  ok(!/\$\{/.test(payload), "D13 payload 无模板插值拼接（不组装任意 prompt 文本）");
  ok(!/window\./.test(policySrc), "D14 policy.ts 为纯函数（无 window 访问）");
  ok(!/enhance:prompt|\.prompt\(/.test(policySrc), "D15 policy.ts 不发起 IPC / 不调用 prompt（无执行能力）");
}

// ---- E. 统一文案契约 ----
{
  ok(ENHANCE_LABEL === "增强提示词", "E1 ENHANCE_LABEL === 增强提示词");
  ok(ENHANCE_ENHANCING_LABEL === "增强中…", "E2 ENHANCE_ENHANCING_LABEL === 增强中…");
  ok(ENHANCE_RESTORE_LABEL === "恢复原文", "E3 ENHANCE_RESTORE_LABEL === 恢复原文");
  ok(ENHANCE_FAILED_NOTICE === "增强失败，请重试", "E4 ENHANCE_FAILED_NOTICE === 增强失败，请重试");
  ok(ENHANCE_STALE_NOTICE === "输入内容已变化，增强结果未应用", "E5 ENHANCE_STALE_NOTICE === 输入内容已变化，增强结果未应用");
  ok(ENHANCE_UNDO_BLOCKED_NOTICE === "内容已修改，无法直接恢复", "E6 ENHANCE_UNDO_BLOCKED_NOTICE === 内容已修改，无法直接恢复");
  // ChatInput 不再出现旧文案
  ok(!chatInput.includes("已完善"), "E7 ChatInput 不含旧文案「已完善」");
  ok(!chatInput.includes("无法直接撤销"), "E8 ChatInput 不含旧文案「无法直接撤销」");
  ok(!chatInput.includes("完善失败"), "E9 ChatInput 不含旧文案「完善失败」");
}

// ---- F. 通道与 preload 桥 ----
{
  const channels = [EnhanceIpc.prompt, AgentIpc.prompt, AgentIpc.abort, BtwIpc.prompt, BtwIpc.event];
  ok(new Set(channels).size === channels.length, "F1 enhance 通道与 agent/btw 通道不重合");
  ok(EnhanceIpc.prompt === "enhance:prompt", "F2 enhance 通道命名独立（enhance:prompt）");
  ok(/enhance: \{/.test(preload) && /EnhanceIpc\.prompt/.test(preload), "F3 preload 暴露 enhance.prompt 桥");
  ok(/EnhancePromptRequest/.test(preload) && /EnhancePromptResult/.test(preload), "F4 类型契约完整（EnhancePromptRequest/Result）");
  ok(!/improve/.test(preload), "F5 preload 无旧 improve 命名残留");
  ok(!/improve/.test(chatInput), "F6 ChatInput 无旧 improve 命名残留");
  const enhanceIdx = chatInput.indexOf("<PromptEnhanceControl");
  ok(enhanceIdx >= 0, "F7 ChatInput 含 PromptEnhanceControl");
  ok(!chatInput.includes("语音输入") && !chatInput.includes("<IconMic"), "F8 语音输入已移除（输入法自带语音）");
  ok(!chatInput.includes("prompt-enhance-host"), "F9 ChatInput 不再把增强入口叠在 textarea 右下");
  ok(!chatInput.includes("streamingBarVisible"), "F10 ChatInput 不再因主任务回复禁用增强");
  ok(chatInput.includes("empty={!text.trim()}"), "F11 无字时把 empty 传给 PromptEnhanceControl（默认隐藏）");
  const controlSrc = readFileSync(
    join(repo, "src/renderer/src/features/prompt-enhance/PromptEnhanceControl.tsx"),
    "utf8",
  );
  ok(!controlSrc.includes("prompt-enhance-loading"), "F13 工具栏不渲染「增强中…」文字，只改图标");
  ok(controlSrc.includes("IconRotate"), "F14 可恢复时同一槽位换成恢复图标");
  ok(controlSrc.includes("prompt-enhance-tip"), "F15 「恢复原文」仅 hover/focus 提示，不占工具栏");
  ok(!controlSrc.includes("prompt-enhance-restore"), "F16 不再单独放「恢复原文」文字按钮");
}

console.log(`[prompt-enhance-test] passed=${passed} failed=0`);
