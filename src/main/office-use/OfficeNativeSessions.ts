import { McpClient, StdioTransport, type Tool } from "@earendil-works/pi-mcp";
import type { ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import type { OfficeNativeEngine } from "../platform/office-native";
import { launchOfficeNativeDesktop } from "../platform/OfficeNativeDesktop";

export type OfficeNativeSurface = "workspace" | "desktop";

interface OfficeNativeSession {
  taskId: string;
  client: McpClient;
  connected: Promise<McpClient>;
  catalog?: Promise<Tool[]>;
  queue: Promise<unknown>;
  startup: AbortController;
  child?: ChildProcess;
  closeDesktop?: () => Promise<void>;
  retiring?: Promise<void>;
}

export class OfficeNativeSessions {
  private readonly sessions = new Map<string, OfficeNativeSession>();
  private closed = false;

  constructor(private readonly locate: (engine: OfficeNativeEngine) => Promise<string>) {}

  private retire(key: string, session: OfficeNativeSession): Promise<void> {
    if (session.retiring) return session.retiring;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    session.retiring = Promise.resolve().then(async () => {
      session.startup.abort();
      await Promise.all([
        session.client.close(),
        session.closeDesktop?.(),
      ]);
    });
    return session.retiring;
  }

  async closeTask(taskId: string): Promise<void> {
    await Promise.allSettled([...this.sessions].filter(([, session]) => session.taskId === taskId)
      .map(([key, session]) => this.retire(key, session)));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.sessions].map(([key, session]) => this.retire(key, session)));
  }

  async run<T>(taskId: string, root: string, engine: OfficeNativeEngine, surface: OfficeNativeSurface,
    signal: AbortSignal | undefined,
    operation: (client: McpClient, catalog: () => Promise<Tool[]>) => Promise<T>,
    initialFile?: string,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Office Use 正在关闭。");
    const key = JSON.stringify([taskId, root, engine, surface]);
    let session = this.sessions.get(key);
    if (!session) {
      const client = new McpClient({ name: "mybuddy-office-use", version: "1", requestTimeoutMs: 120_000 });
      const entry: OfficeNativeSession = { taskId, client, connected: Promise.resolve(client), queue: Promise.resolve(), startup: new AbortController() };
      this.sessions.set(key, entry);
      client.onClose(() => { void this.retire(key, entry).catch(() => {}); });
      entry.connected = this.locate(engine).then(async command => {
        if (this.closed || this.sessions.get(key) !== entry) throw new Error("Office 会话已关闭。");
        const desktop = surface === "desktop"
          ? await launchOfficeNativeDesktop({ engine, cli: command, root, file: initialFile, signal: entry.startup.signal }) : undefined;
        if (desktop) {
          if (entry.startup.signal.aborted) {
            await desktop.close();
            entry.startup.signal.throwIfAborted();
          }
          entry.child = desktop.child;
          entry.closeDesktop = desktop.close;
          desktop.child.once("exit", () => { void this.retire(key, entry).catch(() => {}); });
        }
        entry.startup.signal.throwIfAborted();
        const args = desktop ? ["--connect", desktop.address] : engine === "gridcraft" ? []
          : ["--automation-read-root", root, "--automation-write-root", root];
        const env = Object.fromEntries(
          ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "FONTCONFIG_FILE", "FONTCONFIG_PATH",
            "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
            .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
        );
        await client.connect(new StdioTransport({
          command, args: ["mcp", ...args], cwd: root,
          env: { ...env, ...desktop?.clientEnv, PATH: dirname(command), WORDCRAFT_NO_PREFS: "1" },
          inheritEnv: false, maxMessageBytes: 64 * 1024 * 1024,
        }));
        return client;
      }).catch(async error => {
        await this.retire(key, entry).catch(() => {});
        throw error;
      });
      session = entry;
    }
    const active = session;
    const job = active.queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const onAbort = () => {
        if (surface !== "desktop" || !active.child) void this.retire(key, active).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const client = await active.connected;
        signal?.throwIfAborted();
        if (this.closed || this.sessions.get(key) !== active) throw new Error("Office 会话已关闭。请重新打开文档。");
        return await operation(client, () => active.catalog ??= client.listTools({ signal }).catch(error => {
          active.catalog = undefined;
          throw error;
        }));
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    });
    active.queue = job;
    return job;
  }
}
