import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TerminalHost, TerminalOwner } from "./TerminalHost";
import type { TerminalScreenResult } from "./TerminalScreen";

export interface TaskTerminalState extends TerminalScreenResult {
  terminalId: string;
  sessionId: string;
  cwd: string;
  alive: boolean;
  exitCode: number | null;
  exitReason: string | null;
  wait?: "matched" | "timeout" | "exited";
}

function validateSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 300 || rows < 1 || rows > 150) {
    throw new Error("Terminal dimensions must be 2..300 columns and 1..150 rows");
  }
}

export class TaskTerminalService {
  private readonly taskTerminals = new Map<string, Map<string, string>>();

  constructor(private readonly host: TerminalHost) {}

  private owner(taskId: string, terminalId: string): TerminalOwner {
    return { kind: "task", id: taskId, terminalId };
  }

  private owned(taskId: string, terminalId: string, sessionId: string) {
    if (this.taskTerminals.get(taskId)?.get(terminalId) !== sessionId) throw new Error("Unknown terminal ownership or stale session");
    const owner = this.owner(taskId, terminalId);
    const info = this.host.getInfo(owner);
    if (!info || info.sessionId !== sessionId) throw new Error("Terminal session is no longer available");
    return { owner, info };
  }

  list(taskId: string) {
    return [...(this.taskTerminals.get(taskId)?.keys() ?? [])]
      .map(id => this.host.getInfo(this.owner(taskId, id)))
      .filter(info => info !== null);
  }

  async open(taskId: string, cols = 80, rows = 24): Promise<TaskTerminalState> {
    validateSize(cols, rows);
    let terminals = this.taskTerminals.get(taskId);
    if (!terminals) {
      terminals = new Map();
      this.taskTerminals.set(taskId, terminals);
    }
    for (const [id, sessionId] of terminals) {
      if (!this.host.getInfo(this.owner(taskId, id))?.alive) this.close(taskId, id, sessionId);
    }
    if (terminals.size >= 4) throw new Error("This task already owns four active terminals");
    const terminalId = `agent-${randomUUID()}`;
    const info = this.host.open({ taskId, terminalId, cols, rows }, true);
    if (!info.alive) {
      this.host.release(this.owner(taskId, terminalId));
      throw new Error(`Terminal failed to start: ${info.exitReason}`);
    }
    terminals.set(terminalId, info.sessionId);
    return this.read(taskId, terminalId, info.sessionId);
  }

  async input(taskId: string, terminalId: string, sessionId: string, data: string): Promise<TaskTerminalState> {
    this.owned(taskId, terminalId, sessionId);
    if (!this.host.input({ taskId, terminalId, sessionId, data })) throw new Error("Terminal input failed; inspect state before retrying");
    return this.read(taskId, terminalId, sessionId);
  }

  async resize(taskId: string, terminalId: string, sessionId: string, cols: number, rows: number): Promise<TaskTerminalState> {
    validateSize(cols, rows);
    this.owned(taskId, terminalId, sessionId);
    if (!this.host.resize({ taskId, terminalId, sessionId, cols, rows })) throw new Error("Terminal resize failed");
    return this.read(taskId, terminalId, sessionId);
  }

  async read(taskId: string, terminalId: string, sessionId: string, options: {
    waitFor?: string; timeoutMs?: number; signal?: AbortSignal;
  } = {}): Promise<TaskTerminalState> {
    const timeout = options.timeoutMs ?? 10000;
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30000) throw new Error("Terminal wait must be 0..30000 ms");
    const deadline = Date.now() + timeout;
    for (;;) {
      options.signal?.throwIfAborted();
      const { owner } = this.owned(taskId, terminalId, sessionId);
      const screen = await this.host.readScreen({ owner });
      if (!screen) throw new Error("Terminal has no screen");
      const { info } = this.owned(taskId, terminalId, sessionId);
      const state: TaskTerminalState = { ...screen, terminalId, sessionId, cwd: info.cwd, alive: info.alive, exitCode: info.exitCode, exitReason: info.exitReason };
      if (!options.waitFor) return state;
      if (screen.screen.join("\n").includes(options.waitFor)) return { ...state, wait: "matched" };
      if (!info.alive) return { ...state, wait: "exited" };
      if (Date.now() >= deadline) return { ...state, wait: "timeout" };
      await delay(Math.min(50, deadline - Date.now()), undefined, { signal: options.signal });
    }
  }

  close(taskId: string, terminalId: string, sessionId: string): void {
    this.owned(taskId, terminalId, sessionId);
    this.host.release(this.owner(taskId, terminalId));
    this.taskTerminals.get(taskId)?.delete(terminalId);
  }

  closeTask(taskId: string): void {
    for (const id of this.taskTerminals.get(taskId)?.keys() ?? []) this.host.release(this.owner(taskId, id));
    this.taskTerminals.delete(taskId);
  }
}
