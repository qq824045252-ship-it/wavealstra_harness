import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dotsGoogleAccounts, type DotsGoogleAccount, type DotsGoogleAccountStatus, type DotsGoogleConnection } from "../../shared/dots-google";
import { createGadgetCommandRunner, type GadgetCommandOptions } from "../platform/gadget-commands";
import { atomicWriteJson } from "../task/TaskExecutionWorkspace";

const configVariable = "GOOGLE_WORKSPACE_CLI_CONFIG_DIR";
const clientFile = "client_secret.json";
const scopes = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly"];
type Json = Record<string, unknown>;
type Command = (directory: string, args: string[], options?: GadgetCommandOptions) => Promise<Json>;

interface Connection extends DotsGoogleConnection { profile: string }

export class DotsGoogleError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

function errorMessage(error: unknown): string {
  if (error instanceof DotsGoogleError) return error.message;
  switch ((error as { code?: string } | null)?.code) {
    case "COMMAND_NOT_FOUND": return "找不到 gws。请安装 @googleworkspace/cli，并确认 MyBuddy 的 PATH 能找到它。";
    case "UNSUPPORTED_COMMAND_SHIM": return "无法启动 gws。请确认 PATH 优先指向 @googleworkspace/cli。";
    case "COMMAND_ABORTED": return "已取消登录。";
    case "COMMAND_TIMEOUT": return "操作超时，请检查网络后重试。";
    default: return "操作失败，请检查网络和 gws 安装后重试。";
  }
}

function replyError(text: string): string {
  if (/access_denied|access denied|consent.+denied/i.test(text)) return "Google 授权未获批准。请确认选择了正确的账号，并检查公司的授权政策。";
  if (/invalid_grant|invalid credentials|unauthenticated|no authentication|expired or revoked|401\b/i.test(text))
    return "Google 授权已失效，请重新登录。";
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used.+project|api.+disabled/i.test(text))
    return "OAuth 客户端项目还未启用此 Google API。";
  if (/insufficient|permission.denied|403\b/i.test(text)) return "这个账号未授予该服务的读取权限。";
  if (/unrecognized|invalid choice|unexpected argument/i.test(text)) return "当前 gws 版本不支持此命令，请使用 @googleworkspace/cli。";
  if (/no oauth client configured|invalid_client|redirect_uri_mismatch/i.test(text)) return "OAuth 客户端配置无效，请检查 Google 桌面应用客户端。";
  return "gws 请求失败，请检查网络后重试。";
}

export const runDotsGoogle: Command = async (directory, args, options) => {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !/^(?:GOOGLE_WORKSPACE_|GOOGLE_APPLICATION_CREDENTIALS$|GWS_|ELECTRON_RUN_AS_NODE$)/i.test(entry[0])));
  const runner = createGadgetCommandRunner({
    platform: process.platform, cwd: directory, nodeExecutable: process.execPath,
    allowedCommands: ["gws"], environment: { ...environment, [configVariable]: directory },
  });
  try {
    const result = await runner.run("gws", { ...options, args });
    if (result.exitCode !== 0) {
      const output = result.stderr + "\n" + result.stdout;
      let status: number | undefined;
      for (const stream of [result.stdout, result.stderr]) {
        try {
          const code = Number(JSON.parse(stream).error?.code);
          if (Number.isInteger(code)) status = code;
        } catch { /* gws can also emit plain diagnostic text. */ }
      }
      throw new DotsGoogleError(replyError(output), status);
    }
    // Proxy-enabled gws prints the browser URL on stdout ahead of the JSON receipt.
    const start = result.stdout.indexOf("{");
    let data: unknown;
    try { data = JSON.parse(result.stdout.slice(start === -1 ? 0 : start)); }
    catch { throw new DotsGoogleError("gws 未返回有效的 JSON 回执。"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new DotsGoogleError("gws 回执格式无效。");
    return data as Json;
  } finally { await runner.dispose(); }
};

function authorizationUrl(line: string): string | undefined {
  try {
    const url = new URL(line.trim());
    if (url.origin !== "https://accounts.google.com" || url.username || url.password ||
      !["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(url.pathname)) return;
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    if (redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) && redirect.port)
      return url.href;
  } catch { /* Only the complete Google authorization URL is actionable. */ }
}

function emailFrom(value: unknown): string | undefined {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value) && value.length <= 254 ? value : undefined;
}

export class DotsGoogleAccounts {
  private loginAttempt?: { account: DotsGoogleAccount; controller: AbortController; choosingClient: boolean };
  private readonly checks = new Map<DotsGoogleAccount, AbortController>();
  private readonly messages = new Map<DotsGoogleAccount, string>();
  private readonly operations = new Set<Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly openBrowser: (url: string) => Promise<void>,
    private readonly chooseClient: () => Promise<string | undefined>,
    private readonly clientDirectories: readonly (string | undefined)[],
    private readonly run: Command = runDotsGoogle,
  ) {}

  private metadata(account: DotsGoogleAccount) {
    return join(this.root, account, "connection.json");
  }

  current(account: DotsGoogleAccount): (Connection & { directory: string }) | undefined {
    try {
      const stored = JSON.parse(readFileSync(this.metadata(account), "utf8")) as Connection;
      if (typeof stored.profile === "string" && /^profile-[\w-]+$/.test(stored.profile) && emailFrom(stored.email)
        && typeof stored.checkedAt === "number" && stored.access?.gmail && stored.access?.calendar)
        return { ...stored, directory: join(this.root, account, stored.profile) };
    } catch { /* A fresh profile has no authorization. */ }
  }

  status(): Record<DotsGoogleAccount, DotsGoogleAccountStatus> {
    const entry = (account: DotsGoogleAccount): DotsGoogleAccountStatus => {
      const saved = this.current(account);
      return {
        connection: saved && { email: saved.email, access: saved.access, checkedAt: saved.checkedAt },
        busy: this.loginAttempt?.account === account ? "login" : this.checks.has(account) ? "check" : undefined,
        message: this.messages.get(account),
      };
    };
    return { personal: entry("personal"), company: entry("company") };
  }

  private async oauthClient(previous?: string) {
    const directories = [previous, ...this.clientDirectories];
    for (const directory of directories) {
      if (!directory) continue;
      const path = join(directory, clientFile);
      if ((await stat(path).catch(() => undefined))?.isFile()) return path;
    }
    if (this.loginAttempt) this.loginAttempt.choosingClient = true;
    return this.chooseClient();
  }

  private async writeClient(source: string, directory: string) {
    const badClient = () => new DotsGoogleError("请选择从 Google Cloud 下载的桌面应用 OAuth 客户端 JSON。");
    const info = await stat(source).catch(() => undefined);
    if (!info?.isFile() || info.size > 64 * 1024) throw badClient();
    let installed: Json;
    try { installed = JSON.parse(await readFile(source, "utf8")).installed; }
    catch { throw badClient(); }
    if (!installed || typeof installed.client_id !== "string" || !installed.client_id.endsWith(".apps.googleusercontent.com")
      || typeof installed.client_secret !== "string" || !installed.client_secret) throw badClient();
    await writeFile(join(directory, clientFile), JSON.stringify({ installed: {
      client_id: installed.client_id, client_secret: installed.client_secret,
      project_id: typeof installed.project_id === "string" ? installed.project_id : "",
      auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: ["http://localhost"],
    } }), { mode: 0o600, flag: "wx" });
  }

  private async verify(directory: string, email: string, signal: AbortSignal): Promise<DotsGoogleConnection> {
    const [gmail, calendar] = await Promise.allSettled([
      this.run(directory, ["gmail", "users", "getProfile", "--params", '{"userId":"me","fields":"emailAddress"}'], { signal }),
      this.run(directory, ["calendar", "events", "list", "--params", '{"calendarId":"primary","maxResults":1,"fields":"kind"}'], { signal }),
    ]);
    signal.throwIfAborted();
    if (gmail.status === "fulfilled" && emailFrom(gmail.value.emailAddress)?.toLowerCase() !== email.toLowerCase())
      throw new DotsGoogleError("Gmail 回执的账号与登录账号不一致，请重新登录。");
    return {
      email, checkedAt: Date.now(), access: {
        gmail: gmail.status === "fulfilled" ? { ready: true } : { ready: false, message: errorMessage(gmail.reason) },
        calendar: calendar.status === "fulfilled" && calendar.value.kind === "calendar#events"
          ? { ready: true } : { ready: false, message: calendar.status === "rejected" ? errorMessage(calendar.reason) : "日历返回了无效回执。" },
      },
    };
  }

  private track(operation: Promise<void>) {
    this.operations.add(operation);
    return operation.finally(() => this.operations.delete(operation));
  }

  login(account: DotsGoogleAccount) { return this.track(this.signIn(account)); }

  private async signIn(account: DotsGoogleAccount) {
    if (this.loginAttempt || this.checks.has(account)) return;
    const controller = new AbortController();
    this.loginAttempt = { account, controller, choosingClient: false };
    this.messages.delete(account);
    const previous = this.current(account);
    let staged: string | undefined;
    let opened: Promise<void> | undefined;
    let failedToOpen = false;
    try {
      const oauthClient = await this.oauthClient(previous?.directory);
      if (!oauthClient || controller.signal.aborted) throw new DotsGoogleError("已取消登录。");
      this.loginAttempt.choosingClient = false;
      const parent = join(this.root, account);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      staged = await mkdtemp(join(parent, "profile-"));
      await this.writeClient(oauthClient, staged);
      const lines = { stdout: "", stderr: "" };
      const receipt = await this.run(staged, ["auth", "login", "--scopes", scopes.join(",")], {
        timeoutMs: 300_000, signal: controller.signal,
        onOutput: (stream, chunk) => {
          if (opened || controller.signal.aborted) return;
          const parts = (lines[stream] + chunk.toString("utf8")).split("\n");
          lines[stream] = parts.pop() ?? "";
          for (const line of parts) {
            const url = authorizationUrl(line);
            if (!url) continue;
            opened = this.openBrowser(url).catch(() => { failedToOpen = true; controller.abort(); });
            break;
          }
        },
      });
      await opened;
      controller.signal.throwIfAborted();
      const email = emailFrom(receipt.account);
      if (receipt.status !== "success" || !email) throw new DotsGoogleError("Google 返回的账号身份无法确认，请重新登录。");
      const other = dotsGoogleAccounts.find(candidate => candidate !== account)!;
      if (this.current(other)?.email.toLowerCase() === email.toLowerCase())
        throw new DotsGoogleError("这个邮箱已连接在另一个位置。请在浏览器里选择另一个 Google 账号。");
      const connection = await this.verify(staged, email, controller.signal);
      atomicWriteJson(this.metadata(account), { ...connection, profile: basename(staged) });
      staged = undefined;
      if (previous) await rm(previous.directory, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      this.messages.set(account, failedToOpen ? "未能打开浏览器，请检查默认浏览器后重试。"
        : controller.signal.aborted ? "已取消登录。" : errorMessage(error));
    } finally {
      if (staged) await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      this.loginAttempt = undefined;
    }
  }

  check(account: DotsGoogleAccount) { return this.track(this.checkConnection(account)); }

  private async checkConnection(account: DotsGoogleAccount) {
    const saved = this.current(account);
    if (!saved || this.checks.has(account) || this.loginAttempt?.account === account) return;
    const controller = new AbortController();
    this.checks.set(account, controller);
    this.messages.delete(account);
    try {
      const connection = await this.verify(saved.directory, saved.email, controller.signal);
      atomicWriteJson(this.metadata(account), { ...connection, profile: saved.profile });
    } catch (error) { this.messages.set(account, errorMessage(error)); }
    finally { this.checks.delete(account); }
  }

  cancel(account: DotsGoogleAccount) {
    if (this.loginAttempt?.account === account) this.loginAttempt.controller.abort();
  }

  async close() {
    this.loginAttempt?.controller.abort();
    for (const controller of this.checks.values()) controller.abort();
    if (!this.loginAttempt?.choosingClient) await Promise.allSettled(this.operations);
  }
}
