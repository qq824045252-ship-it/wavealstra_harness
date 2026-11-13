import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import { BotTeamAvatar, teamAvatarMembers } from "../src/renderer/src/components/common/BotTeamAvatar";
import { avatarCommand } from "../src/renderer/src/lib/botAvatarStore";
import { builtinBotAvatars, type BotAvatarSnapshot, type BotAvatarCommand } from "../src/shared/bot-avatar";
const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
const document = window.document;
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(document, 'visibilityState', { value: 'visible' });
Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
const snapshot: BotAvatarSnapshot = { selections: {}, uploads: [], motion: true };
Object.assign(window, { api: { botWork: { avatars: async (request: BotAvatarCommand) => {
  if (request.kind === 'set') snapshot.selections[request.botId] = { assetId: request.assetId, revision: request.expectedRevision + 1 };
  return { ok: true, snapshot: structuredClone(snapshot) };
} } } });
const bots = ['a','b','c','d','e'].map(botId => ({ botId, displayName: `Bot ${botId}` }));
const team = (ids: string[]) => ({ name: '产品团队', ownerBotId: ids[0] ?? '', members: ids.slice(1).map(botId => ({ botId, responsibility: '测试', delegatedScope: [] })) });
async function main() {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const draw = (ids: string[]) => act(async () => { root.render(<BotTeamAvatar team={team(ids)} bots={bots} />); });
  const images = () => document.querySelectorAll('.bot-avatar');
  assert.deepEqual(teamAvatarMembers(team(['a','a','b']), bots).map(member => member.botId), ['a','b']);
  assert.deepEqual(teamAvatarMembers(team(['a','b']), [...bots].reverse()).map(member => member.botId), ['a','b']);
  for (const count of [0,1,2,3,4,5]) {
    await draw(bots.slice(0,count).map(bot => bot.botId));
    assert.equal(images().length, Math.min(count,4));
    assert.equal(document.querySelectorAll('[data-animated="true"]').length,0);
    assert.equal(document.querySelector('.bot-team-avatar')?.getAttribute('data-member-count'), String(count));
  }
  await draw(['a','b']);
  await act(async () => { await avatarCommand({ kind: 'set', botId: 'b', assetId: builtinBotAvatars[0].id, expectedRevision: 0 }); });
  assert.equal(images()[1]?.getAttribute('data-avatar-id'),builtinBotAvatars[0].id);
  assert(images()[1]?.querySelector('img')?.getAttribute('src')?.endsWith('.png'));
  await draw(['b','c']);
  assert.equal(images()[0]?.getAttribute('data-avatar-id'),builtinBotAvatars[0].id);
  assert(document.querySelector('.bot-team-avatar')?.getAttribute('aria-label')?.includes('Bot c'));
  await draw(['missing']);
  assert(document.querySelector('.bot-team-avatar')?.getAttribute('aria-label')?.includes('不可用 Bot'));
  assert.equal(images()[0]?.getAttribute('data-avatar-id'),'default');
  await act(() => root.unmount());
  console.log('team-avatar DOM: 0–5 members, stable order, duplicates, missing Bot, live avatar and membership updates, static posters PASS');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
