import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import SettingsModal from '../src/renderer/src/components/settings/SettingsModal';
import { useAppStore } from '../src/renderer/src/store/appStore';
import '../src/renderer/src/styles/global.css';

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
let restored: unknown;
const root = createRoot(document.body.appendChild(document.createElement('div')));
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  check(button && !button.disabled, `Missing enabled button: ${label}`);
  flushSync(() => button!.click());
  await settle();
}
async function change(label: string, value: string) {
  const input = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
  const proto = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }));
  });
  await settle();
}
export async function preview(tab: 'archive' | 'security', dark = false) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const spaces = Array.from({ length: 17 }, (_, i) => ({ id: `s${i}`, name: `研发归档空间 ${i}`, path: 'C:/projects/' + 'long-path/'.repeat(15), archived: true }));
  const tasks = Array.from({ length: 17 }, (_, i) => ({ id: `t${i}`, title: `归档任务 ${i} ` + '长标题'.repeat(15), spaceId: `s${i % 2}`, archived: true, updatedAt: 1790040000000 + i }));
  const backups = Array.from({ length: 217 }, (_, i) => ({ taskId: `t${i % 17}`, backupId: `b${i}`, relPath: `src/${i}/` + 'long-path/'.repeat(8) + 'file.ts', createdAt: 1790040000000 + i, size: 1024, kind: i % 2 ? 'modified' : 'deleted' }));
  (window as any).api = { agent: { getAppSettings: async () => ({}), listBackups: async () => backups, restoreBackup: async (request: unknown) => { restored = request; } } };
  flushSync(() => root.render(null));
  useAppStore.setState({ spaces: spaces as any, tasks: tasks as any, settingsTab: tab });
  flushSync(() => root.render(<SettingsModal />));
  await settle();
  if (tab === 'security') {
    check(!document.body.textContent?.includes('文件修改/删除前自动备份'), 'Removed automatic backup setting stays absent');
    await click('历史备份 217');
    check(document.querySelector('.record-intro')?.textContent?.includes('当前版本不再自动创建备份'), 'History explains manual restore only');
  }
}
export function layout() {
  const body = document.querySelector('.settings-content-body') as HTMLElement;
  const pager = document.querySelector('.record-pager') as HTMLElement;
  const list = document.querySelector('.record-list') as HTMLElement;
  const b = body.getBoundingClientRect(), p = pager.getBoundingClientRect();
  check(body.scrollHeight <= body.clientHeight + 1, 'Outer page must not scroll');
  check(body.scrollWidth <= body.clientWidth + 1, 'No horizontal overflow');
  check(p.bottom <= b.bottom && p.top >= b.top, 'Pager stays visible');
  check(list.clientHeight > 60, 'List retains usable height');
  return { width: innerWidth, height: innerHeight, listHeight: list.clientHeight, pagerBottom: p.bottom };
}
export async function showSettings() { await click('安全设置'); }
export async function run() {
  await preview('archive');
  check(document.querySelectorAll('.archive-card').length === 8, 'Archive page size');
  await click('下一页'); await click('下一页');
  check(document.querySelectorAll('.archive-card').length === 1, 'Archive final page');
  flushSync(() => useAppStore.setState((s) => ({ spaces: s.spaces.slice(0, 16) })));
  await settle();
  check(document.querySelector('.record-pager')?.textContent?.includes('2 / 2'), 'Clamp page after record removal');
  await change('搜索归档', '研发归档空间 0');
  check(document.querySelectorAll('.archive-card').length === 1, 'Search entire archive and reset page');
  await change('搜索归档', 'no-such-record');
  check(document.querySelector('.record-empty'), 'Search empty state');
  await change('搜索归档', '');
  await click('任务 17');
  check(document.querySelectorAll('.archive-card').length === 8, 'Task pagination');
  await preview('security');
  check(document.querySelectorAll('.backup-card').length === 8, 'Backup page size');
  for (let i = 1; i < 28; i++) await click('下一页');
  check(document.querySelector('.backup-path')?.textContent?.startsWith('src/0/'), 'Backups beyond former 200-record limit are reachable');
  await change('搜索备份', 'src/216/');
  check(document.querySelectorAll('.backup-card').length === 1, 'Backup search resets page');
  await click('还原');
  check((restored as any)?.backupId === 'b216', 'Restore retains exact backup identity');
  await change('搜索备份', '');
  await click('工作空间'); await change('筛选空间', 's1');
  check(document.querySelector('.record-pager')?.textContent?.includes('共 102 条'), 'Space filtering');
  await click('任务'); await change('筛选任务', 't0');
  check(document.querySelector('.record-pager')?.textContent?.includes('共 13 条'), 'Task filtering');
  return ['archive/task pagination and removal clamping', 'search and empty states', '217 backups reachable', 'space/task filters and exact restore target'];
}
