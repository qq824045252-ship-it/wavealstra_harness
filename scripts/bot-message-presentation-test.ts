import assert from "node:assert/strict";
import { botMessagePresentation } from "../src/renderer/src/lib/botMessagePresentation";
import type { ChatMessage } from "../src/renderer/src/types";
const user = (id: string): ChatMessage => ({ id, role: "user", blocks: [{type:"text",text:id}], createdAt:1 });
const reply = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role:"assistant",blocks:[],createdAt:2, ...extra });
const tool = {id:"call-1",tool:"read",summary:"seed",status:"success" as const,output:"seed result"};
const records = [user("input-1"),
  reply("step-1",{blocks:[{type:"thinking",text:"reasoning"},{type:"tool",toolCall:tool}],finalBlocks:[{type:"text",text:"checking"}],artifactIds:["image-1"],modelName:"first model"}),
  reply("step-2",{blocks:[{type:"tool",toolCall:{...tool,status:"error",output:"latest diagnostic"}}],artifactIds:["image-1","file-2"]}),
  reply("final-1",{finalBlocks:[{type:"text",text:"complete answer"}],modelName:"next model",durationLabel:"26s"}),
  user("input-2"), reply("final-2",{finalBlocks:[{type:"text",text:"separate turn"}]})];
const before = JSON.stringify(records);
const projected = botMessagePresentation(records);
assert.equal(projected.length,4);
assert.equal(projected[1].id,"final-1");
assert.equal(projected[1].presentationKey,"durable-turn-input-1");
assert.deepEqual(projected[1].finalBlocks,records[3].finalBlocks);
assert.deepEqual(projected[1].blocks.map(block=>block.type),["thinking","text","tool"]);
assert.equal(projected[1].blocks[2].type === "tool" && projected[1].blocks[2].toolCall.output,"latest diagnostic");
assert.deepEqual(projected[1].artifactIds,["image-1","file-2"]);
assert.equal(projected[1].durationLabel,"26s");assert.equal(projected[1].modelName,"next model");
assert.equal(JSON.stringify(records),before,"Display grouping cannot mutate native history");
for(const partial of [reply("waiting",{streaming:true}), ...records.slice(1,4)]) {
  const current=botMessagePresentation([records[0],partial]);
  assert.equal(current[1].presentationKey,projected[1].presentationKey,"Waiting, tools, streaming and completion reuse one row identity");
}
assert.equal(botMessagePresentation([]).length,0);
assert.equal(botMessagePresentation([reply("orphan")])[0].presentationKey,"durable-turn-orphan");
console.log("PASS: Bot reply grouping, ordered process, tool deduplication, artifacts, turn boundaries and stable row identity");
