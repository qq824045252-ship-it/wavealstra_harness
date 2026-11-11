import assert from "node:assert/strict";
import { workDeliveryFiles, workDeliveryResults } from "../src/main/agent/work/WorkDeliveryArtifacts";
import type { WorkService } from "../src/main/agent/work/WorkService";
import type { WorkDeliverableDto, WorkExecutionBindingDto } from "../src/shared/bot-work";
const binding = { bindingId:"owner",botId:"lead",taskId:"owner-task",workId:"work",intentRevision:2,inputSnapshotId:"input",ownerEpoch:1,admittedAt:30 } as WorkExecutionBindingDto;
const member = {...binding,bindingId:"member",botId:"writer",taskId:"writer-task",admittedAt:10};
const recovery = {...member,bindingId:"recovery",admittedAt:20};
const own = {deliverableId:"own",workId:"work",producerBotId:"lead",executionId:"owner",intentRevision:2,inputSnapshotId:"input",ownerEpoch:1,status:"proposed",summary:"worker report",artifactRefs:[],createdAt:30} as unknown as WorkDeliverableDto;
const authored = {...own,deliverableId:"member-result",producerBotId:"writer",executionId:"member",artifactRefs:["/snap/old.html","/snap/new.html","/work/unregistered.txt"],createdAt:11};
const newResult = {...authored,deliverableId:"new-result",executionId:"recovery",artifactRefs:["/snap/recovered.html"],createdAt:21};
let context: unknown = {teamAssignment:{role:"owner_summary",previousResults:[{botId:"writer",bindingId:"member",deliverableId:"member-result"},{botId:"writer",bindingId:"recovery",deliverableId:"new-result"}]}};
let results = [own,authored];
const generated = [
 {bindingId:"member",path:"/work/talk.html",snapshotPath:"/snap/old.html",sourceEntryId:2,registeredAt:12},
 {bindingId:"member",path:"/work/talk.html",snapshotPath:"/snap/new.html",sourceEntryId:4,registeredAt:14},
 {bindingId:"member",path:"/work/private.txt",snapshotPath:"/snap/private.txt",sourceEntryId:5,registeredAt:15},
 {bindingId:"foreign",path:"/work/unregistered.txt",snapshotPath:"/snap/foreign.txt",sourceEntryId:99,registeredAt:99},
 {bindingId:"recovery",path:"/work/talk.html",snapshotPath:"/snap/recovered.html",sourceEntryId:1,registeredAt:22},
];
const bindings = [binding,member,recovery];
let continuationSource: WorkExecutionBindingDto | undefined;
const works = {partialResults:{deliverySource:(b:WorkExecutionBindingDto)=>b.bindingId==="followup"?continuationSource:undefined},repo:{listDeliverables:()=>results,reportContext:()=>context,getBinding:(id:string)=>bindings.find(b=>b.bindingId===id),listBindings:()=>bindings},generatedArtifacts:{list:()=>generated}} as unknown as WorkService;
const selected = workDeliveryResults(works,binding);
assert.deepEqual(selected.map(r=>r.deliverableId),["own","member-result"],"frozen exact member delivery joins read-only owner summary");
assert.deepEqual(workDeliveryFiles(works,selected),[{ref:"/snap/new.html",name:"talk.html",openPath:"/snap/new.html"},{ref:"/work/unregistered.txt",name:"unregistered.txt"}],"latest referenced version is openable; same-name foreign file is not");
assert.equal(authored.artifactRefs.length,3,"original file history is not changed");
assert(!JSON.stringify(workDeliveryFiles(works,selected)).includes("private"),"registered but undelivered output cannot leak into reply");
results=[own,authored,newResult];
assert.equal(workDeliveryFiles(works,workDeliveryResults(works,binding)).filter(f=>f.name==="talk.html").length,1);
assert.equal(workDeliveryFiles(works,workDeliveryResults(works,binding)).find(f=>f.name==="talk.html")?.openPath,"/snap/recovered.html","newer registered version from same task supersedes older delivered version");
for (const changed of [{workId:"other"},{intentRevision:1},{inputSnapshotId:"other"},{ownerEpoch:2},{producerBotId:"impostor"},{status:"superseded"},{status:"rejected"}]) {
 results=[own,{...authored,...changed} as WorkDeliverableDto];
 assert.deepEqual(workDeliveryResults(works,binding).map(r=>r.deliverableId),["own"],"foreign/obsolete/rejected source is excluded");
}
results=[own,authored];context={};
assert.deepEqual(workDeliveryResults(works,binding).map(r=>r.deliverableId),["own"],"missing historical context is not permission to guess member files");
context={teamAssignment:{role:"member",previousResults:[{botId:"writer",bindingId:"member",deliverableId:"member-result"}]}};
assert.deepEqual(workDeliveryResults(works,binding).map(r=>r.deliverableId),["own"],"non-owner cannot adopt dependency outputs as a final team delivery");
console.log("PASS exact owner/member result scope, current versions, latest registered snapshots, provenance and unregistered refs");

const followup = {...binding,bindingId:"followup",taskId:"new-continuation-task",admittedAt:40};
bindings.push(followup);
const final = {...own,deliverableId:"final",executionId:"followup",artifactRefs:["/snap/new.html"],createdAt:41};
results=[own,authored,final];
context={teamAssignment:{role:"owner_summary",previousResults:[{botId:"writer",bindingId:"member",deliverableId:"member-result"}]}};
const reportContext=works.repo.reportContext;
works.repo.reportContext=(b)=>b.bindingId==="owner"?reportContext(b):undefined;
continuationSource=binding;
const continued = workDeliveryResults(works,followup);
assert.deepEqual(continued.map(r=>r.deliverableId),["own","member-result","final"]);
assert.equal(workDeliveryFiles(works,continued).filter(f=>f.name==="talk.html").length,1);
assert.equal(workDeliveryFiles(works,continued).find(f=>f.name==="talk.html")?.openPath,"/snap/new.html","verification-only continuation retains the member's original main deliverable");
continuationSource=undefined;
assert.equal(workDeliveryFiles(works,workDeliveryResults(works,followup))[0]?.openPath,undefined,"a naked prior ref is not continuation authority");
console.log("PASS persisted continuation lineage retains member output without global history guessing");

// Keep the production result-review transport regression in this focused gate.
await import("./bot-result-artifact-selection-test");
