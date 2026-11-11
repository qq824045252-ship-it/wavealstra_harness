import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskDiagnosticsButton from '../src/renderer/src/components/chat/TaskDiagnosticsButton';
import ToolCallCard from '../src/renderer/src/components/chat/ToolCallCard';
import type { ToolCall } from '../src/renderer/src/types';
// The task header exposes 执行诊断 directly; the retired "more" menu held no
// other action and must not come back as an authorization entry point.
const header = renderToStaticMarkup(<TaskDiagnosticsButton open={false} onClick={() => {}} />);
assert.match(header, /执行诊断/);
assert.doesNotMatch(header, /任务菜单|授权|撤销|外部写入/);
for (const approvalKind of [undefined, 'external-write'] as const) {
  const tool = { id: 'legacy', tool: 'write', summary: '需要授权', status: 'pending_approval', approvalKind, detail: 'legacy request', targetPath: '/tmp/example', canonicalDir: '/tmp' } as ToolCall;
  const html = renderToStaticMarkup(<ToolCallCard messageId="test" toolCall={tool} />);
  assert.match(html, /旧版待处理记录/);
  assert.doesNotMatch(html, /允许执行|允许一次|始终允许|需要你的确认/);
}
// Native third-party protocol decisions are not our app-owned authorization policy.
const acp = renderToStaticMarkup(<ToolCallCard messageId="test" toolCall={{ id:'acp', tool:'external', summary:'Provider request', status:'pending_approval', approvalKind:'acp', acpPermissionOptions:[{ optionId:'once', name:'Allow once', kind:'allow_once' }], externalRunId:'external-run' } as ToolCall} />);
assert.match(acp, /允许一次/);
const composer = readFileSync('src/renderer/src/components/chat/ChatInput.tsx','utf8');
assert.doesNotMatch(composer, /HomePermissionPicker|FullAccessConfirmModal|exec-perm-bar|setPermissionMode/);
const settings = readFileSync('src/renderer/src/components/settings/SettingsModal.tsx','utf8');
assert.doesNotMatch(settings, /系统操作策略|setPolicy\(/);
assert.match(settings, /本机代码执行环境/);
for (const path of ['chat/HomePermissionPicker.tsx','chat/FullAccessConfirmModal.tsx','chat/TaskWriteGrantsMenu.tsx','pages/BotWorkspaceAuthorization.tsx']) assert.equal(existsSync(`src/renderer/src/components/${path}`), false);
console.log('PASS app permission UI removal: composer, settings, direct task-header diagnostics entry, legacy ordinary/external-write records, third-party protocol boundary');
