/** Opt-in real OAuth verification: no fixture model/session/response. Never logs auth or HTTP bodies. */
import { mkdtempSync, mkdirSync, symlinkSync, copyFileSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const realProfile = join(homedir(), '.mybuddy');
const root = mkdtempSync(join(tmpdir(), 'a3-codex-auth-'));
const profile = join(root, '.mybuddy');
mkdirSync(profile, { recursive: true });
// Shared auth path lets Pi persist a legitimate OAuth refresh without copying credentials.
symlinkSync(join(realProfile, 'auth.json'), join(profile, 'auth.json'));
for (const file of ['models.json', 'models-store.json']) if (existsSync(join(realProfile, file))) copyFileSync(join(realProfile, file), join(profile, file));
process.env.MYBUDDY_WHISPER_DIR ??= join(homedir(), 'Documents', 'GitHub', 'whisper-voice-ime');
process.env.HOME = root;
process.env.USERPROFILE = root;
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ transport: 'sse', retry: { enabled: false }, compaction: { enabled: false } }));
// Keep application logging out of evidence; only explicitly selected non-secret fields are written.
console.log = console.info = console.warn = console.error = () => {};
const { ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
const { AgentService } = await import('../src/main/agent/AgentService');
const { AppDatabase } = await import('../src/main/db/AppDatabase');
const { TaskExecutionWorkspace } = await import('../src/main/task/TaskExecutionWorkspace');
const { probeSkillDependency } = await import('../src/main/agent/SessionDiagnostics');

const evidence: any = { root, auth: 'existing MyBuddy openai-codex OAuth via symlink; credentials never logged', transport: 'real SSE (for server request ID observation)', cells: [] };
const output = '/tmp/a3-codex-auth-evidence.json';
function save() { writeFileSync(output, JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
const nativeFetch = globalThis.fetch;
let cellRequests: any[] = [];
const bodies: Promise<void>[] = [];
globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/responses')) {
    let model: string | undefined;
    try { const body = init?.body; model = JSON.parse(typeof body === 'string' ? body : zstdDecompressSync(body as Uint8Array).toString('utf8')).model; } catch {}
    const requestHeaders = new Headers(init?.headers);
    const record: any = { model, clientRequestId: requestHeaders.get('x-client-request-id'), status: response.status, requestId: response.headers.get('x-request-id'), cfRay: response.headers.get('cf-ray'), responseIds: [] };
    cellRequests.push(record);
    bodies.push(response.clone().text().then(text => {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { const event = JSON.parse(line.slice(5)); if (event.response?.id) record.responseIds.push(event.response.id); } catch {}
      }
      record.responseIds = [...new Set(record.responseIds)];
      if (!response.ok) { try { const data = JSON.parse(text); record.error = data.error?.message ?? data.detail ?? data.message; } catch {} }
    }).catch(() => {}));
  }
  return response;
};

// Refresh the real profile's model cache through Pi's existing runtime, without touching defaults.
const runtime = await ModelRuntime.create({ authPath: join(realProfile, 'auth.json'), modelsPath: join(realProfile, 'models.json'), refreshOnCreate: false });
const refresh = await runtime.refresh({ providers: ['openai-codex'], allowNetwork: true, force: true, signal: AbortSignal.timeout(15000) });
evidence.refresh = { aborted: refresh.aborted, errors: [...refresh.errors.keys()], models: (await runtime.getAvailable()).filter(m => m.provider === 'openai-codex').map(m => m.id) };
if (existsSync(join(realProfile, 'models-store.json'))) copyFileSync(join(realProfile, 'models-store.json'), join(profile, 'models-store.json'));
save();
const db = new AppDatabase(join(root, 'tasks.db'));
let agent = new AgentService(db, new TaskExecutionWorkspace(join(root, 'workspaces')));
await agent.init();
const reload = await agent.reloadModels('openai-codex');
const models = reload.models.filter(m => m.vendor === 'openai-codex' && m.available);
evidence.catalog = models.map(m => ({ id: m.id, provider: m.vendor }));
save();
if (!models.length) throw new Error('No available openai-codex model after refresh');
const modelA = models.find(m => m.id.endsWith('/gpt-6.1-sol'))?.id ?? models[0]!.id;
const modelB = models.find(m => m.id.endsWith('/gpt-6-sol'))?.id ?? modelA;
evidence.selected = { modelA, modelB };
const base = agent.getModeProfile('working').policy;
async function config(suggestion?: string, defaultId?: string) {
  agent.saveModePolicy('working', { ...base, suggestedModelId: suggestion ?? null });
  const settings = SettingsManager.create(process.cwd(), profile);
  settings.setDefaultProvider(defaultId ? defaultId.slice(0, defaultId.indexOf('/')) : '');
  settings.setDefaultModel(defaultId ? defaultId.slice(defaultId.indexOf('/') + 1) : '');
  settings.setEnabledModels(models.map(m => m.id));
  settings.setTransport('sse');
  await settings.flush();
}
let restoredTask: string | undefined;
for (const name of ['explicit', 'suggestion', 'default', 'invalid-suggestion', 'restored', 'no-config']) {
  cellRequests = [];
  const taskId = name === 'restored' ? restoredTask! : `a3-${name}-${randomUUID()}`;
  const userMessageId = randomUUID(), assistantMessageId = randomUUID();
  const row: any = { name, taskId, userMessageId, assistantMessageId };
  evidence.cells.push(row); save();
  try {
    await config(name === 'explicit' ? modelB : name === 'suggestion' ? modelA : name === 'invalid-suggestion' ? 'openai-codex/nonexistent-a3' : undefined,
      ['explicit', 'suggestion'].includes(name) ? modelB : ['default', 'invalid-suggestion'].includes(name) ? modelA : undefined);
    if (name === 'restored') {
      const previous = db.getTask(taskId);
      row.restoredSessionFile = previous?.sessionFile;
      agent.dispose(); await agent.closeDurableBots();
      agent = new AgentService(db, new TaskExecutionWorkspace(join(root, 'workspaces')));
      await agent.init();
    } else db.upsertTask({ id: taskId, title: `A3 ${name}`, updatedAt: Date.now(), welcomeMode: 'working' });
    const errors: string[] = [];
    const off = agent.onPatch(p => { if (p.taskId === taskId && p.type === 'assistant_end' && p.error) errors.push(p.error); });
    const timer = setTimeout(() => { void agent.abort(taskId); }, 90000);
    try {
      row.result = await agent.prompt({ taskId, userMessageId, assistantMessageId, text: 'Reply with exactly A3_OK. Do not use any tools.', welcomeMode: 'working', ...(name === 'explicit' ? { modelId: modelA } : {}) });
    } finally { clearTimeout(timer); off(); }
    await Promise.all(bodies);
    row.requests = cellRequests;
    row.sessionDiagnostics = agent.inspectRuntimeContext(taskId).sessionDiagnostics;
    row.errorPatchCount = errors.length;
    const live = (agent as any).registry.get(taskId);
    row.reply = live?.session.getLastAssistantText();
    row.sessionFile = live?.session.sessionFile;
    row.restoreVerified = name !== 'restored' || row.sessionFile === row.restoredSessionFile;
    const expected = name === 'no-config' ? undefined : modelA;
    row.expected = expected ?? 'SDK selection from available openai-codex catalog';
    const diag = row.sessionDiagnostics;
    row.status = !row.result.error && !errors.length && diag?.model.provider === 'openai-codex'
      && row.restoreVerified && row.reply?.includes('A3_OK') && (!expected || diag.model.actualId === expected) && cellRequests.some(r => r.status === 200 && r.responseIds.length && r.model === diag.model.model) ? 'PASS' : 'FAIL';
    row.a2 = ['officecli', 'meeting-transcribe', 'dimagent-debug'].map(id => ({ id, dependency: probeSkillDependency(id, diag.cwd, diag.activeTools) }));
    if (name === 'explicit') restoredTask = taskId;
  } catch (error) { row.status = 'FAIL'; row.errorType = error instanceof Error ? error.name : 'unknown'; row.error = error instanceof Error ? error.message : 'unknown'; await Promise.all(bodies); row.requests = cellRequests; try { row.sessionDiagnostics = agent.inspectRuntimeContext(taskId).sessionDiagnostics; } catch {} }
  save();
  process.stdout.write(`${name}: ${row.status}\n`);
}
// A2 probes use the real host profile for ASR path resolution, and actual session tools above.
process.env.HOME = realProfile.slice(0, -'/.mybuddy'.length);
process.env.USERPROFILE = process.env.HOME;
evidence.a2Host = ['officecli', 'meeting-transcribe', 'dimagent-debug'].map(id => ({ id, dependency: probeSkillDependency(id, process.cwd(), evidence.cells[0]?.sessionDiagnostics?.activeTools ?? []) }));
const { SkillTrialLedger } = await import('../src/main/agent/SkillTrialLedger');
const skillPath = join(process.cwd(), 'scripts/skill-governance/payload/officecli/SKILL.md');
const ledger = new SkillTrialLedger(join(root, 'skill-trials'));
const trial = ledger.runOfficeVersion({ skillPath, cwd: process.cwd(), installed: true, policyAllowed: true, whitelisted: true });
evidence.a2Office = { scope: 'repository SKILL.md; explicit controlled admission, not live installed skill', trial, readback: new SkillTrialLedger(join(root, 'skill-trials')).latest('officecli', skillPath, process.cwd()) };
evidence.a2LocalCommand = { command: 'node --version', output: execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim(), scope: 'real safe CLI execution only; not skill-ledger success or UI trial' };
agent.dispose(); await agent.closeDurableBots(); db.close();
// No credential bytes in the emitted evidence (check against known auth string values without printing them).
const auth = JSON.parse(readFileSync(join(realProfile, 'auth.json'), 'utf8'));
const serialized = JSON.stringify(evidence);
function check(value: unknown): void {
  if (typeof value === 'string' && value.length > 40 && serialized.includes(value)) throw new Error('Secret detected in evidence');
  if (value && typeof value === 'object') Object.values(value).forEach(check);
}
check(auth); evidence.secretScan = 'PASS'; save(); chmodSync(output, 0o600);
process.stdout.write(`Evidence: ${output}\n`);
process.exit(0);
