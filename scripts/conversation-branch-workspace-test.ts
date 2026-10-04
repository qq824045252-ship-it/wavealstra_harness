import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { TaskFileAccessPolicy } from '../src/main/security/TaskFileAccessPolicy';
import { createConversationBranchSession, resolveConversationBranchSourceRoots } from '../src/main/agent/session-branch';
const root = mkdtempSync(join(tmpdir(), 'mybuddy-fork-workspace-'));
const parent = join(root, 'parent'), child = join(root, 'child'), external = join(root, 'external');
for (const p of [parent, child, external]) mkdirSync(p, { recursive: true });
writeFileSync(join(parent, 'same.md'), 'PARENT'); writeFileSync(join(child, 'same.md'), 'CHILD');
let checks = 0;
function check(name: string, condition: unknown): void { assert(condition, name); checks++; console.log('PASS ' + name); }
try {
 const sm = SessionManager.create(parent, join(root, 'sessions'));
 const u = sm.appendMessage({ role: 'user', content: 'read/write same.md' } as never);
 sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }] } as never);
 const fork = createConversationBranchSession(sm.getSessionFile()!, child, u);
 const sources = resolveConversationBranchSourceRoots(fork.sessionFile, child);
 check('source roots come from Pi ancestry', sources.length === 1 && sources[0] === parent);
 const policy = new TaskFileAccessPolicy({ taskId: 'child', taskRoot: child, isolatedSourceRoots: sources });
 check('current relative path remains writable', policy.decide('write', 'same.md').allowed);
 check('historical parent absolute path is an isolated source', policy.decide('write', join(parent, 'same.md')).scope === 'isolated-source');
 check('retained product path policy classifies a historical parent read as an isolated source', policy.decide('read', join(parent, 'same.md')).scope === 'isolated-source');
 check('similar prefix outside parent is not misclassified', policy.decide('write', join(root, 'parent-other', 'same.md')).scope === 'external');
 // Real junction: a lexical child path must not bypass source isolation.
 const alias = join(child, 'parent-alias'); symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
 check('source isolation follows junction realpaths', policy.decide('write', join(alias, 'same.md')).scope === 'isolated-source');
 check('parent file remains byte-for-byte unchanged', readFileSync(join(parent,'same.md'),'utf8') === 'PARENT');
 const shared = new TaskFileAccessPolicy({taskId:'shared',taskRoot:parent});
 check('shared workspace intentionally remains shared', shared.decide('write',join(parent,'same.md')).allowed);
 policy.addWriteGrant({path:parent,source:'user-approval'});
 check('explicit child-task source grant is respected', policy.decide('write',join(parent,'same.md')).allowed);
 const grandchild = join(root,'grandchild'); mkdirSync(grandchild);
 const grand = createConversationBranchSession(fork.sessionFile,grandchild,u);
 const ancestors = resolveConversationBranchSourceRoots(grand.sessionFile,grandchild);
 check('nested fork protects both source workspaces', ancestors.includes(parent) && ancestors.includes(child));
 console.log(`conversation-branch-workspace: passed=${checks} failed=0`);
} finally { rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
