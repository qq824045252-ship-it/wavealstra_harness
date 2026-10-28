import { randomInt, timingSafeEqual } from "node:crypto";

/** 桌面端点“允许新设备接入”后生成的短暂窗口 + 一次性 6 位配对码 */
export interface RemotePairWindowState {
  code: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
/** 连续输错达到上限即作废窗口，防止在线暴力猜 6 位码 */
const MAX_FAILURES = 5;

export class RemotePairWindow {
  private code: string | null = null;
  private expiresAt = 0;
  private failures = 0;

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  open(): RemotePairWindowState {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.expiresAt = Date.now() + this.ttlMs;
    this.failures = 0;
    return { code: this.code, expiresAt: this.expiresAt };
  }

  /** 当前有效窗口；过期/未开启返回 null（关闭时顺便清理状态） */
  state(): RemotePairWindowState | null {
    if (!this.code || Date.now() >= this.expiresAt) {
      this.reset();
      return null;
    }
    return { code: this.code, expiresAt: this.expiresAt };
  }

  close(): void { this.reset(); }

  /** 校验并消费：一次开启只允许一台设备接入；输错累计到上限直接作废 */
  consume(code: string): boolean {
    const current = this.state();
    if (!current) return false;
    const expected = Buffer.from(current.code, "utf8");
    const provided = Buffer.from(code.trim(), "utf8");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      this.failures += 1;
      if (this.failures >= MAX_FAILURES) this.reset();
      return false;
    }
    this.reset();
    return true;
  }

  private reset(): void {
    this.code = null;
    this.expiresAt = 0;
    this.failures = 0;
  }
}
