import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BotCallDto, BotMessageDto } from '../src/shared/bot-conversation';
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
