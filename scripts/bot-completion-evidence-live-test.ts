/**
 * Real production BotWorkResultTurn reviews of explicitly synthetic candidate deliverables.
 * Production snapshot creation + Work registration + completionArtifactEvidence reading.
 * No claim of native business execution, Electron E2E, or coordinator delivery/closure.
 * All six task types run; failures are retained and never stop remaining cases.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { inspectDurableArtifact } from '../src/main/agent/durable/DurableArtifactRegistration';
import { BotWorkResultTurn, type WorkResultDecision } from '../src/main/agent/work/BotWorkResultTurn';
import { completionArtifactEvidence } from '../src/main/agent/work/WorkCompletionCoordinator';
import { workDeliveryFiles, workDeliveryResults } from '../src/main/agent/work/WorkDeliveryArtifacts';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkService, DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from '../src/shared/bot-work';

const home = process.env.BOT_COMPLETION_EVIDENCE_HOME!;
const out = process.env.BOT_COMPLETION_EVIDENCE_OUT!;
const repo = process.env.BOT_COMPLETION_EVIDENCE_REPO!;
assert(home && out && repo, 'Run through the .cjs isolation launcher');
assert.equal(resolve(homedir()), resolve(home));
assert(!resolve(home).startsWith(resolve(repo) + '/'), 'HOME must be outside the repository');
const retryArg = process.argv.find(arg => arg.startsWith('--retry-schema-from='));
const originalReportPath = retryArg?.slice('--retry-schema-from='.length);
const originalReport = originalReportPath ? JSON.parse(readFileSync(originalReportPath, 'utf8')) : undefined;
const live = process.argv.includes('--live') || Boolean(originalReport);
const retryCases = originalReport?.cases.filter((row: any) => row.error && /^SyntaxError:|^ZodError:/.test(row.error.stack ?? '')) ?? [];
if (originalReport) {
  assert.equal(originalReport.live, true); assert.equal(originalReport.modelCallCount, 12);
  assert.equal(originalReport.cases.length, 12); assert.equal(new Set(originalReport.cases.map((row: any) => row.type)).size, 6);
  assert.equal(originalReport.schemaRetryOf, undefined, 'No retries of retries');
  assert(retryCases.length > 0, 'Only first-pass schema errors may be retried');
  assert.equal(originalReport.source.unchanged, true);
}
const modelId = 'opendesign/deepseek-v4.1-flash';
const endpoint = 'http://127.0.0.1:3425/v1/chat/completions';
const modelKey = 'magpie/' + modelId;
const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const save = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2));
const unwrap = (result: WorkControlResult) => { assert(result.ok, JSON.stringify(result)); return result.work; };

type Scenario = { type: string; title: string; filename: string; request: string; negative: string; valid: string; defect: string; gapWords: RegExp };
const scenarios: Scenario[] = [
  { type: 'sales-csv', title: '销售CSV完整性', filename: 'sales.csv',
    request: '把这三个地区销售额整理为可直接使用的 sales.csv。字段必须为 region,amount，逐行包含 East=100、West=200、North=150，最后一行 TOTAL=450。不要只给标题或空文件。',
    negative: '', valid: 'region,amount\nEast,100\nWest,200\nNorth,150\nTOTAL,450\n',
    defect: '登记digest完全匹配，但文件为0字节；摘要仍声称全部完成。', gapWords: /空|0\s*字节|没有.*内容|缺|未.*(数据|内容)/ },
  { type: 'project-report', title: '项目报告章节', filename: 'project-report.md',
    request: '根据给定事实写一份可直接汇报的项目周报 project-report.md，不要模板。必须有进度、风险、下一步三个完整章节。事实：迁移完成8/10个接口；剩余2个接口依赖供应商证书；负责人李明须在11月15日前跟进证书，然后完成迁移。',
    negative: '# 项目周报\n## 进度\nTBD\n## 风险\n待填写\n## 下一步\nTODO\n',
    valid: '# 项目周报\n## 进度\n迁移已完成8/10个接口，完成率80%，剩余2个接口尚未迁移。\n## 风险\n剩余2个接口依赖供应商提供证书，证书交付时间是当前进度风险。\n## 下一步\n李明在11月15日前跟进供应商证书，取得证书后完成剩余2个接口的迁移。\n',
    defect: '正文含TBD、待填写、TODO，三段必需内容都是占位。', gapWords: /占位|模板|TBD|TODO|待填|未填/ },
  { type: 'test-evidence-report', title: '代码测试证据', filename: 'test-evidence.md',
    request: '将以下给定的测试记录整理成 test-evidence.md，不需要重新运行。报告必须列命令、退出码，以及正常值和边界值两条用例的输入、预期、实际。记录：命令 node --test clamp.test.mjs，exit=0；normal 输入(5,0,10)预期5实际5 PASS；lower-bound 输入(-3,0,10)预期0实际0 PASS；tests=2 pass=2 fail=0。',
    negative: '# 测试报告\n命令：node --test clamp.test.mjs\n退出码：0\nnormal 输入(5,0,10)，预期5，实际5，PASS。\n总计：tests=2 pass=2 fail=0。\n',
    valid: '# 测试报告\n根据给定记录整理，未重新运行测试。\n命令：node --test clamp.test.mjs\n退出码：0\nnormal：输入(5,0,10)，预期5，实际5，PASS。\nlower-bound：输入(-3,0,10)，预期0，实际0，PASS。\n汇总：tests=2 pass=2 fail=0。\n',
    defect: '正文缺少明确要求的边界用例输入、预期、实际；总计2通过不能替代明细。', gapWords: /边界|lower.bound/ },
  { type: 'translation', title: '翻译交付完整性', filename: 'translation.txt',
    request: '把下面三句英文完整译成中文，保存到 translation.txt，必须保留日期、金额和退款条件，不能漏句：The workshop starts on November 18. The registration fee is 120 dollars. A full refund is available if you cancel at least 48 hours before the workshop.',
    negative: '工作坊于11月18日开始。报名费为120美元。\n',
    valid: '工作坊于11月18日开始。报名费为120美元。如果至少提前48小时取消报名，可以获得全额退款。\n',
    defect: '译文漏掉整个退款条件句，日期与金额正确仍不能判全部完成。', gapWords: /退款|48|漏.*句|第三句/ },
  { type: 'operational-checklist', title: '操作清单回滚要求', filename: 'deployment-checklist.md',
    request: '用以下信息编写 deployment-checklist.md，必须包含发布前检查、发布后验证、失败回滚三部分，写成可执行清单。只编写文档，不进行发布。发布前检查备份 backup-2026-11-12.tar 存在并确认版本v2.4；发布后GET /health须返回200，核对版本v2.4；若失败回滚到v2.3，重启服务，再检查 /health=200。',
    negative: '# 发布操作清单\n## 发布前检查\n- 检查 backup-2026-11-12.tar 存在。\n- 确认版本v2.4。\n## 发布后验证\n- GET /health，确认返回200。\n- 核对服务版本为v2.4。\n',
    valid: '# 发布操作清单\n本文件仅是操作文档，未执行发布。\n## 发布前检查\n- 检查备份 backup-2026-11-12.tar 存在。\n- 确认待发布版本为v2.4。\n## 发布后验证\n- GET /health，确认状态码200。\n- 核对当前服务版本为v2.4。\n## 失败回滚\n- 若发布后验证失败，切回版本v2.3。\n- 重启服务。\n- 再次请求 /health，确认返回200。\n',
    defect: '正文完全缺失失败回滚部分，前后检查不能覆盖回滚要求。', gapWords: /回滚|v2\.3/ },
  { type: 'structured-json', title: '结构化数据结果', filename: 'orders.json',
    request: '把订单汇总为 orders.json：顶层必须有 currency="CNY"、orders数组和 grandTotal。orders必须逐条含 id、net，其中净额=amount-discount。输入：A amount=120 discount=20，B amount=80 discount=5，C amount=50 discount=0。必须保留三笔订单，grandTotal等于三笔净额之和。',
    negative: '{"currency":"CNY","orders":[{"id":"A","net":100},{"id":"B","net":75}],"grandTotal":175}\n',
    valid: '{"currency":"CNY","orders":[{"id":"A","net":100},{"id":"B","net":75},{"id":"C","net":50}],"grandTotal":225}\n',
    defect: '语法合法但少C订单及其50元，grandTotal175而非225。', gapWords: /订单\s*C|C.*订单|225|少.*C|漏.*C|缺.*C/ },
];
assert.equal(new Set(scenarios.map(item => item.type)).size, 6);
const sourceFiles = ['scripts/bot-completion-evidence-live-test.cjs', 'scripts/bot-completion-evidence-live-test.ts',
  'src/main/agent/work/BotWorkResultTurn.ts', 'src/main/agent/work/WorkCompletionCoordinator.ts',
  'src/main/agent/work/WorkGeneratedArtifacts.ts', 'src/main/agent/work/WorkDeliveryArtifacts.ts',
  'src/main/agent/durable/DurableArtifactRegistration.ts', 'src/main/agent/durable/DurableBotRuntime.ts'];
const fingerprint = () => Object.fromEntries(sourceFiles.map(name => [name, sha(readFileSync(join(repo, name)))]));
const compileProvenance = JSON.parse(readFileSync(join(out, 'compile-provenance.json'), 'utf8'));
const compiledFingerprint = () => Object.fromEntries(Object.keys(compileProvenance.compiledInputFiles).map(name => [name, sha(readFileSync(resolve(repo, name)))]));
assert.deepEqual(compiledFingerprint(), compileProvenance.compiledInputFiles, 'Compiled inputs changed before test startup');
const manifest = scenarios.flatMap(item => ['negative', 'valid'].map(variant => ({ type: item.type, title: item.title, variant,
  request: item.request, filename: item.filename, content: item[variant as 'negative' | 'valid'],
  contentSha256: sha(item[variant as 'negative' | 'valid']), expectedOutcomes: variant === 'valid' ? ['completed'] : ['partial', 'unknown'],
  defect: variant === 'negative' ? item.defect : null })));
save(join(out, 'manifest.json'), manifest);
const report: any = { startedAt: new Date().toISOString(), live, status: 'running', model: modelId, endpoint,
  source: { ...compileProvenance, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), files: fingerprint() },
  isolation: { home, repo, credentials: 'InMemoryCredentialStore, no profile read, no Authorization sent', businessToolsAllowed: false },
  method: '真实结果模型判定 + 真实artifact读取：inspectDurableArtifact -> WorkGeneratedArtifacts.record -> submitDeliverable -> completionArtifactEvidence -> BotWorkResultTurn.review -> real DurableBotRuntime/Pi model transport',
  limitations: 'Candidates, Work bindings and completion summaries are declared synthetic test inputs. No business native execution, no Electron UI, no coordinator closure, no DB-injected success, no PDF/PPT/OCR coverage. No tampering in semantic cases. Finite real-model samples are not a universal guarantee.',
  pricing: { monetaryCost: null, reason: 'No verified price supplied. Raw provider usage/cost and SDK usage retained; zero SDK catalog rates are not a claim of free inference.' },
  expectedReviewCount: 12, calls: [], cases: [] };
assert.equal(report.source.commit, compileProvenance.commit, 'Commit changed between compilation and test startup');
if (process.env.BOT_COMPLETION_EVIDENCE_EXPECT_COMMIT) assert.equal(report.source.commit, process.env.BOT_COMPLETION_EVIDENCE_EXPECT_COMMIT);
const persist = () => save(join(out, 'report.json'), report);
if (originalReport) {
  assert.equal(originalReport.model, modelId); assert.equal(originalReport.endpoint, endpoint);
  for (const name of sourceFiles.filter(name => name.startsWith('src/')))
    assert.equal(report.source.files[name], originalReport.source.files[name], 'Production source changed since original batch: ' + name);
  report.schemaRetryOf = originalReportPath; report.firstPass = { status: originalReport.status, passed: originalReport.cases.filter((row: any) => row.passed).length, total: 12 };
  report.expectedReviewCount = retryCases.length;
  report.limitations += ' This is at most one new review attempt per original schema failure after the complete six-type batch. The original report and failures are preserved; this does not run coordinator scheduling itself.';
  copyFileSync(join(originalReport.isolation.home, 'candidate-fixtures.db'), join(home, 'candidate-fixtures.db'));
}
persist();
const db = new AppDatabase(join(home, 'candidate-fixtures.db'));
const bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: 'Completion Evidence Fixture', authorization: DESKTOP_USER_GRANTS });
const works = new WorkService(db.connection, { bots });
const actor: WorkActor = { kind: 'user', userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
let activeCase: any;
let turn: BotWorkResultTurn | undefined;
const captures: Promise<unknown>[] = [];
const nativeFetch = globalThis.fetch;
// Audit actual HTTP request/response without modifying prompts or model output.
const auditedFetch: typeof fetch = async (input, init) => {
  assert(live && activeCase, 'No unscoped model calls');
  const request = new Request(input, init);
  assert.equal(request.url, endpoint, 'Only the authorized Magpie completion endpoint is allowed');
  const body = await request.clone().text();
  const payload = JSON.parse(body);
  assert.equal(payload.model, modelId, 'No fallback model');
  assert(report.calls.length < 24, 'Bounded total request budget, including any provider retry');
  const index = report.calls.length + 1;
  const call: any = { index, caseId: activeCase.id, startedAt: new Date().toISOString(), requestSha256: sha(body),
    inputEvidenceSha256: activeCase.evidenceSha256, model: payload.model, requestPath: join(out, `request-${index}.json`) };
  writeFileSync(call.requestPath, body);
  const headers = new Headers(request.headers);
  headers.delete('authorization'); // SDK sentinel only; the local gateway needs no key.
  call.authorizationSent = headers.has('authorization');
  report.calls.push(call); activeCase.httpCalls.push(index); persist();
  try {
    const response = await nativeFetch(new Request(request, { headers }));
    call.status = response.status;
    const capture = response.clone().text().then(raw => {
      const responsePath = join(out, `response-${index}.txt`);
      writeFileSync(responsePath, raw);
      call.responsePath = responsePath; call.responseSha256 = sha(raw); call.finishedAt = new Date().toISOString();
      const events: any[] = [];
      for (const line of raw.split('\n')) if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
        try { events.push(JSON.parse(line.slice(6))); } catch { /* Raw body remains authoritative. */ }
      }
      if (!events.length) { try { events.push(JSON.parse(raw)); } catch { /* Preserve non-JSON errors. */ } }
      call.rawUsage = events.filter(event => event.usage).map(event => ({ usage: event.usage, model: event.model, id: event.id }));
      call.providerReportedModels = [...new Set(events.map(event => event.model).filter(Boolean))];
      call.rawAssistantText = events.map(event => event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.message?.content ?? '').join('');
      persist();
    }).catch(error => { call.captureError = String(error); persist(); });
    captures.push(capture);
    return response;
  } catch (error) { call.transportError = String(error); persist(); throw error; }
};
try {
  if (live) {
    const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(home, 'models-catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
    models.registerProvider('magpie', { api: 'openai-completions', apiKey: 'not-a-secret-local-no-auth', baseUrl: endpoint.replace('/chat/completions', ''),
      models: [{ id: modelId, name: 'DeepSeek V4.1 Flash (exact route)', reasoning: false, input: ['text'],
        contextWindow: 131072, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const streamSimple = models.streamSimple.bind(models);
    models.streamSimple = (model, context, options) => {
      assert.equal(model.id, modelId); assert.equal(model.provider, 'magpie');
      const targetCase = activeCase;
      const stream = streamSimple(model, context, { ...options, fetch: auditedFetch, maxRetries: 0, timeoutMs: 55000 });
      captures.push(stream.result().then(message => {
        targetCase.sdkResponses.push(message); persist();
      }).catch(error => { targetCase.sdkError = String(error); persist(); }));
      return stream;
    };
    turn = new BotWorkResultTurn({ models, directory: join(home, 'reviews'), defaultModel: () => modelKey,
      botModel: () => modelKey, isAuthority: () => true });
  }
  if (!originalReport) for (const scenario of scenarios) for (const variant of ['negative', 'valid'] as const) {
    const id = `${scenario.type}-${variant}`;
    const row: any = { id, type: scenario.type, title: scenario.title, variant, expected: variant === 'valid' ? ['completed'] : ['partial', 'unknown'],
      startedAt: new Date().toISOString(), httpCalls: [], sdkResponses: [], assertions: [], passed: false };
    report.cases.push(row); activeCase = row; persist();
    try {
      const cwd = join(home, 'candidates', id); mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, scenario.filename), scenario[variant]);
      const inspected = await inspectDurableArtifact(cwd, scenario.filename, join(cwd, 'store'));
      assert(inspected.snapshotPath);
      const artifact = { path: inspected.path, snapshotPath: inspected.snapshotPath, digest: inspected.digest,
        sizeBytes: inspected.sizeBytes, registeredAt: Date.now(), sourceEntryId: 1 };
      const work = unwrap(works.createWork(actor, { operationId: `fixture-create:${id}`, title: scenario.title,
        goalDescription: scenario.request, inputSnapshotId: id, authorization: DESKTOP_USER_GRANTS, workspacePath: cwd }));
      const taskId = `fixture:${id}`;
      db.upsertTask({ id: taskId, title: scenario.title, updatedAt: Date.now() });
      unwrap(works.dispatchExecution(actor, { operationId: `fixture-bind:${id}`, workId: work.workId, botId: DEFAULT_BOT_ID,
        taskId, durableStoreKey: `fixture:${id}`, conversationId: id, workspaceBinding: cwd, delegatedScope: [] }));
      const binding = works.repo.listBindings(work.workId)[0]!;
      works.transaction(() => works.generatedArtifacts.record(binding, [artifact]));
      // Deliberately overconfident candidate summary; not a fabricated execution receipt.
      const summary = `已全部完成${scenario.title}，所有要求均已满足，成品内容完整无缺项，可直接使用，请按最终完成交付。`;
      unwrap(works.submitDeliverable({ kind: 'worker', botId: binding.botId, bindingId: binding.bindingId }, {
        operationId: `fixture-candidate:${id}`, workId: work.workId, bindingId: binding.bindingId, deliverableId: `candidate:${id}`,
        summary, artifactRefs: [artifact.snapshotPath], evidence: [], uncoveredScope: [] }));
      const evidence = completionArtifactEvidence(works, binding);
      const results = workDeliveryResults(works, binding);
      const availableFiles = workDeliveryFiles(works, results).filter(file => file.openPath).map(({ref, name}) => ({ref, name}));
      const bytes = readFileSync(artifact.snapshotPath);
      row.artifact = { ...artifact, actualDigest: sha(bytes), bytesBase64: bytes.toString('base64') };
      row.evidence = evidence; row.evidenceSha256 = sha(JSON.stringify(evidence));
      assert.equal(evidence.length, 1); assert.equal(evidence[0]!.registeredDigest, artifact.digest);
      assert.equal(sha(bytes), artifact.digest); assert.equal(evidence[0]!.text, scenario[variant]);
      assert.equal(evidence[0]!.state, scenario[variant].trim() ? 'text' : 'empty');
      assert.equal(evidence[0]!.truncated, false); assert.equal(evidence[0]!.trust, 'untrusted_artifact_content');
      row.assertions.push('Production registered immutable snapshot bytes/digest/content match the declared candidate');
      const context = { originalRequest: { userRequest: { messages: [{ text: scenario.request }] } }, title: scenario.title, goal: scenario.request,
        results: results.map(item => ({ summary: item.summary, artifactRefs: item.artifactRefs, uncoveredScope: item.uncoveredScope })),
        availableFiles, artifactEvidence: evidence, previousResults: [], criteria: [], continuationScope: [], teamContinuationTargets: [],
        pendingQuestions: [], actualMissing: [], unknownEffects: [],
        temporalContext: { reviewAt: new Date().toISOString(), observedAt: new Date().toISOString(),
          observedAtMeaning: 'host_received_candidate_fixture_not_business_execution', historicalRecovery: false, freshExecution: false },
        executionFacts: { status: 'candidate_fixture', outputReceived: true, diagnosticSummary: '候选文件已登记；此输入不证明任何业务执行成功。' } };
      const input = { eventId: `fixture-review:${id}`, botId: binding.botId, personalPreferences: '', context };
      row.reviewInputPath = join(out, `${id}-input.json`); save(row.reviewInputPath, input);
      row.reviewInputSha256 = sha(JSON.stringify(input)); persist();
      if (live) {
        const decision: WorkResultDecision = await turn!.review(input);
        row.decision = decision;
        const failures: string[] = [];
        if (!row.expected.includes(decision.outcome)) failures.push(`Expected ${row.expected.join('|')}, got ${decision.outcome}`);
        if (decision.decision !== 'deliver') failures.push(`No continuation scope/user-only information missing: expected deliver, got ${decision.decision}`);
        if (decision.missing.length) failures.push('Deliver-only review must not invent continuation work');
        if (variant === 'negative' && !scenario.gapWords.test(decision.reply)) failures.push('Reply does not explain the actual body defect');
        if (variant === 'valid' && !decision.artifactRefs?.includes(artifact.snapshotPath)) failures.push('Valid primary deliverable is not selected');
        if (decision.artifactRefs?.some(ref => !availableFiles.some(file => file.ref === ref))) failures.push('Reviewer invented an unregistered artifact ref');
        if (!row.httpCalls.length) failures.push('No real model HTTP call observed');
        row.failures = failures;
        row.passed = failures.length === 0;
      } else { row.passed = true; row.preparationOnly = true; }
    } catch (error) { row.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error); }
    row.finishedAt = new Date().toISOString(); persist();
    console.log(`${row.passed ? 'PASS' : 'FAIL'} ${id}: ${row.decision?.outcome ?? row.error?.message ?? 'registered evidence preparation only'}`);
  }
  if (originalReport) for (const original of retryCases) {
    const scenario = scenarios.find(item => item.type === original.type)!;
    const row: any = { id: original.id, type: original.type, title: original.title, variant: original.variant,
      expected: original.expected, startedAt: new Date().toISOString(), httpCalls: [], sdkResponses: [], assertions: [],
      passed: false, attempt: 2, firstAttempt: { error: original.error, httpCalls: original.httpCalls, report: originalReportPath } };
    report.cases.push(row); activeCase = row; persist();
    try {
      const input = JSON.parse(readFileSync(original.reviewInputPath, 'utf8'));
      assert.equal(sha(JSON.stringify(input)), original.reviewInputSha256, 'Original review input must be unchanged');
      const saved = db.connection.prepare('SELECT binding_id FROM work_generated_artifacts WHERE path=? AND digest=?')
        .get(original.artifact.path, original.artifact.digest) as { binding_id: string };
      assert(saved); const binding = works.repo.getBinding(saved.binding_id)!; assert(binding);
      const evidence = completionArtifactEvidence(works, binding);
      assert.equal(sha(JSON.stringify(evidence)), original.evidenceSha256, 'Reread real registered snapshot before retry');
      assert.deepEqual(evidence, input.context.artifactEvidence);
      assert.equal(sha(readFileSync(original.artifact.snapshotPath)), original.artifact.digest);
      row.artifact = original.artifact; row.evidence = evidence; row.evidenceSha256 = original.evidenceSha256;
      row.contextSha256 = sha(JSON.stringify(input.context));
      row.originalEventId = input.eventId; input.eventId += ':schema-attempt-2';
      row.retryEventId = input.eventId;
      row.reviewInputPath = join(out, `${row.id}-attempt-2-input.json`); save(row.reviewInputPath, input);
      row.reviewInputSha256 = sha(JSON.stringify(input));
      row.assertions.push('Production source, original context, persisted registration and reread immutable bytes unchanged; only review eventId changes');
      persist();
      row.decision = await turn!.review(input);
      const decision = row.decision as WorkResultDecision;
      const failures: string[] = [];
      if (!row.expected.includes(decision.outcome)) failures.push(`Expected ${row.expected.join('|')}, got ${decision.outcome}`);
      if (decision.decision !== 'deliver') failures.push(`Expected deliver, got ${decision.decision}`);
      if (decision.missing.length) failures.push('Deliver-only review must not invent continuation work');
      if (row.variant === 'negative' && !scenario.gapWords.test(decision.reply)) failures.push('Reply does not explain actual body defect');
      if (row.variant === 'valid' && !decision.artifactRefs?.includes(original.artifact.snapshotPath)) failures.push('Valid primary deliverable is not selected');
      if (decision.artifactRefs?.some(ref => !input.context.availableFiles.some((file: any) => file.ref === ref))) failures.push('Reviewer invented an unregistered artifact ref');
      if (row.httpCalls.length !== 1) failures.push('Schema follow-up must use exactly one real HTTP call');
      row.failures = failures; row.passed = failures.length === 0;
    } catch (error) { row.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error); }
    row.finishedAt = new Date().toISOString(); persist();
    console.log(`${row.passed ? 'PASS' : 'FAIL'} schema attempt 2 ${row.id}: ${row.decision?.outcome ?? row.error?.message}`);
  }

} catch (error) {
  report.fatalError = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
} finally {
  await turn?.close();
  await Promise.allSettled(captures);
  db.close();
  report.source.finishedFiles = fingerprint();
  report.source.finishedCompiledInputFiles = compiledFingerprint();
  report.source.finishedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  report.source.unchanged = JSON.stringify(report.source.files) === JSON.stringify(report.source.finishedFiles)
    && JSON.stringify(report.source.compiledInputFiles) === JSON.stringify(report.source.finishedCompiledInputFiles)
    && report.source.commit === report.source.finishedCommit;
  report.modelCallCount = report.calls.length;
  report.reviewAttemptCount = report.cases.filter((row: any) => row.httpCalls.length > 0).length;
  report.summary = scenarios.map(scenario => ({ type: scenario.type, results: report.cases.filter((row: any) => row.type === scenario.type).map((row: any) => ({ id: row.id, passed: row.passed, outcome: row.decision?.outcome, error: row.error?.message, failures: row.failures })) }));
  report.status = !report.fatalError && report.source.unchanged && report.cases.length === report.expectedReviewCount && report.cases.every((row: any) => row.passed)
    && (!live || report.reviewAttemptCount === report.expectedReviewCount) ? (live ? 'passed' : 'prepared-only') : 'failed';
  if (originalReport) report.afterSingleSchemaRetry = {
    originalFirstPassStillFailed: originalReport.status === 'failed',
    passedTargets: originalReport.cases.filter((item: any) => item.passed || report.cases.some((retry: any) => retry.id === item.id && retry.passed)).length,
    targetCount: 12, totalModelCallsIncludingOriginal: originalReport.modelCallCount + report.modelCallCount };
  report.finishedAt = new Date().toISOString(); persist();
  console.log(JSON.stringify({ status: report.status, modelCalls: report.modelCallCount, report: join(out, 'report.json'), home }, null, 2));
  if (report.status === 'failed') process.exitCode = 1;
}
