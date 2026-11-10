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
  // Manual result acceptance/attestation/closure forms were deliberately removed.
  // Native/real-model completion and continuation are exercised by
  // bot-work-automatic-completion-test and bot-goal-outcome-live-test.
  assert(!await evaluate("[...document.querySelectorAll('.bot-work-details button')].some(b=>/采纳成果|拒绝成果|确认结束事项/.test(b.textContent))"));
  assert.equal((await evaluate('window.api.db.listTasks()')).length, taskCount);
  assert.equal(requests.length, providerCount);
  report.actualControlChecks.push('result details expose no manual acceptance or closure ceremony; inspection does not rerun native work');

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
