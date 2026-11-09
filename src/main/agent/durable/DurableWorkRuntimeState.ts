import type { HarnessInspection } from "@earendil-works/pi-durable";
import type { WorkRuntimeState } from "../../../shared/bot-work-phase3";

/** A persisted placed/queued input is not proof that this host is executing it. */
export function durableWorkRuntimeState(inspection: HarnessInspection): { runtimeState: WorkRuntimeState; runtimeReason: string } {
  if (inspection.scheduling === "closing") return { runtimeState: "interrupted", runtimeReason: "执行宿主正在关闭；保留原始回执，启动后核对恢复，不代表任务已完成" };
  if (inspection.scheduling === "paused") return { runtimeState: "recovering", runtimeReason: "上次执行尚未结束，当前宿主正在恢复原执行；尚未开始调度，不会重新提交任务" };
  if (inspection.tasks.some(task => task.state.kind === "running")) return { runtimeState: "running", runtimeReason: "当前宿主已确认原生执行仍在运行" };
  const blocked = inspection.tasks.find(task => task.state.kind === "blocked");
  if (blocked?.state.kind === "blocked") return { runtimeState: "interrupted", runtimeReason: `原生执行暂不能恢复：${blocked.state.reason}；已保留原始回执，不会重放未知效果` };
  return { runtimeState: "waiting", runtimeReason: "执行宿主在线，原执行正在等待调度、依赖或回执；尚无完成结果" };
}
