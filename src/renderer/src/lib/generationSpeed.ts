import type { GenerationStats } from "@shared/generation-stats";
import type { ChatMessage } from "@/types";

/** Prefer the executing reply over a queued follow-up shell. Never show a previous turn's speed. */
export function selectGenerationReply(messages: ChatMessage[]): ChatMessage | undefined {
  const active = messages.find((m) => m.role === "assistant" && m.streaming);
  if (active) return active;
  const last = messages.at(-1);
  return last?.role === "assistant" ? last : undefined;
}

export interface GenerationSpeedInput {
  stats?: GenerationStats;
  streaming: boolean;
  createdAt: number;
  approval: boolean;
}

export function generationSpeedInput(message: ChatMessage | undefined): GenerationSpeedInput {
  return {
    stats: message?.generationStats,
    streaming: Boolean(message?.streaming),
    createdAt: message?.createdAt ?? 0,
    approval: Boolean(message?.streaming && message.blocks.some(
      (block) => block.type === "tool" && block.toolCall.status === "pending_approval",
    )),
  };
}

function seconds(ms: number): string {
  const value = Math.max(0, ms) / 1000;
  return value < 60 ? `${value.toFixed(1)}s` : `${Math.floor(value / 60)}m ${Math.floor(value % 60)}s`;
}

export function generationSpeedView(input: GenerationSpeedInput, now: number): {
  label: string;
  detail: string;
} | null {
  const { stats, streaming, createdAt, approval } = input;
  if (!streaming && !stats) return null;
  const details: string[] = [];
  const tps = stats?.tps;
  const hasTps = tps != null && Number.isFinite(tps) && tps > 0;
  let label: string;
  if (!streaming) {
    const settled = stats?.phase === "complete" && !stats.estimated;
    const stopped = stats?.outcome === "aborted" || !settled;
    label = stats?.outcome === "error" ? "生成失败" : stopped ? "已停止"
      : hasTps ? `平均 ${tps.toFixed(1)} tok/s` : "已完成";
    if (settled && hasTps) details.push(`平均生成速度 ${tps.toFixed(1)} tok/s`);
    details.push("按本条回复的模型生成时长加权，排除首响应等待、工具执行和审批耗时。");
    if (!hasTps || !settled) details.push("本次未取得完整的速度统计。");
  } else if (approval) {
    label = "等待批准";
    details.push("等待工具执行授权，此时不统计生成速度。");
  } else if (stats?.phase === "tools") {
    label = "工具执行中";
    details.push("工具执行期间不统计生成速度。");
  } else if (stats?.phase === "retrying") {
    const retry = stats.retry;
    const budget = retry?.maxAttempts !== undefined ? `/${retry.maxAttempts}` : "";
    label = retry ? `正在重试 ${retry.attempt}${budget}` : "正在重试";
    if (retry) details.push(`上次中断：${retry.error}`);
    details.push("模型请求正在重试，等待期间不统计生成速度。");
  } else if (stats?.phase === "compacting") {
    label = "整理上下文";
    details.push("正在压缩上下文，此时不统计生成速度。");
  } else if (stats?.phase === "generating") {
    const stalled = now - stats.updatedAt >= 3000;
    label = stalled ? `等待输出 ${seconds(now - stats.updatedAt)}`
      : hasTps ? `≈${tps.toFixed(1)} tok/s` : "正在生成";
    details.push(stalled ? "流式输出暂未更新，恢复后继续显示速度。"
      : "实时估算：当前模型调用收到的文本、思考和工具参数，按字符粗估 token；每半秒刷新。");
    details.push("估算值不用于用量计费；结束后使用模型返回的 token 数计算平均速度。");
  } else {
    label = `等待 ${seconds(now - (stats?.startedAt ?? createdAt))}`;
    details.push("等待模型输出，首响应等待不计入生成速度。");
  }
  // A retry makes the current attempt the long one (large tool arguments); show it, don't hide it.
  if ((stats?.attempts ?? 1) > 1 && stats?.retry && stats.phase !== "retrying") {
    details.push(`第 ${stats.attempts} 次尝试；上次中断：${stats.retry.error}`);
    if (stats.phase !== "complete") label += ` · 第 ${stats.attempts} 次尝试`;
  }
  if (stats?.outputTokens != null && !streaming) {
    details.push(`输出 ${stats.outputTokens.toLocaleString()} tokens`);
  }
  if (stats?.ttftMs != null) details.push(`首响应 ${seconds(stats.ttftMs)}（含思考或工具参数）`);
  return { label, detail: details.join("\n") };
}
