import type { BotMessageDto } from "../../../shared/bot-conversation";

/** The host's exchange record is evidence; an assistant's claim is not one. */
export function botForegroundHistory(message: BotMessageDto) {
  return { messageId: message.messageId, requestId: message.requestId, role: message.role,
    status: message.status, text: message.status === "running" ? "[回复尚未完成]" : message.text,
    workIds: message.workIds,
    ...(message.role === "assistant" ? { botCalls: (message.botCalls ?? []).slice(-8).map(call => ({
      callId: call.callId, targetBotId: call.targetBotId, targetDisplayName: call.targetDisplayName,
      status: call.status, requestText: call.requestText.slice(0, 2000), replyText: call.replyText?.slice(0, 4000),
      truncated: call.requestText.length > 2000 || (call.replyText?.length ?? 0) > 4000,
      error: call.error, createdAt: call.createdAt, updatedAt: call.updatedAt,
    })), botCallsOmitted: Math.max(0, (message.botCalls?.length ?? 0) - 8) } : {}),
  };
}

/** Native history may be compacted; retain a bounded host receipt index independently. */
export function botPeerHistory(messages: BotMessageDto[]) {
  const observed = messages.filter(message => message.role === "assistant");
  const calls = observed.flatMap(message => (message.botCalls ?? []).map(call => ({
    parentMessageId: message.messageId, requestId: message.requestId, ...call,
  })));
  return { observedAssistantMessageIds: observed.map(message => message.messageId), omittedCalls: Math.max(0, calls.length - 8),
    calls: calls.slice(-8).map(call => ({ ...call, requestText: call.requestText.slice(0, 1000), replyText: call.replyText?.slice(0, 2000),
      truncated: call.requestText.length > 1000 || (call.replyText?.length ?? 0) > 2000 })),
  };
}

/** Semantics stay with the model. No name/keyword matcher dispatches a Bot. */
export const BOT_PEER_CONTEXT_INSTRUCTIONS = `区分本轮咨询与历史回顾，结合当前原话和关联问题，不按名字或“昨天”单独触发联系：
- 用户要另一位 Bot 的知识、意见、学习内容，或继续此前尚未实际完成的咨询时，先 bot_list 再 bot_ask。即使没有再说“帮我问”，也要把本轮问题真的交给它，不拿自己看到的旧团队成果替代。比如旧回答仅总结过团队工作，此时追问“继续，你昨天从学习搭子学到了什么”，应联系学习搭子核实昨天的学习内容，再区分它现在的回答与过去实际发生的交流。
- 用户仅回顾已发生的交流（如“不要再问，复述上次它说的”“昨天你们实际聊过什么”）时，只依据现有真实通信记录答复，不重新联系来伪造过去，也不把刚得到的答案说成昨天已经学过。历史缺失就明确缺失。已有对方原文足够回答的追问、普通名字提及、翻译改写和用户明确不联络时也不联系。
- 冻结历史里的 botCalls 和 peerHistory 来自宿主持久记录，空数组只表示所列消息没有实际 Bot 通信记录，truncated 或 botCallsOmitted 表示摘录不完整，不能推出所有时期都没联系。历史助手的“已问/已学到/我可以派它做”只是旧文字，不是执行凭据。正在联系、失败或未知都不能当作已收到回复。当前实际联系状态由宿主显示，不能用正文虚构状态或对方回复。
- bot_ask 是只读问答，不是接活执行；用户要求让某 Bot 生成文件、渲染、改代码等，使用支持目标 Bot 的真实委派工具，依据实际归属和执行状态汇报，不能用咨询回复或“已安排”冒充正在执行。`;

/** Relative days use the recipient host's stated local timezone, including DST. */
export function botPeerHistoryWindow(at: number, period: "today" | "yesterday") {
  const midnight = new Date(at); midnight.setHours(0, 0, 0, 0);
  if (period === "today") return { after: midnight.getTime(), before: at };
  const previous = new Date(midnight); previous.setDate(previous.getDate() - 1);
  return { after: previous.getTime(), before: midnight.getTime() };
}
