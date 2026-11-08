import { safeStorage } from "electron";
import type { GatewayChannelType } from "../../shared/agent-ipc";
import type { ChannelConfig } from "./channels";

export type SecureGatewayProvider = "dingtalk" | "discord";
const fields: Record<SecureGatewayProvider, { public: string[]; secrets: string[]; required: string[] }> = {
  dingtalk: { public: ["clientId", "corpId", "robotCode", "allowUsers"], secrets: ["clientSecret"], required: ["clientId", "clientSecret", "corpId", "robotCode"] },
  discord: { public: ["applicationId", "allowUsers", "guildIds", "allowDirectMessages"], secrets: ["botToken"], required: ["applicationId", "botToken"] },
};
export function isSecureGatewayProvider(type: GatewayChannelType): type is SecureGatewayProvider {
  return type === "dingtalk" || type === "discord";
}
function select(config: ChannelConfig, keys: string[]): ChannelConfig {
  return Object.fromEntries(keys.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
}
export function validateGatewayProviderConfig(type: SecureGatewayProvider, config: ChannelConfig): ChannelConfig {
  const result = select(config, [...fields[type].public, ...fields[type].secrets]);
  for (const key of fields[type].required) {
    if (typeof result[key] !== "string" || !(result[key] as string).trim() || result[key] === "••••••") {
      throw new Error(`${type} 缺少配置：${key}`);
    }
    result[key] = (result[key] as string).trim();
  }
  if (!Array.isArray(result.allowUsers) || !result.allowUsers.length || result.allowUsers.some(value => typeof value !== "string" || !value.trim())) {
    throw new Error(`${type} 必须配置允许的用户 ID，避免公开机器人触发未授权任务`);
  }
  result.allowUsers = [...new Set((result.allowUsers as string[]).map(value => value.trim()))];
  if (type === "discord") {
    if (!Array.isArray(result.guildIds) || result.guildIds.some(value => typeof value !== "string" || !/^\d+$/.test(value))) throw new Error("Discord 服务器 ID 列表无效");
    if (typeof result.allowDirectMessages !== "boolean") throw new Error("请明确选择是否允许 Discord 私聊");
    if (!result.guildIds.length && !result.allowDirectMessages) throw new Error("Discord 需要指定服务器或启用私聊");
  }
  return result;
}
export function sealGatewayProviderConfig(type: SecureGatewayProvider, config: ChannelConfig): ChannelConfig {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统凭据加密不可用，Gateway 配置未保存");
  return { ...select(config, fields[type].public), encryptedSecrets: { version: 1,
    ciphertext: safeStorage.encryptString(JSON.stringify(select(config, fields[type].secrets))).toString("base64") } };
}
export function openGatewayProviderConfig(type: SecureGatewayProvider, config: ChannelConfig): ChannelConfig {
  const encrypted = config.encryptedSecrets as { version?: unknown; ciphertext?: unknown } | undefined;
  if (!safeStorage.isEncryptionAvailable() || encrypted?.version !== 1 || typeof encrypted.ciphertext !== "string") {
    throw new Error("Gateway 安全配置不可用，请重新配置");
  }
  try {
    const secrets = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted.ciphertext, "base64"))) as ChannelConfig;
    return validateGatewayProviderConfig(type, { ...select(config, fields[type].public), ...select(secrets, fields[type].secrets) });
  } catch { throw new Error("Gateway 安全配置无法读取，请重新配置"); }
}
export function gatewayProviderConfigView(type: SecureGatewayProvider, config: ChannelConfig): ChannelConfig {
  const encrypted = config.encryptedSecrets as { ciphertext?: unknown } | undefined;
  return { ...select(config, fields[type].public), ...Object.fromEntries(fields[type].secrets.map(key => [key, encrypted?.ciphertext ? "••••••" : ""])) };
}
