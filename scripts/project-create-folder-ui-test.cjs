const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const output = join(__dirname, '../out/tests');
app.setPath('userData', join(output, 'project-create-folder-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 820, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const evaluate = async (code) => { try { return await win.webContents.executeJavaScript(code); } catch (error) { console.error('[project-create-folder-ui] evaluate failed:', code); throw error; } };
  const wait = async (code) => { const deadline = Date.now() + 6000; while (!(await evaluate(code))) { if (Date.now() > deadline) throw new Error(`UI wait timed out: ${code}`); await new Promise((accept) => setTimeout(accept, 50)); } };
  const click = async (label) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} && b.getClientRects().length);if(!b||b.disabled)throw Error('button unavailable: '+${JSON.stringify(label)});b.click()})()`);
  const setName = async (value) => evaluate(`(()=>{const input=document.querySelector('input[placeholder="请输入项目名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  try {
    mkdirSync(output, { recursive: true });
    const html = join(output, 'project-create-folder-ui.html');
    writeFileSync(html, '<!doctype html><html lang="zh"><meta charset="UTF-8"><link rel="stylesheet" href="project-create-folder-ui.css"><div id="root"></div><script src="project-create-folder-ui.js"></script></html>');
    await win.loadFile(html);
    await wait(`document.body.innerText.includes('新建项目')`);
    assert.equal(await evaluate(`document.querySelector('input[aria-label="项目工作目录"]').value`), '');
    await setName('目录项目');
    await click('选择文件夹');
    await wait(`document.querySelector('input[aria-label="项目工作目录"]').value==='C:/projects/new-project'`);
    await click('创建项目');
    await wait(`window.projectCreateFolderTest.saved.length===1`);
    assert.equal(await evaluate(`window.projectCreateFolderTest.saved[0].project.defaultSpaceId`), 'project-space');
    assert.equal(await evaluate(`window.projectCreateFolderTest.state.homeSpaceId`), 'home-original', '项目目录不能污染全局 homeSpaceId');
    assert.deepEqual(await evaluate(`window.projectCreateFolderTest.calls.find(c=>c[0]==='ensureSpaceFromPath')[4]`), { activate: false });
    assert.equal(await evaluate(`window.projectCreateFolderTest.apiCalls.filter(c=>c[0]==='createProject').length`), 1);
    assert.equal(await evaluate(`window.projectCreateFolderTest.apiCalls.filter(c=>c[0]==='updateProject').length`), 1);

    await evaluate(`document.querySelector('#reopen').click()`);
    await wait(`document.body.innerText.includes('新建项目') && document.querySelector('input[aria-label="项目工作目录"]').value===''`);
    await setName('失败项目');
    await click('选择文件夹');
    await evaluate(`window.projectCreateFolderTest.failNextBinding()`);
    await click('创建项目');
    await wait(`window.projectCreateFolderTest.saved.length===2`);
    assert((await evaluate(`window.projectCreateFolderTest.saved[1].notice`)).includes('项目已创建，但工作目录未绑定'));
    assert.equal(await evaluate(`window.projectCreateFolderTest.calls.filter(c=>c[0]==='deleteSpace').length`), 1, '新建目录绑定失败必须补偿删除');
    assert.equal(await evaluate(`window.projectCreateFolderTest.state.homeSpaceId`), 'home-original');
    assert.equal(await evaluate(`window.projectCreateFolderTest.apiCalls.filter(c=>c[0]==='createProject').length`), 2, '绑定失败不得让用户二次创建同名项目');
    console.log('project create folder Electron UI: PASS');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
}).catch((error) => { console.error(error); app.exit(1); });