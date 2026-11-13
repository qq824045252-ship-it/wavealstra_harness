import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir, mkdtemp, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SavedArtifactRequest } from '../../shared/saved-artifact';

const within = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };
export interface SavedArtifactActionsPorts {
  storageRoot: string;
  exportRoot: string;
  chooseDestination(name: string): Promise<string | undefined>;
  openPath(path: string): Promise<string>;
}
/** Exports only exact host snapshots. Never reads mutable originals. External apps
 * receive an independent copy, so editing cannot corrupt saved evidence. */
export class SavedArtifactActions {
  private readonly ports: SavedArtifactActionsPorts;
  constructor(ports: SavedArtifactActionsPorts) { this.ports = ports; }
  private async identity(request: SavedArtifactRequest): Promise<{ name: string; path: string }> {
    if (!request || typeof request.snapshotPath !== 'string' || typeof request.name !== 'string') throw new Error('保存版本参数无效');
    const path = resolve(request.snapshotPath), root = await realpath(this.ports.storageRoot);
    const store = dirname(path), record = dirname(store);
    if (!within(root, path) || basename(store) !== 'artifacts' || !/^[a-f0-9]{64}$/.test(basename(record))
      || dirname(record) !== join(root, 'durable') || !/^[a-f0-9]{64}\.[a-z0-9]{1,16}$/.test(basename(path))
      || await realpath(path) !== path) throw new Error('不是本应用已登记的保存版本');
    const extension = extname(path);
    const label = basename(request.name.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120);
    const stem = label.slice(0, label.length - extname(label).length) || 'artifact';
    const name = (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? '_' : '') + stem + extension;
    return { name, path };
  }
  /** Bounded memory; a failed verification only leaves an unpublished temporary copy. */
  private async verify(path: string, destination?: string): Promise<void> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('保存版本不是普通文件');
    const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const first = await input.stat();
      if (!first.isFile() || first.ino !== before.ino || first.dev !== before.dev) throw new Error('保存版本发生变化');
      if (destination) output = await open(destination, 'wx', 0o600);
      const buffer = Buffer.allocUnsafe(64 * 1024), hash = createHash('sha256');
      let length = 0;
      while (length < first.size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, first.size - length), null);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
        if (output) await output.writeFile(chunk);
        length += bytesRead;
      }
      const after = await input.stat(), current = await lstat(path);
      if (length !== first.size || after.size !== first.size || after.mtimeMs !== first.mtimeMs || after.ctimeMs !== first.ctimeMs
        || current.ino !== first.ino || current.dev !== first.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs
        || await realpath(path) !== path || hash.digest('hex') !== basename(path).split('.')[0]) throw new Error('保存版本完整性校验失败');
      await output?.sync();
    } finally { await input.close(); await output?.close(); }
  }
  async openSystem(request: SavedArtifactRequest): Promise<void> {
    const saved = await this.identity(request);
    await mkdir(this.ports.exportRoot, { recursive: true });
    const folder = await mkdtemp(join(this.ports.exportRoot, 'saved-'));
    const target = join(folder, saved.name);
    try { await this.verify(saved.path, target); }
    catch (error) { await unlink(target).catch(() => {}); throw error; }
    const error = await this.ports.openPath(target);
    if (error) throw new Error(error);
  }
  async saveAs(request: SavedArtifactRequest): Promise<{ canceled: boolean; path?: string }> {
    const initial = await this.identity(request); await this.verify(initial.path);
    const destination = await this.ports.chooseDestination(initial.name);
    if (!destination) return { canceled: true };
    const requested = resolve(destination), parent = await realpath(dirname(requested));
    const target = join(parent, basename(requested)), parentInfo = await lstat(parent);
    const storage = await realpath(this.ports.storageRoot);
    if (within(storage, target)) throw new Error('不能覆盖应用数据或保存版本，请选择其他位置');
    const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('目标不是独立普通文件');
    const current = await this.identity(request);
    const pending = join(parent, `.mybuddy-save-${randomUUID()}`);
    try {
      await this.verify(current.path, pending);
      const finalParent = await lstat(parent);
      if (await realpath(dirname(requested)) !== parent || await realpath(parent) !== parent
        || finalParent.ino !== parentInfo.ino || finalParent.dev !== parentInfo.dev) throw new Error('保存目录发生变化，请重新选择');
      const finalTarget = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (existing ? !finalTarget || finalTarget.isSymbolicLink() || finalTarget.ino !== existing.ino || finalTarget.dev !== existing.dev
        || finalTarget.size !== existing.size || finalTarget.mtimeMs !== existing.mtimeMs || finalTarget.nlink !== 1 : Boolean(finalTarget)) throw new Error('目标文件发生变化，请重新保存');
      // Publish only fully verified bytes. Node has no portable renameat directory
      // handle API: revalidate immediately, but do not claim a hostile-process sandbox.
      await rename(pending, target);
    } finally { await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { canceled: false, path: target };
  }
}
