import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { ComputerUseError } from "../protocol";

/** socket2 gives window lifetime events that polling cannot distinguish after address reuse. */
export interface HyprlandEventSource {
  connect(): Promise<void>;
  readonly connected: boolean;
  readonly revision: number;
  identity(address: string): string | undefined;
  shutdown(): Promise<void>;
}
export class HyprlandEvents implements HyprlandEventSource {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private epoch = randomUUID();
  private serial = 0;
  private readonly lifetimes = new Map<string, number>();
  private buffer = "";
  private stopped = false;
  private eventRevision = 0;
  constructor(private readonly options: { path?: string; connectSocket?: (path: string) => Socket; onDisconnect?: (error: ComputerUseError) => void } = {}) {}
  get connected(): boolean { return Boolean(this.socket && !this.socket.destroyed && !this.socket.connecting); }
  get revision(): number { return this.eventRevision; }
  identity(address: string): string | undefined {
    if (!this.connected) return undefined;
    if (this.lifetimes.size > 16_384) { this.epoch = randomUUID(); this.lifetimes.clear(); this.eventRevision++; }
    let serial = this.lifetimes.get(address);
    if (serial === undefined) { serial = ++this.serial; this.lifetimes.set(address, serial); }
    return `${this.epoch}:${serial}:${address}`;
  }
  async connect(): Promise<void> {
    if (this.stopped) throw new ComputerUseError("HOST_UNAVAILABLE", "Hyprland 事件连接已关闭");
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
    const runtime = process.env.XDG_RUNTIME_DIR;
    const path = this.options.path ?? (runtime && signature ? join(runtime, "hypr", signature, ".socket2.sock") : undefined);
    if (!path) throw new ComputerUseError("HOST_UNAVAILABLE", "缺少 Hyprland 事件套接字路径，不能验证窗口生命周期");
    this.epoch = randomUUID(); this.lifetimes.clear(); this.buffer = ""; this.eventRevision++;
    const socket = (this.options.connectSocket ?? createConnection)(path); this.socket = socket;
    const promise = new Promise<void>((resolve, reject) => {
      let done = false; let wasConnected = false;
      const timer = setTimeout(() => fail(new ComputerUseError("REQUEST_TIMEOUT", "Hyprland 事件套接字连接超时")), 2_000);
      const finish = (error?: Error) => {
        if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve();
      };
      const fail = (error: Error) => { finish(error); socket.destroy(); };
      socket.once("connect", () => { wasConnected = true; finish(); });
      socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        if (this.buffer.length > 1_048_576) { fail(new ComputerUseError("HOST_PROTOCOL_ERROR", "Hyprland 事件缓冲超过限制")); return; }
        let end: number;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          const separator = line.indexOf(">>");
          if (separator < 1) continue;
          const event = line.slice(0, separator); const payload = line.slice(separator + 2);
          if (/^(openwindow|closewindow)$/.test(event)) {
            const raw = payload.split(",", 1)[0].toLowerCase().replace(/^0x/, "");
            if (/^[0-9a-f]+$/.test(raw)) {
              if (this.lifetimes.size > 16_384) { this.epoch = randomUUID(); this.lifetimes.clear(); }
              this.lifetimes.set(`0x${raw}`, ++this.serial);
            }
          }
          // Ignore high-frequency irrelevant events such as screencast notifications.
          if (/window|workspace|monitor|fullscreen|floating|pin/.test(event)) this.eventRevision++;
        }
      });
      socket.on("error", (error) => finish(new ComputerUseError("HOST_UNAVAILABLE", `Hyprland 事件连接失败：${error.message}`)));
      socket.once("close", () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.epoch = randomUUID(); this.lifetimes.clear(); this.eventRevision++;
        finish(new ComputerUseError("HOST_UNAVAILABLE", "Hyprland 事件连接已断开"));
        if (wasConnected && !this.stopped) this.options.onDisconnect?.(new ComputerUseError("HOST_UNAVAILABLE", "Hyprland 事件连接丢失，旧窗口观察已失效"));
      });
    });
    this.connecting = promise;
    try { await promise; } finally { if (this.connecting === promise) this.connecting = undefined; }
  }
  async shutdown(): Promise<void> { this.stopped = true; this.socket?.destroy(); this.socket = undefined; this.lifetimes.clear(); }
}
