import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuChannelAdapter, type GatewayInboundMessage } from '../src/main/gateway/channels';
const home = mkdtempSync(join(tmpdir(), 'feishu-media-'));
const originalFetch = globalThis.fetch;
const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
process.env.HOME = home; process.env.USERPROFILE = home;
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
let passed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> { await run(); console.log('PASS ' + name); passed++; }
function fixture() {
  let onEvent: (event: unknown) => Promise<void> = async () => {};
  let epoch = {};
  const adapter = new FeishuChannelAdapter('fs', 'Feishu', () => ({
    async start(handler) { onEvent = handler; }, close() {}, generation: () => epoch,
  }));
  return { adapter, event: (event: unknown) => onEvent(event), reconnect: () => { epoch = {}; } };
}
const event = (kind: string, content: unknown) => ({ message: { message_id: 'om_message', chat_id: 'oc_chat', thread_id: 'omt_topic',
  message_type: kind, content: JSON.stringify(content) }, sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } } });
try {
  await check('official resources, media-only ingress, post locale and quoted thread replies', async () => {
    const f = fixture(), seen: GatewayInboundMessage[] = [], urls: string[] = [], replies: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input); assert.equal(init?.redirect, 'error');
      if (url.includes('/auth/')) return json({ code: 0, tenant_access_token: 'secret' });
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret');
      if (url.endsWith('/reply')) { replies.push(JSON.parse(String(init?.body))); return json({ code: 0 }); }
      urls.push(url); return new Response('bytes');
    };
    f.adapter.setInboundHandler(async msg => { seen.push(msg); assert.equal(readFileSync(msg.attachments![0].path, 'utf8'), 'bytes'); await msg.reply('answer'); });
    await f.adapter.connect({ appId: 'app', appSecret: 'secret', transport: 'websocket' });
    for (const kind of ['image', 'file', 'audio', 'video', 'media']) await f.event(event(kind, kind === 'image' ? { image_key: 'img_key' } : { file_key: kind, file_name: '../../file.pdf' }));
    await f.event(event('post', { zh_cn: { title: 'title', content: [[{ tag: 'text', text: 'caption' }, { tag: 'img', image_key: 'post_image' }], [{ tag: 'file', file_key: 'post_file', file_name: 'report.pdf' }]] } }));
    assert.equal(seen.length, 6); assert.equal(seen[0].text, ''); assert.equal(seen[5].text, 'title\ncaption');
    assert.equal(seen[5].attachments?.length, 2); assert.equal(urls.length, 7);
    assert.ok(urls.every(url => url.startsWith('https://open.feishu.cn/open-apis/im/v1/messages/om_message/resources/')));
    assert.ok(urls[0].endsWith('?type=image')); assert.ok(urls[1].endsWith('?type=file'));
    assert.ok(seen.every(msg => msg.workTarget?.channelType === 'feishu' && msg.workTarget.address.threadId === 'omt_topic'));
    assert.ok(replies.every(body => body.reply_in_thread === true && !('receive_id' in body)));
    assert.ok(seen.every(msg => !msg.attachments![0].name.includes('/')));
    assert.equal(readFileSync(seen[0].attachments![0].path, 'utf8'), 'bytes');
    f.reconnect(); await assert.rejects(() => seen[0].reply('stale')); await f.adapter.disconnect();
  });
  await check('authentication, unsupported types and errors do not enter agent', async () => {
    const f = fixture(); let count = 0, downloads = 0;
    globalThis.fetch = async input => {
      if (String(input).includes('/auth/')) return json({ code: 0, tenant_access_token: 'token' });
      downloads++; return json({ code: 999, msg: 'no permission' });
    };
    f.adapter.setInboundHandler(async () => { count++; });
    await f.adapter.connect({ appId: 'app', appSecret: 'secret', verificationToken: 'verify' });
    await assert.rejects(() => f.adapter.handleWebhookPayload({ schema: '2.0', header: { app_id: 'app', token: 'bad', event_type: 'im.message.receive_v1' }, event: event('image', { image_key: 'x' }) }));
    assert.equal(downloads, 0);
    const webhook = (e: unknown) => f.adapter.handleWebhookPayload({ schema: '2.0', header: { app_id: 'app', token: 'verify', event_type: 'im.message.receive_v1' }, event: e });
    await assert.rejects(() => webhook(event('image', { image_key: 'x' })));
    await assert.rejects(() => webhook(event('interactive', {})), /暂不支持/);
    assert.equal(count, 0); await f.adapter.disconnect();
  });
  await check('reconnection during resource fetch rejects stale media', async () => {
    const f = fixture(); let count = 0;
    globalThis.fetch = async input => {
      if (String(input).includes('/auth/')) return json({ code: 0, tenant_access_token: 'token' });
      f.reconnect(); return new Response('stale');
    };
    f.adapter.setInboundHandler(async () => { count++; });
    await f.adapter.connect({ appId: 'app', appSecret: 'secret', transport: 'websocket' });
    await assert.rejects(() => f.event(event('file', { file_key: 'x' })));
    assert.equal(count, 0); await f.adapter.disconnect();
  });
  await check('limits and malicious resource identifiers reject before media admission', async () => {
    const f = fixture(); let count = 0, downloads = 0;
    globalThis.fetch = async input => {
      if (String(input).includes('/auth/')) return json({ code: 0, tenant_access_token: 'token' });
      downloads++; return new Response('too large', { headers: { 'content-length': String(21 * 1024 * 1024) } });
    };
    f.adapter.setInboundHandler(async () => { count++; });
    await f.adapter.connect({ appId: 'app', appSecret: 'secret', transport: 'websocket' });
    await assert.rejects(() => f.event(event('file', { file_key: '..' })), /资源标识/);
    assert.equal(downloads, 0);
    await assert.rejects(() => f.event(event('post', { content: [Array.from({ length: 11 }, (_, index) => ({ tag: 'img', image_key: `img_${index}` }))] })), /数量/);
    assert.equal(downloads, 0);
    await assert.rejects(() => f.event(event('file', { file_key: 'large' })));
    assert.equal(count, 0); await f.adapter.disconnect();
  });
  await check('sender allowlist is enforced before resource download', async () => {
    const f = fixture(); let downloads = 0, count = 0;
    globalThis.fetch = async input => {
      if (String(input).includes('/auth/')) return json({ code: 0, tenant_access_token: 'token' });
      downloads++; return new Response('file');
    };
    f.adapter.setInboundHandler(async () => { count++; });
    await f.adapter.connect({ appId: 'app', appSecret: 'secret', transport: 'websocket', allowUsers: [' allowed '] });
    await f.event(event('image', { image_key: 'img' }));
    const missing = { ...event('image', { image_key: 'img' }), sender: {} };
    await f.event(missing);
    assert.equal(downloads, 0); assert.equal(count, 0);
    await f.event({ ...event('image', { image_key: 'img' }), sender: { sender_id: { open_id: 'allowed' } } });
    assert.equal(downloads, 1); assert.equal(count, 1); await f.adapter.disconnect();
  });
  await check('provider reply errors surface rather than pretending success', async () => {
    const f = fixture(); let message: GatewayInboundMessage | undefined;
    globalThis.fetch = async input => String(input).includes('/auth/')
      ? json({ code: 0, tenant_access_token: 'token' }) : json({ code: 230011 });
    f.adapter.setInboundHandler(async msg => { message = msg; });
    await f.adapter.connect({ appId: 'app', appSecret: 'secret', transport: 'websocket' });
    await f.event(event('text', { text: 'hello' }));
    await assert.rejects(() => message!.reply('answer'), /回复失败/);
    await f.adapter.disconnect();
  });
  console.log(`${passed} Feishu media cases passed`);
} finally {
  globalThis.fetch = originalFetch;
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  rmSync(home, { recursive: true, force: true });
}
