import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const results: Array<{ name: string; passed: boolean; error?: string }> = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS '+name); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); console.error('FAIL '+name+': '+error); }
}

await test('Code Mode status is not rendered on welcome or active task UI', () => {
  const chat = readFileSync('src/renderer/src/components/chat/ChatView.tsx','utf8');
  assert(!chat.includes('PiCodeModeChip'));
  assert(!chat.includes('pi-codemode-status'));
  assert(!chat.includes('hero-native-capability'));
});
await test('backend native Code Mode status remains diagnostic-only', () => {
  const runtime = readFileSync('src/main/mcp/McpRuntimeService.ts','utf8');
  assert(runtime.includes('codeMode: this.codeModeState(sessionId)'));
  assert(runtime.includes('getActiveToolNames().includes("codemode")'));
});
await test('hidden UI has no accidental global CSS reference', () => {
  const files = ['src/renderer/src/components/chat/ChatView.tsx'];
  assert(files.every(file => !/pi-codemode-chip|hero-native-capability/.test(readFileSync(file,'utf8'))));
});
mkdirSync('artifacts/pi-minimal-mode',{recursive:true});
writeFileSync('artifacts/pi-minimal-mode/hidden-codemode-ui-results.json',JSON.stringify({at:new Date().toISOString(),passed:results.every(t=>t.passed),results},null,2));
process.exitCode=results.every(t=>t.passed)?0:1;
