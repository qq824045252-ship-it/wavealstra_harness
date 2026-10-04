import { safeStorage } from "electron";
import type { ChannelConfig } from "./channels";

interface EncryptedSecrets { version: number; ciphertext: string }
const REDACTED = "••••••";

function publicConfig(config: ChannelConfig): ChannelConfig {
  return { appId: config.appId, teamId: config.teamId, allowUsers: config.allowUsers };
}

/** Reuses the desktop host's OS encryption; Slack tokens never enter plaintext gateway config or renderer readback. */
export function sealSlackGatewayConfig(config: ChannelConfig): ChannelConfig {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统凭据加密不可用，Slack 配置未保存");
  const secrets = JSON.stringify({ botToken: config.botToken, appToken: config.appToken });
  return { ...publicConfig(config), encryptedSecrets: { version: 1, ciphertext: safeStorage.encryptString(secrets).toString("base64") } };
}

export function openSlackGatewayConfig(config: ChannelConfig): ChannelConfig {
  const encrypted = config.encryptedSecrets as EncryptedSecrets | undefined;
  if (!encrypted || encrypted.version !== 1 || typeof encrypted.ciphertext !== "string") {
    throw new Error("Slack 连接凭据尚未保存在安全配置中");
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统凭据加密不可用，Slack 连接未恢复");
  try {
    const secrets = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted.ciphertext, "base64"))) as ChannelConfig;
    return { ...publicConfig(config), botToken: secrets.botToken, appToken: secrets.appToken };
  } catch { throw new Error("Slack 安全配置无法读取，请在安全输入框重新配置"); }
}

export function slackGatewayConfigView(config: ChannelConfig): ChannelConfig {
  const hasSecrets = Boolean((config.encryptedSecrets as EncryptedSecrets | undefined)?.ciphertext);
  return { ...publicConfig(config), botToken: hasSecrets ? REDACTED : "", appToken: hasSecrets ? REDACTED : "" };
}
