/** 测试用 @capacitor/core 替身：模拟 Android 端 SharedPreferences + 加密插件行为 */
const prefs = new Map<string, string>();

const plugin = {
  saveConfig: async ({ configJson }: { configJson: string }) => {
    prefs.set("config_ciphertext", JSON.stringify({ configJson }));
    prefs.set("config_iv", "iv");
  },
  loadConfig: async () => {
    const raw = prefs.get("config_ciphertext");
    if (raw) return { configJson: (JSON.parse(raw) as { configJson: string }).configJson };
    const legacyRaw = prefs.get("ciphertext");
    if (!legacyRaw) return {};
    const legacy = JSON.parse(legacyRaw) as { configJson?: string; baseUrl?: string; deviceToken?: string };
    if (legacy.configJson) {
      prefs.set("config_ciphertext", JSON.stringify({ configJson: legacy.configJson }));
      return { configJson: legacy.configJson };
    }
    if (legacy.baseUrl && legacy.deviceToken) return { legacyBaseUrl: legacy.baseUrl, legacyDeviceToken: legacy.deviceToken };
    return {};
  },
  saveToken: async ({ baseUrl, deviceToken }: { baseUrl: string; deviceToken: string }) => {
    prefs.set("ciphertext", JSON.stringify({ baseUrl, deviceToken }));
    prefs.set("iv", "iv");
  },
  loadToken: async () => {
    const raw = prefs.get("ciphertext");
    if (!raw) return {};
    const value = JSON.parse(raw) as { baseUrl?: string; deviceToken?: string };
    return { baseUrl: value.baseUrl, deviceToken: value.deviceToken };
  },
  clearToken: async () => { prefs.delete("ciphertext"); prefs.delete("iv"); },
  getInstallationId: async () => ({ installationId: "stub-installation" }),
};

export const Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
export function registerPlugin() { return plugin; }
export const __prefs = prefs;
