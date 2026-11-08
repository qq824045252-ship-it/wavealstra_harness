import assert from 'node:assert/strict';
import { TelegramChannelAdapter, type GatewayInboundMessage } from '../src/main/gateway/channels';
const original = globalThis.fetch;
const bodies: Record<string, unknown>[] = [];
let delivered = false;
let captured!: (value: GatewayInboundMessage) => void;
const message = new Promise<GatewayInboundMessage>(resolve => { captured = resolve; });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 42, username: 'bot' } });
  if (url.includes('/getUpdates')) {
    if (delivered) return new Promise<Response>(() => {});
    delivered = true;
    return Response.json({ ok: true, result: [{ update_id: 1, message: {
      message_id: 10, chat: { id: 123 }, from: { id: 7 }, text: 'hello',
      message_thread_id: 51, direct_messages_topic: { topic_id: 62 },
    } }] });
  }
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  bodies.push(body);
  if (bodies.length === 1) return Response.json({ ok: false, description: "can't parse entities" }, { status: 400 });
  return Response.json({ ok: true });
};
const adapter = new TelegramChannelAdapter('telegram-default', 'Telegram');
adapter.setInboundHandler(async value => { captured(value); });
try {
  await adapter.connect({ botToken: 'fixture' });
  const inbound = await message;
  await inbound.reply('**answer**');
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.chat_id, 123); assert.equal(body.message_thread_id, 51); assert.equal(body.direct_messages_topic_id, 62);
  }
  assert.equal(bodies[1].parse_mode, undefined);
  await adapter.disconnect();
  await assert.rejects(inbound.reply('stale'), /连接已改变/);
  console.log('PASS Telegram reply preserves topic through HTML fallback and rejects stale delivery');
} finally { await adapter.disconnect(); globalThis.fetch = original; }
