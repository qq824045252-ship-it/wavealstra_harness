import { createConnection } from "node:net";
import * as dbus from "dbus-native";
import { ComputerUseError } from "../protocol";

export interface AtSpiMessage {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature?: string;
  body?: unknown[];
}

export interface AtSpiSignal {
  sender?: string;
  path?: string;
  interface?: string;
  member?: string;
  body?: unknown[];
}

export interface AtSpiBus {
  call(message: AtSpiMessage, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  onSignal(listener: (message: AtSpiSignal) => void): () => void;
  onDisconnect(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export type AtSpiBusFactory = (address: string, signal?: AbortSignal) => Promise<AtSpiBus>;

const DBUS_NAME = "org.freedesktop.DBus";

/**
 * Only the local Unix transports used by a graphical session are accepted.
 * D-Bus percent encoding is decoded before passing a socket path to Node.
 * No shell, unixexec, TCP, FD-capable transport, or native addon is involved.
 */
export function parseAtSpiBusAddress(address: string): string[] {
  if (typeof address !== "string" || address.length === 0 || address.length > 16_384) {
    throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI 总线地址为空或无效", { diagnosticCode: "BUS_ADDRESS_INVALID" });
  }
  const paths: string[] = [];
  for (const alternative of address.split(";").filter(Boolean)) {
    const colon = alternative.indexOf(":");
    if (colon < 0 || alternative.slice(0, colon) !== "unix") continue;
    const parameters = new Map<string, string>();
    for (const pair of alternative.slice(colon + 1).split(",")) {
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;
      const key = pair.slice(0, equals);
      if (parameters.has(key)) throw new ComputerUseError("HOST_UNAVAILABLE", "D-Bus 地址参数重复", { diagnosticCode: "BUS_ADDRESS_INVALID" });
      let value: string;
      try {
        value = decodeURIComponent(pair.slice(equals + 1));
      } catch {
        throw new ComputerUseError("HOST_UNAVAILABLE", "D-Bus 地址的百分号编码无效", { diagnosticCode: "BUS_ADDRESS_INVALID" });
      }
      if (value.includes("\0")) throw new ComputerUseError("HOST_UNAVAILABLE", "D-Bus 地址包含 NUL", { diagnosticCode: "BUS_ADDRESS_INVALID" });
      parameters.set(key, value);
    }
    const filesystemPath = parameters.get("path") ?? parameters.get("socket");
    const abstract = parameters.get("abstract");
    if (filesystemPath !== undefined && abstract !== undefined) {
      throw new ComputerUseError("HOST_UNAVAILABLE", "D-Bus 地址同时声明 path 和 abstract", { diagnosticCode: "BUS_ADDRESS_INVALID" });
    }
    if (filesystemPath?.startsWith("/") && Buffer.byteLength(filesystemPath) <= 107) paths.push(filesystemPath);
    else if (abstract && Buffer.byteLength(abstract) <= 107) paths.push("\0" + abstract);
  }
  if (paths.length === 0) {
    throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI 需要有效的 unix:path 或 unix:abstract 总线地址", { diagnosticCode: "BUS_TRANSPORT_UNSUPPORTED" });
  }
  return paths;
}

/** dbus-native 0.16.3: invoke returns one value directly, not [value]. */
export const createAtSpiBus: AtSpiBusFactory = async (address, signal) => {
  if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 连接在发送前已取消");
  const connectDeadline = Date.now() + 2_000;
  const timeoutSignal = AbortSignal.timeout(2_000);
  const connectSignal = AbortSignal.any([timeoutSignal, ...(signal ? [signal] : [])]);
  let lastError: unknown;
  for (const path of parseAtSpiBusAddress(address)) {
    if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 连接已取消");
    if (timeoutSignal.aborted || Date.now() >= connectDeadline) break;
    const stream = createConnection({ path });
    const bus = dbus.createClient({
      stream,
      plainValues: true,
      variants: "plain",
      fdTransport: false,
      reconnect: false,
      authMethods: ["EXTERNAL"],
      timeout: 2_000,
      maxMessageSize: 8 * 1024 * 1024,
    });
    const signalListeners = new Set<(message: AtSpiSignal) => void>();
    const disconnectListeners = new Set<(error?: Error) => void>();
    let closed = false;
    const disconnected = (error?: Error): void => {
      if (closed) return;
      closed = true;
      for (const listener of disconnectListeners) listener(error);
      // An authentication failure can emit error without closing the socket.
      stream.destroy();
    };
    const incoming = (message: dbus.Message): void => {
      if (message.type !== dbus.messageType.signal) return;
      for (const listener of signalListeners) listener(message);
    };
    bus.connection.on("error", disconnected);
    bus.connection.on("close", disconnected);
    bus.connection.on("end", () => disconnected());
    bus.connection.on("message", incoming);
    try {
      // GetId completes only after authentication and the preceding Hello.
      await bus.invoke({
        destination: DBUS_NAME, path: "/org/freedesktop/DBus", interface: DBUS_NAME, member: "GetId",
      }, { signal: connectSignal, timeout: Math.max(1, connectDeadline - Date.now()) });
      if (closed) throw new Error("D-Bus connection closed during handshake");
      return {
        call: async (message, options = {}) => {
          if (closed) throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI 总线已断开", { diagnosticCode: "BUS_DISCONNECTED" });
          return await bus.invoke(message, { signal: options.signal, timeout: Math.max(1, options.timeoutMs ?? 2_000) });
        },
        onSignal: (listener) => {
          signalListeners.add(listener);
          return () => { signalListeners.delete(listener); };
        },
        onDisconnect: (listener) => {
          disconnectListeners.add(listener);
          if (closed) listener(new Error("D-Bus connection closed"));
          return () => { disconnectListeners.delete(listener); };
        },
        close: async () => {
          closed = true;
          signalListeners.clear();
          disconnectListeners.clear();
          bus.connection.removeListener("message", incoming);
          stream.destroy();
        },
      };
    } catch (error) {
      lastError = error;
      closed = true;
      stream.destroy();
    }
  }
  if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 总线连接已取消");
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ComputerUseError("HOST_UNAVAILABLE", "无法连接图形会话 D-Bus：" + message, { diagnosticCode: "BUS_CONNECTION_FAILED" });
};
