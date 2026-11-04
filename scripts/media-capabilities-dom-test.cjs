// DOM-only execution of the same interaction fixture. This does not verify CSS layout or native Electron.
const { parseHTML } = require('linkedom');
const vm = require('node:vm');
const fs = require('node:fs');
const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
for (const name of ['HTMLElement','HTMLInputElement','HTMLSelectElement','HTMLButtonElement','HTMLIFrameElement','Element','Node','Event','CustomEvent','Document']) globalThis[name] = window[name];
globalThis.window = window; globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'DOM fixture' } });
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.innerWidth = 1280; globalThis.innerHeight = 1000;
window.scrollTo = () => {};
window.document.oninput = null;
window.HTMLElement.prototype.scrollIntoView = () => {};
// LinkeDOM omits native default input type, select assignment and inherited fieldset disabledness.
const inputType = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type');
Object.defineProperty(HTMLInputElement.prototype, 'type', { configurable: true, get() { return inputType.get.call(this) || 'text'; }, set(value) { inputType.set.call(this,value); } });
const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
Object.defineProperty(HTMLSelectElement.prototype, 'value', { configurable: true, get: selectValue.get, set(value) { for (const option of this.options) option.removeAttribute('selected'); const option = [...this.options].find(item => item.value === value); if (option) option.setAttribute('selected',''); } });
const matches = HTMLElement.prototype.matches;
HTMLElement.prototype.matches = function(selector) { if (selector === ':disabled') return this.hasAttribute('disabled') || Boolean(this.closest('fieldset[disabled]')); return matches.call(this,selector); };
Object.defineProperty(HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { value ? this.setAttribute('open','') : this.removeAttribute('open'); } });
const watchdog = setTimeout(() => { console.error('FAIL DOM media settings timed out'); process.exit(1); }, 30000);
vm.runInThisContext(fs.readFileSync('out/tests/media-capabilities-dom.js','utf8'), {filename:'media-capabilities-dom.js'});
(async () => { const results = await MediaCapabilitiesUI.run(); for (const result of results) console.log('PASS DOM',result); })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
