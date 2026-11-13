import assert from "node:assert/strict";
import { buildActivityRows } from "../src/renderer/src/lib/botActivityMonitor";
import { tasks, works, bots, histories, subagents } from "./bot-activity-fixtures";
const input = { tasks, works, bots, histories, subagents, now: 200 };
const rows = buildActivityRows(input);
assert.equal(rows.length, 6);
assert.equal(rows.filter(row => row.running).length, 3);
assert(!rows.some(row => row.id === "task:binding-task"));
assert.equal(rows.find(row => row.id === "work:work")?.label, "等待执行");
assert(rows.find(row => row.id === "task:failed")?.ended);
assert(!rows.find(row => row.id === "task:failed")?.running);
assert.equal(rows.find(row => row.kind === "subagent")?.taskId, "ordinary");
assert.equal(rows.find(row => row.kind === "bot")?.title, "查明天是否下雨");
assert.equal(rows.find(row => row.kind === "bot")?.messageId, "reply");
assert.equal(buildActivityRows({ ...input, histories: { owner: { ...histories.owner, archived: true } } }).filter(row => row.kind === "bot").length, 0);
const ended = buildActivityRows({ ...input, subagents: {}, histories: { owner: { ...histories.owner, messages: histories.owner.messages.map(m => ({ ...m, status: "completed" })) } } });
assert(!ended.some(row => row.kind === "subagent"));
assert(ended.find(row => row.kind === "bot")?.ended);
assert.equal(buildActivityRows({ ...input, tasks: tasks.map(task => ({ ...task, archived: true })) }).filter(row => ["task", "subagent"].includes(row.kind)).length, 0);
const huge = buildActivityRows({ ...input, works: Array.from({ length: 1000 }, (_, i) => ({ ...works[0], workId: "w" + i })) });
assert.equal(huge.filter(row => row.kind === "work").length, 1000);
console.log("PASS activity monitor: source identities, deduplication, truthful states, archive, completion and 1000 Works");

const stale = buildActivityRows({ ...input, tasks: [{ ...tasks[0], messages: [] }] });
assert.equal(stale.find(row => row.kind === "task")?.label, "运行状态待核实");
assert(!stale.find(row => row.kind === "task")?.running);
const submitted = buildActivityRows({ ...input, works: [{ ...works[0], executions: works[0].executions.map(item => ({ ...item, status: "submitted" })) }] });
assert.equal(submitted.find(row => row.kind === "work")?.label, "已提交，等待执行");
assert(!submitted.find(row => row.kind === "work")?.running);

const oldRequest = { message: { ...histories.owner.messages[1], messageId: "old", conversationId: "old-conversation", status: "unknown" as const }, prompt: histories.owner.messages[0], archived: true };
const cross = buildActivityRows({ ...input, activeRequests: [oldRequest, { message: histories.owner.messages[1], prompt: histories.owner.messages[0], archived: false }] });
assert.equal(cross.filter(row => row.kind === "bot").length, 2, "current request deduped, old request retained");
assert(!cross.find(row => row.id === "bot:old")?.running);
assert(!cross.find(row => row.id === "bot:old")?.ended);
assert(cross.find(row => row.id === "bot:old")?.sourceRequest?.archived);

const terminalRace = buildActivityRows({ ...input, histories: { owner: { ...histories.owner, messages: histories.owner.messages.map(message => ({ ...message, status: "completed" })) } }, activeRequests: [{ message: histories.owner.messages[1], archived: false }] });
assert(terminalRace.find(row => row.kind === "bot")?.ended);
assert(!terminalRace.find(row => row.kind === "bot")?.running);

const staleStream = buildActivityRows({ ...input, tasks: [{ ...tasks[0], status: "failed" }] });
assert(!staleStream.find(row => row.kind === "task")?.running, "failed task is not revived by stale stream flags");

const idleChild = buildActivityRows({ ...input, subagents: { ordinary: [{ ...subagents.ordinary[0], status: "idle", workerAlive: true }] } });
assert.equal(idleChild.find(row => row.kind === "subagent")?.label, "等待工具调用");
assert(!idleChild.find(row => row.kind === "subagent")?.running);

const personal = buildActivityRows({ ...input, scopeBotId: "owner" });
assert.deepEqual(personal.map(row => row.id).sort(), ["bot:reply", "work:work"]);
assert.equal(buildActivityRows({ ...input, scopeBotId: "other" }).length, 0);
assert.equal(buildActivityRows({ ...input, scopeBotId: "" }).length, 0);
const teamOnly = buildActivityRows({ ...input, scopeBotId: "owner", works: [{ ...works[0], team: { teamId: "team", teamName: "团队", members: [], workId: "work", planRevision: 1, intentRevision: 1, inputSnapshotId: "input", ownerEpoch: 1, state: "running", executions: [], createdAt: 1, ownerBotId: "owner", ownerResponsibility: "汇总" } }] });
assert(!teamOnly.some(row => row.kind === "work"), "team Work is not personal Bot context");
assert.equal(buildActivityRows({ ...input, scopeBotId: null }).length, rows.length, "explicit global view preserves all sources");
console.log("PASS personal Bot scope, team exclusion and explicit global view");
const teamHistory = { ...histories.owner, teamId: "team-a", conversationId: "team-a-conversation", messages: histories.owner.messages.map(message => ({ ...message, teamId: "team-a", conversationId: "team-a-conversation", messageId: "team-" + message.messageId })) };
const teamContext = { ...input, histories: { ...histories, "team:team-a": teamHistory } };
assert(!buildActivityRows({ ...teamContext, scopeBotId: "owner" }).some(row => row.teamId), "personal scope excludes same leader's team requests");
const onlyTeam = buildActivityRows({ ...teamContext, scopeBotId: "owner", scopeTeamId: "team-a" });
assert.deepEqual(onlyTeam.map(row => row.id), ["bot:team-reply"]);
assert.equal(onlyTeam[0].teamId, "team-a");
assert.equal(buildActivityRows({ ...teamContext, scopeBotId: "owner", scopeTeamId: "team-b" }).length, 0);
console.log("PASS independent team message scope under the same leader");
