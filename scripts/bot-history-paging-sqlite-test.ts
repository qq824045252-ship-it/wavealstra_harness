import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
const root = mkdtempSync(join(tmpdir(),"bot-history-pages-")), file = join(root,"app.db");
let db = new AppDatabase(file);
try {
  const bots = new BotRegistry(db.connection);
  bots.registerBot({botId:"a",userId:"u",displayName:"A"}); bots.registerBot({botId:"b",userId:"u",displayName:"B"});
  let repo = new BotConversationRepository(db.connection);
  for (let i=0;i<125;i++) {
    repo.accept("u",{botId:"a",requestId:`a${i}`,text:`personal ${i}`});
    repo.accept("u",{botId:"a",teamId:"t",requestId:`t${i}`,text:`team ${i}`});
    repo.accept("u",{botId:"b",requestId:`b${i}`,text:`other ${i}`});
  }
  db.close(); db = new AppDatabase(file); repo = new BotConversationRepository(db.connection);
  for(const teamId of [undefined,"t"]) {
    let page = repo.history("u",{botId:"a",teamId}); const conversationId = page.conversationId;
    const messages = [...page.messages]; assert.equal(page.messages.length,100); assert(page.before);
    page = repo.history("u",{botId:"a",teamId,conversationId,before:page.before}); assert.equal(page.messages.length,100); messages.unshift(...page.messages);
    page = repo.history("u",{botId:"a",teamId,conversationId,before:page.before}); assert.equal(page.messages.length,50); assert.equal(page.before,undefined); messages.unshift(...page.messages);
    assert.equal(new Set(messages.map(m=>m.messageId)).size,250); assert(messages.every(m=>m.botId==="a"&&m.conversationId===conversationId));
    assert.deepEqual(messages.map(m=>m.ordinal),messages.map(m=>m.ordinal).sort((a,b)=>a-b));
    const catchup = repo.history("u",{botId:"a",teamId,after:messages[0].ordinal});
    assert.equal(catchup.messages.length,100); assert.deepEqual(catchup.messages.map(m=>m.messageId),messages.slice(1,101).map(m=>m.messageId));
    const target = messages.find(message=>message.role==="assistant")!;
    repo.update(target.messageId,"completed","finished while disconnected");
    const reconcile = repo.history("u",{botId:"a",teamId,conversationId,messageIds:[target.messageId]});
    assert.equal(reconcile.messages.length,1); assert.equal(reconcile.messages[0].status,"completed");
    assert.equal(repo.history("u",{botId:"b",messageIds:[target.messageId]}).messages.length,0,"target IDs cannot bypass scope");
    assert.throws(()=>repo.history("u",{botId:"a",teamId:teamId?undefined:"t",conversationId}),/不属于/);
    assert.equal(repo.history("foreign-user",{botId:"a",teamId,conversationId}).messages.length,0);
  }
  // Exact full page is an EOF, not an extra empty page request.
  for(let i=0;i<50;i++) repo.accept("u",{botId:"a",teamId:"exact",requestId:`exact${i}`,text:"exact"});
  assert.equal(repo.history("u",{botId:"a",teamId:"exact"}).before,undefined);
  console.log("PASS persistent SQLite history: 100/100/50 paging after reopen, stable global ordinals, Bot/team/user fences, forward catch-up, exact EOF");
} finally { db.close(); rmSync(root,{recursive:true,force:true}); }
