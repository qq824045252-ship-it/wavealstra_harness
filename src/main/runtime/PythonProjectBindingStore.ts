import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PythonProjectBinding, PythonProjectBindingView } from "../../shared/python-runtime";
import type { RuntimeAuditReader, RuntimePythonProjectBinding } from "../platform/runtime-audit";
import { currentNodePlatform } from "../platform/runtime";
import { pythonProjectBindingId, pythonProjectDirKey } from "./python-environment-spec";

export class PythonProjectBindingStore {
  constructor(
    private readonly reader: Pick<RuntimeAuditReader, "pythonProjectBindings" | "batch1Write">,
    private readonly platform: NodeJS.Platform = currentNodePlatform,
  ) {}

  async save(binding: PythonProjectBinding): Promise<void> {
    const reply = await this.reader.batch1Write<{ saved?: boolean }>({ kind: "savePythonBinding", ...binding });
    if (reply?.saved !== true) throw new Error("Python 项目绑定写入未获 Rust 核心确认");
  }

  async remove(projectDir: string): Promise<boolean> {
    const dirKey = pythonProjectDirKey(projectDir, this.platform);
    const reply = await this.reader.batch1Write<{ deleted?: boolean }>({ kind: "removePythonBinding", dirKey });
    if (typeof reply?.deleted !== "boolean") throw new Error("Python 项目解绑未获 Rust 核心确认");
    return reply.deleted;
  }

  async list(): Promise<PythonProjectBindingView[]> {
    return (await this.read()).map(toView);
  }

  async resolveForDir(taskRoot: string): Promise<PythonProjectBindingView | null> {
    const ancestors: string[] = [];
    let current = resolve(taskRoot);
    for (;;) {
      ancestors.push(pythonProjectDirKey(current, this.platform));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const [binding] = await this.read(ancestors);
    return binding ? toView(binding) : null;
  }

  private async read(ancestors?: string[]): Promise<RuntimePythonProjectBinding[]> {
    const rows = await this.reader.pythonProjectBindings(ancestors);
    if (!rows) throw new Error("Python 项目绑定读取未获 Rust 核心确认");
    return rows;
  }
}

function toView(row: RuntimePythonProjectBinding): PythonProjectBindingView {
  return {
    projectDir: row.project_dir,
    dirKey: row.dir_key,
    pythonPath: row.python_path,
    pythonVersion: row.python_version,
    manifestPath: row.manifest_path,
    boundAt: row.bound_at,
    bindingId: pythonProjectBindingId(row.dir_key),
    available: existsSync(row.python_path),
  };
}
