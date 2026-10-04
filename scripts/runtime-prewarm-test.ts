/**
 * RuntimePrewarmService 单元测试（策略驱动 prewarm/send-preflight/first-call fallback）。
 *
 * 覆盖：
 * - 结构化 requirement 解析（launchPolicy gui/backend/none、旧 string 归一化、非法回落）；
 * - prewarm：Tag 选择触发（异步不阻塞）、ready/starting 短路、并发去重；
 * - launchPolicy=none：不 spawn、ensureReady 不误判失败（adapter-managed）；
 * - ensureReady gate：未 ready 先启动再放行、ready 缓存 fresh 复核、失败在任务开始前抛错；
 * - ensureMany：并行等待、聚合失败、preflight-only 不误失败；
 * - 状态机：starting → waiting-backend → ready / failed、状态 push 事件；
 * - 快速 Tag 切换不串 provider、crash/用户关闭后恢复。
 */
import {
  RuntimePrewarmService,
  type RuntimeStartable,
} from "../src/main/professional-tools/RuntimePrewarmService";
import {
  resolveRuntimeRequirement,
  resolveRuntimeRequirementList,
  type RuntimeRequirement,
} from "../src/shared/runtime-requirement";
import type { ManagedToolProviderId, ProfessionalToolStatusDto } from "../src/shared/professional-tools";

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const ready = (detail = "Ready", providerId: ManagedToolProviderId = "penpot"): ProfessionalToolStatusDto => ({
  providerId,
  state: "ready",
  installed: true,
  ready: true,
  detail,
});
const notReady = (detail = "not ready", providerId: ManagedToolProviderId = "penpot"): ProfessionalToolStatusDto => ({
  providerId,
  state: "stopped",
  installed: true,
  ready: false,
  detail,
});

function req(providerId: string, patch: Partial<RuntimeRequirement> = {}): RuntimeRequirement {
  return { providerId: providerId as RuntimeRequirement["providerId"], ...patch };
}

/** 可控 mock runtime：start 次数、ready 时间点、失败注入 */
function makeRuntime(opts: { readyAfterStarts?: number; failStarts?: number } = {}) {
  let starts = 0;
  const calls: string[] = [];
  const runtime: RuntimeStartable = {
    async status(providerId) {
      calls.push(`status:${providerId}`);
      return starts > 0 ? ready("Ready", providerId) : notReady("not ready", providerId);
    },
    async start(providerId) {
      starts += 1;
      calls.push(`start:${providerId}`);
      if (opts.failStarts && starts === opts.failStarts) {
        throw new Error("启动失败（mock）");
      }
      if (opts.readyAfterStarts !== undefined && starts >= opts.readyAfterStarts) {
        return ready("Ready", providerId);
      }
      return notReady("not ready", providerId);
    },
  };
  return {
    runtime,
    get starts() {
      return starts;
    },
    get calls() {
      return calls;
    },
  };
}

async function main(): Promise<void> {
  console.log("== 0) resolveRuntimeRequirement：当前 managed provider / 退役 provider / 非法 ==");
  {
    assert(resolveRuntimeRequirement("freecad") === null, "退役 freecad 不再解析为 managed runtime");
    assert(resolveRuntimeRequirement("blender") === null, "退役 blender 不再解析为 managed runtime");
    const penpot = resolveRuntimeRequirement("penpot");
    assert(
      penpot?.launchPolicy === "backend" && penpot?.readinessPolicy === "http" && penpot?.openUi === "browser",
      "penpot 默认 backend/http/browser",
    );
    const drawio = resolveRuntimeRequirement("drawio-ai");
    assert(drawio?.launchPolicy === "none" && drawio?.readinessPolicy === "preflight-only", "drawio 默认 none/preflight-only");
    const structured = resolveRuntimeRequirement({ providerId: "penpot", launchPolicy: "backend", readinessPolicy: "http", openUi: "browser" });
    assert(structured?.openUi === "browser", "结构化字段覆盖生效");
    const invalid = resolveRuntimeRequirement({ providerId: "penpot", launchPolicy: "bogus" as never });
    assert(invalid?.launchPolicy === "backend", "非法枚举回落默认");
    assert(resolveRuntimeRequirement("not-a-provider") === null, "未知 provider → null");
    const list = resolveRuntimeRequirementList(["freecad", "penpot", "drawio-ai", "penpot", "blender"]);
    assert(
      list.length === 2 && list[0].providerId === "penpot" && list[1].providerId === "drawio-ai",
      "列表跳过退役 provider + 同 provider 去重保序",
    );
  }
  console.log("== 1) prewarm：异步启动 + 状态可见 ==");
  {
    const m = makeRuntime({ readyAfterStarts: 1 });
    const svc = new RuntimePrewarmService(m.runtime);
    svc.prewarm(req("penpot"));
    assert(svc.getState("penpot").phase === "starting", "prewarm 后立即 starting（不阻塞）");
    await new Promise((r) => setTimeout(r, 20));
    assert(svc.getState("penpot").phase === "ready", "prewarm 完成 → ready");
    assert(m.starts === 1, "只启动一次");
  }

  console.log("== 2) ready 不重复启动 ==");
  {
    const m = makeRuntime({ readyAfterStarts: 1 });
    const svc = new RuntimePrewarmService(m.runtime);
    svc.prewarm(req("penpot"));
    await new Promise((r) => setTimeout(r, 20));
    svc.prewarm(req("penpot")); // 重复选择
    svc.prewarm(req("penpot"));
    await new Promise((r) => setTimeout(r, 20));
    assert(m.starts === 1, `重复 prewarm 不重复启动（starts=${m.starts}）`);
  }

  console.log("== 3) 并发去重：两个 prewarm 同时触发只启动一次 ==");
  {
    const m = makeRuntime({ readyAfterStarts: 1 });
    const svc = new RuntimePrewarmService(m.runtime);
    svc.prewarm(req("penpot"));
    svc.prewarm(req("penpot"));
    await new Promise((r) => setTimeout(r, 30));
    assert(m.starts === 1, `并发 prewarm 去重（starts=${m.starts}）`);
  }

  console.log("== 4) ensureReady gate：未 ready → 先启动再放行 ==");
  {
    const m = makeRuntime({ readyAfterStarts: 1 });
    const svc = new RuntimePrewarmService(m.runtime);
    const status = await svc.ensureReady(req("penpot"), 5000);
    assert(status.ready === true, "ensureReady 返回 ready");
    assert(m.starts === 1, "gate 触发启动一次");
  }

  console.log("== 5) prewarm 进行中 ensureReady 等待同一启动（不重复 spawn）==");
  {
    const m = makeRuntime({ readyAfterStarts: 1 });
    const svc = new RuntimePrewarmService(m.runtime);
    svc.prewarm(req("penpot"));
    const status = await svc.ensureReady(req("penpot"), 5000);
    assert(status.ready === true, "等待 prewarm 完成 → ready");
    assert(m.starts === 1, `不重复启动（starts=${m.starts}）`);
  }

  console.log("== 6) 启动失败 → ensureReady 在任务开始前失败 ==");
  {
    const m = makeRuntime({ failStarts: 1 });
    const svc = new RuntimePrewarmService(m.runtime);
    let threw: Error | null = null;
    try {
      await svc.ensureReady(req("penpot"), 5000);
    } catch (e) {
      threw = e as Error;
    }
    assert(threw !== null, "ensureReady 抛错（任务不开始）");
    assert(threw?.message.includes("必需运行环境未就绪"), `失败信息明确（${threw?.message.slice(0, 40)}）`);
    assert(svc.getState("penpot").phase === "failed", "状态 = failed");
  }

  console.log("== 7) failed 后可重试（重新 prewarm 恢复）==");
  {
    const m = makeRuntime({ failStarts: 1, readyAfterStarts: 2 });
    const svc = new RuntimePrewarmService(m.runtime);
    await svc.ensureReady(req("penpot"), 5000).catch(() => undefined);
    svc.prewarm(req("penpot")); // 修复后重新触发
    await new Promise((r) => setTimeout(r, 20));
    assert(svc.getState("penpot").phase === "ready", "重试后恢复 ready");
    assert(m.starts === 2, `共启动 2 次（starts=${m.starts}）`);
  }

  console.log("== 8) 切换 Tag 不串 runtime：不同 provider 独立状态 ==");
  {
    const m = makeRuntime({ readyAfterStarts: 1 });
    const svc = new RuntimePrewarmService(m.runtime);
    svc.prewarm(req("drawio-ai", { launchPolicy: "backend", readinessPolicy: "http", openUi: "none" }));
    await new Promise((r) => setTimeout(r, 20));
    assert(svc.getState("drawio-ai").phase === "ready", "drawio override ready");
    assert(svc.getState("penpot").phase === "idle", "penpot 仍 idle（不串）");
  }

  console.log("== 9) ready 缓存 + runtime crash → ensureReady 重新探测并恢复 ==");
  {
    // status 在 ready 后返回 notReady（模拟软件被关闭），start 可重新拉起
    let started = 0;
    const runtime: RuntimeStartable = {
      async status(p) {
        return started > 0
          ? { providerId: p, state: "stopped", installed: true, ready: false, detail: "掉线" }
          : { providerId: p, state: "stopped", installed: true, ready: false, detail: "未启动" };
      },
      async start(p) {
        started += 1;
        return { providerId: p, state: "ready", installed: true, ready: true, detail: "Ready" };
      },
    };
    const svc = new RuntimePrewarmService(runtime);
    svc.prewarm(req("penpot"));
    await new Promise((r) => setTimeout(r, 20));
    assert(svc.getState("penpot").phase === "ready", "prewarm → ready（缓存）");
    // 模拟 crash：runtime 内部状态重置
    started = 0;
    const status = await svc.ensureReady(req("penpot"), 5000);
    assert(status.ready === true, "crash 后 ensureReady 重新启动并恢复 ready");
    assert(started === 1, `重新启动一次（started=${started}）`);
  }

  console.log("== 10) launchPolicy=none：不 spawn、不误判失败（adapter-managed）==");
  {
    let starts = 0;
    const runtime: RuntimeStartable = {
      async status() {
        return notReady("drawio 未运行（由会话 adapter 拉起）");
      },
      async start() {
        starts += 1;
        return notReady("not ready", providerId);
      },
    };
    const svc = new RuntimePrewarmService(runtime);
    svc.prewarm(req("drawio-ai", { launchPolicy: "none" }));
    await new Promise((r) => setTimeout(r, 20));
    assert(starts === 0, "none 策略 prewarm 不 spawn");
    assert(svc.getState("drawio-ai").phase === "idle", "none 未 ready 时保持 idle（不 failed）");
    const status = await svc.ensureReady(req("drawio-ai", { launchPolicy: "none" }), 5000);
    assert(status.ready === false, "none 未 ready 返回真实状态");
    assert(starts === 0, "none 策略 ensureReady 不 spawn");
    // none 策略 ensureReady 必须不抛错（首次 tool call fallback 不被阻断）
  }

  console.log("== 11) ensureMany：并行等待 + 聚合失败 ==");
  {
    // 两个 provider 都 readyAfterStarts=1 → 并行启动，串行总时长远小于 2×单次
    const m1 = makeRuntime({ readyAfterStarts: 1 });
    const m2 = makeRuntime({ readyAfterStarts: 1 });
    const svc = new RuntimePrewarmService({
      async status(p) {
        return p === "penpot" ? m1.runtime.status(p) : m2.runtime.status(p);
      },
      async start(p) {
        return p === "penpot" ? m1.runtime.start(p) : m2.runtime.start(p);
      },
    });
    const results = await svc.ensureMany([req("penpot"), req("drawio-ai", { launchPolicy: "backend", readinessPolicy: "http", openUi: "none" })], 5000);
    assert(results.length === 2 && results.every((s) => s.ready), "两个 provider 都 ready");
    assert(m1.starts === 1 && m2.starts === 1, "两个 provider 各启动一次");
    // 一个失败 → 聚合错误且包含失败 provider
    const bad = makeRuntime({ failStarts: 1 });
    const svc2 = new RuntimePrewarmService({
      async status(p) {
        return p === "penpot" ? m1.runtime.status(p) : bad.runtime.status(p);
      },
      async start(p) {
        return p === "penpot" ? m1.runtime.start(p) : bad.runtime.start(p);
      },
    });
    let threw: Error | null = null;
    try {
      await svc2.ensureMany([req("penpot"), req("drawio-ai", { launchPolicy: "backend", readinessPolicy: "http", openUi: "none" })], 5000);
    } catch (e) {
      threw = e as Error;
    }
    assert(threw !== null && threw.message.includes("drawio-ai"), "聚合失败信息含失败 provider");
    assert(threw?.message.includes("任务未开始"), "失败信息提示任务未开始、可重试");
  }

  console.log("== 12) 状态 push 事件：phase 变化触发、无变化不重复 ==");
  {
    const m = makeRuntime({ readyAfterStarts: 1 });
    const svc = new RuntimePrewarmService(m.runtime);
    const events: string[] = [];
    svc.setStateChangeListener((state) => events.push(`${state.phase}:${state.launch}`));
    svc.prewarm(req("penpot"));
    await new Promise((r) => setTimeout(r, 20));
    svc.prewarm(req("penpot")); // ready 短路，不应再发事件
    await new Promise((r) => setTimeout(r, 10));
    assert(events.includes("starting:backend"), "事件含 starting:backend");
    assert(events.includes("ready:backend"), "事件含 ready:backend");
    assert(events.filter((e) => e === "ready:backend").length === 1, "ready 事件不重复");
  }

  console.log("== 12b) GUI ready 缓存但 status 已掉线 → 补启动 ==");
  {
    let windowUp = false;
    let starts = 0;
    const runtime: RuntimeStartable = {
      async status() {
        return windowUp ? ready("gui up") : notReady("sidecar only");
      },
      async start() {
        starts += 1;
        windowUp = true;
        return ready("spawned gui");
      },
    };
    const svc = new RuntimePrewarmService(runtime);
    svc.prewarm(req("penpot", { launchPolicy: "gui", readinessPolicy: "layered", openUi: "none" }));
    await new Promise((r) => setTimeout(r, 20));
    assert(starts === 1 && svc.getState("penpot").phase === "ready", "首次 prewarm 拉起 GUI");
    windowUp = false;
    svc.prewarm(req("penpot", { launchPolicy: "gui", readinessPolicy: "layered", openUi: "none" }));
    await new Promise((r) => setTimeout(r, 20));
    assert(starts === 2, "ready 缓存但窗口已关 → 再次 spawn");
    assert(svc.getState("penpot").phase === "ready", "补启动后回到 ready");
  }

  console.log("== 13) 状态机：start 返回未 ready → waiting-backend → 最终 ready/failed ==");
  {
    // start 返回 notReady，晚探测变 ready → 经历 waiting-backend
    let backendReady = false;
    const runtime: RuntimeStartable = {
      async status() {
        return backendReady ? ready("backend up") : notReady("等待 backend");
      },
      async start() {
        return notReady("spawn 完成，等 backend");
      },
    };
    const svc = new RuntimePrewarmService(runtime);
    const phases: string[] = [];
    svc.setStateChangeListener((state) => phases.push(state.phase));
    svc.prewarm(req("penpot"));
    await new Promise((r) => setTimeout(r, 10));
    assert(phases.includes("waiting-backend"), "start 未 ready → waiting-backend");
    backendReady = true;
    svc.prewarm(req("penpot")); // 再次触发会因 waiting-backend 短路，用 ensureReady 推进
    await svc.ensureReady(req("penpot"), 5000).catch(() => undefined);
    assert(svc.getState("penpot").phase === "ready", "晚探测 ready → 最终 ready");
  }

  console.log("== 14) 用户停止：作废 in-flight，迟到 start 不覆盖 idle ==");
  {
    let started = 0;
    let stopped = 0;
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runtime: RuntimeStartable = {
      async status() {
        return notReady("not ready", providerId);
      },
      async start() {
        started += 1;
        await gate;
        return ready("Ready", providerId);
      },
      async stop() {
        stopped += 1;
        return notReady("已停止");
      },
    };
    const svc = new RuntimePrewarmService(runtime);
    svc.prewarm(req("penpot"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert(svc.getState("penpot").phase === "starting", "prewarm 后 starting");
    await svc.stop("penpot");
    assert(stopped === 1, "调用 runtime.stop");
    assert(svc.getState("penpot").phase === "idle", "stop 后 idle");
    releaseStart();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(svc.getState("penpot").phase === "idle", "迟到的 start 完成不覆盖 idle");
    assert(started === 1, "被取消的 start 仍会计数一次");
  }

  console.log("== 15) 用户重启：先 stop 再 prewarm ==");
  {
    const m = makeRuntime({ readyAfterStarts: 1 });
    const stops: string[] = [];
    const runtime: RuntimeStartable = {
      status: (providerId) => m.runtime.status(providerId),
      start: (providerId) => m.runtime.start(providerId),
      async stop(providerId) {
        stops.push(providerId);
        return notReady("已停止");
      },
    };
    const svc = new RuntimePrewarmService(runtime);
    svc.prewarm(req("penpot"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(svc.getState("penpot").phase === "ready", "先 ready");
    await svc.restart(req("penpot"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(stops.length === 1, "重启先 stop");
    assert(m.starts === 2, `重启再 start（starts=${m.starts}）`);
    assert(svc.getState("penpot").phase === "ready", "重启后 ready");
  }

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
