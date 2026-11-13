import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkService, DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { WorkListQuery } from '../src/main/agent/work/WorkListQuery';
import { readBotWorkIndicators } from '../src/main/agent/work/BotWorkIndicators';
import { LOCAL_USER_ID, type WorkActor } from '../src/shared/bot-work';
import { botPresence, botWorkBadges } from '../src/renderer/src/lib/botWorkIndicators';

const root = mkdtempSync(join(tmpdir(), 'bot-work-indicators-'));
const db = new AppDatabase(join(root, 'app.db'));
const registry = new BotRegistry(db.connection);
const primary = registry.ensureDefaultBot(LOCAL_USER_ID);
const second = registry.registerBot({ botId: 'bot-indicator-second', userId: LOCAL_USER_ID, displayName: '第二' });
const works = new WorkService(db.connection, { bots: registry, emitProjection: () => {} });
const query = new WorkListQuery(db.connection, () => true);
const actor: WorkActor = { kind: 'user', userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const create = (id: string, owner = primary.botId) => {
  const result = works.createWork({ ...actor, userId: LOCAL_USER_ID },
    { operationId: id, title: id, authorization: DESKTOP_USER_GRANTS, ...(owner === primary.botId ? {} : { ownerBotId: owner }) });
  if (!result.ok) throw new Error(`${id}: ${result.message}`);
  return result.work.workId;
};
const close = (workId: string, conclusion: 'succeeded' | 'cancelled') =>
  db.connection.prepare("UPDATE works SET lifecycle='closed',closure_conclusion=?,closed_at=1 WHERE work_id=?").run(conclusion, workId);
const archive = (workId: string, deletedAt: number | null = null) =>
  db.connection.prepare('INSERT INTO work_record_archive(work_id,archived_at,deleted_at) VALUES (?,1,?)').run(workId, deletedAt);
const team = (workId: string, teamId: string, removed = false) => {
  db.connection.prepare(`INSERT INTO work_teams(work_id,user_id,operation_id,request_hash,plan_json,intent_revision,
    input_snapshot_id,created_at) VALUES (?,?,?,?,'{}',1,'snapshot:fixture',1)`).run(workId, LOCAL_USER_ID, `op-${workId}`, workId);
  db.connection.prepare("INSERT INTO work_team_ownership(work_id,team_id,team_name) VALUES (?,?,'产品团队')").run(workId, teamId);
  db.connection.prepare('INSERT INTO work_team_record_visibility(work_id,removed_at) VALUES (?,?)').run(workId, removed ? 1 : null);
};

try {
  create('personal-active');
  close(create('personal-done'), 'succeeded');
  close(create('personal-cancelled'), 'cancelled');
  archive(create('personal-archived'));
  archive(create('personal-deleted'), 2);
  create('other-active', second.botId);
  const teamActive = create('team-active');
  const teamDone = create('team-done'); close(teamDone, 'succeeded');
  const teamRemoved = create('team-removed'); team(teamRemoved, 'team-indicator', true);
  const teamDeleted = create('team-deleted'); team(teamDeleted, 'team-indicator'); archive(teamDeleted, 2);
  team(teamActive, 'team-indicator'); team(teamDone, 'team-indicator');

  // The counters must equal what each row's own tabs show, from the same snapshot.
  const personal = query.query(LOCAL_USER_ID, { scope: { kind: 'personal', botId: primary.botId }, view: 'all', pageSize: 1 });
  const teamCounts = query.query(LOCAL_USER_ID, { scope: { kind: 'team', teamId: 'team-indicator' }, view: 'all', pageSize: 1 });
  const before = db.connection.prepare('SELECT total_changes() AS n').get() as { n: number };
  const indicators = readBotWorkIndicators(db.connection, LOCAL_USER_ID);
  const after = db.connection.prepare('SELECT total_changes() AS n').get() as { n: number };
  assert.deepEqual({ active: indicators.bots[primary.botId]?.active, completed: indicators.bots[primary.botId]?.completed },
    { active: personal.viewCounts.active, completed: personal.viewCounts.completed },
    'a Bot badge equals its personal 进行中/已完成 tab totals');
  assert.deepEqual(indicators.teams['team-indicator'],
    { active: teamCounts.viewCounts.active, completed: teamCounts.viewCounts.completed },
    'a team badge equals its team tab totals');
  assert.deepEqual(indicators.bots[primary.botId], { active: 1, completed: 1 },
    'archived, deleted, cancelled and team records never leak into the Bot counters');
  assert.deepEqual(indicators.bots[second.botId], { active: 1, completed: 0 });
  assert.deepEqual(indicators.teams['team-indicator'], { active: 1, completed: 1 });
  assert.equal(before.n, after.n, 'reading the directory counters writes nothing');
  assert.deepEqual(readBotWorkIndicators(db.connection, LOCAL_USER_ID), indicators, 'repeated reads are identical');
  for (const [botId, counts] of Object.entries(indicators.bots)) assert.ok(counts.active + counts.completed > 0, `${botId} keeps only non-empty counters`);

  // Presence follows unfinished Work; availability and lifecycle stay separate.
  assert.deepEqual(botPresence({ status: 'active' }, { online: true }, { active: 1, completed: 9 }), { state: 'working', label: '工作中' });
  assert.deepEqual(botPresence({ status: 'active' }, { online: true }, { active: 0, completed: 9 }), { state: 'idle', label: '空闲' });
  assert.deepEqual(botPresence({ status: 'active' }, { online: true }), { state: 'idle', label: '空闲' });
  assert.deepEqual(botPresence({ status: 'active' }, { online: false }, { active: 3, completed: 0 }), { state: 'offline', label: '离线' });
  assert.deepEqual(botPresence({ status: 'active' }, null, { active: 3, completed: 0 }), { state: 'unknown', label: '状态待核实' });
  assert.deepEqual(botPresence({ status: 'paused' }, { online: true }, { active: 3, completed: 0 }), { state: 'paused', label: '已暂停' });
  assert.deepEqual(botPresence({ status: 'disabled' }, { online: true }), { state: 'disabled', label: '已停用' });
  assert.deepEqual(botWorkBadges({ active: 2, completed: 0 }).map(badge => badge.label), ['进行中'], 'an empty counter stays silent');
  assert.deepEqual(botWorkBadges({ active: 2, completed: 6 }).map(badge => `${badge.label}${badge.value}`), ['进行中2', '已完成6']);
  assert.deepEqual(botWorkBadges(undefined), []);

  console.log('PASS bot work indicators: personal/team counters match the tabs, archived/deleted/removed are excluded, reads are side-effect free, presence and badges follow unfinished Work');
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
