import type { GatewayChannelType } from "../../shared/agent-ipc";
import type { ChannelConfig } from "./channels";

/** One list for encrypted storage, renderer readback and the outbound boundary. */
export const GATEWAY_SECRET_FIELDS: Readonly<Record<GatewayChannelType, readonly string[]>> = {
  feishu: ["appSecret", "verificationToken"],
  wecom: ["secret", "token", "encodingAESKey"],
  wechat: ["appSecret", "token", "encodingAESKey"],
  telegram: ["botToken"],
  slack: ["botToken", "appToken"],
  dingtalk: ["clientSecret"],
  discord: ["botToken"],
  weixin: ["botToken"],
  qq: ["appSecret"],
};

export const GATEWAY_REDACTED = "••••••";
const HIDDEN = "[凭据已隐藏]";

/** Exact configured credentials plus common credential-bearing error formats.
 * Keep this module independent of Electron so every outbound transport can use it.
 */
export function redactGatewayText(value: string, secrets: readonly string[] = []): string {
  let text = value;
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret === GATEWAY_REDACTED) continue;
    forms.add(secret);
    // JSON strings can contain an unpaired surrogate. Exact redaction must still
    // work, and error-reporting must never fail while trying to URL-encode it.
    try { forms.add(encodeURIComponent(secret)); } catch { /* keep the exact and JSON forms */ }
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  // Longest first prevents a short credential from revealing a longer one's suffix.
  for (const secret of [...forms].sort((a, b) => b.length - a.length)) text = text.split(secret).join(HIDDEN);
  return text.replace(/\b(?:xox[a-z]-|xapp-)[A-Za-z0-9-]+/gi, HIDDEN)
    .replace(/\bBearer\s+[^\s,"'<>]+/gi, `Bearer ${HIDDEN}`)
    .replace(/((?:api[_-]?key|access[_-]?token|context[_-]?token|token|secret|password)\s*["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi, `$1${HIDDEN}`)
    .replace(/(https:\/\/api\.telegram\.org\/(?:file\/)?bot)[^/\s"'<>]+/gi, `$1${HIDDEN}`);
}

/** Values stay in process memory, never in message metadata or a database row. */
export class GatewaySecrets {
  private readonly current = new Map<string, string[]>();
  // Retain only the previous generation so late failures cannot echo rotated keys.
  private readonly previous = new Map<string, string[]>();

  remember(channelId: string, type: GatewayChannelType, config: ChannelConfig): void {
    const values = GATEWAY_SECRET_FIELDS[type]
      .map(key => config[key]).filter((value): value is string => typeof value === "string" && Boolean(value) && value !== GATEWAY_REDACTED);
    const old = this.current.get(channelId);
    if (old && JSON.stringify(old) !== JSON.stringify(values)) this.previous.set(channelId, old);
    this.current.set(channelId, values);
  }

  redact(text: string): string {
    return redactGatewayText(text, [...this.current.values(), ...this.previous.values()].flat());
  }

  /** A long-running turn keeps its original credential filter through rotations.
   * Its snapshot is released with the turn instead of growing a global key history.
   */
  outboundFilter(): (text: string) => string {
    const snapshot = [...this.current.values(), ...this.previous.values()].flat();
    return text => this.redact(redactGatewayText(text, snapshot));
  }

  error(error: unknown, originalSecrets: readonly string[] = []): string {
    return this.redact(redactGatewayText(error instanceof Error ? error.message : "Gateway 操作失败", originalSecrets))
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[网络地址已隐藏]").slice(0, 2000);
  }
}
