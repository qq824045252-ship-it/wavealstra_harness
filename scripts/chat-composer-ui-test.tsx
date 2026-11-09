/** Mounted shared editor behavior. Layout/real IME acceptance is tested separately on desktop. */
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { act, createRef } from 'react';
import ChatComposer from '../src/renderer/src/components/chat/ChatComposer';

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(document, 'oninput', { configurable: true, value: null });
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'defaultValue', {
  configurable: true, get() { return this.textContent ?? ''; }, set(value: string) { this.textContent = value; },
});
async function main() {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const ref = createRef<HTMLTextAreaElement>();
  const keys: string[] = [];
  const changed: string[] = [];
  let clicked = 0;
  let pasted = 0;
  const draw = (value: string, maxHeight = 180) => act(() => root.render(<ChatComposer ref={ref}
    value={value} maxHeight={maxHeight} maxLength={32000} rows={2}
    onChange={event => changed.push(event.target.value)}
    onPaste={() => pasted++}
    onKeyDown={event => keys.push(event.shiftKey ? 'shift-' + event.key : event.key)}
    toolbar={<button onClick={() => clicked++}>Send</button>} />));
  await draw('first');
  const textarea = ref.current!;
  assert.equal(textarea.tagName, 'TEXTAREA');
  assert.equal(textarea.value, 'first');
  assert.equal(textarea.className, 'input-textarea');
  assert.equal(textarea.getAttribute('aria-label'), '输入消息');
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 260 });
  await draw('second');
  assert.equal(textarea.style.height, '180px');
  await draw('home', 220);
  assert.equal(textarea.style.height, '220px');
  const key = async (extra: Record<string, unknown>) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key: 'Enter', keyCode: 13, ...extra });
    await act(() => textarea.dispatchEvent(event));
  };
  await key({ isComposing: true });
  await key({ keyCode: 229 });
  assert.deepEqual(keys, [], 'IME Enter must not reach submit handler');
  // React's fallback IME path treats 229 as composition-start and Enter keyup as end.
  const end = new window.Event('keyup', { bubbles: true });
  Object.assign(end, { key: 'Enter', keyCode: 13 });
  await act(() => textarea.dispatchEvent(end));
  await key({});
  await key({ shiftKey: true });
  assert.deepEqual(keys, ['Enter', 'shift-Enter'], 'adapter retains normal Enter and Shift+Enter behavior');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(() => { setter.call(textarea, 'edited'); textarea.dispatchEvent(new window.Event('input', { bubbles: true })); });
  assert.deepEqual(changed, ['edited'], 'real input events reach controlled draft adapter');
  await act(() => textarea.dispatchEvent(new window.Event('paste', { bubbles: true })));
  assert.equal(pasted, 1, 'ordinary attachment/paste handler survives shared surface');
  await act(() => document.querySelector('button')!.click());
  assert.equal(clicked, 1, 'toolbar action remains owned by adapter');
  assert.equal(document.querySelectorAll('.input-toolbar').length, 1);
  await act(() => root.unmount());
  assert.equal(ref.current, null);
  console.log('[chat-composer-ui] PASS: controlled draft/ref, resize, IME, Enter, paste, toolbar, unmount');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
