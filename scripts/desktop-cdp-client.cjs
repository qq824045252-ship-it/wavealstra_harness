/**
 * 桌面端 CDP 辅助：连接 MyBuddy 渲染进程，按文本打开任务并导出当前对话状态。
 * 仅用于本地验收排查（需要 App 以 --remote-debugging-port 启动）。
 */
async function connect(options = {}) {
  const port = Number(options.port || process.env.MYBUDDY_DESKTOP_CDP_PORT || 9223);
  const timeoutMs = options.timeoutMs || 20000;
  const connectTimeoutMs = options.connectTimeoutMs || timeoutMs;
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(connectTimeoutMs) }).then((r) => r.json());
  const matches = options.target || ((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('file://'));
  const page = targets.find(matches);
  if (!page) throw new Error('没找到 MyBuddy 渲染进程 target: ' + JSON.stringify(targets.map((t) => t.url)));
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('CDP connection timeout')); }, connectTimeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('CDP connection failed')); }, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(event.data);
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    clearTimeout(entry.timer);
    value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('CDP connection closed')); }
    pending.clear();
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(Error('CDP unavailable: ' + method)); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try { await rpc('Runtime.enable'); }
  catch (error) { socket.close(); throw error; }
  const evaluate = async (expression) => {
    const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  return { evaluate, rpc, target: page, close: () => socket.close() };
}

module.exports = { connect };
