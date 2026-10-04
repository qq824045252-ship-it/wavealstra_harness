import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RemotePairingSession } from "../../../shared/src/remote-contract";
import { RemoteDeviceStore } from "./RemoteDeviceStore";
import { isAllowedRemoteBaseUrl } from "./RemoteNetwork";

interface PendingPairing { pairingId: string; secret: string; expiresAt: number; failures: number; baseUrl: string }

export class RemotePairingError extends Error {}

function safeSecretEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export class RemoteAccessPairing {
  private readonly pending = new Map<string, PendingPairing>();
  constructor(private readonly devices: RemoteDeviceStore, private readonly ttlMs = 5 * 60_000) {}

  create(baseUrl: string): RemotePairingSession {
    const normalized = baseUrl.trim().replace(/\/$/, "");
    if (!isAllowedRemoteBaseUrl(normalized)) {
      throw new RemotePairingError("访问地址必须是 HTTPS，或受信任局域网/本机 HTTP 地址");
    }
    const pending: PendingPairing = {
      pairingId: `rpair_${randomUUID()}`,
      secret: randomBytes(24).toString("base64url"),
      expiresAt: Date.now() + this.ttlMs,
      failures: 0,
      baseUrl: normalized,
    };
    this.pending.set(pending.pairingId, pending);
    const query = new URLSearchParams({ v: "1", baseUrl: pending.baseUrl, pairingId: pending.pairingId, secret: pending.secret });
    return { pairingId: pending.pairingId, secret: pending.secret, expiresAt: pending.expiresAt, pairingUrl: `mybuddy://pair?${query}` };
  }

  cancel(pairingId: string): void { this.pending.delete(pairingId); }

  exchange(pairingId: string, secret: string, deviceName: string, installationId?: string) {
    const pending = this.pending.get(pairingId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pending.delete(pairingId);
      throw new RemotePairingError("配对请求已过期或不存在");
    }
    if (!safeSecretEqual(secret, pending.secret)) {
      pending.failures += 1;
      if (pending.failures >= 5) this.pending.delete(pairingId);
      throw new RemotePairingError("配对密钥无效");
    }
    this.pending.delete(pairingId);
    return this.devices.issue(deviceName, installationId);
  }
}
