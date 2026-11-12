const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { buildSync } = require('esbuild');
function load(path) {
  const code = buildSync({ entryPoints: [path], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'silent' }).outputFiles[0].text;
  const m = { exports: {} }; new Function('require', 'module', 'exports', code)(createRequire(resolve('package.json')), m, m.exports); return m.exports;
}
const { workGatewayText } = load('src/main/agent/work/WorkGatewayNotificationChannel.ts');
const { DiscordGatewayAdapter } = load('src/main/gateway/DiscordGatewayAdapter.ts');
for (const files of [undefined, [], [{ name: 'answer.txt' }]]) {
  const text = workGatewayText({ kind: 'result', title: '比较完成', body: 'A100元，B80元，建议B。', deliveryFiles: files });
  assert.match(text, /A100元，B80元，建议B/);
}
const claim = workGatewayText({ kind: 'result', title: '完成', body: '附件已送达', deliveryFiles: [] });
assert.match(claim, /不代表渠道投递回执/); assert.match(claim, /本次通知没有附件/);
function fixture(fetcher) {
  let calls = 0;
  const adapter = new DiscordGatewayAdapter('channel', 'fixture', { fetch: async (...args) => { calls++; return fetcher(calls, ...args); } });
  Object.assign(adapter, { config: { botToken: 'fixture', applicationId: '200', allowUsers: ['300'], guildIds: ['400'], allowDirectMessages: true }, botId: '100', connected: true, activated: true, stopped: false });
  const target = { version: 1, channelType: 'discord', channelId: 'channel', connectionKey: adapter.workConnectionKey(), chatId: 'channel:200:100:400:500:300', senderId: '300', address: { channelId: '500', guildId: '400', applicationId: '200', botId: '100', messageId: '1' } };
  return { adapter, calls: () => calls, input: { target, text: 'result', files: [], effectKey: 'stable-effect', assertCurrent: () => {} } };
}
const limited = () => Response.json({ retry_after: 0.001 }, { status: 429 });
(async () => {
  const bodies=[]; const f=fixture((n,url,init)=>{bodies.push(JSON.parse(init.body.get('payload_json')));return n===1?limited():Response.json({id:'900',channel_id:'500'});});
  assert.equal((await f.adapter.sendWorkNotification(f.input)).ok,true); assert.equal(f.calls(),2); assert.deepEqual(bodies[0],bodies[1]);
  const c=new AbortController(); const cancel=fixture(()=>{setTimeout(()=>c.abort(),10);return limited();});
  await assert.rejects(cancel.adapter.sendWorkNotification({...cancel.input,signal:c.signal}),/取消/); assert.equal(cancel.calls(),1);
  let current=true; const stale=fixture(()=>{setTimeout(()=>{current=false;},10);return limited();});
  await assert.rejects(stale.adapter.sendWorkNotification({...stale.input,assertCurrent:()=>{if(!current)throw new Error('stale revision');}}),/事项或目标授权已改变/);assert.equal(stale.calls(),1);
  const changed=fixture(()=>{setTimeout(()=>{changed.adapter.generation++;},10);return limited();});
  await assert.rejects(changed.adapter.sendWorkNotification(changed.input),/连接已更换/);assert.equal(changed.calls(),1);
  const unknown=fixture(()=>{throw new Error('response lost')});assert.equal((await unknown.adapter.sendWorkNotification(unknown.input)).responseLost,true);assert.equal(unknown.calls(),1);
  const forbidden=fixture(()=>Response.json({}, {status:403}));assert.equal((await forbidden.adapter.sendWorkNotification(forbidden.input)).retryable,false);assert.equal(forbidden.calls(),1);
  const exhausted=fixture(limited);const end=await exhausted.adapter.sendWorkNotification(exhausted.input);assert.equal(end.ok,false);assert.equal(end.responseLost,false);assert.equal(exhausted.calls(),4);
  console.log('Gateway Work review regressions PASS: text preservation, attachment attribution, 429 recovery, immutable request, cancellation, stale revision, unknown/403 no retry, bounded attempts');
})().catch(error=>{console.error(error);process.exitCode=1;});
