import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import GatewayBotBindings from '../src/renderer/src/components/settings/GatewayBotBindings';
import type { GatewayBotBinding, GatewayBotBindingRequest } from '../src/shared/gateway-bot-binding';
const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
const document = window.document;
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
let channels = [
  { id: 'qq', name: 'QQ', connected: true, bindingRevision: 'c'.repeat(64), bindingConnectionKey: 'a'.repeat(64) },
  { id: 'slack', name: 'Slack', connected: false, bindingRevision: undefined as string | undefined, bindingConnectionKey: undefined as string | undefined },
  { id: 'weixin', name: '微信', connected: true, bindingRevision: 'c'.repeat(64), bindingConnectionKey: 'a'.repeat(64) },
];
let bindings: Record<string, GatewayBotBinding> = {
  qq: { botId: 'a', ownerSenderIds: ['owner-qq'], connectionKey: 'a'.repeat(64) },
  slack: { botId: 'gone', ownerSenderIds: ['owner-slack'], connectionKey: 'b'.repeat(64) },
};
let calls: GatewayBotBindingRequest[] = [];
let fail = false;
let hold: (() => void) | undefined;
const listeners = new Set<(event: any) => void>();
Object.assign(window, { api: {
  agent: { getAppSettings: async () => ({ gatewayBotBindings: structuredClone(bindings) }) },
  botWork: { listBots: async () => [{ botId: 'a', displayName: '学习搭子', status: 'active' }, { botId: 'b', displayName: '编程专家', status: 'active' }] },
  gateway: {
    status: async () => ({ channels: structuredClone(channels) }),
    onEvent: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    listMessages: async ({ channelId }: { channelId: string }) => [{ direction: 'in', senderId: `${channelId}-owner`, senderName: '本人' }],
    configureBotBinding: async (request: GatewayBotBindingRequest) => {
      calls.push(request);
      if (fail) throw new Error('保存失败');
      if (hold) await new Promise<void>(resolve => { hold = resolve; });
      if (request.action === 'unbind') delete bindings[request.channelId];
      else bindings[request.channelId] = { botId: request.botId, ownerSenderIds: request.ownerSenderIds, connectionKey: channels.find(item => item.id === request.channelId)!.bindingConnectionKey! };
      return structuredClone(bindings);
    },
  },
} });
const button = (text: string, scope: ParentNode = document) => {
  const result = [...scope.querySelectorAll('button')].find(item => item.textContent === text);
  assert.ok(result, `button ${text} exists`); return result as HTMLButtonElement;
};
const row = (id: string) => { const result = document.querySelector(`[data-channel-id="${id}"]`); assert.ok(result); return result; };
const editor = () => document.querySelector('.gateway-assistant-editor');
async function choose(select: HTMLSelectElement, value: string) {
  Object.defineProperty(select, 'value', { value, configurable: true });
  await act(async () => select.dispatchEvent(new window.Event('change', { bubbles: true })));
}
async function main() {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<GatewayBotBindings />));
  assert.equal(document.querySelectorAll('.gateway-assistant-binding').length, 2);
  assert.equal(editor(), null, 'saved bindings do not reopen a creation form');
  assert.match(row('qq').textContent!, /学习搭子.*owner-qq/);
  assert.match(row('slack').textContent!, /不可用.*owner-slack/);
  assert.equal(button('解除绑定', row('slack')).disabled, false, 'offline/invalid bindings remain manageable');
  await act(async () => button('编辑绑定', row('qq')).click());
  assert.equal((editor()!.querySelector('select') as HTMLSelectElement).disabled, true, 'editing cannot silently replace another channel');
  await act(async () => button('取消').click());
  assert.equal(calls.length, 0, 'cancel does not save');
  await act(async () => button('编辑绑定', row('qq')).click());
  await choose(editor()!.querySelectorAll('select')[1] as HTMLSelectElement, 'b');
  fail = true;
  await act(async () => button('保存绑定').click());
  assert.ok(editor(), 'save failure retains draft');
  assert.match(document.querySelector('[role=alert]')!.textContent!, /保存失败/);
  fail = false;
  channels = channels.map(item => item.id === 'qq' ? { ...item, connected: false, bindingRevision: undefined as string | undefined, bindingConnectionKey: undefined as string | undefined } : item);
  await act(async () => { for (const callback of listeners) callback({ direction: 'system', channelId: 'qq' }); });
  assert.equal(button('保存绑定').disabled, true, 'disconnection prevents binding identity rewrite');
  channels = channels.map(item => item.id === 'qq' ? { ...item, connected: true, bindingRevision: 'c'.repeat(64), bindingConnectionKey: 'a'.repeat(64) } : item);
  await act(async () => { for (const callback of listeners) callback({ direction: 'system', channelId: 'qq' }); });
  assert.equal((editor()!.querySelectorAll('select')[1] as HTMLSelectElement).value, 'b', 'status refresh preserves draft');
  await act(async () => button('保存绑定').click());
  assert.equal(editor(), null);
  assert.equal(bindings.qq.botId, 'b');
  assert.equal(calls.at(-1)?.action === 'bind' && (calls.at(-1) as any).connectionRevision, 'c'.repeat(64));
  assert.deepEqual(bindings.qq.ownerSenderIds, ['owner-qq']);
  assert.match(row('qq').textContent!, /编程专家/);
  await act(async () => button('编辑绑定', row('qq')).click());
  channels = channels.map(item => item.id === 'qq' ? { ...item, bindingRevision: 'd'.repeat(64), bindingConnectionKey: 'b'.repeat(64) } : item);
  await act(async () => { for (const callback of listeners) callback({ direction: 'system', channelId: 'qq' }); });
  assert.equal(button('保存绑定').disabled, true, 'account/connection change invalidates old identity selection');
  await act(async () => button('重新选择本人账号').click());
  assert.equal(editor()!.querySelectorAll('.gateway-assistant-account-chip').length, 0, 'explicit reset clears old sender IDs');
  assert.equal(button('保存绑定').disabled, true, 'reset must select a sender again');
  await act(async () => { for (const callback of listeners) { callback({ direction: 'in', channelId: 'qq', senderId: 'old-owner', bindingConnectionKey: 'a'.repeat(64) }); callback({ direction: 'in', channelId: 'qq', senderId: 'unverified-owner' }); } });
  assert.equal(editor()!.querySelectorAll('select')[2].querySelectorAll('option').length, 1, 'old-account and unverified senders must not be selectable');
  await act(async () => { for (const callback of listeners) callback({ direction: 'in', channelId: 'qq', senderId: 'replacement-owner', bindingConnectionKey: 'b'.repeat(64) }); });
  await choose(editor()!.querySelectorAll('select')[2] as HTMLSelectElement, 'replacement-owner');
  await act(async () => button('保存绑定').click());
  assert.deepEqual(bindings.qq.ownerSenderIds, ['replacement-owner']);
  channels = channels.map(item => item.id === 'qq' ? { ...item, bindingRevision: 'e'.repeat(64), bindingConnectionKey: 'd'.repeat(64) } : item);
  await act(async () => { for (const callback of listeners) callback({ direction: 'system', channelId: 'qq' }); });
  assert.match(row('qq').textContent!, /需重新绑定/);
  await act(async () => button('编辑绑定', row('qq')).click());
  assert.equal(editor()!.querySelectorAll('.gateway-assistant-account-chip').length, 0, 'new editor never reuses old account sender IDs');
  assert.equal(button('保存绑定').disabled, true);
  await act(async () => button('取消').click());
  const before = calls.length;
  hold = () => {};
  await act(async () => { const remove = button('解除绑定', row('slack')); remove.click(); remove.click(); });
  assert.equal(calls.length, before + 1, 'same-tick repeated actions are serialized');
  await act(async () => { hold!(); hold = undefined; });
  assert.equal(document.querySelector('[data-channel-id=slack]'), null);
  assert.ok(bindings.qq, 'unrelated binding preserved');
  await act(async () => button('新增绑定').click());
  const channelSelect = editor()!.querySelector('select') as HTMLSelectElement;
  assert.equal([...channelSelect.options].some(item => item.value === 'qq'), false, 'new binding cannot overwrite saved channel');
  await choose(channelSelect, 'weixin');
  await choose(editor()!.querySelectorAll('select')[1] as HTMLSelectElement, 'a');
  await act(async () => { for (const callback of listeners) callback({ direction: 'in', channelId: 'weixin', senderId: 'weixin-owner', bindingConnectionKey: channels.find(item => item.id === 'weixin')!.bindingConnectionKey }); });
  await choose(editor()!.querySelectorAll('select')[2] as HTMLSelectElement, 'weixin-owner');
  await act(async () => button('保存绑定').click());
  assert.deepEqual(bindings.weixin.ownerSenderIds, ['weixin-owner']);
  await act(async () => root.unmount());
  assert.equal(listeners.size, 0, 'unmount releases subscriptions');
  console.log('gateway binding management DOM PASS: saved list, offline/invalid entries, edit/cancel/failure, refresh retains drafts, identity guard, repeated-click guard, add, remove, cleanup');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
