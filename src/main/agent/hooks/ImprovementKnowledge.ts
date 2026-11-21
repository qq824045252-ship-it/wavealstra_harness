import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ObservationSource } from "../../../shared/native-improvement";
import type { MemoryService } from "../../memory/MemoryService";

export type ImprovementKnowledgeScope = { kind: "task" | "project" | "workspace"; id: string };
export interface ImprovementKnowledgeTask {
  taskId: string;
  projectId?: string | null;
  workspaceId?: string | null;
  canUseSkill?: (name: string) => boolean;
}

interface Source {
  scope: ImprovementKnowledgeScope;
  sourceMemoryId: string;
}

type ImprovementKnowledgeDraft = Source & (
  | { kind: "skill"; name: string; description: string }
  | { kind: "memory" }
);

export type PreparedImprovementKnowledge = ImprovementKnowledgeDraft & {
  version: string;
  sourceHash: string;
  title: string;
  content: string;
};

export type ResolvedImprovementKnowledge =
  | { kind: "skill"; name: string; description: string; path: string; content: string }
  | { kind: "memory"; title: string; content: string };

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function inScope(scope: ImprovementKnowledgeScope, task: ImprovementKnowledgeTask): boolean {
  const id = { task: task.taskId, project: task.projectId, workspace: task.workspaceId }[scope.kind];
  return Boolean(scope.id && scope.id === id);
}

function skillMarkdown(name: string, description: string, procedure: string): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${procedure.trim()}\n`;
}

function fingerprint(draft: ImprovementKnowledgeDraft, sourceHash: string, title: string, content: string): string {
  return digest(JSON.stringify([
    draft.kind, draft.scope.kind, draft.scope.id, draft.sourceMemoryId, sourceHash, title, content,
    draft.kind === "skill" ? [draft.name, draft.description] : null,
  ]));
}

const deliverySkill =
  "交付前，从当前请求列出明确要求、交付物和验证结果。检查每项是否已经满足；在权限允许时继续补齐可修复的缺项。保留用户最新的范围和跳过要求，明确报告仍待处理的事项。";

/** Only the committed weekly manifest selects these assets. Stage files outside the regular skill search paths. */
export class ImprovementKnowledge {
  private readonly root: string;

  constructor(root: string, private readonly memory: Pick<MemoryService,
    "getWeeklyObservationMemory" | "stageWeeklyObservationMemory">) {
    this.root = resolve(root);
  }

  private source(draft: ImprovementKnowledgeDraft, task: ImprovementKnowledgeTask) {
    if (!inScope(draft.scope, task)) return;
    const source = this.memory.getWeeklyObservationMemory(draft.sourceMemoryId, { taskId: task.taskId });
    if (!source || !source.scopes.some(scope =>
      scope.scopeType === draft.scope.kind && scope.scopeId === draft.scope.id)) return;
    if (!source.content.trim() || source.content.length > 8_000 || source.title.length > 200) return;
    return source;
  }

  /** Prepare the fixed assets for a host-verified omission of an explicit delivery requirement. */
  async prepareDelivery(scope: ImprovementKnowledgeScope, source: ObservationSource): Promise<PreparedImprovementKnowledge[]> {
    const memory = this.memory.stageWeeklyObservationMemory(scope, source);
    const common = { scope, sourceMemoryId: memory.id };
    const task = { taskId: source.taskId,
      projectId: scope.kind === "project" ? scope.id : undefined,
      workspaceId: scope.kind === "workspace" ? scope.id : undefined };
    return Promise.all([
      this.prepare({ ...common, kind: "skill", name: "weekly-delivery-check", description: "交付前核对并补齐当前请求中的明确要求。" }, task),
      this.prepare({ ...common, kind: "memory" }, task),
    ]);
  }

  private async prepare(draft: ImprovementKnowledgeDraft, sourceTask: ImprovementKnowledgeTask): Promise<PreparedImprovementKnowledge> {
    const source = this.source(draft, sourceTask);
    if (!source) throw new Error("改进资产缺少当前作用域内可引用的明确记忆");
    if (draft.kind === "skill" && (!/^[a-z][a-z0-9-]{0,63}$/.test(draft.name)
      || !draft.description.trim() || draft.description.length > 180 || /[\r\n]/.test(draft.description))) {
      throw new Error("周改进技能名称或描述无效");
    }
    const content = draft.kind === "skill"
      ? skillMarkdown(draft.name, draft.description, deliverySkill)
      : source.content;
    const asset: PreparedImprovementKnowledge = {
      ...draft, sourceHash: source.contentHash, title: source.title, content,
      version: fingerprint(draft, source.contentHash, source.title, content),
    };
    if (draft.kind === "skill") await this.stageSkill(asset.version, content);
    if (!this.isCurrent(asset, sourceTask)) throw new Error("改进资产来源在准备期间已变更");
    return asset;
  }

  /** Can also run synchronously at the provider boundary after a request has been assembled. */
  isCurrent(asset: PreparedImprovementKnowledge, task: ImprovementKnowledgeTask): boolean {
    const source = this.source(asset, task);
    if (!source || source.contentHash !== asset.sourceHash || source.title !== asset.title) return false;
    const content = asset.kind === "skill"
      ? skillMarkdown(asset.name, asset.description, deliverySkill)
      : source.content;
    return asset.content === content && asset.version === fingerprint(asset, source.contentHash, source.title, content);
  }

  async resolve(asset: PreparedImprovementKnowledge, task: ImprovementKnowledgeTask): Promise<ResolvedImprovementKnowledge | undefined> {
    if (!this.isCurrent(asset, task)) return;
    if (asset.kind === "memory") return { kind: "memory", title: asset.title, content: asset.content };
    if (!task.canUseSkill?.(asset.name)) return;
    const path = join(this.root, asset.version, "SKILL.md");
    try {
      if (await realpath(path) !== path) return;
      const content = await readFile(path, "utf8");
      if (content !== asset.content || !this.isCurrent(asset, task) || !task.canUseSkill(asset.name)) return;
      return { kind: "skill", name: asset.name, description: asset.description, path, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async stageSkill(version: string, content: string): Promise<void> {
    const directory = join(this.root, version);
    await mkdir(directory, { recursive: true });
    if (await realpath(directory) !== directory) throw new Error("周改进技能目录已重定向");
    const path = join(directory, "SKILL.md");
    const temp = join(directory, randomUUID());
    try {
      await writeFile(temp, content, { flag: "wx", mode: 0o600, flush: true });
      try {
        await link(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await realpath(path) !== path || await readFile(path, "utf8") !== content) {
        throw new Error("已暂存的周改进技能与发布内容不匹配");
      }
    } finally {
      try {
        await unlink(temp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
