import assert from 'node:assert/strict';
import type { GatewayInboundMessage } from '../src/main/gateway/channels';
import { DiscordGatewayAdapter, type DiscordSocket } from '../src/main/gateway/DiscordGatewayAdapter.ts';
let interruptResume = false;
let holdResume = false;
let continueResume: (() => void) | undefined;
class Socket implements DiscordSocket {
  onmessage: DiscordSocket['onmessage'] = null;
  onclose: DiscordSocket['onclose'] = null;
  onerror: DiscordSocket['onerror'] = null;
  sent: Array<{ op: number; d: Record<string, unknown> }> = [];
  send(value: string): void {
    const frame = JSON.parse(value); this.sent.push(frame);
    if (frame.op === 2) queueMicrotask(() => this.frame({ op: 0, t: 'READY', s: 1,
      d: { user: { id: '100', bot: true }, application: { id: '200' }, session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' } }));
    if (frame.op === 6) queueMicrotask(() => {
      this.frame({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: { id: '8', channel_id: '500', guild_id: '400',
        author: { id: '300' }, mentions: [{ id: '100' }], content: '<@100> replay before resumed' } });
      if (interruptResume) { interruptResume = false; this.close(); return; }
      const finishResume = (): void => { this.frame({ op: 0, t: 'RESUMED', s: 5, d: {} }); };
      if (holdResume) continueResume = finishResume;
      else finishResume();
    });
  }
  frame(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(): void { this.onclose?.({ code: 1000 }); }
}
const sockets: Socket[] = [];
const requests: Array<{ path: string; body?: Record<string, unknown>; auth: string | undefined }> = [];
let bot = true, applicationId = '200', limited = false, retryCount = 0;
const adapter = new DiscordGatewayAdapter('channel', 'Discord', {
  reconnectDelayMs: 1,
  socketFactory: () => { const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.frame({ op: 10, d: { heartbeat_interval: 1000 } })); return socket; },
  fetch: (async (url, init) => {
    const path = String(url).split('/v10')[1];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body, auth: (init?.headers as Record<string, string>)?.Authorization });
    if (path === '/users/@me') return Response.json({ id: '100', bot });
    if (path === '/oauth2/applications/@me') return Response.json({ id: applicationId });
    if (path === '/gateway/bot') return Response.json({ url: 'wss://gateway.discord.gg', session_start_limit: { remaining: 10 } });
    if (limited && retryCount++ === 0) return Response.json({ retry_after: 0.001 }, { status: 429 });
    return Response.json({ id: '900' });
  }) as typeof fetch,
});
const config = { botToken: 'test-secret', applicationId: '200', allowUsers: ['300'], guildIds: ['400'], allowDirectMessages: true };
const inbound: Array<{ chatId: string; text: string; reply: (text: string) => Promise<void> }> = [];
adapter.setInboundHandler(async message => {
  assert(adapter.workConnectionKey(), 'every replay delivery requires a connected identity');
  inbound.push(message);
});
const tick = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 10)); };
const event = (id: string, override: Record<string, unknown> = {}): void => sockets.at(-1)!.frame({ op: 0, t: 'MESSAGE_CREATE', s: 3,
  d: { id, channel_id: '500', guild_id: '400', author: { id: '300' }, mentions: [{ id: '100' }], content: '<@100> hello', ...override } });
await assert.rejects(adapter.connect({ ...config, allowUsers: [] }), /允许用户/);
bot = false; await assert.rejects(adapter.connect(config), /官方 Bot/); bot = true;
applicationId = '201'; await assert.rejects(adapter.connect(config), /官方 Bot/); applicationId = '200';
await adapter.connect(config);
assert(adapter.isConnected());
assert.equal(sockets.at(-1)!.sent[0].d.intents, 1 | 512 | 4096);
event('1'); event('1'); event('2', { author: { id: '301' } }); event('3', { guild_id: '401' });
event('4', { author: { id: '300', bot: true } }); event('5', { mentions: [] }); event('6', { webhook_id: '999' });
await tick(); assert.equal(inbound.length, 1); assert.equal(inbound[0].text, 'hello');
limited = true; await inbound[0].reply('@everyone test-secret');
const reply = requests.filter(row => row.body).at(-1)!;
assert.equal(reply.auth, 'Bot test-secret');
assert.equal(reply.body?.content, '@everyone [凭据已隐藏]');
assert.deepEqual(reply.body?.allowed_mentions, { parse: [], replied_user: false });
assert.equal(reply.body?.enforce_nonce, true); assert.equal(retryCount, 2);
interruptResume = true;
sockets.at(-1)!.close(); await tick(); await tick(); assert(adapter.isConnected());
const resumes = sockets.flatMap(socket => socket.sent).filter(frame => frame.op === 6);
assert.equal(resumes.length, 2);
assert.equal(resumes[0].d.seq, 3);
assert.equal(resumes[1].d.seq, 3, 'interrupted replay must not advance the committed sequence');
assert.equal(inbound.length, 2);
assert.equal(inbound[1].text, 'replay before resumed');
assert(adapter.workConnectionKey(), 'replay dispatch must have a connected identity');
assert.equal(sockets.at(-1)!.sent[0].op, 6);
event('1'); event('7', { guild_id: undefined, mentions: [], content: 'DM' }); await tick();
assert.equal(inbound.length, 3); assert.notEqual(inbound[0].chatId, inbound[2].chatId);
const oldReply = inbound[0].reply; await adapter.disconnect(); await adapter.connect(config);
const count = requests.length; await assert.rejects(oldReply('must not send'), /连接已更换/); assert.equal(requests.length, count);
// Production Gateway checks workConnectionKey before entering a task. The second
// same-chat delivery must wait while the first finishes during a lost connection.
let finishFirst!: () => void;
const firstPending = new Promise<void>(resolve => { finishFirst = resolve; });
const entered: string[] = [];
adapter.setInboundHandler(async message => {
  if (!adapter.workConnectionKey()) throw new Error('Gateway missing connected identity');
  entered.push(message.messageId!);
  if (message.messageId === '20') await firstPending;
  if (message.messageId === '22') throw new Error('failure after execution started');
});
event('20'); event('21'); await tick();
assert.deepEqual(entered, ['20']);
holdResume = true; sockets.at(-1)!.close(); finishFirst(); await tick();
assert.equal(adapter.workConnectionKey(), undefined);
assert.deepEqual(entered, ['20'], 'queued turn must not enter Gateway while disconnected');
event('21'); // Official replay arrives before RESUMED while the original is queued.
assert(continueResume); holdResume = false; continueResume(); await tick();
assert.deepEqual(entered, ['20', '21'], 'pending delivery executes exactly once after recovery');
event('21'); event('22'); await tick(); event('22'); await tick();
assert.deepEqual(entered, ['20', '21', '22'], 'executed failures stay deduplicated');
// Once the durable inbox accepts a delivery, adapter preparation queues must let
// later messages reach that inbox while Registry serializes native execution.
{
  const acceptedMessages: GatewayInboundMessage[] = [];
  let finish!: () => void;
  const longTurn = new Promise<void>(resolve => { finish = resolve; });
  adapter.setInboundHandler(message => { acceptedMessages.push(message);
    return Object.assign(message.messageId === '30' ? longTurn : Promise.resolve(), { accepted: Promise.resolve() });
  });
  event('30'); event('31'); await tick();
  assert.deepEqual(acceptedMessages.map(message => message.messageId), ['30', '31']);
  finish(); await tick();
  const first = acceptedMessages[0];
  const restored = adapter.restoreGatewayReply({ deliveryId:'persisted-discord',chatId:first.chatId,messageId:first.messageId!,sender:first.sender,route:first.replyRoute });
  assert.ok(restored); await restored('durable reply'); await restored('durable reply');
  assert.equal(requests.at(-1)?.body?.nonce, requests.at(-2)?.body?.nonce, 'same outbox delivery keeps its provider nonce');
  assert.equal(adapter.restoreGatewayReply({ deliveryId:'persisted-discord',chatId:'wrong-room',messageId:first.messageId!,sender:first.sender,route:first.replyRoute }), undefined);
  let attempts = 0;
  adapter.setInboundHandler(() => { attempts++;
    const result = attempts === 1 ? Promise.reject(new Error('inbox unavailable')) : Promise.resolve();
    return Object.assign(result, { accepted: result });
  });
  event('32'); await tick(); event('32'); await tick(); event('32'); await tick();
  assert.equal(attempts, 2, 'failed admission is redeliverable; committed admission is deduplicated');
}
sockets.at(-1)!.onclose?.({ code: 4014 }); await tick(); assert.equal(adapter.isConnected(), false); assert.match(adapter.statusText(), /Intents/);
await adapter.disconnect();
console.log('Discord gateway: identity, intents, allowlists, dedup, mention/DM, resume, rate limit, secret redaction and stale replies PASS');
