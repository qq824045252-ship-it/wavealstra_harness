const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** Actual React clicks + trusted preload/IPC. Any seeded presentation fact is labelled. */
module.exports = async ({ evaluate, rpc, until, isolatedSql, report, original, requests, socket, out }) => {
  const workId = original.workId;
  const work = () => evaluate(`window.api.botWork.getWork(${JSON.stringify(workId)})`);
  const taskCount = (await evaluate('window.api.db.listTasks()')).length;
  const providerCount = requests.length;
  const selectButton = (scope, text) => `[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(button => button.textContent.trim() === ${JSON.stringify(text)})`;
  const click = async (scope, text) => {
    const expression = selectButton(scope, text);
    await until(() => evaluate(`Boolean(${expression} && !${expression}.disabled)`), `enabled ${text}`);
    await evaluate(`${expression}.click()`);
  };
  const reviewScope = '[aria-label="成果评审与结束"]';
  const cardScope = '[aria-label="结果卡片与证据"]';
  const fill = async (label, value, tag = 'input') => {
    const selector = `[aria-label="${label}"]`;
    await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(${tag === 'textarea' ? 'HTMLTextAreaElement' : tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event(${JSON.stringify(tag === 'select' ? 'change' : 'input')}, { bubbles: true })); })()`);
    await until(() => evaluate(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(value)}`), `controlled ${label}`);
  };

  await click(reviewScope, '采纳成果');
  await until(async () => (await work()).deliverables.some(item => item.status === 'accepted'), 'UI acceptance persisted');
  let projection = await work();
  assert.equal(projection.criteria[0].status, 'pending', 'acceptance cannot invent user verification');
  const acceptedCard = projection.cards.find(card => card.kind === 'accepted_result');
  assert(acceptedCard);
  report.actualControlChecks.push('real native proposed result accepted through React review button and guarded IPC; one accepted card, criterion still pending');

  const beforeRead = { stateVersion: projection.stateVersion, intentRevision: projection.intentRevision, ownerEpoch: projection.ownerEpoch };
  await click(cardScope, '标记已读');
  await until(async () => (await work()).cards.find(card => card.cardKey === acceptedCard.cardKey)?.readVersion === 1, 'card read persisted');
  projection = await work();
  assert.deepEqual({ stateVersion: projection.stateVersion, intentRevision: projection.intentRevision, ownerEpoch: projection.ownerEpoch }, beforeRead);
  await evaluate(`document.querySelector(${JSON.stringify(cardScope + ' details summary')}).click()`);
  await click(cardScope, '读取诊断');
  await until(() => evaluate(`document.querySelector(${JSON.stringify(cardScope)}).innerText.includes('产物快照')`), 'expanded diagnostics rendered');
  report.actualControlChecks.push('real card read and diagnostics clicks; persistent readVersion=1 while all Work control versions stay unchanged');

  await until(async () => (await work()).notifications.some(item => item.kind === 'result' && item.delivery === 'sent'), 'desktop channel receipt');
  projection = await work();
  const notification = projection.notifications.find(item => item.kind === 'result');
  // A controlled response-loss fixture changes only the test delivery outcome. The card,
  // accepted result, physical send and immutable original effect are all real production facts.
  isolatedSql({ statements: [
    { sql: "UPDATE work_notification_attempts SET status='unknown',settled_at=NULL WHERE notification_id=?", params: [notification.notificationId] },
    { sql: "UPDATE work_notifications SET delivery='unknown',sent_at=NULL WHERE notification_id=?", params: [notification.notificationId] },
  ] });
  report.seededPresentationFacts.push('original desktop response outcome changed to unknown in isolated SQLite to exercise risk-confirmed resend; no real provider outage claimed');
  const dialog = async event => {
    const value = JSON.parse(event.data);
    if (value.method === 'Page.javascriptDialogOpening') {
      assert.equal(value.params.type, 'prompt');
      assert.match(value.params.message, /可能已经送达|重复/);
      await rpc('Page.handleJavaScriptDialog', { accept: true, promptText: 'Isolated UI test confirms duplicate risk' });
    }
  };
  socket.addEventListener('message', dialog);
  try { await click(cardScope, '确认风险后重发'); }
  finally { socket.removeEventListener('message', dialog); }
  await until(async () => (await work()).notifications.some(item => item.notificationId === notification.notificationId
    && item.delivery === 'sent' && item.attemptCount === notification.attemptCount + 1), 'manual resend receipt');
  const manual = isolatedSql({ statements: [], query: {
    sql: "SELECT effect_key FROM work_notification_effects WHERE notification_id=? AND authorization_kind='manual-resend'",
    params: [notification.notificationId],
  } });
  assert.equal(manual.length, 1);
  report.actualControlChecks.push('actual risk prompt and resend button create one attributable manual effect and one new attempt; original unknown remains in history');

  // Feedback is an explicitly labelled fixture observation; it proves UI/version binding,
  // never Windows/Omarchy/phone hardware validation.
  await evaluate(`document.querySelector(${JSON.stringify(reviewScope)}).querySelector('details summary').click()`);
  await fill('实测环境', 'Isolated UI fixture');
  await fill('实测版本或记录', 'fixture:phase5-ui-current-result');
  await fill('实测说明', 'Verifies the local test fixture only; not a physical-device acceptance.', 'textarea');
  await click(reviewScope, '记录实测通过');
  await until(async () => (await work()).criteria[0].status === 'satisfied', 'versioned feedback persisted');
  report.actualControlChecks.push('user feedback typed and submitted through actual form; current input/artifact and all three control versions reach existing host guard');

  // Request the all scope before closure so the final result remains selected and visible.
  await click('body', '查看已结束事项');
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(reviewScope)}))`), 'review remains selected');
  await evaluate(`(() => { const section = document.querySelector(${JSON.stringify(reviewScope)});
    [...section.querySelectorAll('summary')].find(item => item.textContent === '结束事项').click(); })()`);
  await fill('事项结束依据', 'Current isolated fixture was checked; no remaining effects.', 'textarea');
  assert(await evaluate(`${selectButton(reviewScope, '确认结束事项')}.disabled`));
  await evaluate('document.querySelector(\'[aria-label="确认事项结束"]\').click()');
  await click(reviewScope, '确认结束事项');
  await until(async () => (await work()).lifecycle === 'closed', 'trusted close persisted');
  projection = await work();
  assert.equal(projection.closureConclusion, 'succeeded');
  assert.equal(projection.cards.filter(card => card.kind === 'accepted_result').length, 1);
  assert.equal(projection.cards.find(card => card.kind === 'accepted_result').cardKey, acceptedCard.cardKey);
  await until(() => evaluate(`document.querySelector(${JSON.stringify(cardScope)})?.innerText.includes('已完成并关闭')`), 'accepted card successful-closure badge');
  assert.equal((await evaluate('window.api.db.listTasks()')).length, taskCount);
  assert.equal(requests.length, providerCount, 'review/read/resend/close never rerun native work');
  report.actualControlChecks.push('explicit successful-close confirmation reaches original control; accepted card identity is reused and no native task/model request is repeated');

  const botId = 'bot-mybuddy-default';
  const versions = await evaluate(`window.api.botWork.listBotExpertVersions(${JSON.stringify(botId)})`);
  const active = versions.find(version => version.state === 'active');
  assert(active?.configuration, 'real default Bot has its immutable expert configuration');
  const nextVersion = Math.max(...versions.map(version => version.version)) + 1;
  const stage = version => {
    const configuration = { ...active.configuration, name: `UI review fixture v${version}`,
      instructions: `UI review fixture instructions v${version}` };
    isolatedSql({ statements: [
      { sql: "UPDATE bot_expert_versions SET state='superseded' WHERE bot_id=? AND state='pending'", params: [botId] },
      { sql: "INSERT INTO bot_expert_versions(bot_id,version,state,expert_id,source_revision,system_prompt_hash,configuration_json,skill_packages_json,allowed_mcp_ids_json,allowed_skill_ids_json,allowed_connector_ids_json,staged_by,created_at) VALUES (?,?,'pending',?,?,?,?,'[]','[]','[]','[]','phase5-ui-fixture',?)",
        params: [botId, version, active.expertId, `fixture:v${version}`, `fixture-hash-${version}`,
          JSON.stringify(configuration), Date.now()] },
    ] });
  };
  stage(nextVersion);
  report.seededPresentationFacts.push('pending expert snapshots staged in the isolated database for explicit review/race testing; external expert installation is not claimed');
  await click('body', '返回普通模式');
  await evaluate('document.querySelector(".sidebar-user-main").click()');
  await click('body', 'Bot 模式');
  await until(() => evaluate(`document.querySelector('[aria-label="待审阅专家配置"]')?.innerText.includes(${JSON.stringify(`v${nextVersion}`)})`), 'pending expert review loaded');
  await evaluate(`[...document.querySelectorAll('summary')].find(item => item.textContent === '专家配置审阅').click()`);
  await evaluate(`document.querySelector('[aria-label="待审阅专家配置"] details summary').click()`);
  assert(await evaluate(`document.querySelector('.bot-expert-prompt').innerText.includes(${JSON.stringify(`instructions v${nextVersion}`)})`));
  // A newer immutable version arrives after the displayed review. The old UI click
  // must refuse adoption before the refreshed new version can be explicitly selected.
  stage(nextVersion + 1);
  await click('.bot-expert-review', `采用 v${nextVersion}`);
  await until(() => evaluate(`/已不再是待采纳版本|拒绝把旧提示词/.test(document.querySelector('.bot-expert-review [role="status"]')?.innerText ?? '')`), 'stale expert confirmation visibly refused');
  const afterStale = await evaluate(`window.api.botWork.listBotExpertVersions(${JSON.stringify(botId)})`);
  assert.equal(afterStale.find(version => version.state === 'active').version, active.version);
  await click('.bot-expert-review', `采用 v${nextVersion + 1}`);
  await until(async () => (await evaluate(`window.api.botWork.listBotExpertVersions(${JSON.stringify(botId)})`))
    .some(version => version.state === 'active' && version.version === nextVersion + 1), 'reviewed expert version adopted');
  report.actualControlChecks.push('full expert configuration opened; stale pendingVersion/snapshotId click visibly refused; refreshed reviewed version adopted through real React/preload/IPC');
  const screenshot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, 'phase5-page.png'), Buffer.from(screenshot.data, 'base64'));
};
