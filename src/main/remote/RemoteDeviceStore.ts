import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RemoteDeviceSummary } from "../../../shared/src/remote-contract";
import { getMyBuddyDir } from "../paths";
import { protectMemoryGatewaySecretFile } from "../memory/MemoryGatewayFileSecurity";

interface StoredDevice extends RemoteDeviceSummary {
  tokenHash: string;
  /** Android/Web 安装实例的稳定身份哈希；只存哈希，不落原始 installationId。 */
  installationIdHash?: string;
}
interface DeviceFile { version: 1; devices: StoredDevice[] }
export interface RemotePrincipal { deviceId: string; deviceName: string; capabilities: string[] }

const DEFAULT_CAPABILITIES = ["tasks", "prompt", "approval", "notifications"];

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
function publicDevice(device: StoredDevice): RemoteDeviceSummary {
  const { tokenHash: _tokenHash, installationIdHash: _installationIdHash, ...summary } = device;
  return structuredClone(summary);
}

export class RemoteDeviceStore {
  private readonly seenWrites = new Map<string, number>();
  private protectionVerified = false;
  constructor(private readonly path = join(getMyBuddyDir(), "remote-devices.json")) {}

  list(includeRevoked = true): RemoteDeviceSummary[] {
    return this.read().devices.filter((device) => includeRevoked || !device.revokedAt).map(publicDevice);
  }

  /**
   * 签发或轮换设备 Token。
   * installationId 相同表示同一个 App 安装实例：重复配对只轮换 Token，不新增设备行。
   */
  issue(name: string, installationId?: string): { device: RemoteDeviceSummary; token: string } {
    const cleanName = name.trim().slice(0, 80);
    if (!cleanName) throw new Error("设备名称不能为空");
    const cleanInstallationId = installationId?.trim().slice(0, 200);
    const installationIdHash = cleanInstallationId ? hashToken(`installation:${cleanInstallationId}`) : undefined;
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const state = this.read();

    if (installationIdHash) {
      const existing = state.devices.find((candidate) => candidate.installationIdHash === installationIdHash);
      if (existing) {
        existing.name = cleanName;
        existing.tokenHash = hashToken(token);
        existing.lastSeenAt = now;
        existing.capabilities = [...DEFAULT_CAPABILITIES];
        delete existing.revokedAt;
        this.write(state);
        return { device: publicDevice(existing), token };
      }

      // 兼容旧版本：以前没有 installationId，同一台手机每配一次都会新增一行。
      // 首次升级配对时接管最近在线的同名 legacy 行，并撤销其它同名 legacy 重复项。
      const legacy = state.devices
        .filter((candidate) => !candidate.installationIdHash && !candidate.revokedAt && candidate.name === cleanName)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      if (legacy.length > 0) {
        const adopted = legacy[0];
        adopted.installationIdHash = installationIdHash;
        adopted.name = cleanName;
        adopted.tokenHash = hashToken(token);
        adopted.lastSeenAt = now;
        adopted.capabilities = [...DEFAULT_CAPABILITIES];
        for (const duplicate of legacy.slice(1)) duplicate.revokedAt = now;
        this.write(state);
        return { device: publicDevice(adopted), token };
      }
    }

    const stored: StoredDevice = {
      id: `rdev_${randomUUID()}`,
      name: cleanName,
      tokenHash: hashToken(token),
      installationIdHash,
      createdAt: now,
      lastSeenAt: now,
      capabilities: [...DEFAULT_CAPABILITIES],
    };
    state.devices.push(stored);
    this.write(state);
    return { device: publicDevice(stored), token };
  }

  authenticate(token: string): { principal: RemotePrincipal; device: RemoteDeviceSummary } | null {
    if (!token || token.length > 256) return null;
    const digest = hashToken(token);
    const state = this.read();
    const device = state.devices.find((candidate) => !candidate.revokedAt && safeEqualHex(digest, candidate.tokenHash));
    if (!device) return null;
    const now = Date.now();
    const lastWrite = this.seenWrites.get(device.id) ?? device.lastSeenAt;
    if (now - lastWrite >= 60_000) {
      device.lastSeenAt = now;
      this.seenWrites.set(device.id, now);
      this.write(state);
    }
    return {
      principal: { deviceId: device.id, deviceName: device.name, capabilities: [...device.capabilities] },
      device: publicDevice(device),
    };
  }

  revoke(id: string): boolean {
    const state = this.read();
    const device = state.devices.find((candidate) => candidate.id === id);
    if (!device || device.revokedAt) return false;
    device.revokedAt = Date.now();
    this.write(state);
    return true;
  }

  private read(): DeviceFile {
    if (!existsSync(this.path)) return { version: 1, devices: [] };
    if (!this.protectionVerified) {
      protectMemoryGatewaySecretFile(this.path);
      this.protectionVerified = true;
    }
    const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<DeviceFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.devices)) throw new Error(`远程设备文件损坏：${this.path}`);
    const devices = parsed.devices.filter((device): device is StoredDevice => Boolean(
      device && typeof device.id === "string" && typeof device.name === "string" &&
      typeof device.tokenHash === "string" && /^[0-9a-f]{64}$/.test(device.tokenHash) &&
      (device.installationIdHash == null || (typeof device.installationIdHash === "string" && /^[0-9a-f]{64}$/.test(device.installationIdHash))) &&
      Number.isFinite(device.createdAt) && Number.isFinite(device.lastSeenAt) && Array.isArray(device.capabilities),
    ));
    return { version: 1, devices };
  }

  private write(state: DeviceFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "w", 0o600);
      writeFileSync(fd, `${JSON.stringify({ version: 1, devices: state.devices }, null, 2)}\n`, "utf-8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      protectMemoryGatewaySecretFile(tmp);
      renameSync(tmp, this.path);
      protectMemoryGatewaySecretFile(this.path);
      this.protectionVerified = true;
    } catch (error) {
      if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  }
}
