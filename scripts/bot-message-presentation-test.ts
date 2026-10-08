import assert from "node:assert/strict";
import { botMessagePresentation } from "../src/renderer/src/lib/botMessagePresentation";
import type { ChatMessage } from "../src/renderer/src/types";
import { messageImageArtifacts } from "../src/renderer/src/lib/chatImages";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
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
assert.deepEqual(projected[1].sourceMessageIds,["step-1","step-2","final-1"]);
const image = (id: string, messageId: string, taskId = "task"): ArtifactDescriptor => ({id,taskId,kind:"image",createdByMessageId:messageId} as ArtifactDescriptor);
const generatedImages=[image("image-1","step-1"),image("unrelated-turn","final-2"),image("unrelated-task","step-1","other-task")];
assert.deepEqual(messageImageArtifacts(projected[1],generatedImages,"task").map(d=>d.id),["image-1"],"Images from an intermediate native record remain in the merged row without leaking across turns or tasks");
assert.equal(projected[1].durationLabel,"26s");assert.equal(projected[1].modelName,"next model");
assert.equal(JSON.stringify(records),before,"Display grouping cannot mutate native history");
for(const partial of [reply("waiting",{streaming:true}), ...records.slice(1,4)]) {
  const current=botMessagePresentation([records[0],partial]);
  assert.equal(current[1].presentationKey,projected[1].presentationKey,"Waiting, tools, streaming and completion reuse one row identity");
}
assert.equal(botMessagePresentation([]).length,0);
assert.equal(botMessagePresentation([reply("orphan")])[0].presentationKey,"durable-turn-orphan");
const queue = [{ id:"steer-1", mode:"steer" as const, text:"相同内容\n第二行" },
  { id:"follow-1", mode:"followUp" as const, text:"相同内容\n第二行" }];
const queueBefore = JSON.stringify(queue);
const queued = botMessagePresentation(records,queue);
assert.deepEqual(queued.slice(0,projected.length),projected,"Queue previews cannot change the active reply or native history");
assert.deepEqual(queued.slice(-4).map(message=>message.role),["user","assistant","user","assistant"]);
assert.deepEqual(queued.slice(-4).filter(message=>message.role==="user").map(message=>message.blocks),queue.map(input=>[{type:"text",text:input.text}]));
assert.deepEqual(queued.slice(-4).filter(message=>message.role==="assistant").map(message=>message.pendingBehavior),["steer","followUp"]);
assert(queued.slice(-4).filter(message=>message.role==="assistant").every(message=>message.streaming));
assert.equal(new Set(queued.map(message=>message.id)).size,queued.length,"Identical queued texts must retain separate identities");
assert.deepEqual(botMessagePresentation(records,queue).map(message=>message.id),queued.map(message=>message.id),"Queue row identities are stable across snapshots");
assert.equal(JSON.stringify(queue),queueBefore,"The native inbox cannot be mutated by display projection");
assert.equal(JSON.stringify(records),before,"Pending rows cannot be persisted into native history");
const consumed = botMessagePresentation([...records,user("native-delivered"),reply("native-answer")],[]);
assert(!consumed.some(message=>message.pendingBehavior),"A consumed native inbox leaves no pending reply rows");
assert.equal(consumed.length,projected.length+2);
console.log("PASS: Bot reply grouping, ordered process, tool deduplication, artifacts, turn boundaries and stable row identity");
