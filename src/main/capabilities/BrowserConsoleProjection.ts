import type { BrowserConsoleEntryDto, BrowserConsoleTarget } from "../../shared/browser-console";
import type { RuntimeProbeEvent } from "./RuntimeProbeService";

export function requireBrowserConsoleTarget(value: unknown): BrowserConsoleTarget {
  if (value !== "browser" && value !== "artifact") throw new Error("无效的控制台 target");
  return value;
}

export function toBrowserConsoleEntry(event: RuntimeProbeEvent): BrowserConsoleEntryDto | null {
  if (event.target !== "browser" && event.target !== "artifact") return null;
  if (event.kind !== "console" && event.kind !== "runtime-error" && event.kind !== "load") return null;
  // load 生命周期中的 start/stop 属于内部诊断噪声；控制台只显示真正失败。
  if (event.kind === "load" && event.level !== "error") return null;
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    level: event.level,
    kind: event.kind,
    message: event.message.replace(/^\[MYBUDDY_(?:RUNTIME_ERROR|UNHANDLED_REJECTION)\]\s*/, ""),
    url: event.url,
    sourceId: event.sourceId,
    line: event.line,
  };
}
