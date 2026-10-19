/**
 * 桌面端 CDP 辅助：连接 MyBuddy 渲染进程，按文本打开任务并导出当前对话状态。
 * 仅用于本地验收排查（需要 App 以 --remote-debugging-port 启动）。
 */
const port = Number(process.env.MYBUDDY_DESKTOP_CDP_PORT || 9223);

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('file://'));
  if (!page) throw new Error('没找到 MyBuddy 渲染进程 target: ' + JSON.stringify(targets.map((t) => t.url)));
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(event.data);
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await rpc('Runtime.enable');
  const evaluate = async (expression) => {
    const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  return { evaluate, close: () => socket.close() };
}

module.exports = { connect };
