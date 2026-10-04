import dgram from "node:dgram";
import os from "node:os";
import Bonjour, { type Service as BonjourService } from "bonjour-service";
import { REMOTE_API_VERSION } from "../../../shared/src/remote-contract";
import { isPrivateIpv4, listLanIpv4Addresses } from "./RemoteNetwork";

export const REMOTE_DISCOVERY_UDP_PORT = 3353;
export const REMOTE_MDNS_SERVICE_TYPE = "mybuddy-remote";
export const REMOTE_MDNS_SERVICE_FQDN = "_mybuddy-remote._tcp.local";
export const REMOTE_DISCOVERY_MAGIC = "MYBUDDY_DISCOVER_V1";

export interface RemoteDiscoveryStatus {
  mdns: boolean;
  udp: boolean;
  udpPort: number;
  serviceType: string;
  error?: string;
}

export class RemoteDiscoveryService {
  private bonjour: Bonjour | null = null;
  private bonjourService: BonjourService | null = null;
  private udpSocket: dgram.Socket | null = null;
  private statusValue: RemoteDiscoveryStatus = {
    mdns: false,
    udp: false,
    udpPort: REMOTE_DISCOVERY_UDP_PORT,
    serviceType: REMOTE_MDNS_SERVICE_FQDN,
  };

  status(): RemoteDiscoveryStatus {
    return { ...this.statusValue };
  }

  async start(port: number): Promise<RemoteDiscoveryStatus> {
    await this.stop();
    const errors: string[] = [];
    const addresses = listLanIpv4Addresses();
    const hostName = os.hostname();

    try {
      const bonjour = new Bonjour({ disableIPv6: true });
      const service = bonjour.publish({
        name: `MyBuddy ${hostName}`,
        type: REMOTE_MDNS_SERVICE_TYPE,
        protocol: "tcp",
        port,
        disableIPv6: true,
        txt: {
          service: "mybuddy-remote",
          apiVersion: String(REMOTE_API_VERSION),
          hostname: hostName,
          path: "/healthz",
          addresses: addresses.join(","),
        },
      });
      service.on("error", (error) => {
        console.warn("[RemoteDiscovery] mDNS publish failed", error instanceof Error ? error.message : String(error));
      });
      this.bonjour = bonjour;
      this.bonjourService = service;
      this.statusValue.mdns = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`mDNS: ${message}`);
      console.warn("[RemoteDiscovery] mDNS unavailable", message);
    }

    try {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      socket.on("error", (error) => {
        console.warn("[RemoteDiscovery] UDP discovery error", error.message);
      });
      socket.on("message", (message, remote) => {
        if (!isPrivateIpv4(remote.address)) return;
        const text = message.toString("utf8").trim();
        let nonce: string | undefined;
        if (text !== REMOTE_DISCOVERY_MAGIC) {
          try {
            const parsed = JSON.parse(text) as { type?: string; nonce?: string };
            if (parsed.type !== REMOTE_DISCOVERY_MAGIC) return;
            nonce = typeof parsed.nonce === "string" ? parsed.nonce.slice(0, 120) : undefined;
          } catch {
            return;
          }
        }
        const payload = Buffer.from(JSON.stringify({
          type: "MYBUDDY_DISCOVERY_RESPONSE_V1",
          nonce,
          service: "mybuddy-remote",
          apiVersion: REMOTE_API_VERSION,
          name: "MyBuddy",
          hostname: hostName,
          port,
          addresses,
          urls: addresses.map((address) => `http://${address}:${port}`),
        }), "utf8");
        socket.send(payload, remote.port, remote.address, (error) => {
          if (error) console.warn("[RemoteDiscovery] UDP reply failed", error.message);
        });
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          socket.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          socket.off("error", onError);
          try { socket.setBroadcast(true); } catch { /* receive-only fallback still works */ }
          resolve();
        };
        socket.once("error", onError);
        socket.once("listening", onListening);
        socket.bind(REMOTE_DISCOVERY_UDP_PORT, "0.0.0.0");
      });
      this.udpSocket = socket;
      this.statusValue.udp = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`UDP: ${message}`);
      console.warn("[RemoteDiscovery] UDP discovery unavailable", message);
    }

    this.statusValue = {
      mdns: this.statusValue.mdns,
      udp: this.statusValue.udp,
      udpPort: REMOTE_DISCOVERY_UDP_PORT,
      serviceType: REMOTE_MDNS_SERVICE_FQDN,
      error: errors.length ? errors.join("; ") : undefined,
    };
    return this.status();
  }

  async stop(): Promise<void> {
    const socket = this.udpSocket;
    this.udpSocket = null;
    if (socket) {
      await new Promise<void>((resolve) => {
        try { socket.close(() => resolve()); }
        catch { resolve(); }
      });
    }

    const service = this.bonjourService;
    this.bonjourService = null;
    if (service) {
      try { service.stop?.(); } catch { /* best effort */ }
    }

    const bonjour = this.bonjour;
    this.bonjour = null;
    if (bonjour) {
      await new Promise<void>((resolve) => {
        try { bonjour.destroy(() => resolve()); }
        catch { resolve(); }
      });
    }

    this.statusValue = {
      mdns: false,
      udp: false,
      udpPort: REMOTE_DISCOVERY_UDP_PORT,
      serviceType: REMOTE_MDNS_SERVICE_FQDN,
    };
  }
}
