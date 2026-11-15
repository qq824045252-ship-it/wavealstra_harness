import { DEEPSEEK_API_ROOT, type ApiCapabilityConnection } from "../../../shared/media-capabilities";
import type { BuiltinCapabilitiesConfigDto } from "../../../shared/builtin-capabilities";
import { BuiltinCapabilityStore } from "../BuiltinCapabilityStore";

export interface DeepSeekConnectionSource {
  getConfig: () => BuiltinCapabilitiesConfigDto;
  getCredential: (ref: string) => string | null | Promise<string | null>;
  hasCredential?: (ref: string) => boolean;
}

export interface ResolvedDeepSeekConnection {
  id: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

/** The main process supplies its existing keyring; workers lazily open the same store. */
let configuredSource: DeepSeekConnectionSource | undefined;
export function configureDeepSeekConnectionSource(source: DeepSeekConnectionSource): void {
  configuredSource = source;
}

function source(): DeepSeekConnectionSource {
  return configuredSource ?? {
    getConfig: () => new BuiltinCapabilityStore().read(),
    getCredential: async (ref) => {
      const { BuiltinCredentialStore } = await import("../BuiltinCredentialStore");
      return new BuiltinCredentialStore().get(ref);
    },
  };
}

function selectConnection(config: BuiltinCapabilitiesConfigDto, connectionId?: string): [string, ApiCapabilityConnection] {
  const entries = Object.entries(config.connections ?? {}).filter(([, entry]) => entry.protocol === "deepseek");
  const selected = connectionId ? entries.find(([id]) => id === connectionId) : entries.length === 1 ? entries[0] : undefined;
  if (!selected) throw new Error(connectionId ? "所选 DeepSeek 服务已移除或不可用，请在工具能力中重新选择。" : "请在工具能力中添加并选择 DeepSeek 官方 API 服务。");
  const [, connection] = selected;
  if (connection.presetId !== "deepseek" || connection.baseUrl.replace(/\/+$/, "") !== DEEPSEEK_API_ROOT || connection.auth !== "api-key") {
    throw new Error("DeepSeek 工具服务须使用官方 API 地址和 API Key。");
  }
  if (!connection.credentialRef) throw new Error("请填写 DeepSeek API Key。");
  if (!Number.isSafeInteger(connection.timeoutMs) || connection.timeoutMs < 1000 || connection.timeoutMs > 600_000) {
    throw new Error("DeepSeek 服务等待上限应为 1 至 600 秒。");
  }
  return selected;
}

/** Independent tools share the saved connection instead of copying keys into web-search.json. */
export function createDeepSeekConnectionResolver(input: DeepSeekConnectionSource) {
  return {
    isConfigured(connectionId?: string): boolean {
      try {
        const [, connection] = selectConnection(input.getConfig(), connectionId);
        return input.hasCredential ? input.hasCredential(connection.credentialRef!) : true;
      } catch { return false; }
    },
    async resolve(connectionId?: string): Promise<ResolvedDeepSeekConnection> {
      const [id, connection] = selectConnection(input.getConfig(), connectionId);
      const apiKey = (await input.getCredential(connection.credentialRef!))?.trim();
      if (!apiKey || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) throw new Error("DeepSeek API Key 缺失或含无法用于请求头的字符，请重新填写。");
      return { id, baseUrl: DEEPSEEK_API_ROOT, apiKey, timeoutMs: connection.timeoutMs };
    },
  };
}

/** Configuration presence only; a successful tool request is reported separately. */
export function isDeepSeekConnectionConfigured(connectionId?: string): boolean {
  return createDeepSeekConnectionResolver(source()).isConfigured(connectionId);
}

export function resolveDeepSeekConnection(connectionId?: string): Promise<ResolvedDeepSeekConnection> {
  return createDeepSeekConnectionResolver(source()).resolve(connectionId);
}
