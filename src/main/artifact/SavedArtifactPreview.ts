import type { WebContents } from "electron";
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep, posix } from 'node:path';
import { parse } from 'parse5';
import { mimeFor } from './WebArtifactRuntime';
import type { SavedArtifactPreview, SavedArtifactRequest } from '../../shared/saved-artifact';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_BUNDLE = 32 * 1024 * 1024;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
interface Resource { snapshot: string; digest: string; bytes: number }
interface Manifest { version: 1; entry: string; resources: Record<string, Resource>; warnings: string[] }
type Inspect = (cwd: string, path: string, directory?: string) => Promise<{ snapshotPath?: string; digest: string; sizeBytes: number }>;
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** Only actual document resource attributes/imports; never crawl the directory. */
export function savedResourceReferences(content: string, extension: string): string[] {
  const refs: string[] = [];
  const css = (text: string) => {
    for (const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+['"]([^'"]+)['"]/gi)) refs.push(match[2] ?? match[3]);
  };
  const js = (text: string) => {
    for (const match of text.matchAll(/(?:\bimport\s*(?:[^'";]*?\sfrom\s*)?|\bexport\s+[^'";]*?\sfrom\s*|\bimport\s*\(|\bfetch\s*\()\s*['"]([^'"]+)['"]/g)) refs.push(match[1]);
  };
  if (/^\.html?$/.test(extension)) {
    const walk = (node: any): void => {
      const attrs = Object.fromEntries((node.attrs ?? []).map((a: any) => [a.name, a.value]));
      if (node.tagName === 'base') throw new Error('HTML base URL requires explicit resource packaging');
      if (attrs.src) refs.push(attrs.src);
      if (attrs.poster) refs.push(attrs.poster);
      if (attrs.href && ['link', 'a'].includes(node.tagName)) refs.push(attrs.href);
      if (attrs.srcset) for (const item of attrs.srcset.split(',')) refs.push(item.trim().split(/\s+/)[0]);
      if (attrs.style) css(attrs.style);
      if (node.tagName === 'style') css((node.childNodes ?? []).map((n: any) => n.value ?? '').join(''));
      if (node.tagName === 'script') js((node.childNodes ?? []).map((n: any) => n.value ?? '').join(''));
      for (const child of node.childNodes ?? []) walk(child);
      if (node.content) walk(node.content);
    };
    walk(parse(content));
  } else if (extension === '.css') css(content);
  else if (/^\.(?:m?js)$/.test(extension)) js(content);
  return [...new Set(refs.filter(Boolean))];
}

/** Captured at registration time, never at view time. Each manifest hashes its complete resource map. */
export async function captureSavedWebBundle(cwd: string, sourcePath: string, snapshotPath: string, directory: string, inspect: Inspect): Promise<string> {
  const root = await realpath(cwd);
  const entry = relative(root, sourcePath).split(sep).join('/');
  const queue = [{ name: entry, snapshotPath }];
  const resources: Manifest['resources'] = Object.create(null);
  const warnings: string[] = [];
  const visited = new Set<string>();
  let total = 0;
  while (queue.length) {
    const item = queue.shift()!;
    if (visited.has(item.name)) continue;
    visited.add(item.name);
    if (visited.size > MAX_FILES) { warnings.push('资源超过 128 个，仅保存已明确捕获的资源'); break; }
    try {
      const source = resolve(root, item.name);
      // The entry is already immutable: its mutable source may have been moved or deleted.
      // Dependencies still require real-path confinement before capture.
      if (!inside(root, source) || (!item.snapshotPath && !inside(root, await realpath(source)))) throw new Error('资源位于工作区之外');
      if (item.snapshotPath && (await realpath(item.snapshotPath) !== resolve(item.snapshotPath) || dirname(resolve(item.snapshotPath)) !== resolve(directory, 'artifacts'))) throw new Error('保存版本路径无效');
      const receipt = item.snapshotPath ? { snapshotPath: item.snapshotPath, digest: basename(item.snapshotPath).split('.')[0], sizeBytes: (await stat(item.snapshotPath)).size } : await inspect(root, source, directory);
      if (!receipt.snapshotPath) throw new Error('资源没有保存版本');
      total += receipt.sizeBytes;
      if (receipt.sizeBytes > MAX_FILE || total > MAX_BUNDLE) throw new Error('资源大小超出预览限制（单文件 8 MiB / 总计 32 MiB）');
      resources[item.name] = { snapshot: basename(receipt.snapshotPath), digest: receipt.digest, bytes: receipt.sizeBytes };
      const extension = extname(item.name).toLowerCase();
      if (!/^\.(?:html?|css|m?js)$/.test(extension)) continue;
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(receipt.snapshotPath));
      for (const ref of savedResourceReferences(content, extension)) {
        if (/^(?:data:|blob:|#)/i.test(ref)) continue;
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(ref)) { warnings.push(`外部资源未保存：${ref.slice(0, 160)}`); continue; }
        const raw = decodeURIComponent(ref.split(/[?#]/)[0]);
        if (!raw) continue;
        if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) { warnings.push(`不支持的资源路径：${raw.slice(0, 160)}`); continue; }
        const name = posix.normalize(posix.join(posix.dirname(item.name), raw));
        if (name === '..' || name.startsWith('../')) { warnings.push(`资源路径越界：${raw.slice(0, 160)}`); continue; }
        queue.push({ name, snapshotPath: '' });
      }
    } catch (error) { warnings.push(`${item.name}：${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!Object.hasOwn(resources, entry)) throw new Error('无法捕获保存版本入口：' + warnings.join('; '));
  const manifest: Manifest = { version: 1, entry, resources, warnings: [...new Set(warnings)] };
  const json = JSON.stringify(manifest);
  const target = join(dirname(snapshotPath), `${hash(json)}.web.json`);
  await writeFile(target, json, { flag: 'wx', mode: 0o600 }).catch(async error => {
    if (error.code !== 'EEXIST' || await readFile(target, 'utf8') !== json) throw error;
  });
  return target;
}

/** Determine whether a later registered resource can fill/replace this version's dependency. */
export async function savedBundleDependsOn(manifestPath: string | undefined, cwd: string, changedPath: string): Promise<boolean> {
  if (!manifestPath) return false;
  const name = relative(cwd, changedPath).split(sep).join('/');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  return Object.hasOwn(manifest.resources, name) || manifest.warnings.some(warning => warning.startsWith(`${name}：`));
}

function bridge(token: string): string {
  return `<script>(()=>{const token=${JSON.stringify(token)};const send=(type,data)=>parent.postMessage({type,token,...data},'*');const link=url=>{try{const u=new URL(url,location.href);if(/^https?:$/.test(u.protocol)){send('mybuddy:saved-artifact-link',{url:u.href});return true}}catch{}return false};document.addEventListener('click',e=>{const a=e.target.closest?.('a[href]');if(a&&link(a.href)){e.preventDefault();e.stopImmediatePropagation()}},true);window.open=(url)=>{link(url);return null};window.addEventListener('error',e=>{if(e.target!==window)send('mybuddy:saved-artifact-error',{message:'页面资源加载失败；保存版本可能缺少依赖'})},true);})();</script>`;
}
interface Session { owner: number; store: string; manifest: Manifest; source: string }
export class SavedArtifactPreviewService {
  private readonly sessions = new Map<string, Session>();
  private readonly owners = new Map<number, WebContents>();
  /** Installed on the trusted application WebContents, not on generated content. */
  attachOwner(owner: WebContents, openLink: (url: string) => void): void {
    if (this.owners.has(owner.id)) return;
    this.owners.set(owner.id, owner);
    owner.once('destroyed', () => { this.releaseOwner(owner.id); this.owners.delete(owner.id); });
    owner.on('will-frame-navigate', event => {
      const from = event.initiator?.url || event.frame?.url || '';
      const current = event.frame?.url || '';
      const saved = /^mybuddy-artifact:\/\/saved-([a-f0-9]{48})\//.exec(from) ?? /^mybuddy-artifact:\/\/saved-([a-f0-9]{48})\//.exec(current);
      if (!saved) return;
      const state = this.sessions.get(saved[1]);
      const allowed = state?.owner === owner.id && event.url.startsWith(`mybuddy-artifact://saved-${saved[1]}/`);
      if (allowed) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(event.url)) openLink(event.url);
      else void event.frame?.executeJavaScript(`parent.postMessage({type:'mybuddy:saved-artifact-error',token:${JSON.stringify(saved[1])},message:'该导航不属于当前保存版本'},'*')`).catch(() => {});
    });
  }
  async prepare(owner: number, request: SavedArtifactRequest): Promise<SavedArtifactPreview> {
    if (!request || typeof request.snapshotPath !== 'string' || typeof request.name !== 'string') throw new Error('保存版本参数无效');
    const snapshot = resolve(request.snapshotPath);
    if (await realpath(snapshot) !== snapshot || !/^[a-f0-9]{64}\.(?:html?|bin)$/i.test(basename(snapshot)) || basename(dirname(snapshot)) !== 'artifacts') throw new Error('不是已登记的 HTML 保存版本');
    const sourceBytes = await this.verifiedRead(dirname(snapshot), { snapshot: basename(snapshot), digest: basename(snapshot).split('.')[0], bytes: (await stat(snapshot)).size });
    const source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
    let manifest: Manifest = { version: 1, entry: 'index.html', resources: { 'index.html': { snapshot: basename(snapshot), digest: hash(sourceBytes), bytes: sourceBytes.length } }, warnings: [] };
    if (request.manifestPath) {
      const path = resolve(request.manifestPath);
      if (dirname(path) !== dirname(snapshot) || await realpath(path) !== path || !/^[a-f0-9]{64}\.web\.json$/.test(basename(path))) throw new Error('保存版本资源清单路径无效');
      if ((await stat(path)).size > 256 * 1024) throw new Error('资源清单过大');
      const json = await readFile(path, 'utf8');
      if (hash(json) !== basename(path).split('.')[0]) throw new Error('保存版本资源清单校验失败');
      manifest = JSON.parse(json);
      if (manifest.version !== 1 || !manifest.resources || !Array.isArray(manifest.warnings) || typeof manifest.entry !== 'string' || manifest.resources[manifest.entry]?.snapshot !== basename(snapshot)) throw new Error('资源清单与保存版本不匹配');
    } else if (/\b(?:src|href|srcset)\s*=|\b(?:import|fetch)\s*\(|url\(/i.test(source)) {
      manifest.warnings.push('旧保存版本未包含依赖资源，页面可能不完整；不会读取当前工作目录补齐。');
    }
    if (this.sessions.size >= 64) throw new Error('打开的预览过多，请先关闭未使用的预览');
    const token = randomBytes(24).toString('hex');
    this.sessions.set(token, { owner, store: dirname(snapshot), manifest, source });
    return { token, url: `mybuddy-artifact://saved-${token}/${manifest.entry.split('/').map(encodeURIComponent).join('/')}`, source, warnings: manifest.warnings };
  }
  release(owner: number, token: string): void {
    if (this.sessions.get(token)?.owner !== owner) return;
    this.sessions.delete(token);
    const wc = this.owners.get(owner);
    if (wc && !wc.isDestroyed()) void wc.session.clearStorageData({ origin: `mybuddy-artifact://saved-${token}`, storages: ['localstorage', 'indexdb', 'cachestorage'] }).catch(() => {});
  }
  releaseOwner(owner: number): void { for (const [key, value] of this.sessions) if (value.owner === owner) this.release(owner, key); }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.hostname.replace(/^saved-/, '');
    const state = this.sessions.get(token);
    if (!state) return new Response('保存版本预览已关闭', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
    let path: string;
    try { path = decodeURIComponent(url.pathname.slice(1)); } catch { return new Response('Bad Request', { status: 400 }); }
    const resource = Object.hasOwn(state.manifest.resources, path) ? state.manifest.resources[path] : undefined;
    if (!resource) return new Response('此资源未包含在保存版本中', { status: 404 });
    try {
      const bytes = await this.verifiedRead(state.store, resource);
      const mimeType = mimeFor(path);
      let body: string | Uint8Array = bytes;
      if (/\.html?$/i.test(path)) {
        const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        body = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, match => match + bridge(token)) : bridge(token) + html;
      }
      const origin = `mybuddy-artifact://saved-${token}`;
      return new Response(request.method === 'HEAD' ? null : body as BodyInit, { headers: {
        'content-type': mimeType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src ${origin} data: blob:; script-src ${origin} 'unsafe-inline' 'unsafe-eval' blob:; style-src ${origin} 'unsafe-inline'; connect-src ${origin}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'`,
      } });
    } catch (error) { return new Response(`无法读取保存版本：${error instanceof Error ? error.message : String(error)}`, { status: 410 }); }
  }
  private async verifiedRead(store: string, resource: Resource): Promise<Buffer> {
    if (!resource || !/^[a-f0-9]{64}\.[a-z0-9]{1,16}$/.test(resource.snapshot) || !/^[a-f0-9]{64}$/.test(resource.digest)) throw new Error('资源版本记录无效');
    const path = join(store, resource.snapshot);
    if (await realpath(path) !== path) throw new Error('保存版本不能是符号链接');
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE) throw new Error('保存版本不是文件或超过 8 MiB');
    const bytes = await readFile(path);
    if (bytes.length !== resource.bytes || hash(bytes) !== resource.digest) throw new Error('保存版本完整性校验失败');
    return bytes;
  }
}
export const savedArtifactPreviewService = new SavedArtifactPreviewService();
