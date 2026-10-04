/**
 * subagent 扩展 IPC 注册事务性测试（问题 3）。
 *
 * 覆盖：扩展 factory 部分注册后失败不得污染进程级 registry：
 * - 场景 A：工具/事件注册中途抛错 → factory 失败 → IPC 零注册（registerIpc 在
 *   factory 末尾，失败路径不产生进程级副作用）；
 * - 场景 B：registerIpc 中途抛错（模拟同名 channel 已被残留占用）→ rollbackIpc
 *   移除已注册的 channel 与 registry 监听 → 无残留；
 * - 场景 C：回滚后重新执行同一 factory → 同名 handler 可重新注册成功（4 channels）。
 *
 * 加载方式仅用于测试隔离重载：jiti 动态加载真实 src/main/capabilities/subagent/index.ts，
 * electron 经 virtualModules 注入 mock（状态由本测试文件直接持有）；
 * 数据目录经 PI_CODING_AGENT_DIR 重定向到 sandbox（避免 gcLegacy/registry 触碰
 * 真实 ~/.mybuddy/subagent）。
 */
import { createJiti } from "jiti";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sandbox = mkdtempSync(join(tmpdir(), "subagent-ipc-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

interface IpcMock {
  channels: string[];
  handleCalls: number;
  /** >0 时第 N 次 handle 调用抛错（模拟同名 channel 残留占用） */
  failOnHandleAt: number;
}

/** electron mock（virtualModules 注入；状态由测试持有） */
function makeElectronMock(): { ipcMain: unknown; BrowserWindow: unknown } {
  const mock: IpcMock = { channels: [], handleCalls: 0, failOnHandleAt: 0 };
  (globalThis as Record<string, unknown>).__subagentIpcMock = mock;
  const ipcMain = {
    handle(channel: string, _fn: unknown): void {
      mock.handleCalls += 1;
      // 与 Electron 一致：重复注册抛错且 handler 不写入（throw 在注册前）
      if (mock.failOnHandleAt > 0 && mock.handleCalls === mock.failOnHandleAt) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      mock.channels.push(channel);
    },
    removeHandler(channel: string): void {
      mock.channels = mock.channels.filter((c) => c !== channel);
    },
  };
  class BrowserWindow {
    static getAllWindows(): unknown[] {
      return [];
    }
  }
  return { ipcMain, BrowserWindow };
}

function currentMock(): IpcMock {
  return (globalThis as Record<string, unknown>).__subagentIpcMock as IpcMock;
}

async function loadFactory(): Promise<(pi: never) => void> {
  const electronMock = makeElectronMock();
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: {
      electron: electronMock,
    },
  });
  const root = process.cwd(); // 测试恒在项目根目录运行
  const factory = await jiti.import(join(root, "src", "main", "capabilities", "subagent", "index"), {
    default: true,
  });
  return factory as (pi: never) => void;
}

/** fake pi：on 恒成功；registerTool 第 failOnToolCall 次抛错（0/负 = 不抛） */
function makePi(failOnToolCall = 0): { on: () => void; registerTool: () => void } {
  let tools = 0;
  return {
    on: (): void => undefined,
    registerTool: (): void => {
      tools += 1;
      if (failOnToolCall > 0 && tools === failOnToolCall) {
        throw new Error("registerTool boom");
      }
    },
  };
}

async function main(): Promise<void> {
  console.log("== 场景 A：工具注册中途抛错 → IPC 零注册 ==");
  {
    const factory = await loadFactory();
    let threw = false;
    try {
      factory(makePi(2) as never);
    } catch {
      threw = true;
    }
    assert(threw, "A: registerTool 抛错 → factory 抛错");
    assert(currentMock().channels.length === 0, `A: IPC 零注册（channels=${currentMock().channels.length}）`);
    assert(currentMock().handleCalls === 0, "A: handle 未被调用（registerIpc 未执行）");
  }

  console.log("== 场景 B：registerIpc 中途抛错 → rollback 无残留 ==");
  {
    const factory = await loadFactory();
    currentMock().failOnHandleAt = 3; // 第 3 个 handle 抛（模拟同名 channel 残留占用）
    let threw = false;
    try {
      factory(makePi() as never);
    } catch {
      threw = true;
    }
    assert(threw, "B: registerIpc 抛错 → factory 抛错");
    assert(currentMock().channels.length === 0, `B: rollback 后无残留（channels=${currentMock().channels.length}）`);
  }

  console.log("== 场景 C：回滚后同名 handler 可重新注册 ==");
  {
    const factory = await loadFactory();
    currentMock().failOnHandleAt = 0; // mock 恢复正常
    let ok = false;
    try {
      factory(makePi() as never);
      ok = true;
    } catch {
      /* ignore */
    }
    assert(ok, "C: 回滚后可重新执行 factory");
    const m = currentMock();
    assert(m.channels.length === 4, `C: 4 个 channel 全部注册成功（${m.channels.join(",")}）`);
    assert(
      m.channels.includes("subagent:transcript") && m.channels.includes("subagent:active"),
      "C: 含 subagent:transcript / subagent:active",
    );
  }

  console.log("== 场景 D：宿主已注册 stub → 扩展只 install backend，不 handle ==");
  {
    const hostState: { backend: null | { active: () => unknown } } = { backend: null };
    (globalThis as Record<string, unknown>).__mybuddySubagentIpcHost = {
      setBackend(next: { active: () => unknown } | null): void {
        hostState.backend = next;
      },
    };
    const factory = await loadFactory();
    let ok = false;
    try {
      factory(makePi() as never);
      ok = true;
    } catch {
      /* ignore */
    }
    assert(ok, "D: factory 在宿主模式下成功");
    assert(currentMock().handleCalls === 0, `D: 不走 ipcMain.handle（calls=${currentMock().handleCalls}）`);
    assert(currentMock().channels.length === 0, "D: 不注册 channel");
    assert(typeof hostState.backend?.active === "function", "D: backend 已安装");
    assert(Array.isArray(hostState.backend?.active()), "D: active() 返回数组");
    delete (globalThis as Record<string, unknown>).__mybuddySubagentIpcHost;
  }

  rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
