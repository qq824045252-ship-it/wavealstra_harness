import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QQChannelAdapter, type QQSocket } from '../src/main/gateway/QQChannelAdapter';
import type { GatewayInboundMessage } from '../src/main/gateway/channels';
class Socket implements QQSocket {
  onmessage: QQSocket['onmessage'] = null;
  onclose: QQSocket['onclose'] = null;
  onerror: QQSocket['onerror'] = null;
  frame(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  send(raw: string) {
    if (JSON.parse(raw).op === 2) queueMicrotask(() => this.frame({ op: 0, t: 'READY', d: { session_id: 'session' } }));
  }
  close() { this.onclose?.({ code: 1000 }); }
}
let socket: Socket;
let downloads = 0, mode = '', failHandler = false, release: (() => void) | undefined;
const messages: GatewayInboundMessage[] = [], statuses: string[] = [], posts: Record<string, unknown>[] = [];
const adapter = new QQChannelAdapter('qq', 'QQ', {
  deferInboundUntilActivated: true,
  onStatus: value => statuses.push(value),
  socketFactory: () => { socket = new Socket(); queueMicrotask(() => socket.frame({ op: 10, d: { heartbeat_interval: 60000 } })); return socket; },
  fetch: (async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, 'error');
    if (url.endsWith('/getAppAccessToken')) return Response.json({ access_token: 'secret', expires_in: 7200 });
    if (url.endsWith('/gateway')) return Response.json({ url: 'wss://gateway.qq.com' });
    if (url.endsWith('/messages')) { posts.push(JSON.parse(String(init?.body))); return Response.json({ id: 'receipt' }); }
    downloads++;
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    assert.equal(new Headers(init?.headers).has('X-Union-Appid'), false);
    if (mode === 'hold') await new Promise<void>(resolve => { release = resolve; });
    if (mode === 'failure') throw new Error('synthetic transient network error');
    if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'https://evil.example/file' } });
    return new Response('abc', { headers: { 'content-length': '3' } });
  }) as typeof fetch,
});
adapter.setInboundHandler(async message => {
  for (const file of message.attachments ?? []) assert.equal(await readFile(file.path, 'utf8'), 'abc');
  messages.push(message);
  if (failHandler) throw new Error("synthetic uncertain Gateway failure");
});
const config = { appId: '123', appSecret: 'secret', allowUsers: ['user'] };
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const until = async (ready: () => boolean) => { const deadline=Date.now()+5000;
  while(!ready()){if(Date.now()>deadline)throw new Error("QQ media observable completion timeout");await new Promise(resolve=>setTimeout(resolve,5));} };
const media = (url = 'https://multimedia.nt.qq.com/download/file', extra: Record<string, unknown> = {}) => ({ url, filename: 'photo.png', content_type: 'image/png', size: 3, ...extra });
const event = (id: string, extra: Record<string, unknown> = {}, group = false) => socket.frame({ op: 0, t: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', d: {
  id, content: '', author: group ? { member_openid: 'user' } : { user_openid: 'user' }, group_openid: 'group', timestamp: new Date().toISOString(), attachments: [media()], ...extra,
} });
const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
const home = await mkdtemp(join(tmpdir(), 'qq-media-test-'));
process.env.HOME = process.env.USERPROFILE = home;
try {
  await adapter.connect(config);
  event('buffered'); await tick(); assert.equal(downloads, 0);
  adapter.activate(); await until(()=>messages.length===1); assert.equal(messages.length, 1); assert.equal(messages[0].text, '');
  assert.equal(messages[0].attachments?.[0].name, 'photo.png');
  event('buffered'); event('unauthorized', { author: { user_openid: 'stranger' } }); await tick(); assert.equal(downloads, 1);
  event('batch', { content: 'caption', attachments: [media('//gchat.qpic.cn/image'),
    media('https://multimedia.nt.qq.com/file', { filename: '../doc.pdf', content_type: 'application/pdf' }),
    media('https://grouptalk.c2c.qq.com/audio', { filename: 'voice.silk', content_type: 'audio/silk', asr_refer_text: 'not trusted', voice_wav_url: 'https://evil.example/voice' }),
    media('https://multimedia.nt.qq.com/video', { filename: 'video.mp4', content_type: 'video/mp4' })] }, true);
  await until(()=>messages.length===2); assert.equal(messages.length, 2); assert.equal(messages[1].text, 'caption');
  assert.equal(messages[1].attachments?.length, 4); assert.equal(messages[1].chatId, 'group:group');
  assert(!messages[1].attachments![1].name.includes('/'));
  await messages[1].reply('answer'); assert.equal(posts[0].msg_id, 'batch');
  const before = downloads;
  for (const [i, url] of ['https://evil.example/a', 'http://gchat.qpic.cn/a', 'https://gchat.qpic.cn.evil.example/a',
    'https://127.0.0.1/a', 'https://user@gchat.qpic.cn/a', 'https://gchat.qpic.cn:444/a', 'https://gchat.qpic.cn/a#fragment'].entries()) event(`bad-${i}`, { attachments: [media(url)] });
  event('large', { attachments: [media(undefined, { size: 21 * 1024 * 1024 })] });
  event('count', { attachments: Array.from({ length: 11 }, () => media()) });
  event('malformed', { attachments: [null] });
  await tick(); assert.equal(downloads, before); assert.equal(messages.length, 2);
  event('text-url', { content: 'https://multimedia.nt.qq.com/not-an-attachment', attachments: [] });
  await until(()=>messages.length===3); assert.equal(downloads, before); assert.equal(messages.length, 3);
  mode = 'redirect'; event('redirect'); await tick(); assert.equal(messages.length, 3); assert(statuses.some(value => value.includes('处理失败')));
  mode = 'failure'; event('retry-media'); await tick(); assert.equal(messages.length, 3);
  assert(statuses.at(-1)?.includes('允许平台重新投递'));
  const failedDownloads = downloads;
  mode = ''; event('retry-media'); event('retry-media'); await until(()=>messages.length===4);
  assert.equal(downloads, failedDownloads + 1); assert.equal(messages.length, 4);
  failHandler = true; event('handler-error'); await until(()=>messages.length===5 && statuses.at(-1)?.includes('避免重复执行')===true); assert.equal(messages.length, 5);
  assert(statuses.at(-1)?.includes('避免重复执行'));
  const enteredDownloads = downloads;
  failHandler = false; event('handler-error'); await tick();
  assert.equal(downloads, enteredDownloads); assert.equal(messages.length, 5);
  mode = 'hold'; event('old-generation'); await until(()=>Boolean(release)); assert(release);
  await adapter.disconnect(); await adapter.connect({ ...config, appId: '456' }); adapter.activate();
  release(); await tick(); assert.equal(messages.length, 5);
  console.log('QQ media: attachment-only/caption, image/file/audio/video bytes, activation, dedup, auth, fixed CDN/HTTPS/size/count, no URL scraping, redirects, stale generation PASS');
} finally {
  await adapter.disconnect();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  await rm(home, { recursive: true, force: true });
}
