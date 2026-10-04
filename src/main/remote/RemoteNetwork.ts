import { networkInterfaces } from "node:os";

const VIRTUAL_INTERFACE_PATTERN = /(?:loopback|vEthernet|hyper-v|wsl|vmware|virtualbox|docker|tailscale|vpn|meta|zerotier)/i;

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function collectLanAddresses(includeVirtual: boolean): string[] {
  const result = new Set<string>();
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (!includeVirtual && VIRTUAL_INTERFACE_PATTERN.test(name)) continue;
    for (const item of entries ?? []) {
      if (item.family !== "IPv4" || item.internal || !isPrivateIpv4(item.address)) continue;
      result.add(item.address);
    }
  }
  return [...result].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function listLanIpv4Addresses(): string[] {
  const physical = collectLanAddresses(false);
  return physical.length > 0 ? physical : collectLanAddresses(true);
}

export function resolveRemotePairingBaseUrl(options: {
  baseUrl: string;
  bindMode: "loopback" | "lan";
  port: number;
  lanAddresses?: string[];
}): string | null {
  const configured = options.baseUrl.trim();
  if (configured) return configured;
  if (options.bindMode !== "lan") return null;
  const lanAddress = (options.lanAddresses ?? listLanIpv4Addresses())[0];
  return lanAddress ? `http://${lanAddress}:${options.port}` : null;
}

export function isAllowedRemoteBaseUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { return false; }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  if (host === "127.0.0.1" || host === "localhost") return true;
  return isPrivateIpv4(host);
}
