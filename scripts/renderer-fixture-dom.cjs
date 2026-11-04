// DOM behaviour only. LinkeDOM has no CSS layout, painted pixels, native file
// dialogs, or Electron IPC. These control defaults are browser semantics, not
// application mocks; the fixture supplies the same IPC data as its Electron run.
const { parseHTML } = require('linkedom');
const { readFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const vm = require('node:vm');

function createDomFixture() {
  return {
    backend: 'dom',
    evaluate: async (code) => vm.runInThisContext(code),
    loadFile: async (file) => {
      const { window } = parseHTML(readFileSync(file, 'utf8'));
      for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event', 'CustomEvent', 'Document', 'DOMParser', 'MutationObserver']) globalThis[name] = window[name];
      globalThis.window = window;
      globalThis.document = window.document;
      Object.defineProperty(window.document, 'compatMode', { value: 'CSS1Compat' });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'LinkeDOM renderer fixture' } });
      globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
      globalThis.cancelAnimationFrame = clearTimeout;
      globalThis.sessionStorage = Object.create({
        getItem(key) { return Object.hasOwn(this, key) ? this[key] : null; },
        setItem(key, value) { this[key] = String(value); },
        removeItem(key) { delete this[key]; },
        clear() { for (const key of Object.keys(this)) delete this[key]; },
        key(index) { return Object.keys(this)[index] ?? null; },
        get length() { return Object.keys(this).length; },
      });
      window.document.oninput = null;
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};

      const inputType = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type');
      Object.defineProperty(HTMLInputElement.prototype, 'type', { configurable: true,
        get() { return inputType.get.call(this) || 'text'; },
        set(value) { inputType.set.call(this, value); },
      });
      // React initializes textareas via defaultValue. Native textarea value has
      // its own dirty flag; changing defaultValue must not overwrite typed text.
      const textareaValues = new WeakMap();
      Object.defineProperties(HTMLTextAreaElement.prototype, {
        defaultValue: { configurable: true,
          get() { return this.textContent; },
          set(value) { this.textContent = String(value); },
        },
        value: { configurable: true,
          get() { return textareaValues.has(this) ? textareaValues.get(this) : this.textContent; },
          set(value) { textareaValues.set(this, String(value)); },
        },
      });
      const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      Object.defineProperty(HTMLSelectElement.prototype, 'value', { configurable: true,
        get() { return selectValue.get.call(this) ?? this.options[0]?.value ?? ''; },
        set(value) {
          for (const option of this.options) option.removeAttribute('selected');
          [...this.options].find((option) => option.value === String(value))?.setAttribute('selected', '');
        },
      });
      for (const prototype of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
        Object.defineProperty(prototype, 'readOnly', { configurable: true,
          get() { return this.hasAttribute('readonly') || this.hasAttribute('readOnly'); },
          set(value) { value ? this.setAttribute('readonly', '') : this.removeAttribute('readonly'); },
        });
      }
      Object.defineProperty(HTMLElement.prototype, 'open', { configurable: true,
        get() { return this.hasAttribute('open'); },
        set(value) { value ? this.setAttribute('open', '') : this.removeAttribute('open'); },
      });
      HTMLElement.prototype.click = function () {
        if (this.disabled) return;
        const event = new Event('click', { bubbles: true, cancelable: true });
        if (!this.dispatchEvent(event)) return;
        if (this.localName === 'summary' && this.parentElement?.localName === 'details') this.parentElement.open = !this.parentElement.open;
        if (this.localName === 'button' && (this.getAttribute('type') || 'submit') === 'submit') {
          this.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      };

      // Honour semantic hidden/details state without inventing layout rectangles.
      window.__fixtureVisible = (element) => {
        if (!element.isConnected) return false;
        for (let node = element; node; node = node.parentElement) {
          if (node.hidden || node.style?.display === 'none' || node.style?.visibility === 'hidden') return false;
          if (node.parentElement?.localName === 'details' && !node.parentElement.open && node.localName !== 'summary') return false;
        }
        return true;
      };
      const innerText = Object.getOwnPropertyDescriptor(Element.prototype, 'innerText').get;
      Object.defineProperty(Element.prototype, 'innerText', { configurable: true, get() {
        const clone = this.cloneNode(true);
        for (const node of clone.querySelectorAll('script, style, [hidden], details:not([open]) > :not(summary)')) node.remove();
        return innerText.call(clone);
      } });

      for (const script of window.document.querySelectorAll('script[src]')) {
        vm.runInThisContext(readFileSync(resolve(dirname(file), script.getAttribute('src')), 'utf8'), { filename: script.getAttribute('src') });
      }
    },
    screenshot: async () => {
      console.log('SKIP DOM screenshot: this backend has no layout or painted pixels');
      return null;
    },
  };
}

module.exports = { createDomFixture };
