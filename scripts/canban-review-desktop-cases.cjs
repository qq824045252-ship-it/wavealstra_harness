const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function verifyRustWorker(rpc) {
  await rpc('Target.setAutoAttach', {autoAttach:true, waitForDebuggerOnStart:false, flatten:true, filter:[{type:'worker'}]});
  const { targetInfos } = await rpc('Target.getTargets');
  const worker = targetInfos.find(target => target.type === 'worker' && target.url.includes('canban-review'));
  assert.ok(worker, 'the displayed diff starts the Canban review worker. Debug targets '+JSON.stringify(targetInfos.map(({type,url})=>[type,url])));
  const { sessionId } = await rpc('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  try {
    const prototype = await rpc('Runtime.evaluate', { expression: 'WebAssembly.Instance.prototype' }, sessionId);
    const instances = await rpc('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId }, sessionId);
    const result = await rpc('Runtime.callFunctionOn', {
      objectId: instances.objects.objectId,
      functionDeclaration: 'function () { return Array.from(this, instance => Object.keys(instance.exports)); }',
      returnByValue: true,
    }, sessionId);
    const exports = result.result.value?.find(names => names.includes('run_request') && names.includes('context_step'));
    assert.ok(exports, 'the worker that rendered the desktop diff holds the compiled upstream Rust module');
    return exports;
  } finally {
    await rpc('Target.detachFromTarget', { sessionId });
    await rpc('Target.setAutoAttach', {autoAttach:false, waitForDebuggerOnStart:false, flatten:true});
  }
}

// This directory belongs to the disposable Electron profile. Git runs only in this fixture.
function initializeGitFixture(workspace) {
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Review fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', ...args,
  ], {cwd:workspace, encoding:'utf8', windowsHide:true});
  const write = (name, content) => fs.writeFileSync(path.join(workspace, name), content);
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(workspace,'src'));
  write('.gitignore', '/*\n!/src/\n!/.gitignore\n');
  write('src/account.ts', 'export const baseAmount = 20;\n');
  write('src/分层.ts', 'export const region = "original";\n');
  git('add', '--', '.gitignore', 'src');
  git('commit', '-qm', 'original amount');
  git('tag', 'review-base');
  write('src/account.ts', 'export const baseAmount = 24;\n');
  git('add', '--', 'src/account.ts');
  git('commit', '-qm', 'update amount');
  write('src/分层.ts', 'export const region = "staged";\n');
  git('add', '--', 'src/分层.ts');
  write('src/分层.ts', 'export const region = "original";\n');
  write('src/untracked.ts', 'export const pending = true;\n');
  return () => ({
    head:git('rev-parse','HEAD').trim(), index:git('show',':src/分层.ts'),
    disk:fs.readFileSync(path.join(workspace,'src','分层.ts'),'utf8'),
    untracked:fs.readFileSync(path.join(workspace,'src','untracked.ts'),'utf8'),
    status:git('status','--porcelain=v1','-z','--untracked-files=all'),
  });
}

async function verifyGitWorkbench({evaluate, until, rpc, query, clickNode, out, workspace}) {
  async function select(label, value) {
    const selector='select[aria-label="'+label+'"]';
    await until(()=>evaluate(`[...document.querySelectorAll(${JSON.stringify(selector+' option')})].some(option=>!option.disabled && option.value===${JSON.stringify(value)})`),label+' '+value);
    await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  const row = section => '.code-review-file[data-review-path="src/分层.ts"][data-review-section="'+section+'"]';
  const lines = (name,section,kind) => {
    const selector='[data-review-file="'+name+'"][data-review-section="'+section+'"] .code-review-line.'+kind+' code';
    return evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(el=>el.textContent)`);
  };
  await select('审查来源','uncommitted');
  await clickNode(query(row('staged')),'查看暂存版本');
  await until(async ()=>(await lines('src/分层.ts','staged','is-added')).includes('export const region = "staged";'),'index diff');
  await clickNode(query(row('unstaged')),'查看工作区版本');
  await until(async ()=>(await lines('src/分层.ts','unstaged','is-added')).includes('export const region = "original";'),'working tree diff');
  await clickNode(query('.code-review-file[data-review-path="src/untracked.ts"]'),'查看未跟踪文件');
  const untrackedLines=()=>lines('src/untracked.ts','unstaged','is-added');
  await until(async ()=>(await untrackedLines()).includes('export const pending = true;'),'untracked file diff');
  assert.equal(await evaluate(`[...document.querySelectorAll('.code-review button[aria-label]')].some(el=>!el.disabled && /^(全部拒绝$|拒绝 )/.test(el.getAttribute('aria-label')))`),false,'raw Git changes are read-only');
  const shot=await rpc('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,'git-review.png'),Buffer.from(shot.data,'base64'));
  const untrackedFile=path.join(workspace,'src','untracked.ts');
  const previous=fs.readFileSync(untrackedFile);
  try {
    fs.writeFileSync(untrackedFile,'export const pending = null;\n');
    await clickNode(query('button[aria-label="刷新代码审查"]'),'刷新同一文件');
    await until(async ()=>(await untrackedLines()).includes('export const pending = null;'),'refresh updates file content with the same size and line counts');
  } finally {
    fs.writeFileSync(untrackedFile,previous);
  }
  await select('审查来源','compare');
  await select('比较基准','review-base');
  await select('比较目标','main');
  await clickNode(query('.code-review-file[data-review-path="src/account.ts"]'),'查看提交间改动');
  await until(async ()=>(await lines('src/account.ts','compare','is-added')).includes('export const baseAmount = 24;'),'ref comparison');
  assert.ok((await lines('src/account.ts','compare','is-deleted')).includes('export const baseAmount = 20;'),'the base revision supplies the removed line');
}

module.exports = { verifyRustWorker, initializeGitFixture, verifyGitWorkbench };
