import { randomUUID } from 'node:crypto';
import { WeixinIlinkClient, ILINK_BASE, ilinkBase } from './WeixinIlinkClient';
export interface WeixinCredentials { accountId: string; botToken: string; baseUrl: string; userId: string }
export interface WeixinQrState { status: 'idle'|'waiting'|'scanned'|'authorized'|'expired'|'cancelled'|'error'; sessionId?: string; qrUrl?: string; error?: string }
export class WeixinQrLogin {
  private state: WeixinQrState = { status: 'idle' };
  private controller = new AbortController();
  private client: WeixinIlinkClient;
  constructor(private readonly options: { fetch?: typeof fetch; onAuthorized: (credentials: WeixinCredentials, assertCurrent: () => void, signal: AbortSignal) => Promise<void> }) { this.client = new WeixinIlinkClient(options.fetch); }
  getState(): WeixinQrState { return { ...this.state }; }
  cancel(sessionId?: string): void { if (sessionId && sessionId !== this.state.sessionId) return; this.controller.abort(); this.state = { sessionId: this.state.sessionId, status: 'cancelled' }; }
  async start(approvedPersistentAccess: boolean): Promise<WeixinQrState> {
    if (!approvedPersistentAccess) throw new Error('请先确认授权保存微信 iLink Bot 凭据');
    this.cancel(); const controller = this.controller = new AbortController();
    const current = () => { if (controller !== this.controller || controller.signal.aborted) throw new Error('微信扫码已取消'); };
    this.state = { status: 'waiting', sessionId: randomUUID() };
    try {
      const qr = await this.client.request(ILINK_BASE, 'get_bot_qrcode?bot_type=3', undefined, undefined, controller.signal);
      current();
      if (typeof qr.qrcode !== 'string' || !qr.qrcode || typeof qr.qrcode_img_content !== 'string' || !qr.qrcode_img_content) throw new Error('invalid qr');
      // Render as a QR payload, never navigate the renderer to an API supplied URL.
      this.state = { ...this.state, status: 'waiting', qrUrl: qr.qrcode_img_content };
      void this.poll(qr.qrcode, controller, current);
    } catch { if (controller === this.controller && !controller.signal.aborted) this.state = { sessionId: this.state.sessionId, status: 'error', error: '微信二维码获取失败，请重试' }; }
    return this.getState();
  }
  private async poll(qr: string, controller: AbortController, current: () => void): Promise<void> {
    const deadline = Date.now() + 480_000; let base = ILINK_BASE;
    try {
      while (Date.now() < deadline) {
        current();
        const result = await this.client.request(base, `get_qrcode_status?qrcode=${encodeURIComponent(qr)}`, undefined, undefined, controller.signal);
        current();
        if (result.status === 'confirmed') {
          const credentials = { accountId: result.ilink_bot_id, botToken: result.bot_token, baseUrl: ilinkBase(result.baseurl || base), userId: result.ilink_user_id };
          if (Object.values(credentials).some(v => typeof v !== 'string' || !v.trim())) throw new Error('incomplete credentials');
          await this.options.onAuthorized(credentials, current, controller.signal); current();
          this.state = { sessionId: this.state.sessionId, status: 'authorized' }; return;
        }
        if (result.status === 'expired') { this.state = { sessionId: this.state.sessionId, status: 'expired' }; return; }
        if (result.status === 'scaned') this.state = { ...this.state, status: 'scanned' };
        if (result.status === 'scaned_but_redirect') base = ilinkBase(`https://${String(result.redirect_host)}`);
        await new Promise<void>(resolve => { const timer = setTimeout(done, 1000); function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); } controller.signal.addEventListener('abort', done, { once: true }); });
      }
      current(); this.state = { sessionId: this.state.sessionId, status: 'expired' };
    } catch { if (controller === this.controller && !controller.signal.aborted) this.state = { sessionId: this.state.sessionId, status: 'error', error: '微信扫码授权未完成，请重试' }; }
  }
}
