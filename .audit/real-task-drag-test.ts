import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { getChildrenMixed, mixedIndexToKindIndex } from '../src/shared/workspace-tree';
const file='out/tests/real-task-drag/tasks.db';
let db=new AppDatabase(file);
const parent='local-1791336282611-34';
const before=db.listTasks();
const timestamps=new Map(before.map(task=>[task.id,task.updatedAt]));
const children=()=>getChildrenMixed(parent,db.listSpaces(),db.listTasks()).filter(node=>node.kind==='task');
const initial=children();
assert(initial.length>=3);
const report=[];
for(const [from,to] of [[0,2],[4,1],[1,4],[2,0]]) {
 const original=children();const task=original[from];assert(task);
 const expected=original.map(node=>node.id).filter(id=>id!==task.id);expected.splice(to,0,task.id);
 const index=mixedIndexToKindIndex(original,task.id,'task',to);
 db.moveTaskInWorkspaceTree({taskId:task.id,targetSpaceId:parent,targetIndex:index});
 assert.deepEqual(children().map(node=>node.id),expected,'saved order must match actual drop');
 db.close();db=new AppDatabase(file);
 assert.deepEqual(children().map(node=>node.id),expected,'reopened order must match actual drop');
 for(const row of db.listTasks())assert.equal(row.updatedAt,timestamps.get(row.id),'activity timestamps must be preserved');
 report.push({taskId:task.id,title:before.find(row=>row.id===task.id)?.title,from,to,orderAfter:expected,persisted:true,timestampsPreserved:true});
}
db.close();writeFileSync('out/tests/real-task-drag/report.json',JSON.stringify({source:'real app.db SQLite backup',taskCount:before.length,parent,moves:report},null,2));console.log(JSON.stringify(report.map(({title,from,to,persisted,timestampsPreserved})=>({title,from,to,persisted,timestampsPreserved})),null,2));
