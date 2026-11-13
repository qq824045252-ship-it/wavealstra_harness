import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import { readFileSync } from "node:fs";
import type { WorkProjectionDto } from "../src/shared/bot-work";
const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
const document = window.document;
Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const team = { templateId: 'deleted-team', name: '旧正式团队', ownerBotId: 'owner', members: [], deletedAt: 1 };
const work = { workId: 'old-work', title: '保留成果', ownerBotId: 'owner', team: { teamId: team.templateId, teamName: team.name } } as WorkProjectionDto;
const page = (works: WorkProjectionDto[]) => ({ works, total: works.length, filtered: works.length, page: 1, pages: 1, pageSize: 24, filterCounts: {}, viewCounts: {}, watermark: { epoch: 'test', sequence: 1 } });
Object.assign(window, { api: { botWork: {
  teamControl: async () => ({ ok: true, templates: [team] }),
  queryWorks: async (request: {scope: { kind: string }}) => page(request.scope.kind === 'team' ? [work] : []),
} } });
async function main() {
  const { createRoot } = await import('react-dom/client');
  const { BotTeamManagement } = await import('../src/renderer/src/components/pages/BotTeamManagement');
  const { buildActivityRows } = await import('../src/renderer/src/lib/botActivityMonitor');
  const legacy = { ...work, team: { ...work.team!, teamId: undefined }, executions: [], blockers: [], deliverables: [], criteria: [], nextSteps: [], listSummary: { status: { label: '已结束', group: 'closed' }, excerpt: '', deliverableCount: 0, canArchive: true, executionTaskIds: [], running: false } } as unknown as WorkProjectionDto;
  const activity = (item: WorkProjectionDto) => buildActivityRows({ works: [item], tasks: [], bots: [], histories: {}, subagents: {}, now: 1, scopeBotId: 'owner' });
  assert(activity(legacy).some(row => row.workId === legacy.workId && !row.teamWork), 'legacy owner record uses personal activity route');
  assert(!activity({ ...legacy, team: { ...legacy.team!, removedAt: 1 } }).length, 'removed records stay out of personal activity');
  assert(!activity({ ...legacy, team: { ...legacy.team!, teamId: 'formal' } }).length, 'formal team never enters personal activity');
  const root = createRoot(document.getElementById('root')!);
  let opened: WorkProjectionDto | undefined;
  await act(async () => root.render(<dialog open><BotTeamManagement onChanged={() => {}} onOpenWork={item => {
    document.querySelector('dialog')!.removeAttribute('open'); opened = item;
  }} /></dialog>));
  const details = document.querySelector('details')!;
  await act(async () => { details.setAttribute('open', ''); details.dispatchEvent(new window.Event('toggle')); });
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find(item => item.textContent === text)!;
  await act(async () => button('查看事项').click());
  assert(document.querySelector('dialog')?.hasAttribute('open'));
  await act(async () => button('保留成果').click());
  assert.equal(opened?.workId, work.workId, 'real item click calls the parent navigation callback');
  assert.equal(document.querySelector('dialog')?.hasAttribute('open'), false, 'settings dialog closes before detail navigation');
  const pageSource = readFileSync('src/renderer/src/components/pages/BotWorkspacePage.tsx', 'utf8');
  assert.equal(pageSource.match(/onOpenWork=\{work => \{ closeSettings\(\); useAppStore.getState\(\).setHistoricalTeamWork\(work\); \}\}/g)?.length, 2, 'both personal and team settings wire close before navigation');
  const navSource = readFileSync('src/renderer/src/components/BotTeamsNavigation.tsx', 'utf8');
  assert(!navSource.includes('Work 历史'));
  await act(async () => root.unmount());
  console.log('PASS team recycle actual DOM clicks: list deleted team, open record, close parent dialog before navigation; both settings paths wired');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
