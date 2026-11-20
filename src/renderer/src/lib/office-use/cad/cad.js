const frame = document.querySelector('#drawing');
const status = document.querySelector('#status');
const api = () => frame.contentWindow.cadcraft;
let attached = false;
let dirty = false;
let saving;
let drafting;
let config;
let statusTimer;

function report(message, failed = false, duration = 0) {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.hidden = !message;
  status.toggleAttribute('data-error', failed);
  if (duration) statusTimer = setTimeout(() => report(''), duration);
}

async function call(action, options) {
  const response = await fetch(action, options);
  if (!response.ok) throw new Error(await response.text() || '图纸请求失败');
  return response;
}

function post(action, body) {
  return call(action, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
}

async function snapshot() {
  const result = await api().execute('document.bytes', { format: 'dxf', version: '2018' });
  return Uint8Array.fromBase64(result.data);
}

async function openDrawing() {
  const bytes = await (await call('source')).arrayBuffer();
  frame.contentWindow.postMessage({ type: 'cadcraft:open', name: config.name, bytes }, location.origin, [bytes]);
  for (let attempt = 0; attempt < 20; attempt++) {
    const document = await api().docInspect().catch(error => {
      if (!error.message.includes('no drawing open')) throw error;
      return null;
    });
    if (document) {
      await api().execute('zoom', { mode: 'extents' }).catch(() => {});
      attached = true;
      report(config.recovered ? '已恢复编辑草稿' : '', false, 3000);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('CADCraft 无法打开此图纸');
}

function flushDraft() {
  if (saving) return saving;
  if (!attached || !dirty) return Promise.resolve();
  if (!drafting) {
    drafting = snapshot().then(bytes => post('draft', bytes)).finally(() => { drafting = undefined; });
  }
  return drafting;
}

function save(bytes) {
  if (!attached || saving) return;
  report('正在准备副本…');
  const previousDraft = drafting;
  saving = (async () => {
    await previousDraft?.catch(() => {});
    await post('draft', bytes);
    const result = await (await post('save', bytes)).json();
    report(result.path ? [`已保存 ${result.path}`, result.warning].filter(Boolean).join(' · ') : '已取消保存', false, result.warning ? 9000 : 3000);
  })().catch(error => report(error.message, true)).finally(() => {
    saving = undefined;
  });
}

window.flushCadDraft = flushDraft;

try {
  config = await (await call('config')).json();
  let startup;
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.type === 'cadcraft:ready') {
      void openDrawing().catch(error => report(error.message, true)).finally(() => clearTimeout(startup));
    } else if (message?.type === 'cadcraft:dirty') {
      dirty = message.dirty === true;
    } else if (message?.type === 'cadcraft:save' && /\.dxf$/i.test(message.name) && message.bytes instanceof ArrayBuffer) {
      save(message.bytes);
    } else if (message?.type === 'cadcraft:failed') {
      clearTimeout(startup);
      report(message.error || 'CADCraft 初始化失败', true);
    }
  });
  const layout = new ResizeObserver(() => {
    if (frame.clientWidth < 2 || frame.clientHeight < 2) return;
    layout.disconnect();
    startup = setTimeout(() => {
      if (!attached) report('CADCraft 加载超时，请关闭图纸后重新打开。', true);
    }, 30_000);
    frame.src = '/cadcraft/index.html?host=parent&webgl';
  });
  layout.observe(frame);
  setInterval(() => { void flushDraft().catch(error => report(`图纸草稿保存失败。${error.message}`, true)); }, 12_000);
} catch (error) {
  report(error.message, true);
}
