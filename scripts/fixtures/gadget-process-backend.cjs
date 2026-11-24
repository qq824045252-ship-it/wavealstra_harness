const readline = require('node:readline');
const { spawn } = require('node:child_process');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const lines = readline.createInterface({ input: process.stdin });
const pending = new Map();
let requestId = 0;
let count = 0;

function host(call, scope, operation, fields) {
  return new Promise(resolve => {
    const id = ++requestId;
    pending.set(id, resolve);
    send({ type: 'host', id, call, scope, operation, ...fields });
  });
}
const result = (id, value) => send({ type: 'result', id, value });
lines.on('line', async raw => {
  const message = JSON.parse(raw);
  const { id, type, action, input } = message;
  if (type === 'shutdown') {
    lines.close();
    process.exit(0);
  }
  if (type === 'hostResult') {
    const settle = pending.get(id);
    pending.delete(id);
    settle?.(message);
    return;
  }
  if (type === 'cancel' && id === cancellableCall) {
    const response = await host(id, 'storage', 'set', { key: 'late', value: 'bad' });
    cancellationReply = response.error;
    result(id, null);
    return;
  }
  if (type !== 'call') return;
  switch (action) {
    case 'echo':
      result(id, { input, count: ++count, pid: process.pid, arg: process.argv[2],
        marker: process.env.MYBUDDY_TEST_GADGET_MARKER, privateMarker: process.env.MYBUDDY_TEST_GADGET_UNDECLARED ?? null });
      break;
    case 'store': {
      const stored = await host(id, 'storage', 'set', { key: 'external', value: input });
      const theme = await host(id, 'config', 'get', { key: 'theme' });
      result(id, { value: stored.value.value, theme: theme.value });
      break;
    }
    case 'cancellable':
      cancellableCall = id;
      await host(id, 'storage', 'set', { key: 'external-started', value: true });
      break;
    case 'cancelStatus': result(id, cancellationReply); break;
    case 'descendant': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => result(id, child.pid));
      child.once('error', () => send({ type: 'error', id }));
      break;
    }
    case 'hang': break;
    case 'crash': process.exit(17); break;
  }
});
let cancellableCall;
let cancellationReply = null;
send({ type: 'ready', version: 1, actions: ['echo', 'store', 'cancellable', 'cancelStatus', 'descendant', 'hang', 'crash'] });
