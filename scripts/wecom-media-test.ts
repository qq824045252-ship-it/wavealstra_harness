import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomSmartRobot, type WecomSocket } from '../src/main/gateway/WecomSmartRobot';
import type { GatewayInboundMessage } from '../src/main/gateway/channels';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const until = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !predicate(); i++) await tick();
  assert.ok(predicate(), 'timed out');
};
class Socket implements WecomSocket {
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  close(): void {}
  send(data: string): void { const frame = JSON.parse(data); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ headers: frame.headers, errcode: 0 }) })); }
  receive(body: unknown, id: string): void { this.onmessage?.({ data: JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: id }, body: { msgid: id, from: { userid: 'user' }, chatid: 'room', ...body as object } }) }); }
}
const root = await mkdtemp(join(tmpdir(), 'wecom-media-'));
const old = process.env.HOME;
process.env.HOME = root;
const key = Buffer.alloc(32, 255);
const raw = Buffer.from('attachment content');
const encrypt = (padOverride?: number): Buffer => {
  const pad = 32 - raw.length % 32;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(pad, padOverride ?? pad)])), cipher.final()]);
};
let bytes = encrypt(); let requests = 0; let failDownload = false; let release: (() => void) | undefined;
const socket = new Socket();
const messages: GatewayInboundMessage[] = [];
const robot = new WecomSmartRobot('wecom-test', { socketFactory: () => { queueMicrotask(() => socket.onopen?.()); return socket; },
  fetch: async (_url, options) => { requests++; assert.equal(options?.redirect, 'error'); if (failDownload) throw new Error('secret signed url must not leak'); if (release) await new Promise<void>(resolve => { release = resolve; }); return new Response(new Uint8Array(bytes)); } });
robot.setInboundHandler(async msg => { messages.push(msg); });
const media = { url: 'https://wwcdn.weixin.qq.com/image', aeskey: encodeURIComponent(key.toString('base64').replace(/=+$/, '')), filename: 'image.png' };
try {
  await robot.connect({ botId: 'bot', secret: 'secret', allowUsers: ['user'] });
  const cases = [
    { msgtype: 'image', image: media },
    { msgtype: 'file', file: { ...media, filename: 'report.pdf' } },
    { msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: 'look' } }, { msgtype: 'image', image: media }] } },
    { msgtype: 'appmsg', appmsg: { file: { ...media, filename: 'report.docx' } } },
    { msgtype: 'text', text: { content: 'compare' }, quote: { msgtype: 'image', image: media } },
  ];
  for (const [i, body] of cases.entries()) { socket.receive(body, String(i)); await until(() => messages.length === i + 1); assert.deepEqual(await readFile(messages[i].attachments![0].path), raw); }
  assert.match(messages[4].text, /不代表.*授权/);
  assert.equal(messages[2].text, 'look');
  const before = requests;
  socket.receive({ msgtype: 'image', image: media, from: { userid: 'blocked' } }, 'blocked'); await tick(); assert.equal(requests, before);
  for (const [i, url] of ['http://wwcdn.weixin.qq.com/a', 'https://evil.example/a', 'https://wwcdn.weixin.qq.com.evil.example/a', 'https://ww-aibot-img-999.cos.ap-guangzhou.myqcloud.com/a', 'https://127.0.0.1/a'].entries()) {
    socket.receive({ msgtype: 'image', image: { ...media, url } }, 'unsafe' + i); await until(() => robot.statusText().includes('处理失败')); await tick();
  }
  assert.equal(requests, before); assert.equal(messages.length, 5);
  bytes = encrypt(0); socket.receive({ msgtype: 'image', image: media }, 'padding'); await until(() => requests > before); await tick(); assert.equal(messages.length, 5);
  failDownload = true; socket.receive({ msgtype: 'file', file: media }, 'download-fail'); await until(() => requests > before + 1); await tick(); assert.equal(messages.length, 5); assert.doesNotMatch(robot.statusText(), /secret signed/); failDownload = false;
  // A transport redelivery after preparation failed must get one chance to enter the agent.
  bytes = encrypt(); socket.receive({ msgtype: 'file', file: media }, 'download-fail');
  await until(() => messages.length === 6); assert.equal(messages[5].messageId, 'download-fail');
  const deliveredRequests = requests;
  socket.receive({ msgtype: 'file', file: media }, 'download-fail'); await tick();
  assert.equal(messages.length, 6); assert.equal(requests, deliveredRequests);
  // Once native execution starts, an error is uncertain and cannot authorize replay.
  robot.setInboundHandler(async msg => { messages.push(msg); throw new Error('secret signed url from agent'); });
  socket.receive({ msgtype: 'file', file: media }, 'agent-fail'); await until(() => messages.length === 7); await tick();
  const failedTurnRequests = requests;
  socket.receive({ msgtype: 'file', file: media }, 'agent-fail'); await tick();
  assert.equal(messages.length, 7); assert.equal(requests, failedTurnRequests);
  assert.doesNotMatch(robot.statusText(), /secret signed/);
  // Committed Registry deliveries release the adapter's preparation queue, even
  // while the first native turn is running. Plain handlers above keep full-await behavior.
  {
    let finish!: () => void; const first = new Promise<void>(resolve => { finish = resolve; });
    const admitted: string[] = [];
    robot.setInboundHandler(msg => { admitted.push(msg.messageId!);
      return Object.assign(msg.messageId === 'durable-a' ? first : Promise.resolve(), { accepted: Promise.resolve() }); });
    socket.receive({ msgtype:'text',text:{content:'first'} },'durable-a');
    socket.receive({ msgtype:'text',text:{content:'second'} },'durable-b');
    await until(() => admitted.length === 2); assert.deepEqual(admitted,['durable-a','durable-b']); finish();
    let attempts = 0;
    robot.setInboundHandler(() => { attempts++; const result = attempts === 1 ? Promise.reject(new Error('commit failed')) : Promise.resolve();
      return Object.assign(result,{accepted:result}); });
    socket.receive({msgtype:'text',text:{content:'retry'}},'durable-reject'); await tick(); await tick();
    socket.receive({msgtype:'text',text:{content:'retry'}},'durable-reject'); await until(() => attempts === 2);
    socket.receive({msgtype:'text',text:{content:'retry'}},'durable-reject'); await tick(); assert.equal(attempts,2);
  }
  robot.setInboundHandler(async msg => { messages.push(msg); });
  release = () => {}; socket.receive({ msgtype: 'image', image: media }, 'stale'); await until(() => requests > failedTurnRequests);
  await robot.disconnect(); release!(); await tick(); await tick(); assert.equal(messages.length, 7);
  console.log('WeCom media ingress tests passed');
} finally {
  await robot.disconnect(); if (old === undefined) delete process.env.HOME; else process.env.HOME = old;
  await rm(root, { recursive: true, force: true });
}
