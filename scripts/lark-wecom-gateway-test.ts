import assert from 'node:assert/strict';
import { createFeishuLongConnection } from '../src/main/gateway/FeishuLongConnection';
import { FeishuChannelAdapter, WecomChannelAdapter, type GatewayInboundMessage } from '../src/main/gateway/channels';
import { WecomSmartRobot, type WecomSocket } from '../src/main/gateway/WecomSmartRobot';
import { WxCrypt } from '../src/main/gateway/wx-crypt';
const tick = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', access_token: 'token', expire: 7200, data: { message_id: 'sent' } }));
try {
  let readySignal: (() => void) | undefined;
  let sdkClosed = 0;
  const connection = createFeishuLongConnection('app', 'secret', options => {
    assert.equal(options.autoReconnect, false);
    readySignal = () => options.logger?.debug?.('[ws]', 'ws connect success');
    return { async start() {}, close() { sdkClosed++; } };
  });
  let ready = false;
  const starting = connection.start(async () => {}).then(() => { ready = true; });
  await tick(); assert.equal(ready, false); readySignal!(); await starting; assert.equal(ready, true);
  connection.close(); assert.equal(sdkClosed, 1);
  const cancelled = createFeishuLongConnection('app', 'secret', () => ({ async start() {}, close() {} }));
  const pendingStart = cancelled.start(async () => {}); cancelled.close(); await assert.rejects(() => pendingStart);
  let onEvent: (event: unknown) => Promise<void> = async () => {};
  let closed = 0;
  const messages: GatewayInboundMessage[] = [];
  const feishu = new FeishuChannelAdapter('feishu-default', '飞书', () => ({
    async start(handler) { onEvent = handler; }, close() { closed++; },
  }));
  feishu.setInboundHandler(async msg => { messages.push(msg); });
  await feishu.connect({ appId: 'app', appSecret: 'secret', transport: 'websocket' });
  assert.ok(feishu.isConnected());
  const event = { message: { chat_id: 'room', message_id: 'msg', message_type: 'text', content: JSON.stringify({ text: 'hello' }) }, sender: { sender_type: 'user', sender_id: { open_id: 'user' } } };
  await onEvent(event); assert.equal(messages.length, 1); assert.equal(messages[0].text, 'hello');
  await onEvent({ ...event, message: { ...event.message, message_type: 'image' } }); assert.equal(messages.length, 1);
  await onEvent({ ...event, sender: { sender_type: 'app' } }); assert.equal(messages.length, 1);
  await assert.rejects(() => feishu.handleWebhookPayload({ type: 'url_verification', token: '', challenge: 'x' }));
  let deferredEvent: (event: unknown) => Promise<void> = async () => {};
  const deferredFeishu = new FeishuChannelAdapter('feishu-default', '飞书', () => ({ async start(handler) { deferredEvent = handler; }, close() {} }), { deferInboundUntilActivated: true });
  let deferredCount = 0;
  deferredFeishu.setInboundHandler(async () => { deferredCount++; });
  await deferredFeishu.connect({ appId: 'app', appSecret: 'secret', transport: 'websocket' });
  assert.equal(deferredFeishu.workConnectionKey(), undefined);
  let acknowledged = false;
  const waitingEvent = deferredEvent(event).then(() => { acknowledged = true; });
  await tick(); assert.equal(deferredCount, 0); assert.equal(acknowledged, false);
  deferredFeishu.activate(); await waitingEvent; assert.equal(deferredCount, 1); assert.ok(deferredFeishu.workConnectionKey());
  await deferredFeishu.disconnect();
  const previousEvent = onEvent;
  await feishu.disconnect(); await previousEvent(event); assert.equal(messages.length, 1); assert.equal(closed, 1);
  await assert.rejects(() => messages[0].reply('stale'));
  await feishu.connect({ appId: 'app', appSecret: 'secret', verificationToken: 'verify' });
  assert.deepEqual(await feishu.handleWebhookPayload({ type: 'url_verification', token: 'verify', challenge: 'ok' }), { challenge: 'ok' });
  await assert.rejects(() => feishu.handleWebhookPayload({ schema: '2.0', header: { token: 'bad', app_id: 'app' }, event }));
  await feishu.handleWebhookPayload({ schema: '2.0', header: { token: 'verify', app_id: 'app', event_type: 'im.message.receive_v1' }, event });
  assert.equal(messages.length, 2); await feishu.disconnect();

  class Socket implements WecomSocket {
    onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    sent: Array<{ cmd: string; headers: { req_id: string }; body: Record<string, unknown> }> = [];
    autoAck = true; subscribeCode = 0; closed = false;
    send(raw: string): void {
      const frame = JSON.parse(raw); this.sent.push(frame);
      if (this.autoAck) queueMicrotask(() => this.frame({ headers: frame.headers, errcode: frame.cmd === 'aibot_subscribe' ? this.subscribeCode : 0 }));
    }
    frame(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
    close(): void { this.closed = true; }
  }
  const sockets: Socket[] = [];
  const options = { socketFactory: (url: string): Socket => {
    assert.equal(url, 'wss://openws.work.weixin.qq.com'); const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.onopen?.()); return socket;
  }, requestTimeoutMs: 50, reconnectDelayMs: 1, heartbeatMs: 10000 };
  const smart = new WecomChannelAdapter('wecom-default', '企微', options);
  const received: GatewayInboundMessage[] = [];
  smart.setInboundHandler(async msg => { received.push(msg); await msg.reply('answer'); });
  await smart.connect({ mode: 'smart', botId: 'bot', secret: 'secret' });
  assert.ok(smart.isConnected()); const key = smart.workConnectionKey(); assert.ok(key);
  const callback = (req: string, id: string) => ({ cmd: 'aibot_msg_callback', headers: { req_id: req }, body: { msgid: id, chattype: 'group', chatid: 'room', from: { userid: 'user' }, msgtype: 'text', text: { content: '@bot hello' } } });
  sockets[0].frame(callback('req-1', 'msg-1')); sockets[0].frame(callback('req-2', 'msg-2')); sockets[0].frame(callback('req-1', 'msg-1'));
  await tick(); await tick();
  assert.equal(received.length, 2); assert.equal(received[0].text, 'hello'); assert.equal(received[0].workTarget, undefined);
  assert.deepEqual(sockets[0].sent.filter(f => f.cmd === 'aibot_respond_msg').map(f => f.headers.req_id), ['req-1', 'req-2']);
  sockets[0].onclose?.(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2); assert.ok(smart.isConnected()); assert.equal(smart.workConnectionKey(), key);
  await assert.rejects(() => received[0].reply('stale'));
  const lateFrame = sockets[1].onmessage;
  await smart.disconnect(); lateFrame?.({ data: JSON.stringify(callback('late', 'late')) }); await tick(); assert.equal(received.length, 2);
  assert.ok(sockets.every(s => s.closed));

  const deferredSmart = new WecomChannelAdapter('wecom-default', '企微', { ...options, deferInboundUntilActivated: true });
  let smartCount = 0;
  deferredSmart.setInboundHandler(async () => { smartCount++; });
  await deferredSmart.connect({ mode: 'smart', botId: 'bot', secret: 'secret' });
  assert.equal(deferredSmart.workConnectionKey(), undefined);
  sockets.at(-1)!.frame(callback('early', 'early')); await tick(); assert.equal(smartCount, 0);
  deferredSmart.activate(); await tick(); assert.equal(smartCount, 1); assert.ok(deferredSmart.workConnectionKey());
  await deferredSmart.disconnect();
  const rejected = new WecomSmartRobot('wecom-default', { ...options, socketFactory: () => {
    const socket = new Socket(); socket.subscribeCode = 403; queueMicrotask(() => socket.onopen?.()); return socket;
  } });
  await assert.rejects(() => rejected.connect({ botId: 'bot', secret: 'bad' })); assert.equal(rejected.isConnected(), false);
  const hanging = new WecomSmartRobot('wecom-default', { ...options, socketFactory: () => new Socket() });
  const connecting = hanging.connect({ botId: 'bot', secret: 'secret' }); await tick(); await hanging.disconnect(); await assert.rejects(() => connecting);

  // Unicode boundaries preserve the original text, including a pair spanning code unit 4000.
  const unicodeRobot = new WecomSmartRobot('wecom-default', options);
  const unicodeText = 'a'.repeat(3999) + '😀' + '文'.repeat(3999) + '🚀';
  unicodeRobot.setInboundHandler(async msg => { await msg.reply(unicodeText); });
  await unicodeRobot.connect({ botId: 'bot', secret: 'secret' });
  const unicodeSocket = sockets.at(-1)!;
  unicodeSocket.frame(callback('unicode', 'unicode')); await tick(); await tick();
  const chunks = unicodeSocket.sent.filter(f => f.cmd === 'aibot_respond_msg').map(f => (f.body.markdown as { content: string }).content);
  assert.equal(chunks.join(''), unicodeText); assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4000);
    assert.equal(/[\uD800-\uDBFF]$/.test(chunk), false);
    assert.equal(/^[\uDC00-\uDFFF]/.test(chunk), false);
  }
  await unicodeRobot.disconnect();

  // Per-chat and global limits include running + queued turns. Overflow closes intake,
  // and must not poison dedupe when the rejected message is redelivered after reconnect.
  for (const globalLimit of [false, true]) {
    const bounded = new WecomSmartRobot('wecom-default', options);
    let release: () => void = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let handled = 0;
    bounded.setInboundHandler(async () => { handled++; await blocked; });
    await bounded.connect({ botId: 'bot', secret: 'secret' });
    const boundedSocket = sockets.at(-1)!;
    const limit = globalLimit ? 1024 : 64;
    for (let index = 0; index < limit; index++) {
      const frame = callback(`bounded-${index}`, `bounded-${index}`);
      if (globalLimit) frame.body.chatid = `room-${index}`;
      boundedSocket.frame(frame);
    }
    assert.equal(bounded.isConnected(), true);
    await tick(); assert.equal(handled, globalLimit ? limit : 1);
    const overflow = callback('overflow', 'overflow');
    if (globalLimit) overflow.body.chatid = 'another-room';
    boundedSocket.frame(overflow);
    assert.equal(bounded.isConnected(), false); assert.equal(boundedSocket.closed, true);
    assert.match(bounded.statusText(), /队列已满/);
    release(); await tick();
    const before = handled;
    bounded.setInboundHandler(async () => { handled++; });
    await bounded.connect({ botId: 'bot', secret: 'secret' });
    sockets.at(-1)!.frame(overflow); await tick();
    assert.equal(handled, before + 1);
    await bounded.disconnect();
  }
  const earlyBounded = new WecomSmartRobot('wecom-default', { ...options, deferInboundUntilActivated: true });
  await earlyBounded.connect({ botId: 'bot', secret: 'secret' });
  const earlySocket = sockets.at(-1)!;
  for (let index = 0; index <= 100; index++) earlySocket.frame(callback(`early-${index}`, `early-${index}`));
  assert.equal(earlyBounded.isConnected(), false); assert.equal(earlySocket.closed, true);
  assert.match(earlyBounded.statusText(), /队列已满/);
  await earlyBounded.disconnect();

  for (const oversizedFrame of [true, false]) {
    const sizeBounded = new WecomSmartRobot('wecom-default', { ...options, deferInboundUntilActivated: true });
    await sizeBounded.connect({ botId: 'bot', secret: 'secret' });
    const sizeSocket = sockets.at(-1)!;
    if (oversizedFrame) sizeSocket.onmessage?.({ data: 'x'.repeat(1024 * 1024 + 1) });
    else {
      const largeText = callback('large', 'large'); largeText.body.text.content = 'x'.repeat(64 * 1024 + 1);
      sizeSocket.frame(largeText);
    }
    assert.equal(sizeBounded.isConnected(), false); assert.equal(sizeSocket.closed, true);
    assert.match(sizeBounded.statusText(), oversizedFrame ? /1 MiB/ : /64k/);
    await sizeBounded.disconnect();
  }

  // Existing encrypted callback handshake remains supported in the same channel adapter.
  const aes = Buffer.alloc(32, 1).toString('base64').replace(/=$/, '');
  const crypt = new WxCrypt('verify', aes, 'corp');
  await smart.connect({ corpId: 'corp', agentId: '1', secret: 's', token: 'verify', encodingAESKey: aes });
  const encrypted = crypt.encrypt('challenge');
  const query = new URLSearchParams({ timestamp: '1', nonce: 'n', echostr: encrypted, msg_signature: crypt.sha1Signature('1', 'n', encrypted) });
  assert.equal((await smart.handleHttp({ method: 'GET', query, rawBody: '' })).body, 'challenge');
  await smart.disconnect();
  console.log('Lark official transport and WeCom Smart Robot/callback: PASS');
} finally { globalThis.fetch = originalFetch; }
