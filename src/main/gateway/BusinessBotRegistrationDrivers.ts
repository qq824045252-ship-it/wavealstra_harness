/** Device registration protocols adapted from public MIT sources:
 * NousResearch/hermes-agent plugins/platforms/feishu/adapter.py blob 048e4f915e1ca2f1eac29ed3e4a699e5bc24d2bf.
 * DingTalk-Real-AI/dingtalk-openclaw-connector src/device-auth.ts blob 99ee94852a78b2006ef5444cb6c897f37bdd7802.
 * See docs/third-party/hermes-agent-LICENSE.txt and dingtalk-registration-LICENSE.txt.
 * Provider tickets/credentials remain in the main process. No environment-based endpoint override.
 */
import type { RegistrationDriver, RegistrationPoll, RegistrationTicket } from "./BusinessBotRegistration";
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string => typeof v === "string" && v.length <= 16_384 ? v.trim() : "";
const positive = (v: unknown, fallback: number): number => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
function qrUrl(input: unknown, suffixes: string[]): string {
  const url = new URL(string(input));
  if (url.protocol !== "https:" || url.username || url.password || url.port || !suffixes.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error("invalid official QR destination");
  return url.href;
}
async function post(fetcher: typeof fetch, url: string, body: Record<string, string>, signal: AbortSignal, form = false): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", Accept: "application/json" },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65_536) throw new Error("oversized response"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  // Feishu uses HTTP 400 for authorization_pending. Other failures are never logged.
  if (!response.ok && !(form && response.status === 400 && typeof data.error === "string")) throw new Error("registration service unavailable");
  return data;
}
export function createFeishuRegistrationDriver(fetcher: typeof fetch = fetch): RegistrationDriver {
  const endpoint = "https://accounts.feishu.cn/oauth/v1/app/registration";
  return {
    async begin(signal) {
      const init = await post(fetcher, endpoint, { action: "init" }, signal, true);
      if (!Array.isArray(init.supported_auth_methods) || !init.supported_auth_methods.includes("client_secret")) throw new Error("unsupported auth method");
      const begin = await post(fetcher, endpoint, { action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id" }, signal, true);
      const deviceCode = string(begin.device_code);
      if (!deviceCode) throw new Error("missing device code");
      return { token: { deviceCode }, qrUrl: qrUrl(begin.verification_uri_complete, ["feishu.cn"]), expiresInSeconds: positive(begin.expire_in, 600), intervalSeconds: positive(begin.interval, 5) };
    },
    async poll(ticket, signal): Promise<RegistrationPoll> {
      const deviceCode = string(object(ticket.token).deviceCode);
      if (!deviceCode) throw new Error("invalid registration ticket");
      const result = await post(fetcher, endpoint, { action: "poll", device_code: deviceCode, tp: "ob_app" }, signal, true);
      const user = object(result.user_info);
      // The existing product adapter targets mainland Feishu only. Do not save
      // international Lark credentials against a different region's API.
      if (user.tenant_brand === "lark" || result.error === "domain_switched") throw new Error("international Lark is not configured");
      const clientId = string(result.client_id), clientSecret = string(result.client_secret);
      if (clientId && clientSecret) return { state: "authorized", credentials: { clientId, clientSecret, ownerId: string(user.open_id) || undefined } };
      if (result.error === "expired_token") return { state: "expired" };
      if (result.error === "authorization_pending") return { state: "pending" };
      if (result.error === "slow_down") { ticket.intervalSeconds = Math.min(ticket.intervalSeconds + 5, 30); return { state: "pending", intervalSeconds: ticket.intervalSeconds }; }
      throw new Error("registration was denied or returned invalid data");
    },
  };
}
export function createDingTalkRegistrationDriver(fetcher: typeof fetch = fetch): RegistrationDriver {
  const endpoint = "https://oapi.dingtalk.com/app/registration";
  const request = async (path: string, body: Record<string, string>, signal: AbortSignal) => {
    const result = await post(fetcher, endpoint + path, body, signal);
    if (result.errcode !== 0) throw new Error("DingTalk registration failed");
    return result;
  };
  return {
    async begin(signal) {
      const init = await request("/init", { source: "DING_DWS_CLAW" }, signal);
      const nonce = string(init.nonce); if (!nonce) throw new Error("missing nonce");
      const begin = await request("/begin", { nonce }, signal);
      const deviceCode = string(begin.device_code); if (!deviceCode) throw new Error("missing device code");
      return { token: { deviceCode }, qrUrl: qrUrl(begin.verification_uri_complete, ["dingtalk.com"]), expiresInSeconds: positive(begin.expires_in, 7200), intervalSeconds: positive(begin.interval, 3) };
    },
    async poll(ticket: RegistrationTicket, signal): Promise<RegistrationPoll> {
      const deviceCode = string(object(ticket.token).deviceCode); if (!deviceCode) throw new Error("invalid registration ticket");
      const result = await request("/poll", { device_code: deviceCode }, signal);
      const status = string(result.status).toUpperCase();
      if (status === "WAITING") return { state: "pending" };
      if (status === "EXPIRED") return { state: "expired" };
      if (status !== "SUCCESS" || !string(result.client_id) || !string(result.client_secret)) throw new Error("registration failed or incomplete");
      // Official response only documents these two credentials. Never infer an
      // enterprise/owner identity or open the allowlist from app registration.
      return { state: "authorized", credentials: { clientId: string(result.client_id), clientSecret: string(result.client_secret) } };
    },
  };
}
