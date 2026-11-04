import type { Artifact, ChatMessage, FileChange } from "@/types";

/** 非代码/非文本文件后缀黑名单（绝不能作为代码变更展示） */
const NON_CODE_EXTENSIONS = new Set([
  // 图片
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "tiff", "tif",
  // 媒体
  "mp3", "wav", "ogg", "flac", "aac", "mp4", "webm", "avi", "mov", "mkv",
  // 压缩包 / 二进制
  "zip", "tar", "gz", "7z", "rar", "bz2", "xz", "exe", "dll", "so", "dylib", "bin",
  // 文档（二进制格式）
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // 数据库 / 缓存
  "db", "sqlite", "sqlite3", "pyc", "class", "lock",
]);

/** 常见已知代码/文本文件扩展名 */
const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts",
  "html", "htm", "css", "scss", "sass", "less",
  "json", "json5", "jsonc", "yaml", "yml", "toml", "xml",
  "py", "pyw", "java", "c", "cpp", "cc", "cxx", "h", "hpp", "hh", "hxx",
  "cs", "go", "rs", "rb", "php", "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "sql", "r", "swift", "kt", "kts", "dart", "lua", "vim", "dockerfile",
  "md", "markdown", "txt", "env", "gitignore", "properties", "ini", "conf",
]);

/** 常见已知无扩展名代码/配置文件名 */
const CODE_FILENAMES = new Set([
  "dockerfile", "makefile", "cmakelists.txt", "gemfile", "procfile",
  "jenkinsfile", "license", "readme", ".gitignore", ".env", ".eslintrc",
]);

export function isCodeOrTextFile(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.trim().toLowerCase();
  const base = lower.replaceAll("\\", "/").split("/").pop() || lower;
  if (CODE_FILENAMES.has(base)) return true;

  const parts = base.split(".");
  if (parts.length < 2) return false;
  const ext = parts.pop()!;
  if (NON_CODE_EXTENSIONS.has(ext)) return false;
  if (CODE_EXTENSIONS.has(ext)) return true;
  // 兜底：如果是 1~8 字符的字母数字后缀，且非黑名单，判定为文本/代码
  return /^[a-z0-9]{1,8}$/.test(ext);
}

/** 允许作为写代码/文件的工具名 */
const FILE_WRITE_TOOLS = new Set([
  "write",
  "write_file",
  "create_file",
  "put_file",
  "save_file",
  "edit",
  "edit_file",
  "modify_file",
  "apply_diff",
  "patch",
  "str_replace_editor",
]);

export function isFileWriteTool(toolName?: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase().trim();
  // 显式排除常见非文件写工具（如 gadget 操作、内存操作、执行环境、只读工具等）
  if (
    lower.startsWith("gadget_") ||
    lower.startsWith("memory_") ||
    lower.startsWith("cron_") ||
    lower.startsWith("project_") ||
    lower.startsWith("workspace_") ||
    lower.startsWith("search_") ||
    lower === "codemode" ||
    lower === "bash" ||
    lower === "terminal" ||
    lower === "exec" ||
    lower === "run_command" ||
    lower === "read" ||
    lower === "read_file" ||
    lower === "cat" ||
    lower === "view" ||
    lower === "fetch" ||
    lower === "web_search" ||
    lower === "consult" ||
    lower === "multi_model_consult" ||
    lower === "subagent"
  ) {
    return false;
  }
  return FILE_WRITE_TOOLS.has(lower) || lower.endsWith("_write") || lower.endsWith("_edit");
}

interface ExtractedToolChange {
  name: string;
  path?: string;
  additions: number;
  deletions: number;
}

export function extractChangeFromToolCall(
  tool: string,
  summary?: string,
  detail?: string,
  targetPath?: string,
): ExtractedToolChange | null {
  // 1. 严格检查工具类型：不是写文件工具直接返回 null
  if (!isFileWriteTool(tool)) {
    return null;
  }

  let filePath: string | null = null;
  let additions = 1;
  let deletions = 0;

  // 2. 优先从 targetPath 获取
  if (targetPath && typeof targetPath === "string" && targetPath.trim()) {
    filePath = targetPath.trim();
  }

  // 3. 尝试解析 detail JSON 参数
  let args: Record<string, unknown> | null = null;
  if (detail && typeof detail === "string") {
    try {
      const parsed = JSON.parse(detail);
      if (parsed && typeof parsed === "object") {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // 容错：detail 不是标准 JSON
    }
  }

  if (args) {
    // 从参数提取路径字段
    if (!filePath) {
      const candidate = args.path || args.filePath || args.targetPath || args.file || args.filename;
      if (typeof candidate === "string" && candidate.trim()) {
        filePath = candidate.trim();
      }
    }

    // 计算增删行数
    if (typeof args.content === "string") {
      additions = args.content.split("\n").length;
      deletions = 0;
    } else if (Array.isArray(args.edits)) {
      // 支持 edits 数组格式: [{ oldText, newText }]
      let totalAdd = 0;
      let totalDel = 0;
      for (const edit of args.edits as Array<{ oldText?: string; newText?: string }>) {
        if (typeof edit.newText === "string") totalAdd += edit.newText.split("\n").length;
        if (typeof edit.oldText === "string") totalDel += edit.oldText.split("\n").length;
      }
      additions = totalAdd || 1;
      deletions = totalDel;
    } else if (typeof args.replacement === "string" || typeof args.target === "string") {
      additions = typeof args.replacement === "string" ? args.replacement.split("\n").length : 0;
      deletions = typeof args.target === "string" ? args.target.split("\n").length : 0;
    } else if (typeof args.diff === "string" || typeof args.patch === "string") {
      const diffText = (args.diff || args.patch) as string;
      const lines = diffText.split("\n");
      let add = 0;
      let del = 0;
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) add++;
        else if (line.startsWith("-") && !line.startsWith("---")) del++;
      }
      additions = add || 1;
      deletions = del;
    }
  }

  // 4. 若仍未提取出路径，但 summary 是短路径字符串（不包含空格换行且带后缀）
  if (!filePath && summary && typeof summary === "string") {
    const s = summary.trim().replace(/^(?:write|edit|create|modify|patch)\s+/i, "");
    if (s && !/\s/.test(s) && s.length < 260 && s.includes(".")) {
      filePath = s;
    }
  }

  if (!filePath) return null;

  // 标准化路径斜杠
  const normPath = filePath.replaceAll("\\", "/");
  const name = normPath.split("/").pop();
  if (!name || !isCodeOrTextFile(name)) {
    return null;
  }

  return {
    name,
    path: normPath,
    additions: Math.max(0, additions),
    deletions: Math.max(0, deletions),
  };
}

export function resolveTaskFileChanges(
  rawChanges: FileChange[] | undefined,
  artifacts: Artifact[],
  messages?: ChatMessage[],
): FileChange[] {
  const result: Map<string, FileChange> = new Map();

  const addChange = (c: {
    id: string;
    name: string;
    path?: string;
    additions: number;
    deletions: number;
  }): void => {
    if (!isCodeOrTextFile(c.name)) return;
    const key = (c.path || c.name).toLowerCase();
    const existing = result.get(key);
    if (existing) {
      existing.additions += c.additions;
      existing.deletions += c.deletions;
      if (!existing.path && c.path) {
        existing.path = c.path;
      }
    } else {
      result.set(key, {
        id: c.id,
        name: c.name,
        path: c.path,
        additions: c.additions,
        deletions: c.deletions,
      });
    }
  };

  // 1. 优先从 messages 的工具调用中收集真实的写/改操作（write, edit, patch 等）
  // 工具调用记录了 Agent 本次实际执行的代码修改差异（权威、细粒度统计）
  for (const msg of messages ?? []) {
    for (const block of msg.blocks ?? []) {
      if (block.type === "tool") {
        const tc = block.toolCall;
        const change = extractChangeFromToolCall(tc.tool, tc.summary, tc.detail, tc.targetPath);
        if (change) {
          addChange({
            id: `fc-msg-${tc.id}`,
            name: change.name,
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
          });
        }
      }
    }
  }

  // 2. 将主进程实时记录的 rawChanges 补充进去（如果尚未由工具调用记录）
  for (const c of rawChanges ?? []) {
    if (isCodeOrTextFile(c.name)) {
      const key = (c.path || c.name).toLowerCase();
      const nameKey = c.name.toLowerCase();
      if (!result.has(key) && !result.has(nameKey)) {
        result.set(key, {
          id: c.id,
          name: c.name,
          path: c.path,
          additions: c.additions,
          deletions: c.deletions,
        });
      }
    }
  }

  // 3. 将当前任务的代码/文本类产物作为可靠兜底补齐（例如由 bash / python 脚本生成、未走 write 工具的文件）
  // 注意：如果文件已经在步骤 1（工具调用）或步骤 2 中记录，绝不能把产物全文行数重复累加！
  for (const a of artifacts) {
    if (
      a.kind === "image" ||
      a.kind === "audio" ||
      a.kind === "video" ||
      a.kind === "pdf"
    ) {
      continue;
    }
    if (!isCodeOrTextFile(a.name)) continue;

    const key = (a.path || a.name).toLowerCase();
    const nameKey = a.name.toLowerCase();

    // 检查是否已被真实工具调用或变更记录覆盖
    if (result.has(key) || result.has(nameKey)) {
      const existing = result.get(key) || result.get(nameKey);
      if (existing && !existing.path && a.path) {
        existing.path = a.path;
      }
      continue;
    }

    // 仅在无工具调用的情况下兜底：优先使用实际内容行数，其次使用 capabilities.lineCount，兜底 1
    let lines = 0;
    if (a.content) {
      lines = a.content.split("\n").length;
    } else if (typeof a.capabilities?.lineCount === "number") {
      lines = a.capabilities.lineCount;
    }

    result.set(key, {
      id: `fc-art-${a.id}`,
      name: a.name,
      path: a.path,
      additions: lines > 0 ? lines : 1,
      deletions: 0,
    });
  }

  return Array.from(result.values());
}
