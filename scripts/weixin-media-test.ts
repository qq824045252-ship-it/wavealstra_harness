import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeixinIlinkAdapter } from '../src/main/gateway/WeixinIlinkAdapter';
import { WeixinIlinkClient, parseWeixinMediaKey, decryptWeixinMedia } from '../src/main/gateway/WeixinIlinkClient';
import { withGatewayMedia, GatewayMediaError } from '../src/main/gateway/GatewayMedia';
const directory = await mkdtemp(join(tmpdir(), 'weixin-media-'));
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const plain = Buffer.from('fixture media bytes');
const cipher = createCipheriv('aes-128-ecb', key, null);
const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
assert.deepEqual(parseWeixinMediaKey(key.toString('base64')), key);
assert.deepEqual(parseWeixinMediaKey(Buffer.from(key.toString('hex')).toString('base64')), key);
assert.deepEqual(Buffer.from(decryptWeixinMedia(encrypted, key)), plain);
assert.throws(() => parseWeixinMediaKey('invalid'), error => error instanceof GatewayMediaError && !error.retryable);
assert.throws(() => decryptWeixinMedia(Buffer.alloc(3), key));
const rawCipher = createCipheriv('aes-128-ecb', key, null); rawCipher.setAutoPadding(false);
const unpadded = Buffer.alloc(16, 50);
assert.deepEqual(Buffer.from(decryptWeixinMedia(Buffer.concat([rawCipher.update(unpadded), rawCipher.final()]), key)), unpadded);
const requests: string[] = [];
const fetcher: typeof fetch = async (url, opts) => {
  requests.push(String(url)); assert.equal(opts?.redirect, 'error'); assert.ok(!opts?.headers);
  return new Response(new Uint8Array(encrypted));
};
const client = new WeixinIlinkClient(fetcher);
const signal = new AbortController().signal;
const media = { encrypt_query_param: 'private&query', aes_key: key.toString('base64') };
try {
  await withGatewayMedia([client.mediaSource(media, '../../file.txt', signal)], async files => {
    assert.equal(files.length, 1); assert.ok(!files[0].name.includes('/'));
    assert.deepEqual(await readFile(files[0].path), plain);
  }, { directory });
  assert.ok(requests[0].endsWith('encrypted_query_param=private%26query'));
  for (const url of ['http://novac2c.cdn.weixin.qq.com/x', 'https://evil.example/x', 'https://x@novac2c.cdn.weixin.qq.com/x', 'https://novac2c.cdn.weixin.qq.com:444/x']) {
    await assert.rejects(() => withGatewayMedia([client.mediaSource({ full_url: url }, 'bad.bin', signal)], async () => {}, { directory }));
  }
  assert.equal(requests.length, 1);
  const bad = new WeixinIlinkClient(async () => new Response(new Uint8Array([1,2,3])));
  await assert.rejects(() => withGatewayMedia([bad.mediaSource(media, 'bad.bin', signal)], async () => {}, { directory }));
  const plaintextClient = new WeixinIlinkClient(async () => new Response(new Uint8Array(plain)));
  await withGatewayMedia([plaintextClient.mediaSource({ full_url: 'https://mmbiz.qpic.cn/fixture' }, 'plain.txt', signal)], async files => {
    assert.deepEqual(await readFile(files[0].path), plain);
  }, { directory });
  const oversized = new WeixinIlinkClient(async () => new Response(new Uint8Array([1]), {headers: {'content-length': String(21 * 1024 * 1024)}}));
  await assert.rejects(() => withGatewayMedia([oversized.mediaSource(media, 'large.bin', signal)], async () => {}, { directory }));
  const redirect = new WeixinIlinkClient(async () => new Response(null, {status:302, headers:{location:'https://evil.example/secret'}}));
  await assert.rejects(() => withGatewayMedia([redirect.mediaSource(media, 'redirect.bin', signal)], async () => {}, { directory }));
  const received: any[] = []; let polls = 0, downloads = 0;
  const item = (type: number, field: string, extras = {}) => ({type, [field]: {media, ...extras}});
  const items = [item(2,'image_item',{aeskey:key.toString('hex')}), item(3,'voice_item',{text:'do not use inaccurate transcript'}),
    item(4,'file_item',{file_name:'report.txt'}), item(5,'video_item')];
  const message = (id: string, item_list: any[], peer='owner') => ({message_id:id,from_user_id:peer,to_user_id:'bot',message_type:1,message_state:2,item_list});
  const adapter = new WeixinIlinkAdapter('wx','微信',{mediaDirectory:directory,fetch:async (url, opts) => {
    if (String(url).endsWith('getupdates')) {
      if (++polls === 1) return new Response(JSON.stringify({ret:0,msgs:[message('untrusted',items,'stranger'),message('one',items),message('one',items),
        message('quoted',[{type:1,text_item:{text:'look'},ref_msg:{message_item:items[0]}}]),
        message('transcript',[{type:3,voice_item:{text:'fallback'}}])]}));
      return new Promise<Response>((_,reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('abort')), {once:true}));
    }
    downloads++; return fetcher(url, opts);
  }});
  adapter.setInboundHandler(async msg => { received.push(msg); });
  await adapter.connect({accountId:'bot',userId:'owner',baseUrl:'https://ilinkai.weixin.qq.com',botToken:'secret',allowUsers:['owner']});
  for(let i=0;i<150 && received.length<3;i++) await new Promise(r=>setTimeout(r,10));
  await adapter.disconnect();
  assert.equal(received.length,3); assert.equal(downloads,5); assert.equal(received[0].attachments.length,4);
  assert.deepEqual(received[0].attachments.map((a:any)=>a.name),['image.jpg','voice.silk','report.txt','video.mp4']);
  assert.equal(received[0].text,'[微信媒体附件]'); assert.equal(received[1].attachments.length,1);
  assert.equal(received[2].text,'[Voice transcription provided by Weixin]\nfallback');
  for(const attachment of received[0].attachments) assert.deepEqual(await readFile(attachment.path),plain);
  assert.ok((await readdir(directory)).length > 0);
  let attempts = 0, accepted = 0;
  const cursors: string[] = [];
  const recovery = new WeixinIlinkAdapter('recover','微信',{mediaDirectory:directory,fetch:async (url,opts) => {
    if (String(url).endsWith('getupdates')) {
      cursors.push(JSON.parse(String(opts?.body)).get_updates_buf);
      if (cursors.length <= 2) return new Response(JSON.stringify({ret:0,get_updates_buf:'after-media',msgs:[
        message('earlier',[{type:1,text_item:{text:'already accepted'}}]), message('retry-media',[items[0]])]}));
      return new Promise<Response>((_,reject) => opts?.signal?.addEventListener('abort',()=>reject(new Error('abort')),{once:true}));
    }
    if (++attempts === 1) throw new Error('temporary download failure');
    return new Response(new Uint8Array(encrypted));
  }});
  recovery.setInboundHandler(async () => { accepted++; });
  await recovery.connect({accountId:'bot',userId:'owner',baseUrl:'https://ilinkai.weixin.qq.com',botToken:'secret',allowUsers:['owner']});
  for(let i=0;i<300 && cursors.length<3;i++) await new Promise(r=>setTimeout(r,10));
  await recovery.disconnect();
  assert.equal(accepted,2); assert.equal(attempts,2); assert.deepEqual(cursors,['','','after-media']);
  // Permanent failures must advance the cursor, and bounded transient failures
  // must not prevent later valid messages or replay an uncertain agent run.
  for (const transient of [false, true]) {
    const statuses: string[] = [], checkpoint: string[] = [], invoked: string[] = [];
    let downloadAttempts = 0;
    const rejectedItems = transient ? [item(2,'image_item')] : [
      {type:2,image_item:{media:{full_url:'https://evil.example/private'}}},
      {type:2,image_item:{media:{...media,aes_key:'invalid'}}},
      {type:2,image_item:{media:{...media,encrypt_query_param:'oversize'}}},
      {type:2,image_item:{media:{...media,encrypt_query_param:'decode'}}},
      {type:2,image_item:{media:{...media,encrypt_query_param:'forbidden'}}},
    ];
    const rejecting = new WeixinIlinkAdapter('reject','微信',{mediaDirectory:directory,onStatus:text=>statuses.push(text),fetch:async (url,opts) => {
      if (String(url).endsWith('getupdates')) {
        checkpoint.push(JSON.parse(String(opts?.body)).get_updates_buf);
        if (checkpoint[checkpoint.length-1] !== 'complete') return new Response(JSON.stringify({ret:0,get_updates_buf:'complete',msgs:[
          ...rejectedItems.map((entry,i)=>message(`bad-${i}`,[entry])),
          message('agent-uncertain',[{type:1,text_item:{text:'throw after dispatch'}}]),
          message('agent-uncertain',[{type:1,text_item:{text:'duplicate'}}]),
          message('valid-after-rejection',[{type:1,text_item:{text:'still handled'}}]),
        ]}));
        return new Promise<Response>((_,reject)=>opts?.signal?.addEventListener('abort',()=>reject(new Error('abort')),{once:true}));
      }
      downloadAttempts++;
      if (transient) return new Response(null,{status:503});
      if (String(url).includes('oversize')) return new Response(new Uint8Array([1]),{headers:{'content-length':String(21*1024*1024)}});
      if (String(url).includes('decode')) return new Response(new Uint8Array([1]));
      return new Response(null,{status:403});
    }});
    rejecting.setInboundHandler(async msg=>{invoked.push(msg.messageId!);if(msg.messageId==='agent-uncertain') throw new Error('agent receipt uncertain');});
    await rejecting.connect({accountId:'bot',userId:'owner',baseUrl:'https://ilinkai.weixin.qq.com',botToken:'secret',allowUsers:['owner']});
    for(let i=0;i<500 && !checkpoint.includes('complete');i++) await new Promise(r=>setTimeout(r,10));
    await rejecting.disconnect();
    assert.deepEqual(invoked,['agent-uncertain','valid-after-rejection']);
    assert.equal(downloadAttempts,3);
    assert.deepEqual(checkpoint,transient?['','','','complete']:['','complete']);
    assert.ok(statuses.some(text=>text.includes(transient?'连续3次准备失败':'已拒绝此消息')));
  }
  console.log('PASS Weixin media: AES formats/padding, safe URL/download/cache, four media types, media-only, quoted media, voice fallback, sender gate and dedup');
} finally { await rm(directory,{recursive:true,force:true}); }
