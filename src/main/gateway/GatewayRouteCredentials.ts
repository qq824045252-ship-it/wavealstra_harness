import { safeStorage } from "electron";
import { assertGatewayProviderStorage } from "./GatewayProviderConfig";
import { GatewayRouteEncodingError } from "./GatewayReply";

/** Injected into adapters by the desktop host. Temporary reply capabilities may
 * survive a process restart only as OS-encrypted, versioned records.
 */
export const gatewayReplySecretCodec = Object.freeze({
  seal(value: string): string {
    assertGatewayProviderStorage();
    // The binding envelope adds overhead to a provider capability up to 16 KiB.
    // The ciphertext limit remains the final bound for UTF-8 and escaping expansion.
    if (typeof value !== "string" || !value) throw new GatewayRouteEncodingError("invalid");
    if (value.length > 24_576) throw new GatewayRouteEncodingError("too-large");
    const ciphertext = "v1:" + safeStorage.encryptString(JSON.stringify({ version: 1, purpose: "gateway-reply", value })).toString("base64");
    if (ciphertext.length > 32_768) throw new GatewayRouteEncodingError("too-large");
    return ciphertext;
  },
  open(ciphertext: string): string {
    assertGatewayProviderStorage();
    if (typeof ciphertext !== "string" || ciphertext.length > 32_768 || !/^v1:[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) {
      throw new Error("Gateway 加密回复凭据无效");
    }
    try {
      const stored = JSON.parse(safeStorage.decryptString(Buffer.from(ciphertext.slice(3), "base64"))) as { version?: unknown; purpose?: unknown; value?: unknown };
      if (stored.version !== 1 || stored.purpose !== "gateway-reply" || typeof stored.value !== "string"
        || !stored.value || stored.value.length > 24_576) throw new Error("invalid envelope");
      return stored.value;
    } catch { throw new Error("Gateway 回复凭据无法解密，请重新从原渠道发送消息"); }
  },
});
