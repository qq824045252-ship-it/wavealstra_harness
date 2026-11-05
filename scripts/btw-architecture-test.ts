/**
 * BTW（临时上下文分支）架构守卫测试。
 *
 * 行为级隔离已由 btw-isolation-test 覆盖；这里做两件事：
 * 1) 通道级断言：btw:event 与 agent:event / cron / gateway / mcp 通道物理隔离；
 * 2) 源码级红线扫描：BTW 生命周期方法不得触碰主任务管道
 *    （applyAgentPatch / emitPatch / registry 写 / DB 写 / sessionFile 落盘 / SessionManager.create），
 *    持久执行记录独立于主任务消息。源码扫描仅保护通道与依赖隔离。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAppStoreModule } from "./read-app-store-source";
import { AgentIpc, BtwIpc, CronIpc, GatewayIpc, McpIpc } from "../src/shared/agent-ipc";

let passed = 0;
function ok(cond: unknown, label: string): void {
  assert.ok(cond, label);
  passed += 1;
}

// ---- 1. 事件通道物理隔离 ----
{
  const allChannels = [
    BtwIpc.event,
    AgentIpc.event,
    AgentIpc.authEvent,
    CronIpc.event,
    GatewayIpc.event,
    McpIpc.statusEvent,
  ];
  ok(new Set(allChannels).size === allChannels.length, "1.1 btw:event 与 agent/cron/gateway/mcp 通道互不重合");
  ok(![String(AgentIpc.event)].includes(BtwIpc.event), "1.2 BTW 事件不走 agent:event");
}

const repo = process.cwd();
const agentService = readFileSync(join(repo, "src/main/agent/AgentService.ts"), "utf8");
const btwService = readFileSync(join(repo, "src/main/agent/BtwSessionService.ts"), "utf8");
const btwStore = readFileSync(join(repo, "src/renderer/src/store/btwStore.ts"), "utf8");
const chatInput = readFileSync(join(repo, "src/renderer/src/components/chat/ChatInput.tsx"), "utf8");
const preload = readFileSync(join(repo, "src/preload/index.ts"), "utf8");

// 提取 BTW 区块（主进程）——从 BTW 注释头到下一个非 BTW 私有方法
const btwSection = btwService;
ok(Boolean(btwSection), "2.0 dedicated BTW service source loaded");

// ---- 2. BTW service red-line scan ----
{
  ok(!/AgentIpc\.event/.test(btwSection), "2.1 BTW service never emits agent:event");
  ok(/this\.deps\.emitPatch\(/.test(btwSection), "2.2 BTW service uses dedicated patch bridge");
  ok(!/this\.deps\.registry\.set\(/.test(btwSection), "2.3 BTW service never writes SessionRegistry");
  ok(!/this\.deps\.registry\.delete\(/.test(btwSection), "2.4 BTW service never deletes main registry entries");
  ok(
    !/this\.deps\.db\.(upsertTask|createTask|insertTask|deleteTask|setTaskContextUsage|updateTask)/.test(btwSection),
    "2.5 BTW service performs no task DB writes",
  );
  ok(!/writeFileSync|appendFileSync|copyFileSync|rmSync|mkdirSync|unlinkSync/.test(btwSection), "2.6 BTW service performs no filesystem writes");
  ok(!/setSessionFile/.test(btwSection), "2.7 BTW service never sets sessionFile");
  ok(!/createTransientSession|createAuthoringSession/.test(agentService), "2.8 auxiliary execution has no AgentSession factory");
  ok(/openAuxiliaryRuntime/.test(agentService) && /openRuntime/.test(btwSection), "2.9 BTW uses the shared Durable host");
  ok(/canStartBtwSession\(/.test(btwSection), "2.10 BTW session hard limit remains");
  ok(/schedulePrune\(/.test(btwSection), "2.11 BTW keepalive prune remains");
  ok(/runtime\.close\(/.test(btwSection), "2.12 BTW closes its Durable host");
  ok(/taskId: request\.btwId/.test(btwSection), "2.13 BTW patch taskId remains btwId");
  ok(
    /return this\.btwService\.start\(req\)/.test(agentService) &&
      /return this\.btwService\.prompt\(req\)/.test(agentService),
    "2.14 AgentService BTW API is a thin service facade",
  );
}
// ---- 3. renderer btwStore 红线扫描 ----
{
  ok(!/applyAgentPatch\(/.test(btwStore), "3.1 btwStore 不经过任务 reducer（applyAgentPatch）");
  ok(/applyBtwPatch/.test(btwStore), "3.2 btwStore 使用独立 applyBtwPatch");
  ok(/patch\.btwId !== s\.btwId/.test(btwStore), "3.3 btwStore 按 btwId 路由，不匹配一律丢弃");
  ok(!/\.messages\.push\(/.test(btwStore), "3.4 btwStore 不写 Task.messages（无 push 变异；仅不可变替换本 store 消息）");
  ok(/btw-\$/.test(btwStore) || /btw-\${/.test(btwStore), "3.5 btwId/消息 id 使用 btw-* 前缀");
}

// ---- 4. preload 订阅通道正确性 ----
{
  ok(/ipcRenderer\.on\(AgentIpc\.event/.test(preload), "4.1 agent:event 订阅仍走 AgentIpc.event");
  ok(/ipcRenderer\.on\(BtwIpc\.event/.test(preload), "4.2 btw:event 订阅走 BtwIpc.event（独立通道）");
}

// ---- 5. ChatInput BTW 发送路由红线（P0 回归保护）----
// 历史回归：textarea 已切 btwText，但 send() 仍 send(text)+setText("")，
// 导致 BTW 发不出去且清空主草稿。以下断言固化“发送只消费 btwText”的路由。
{
  ok(/btwComposerSendInput\(btwActive, btwText\)/.test(chatInput), "5.1 ChatInput 发送走纯函数路由（消费 btwText）");
  ok(!/getState\(\)\.send\(text\)/.test(chatInput), "5.2 不存在 send(text) 直连 BTW 的回归路径");
  // send() 的 btwActive 分支块（首个 if (btwActive) { ... return; }；兼容 CRLF）
  const btwSendBlock = /if \(btwActive\) \{[\s\S]*?return;\r?\n    \}/.exec(chatInput);
  ok(Boolean(btwSendBlock), "5.3 找到 send() 的 btwActive 分支块");
  ok(btwSendBlock && !/setText\(/.test(btwSendBlock[0]), "5.4 BTW 分支不触碰主草稿（无 setText）");
  ok(btwSendBlock && /setBtwText\(""\)/.test(btwSendBlock[0]), "5.5 BTW 分支只清空 btwText");
  ok(/sessionBtwId/.test(btwStore), "5.6 btwStore.send 捕获会话身份（P1 守卫）");
  ok(
    /!now\.active \|\| now\.btwId !== btwId/.test(btwStore) ||
      /now\.active \|\| now\.btwId !== sessionBtwId/.test(btwStore),
    "5.7 prompt reject 仅在 active 且 btwId 未变时写回（late-session 污染守卫）",
  );
}

// ---- 6. 本轮 P2 修复的架构红线 ----
{
  const btwPanel = readFileSync(join(repo, "src/renderer/src/components/chat/BtwPanel.tsx"), "utf8");
  // 6a. start 在途发送排队：starting/ready/pendingSend + 自动补发
  ok(/starting: true/.test(btwStore) && /ready: true/.test(btwStore), "6.1 btwStore 有 starting/ready 状态机");
  ok(/pendingSend: \{[\s\S]*?text/.test(btwStore) || /pendingSend/.test(btwStore), "6.2 btwStore 有排队载荷 pendingSend");
  ok(/promptBtwTurn\(btwId, pending\.text/.test(btwStore), "6.3 start 完成后自动补发排队首轮");
  ok(/首轮未发送/.test(btwStore), "6.4 start 失败 + 已排队首轮 → 明确错误提示");
  // 6b. 带回幂等
  ok(/lastBringBackUserMsgId/.test(btwStore), "6.5 带回幂等键（同轮不重复追加）");
  // 6c. 超时兜底：不允许永久卡 streaming
  ok(/isStreamingStalled/.test(btwStore) && /BTW_STREAMING_TIMEOUT_MS/.test(btwStore), "6.6 streaming 超时兜底判定存在");
  ok(/settleStalledStream/.test(btwStore), "6.7 超时兜底本地 settle 存在");
  ok(/streamingSince/.test(btwStore), "6.8 streamingSince 计时字段存在");
  // 6d. Esc overlay 统一语义：ChatInput 传 overlayOpen，BtwPanel 守卫
  ok(/overlayOpen=\{btwOverlayOpen\}/.test(chatInput), "6.9 ChatInput 向 BtwPanel 传递更高层弹层状态");
  ok(/if \(overlayOpen\) return;/.test(btwPanel), "6.10 面板 Esc 遇更高层弹层时让事件继续传播（一次 Esc 只关一层）");
  // 6e. 滚动跟随状态机
  ok(/followBottom/.test(btwPanel), "6.11 面板滚动跟随状态机存在");
  ok(/scrollHeight - el\.scrollTop - el\.clientHeight < 48/.test(btwPanel), "6.12 接近底部才跟随（用户上滚暂停）");
  // 6f. 折叠态 notice/error 可见 + 主草稿待同步提示
  ok(/主线草稿待同步/.test(btwPanel), "6.13 面板提示主草稿待同步（不丢、语义清楚）");
  ok(/if \(btwActive\) return;/.test(chatInput), "6.14 BTW 激活期间 composerDraft 暂停消费（退出后自动注入）");
  // 6g. 多窗口 btwId 全局唯一（随机段防线）
  ok(/btwRand/.test(btwStore), "6.15 btwId 生成含随机段（多窗口各自 counter 不碰撞）");
  ok(/Math\.random\(\)\.toString\(36\)/.test(btwStore), "6.16 随机段基于 Math.random（跨窗口唯一）");
}

// ---- 7. 系统级生命周期 / 资源释放 / 多窗口隔离（源码级红线）----
{
  const taskLifecycle = readAppStoreModule("commands/taskLifecycle.ts");
  const taskUiTransition = readAppStoreModule("transitions/taskUiTransition.ts");
  // 7a. 应用退出：dispose() 路径必须释放全部 BTW 会话
  ok(/this\.btwService\.disposeAll\(\);/.test(agentService), "7.1 主进程 dispose 调用 BtwSessionService disposeAll（app quit 全释放）");
  // Explicit stop and application shutdown have distinct native semantics.
  const closeMethod = btwSection.slice(btwSection.indexOf("  async close("), btwSection.indexOf("  keepalive("));
  const disposeMethod = btwSection.slice(btwSection.indexOf("  disposeAll("), btwSection.indexOf("  private schedulePrune("));
  ok(/runtime\.abort\(/.test(closeMethod), "7.2 explicit close cancels execution");
  ok(/runtime\.close\(/.test(closeMethod), "7.3 explicit close releases host resources");
  ok(!/\.abort\(/.test(disposeMethod), "7.4 application shutdown preserves pending execution");
  ok(/runtime\.close\(/.test(disposeMethod), "7.5 application shutdown closes host");
  // 7c. prune 定时器生命周期：最后一个会话释放后清理，不泄漏
  ok(/clearTimeout\(this\.pruneTimer\);/.test(btwSection), "7.6 prune 定时器在会话清空后取消");
  ok(/pruneTimer = null;/.test(btwSection), "7.7 prune 定时器引用复位");
  // 7d. keepalive 按 btwId 精确匹配（多窗口互不抢心跳）
  ok(/for \(const id of ids\)/.test(btwSection) && /this\.sessions\.get\(id\)/.test(btwSection), "7.8 keepalive 仅续命调用方声明的 btwId（窗口间不互抢）");
  // 7e. 父任务校验：未知父任务拒绝创建（不隐式建任务）
  ok(/BTW 父任务不存在/.test(btwSection), "7.9 startBtw 对未知父任务抛错（不静默创建）");
  ok(/if \(!task\) throw new Error/.test(btwSection), "7.10 missing parent fails closed");
  // 7g. renderer 侧：keepalive 定时器在会话关闭后自清（不泄漏）
  ok(/clearInterval\(keepaliveTimer\);/.test(btwStore), "7.11 renderer keepalive 定时器自清");
  ok(/keepaliveTimer = null;/.test(btwStore), "7.12 renderer keepalive 引用复位");
  // 7h. renderer 侧 IPC 失败全部吞错（start/prompt 已有；abort/close/keepalive 不抛）
  ok(/\.catch\(\(\) => undefined\)/.test(btwStore), "7.13 abort/close/keepalive 的 IPC 失败被吞（不卡 UI）");
  // 7i. 删任务 → activeTaskId 切换 → ChatInput effect 销毁 BTW（链路存在）
  ok(
    /const nextTaskId = tasks\[0\]\?\.id \?\? null/.test(taskLifecycle) &&
      /resetTaskScopedUiState\(s, \{[\s\S]*?nextTaskId/.test(taskLifecycle) &&
      /activeTaskId: options\.nextTaskId/.test(taskUiTransition),
    "7.14 deleting active task updates activeTaskId through reset helper (triggers destroyIfParentChanged)",
  );
  ok(/destroyIfParentChanged\(activeTaskId\)/.test(chatInput), "7.15 ChatInput 挂载时按 activeTaskId 校验父任务（切换/删除即结束当前观察）");
  // 7j. BTW 无主任务 registry 写；父任务权限由辅助宿主绑定检查
  ok(!/this\.deps\.registry\.set\(/.test(btwSection), "7.16 BTW 不向 registry 注册（无幽灵条目）");
}

console.log(`[btw-architecture-test] passed=${passed} failed=0`);
