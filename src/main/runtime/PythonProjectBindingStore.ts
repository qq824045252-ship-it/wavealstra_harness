/**
 * 项目 Python 手动覆盖的持久化与解析。
 *
 * 职责边界：这里只管「存了什么、某个目录该用哪一行」。
 * 绑定是否合法（目录存在吗、解释器能跑吗）由门面 PythonRuntimeService 校验后才落库——
 * 存下一个跑不起来的解释器，等于把失败推迟到用户看不见的执行期。
 *
 * 冻结约束：
 * - 本 store 只保存用户手动 override；零配置自动发现由 PythonProjectDiscovery 负责。
 * - override 命中后子目录继承最近的祖先记录（仓库根指定一次，子包不必重复询问）。
 * - 解释器被删除时不删行：标记 available=false，由门面明确报错，避免静默切换解释器；
 *   用户重建 venv 后同一绑定自动恢复。
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  PythonProjectBinding,
  PythonProjectBindingView,
} from "../../shared/python-runtime";
import { pythonProjectBindingId, pythonProjectDirKey } from "./python-environment-spec";

/**
 * 本 store 只需要「能 prepare 一条语句」，不需要整个 AppDatabase。
 *
 * 收窄依赖是有意的：AppDatabase 会连带拖进 better-sqlite3 与 electron，
 * 而 Python 运行时门禁测试必须在没有 Python、没有 uv 的干净环境里跑起来。
 * 传入 `db.connection` 即可满足这个结构化类型。
 */
export interface PythonBindingConnection {
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

interface BindingRow {
  dir_key: string;
  project_dir: string;
  python_path: string;
  python_version: string | null;
  manifest_path: string | null;
  bound_at: number;
}

export class PythonProjectBindingStore {
  constructor(
    private readonly connection: PythonBindingConnection,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** 幂等 upsert：同一目录改绑到另一个解释器时覆盖，不留下两行互相打架。 */
  save(binding: PythonProjectBinding): void {
    this.connection
      .prepare(
        `INSERT INTO python_project_bindings
           (dir_key, project_dir, python_path, python_version, manifest_path, bound_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(dir_key) DO UPDATE SET
           project_dir = excluded.project_dir,
           python_path = excluded.python_path,
           python_version = excluded.python_version,
           manifest_path = excluded.manifest_path,
           bound_at = excluded.bound_at`,
      )
      .run(
        binding.dirKey,
        binding.projectDir,
        binding.pythonPath,
        binding.pythonVersion,
        binding.manifestPath,
        binding.boundAt,
      );
  }

  /** 解绑一个目录（含其精确键）。幂等：未绑定时返回 false。 */
  remove(projectDir: string): boolean {
    const key = pythonProjectDirKey(projectDir, this.platform);
    const result = this.connection
      .prepare(`DELETE FROM python_project_bindings WHERE dir_key = ?`)
      .run(key);
    return result.changes > 0;
  }

  /** UI 用：全部绑定，最近绑定的在前。 */
  list(): PythonProjectBindingView[] {
    const rows = this.connection
      .prepare(`SELECT * FROM python_project_bindings ORDER BY bound_at DESC, dir_key`)
      .all() as BindingRow[];
    return rows.map((row) => this.toView(row));
  }

  /**
   * 执行期解析：任务目录 → 生效的绑定。
   *
   * 逐级向上找最近的祖先绑定；到根目录仍未命中就返回 null，
   * 由门面继续做项目虚拟环境自动发现；这里不负责嗅探。
   */
  resolveForDir(taskRoot: string): PythonProjectBindingView | null {
    let current = resolve(taskRoot);
    // Windows 根目录 dirname 自反（C:\ → C:\），用「不再变化」作为终止条件
    for (;;) {
      const row = this.connection
        .prepare(`SELECT * FROM python_project_bindings WHERE dir_key = ?`)
        .get(pythonProjectDirKey(current, this.platform)) as BindingRow | undefined;
      if (row) return this.toView(row);
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  private toView(row: BindingRow): PythonProjectBindingView {
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
}
