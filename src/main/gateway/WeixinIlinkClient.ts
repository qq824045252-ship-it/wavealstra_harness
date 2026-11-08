import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withGatewayMedia, GatewayMediaError, type GatewayMediaSource } from './GatewayMedia';
export const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
export const ILINK_CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export function ilinkBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || (url.hostname !== 'ilinkai.weixin.qq.com' && !/^ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(url.hostname)) || !['', '/'].includes(url.pathname)) throw new Error('微信 iLink 服务地址无效');
  return url.origin;
}
function cdnUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port || url.username || url.password) throw new Error('微信媒体地址不在官方 CDN');
  return url.href;
}
export class IlinkError extends Error { constructor(readonly code: number) { super(code === -14 ? '微信登录已过期，请重新扫码' : `微信 iLink 请求失败（${code}）`); } }
export function checkIlink(result: Record<string, any>): void {
  for (const key of ['ret', 'errcode']) if (typeof result[key] === 'number' && result[key] !== 0) throw new IlinkError(result[key]);
}
export class WeixinIlinkClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async request(base: string, endpoint: string, token: string | undefined, payload: Record<string, unknown> | undefined, signal: AbortSignal, timeout = 40_000): Promise<Record<string, any>> {
    const body = payload ? JSON.stringify({ ...payload, base_info: { channel_version: '2.2.0' } }) : undefined;
    let response: Response;
    try { response = await this.fetcher(`${ilinkBase(base)}/ilink/bot/${endpoint}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: { 'Content-Type': 'application/json', 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '131584',
        'AuthorizationType': 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body,
    }); } catch { if (signal.aborted) throw new Error('微信操作已取消'); throw new Error('微信网络请求未确认'); }
    if (!response.ok) throw new Error(`微信 iLink HTTP ${response.status}`);
    const text = (await limitedBody(response, 4 * 1024 * 1024)).toString('utf8');
    if (text.length > 4 * 1024 * 1024) throw new Error('微信响应过大');
    let result: Record<string, any>;
    try { result = object(JSON.parse(text)); } catch { throw new Error('微信响应格式无效'); }
    checkIlink(result); return result;
  }
  mediaSource(media: Record<string, any>, name: string, signal: AbortSignal): GatewayMediaSource {
    const query = media.encrypt_query_param;
    const url = typeof query === 'string' && query ? `${ILINK_CDN}/download?encrypted_query_param=${encodeURIComponent(query)}`
      : typeof media.full_url === 'string' ? media.full_url : '';
    if (!url) throw new GatewayMediaError('微信媒体参数不完整');
    const key = media.aes_key ? parseWeixinMediaKey(media.aes_key) : undefined;
    return { url, name, allowedHosts: WEIXIN_MEDIA_HOSTS,
      fetch: (input, init) => this.fetcher(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }),
      transform: key ? bytes => decryptWeixinMedia(bytes, key) : undefined };
  }
  async download(media: Record<string, any>, signal: AbortSignal): Promise<Buffer> {
    return withGatewayMedia([this.mediaSource(media, 'attachment.bin', signal)], async attachments => readFile(attachments[0].path));
  }
  async upload(base: string, token: string, peer: string, bytes: Buffer, filename: string, kind: 'image'|'video'|'file', signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('微信附件须为 1 字节至 20 MB');
    const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const md5 = createHash('md5').update(bytes).digest('hex');
    const result = await this.request(base, 'getuploadurl', token, { filekey, media_type: kind === 'image' ? 1 : kind === 'video' ? 2 : 3,
      to_user_id: peer, rawsize: bytes.length, rawfilemd5: md5, filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString('hex') }, signal);
    const url = result.upload_full_url || (typeof result.upload_param === 'string' ? `${ILINK_CDN}/upload?encrypted_query_param=${encodeURIComponent(result.upload_param)}&filekey=${filekey}` : '');
    const response = await this.fetcher(cdnUrl(url), { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(encrypted) });
    const param = response.headers.get('x-encrypted-param');
    if (!response.ok || !param) throw new Error('微信附件上传回执未确认');
    const media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 };
    return kind === 'image' ? { type: 2, image_item: { media, mid_size: encrypted.length } } : kind === 'video' ? { type: 5, video_item: { media, video_size: encrypted.length, video_md5: md5, play_length: 0 } } : { type: 4, file_item: { media, file_name: filename, len: String(bytes.length) } };
  }
}
async function limitedBody(response: Response, limit = 20 * 1024 * 1024 + 16): Promise<Buffer> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('微信媒体内容为空');
  const chunks: Buffer[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > limit) throw new Error('微信响应超过大小限制'); chunks.push(Buffer.from(part.value)); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

// Hermes 72d4433 plugins/platforms/weixin/adapter.py: CDN allowlist and AES key formats.
const WEIXIN_MEDIA_HOSTS = ['novac2c.cdn.weixin.qq.com', 'ilinkai.weixin.qq.com', 'wx.qlogo.cn',
  'thirdwx.qlogo.cn', 'res.wx.qq.com', 'mmbiz.qpic.cn', 'mmbiz.qlogo.cn'] as const;
export function parseWeixinMediaKey(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 48) throw new GatewayMediaError('微信媒体密钥无效');
  const decoded = Buffer.from(value, 'base64');
  const key = decoded.length === 32 && /^[a-f\d]{32}$/i.test(decoded.toString()) ? Buffer.from(decoded.toString(), 'hex') : decoded;
  if (key.length !== 16) throw new GatewayMediaError('微信媒体密钥无效');
  return key;
}
export function decryptWeixinMedia(bytes: Uint8Array, key: Buffer): Uint8Array {
  if (!bytes.byteLength || bytes.byteLength % 16) throw new GatewayMediaError('微信媒体密文无效');
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(bytes), decipher.final()]);
  const pad = padded[padded.length - 1];
  // Match Hermes: remove valid PKCS#7 padding, preserve an unpadded full block.
  return pad >= 1 && pad <= 16 && padded.subarray(-pad).every(value => value === pad) ? padded.subarray(0, -pad) : padded;
}
