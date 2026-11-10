/** Ordinary read-only inference regression. No app/profile writes or business tools.
 * node scripts/bot-historical-review-live-test.cjs
 * Requires the local configured OpenAI-compatible gateway; never reads credentials.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../src/main/agent/work/BotWorkResultTurn.ts'), 'utf8');
const instructions = source.match(/instructions: \(\) => `([\s\S]*?)` \}\);/)?.[1];
assert(instructions && !instructions.includes('${'), 'use the exact current static product review instructions');
const temporalContext = {reviewAt:'2026-11-10T14:00:00Z',observedAt:'2026-11-09T09:00:00Z',
  observedAtMeaning:'host_received_execution_receipt_not_source_measurement_time',historicalRecovery:true,freshExecution:false};
const cases = [
  {name:'expected-denial', request:'拒绝路径小测试：拒绝创建 deny.txt，验证文件没有生成，报告结果。',
    result:'用户拒绝 write；工具没有执行。只读检查工作目录，deny.txt 不存在。拒绝路径验证完成。', outcome:'completed'},
  {name:'real-write-failure',request:'创建 deny.txt，内容 hello，并读取校验。',
    result:'用户拒绝 write；工具没有执行，deny.txt 不存在。未创建文件。',outcome:'partial'},
  {name:'missing-negative-evidence',request:'拒绝创建 deny.txt，检查磁盘确认文件不存在并报告。',
    result:'用户拒绝 write。磁盘检查失败，未确认文件是否存在。',outcome:['partial','unknown']},
  {name:'historical-weather',request:'查询2026年11月9日杭州天气并给出穿衣建议。',
    result:'2026-11-09 实时来源已核实：杭州18°C，小雨，建议薄外套带伞。',outcome:'completed',historical:true},
  {name:'historical-error',request:'创建 report.txt 并读回。',
    result:'2026-11-09 执行失败，当时工具层报告共享资源隔离，未写入文件。',outcome:'partial',historical:true},
  {name:'mixed-test-missing-delivery',request:'验证拒绝 deny.txt 的路径，然后创建 ok.txt 并读回。',
    result:'拒绝路径已验证，deny.txt 不存在。ok.txt 未创建，工具写入失败。',outcome:'partial'},
];
(async()=>{
  for (const item of cases) {
    const response=await fetch((process.env.BOT_FRONTDOOR_BASE_URL||'http://127.0.0.1:3425/v1')+'/chat/completions',{
      method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(90000),
      body:JSON.stringify({model:process.env.BOT_FRONTDOOR_MODEL||'opendesign/deepseek-v4.1-flash',stream:false,
        messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify({temporalContext,
          originalRequest:{userRequest:{messages:[{text:item.request}]}},goal:item.request,
          results:[{summary:item.result,artifactRefs:[],uncoveredScope:[]}],executionFacts:{status:'completed',outputReceived:true},
          pendingQuestions:[],unknownEffects:[],continuationScope:[],criteria:[]})}]})});
    assert(response.ok,`gateway ${response.status}`);
    const body=await response.json(); const text=body.choices?.[0]?.message?.content;
    const decision=JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1'));
    assert([item.outcome].flat().includes(decision.outcome),`${item.name}: ${text}`);
    assert.equal(decision.decision,'deliver',`${item.name}: must not resubmit historical business work or ask for approval`);
    assert(!/需要.{0,12}授权|先解决.{0,12}授权|需要.{0,12}允许/.test(decision.reply),`${item.name}: stale permission advice: ${text}`);
    assert(/历史|当时|11[月/-]0?9|此前/.test(decision.reply),`${item.name}: date/history absent: ${text}`);
    console.log(JSON.stringify({case:item.name,decision},null,2));
  }
  console.log('PASS 6 historical/test-goal real-model reviews; no business work executed');
})().catch(error=>{console.error(error);process.exitCode=1;});
