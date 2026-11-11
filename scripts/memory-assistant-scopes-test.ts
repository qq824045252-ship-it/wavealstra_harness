import assert from "node:assert/strict";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ensureWorkTeamSchema } from "../src/main/agent/work/WorkTeamService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { MemoryProjectionRepository } from "../src/main/memory/MemoryProjectionRepository";
import { MemoryService } from "../src/main/memory/MemoryService";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import type { MemoryScopeType, MemorySearchRequest } from "../src/shared/memory-kernel";

// Real MemoryService and SQLite behavior; no model/mock retrieval or production data.
const db = new AppDatabase(":memory:");
try {
  const bots = new BotRegistry(db.connection);
  for (const botId of ["a", "b"]) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId });
  ensureWorkTeamSchema(db.connection);
  db.connection.prepare("INSERT INTO work_team_templates(template_id,user_id,operation_id,request_hash,name,plan_json,created_at) VALUES('team-a',?,'team-op','hash','Team A','{}',1)").run(LOCAL_USER_ID);
  db.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at,archived,resource_budget_chars) VALUES('p1','Project',1,1,0,128000)").run();
  for (const [id, bot] of [["c1", "a"], ["c2", "a"], ["c3", "b"]]) {
    db.connection.prepare(`INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,1)`)
      .run(id, bot, LOCAL_USER_ID, 1, 1);
  }
  for (const id of ["w1", "w2"]) {
    db.connection.prepare(`INSERT INTO works(work_id,user_id,owner_bot_id,project_id,title,authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,created_at,updated_at)
      VALUES(?,?,?,'p1',?,'{}','intent','input','user',1,1)`).run(id, LOCAL_USER_ID, "a", id);
  }
  for (const [taskId, workId] of [["t1", "w1"], ["t2", "w1"], ["t3", "w2"]]) {
    db.upsertTask({ id: taskId, title: taskId, status: "in_progress", updatedAt: 1 });
    db.connection.prepare(`INSERT INTO work_execution_bindings(binding_id,work_id,operation_id,bot_id,task_id,durable_store_key,conversation_id,intent_revision,owner_epoch,input_snapshot_id,expert_snapshot_json,workspace_binding,status,admitted_at)
      VALUES(?,?,?,'a',?,?,?,1,1,'input','{}','/tmp','completed',1)`).run(taskId, workId, taskId, taskId, taskId, taskId);
  }
  const memory = new MemoryService(db, { semantic: false });
  const atom = (scopeType: MemoryScopeType, scopeId?: string, metadata = {}) => memory.create({
    kind: "fact", title: `${scopeType}-${scopeId ?? "public"}`, content: `Unique fact for ${scopeType} ${scopeId ?? "public"}`,
    scopeType, scopeId, sourceType: "user", explicit: true, confidence: 1, metadata,
  });
  const a = atom("bot", "a"), b = atom("bot", "b"), team = atom("team", "team-a");
  const legacyGlobal = atom("global"), shared = atom("global", undefined, { publicShared: true });
  const c1 = atom("conversation", "c1"), c2 = atom("conversation", "c2");
  const w1 = atom("work", "w1"), w2 = atom("work", "w2"), project = atom("project", "p1");
  const taskOnly = atom("task", "t1");
  const visible = (request: MemorySearchRequest) => new Set(memory.search({ ...request, limit: 100 }).map(hit => hit.memory.id));
  const check = (request: MemorySearchRequest, yes: string[], no: string[]) => {
    const result = visible(request);
    for (const id of yes) assert(result.has(id), `missing ${id} for ${JSON.stringify(request)}`);
    for (const id of no) assert(!result.has(id), `scope leaked ${id} for ${JSON.stringify(request)}`);
  };
  check({ botId: "a" }, [a.id, shared.id], [b.id, team.id, legacyGlobal.id]);
  check({ botId: "b" }, [b.id, shared.id], [a.id, legacyGlobal.id]);
  check({ teamId: "team-a", botId: "a" }, [team.id, shared.id], [a.id, b.id, legacyGlobal.id]);
  check({}, [legacyGlobal.id, shared.id], [a.id, team.id]); // ordinary legacy global behavior retained
  check({ conversationId: "c1" }, [a.id, c1.id, shared.id], [c2.id, b.id, legacyGlobal.id]);
  check({ conversationId: "c2" }, [a.id, c2.id], [c1.id, b.id]);
  check({ conversationId: "c3", botId: "a" }, [b.id], [a.id, c1.id]);
  db.connection.prepare("UPDATE bot_conversations SET team_id='team-a' WHERE conversation_id='c2'").run();
  check({ conversationId: "c2", botId: "a" }, [team.id, c2.id], [a.id, b.id, c1.id]);
  check({ taskId: "t1" }, [a.id, w1.id, project.id, taskOnly.id], [w2.id, b.id, legacyGlobal.id]);
  check({ taskId: "t2" }, [a.id, w1.id, project.id], [taskOnly.id, w2.id]);
  check({ taskId: "t3" }, [a.id, w2.id, project.id], [w1.id, taskOnly.id]);
  check({ workId: "w1" }, [a.id, w1.id, project.id], [w2.id, taskOnly.id]);
  check({ taskId: "t2", botId: "b", workId: "w2", teamId: "other-team", projectId: "other-project" },
    [a.id, w1.id, project.id], [b.id, w2.id]);
  // Personal Work remains owned by A even when collaborator B executes its next round.
  db.connection.prepare("UPDATE work_execution_bindings SET bot_id='b' WHERE task_id='t2'").run();
  check({ taskId: "t2" }, [a.id,w1.id,project.id], [b.id,w2.id]);
  // The native subagent memory extension is bound to its parentTaskId, not the executing Bot hint.
  const childBinding = { parentTaskId: "t2", executorBotId: "b" };
  check({ taskId: childBinding.parentTaskId, botId: childBinding.executorBotId }, [a.id,w1.id,project.id], [b.id]);
  assert(memory.resolveScopeChain({taskId:childBinding.parentTaskId}).some(scope => scope.scopeType==='bot' && scope.scopeId==='a'));
  db.connection.prepare("INSERT INTO work_teams(work_id,user_id,operation_id,request_hash,plan_json,intent_revision,input_snapshot_id,created_at) VALUES('w2',?,'op-team','hash','{}',1,'input',1)").run(LOCAL_USER_ID);
  db.connection.prepare("INSERT INTO work_team_ownership(work_id,team_id,team_name) VALUES('w2','team-a','Team A')").run();
  check({ taskId: "t3" }, [team.id, w2.id, project.id, shared.id], [a.id, b.id, w1.id, legacyGlobal.id]);
  check({ workId: "w2", botId: "a" }, [team.id, w2.id, project.id], [a.id, b.id]);
  // A conflicting conversation hint must not cross an authoritative execution boundary.
  check({ taskId: "t2", conversationId: "c3" }, [a.id, w1.id], [c1.id, c2.id, b.id]);
  memory.update({ id: a.id, content: "Updated private fact for a" });
  assert(memory.search({ botId: "a", query: "Updated private fact", limit: 100 }).some(hit => hit.memory.id === a.id));
  memory.forget(a.id);
  check({ botId: "a" }, [shared.id], [a.id, b.id]);
  check({ botId: "b" }, [b.id], [a.id]);
  assert.deepEqual(new MemoryProjectionRepository(db).invalidateScopes([
    { scopeType: "bot", scopeId: "a" }, { scopeType: "team", scopeId: "team-a" },
    { scopeType: "conversation", scopeId: "c1" }, { scopeType: "work", scopeId: "w1" },
  ]), { scenarios: 0, profiles: 0 });
  console.log("Assistant scope behavior passed: Bot isolation, team privacy, explicit public sharing, conversation isolation, Work across tasks and project across Works");
} finally { db.close(); }
