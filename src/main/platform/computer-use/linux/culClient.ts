import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ComputerUseError } from "../protocol";
import { culFailure } from "./culProtocol";
import { culHelperPaths } from "./culBinary";

/** 单次 MCP 调用默认超时；截图/OCR/AT-SPI 树会慢一些，按工具覆盖。 */
const DEFAULT_TIMEOUT_MS = 20_000;
const TOOL_TIMEOUT_MS: Record<string, number> = {
  screenshot: 45_000,
  get_app_state: 45_000,
  list_windows: 20_000,
  activate_window: 20_000,
  doctor: 30_000,
};

export interface CulToolResult {
  /** CUL 返回的结构化对象（text 部分解析后的 JSON）；不是 JSON 时为空对象。 */
  data: Record<string, unknown>;
  /** `ok=false` 或 MCP `isError` 时的 message；成功时为 undefined。 */
  failure?: string;
  /** 返回的图片（base64 已解码）。 */
  image?: { bytes: Uint8Array; mimeType: string };
  /** 原始 text 部分（诊断用）。 */
  text?: string;
}

/**
 * computer-use-linux 的 MCP 客户端（stdio 子进程，惰性启动、复用、可关闭）。
 *
 * 为什么不自己拼 `hyprctl`/`grim`/`ydotool`：CUL 已经把 Wayland 上最容易错的
 * 坐标/缩放/portal 截图/AT-SPI 差异都封在原生实现里（见 culProtocol 的注释），
 * 这里只负责把它按 MCP 协议叫起来。
 */
export class CulMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private starting?: Promise<Client>;
  private stderrTail: string[] = [];
  private closed = false;

  constructor(private readonly options: { binaryPath: string; env?: Record<string, string> }) {}

  get pid(): number | undefined {
    return this.transport?.pid ?? undefined;
  }

  /** 惰性启动并握手；并发调用共享同一次启动。 */
  private async ensureClient(): Promise<Client> {
    if (this.closed) throw new ComputerUseError("HOST_UNAVAILABLE", "Computer Use（computer-use-linux）客户端已关闭");
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<Client> {
    const helpers = culHelperPaths(this.options.binaryPath);
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      ...this.options.env,
    };
    if (helpers.cosmicHelper && !env.COMPUTER_USE_LINUX_COSMIC_HELPER) env.COMPUTER_USE_LINUX_COSMIC_HELPER = helpers.cosmicHelper;
    if (helpers.indicator && !env.COMPUTER_USE_LINUX_INDICATOR_BIN) env.COMPUTER_USE_LINUX_INDICATOR_BIN = helpers.indicator;

    const transport = new StdioClientTransport({
      command: this.options.binaryPath,
      args: ["mcp"],
      env,
      stderr: "pipe",
      maxBufferSize: 32 * 1024 * 1024,
    });
    transport.onerror = (error) => {
      this.stderrTail.push(`transport: ${error.message}`);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    };
    const client = new Client({ name: "mybuddy-computer-use", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (error) {
      await this.dispose();
      throw new ComputerUseError(
        "HOST_UNAVAILABLE",
        `无法启动 computer-use-linux：${error instanceof Error ? error.message : String(error)}`,
        { binaryPath: this.options.binaryPath, stderr: this.stderr() },
      );
    }
    // 握手后把 stderr 接出来做诊断尾巴（CUL 会把 portal/AT-SPI 警告写在这里）
    const stderr = transport.stderr;
    if (stderr && "on" in stderr) {
      stderr.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
        }
      });
    }
    this.transport = transport;
    this.client = client;
    return client;
  }

  /** 调一个 CUL 工具；`ok=false` 不抛异常，由调用方决定怎么报错。 */
  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CulToolResult> {
    const client = await this.ensureClient();
    const timeout = TOOL_TIMEOUT_MS[tool] ?? DEFAULT_TIMEOUT_MS;
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout,
        signal: signal as AbortSignal | undefined,
      });
    } catch (error) {
      if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", `computer-use-linux ${tool} 已取消`);
      const message = error instanceof Error ? error.message : String(error);
      // 子进程死掉后客户端不可复用，下次调用重新握手
      if (/closed|EPIPE|ECONNRESET|terminated/i.test(message)) await this.dispose();
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", `computer-use-linux ${tool} 调用失败：${message}`, { stderr: this.stderr() });
    }
    return parseToolResult(tool, result as unknown as Parameters<typeof parseToolResult>[1]);
  }

  /** 调一个工具并在 `ok=false` 时抛协议错误（多数动作需要这个语义）。 */
  async require(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CulToolResult> {
    const result = await this.call(tool, args, signal);
    if (result.failure) throw culFailure(tool, result.failure);
    return result;
  }

  /** 最近 20 行 stderr，用于把可诊断信息带进错误/状态。 */
  stderr(): string | undefined {
    return this.stderrTail.length ? this.stderrTail.join("\n") : undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.dispose();
  }

  private async dispose(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    const transport = this.transport;
    this.transport = undefined;
    try {
      if (client) await client.close();
    } catch { /* 已经关闭 */ }
    try {
      if (!client) await transport?.close();
    } catch { /* 已经关闭 */ }
  }
}

/** MCP `callTool` 结果 → 结构化对象 + 可选图片 + 失败 message。 */
export function parseToolResult(tool: string, result: { content?: unknown; isError?: boolean; structuredContent?: unknown }): CulToolResult {
  const parts = Array.isArray(result.content) ? result.content as Array<Record<string, unknown>> : [];
  const textPart = parts.find((part) => part.type === "text" && typeof part.text === "string");
  const imagePart = parts.find((part) => part.type === "image" && typeof part.data === "string");
  const text = typeof textPart?.text === "string" ? textPart.text : undefined;
  let data: Record<string, unknown> = {};
  if (result.structuredContent && typeof result.structuredContent === "object") {
    data = result.structuredContent as Record<string, unknown>;
  } else if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch { /* 非 JSON 文本：只有 ok/message 类信息 */ }
  }
  const image = imagePart && typeof imagePart.data === "string"
    ? { bytes: Buffer.from(imagePart.data, "base64"), mimeType: String(imagePart.mimeType ?? "image/jpeg") }
    : undefined;
  const failure = result.isError
    ? (typeof data.message === "string" ? data.message : text || `${tool} 失败`)
    : (data.ok === false ? String(data.message ?? `${tool} 失败`) : undefined);
  return { data, failure, image, text };
}
