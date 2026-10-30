/**
 * 安卓端时间轴对账：同一条用户消息只能占一个轮次。
 * 文本归一化 / 时钟容错 / 附件一侧缺失 任意一项退化，都会让助手回复在两个 anchor 下各渲染一遍
 * （现场表现就是「对话内容重复显示」）。
 * Run: npm run test:remote-timeline
 */
import assert from "node:assert/strict";
import type { RemoteHistoryMessage, RemoteTaskHistory } from "../shared/src/remote-contract";
import {
  buildRemoteTimeline,
  reconcileLiveMessagesWithHistory,
} from "../app/remote/src/store/remoteTimeline";

const T0 = 1_760_000_000_000;
const REPLY = "后端已修好，前端也查了。";

function turn(userText: string, at: number, attachments?: { name: string }[]): RemoteHistoryMessage[] {
  return [
    { id: "hist-user-0", role: "user", text: userText, createdAt: at, ...(attachments ? { attachments } : {}) },
    { id: "hist-asst-1", role: "assistant", text: REPLY, createdAt: at + 1000 },
  ];
}

function project(historyMessages: RemoteHistoryMessage[], liveText: string, lagMs = 500) {
  const history: RemoteTaskHistory = { taskId: "t", messages: historyMessages };
  const live = {
    "remote-user-abc": { id: "remote-user-abc", role: "user" as const, text: liveText, createdAt: T0 + lagMs },
    "remote-asst-def": {
      id: "remote-asst-def", role: "assistant" as const, text: REPLY,
      createdAt: T0 + 1000 + lagMs, streaming: false, replyToId: "remote-user-abc",
    },
  };
  const reconciled = reconcileLiveMessagesWithHistory(live, history);
  const timeline = buildRemoteTimeline(history.messages, live);
  return {
    users: timeline.filter(m => m.role === "user"),
    assistants: timeline.filter(m => m.role === "assistant"),
    liveUsersLeft: Object.values(reconciled).filter(m => m.role === "user"),
  };
}

// 1. 服务端投影会把 3+ 换行压成空行；手机存的即时气泡是用户原文。
{
  const { users, assistants } = project(turn("第一行\n\n第二行", T0), "第一行\n\n\n\n第二行");
  assert.equal(users.length, 1, "多空行差异不得拆成两轮");
  assert.equal(assistants.length, 1, "助手回复只渲染一次");
}

// 2. 完全一致：基线。
{
  const { users, assistants } = project(turn("第一行\n\n第二行", T0), "第一行\n\n第二行");
  assert.equal(users.length, 1);
  assert.equal(assistants.length, 1);
}

// 3. 手机与服务端时钟偏移超过 30s：文本唯一时仍要对上。
{
  const { users, assistants } = project(turn("同一句话", T0), "同一句话", 45_000);
  assert.equal(users.length, 1, "时钟偏移不得拆成两轮");
  assert.equal(assistants.length, 1);
}

// 4. 旧缓存里的历史仍带对话 Goal 注入尾巴。
{
  const { users } = project(turn("同一句话\n\n## 当前 Task 的对话 Goal（跨轮目标）\n目标：X\n状态：active", T0), "同一句话");
  assert.equal(users.length, 1, "注入尾巴不得拆成两轮");
}

// 5. 一侧缺附件记录（旧缓存/断流补发）：不能因此判为不同轮次。
{
  const { users } = project(turn("看这张图", T0, [{ name: "a.png" }]), "看这张图");
  assert.equal(users.length, 1, "附件一侧缺失不得拆成两轮");
}

// 6. 两句相同的「继续」是两个真实轮次，唯一候选兜底不得误并。
{
  const history = [
    { id: "hist-user-0", role: "user" as const, text: "继续", createdAt: T0 },
    { id: "hist-asst-1", role: "assistant" as const, text: "第一轮", createdAt: T0 + 1000 },
    { id: "hist-user-2", role: "user" as const, text: "继续", createdAt: T0 + 5000 },
    { id: "hist-asst-3", role: "assistant" as const, text: "第二轮", createdAt: T0 + 6000 },
  ];
  const { users, liveUsersLeft } = project(history, "继续", 40_000);
  assert.equal(users.length, 3, "两个历史轮次 + 一个未匹配的即时轮次");
  assert.equal(liveUsersLeft.length, 1, "候选不唯一时必须保留即时气泡，不能并到历史轮次里");
}

console.log("remote-timeline-test: ok");
