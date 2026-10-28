const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** RFC1918 私网 IPv4（只在校验 baseUrl 时使用；服务本身固定监听 loopback） */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** baseUrl 允许的形态：https 反代域名，或受信任的本机/私网 http 地址 */
export function isAllowedRemoteBaseUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { return false; }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  if (LOOPBACK_HOSTS.has(host)) return true;
  return isPrivateIpv4(host);
}
