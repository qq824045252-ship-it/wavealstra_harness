import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BotCallDto, BotMessageDto } from '../src/shared/bot-conversation';
import type { BotCollaborationDto } from '../src/shared/bot-collaboration';
import type { WorkProjectionDto } from '../src/shared/bot-work';
import { BotCallThread } from '../src/renderer/src/components/pages/BotCallThread';
import { BotMessage } from '../src/renderer/src/components/pages/BotWorkspacePage';

const call: BotCallDto = { callId: 'call-learning', sourceBotId: 'manager', sourceDisplayName: '总管',
  targetBotId: 'learning', targetDisplayName: '学习搭子', requestText: '今天学到了什么？',
  replyText: '我今天学习了事务隔离。', status: 'completed', createdAt: 1, updatedAt: 2 };
const render = (calls?: BotCallDto[]) => renderToStaticMarkup(<BotCallThread calls={calls} />);
assert.equal(render(), '');
assert.equal(render([]), '');
const completed = render([call]);
assert.match(completed, /<details[^>]*><summary>/, 'native disclosure supports keyboard expansion');
assert.doesNotMatch(completed, /<details[^>]*\bopen\b/, 'starts collapsed');
assert.match(completed, /2 条消息，与 学习搭子/);
assert(completed.slice(0, completed.indexOf('</summary>')).includes('已收到 @学习搭子 的回复'), 'completed state remains visible without expanding');
assert.match(completed, /总管<\/strong><span>→ @学习搭子/);
assert.match(completed, /学习搭子<\/strong><span>回复 总管/);
assert.match(completed, /我今天学习了事务隔离。/);
const multiple = render([call, { ...call, callId: 'call-erp', targetBotId: 'erp', targetDisplayName: 'ERP 后端', replyText: undefined, status: 'running' }]);
assert.match(multiple, /3 条消息，与 2 个 Bot/);
assert.match(multiple, /正在联系 @ERP 后端/);
assert.match(render([call, { ...call, callId: 'second' }]), /4 条消息，与 学习搭子/);
for (const [status, text] of [['queued', '等待联系'], ['running', '正在联系'], ['failed', '失败：连接被拒绝 ECONNREFUSED'], ['cancelled', '已取消联系'], ['unknown', '通信状态待核实']] as const) {
  const html = render([{ ...call, status, replyText: undefined, error: '连接被拒绝 ECONNREFUSED' }]);
  assert.match(html, /1 条消息/);
  assert.ok(html.slice(0, html.indexOf('</summary>')).includes(text), `${status} is visible while collapsed`);
  assert.doesNotMatch(html, /class="bot-call-reply"/, 'missing replies are not fabricated');
}
assert.match(render([{ ...call, replyText: '   ' }]), /1 条消息/);
assert.match(render([{ ...call, replyText: '' }]), /未返回文本回复/);
assert.match(render([{ ...call, requestText: '', replyText: '' }]), /0 条消息/);
assert.match(render([{ ...call, requestText: '<script>bad()</script>', replyText: '<img src=x onerror=bad()>' }]), /&lt;script&gt;/);
assert.doesNotMatch(render([{ ...call, replyText: '<script>bad()</script>' }]), /<script>/);

const message: BotMessageDto = { messageId: 'parent-one', conversationId: 'chat', botId: 'manager', requestId: 'request-one',
  ordinal: 1, role: 'assistant', text: '已询问学习搭子。', status: 'completed', workIds: [], createdAt: 1, updatedAt: 2, botCalls: [call] };
const renderMessage = (value: BotMessageDto) => renderToStaticMarkup(<BotMessage message={value} botName="总管" works={[]} onOpenWork={() => {}} onCancel={() => {}} />);
assert.match(renderMessage(message), /2 条消息，与 学习搭子/);
assert.doesNotMatch(renderMessage({ ...message, role: 'user' }), /bot-call-thread/, 'only assistant messages show host call threads');
assert.doesNotMatch(renderMessage({ ...message, botCalls: undefined }), /bot-call-thread/, 'model mentions alone never create calls');
const second = renderMessage({ ...message, messageId: 'parent-two', requestId: 'request-two', botCalls: [{ ...call, callId: 'independent', targetBotId: 'erp', targetDisplayName: 'ERP 后端', requestText: '独立问题', replyText: undefined, status: 'running' }] });
assert.match(second, /1 条消息，与 ERP 后端/);
assert.doesNotMatch(second, /data-call-id="call-learning"|我今天学习了事务隔离。/, 'concurrent parent messages do not mix records');
console.log('bot-call-thread rendering: PASS');

// A collaboration entry names the delegated Work on both sides, and a reply to a
// peer request opens with the host-recorded acceptance reference.
const collaboration: BotCollaborationDto = { collaborationId: 'relation-one', userId: 'user', sourceBotId: 'manager',
  sourceDisplayName: '总管', sourceConversationId: 'chat', sourceRequestId: 'request-one', sourceUserMessageId: 'user-one',
  sourceAssistantMessageId: 'parent-one', targetBotId: 'learning', targetDisplayName: '学习搭子', workId: 'work-poster',
  createdAt: 1, updatedAt: 2, messageCount: 2, status: 'returned', originAvailable: true,
  times: { sentAt: 1, deliveredAt: 2, acceptedAt: 3, startedAt: 4, endedAt: 5, returningAt: 6, returnedAt: 7 },
  work: { workId: 'work-poster', title: '制作海洋保护 HTML 海报', lifecycle: 'active', executionStatus: 'running',
    startedAt: 4, endedAt: null, closedAt: null } };
const collaborationHtml = renderToStaticMarkup(<BotCallThread collaborations={[collaboration]} viewerBotId="manager" />);
assert.match(collaborationHtml, /class="bot-collaboration-summary-work"[^>]*>「制作海洋保护 HTML 海报」</, 'the delegated task name is visible');
assert.match(collaborationHtml, /aria-label="查看与 学习搭子 的协作记录，委托「制作海洋保护 HTML 海报」，2 条消息"/);
const recipientHtml = renderToStaticMarkup(<BotCallThread collaborations={[collaboration]} viewerBotId="learning" />);
assert.match(recipientHtml, /「制作海洋保护 HTML 海报」/, 'the accepting side names the same delegated task');
const withoutWork = renderToStaticMarkup(<BotCallThread collaborations={[{ ...collaboration, workId: null, work: undefined }]} viewerBotId="manager" />);
assert.doesNotMatch(withoutWork, /bot-collaboration-summary-work/, 'no Work means no invented task name');
assert.match(withoutWork, /已返回/, 'the receipt stays visible without a Work');

const delegatedWork: WorkProjectionDto = { workId: 'work-poster', title: '制作海洋保护 HTML 海报', ownerBotId: 'learning',
  mode: 'once', lifecycle: 'active', ownerEpoch: 1, intentRevision: 1, sourceVersion: 1, stateVersion: 1,
  inputSnapshotId: 'peer-input', inputSnapshotBound: true, goalSources: [], criteria: [], acceptedDeliverableIds: [],
  deliverables: [], blockers: [], executions: [], notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: [], updatedAt: 9 };
const delegationOrigin = { kind: 'request' as const, collaborationId: 'relation-one', exchangeId: 'peer-exchange',
  senderBotId: 'manager', senderDisplayName: '总管', sourceBotId: 'manager', sourceConversationId: 'chat',
  sourceRequestId: 'request-one', sourceUserMessageId: 'user-one', sourceAssistantMessageId: 'parent-one' };
const delegation: BotMessageDto = { messageId: 'peer-accept', conversationId: 'peer-chat', botId: 'learning', requestId: 'peer-request',
  ordinal: 1, role: 'assistant', text: '已受理，正在制作海报。', status: 'completed', workIds: ['work-poster'],
  peerOrigin: delegationOrigin, createdAt: 1, updatedAt: 2 };
const renderDelegation = (value: BotMessageDto, works: WorkProjectionDto[] = [delegatedWork]) => renderToStaticMarkup(
  <BotMessage message={value} botName="学习搭子" works={works} onOpenWork={() => {}} onCancel={() => {}} />);
const acceptedHtml = renderDelegation(delegation);
assert.match(acceptedHtml, /class="bot-reply-reference bot-delegation-reference"/);
assert.match(acceptedHtml, /接受委托<\/span><span class="bot-reply-reference-preview">制作海洋保护 HTML 海报/);
assert.ok(acceptedHtml.indexOf('bot-delegation-reference') < acceptedHtml.indexOf('bot-assistant-content'), 'the delegated task precedes the answer');
assert.doesNotMatch(acceptedHtml, /<details class="bot-reply-reference bot-delegation-reference" open/, 'the reference starts collapsed like a quote');
assert.match(renderDelegation(delegation, []), /来自 总管/, 'a Work that is not loaded still names the sender');
assert.doesNotMatch(renderDelegation({ ...delegation, peerOrigin: undefined }), /bot-delegation-reference/, 'ordinary replies claim no delegation');
assert.doesNotMatch(renderDelegation({ ...delegation, peerOrigin: { ...delegationOrigin, kind: 'return', replyMessageId: 'reply' } }), /bot-delegation-reference/, 'returned collaboration results are not a new acceptance');
console.log('bot delegation reference: PASS');
