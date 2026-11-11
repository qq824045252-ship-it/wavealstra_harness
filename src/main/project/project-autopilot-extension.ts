/**
 * ProjectAutopilotExtension — Project 运行状态快照工具（派生视图，非真源）。
 *
 * 语义：project_status_get 从现有源（tasks/todos/memory/reviews/project）现读派生，
 * 不调用模型、不缓存、不猜测；project_review 只写审计标记（lastReviewedAt），
 * 不直接改任何业务数据（plan/todo 等仍走 project_plan_* 既有工具）。
 * 作用域：task 绑定解析；未绑定 → 受控错误；归档生命周期检查与 context/memory 一致。
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ARCHIVED_PROJECT_WRITE_GUIDANCE } from "../../shared/project-domain";
import type { ProjectStatusSnapshotDto } from "../../shared/project-domain";
import type { PermissionMode } from "../../shared/agent-ipc";
import type { ProjectService } from "./ProjectService";

export interface ProjectAutopilotExtensionBridge {
  projectService: ProjectService;
  taskId: string;
  resolveProjectId: () => string | null;
  getPermissionMode?: () => PermissionMode;
}

class AutopilotToolError extends Error {}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? { text },
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof AutopilotToolError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    content: [{ type: "text" as const, text: `[project_status] ${message}` }],
    isError: true as const,
    details: { error: message },
  };
}

function renderStatus(snapshot: ProjectStatusSnapshotDto): string {
  const lines = [
    `## 项目运行状态：${snapshot.projectName}`,
    snapshot.goal ? `- 目标：${snapshot.goal}` : "",
    snapshot.currentStage ? `- 当前阶段：${snapshot.currentStage}` : "",
    `- 健康度：${snapshot.health === "red" ? "🔴 有阻塞" : snapshot.health === "yellow" ? "🟡 有风险" : "🟢 正常"}`,
    `- 任务：共 ${snapshot.tasks.total}（进行中 ${snapshot.tasks.doing}，停滞 ${snapshot.tasks.stale}）｜计划：共 ${snapshot.plan.total}（进行中 ${snapshot.plan.doing}，逾期 ${snapshot.plan.overdue}）｜记忆：待确认 ${snapshot.memory.openQuestions}，风险 ${snapshot.memory.risks}`,
    snapshot.lastReviewedAt ? `- 最近 review：${new Date(snapshot.lastReviewedAt).toISOString()}` : "- 尚未 review 过",
    "",
  ].filter(Boolean);
  if (snapshot.blockers.length > 0) {
    lines.push("阻塞项：");
    for (const b of snapshot.blockers) lines.push(`- [${b.source}] ${b.title}（${b.reason}）id=${b.refId}`);
  }
  if (snapshot.atRisks.length > 0) {
    lines.push("风险项：");
    for (const r of snapshot.atRisks) lines.push(`- [${r.source}] ${r.title}（${r.reason}）id=${r.refId}`);
  }
  if (snapshot.nextActions.length > 0) {
    lines.push("下一步（源驱动）：");
    for (const a of snapshot.nextActions) {
      lines.push(`- [${a.source}] ${a.title} id=${a.refId}${a.dueAt ? `（截止 ${new Date(a.dueAt).toISOString().slice(0, 10)}）` : ""}`);
    }
  } else {
    lines.push("下一步：无进行中的计划项或任务（可更新计划或新建任务）。");
  }
  lines.push(
    "说明：本快照由任务/计划/记忆等源实时派生，不缓存不猜测；更新计划请用 project_plan_update，更新长期记忆请用 memory_create / memory_update；review 用 project_review 记录。",
  );
  return lines.join("\n");
}

export function createProjectAutopilotExtension(bridge: ProjectAutopilotExtensionBridge): ExtensionFactory {
  const service = bridge.projectService;

  const requireProject = (): string => {
    const projectId = bridge.resolveProjectId();
    if (!projectId) {
      throw new AutopilotToolError("当前任务未绑定任何项目，无法查看项目运行状态。请在项目页把任务关联到项目。");
    }
    return projectId;
  };

  const guardWritable = (projectId: string): void => {
    const project = service.get(projectId);
    if (project?.archived) {
      throw new AutopilotToolError(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    }
  };

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "project_status_get",
      label: "项目状态 · 运行快照",
      description:
        "读取当前任务所属项目的运行状态快照（实时派生，非缓存）：健康度、任务/计划/记忆统计、阻塞项（高优先级且已开始的逾期计划）、风险项（其它逾期/临期计划、停滞任务、active 风险和高重要度待确认）、下一步动作（进行中的计划项与任务）。所有条目带来源引用 id，可继续用 project_plan_* / memory_search / memory_get / library_read 深入。未绑定任务报错；只读。",
      promptSnippet: "project_status_get() — 项目运行状态快照（源派生：任务/计划/记忆/review）",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        try {
          const projectId = requireProject();
          const snapshot = service.buildStatusSnapshot(projectId);
          return textResult(renderStatus(snapshot), { projectId, snapshot });
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_review",
      label: "项目状态 · 记录 review",
      description:
        "记录一次项目 review（审计标记：更新 lastReviewedAt；不修改任何业务数据）。note 可包含本轮结论/关注点（≤500 字符）。归档项目下不可用。",
      promptSnippet: "project_review(note?) — 记录项目 review（审计标记）",
      parameters: Type.Object(
        {
          note: Type.Optional(Type.String({ maxLength: 500 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { note?: string }) => {
        try {
          const projectId = requireProject();
          guardWritable(projectId);
          const review = service.recordReview(projectId, params.note, `task:${bridge.taskId}`);
          const snapshot = service.buildStatusSnapshot(projectId);
          return textResult(
            `已记录 review（${new Date(review.reviewedAt).toISOString()}）。当前健康度：${snapshot.health}。`,
            { projectId, review, snapshot },
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });

    pi.registerTool({
      name: "project_actions_list",
      label: "项目推进 · 建议动作列表",
      description:
        "列出当前项目由状态快照派生的建议动作（不猜测事实，全部带来源引用）：逾期计划项和停滞任务用于定位，风险/待确认用于提醒。建议层只读，不会修改计划或任务状态；readonly/归档项目仍可读。",
      promptSnippet: "project_actions_list() — 列出项目建议动作（只读、源派生）",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        try {
          const projectId = requireProject();
          const proposals = service.generateActionProposals(projectId);
          if (proposals.length === 0) {
            return textResult("当前无建议动作（项目状态健康或需人工确认项已全部处理）。");
          }
          const lines = ["## 项目建议动作（源派生，非猜测）"];
          for (const p of proposals) {
            const statusTag = p.status === "applied" ? "（已执行）" : p.status === "stale" ? "（已失效-stale）" : p.status === "obsolete" ? "（已失效-obsolete）" : "";
            const execHint = p.actionType.startsWith("locate") ? "定位用：打开对应任务/计划" : "仅建议：需人工确认";
            lines.push(
              `- [${p.actionType}]${statusTag} ${p.title}${p.targetRef ? ` · target=${p.targetRef}` : ""} · id=${p.id} · ${execHint}`,
            );
            lines.push(`  依据：${p.rationale}`);
          }
          return textResult(lines.join("\n"), { projectId, proposals });
        } catch (error) {
          return errorResult(error);
        }
      },
    });
  };
}
