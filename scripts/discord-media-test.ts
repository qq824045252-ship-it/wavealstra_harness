import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordGatewayAdapter, type DiscordSocket } from '../src/main/gateway/DiscordGatewayAdapter.ts';
import type { GatewayInboundMessage } from '../src/main/gateway/channels.ts';
class Socket implements DiscordSocket {
  onmessage: DiscordSocket['onmessage'] = null;
  onclose: DiscordSocket['onclose'] = null;
  onerror: DiscordSocket['onerror'] = null;
  send(value: string): void {
    if (JSON.parse(value).op === 2) queueMicrotask(() => this.frame({ op: 0, t: 'READY', s: 1,
      d: { user: { id: '100', bot: true }, application: { id: '200' }, session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' } }));
  }
  frame(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(): void { this.onclose?.({ code: 1000 }); }
}
let socket: Socket;
let downloads = 0;
let holdDownload: (() => void) | undefined;
let pendingDownload = false;
const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
const messages: GatewayInboundMessage[] = [];
const config = { botToken: 'secret', applicationId: '200', allowUsers: ['300'], guildIds: ['400'], allowDirectMessages: true };
const adapter = new DiscordGatewayAdapter('discord', 'Discord', {
  socketFactory: () => { socket = new Socket(); queueMicrotask(() => socket.frame({ op: 10, d: { heartbeat_interval: 60000 } })); return socket; },
  fetch: (async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://discord.com/api/v10/')) {
      downloads++;
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).has('authorization'), false, 'Bot token must never reach CDN');
      if (pendingDownload) await new Promise<void>(resolve => { holdDownload = resolve; });
      return new Response('abc', { headers: { 'content-length': '3' } });
    }
    if (url.endsWith('/users/@me')) return Response.json({ id: '100', bot: true });
    if (url.endsWith('/oauth2/applications/@me')) return Response.json({ id: '200' });
    if (url.endsWith('/gateway/bot')) return Response.json({ url: 'wss://gateway.discord.gg' });
    posts.push({ url, body: JSON.parse(String(init?.body)) }); return Response.json({ id: '900' });
  }) as typeof fetch,
});
adapter.setInboundHandler(async message => {
  for (const attachment of message.attachments ?? []) assert.equal(await readFile(attachment.path, 'utf8'), 'abc');
  messages.push(message);
});
const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
// MESSAGE_CREATE reserves its queue synchronously. Waiting for that queue to drain
// also observes rejected/filtered media completion, without guessing disk I/O timing.
const drained = (): Promise<void> => waitFor(
  () => (adapter as unknown as { queues: Map<string, Promise<void>> }).queues.size === 0,
  'Discord inbound queues to drain',
);
const media = (url = 'https://cdn.discordapp.com/attachments/500/600/photo.png') => [{ id: '600', filename: 'photo.png', size: 3, url }];
const event = (id: string, override: Record<string, unknown> = {}): void => socket.frame({ op: 0, t: 'MESSAGE_CREATE', s: Number(id),
  d: { id, channel_id: '500', guild_id: '400', author: { id: '300' }, mentions: [{ id: '100' }], content: '<@100>', attachments: media(), ...override } });
const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
const home = await mkdtemp(join(tmpdir(), 'discord-media-test-'));
process.env.HOME = process.env.USERPROFILE = home;
try {
await adapter.connect(config);
event('1'); await waitFor(() => messages.length === 1, 'first attachment delivery'); await drained(); assert.equal(messages.length, 1); assert.equal(messages[0].text, ''); assert.equal(messages[0].attachments?.[0].name, 'photo.png');
event('1'); event('2', { author: { id: '999' } }); event('3', { mentions: [] }); await drained(); assert.equal(downloads, 1);
event('4', { attachments: media('https://attacker.example/attachments/500/600/photo.png') });
event('5', { attachments: media('http://cdn.discordapp.com/attachments/500/600/photo.png') });
event('6', { attachments: media('https://cdn.discordapp.com.evil.test/attachments/500/600/photo.png') });
event('7', { attachments: [{ ...media()[0], size: 21 * 1024 * 1024 }] });
event('8', { attachments: media('https://cdn.discordapp.com/other/path') });
await drained(); assert.equal(downloads, 1); assert.equal(messages.length, 1);
// A Discord thread is its own channel ID. Never route its replies to a parent or another reference channel.
event('9', { channel_id: '501', content: 'thread reply', attachments: [], mentions: [], type: 19,
  message_reference: { message_id: '900', channel_id: '501' }, referenced_message: { id: '900', author: { id: '100', bot: true } } });
await waitFor(() => messages.length === 2, 'thread delivery'); await drained(); assert.equal(messages.length, 2); assert.notEqual(messages[0].chatId, messages[1].chatId);
await messages[1].reply('x'.repeat(4000)); assert.equal(posts.length, 3);
assert(posts.every(post => post.url.endsWith('/channels/501/messages')));
assert.deepEqual(posts[0].body.message_reference, { message_id: '9', fail_if_not_exists: false });
assert.equal(posts[1].body.message_reference, undefined); assert.equal(posts[2].body.message_reference, undefined);
event('10', { content: 'wrong reference', mentions: [], type: 19,
  message_reference: { message_id: '900', channel_id: '999' }, referenced_message: { id: '900', author: { id: '100', bot: true } } });
await drained(); assert.equal(messages.length, 2);
pendingDownload = true; event('11'); await waitFor(() => Boolean(holdDownload), 'held download to start'); assert(holdDownload);
await adapter.disconnect(); await adapter.connect(config); holdDownload(); await drained(); assert.equal(messages.length, 2, 'download must not dispatch into a newer account generation');
await adapter.disconnect();
for (const mode of ['off', 'all'] as const) {
  posts.length = 0; await adapter.connect({ ...config, replyToMode: mode });
  const previousCount = messages.length;
  event(mode === 'off' ? '12' : '13', { content: 'mode', attachments: [] });
  await waitFor(() => messages.length === previousCount + 1, `${mode} reply-mode delivery`); await drained();
  await messages.at(-1)!.reply('x'.repeat(2000)); assert.equal(posts.length, 2);
  assert(posts.every(post => Boolean(post.body.message_reference) === (mode === 'all')));
  await adapter.disconnect();
}
console.log('Discord media/thread: attachment-only, trust/size bounds, dedup, auth filtering, thread routing, reply modes and stale download PASS');

} finally {
  await adapter.disconnect();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  await rm(home, { recursive: true, force: true });
}
