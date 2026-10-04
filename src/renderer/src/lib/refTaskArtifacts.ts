/**
 * 跨任务 Artifact 引用 — Wave 3E（InputAddMenu「引用任务」产物来源）
 *
 * 唯一来源 = Artifact Domain：
 * - snapshot（首次访问触发一次性 legacy migration）→ ArtifactDescriptor[]
 * - workspace-file → 只给 path（Agent 读盘），不取内容
 * - managed-content（无磁盘 path）→ 引用时 readContent lazy load
 * 不把 content 塞回 descriptor / 列表（§4：descriptor 无长期 content；不新增第二套真相源）。
 *
 * 纯函数 + 可注入 client：node 回归测试直接注入 Domain service 适配器（见
 * scripts/artifact-cross-ref-test.ts），无需 Electron IPC。
 */
import type {
  ArtifactDomainListResponse,
  ArtifactDomainReadContentResponse,
} from "../../../shared/artifact-ipc";
import type { ArtifactDescriptor, ArtifactSnapshot } from "../../../shared/artifact-types";

/** 可引用到输入框的对话文件 */
export interface RefFileItem {
  id: string;
  name: string;
  path?: string;
  /** 无 path 时把内容塞进 prompt */
  content?: string;
  source: "artifact" | "attachment" | "change";
}

/** InputAddMenu 可用的 Artifact Domain client（preload 子集，便于 node 测试注入） */
export interface ArtifactDomainReader {
  snapshot?: (req: { taskId: string }) => Promise<ArtifactSnapshot | null>;
  list?: (req: { taskId: string }) => Promise<ArtifactDomainListResponse | null>;
  readContent?: (req: { artifactId: string }) => Promise<ArtifactDomainReadContentResponse | null>;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/**
 * descriptor → RefFileItem。
 * workspace-file → 只带 entryFile path（Agent 读盘优先，与旧语义一致）；
 * managed-content → 无 path，引用时 readContent lazy load 内容（供 prompt 内联）。
 */
export async function descriptorToRefFile(
  domain: ArtifactDomainReader,
  d: ArtifactDescriptor,
): Promise<RefFileItem> {
  const path = d.source.type === "workspace-file" ? d.source.entryFile : undefined;
  const item: RefFileItem = {
    id: d.id,
    name: d.title?.trim() || (path ? basename(path) : d.id),
    path,
    source: "artifact",
  };
  if (!path && domain.readContent) {
    try {
      const content = await domain.readContent({ artifactId: d.id });
      if (content?.content) item.content = content.content;
    } catch (err) {
      console.warn("[refTaskArtifacts] readContent failed", d.id, err);
    }
  }
  return item;
}

/**
 * 跨任务产物列表：snapshot 优先（触发一次性 legacy migration，老数据可被引用），
 * list 兜底（API 不可用时退化）。
 */
export async function collectTaskDomainArtifacts(
  domain: ArtifactDomainReader | undefined | null,
  taskId: string,
): Promise<RefFileItem[]> {
  if (!domain) return [];
  let descriptors: ArtifactDescriptor[] = [];
  try {
    if (domain.snapshot) {
      const snap = await domain.snapshot({ taskId });
      descriptors = snap?.artifacts ?? [];
    }
    if (descriptors.length === 0 && domain.list) {
      const list = await domain.list({ taskId });
      descriptors = list?.artifacts ?? [];
    }
  } catch (err) {
    console.warn("[refTaskArtifacts] artifact snapshot failed", taskId, err);
    return [];
  }
  const items: RefFileItem[] = [];
  for (const d of descriptors) {
    items.push(await descriptorToRefFile(domain, d));
  }
  return items;
}
