import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getMyBuddyBinDir } from "../paths";
import { prependEnvPath } from "./terminal-env";

export type HerdrPrepareAction = "focus-existing" | "create-workspace";

export interface HerdrPrepareResult {
  ok: boolean;
  action?: HerdrPrepareAction;
  workspaceId?: string;
  sessionName?: string;
  error?: string;
}

export interface SharedSkillProjectionResult {
  created: number;
  existing: number;
  collisions: string[];
  errors: string[];
}

export type HerdrCommandRunner = (args: string[], cwd: string) => Promise<string>;
export type HerdrServerStarter = (sessionName: string, cwd: string) => Promise<void>;
export type HerdrSleep = (ms: number) => Promise<void>;
export type SharedSkillProjector = () => SharedSkillProjectionResult;

export function myBuddyHerdrEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return prependEnvPath(env, [getMyBuddyBinDir()]);
}

interface HerdrWorkspaceSummary {
  workspace_id?: string;
}

interface HerdrPaneSummary {
  cwd?: string;
  foreground_cwd?: string;
}

function canonicalPath(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

export function defaultHerdrCliSkillRoots(home = homedir()): string[] {
  return [
    join(home, ".agents", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".hermes", "skills"),
  ];
}

function lexicalPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function hasSkillEntry(dir: string): boolean {
  return existsSync(join(dir, "SKILL.md")) || existsSync(join(dir, "skill.md"));
}

/**
 * Expose every standard MyBuddy Skill to the CLI runtimes launched from Herdr.
 * This is deliberately a one-way projection: MyBuddy remains the source of truth,
 * existing CLI-owned entries are never overwritten, and no Skill state is managed here.
 */
export function projectMyBuddySkillsToCliRoots(
  sourceRoot = join(homedir(), ".mybuddy", "skills"),
  targetRoots = defaultHerdrCliSkillRoots(),
): SharedSkillProjectionResult {
  const result: SharedSkillProjectionResult = { created: 0, existing: 0, collisions: [], errors: [] };
  if (!existsSync(sourceRoot)) return result;

  const skillNames = readdirSync(sourceRoot).filter((name) => {
    const dir = join(sourceRoot, name);
    try {
      return statSync(dir).isDirectory() && hasSkillEntry(dir);
    } catch {
      return false;
    }
  });

  for (const targetRoot of targetRoots) {
    try {
      mkdirSync(targetRoot, { recursive: true });
    } catch (error) {
      result.errors.push(`${targetRoot}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    for (const name of skillNames) {
      const source = join(sourceRoot, name);
      const target = join(targetRoot, name);
      if (lexicalPathExists(target)) {
        try {
          if (canonicalPath(realpathSync(target)) === canonicalPath(realpathSync(source))) {
            result.existing += 1;
          } else {
            result.collisions.push(target);
          }
        } catch {
          result.collisions.push(target);
        }
        continue;
      }
      try {
        symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
        result.created += 1;
      } catch (error) {
        result.errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return result;
}

/**
 * MyBuddy never takes over the user's Herdr `default` session.
 * Each MyBuddy workspace gets a deterministic named session instead, so two
 * workspace terminals cannot race each other's Herdr focus.
 */
export function myBuddyHerdrSessionName(workspaceId: string): string {
  const source = workspaceId.trim();
  const hash = createHash("sha256").update(source || "workspace").digest("hex").slice(0, 16);
  return `mybuddy-${hash}`;
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Herdr ${label} 返回了无法解析的结果`);
  }
}

function isCommandMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

export const runHerdrCommand: HerdrCommandRunner = (args, cwd) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "herdr",
      args,
      {
        cwd,
        windowsHide: true,
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        env: myBuddyHerdrEnv(),
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          const wrapped = new Error(detail || error.message) as Error & { code?: string };
          wrapped.code = (error as NodeJS.ErrnoException).code;
          reject(wrapped);
          return;
        }
        resolvePromise(String(stdout ?? ""));
      },
    );
  });

export const startHerdrNamedServer: HerdrServerStarter = (sessionName, cwd) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("herdr", ["--session", sessionName, "server"], {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: myBuddyHerdrEnv(),
    });
    const onError = (error: Error): void => reject(error);
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      child.unref();
      resolvePromise();
    });
  });

const defaultSleep: HerdrSleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function readSessionRunning(runner: HerdrCommandRunner, cwd: string, sessionName: string): Promise<boolean> {
  const sessionText = await runner(["session", "list", "--json"], cwd);
  const sessionData = parseJson<{ sessions?: Array<{ name?: string; running?: boolean }> }>(sessionText, "session list");
  return Boolean((sessionData.sessions ?? []).find((session) => session.name === sessionName)?.running);
}

/**
 * Prepare a dedicated Herdr session for one MyBuddy workspace.
 *
 * MyBuddy's bound folder is always the source of truth. The launcher never
 * focuses or mutates the user's Herdr `default` session. A deterministic named
 * session is started headlessly, then a workspace with the exact bound cwd is
 * focused or created. The visible TUI is launched later in the existing PTY via
 * `herdr --session <sessionName>`.
 */
export async function prepareHerdrWorkspace(
  input: { workspaceId: string; cwd: string; label: string },
  runner: HerdrCommandRunner = runHerdrCommand,
  starter: HerdrServerStarter = startHerdrNamedServer,
  sleep: HerdrSleep = defaultSleep,
  projector: SharedSkillProjector = projectMyBuddySkillsToCliRoots,
): Promise<HerdrPrepareResult> {
  const workspaceId = input.workspaceId.trim();
  const cwd = input.cwd.trim();
  const label = input.label.trim() || cwd;
  if (!workspaceId) return { ok: false, error: "缺少 MyBuddy workspaceId" };
  if (!cwd) return { ok: false, error: "当前空间没有可用的项目目录" };

  const projection = projector();
  if (projection.collisions.length || projection.errors.length) {
    console.warn("[HerdrLauncher] shared Skill projection incomplete", projection);
  }

  const sessionName = myBuddyHerdrSessionName(workspaceId);

  try {
    let running = await readSessionRunning(runner, cwd, sessionName);
    if (!running) {
      await starter(sessionName, cwd);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(150);
        try {
          running = await readSessionRunning(runner, cwd, sessionName);
        } catch {
          running = false;
        }
        if (running) break;
      }
      if (!running) return { ok: false, sessionName, error: "Herdr 后台 session 启动失败" };
    }

    const sessionArgs = ["--session", sessionName];
    const workspaceText = await runner([...sessionArgs, "workspace", "list"], cwd);
    const workspaceData = parseJson<{ result?: { workspaces?: HerdrWorkspaceSummary[] } }>(workspaceText, "workspace list");
    const target = canonicalPath(cwd);

    for (const workspace of workspaceData.result?.workspaces ?? []) {
      const herdrWorkspaceId = workspace.workspace_id?.trim();
      if (!herdrWorkspaceId) continue;
      const paneText = await runner([...sessionArgs, "pane", "list", "--workspace", herdrWorkspaceId], cwd);
      const paneData = parseJson<{ result?: { panes?: HerdrPaneSummary[] } }>(paneText, "pane list");
      const matched = (paneData.result?.panes ?? []).some((pane) => {
        // Stable identity = pane cwd. foreground_cwd may change after an agent/shell cd.
        const paneCwd = pane.cwd?.trim();
        return Boolean(paneCwd && canonicalPath(paneCwd) === target);
      });
      if (!matched) continue;
      await runner([...sessionArgs, "workspace", "focus", herdrWorkspaceId], cwd);
      return { ok: true, action: "focus-existing", workspaceId: herdrWorkspaceId, sessionName };
    }

    const createText = await runner(
      [
        ...sessionArgs,
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        label,
        "--focus",
      ],
      cwd,
    );
    const createData = parseJson<{ result?: { workspace?: { workspace_id?: string } } }>(createText, "workspace create");
    return {
      ok: true,
      action: "create-workspace",
      workspaceId: createData.result?.workspace?.workspace_id,
      sessionName,
    };
  } catch (error) {
    if (isCommandMissing(error)) {
      return { ok: false, sessionName, error: "未找到 Herdr，请先安装并确保 herdr 已加入 PATH" };
    }
    return { ok: false, sessionName, error: error instanceof Error ? error.message : String(error) };
  }
}
