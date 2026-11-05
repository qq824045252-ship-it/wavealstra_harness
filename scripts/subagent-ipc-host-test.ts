/**
 * 主进程 subagent IPC 宿主：扩展未加载时 stub 必须返回空值，
 * 加载后委托 backend；二次 register 不得再次 handle。
 */
import {
  getSubagentIpcBackend,
  handleSubagentActive,
  handleSubagentCancel,
  handleSubagentSteer,
  handleSubagentTranscript,
  registerSubagentIpcHost,
  resetSubagentIpcHostForTests,
  setSubagentIpcBackend,
  SUBAGENT_IPC_HOST_KEY,
} from "../src/main/agent/subagent-ipc-host";

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

async function main(): Promise<void> {
  resetSubagentIpcHostForTests();

  console.log("== stub：无 backend ==");
  assert(Array.isArray(handleSubagentActive()) && (handleSubagentActive() as unknown[]).length === 0, "active → []");
  const tr = handleSubagentTranscript("x") as { record: null; ended: boolean; entries: unknown[] };
  assert(tr.record === null && tr.ended === true && Array.isArray(tr.entries), "transcript → ended");
  const steer = (await handleSubagentSteer("x", "go")) as { ok: boolean; message: string };
  assert(steer.ok === false && steer.message.includes("尚未就绪"), "steer → 未就绪");
  const cancel = (await handleSubagentCancel("x")) as { ok: boolean };
  assert(cancel.ok === false, "cancel → 未就绪");

  console.log("== register 幂等 + 全局槽 ==");
  const handles: string[] = [];
  const ipcMain = {
    handle(channel: string): void {
      handles.push(channel);
    },
  };
  registerSubagentIpcHost(ipcMain);
  registerSubagentIpcHost(ipcMain);
  assert(handles.length === 4, `handle 恰好 4 次（${handles.join(",")}）`);
  assert(
    handles.includes("subagent:active") &&
      handles.includes("subagent:transcript") &&
      handles.includes("subagent:steer") &&
      handles.includes("subagent:cancel"),
    "四通道齐全",
  );
  const slot = (globalThis as Record<string, unknown>)[SUBAGENT_IPC_HOST_KEY] as {
    setBackend: typeof setSubagentIpcBackend;
    getBackend: typeof getSubagentIpcBackend;
  };
  assert(typeof slot?.setBackend === "function", "globalThis 宿主槽已挂");

  console.log("== backend 接管 ==");
  slot.setBackend({
    active: () => [{ subagentId: "sa-1", displayName: "皮卡丘" }],
    transcript: (id: string) => ({ record: { subagentId: id, displayName: "皮卡丘" }, entries: [1], ended: false }),
    steer: async () => ({ ok: true, delivered: "rpc-steer", message: "ok" }),
    cancel: async () => ({ ok: true, message: "cancelled" }),
  });
  const active = handleSubagentActive() as Array<{ subagentId: string; displayName?: string }>;
  assert(active[0]?.subagentId === "sa-1", "active 委托 backend");
  assert(active[0]?.displayName === "皮卡丘", "active DTO 透传 displayName");
  const live = handleSubagentTranscript("sa-1") as {
    ended: boolean;
    entries: unknown[];
    record?: { displayName?: string } | null;
  };
  assert(live.ended === false && live.entries.length === 1, "transcript 委托 backend");
  assert(live.record?.displayName === "皮卡丘", "transcript DTO 透传 displayName");
  const steered = (await handleSubagentSteer("sa-1", "x")) as { ok: boolean };
  assert(steered.ok === true, "steer 委托 backend");
  const cancelled = (await handleSubagentCancel("sa-1")) as { ok: boolean };
  assert(cancelled.ok === true, "cancel 委托 backend");

  slot.setBackend(null);
  assert((handleSubagentActive() as unknown[]).length === 0, "卸 backend 后回到 stub");

  console.log("== 旧扩展二次 handle 被吸收 ==");
  let secondHandleThrew = false;
  try {
    ipcMain.handle("subagent:active", () => [{ subagentId: "legacy-1" }]);
  } catch {
    secondHandleThrew = true;
  }
  assert(!secondHandleThrew, "旧扩展 handle 不抛 second handler");
  const adopted = handleSubagentActive() as Array<{ subagentId: string }>;
  assert(adopted[0]?.subagentId === "legacy-1", "吸收的旧 handler 生效");

  console.log("== reset 后复用同一 mock 必须仍真实注册 ==");
  resetSubagentIpcHostForTests();
  const reusedChannels: string[] = [];
  const reused = {
    handle(channel: string): void {
      reusedChannels.push(channel);
    },
  };
  registerSubagentIpcHost(reused);
  const firstRound = reusedChannels.length;
  resetSubagentIpcHostForTests();
  registerSubagentIpcHost(reused);
  assert(
    firstRound === 4 && reusedChannels.length === 8,
    `reset 后复用同一 mock 仍注册 4 次（first=${firstRound} total=${reusedChannels.length}）`,
  );

  resetSubagentIpcHostForTests();
  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
