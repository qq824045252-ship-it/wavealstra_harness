import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkService, DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { WorkListQuery } from '../src/main/agent/work/WorkListQuery';
import { readBotDirectoryActivity } from '../src/main/agent/work/BotDirectoryActivity';
import { LOCAL_USER_ID, type WorkActor } from '../src/shared/bot-work';
import { botPresence, botReplyBadge, botWorkBadges } from '../src/renderer/src/lib/botDirectoryActivity';

const root = mkdtempSync(join(tmpdir(), 'bot-directory-activity-'));
const db = new AppDatabase(join(root, 'app.db'));
const registry = new BotRegistry(db.connection);
const primary = registry.ensureDefaultBot(LOCAL_USER_ID);
const second = registry.registerBot({ botId: 'bot-directory-second', userId: LOCAL_USER_ID, displayName: '第二' });
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
// Foreground rows: only a queued or streaming assistant answer is output.
const conversation = (id: string, botId: string, teamId: string | null = null) =>
  db.connection.prepare(`INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at,team_id)
    VALUES (?,?,?,1,1,?)`).run(id, botId, LOCAL_USER_ID, teamId);
const reply = (id: string, conversationId: string, botId: string, status: string) =>
  db.connection.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at)
    VALUES (?,?,?,?,'assistant','',?,1,1)`).run(id, conversationId, botId, `req-${id}`, status);

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
  // Work creation already binds a live personal conversation for its owner; the
  // team scope gets its own conversation, exactly like the host does at admission.
  const personalConversation = db.connection.prepare(`SELECT conversation_id FROM bot_conversations
    WHERE user_id=? AND bot_id=? AND team_id IS NULL AND archived_at IS NULL`).pluck().get(LOCAL_USER_ID, primary.botId) as string;
  conversation('conversation-team', primary.botId, 'team-indicator');
  reply('reply-running', personalConversation, primary.botId, 'running');
  reply('reply-queued', 'conversation-team', primary.botId, 'queued');
  reply('reply-done', personalConversation, primary.botId, 'completed');

  // The counters must equal what each row's own tabs show, from the same snapshot.
  const personal = query.query(LOCAL_USER_ID, { scope: { kind: 'personal', botId: primary.botId }, view: 'all', pageSize: 1 });
  const teamCounts = query.query(LOCAL_USER_ID, { scope: { kind: 'team', teamId: 'team-indicator' }, view: 'all', pageSize: 1 });
  const before = db.connection.prepare('SELECT total_changes() AS n').get() as { n: number };
  const activity = readBotDirectoryActivity(db.connection, LOCAL_USER_ID);
  const after = db.connection.prepare('SELECT total_changes() AS n').get() as { n: number };
  assert.deepEqual({ active: activity.bots[primary.botId]?.activeWorks, completed: activity.bots[primary.botId]?.completedWorks },
    { active: personal.viewCounts.active, completed: personal.viewCounts.completed },
    'a Bot badge equals its personal 进行中/已完成 tab totals');
  assert.deepEqual({ active: activity.teams['team-indicator']?.activeWorks, completed: activity.teams['team-indicator']?.completedWorks },
    { active: teamCounts.viewCounts.active, completed: teamCounts.viewCounts.completed },
    'a team badge equals its team tab totals');
  assert.deepEqual(activity.bots[primary.botId], { activeWorks: 1, completedWorks: 1, activeReplies: 2 },
    'archived, deleted, cancelled and team Works never leak into the Bot counters; every foreground output counts');
  assert.deepEqual(activity.bots[second.botId], { activeWorks: 1, completedWorks: 0, activeReplies: 0 });
  assert.deepEqual(activity.teams['team-indicator'], { activeWorks: 1, completedWorks: 1, activeReplies: 1 },
    'a team counts its own replies without borrowing personal Work');
  assert.equal(before.n, after.n, 'reading the directory activity writes nothing');
  assert.deepEqual(readBotDirectoryActivity(db.connection, LOCAL_USER_ID), activity, 'repeated reads are identical');

  db.connection.prepare("UPDATE bot_messages SET status='completed' WHERE message_id IN ('reply-running','reply-queued')").run();
  assert.deepEqual(readBotDirectoryActivity(db.connection, LOCAL_USER_ID).bots[primary.botId],
    { activeWorks: 1, completedWorks: 1, activeReplies: 0 },
    'a finished reply stops counting as foreground output');

  // Presence follows unfinished Work or unfinished foreground output; availability
  // and lifecycle stay separate, and the live reply wins over a stale host count.
  const idle = { activeWorks: 0, completedWorks: 9, activeReplies: 0 };
  assert.deepEqual(botPresence({ status: 'active' }, { online: true }, idle), { state: 'idle', label: '空闲' });
  assert.deepEqual(botPresence({ status: 'active' }, { online: true }, { ...idle, activeWorks: 1 }), { state: 'working', label: '工作中' });
  assert.deepEqual(botPresence({ status: 'active' }, { online: true }, { ...idle, activeReplies: 1 }), { state: 'working', label: '工作中' });
  assert.deepEqual(botPresence({ status: 'active' }, { online: true }, idle, true), { state: 'working', label: '工作中' });
  assert.deepEqual(botPresence({ status: 'active' }, { online: true }), { state: 'idle', label: '空闲' });
  assert.deepEqual(botPresence({ status: 'active' }, { online: false }, { activeWorks: 3, completedWorks: 0, activeReplies: 2 }), { state: 'offline', label: '离线' });
  assert.deepEqual(botPresence({ status: 'active' }, null, { activeWorks: 3, completedWorks: 0, activeReplies: 0 }), { state: 'unknown', label: '状态待核实' });
  assert.deepEqual(botPresence({ status: 'paused' }, { online: true }, { activeWorks: 3, completedWorks: 0, activeReplies: 1 }), { state: 'paused', label: '已暂停' });
  assert.deepEqual(botPresence({ status: 'disabled' }, { online: true }), { state: 'disabled', label: '已停用' });
  assert.deepEqual(botWorkBadges({ activeWorks: 2, completedWorks: 0, activeReplies: 3 }).map(badge => badge.label), ['进行中'], 'an empty counter stays silent');
  assert.deepEqual(botWorkBadges({ activeWorks: 2, completedWorks: 6, activeReplies: 1 }).map(badge => `${badge.label}${badge.value}`), ['进行中2', '已完成6']);
  assert.deepEqual(botWorkBadges(undefined), []);
  // Foreground output is its own badge, never a Work count.
  assert.equal(botReplyBadge({ activeWorks: 0, completedWorks: 3, activeReplies: 0 }), null);
  assert.deepEqual(botReplyBadge({ activeWorks: 0, completedWorks: 3, activeReplies: 1 }), { label: '回复中', title: '正在输出回复' });
  assert.equal(botReplyBadge({ activeWorks: 0, completedWorks: 3, activeReplies: 2 })?.title, '2 条回复正在输出');
  assert.deepEqual(botReplyBadge(undefined, true), { label: '回复中', title: '正在输出回复' });
  assert.equal(botReplyBadge(undefined, false), null);
  assert.deepEqual(botWorkBadges({ activeWorks: 2, completedWorks: 5, activeReplies: 4 }).map(badge => badge.value), [2, 5],
    'an in-flight reply never inflates 进行中/已完成');

  console.log('PASS bot directory activity: personal/team Work counters match the tabs, foreground output counts independently and clears on completion, reads are side-effect free, presence and badges follow unfinished Work and replies');
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
