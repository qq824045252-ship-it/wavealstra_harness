/** Actual BotWorkspacePage/store/Markdown; controlled host data, not model acceptance. */
import './bot-conversation-concurrent-desktop-fixture';
import { useAppStore } from '../src/renderer/src/store/appStore';
import type { BotCollaborationDto, BotCollaborationEventDto, BotCollaborationHistoryQuery, BotCollaborationMessageDto, BotCollaborationsQuery } from '../src/shared/bot-collaboration';
import type { BotHistoryDto, BotSendReceipt, BotSendRequest } from '../src/shared/bot-conversation';
import type { WorkProjectionDto } from '../src/shared/bot-work';
import { botOrganizationSummarySchema, type BotOrganizationSummaryDto } from '../src/shared/bot-organization';

const relation = (id: string, targetBotId: string, targetDisplayName: string, createdAt: number): BotCollaborationDto => ({
  collaborationId: id, userId: 'fixture-user', sourceBotId: 'bot', sourceDisplayName: '并发助理', sourceConversationId: 'source-chat',
  sourceRequestId: `request-${id}`, sourceUserMessageId: `user-${id}`, sourceAssistantMessageId: `assistant-${id}`,
  targetBotId, targetDisplayName, workId: id === 'relation-a' ? 'target-owned-work' : null, createdAt, updatedAt: createdAt + 9000,
  messageCount: id === 'relation-a' ? 112 : 2, status: 'returned', originAvailable: true,
  requestPreview: id === 'relation-a' ? '请核验库存并保留阶段成果' : '请核算十九乘二十三',
  times: { sentAt: 1000, deliveredAt: 1100, acceptedAt: 1200, startedAt: 2200, endedAt: 5200, returningAt: null, returnedAt: 6200 },
});
const first = relation('relation-a', 'target', '学习搭子', 10000);
first.work = { workId: 'target-owned-work', title: '学习搭子的个人核验事项', lifecycle: 'active', executionStatus: 'completed', progressSummary: '已回传阶段成果，继续核验', startedAt: 3200, endedAt: 8200, closedAt: null };
const second = relation('relation-b', 'other-target', '翻译搭子', 9000);
const incomingQuestion: BotCollaborationDto = { ...relation('incoming-question', 'target', '学习搭子', 11000),
  sourceBotId: 'other-target', sourceDisplayName: '翻译搭子', status: 'started', messageCount: 1 };
const outgoingFromTarget: BotCollaborationDto = { ...relation('outgoing-from-target', 'other-target', '翻译搭子', 12000),
  sourceBotId: 'target', sourceDisplayName: '学习搭子', requestPreview: '这条是发出的，不应混入收到的协作' };
const allRelations = [outgoingFromTarget, incomingQuestion, first, second, ...Array.from({ length: 60 }, (_, index) => relation(`relation-${index}`, 'target', '学习搭子', 8000 - index))];
const messages: BotCollaborationMessageDto[] = [];
const events: BotCollaborationEventDto[] = [];
for (let ordinal = 1; ordinal <= 140; ordinal++) {
  if (ordinal % 5 === 0) events.push({ eventId: `event-${ordinal}`, collaborationId: first.collaborationId, ordinal, kind: 'delivered', createdAt: ordinal * 1000, operationId: `event-operation-${ordinal}` });
  else messages.push({ messageId: `message-${ordinal}`, collaborationId: first.collaborationId, ordinal,
    senderBotId: ordinal % 2 ? 'bot' : 'target', senderDisplayName: ordinal % 2 ? '并发助理' : '学习搭子',
    kind: ordinal === 139 ? 'result' : ordinal % 2 ? 'request' : 'reply', text: ordinal === 139 ? '阶段结果：文件已读取，后续验证尚未完成。' : `独立协作 A 的真实消息格式 ${ordinal}\n\n${'用于验证历史滚动位置的段落。'.repeat(4)}`,
    createdAt: ordinal * 1000, operationId: `message-operation-${ordinal}`,
    ...(ordinal === 139 ? { workFeedback: { workId: 'target-owned-work', eventId: 'partial-event', kind: 'result', category: 'progress',
      report: { title: '阶段结果', summary: '后续验证尚未完成', artifactRefs: [], milestone: true, completion: { outcome: 'partial', nextStep: 'continue' }, reviewStatus: 'proposed', current: true, notices: [] } } } : {}),
  });
}
const sourceHistory: BotHistoryDto = { botId: 'bot', conversationId: 'source-chat', revision: 1, archived: false, messages: Array.from({ length: 30 }, (_, index) => ({
  botId: 'bot', conversationId: 'source-chat', requestId: `source-${index}`, messageId: `source-${index}`, ordinal: index + 1,
  role: index % 2 ? 'assistant' : 'user', text: `原始对话消息 ${index}\n\n${'原始对话保持原来的阅读位置。\n\n'.repeat(3)}`,
  status: 'completed', workIds: [], createdAt: 1000, updatedAt: 1000,
  ...(index === 29 ? { collaborations: [first, first, second] } : {}),
})) };
const historyCalls: BotCollaborationHistoryQuery[] = [], listCalls: BotCollaborationsQuery[] = [], sendCalls: BotSendRequest[] = [];
const getWorkCalls: string[] = [];
const targetWork: WorkProjectionDto = { workId: 'target-owned-work', title: '学习搭子的个人核验事项', ownerBotId: 'target', mode: 'once', lifecycle: 'closed', closureConclusion: 'succeeded',
  ownerEpoch: 1, intentRevision: 1, sourceVersion: 1, stateVersion: 1, inputSnapshotId: 'target-input', inputSnapshotBound: true,
  goalSources: [], criteria: [], acceptedDeliverableIds: [], deliverables: [], blockers: [], executions: [], notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: [], updatedAt: 9000 };
const accepted = new Map<string, BotSendReceipt>();
let failFirstReceipt = true;
let heldRelation: string | undefined, releaseRead: (() => void) | undefined;
Object.assign(window.api!.botWork, {
  getWork: async (workId: string) => { getWorkCalls.push(workId); return workId === targetWork.workId ? structuredClone(targetWork) : undefined; },
  history: async ({ botId }: { botId: string }) => botId === 'bot' ? structuredClone(sourceHistory)
    : { botId, conversationId: '', revision: 0, archived: false, messages: [] },
  collaborations: async (request: BotCollaborationsQuery) => {
    listCalls.push(request);
    const available = allRelations.filter(item => (item.sourceBotId === request.botId || item.targetBotId === request.botId)
      && (request.direction !== 'incoming' || item.targetBotId === request.botId)
      && (request.direction !== 'outgoing' || item.sourceBotId === request.botId));
    const offset = Number(request.cursor ?? 0), items = available.slice(offset, offset + (request.limit ?? 50));
    return { items: structuredClone(items), total: available.length, nextCursor: offset + items.length < available.length ? String(offset + items.length) : null };
  },
  collaborationHistory: async (request: BotCollaborationHistoryQuery) => {
    historyCalls.push(request);
    const selected = allRelations.find(item => item.collaborationId === request.collaborationId);
    if (!selected) throw new Error('找不到协作记录');
    if (heldRelation === request.collaborationId) await new Promise<void>(resolve => { releaseRead = resolve; });
    const before = Number(request.cursor ?? Infinity);
    const ordinals = [...messages, ...events].map(item => item.ordinal).filter(ordinal => ordinal < before).sort((a, b) => a - b).slice(-(request.limit ?? 50));
    const included = new Set(ordinals);
    return { collaboration: structuredClone(selected), totalMessages: selected.messageCount,
      messages: selected.collaborationId === first.collaborationId ? structuredClone(messages.filter(item => included.has(item.ordinal))) : [{ ...messages[0], collaborationId: selected.collaborationId, messageId: 'separate-b-message', ordinal: 1, text: '协作 B 的独立回复，不应混入协作 A。' }],
      events: selected.collaborationId === first.collaborationId ? structuredClone(events.filter(item => included.has(item.ordinal))) : [],
      previews: selected.collaborationId === first.collaborationId ? [{ collaborationId: first.collaborationId, exchangeId: 'preview', senderBotId: 'target', senderDisplayName: '学习搭子', text: '流式预览不计入消息总数', updatedAt: 150000 }] : [],
      nextCursor: selected.collaborationId === first.collaborationId && (ordinals[0] ?? 0) > 1 ? String(ordinals[0]) : null,
    };
  },
  sendMessage: async (request: BotSendRequest) => {
    sendCalls.push(structuredClone(request));
    const existing = accepted.get(request.requestId);
    if (existing) return { ...existing, replayed: true };
    const receipt: BotSendReceipt = { botId: request.botId, conversationId: request.conversationId ?? '', requestId: request.requestId,
      userMessageId: `followup-user-${request.requestId}`, assistantMessageId: `followup-assistant-${request.requestId}`, replayed: false };
    accepted.set(request.requestId, receipt);
    if (failFirstReceipt) { failFirstReceipt = false; throw new Error('测试传输在宿主接收后中断，回执未知'); }
    return receipt;
  },
});
const sourceBot = useAppStore.getState().botIdentities[0];
const organizationBase = {
  organizationId: 'organization-fixture', sourceBotId: 'bot', sourceDisplayName: '并发助理',
  sourceConversationId: 'source-chat', sourceRequestId: 'source-29', sourceUserMessageId: 'source-28', sourceAssistantMessageId: 'source-29',
  createdAt: 1000, updatedAt: 99000, summary: '宿主已记录本次查找与创建。创建成功不代表任务已经接单或完成。',
  receipts: [{ receiptId: 'receipt-search', step: 'discovery', status: 'succeeded', createdAt: 1200, summary: '已读取现有 Bot 和可用能力。' }],
  totalReceipts: 1,
} satisfies Omit<Extract<BotOrganizationSummaryDto, { kind: 'discovery' }>, 'kind' | 'status' | 'matchedBotCount' | 'searchedAt'>;
const organizationTimes = { searchedAt: 1200, botCreatedAt: null, configuredAt: null, contactStartedAt: null, linkedAt: null };
const organizationTarget = { botId: 'target', displayName: '学习搭子' };
const organizationIntent = { ...organizationBase, kind: 'intent', intentId: 'organization-intent', times: organizationTimes } as const;
const organizationStates = {
  discovery: { ...organizationBase, kind: 'discovery', status: 'succeeded', matchedBotCount: 2, searchedAt: 1200 },
  unknown: { ...organizationBase, kind: 'discovery', status: 'unknown', matchedBotCount: null, searchedAt: null },
  creating: { ...organizationIntent, phase: 'creating', target: null, collaborationId: null },
  creation_failed: { ...organizationIntent, phase: 'creation_failed', target: null, collaborationId: null },
  configuring: { ...organizationIntent, phase: 'configuring', target: organizationTarget, collaborationId: null,
    times: { ...organizationTimes, botCreatedAt: 2000 } },
  configuration_failed: { ...organizationIntent, phase: 'configuration_failed', target: organizationTarget, collaborationId: null },
  ready: { ...organizationIntent, phase: 'ready', target: organizationTarget, collaborationId: null },
  contacting: { ...organizationIntent, phase: 'contacting', target: organizationTarget, collaborationId: null },
  contact_unknown: { ...organizationIntent, phase: 'contact_unknown', target: organizationTarget, collaborationId: null },
  contact_failed: { ...organizationIntent, phase: 'contact_failed', target: organizationTarget, collaborationId: null,
    times: { ...organizationTimes, botCreatedAt: 2000, configuredAt: 3000, contactStartedAt: 4000 },
    summary: '学习搭子已创建并配置；委派受理失败，可在原意图继续。',
    receipts: [{ receiptId: 'receipt-contact-failed', step: 'contact', status: 'failed', createdAt: 4100, summary: '派发暂时不可用，未创建新的执行事项。' }] },
  linked: { ...organizationIntent, phase: 'linked', target: organizationTarget, collaborationId: first.collaborationId,
    times: { ...organizationTimes, botCreatedAt: 2000, configuredAt: 3000, contactStartedAt: 4000, linkedAt: 5000 } },
  many: { ...organizationIntent, phase: 'contact_failed', target: organizationTarget, collaborationId: null,
    receipts: Array.from({ length: 40 }, (_, index) => ({ receiptId: `receipt-${index}`, step: 'contact', status: 'failed', createdAt: 4100 + index, summary: `保留的管理回执 ${index + 1}` })), totalReceipts: 47 },
} satisfies Record<string, BotOrganizationSummaryDto>;
for (const state of Object.values(organizationStates)) botOrganizationSummarySchema.parse(state);
const organizationSchemaChecks = {
  rejectsFakeDiscoveryTarget: !botOrganizationSummarySchema.safeParse({ ...organizationStates.discovery, target: organizationTarget }).success,
  rejectsMissingReadyTarget: !botOrganizationSummarySchema.safeParse({ ...organizationStates.ready, target: null }).success,
  rejectsMissingLinkedRelation: !botOrganizationSummarySchema.safeParse({ ...organizationStates.linked, collaborationId: null }).success,
  rejectsPrematureCreationTarget: !botOrganizationSummarySchema.safeParse({ ...organizationStates.creation_failed, target: organizationTarget }).success,
  rejectsOversizedReceipts: !botOrganizationSummarySchema.safeParse({ ...organizationStates.many, receipts: [...organizationStates.many.receipts, organizationStates.many.receipts[0]] }).success,
};
useAppStore.setState({ botHistories: { bot: sourceHistory }, botDraft: '尚未发送的来源草稿', botDrafts: { bot: '尚未发送的来源草稿' },
  botAttachmentDrafts: { bot: [{ name: '保留附件.txt', path: '/fixture/attachment.txt' }] },
  botIdentities: [{ ...sourceBot, organizationRole: 'primary' }, { ...sourceBot, botId: 'target', displayName: '学习搭子', organizationRole: 'ordinary' }, { ...sourceBot, botId: 'other-target', displayName: '翻译搭子', organizationRole: 'ordinary' },
    { ...sourceBot, botId: 'idle', displayName: '新助理', organizationRole: 'ordinary' }],
});
Object.assign(window, { collaborationFixture: {
  historyCalls, listCalls, sendCalls, getWorkCalls, organizationSchemaChecks,
  setOrganization: (key: keyof typeof organizationStates | null) => {
    sourceHistory.messages[29].organizations = key === null ? [] : [organizationStates[key]];
    useAppStore.setState({ botHistories: { bot: structuredClone(sourceHistory) } });
  },
  renamePrimary: (name: string) => useAppStore.setState(state => ({ botIdentities: state.botIdentities.map(bot => bot.botId === 'bot' ? { ...bot, displayName: name } : bot) })),
  setWorkStatus: (status: NonNullable<BotCollaborationDto['work']>['executionStatus'], closed = false) => {
    if (!first.work) return;
    first.work = { ...first.work, executionStatus: status, lifecycle: closed ? 'closed' : 'active', closedAt: closed ? 9000 : null,
      ...(closed ? { closureConclusion: 'succeeded' } : { closureConclusion: undefined }) };
    first.times.returnedAt = closed ? 11000 : 6200;
    useAppStore.setState({ botHistories: { bot: structuredClone(sourceHistory) } });
  },
  setExecutionTimes: (startedAt: number | null, endedAt: number | null) => {
    if (!first.work) return;
    first.work = { ...first.work, startedAt, endedAt };
    useAppStore.setState({ botHistories: { bot: structuredClone(sourceHistory) } });
  },
  acceptedCount: () => accepted.size,
  finishIncomingQuestion: () => { incomingQuestion.status = 'returned'; incomingQuestion.messageCount = 2;
    incomingQuestion.replyPreview = '19 × 23 = 437'; incomingQuestion.times.returnedAt = 6500; },
  hold: (id: string) => { heldRelation = id; },
  release: () => { heldRelation = undefined; releaseRead?.(); releaseRead = undefined; },
  sourceState: () => ({ draft: useAppStore.getState().botDraft, attachments: useAppStore.getState().botAttachmentDrafts.bot }),
  selectTarget: () => { useAppStore.getState().setActiveBotId('target'); },
  selectIdle: () => { useAppStore.getState().setActiveBotId('idle'); },
} });
