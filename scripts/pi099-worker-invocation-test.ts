import assert from 'node:assert/strict';
import { resolvePiInvocation } from '../src/main/capabilities/subagent/invocation';
const cli='C:\\pinned-pi\\dist\\cli.js', node='C:\\node\\node.exe';
const env={PI_CLI_PATH:cli,PI_NODE_PATH:node};
const exists=(file:string)=>file===cli||file===node||file===process.argv[1];
assert.deepEqual(resolvePiInvocation(env,node,false,()=>null,exists),{command:node,args:[cli]});
assert.deepEqual(resolvePiInvocation(env,'C:\\MyBuddy.exe',true,()=>null,exists),{command:node,args:[cli]});
assert.equal(resolvePiInvocation({},node,false,()=>null,p=>p===process.argv[1]),null,'Host test/application script must never become the Pi worker CLI');
console.log('PASS canonical Node/Electron worker CLI resolution and fail-closed missing Pi');
