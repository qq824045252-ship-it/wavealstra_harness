import './bot-workspace-navigation-ui-env';
// LinkeDOM has neither a resize engine nor modal dialog methods. These no-ops
// allow behavior tests only; they do not supply layout or prove focus trapping.
if (typeof ResizeObserver === 'undefined') {
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  Object.assign(HTMLElement.prototype, {
    showModal(this: HTMLElement) { this.setAttribute('open', ''); },
    close(this: HTMLElement) { this.removeAttribute('open'); },
  });
}

if (typeof localStorage === 'undefined') {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; } };
  Object.assign(globalThis, { localStorage: storage });
  Object.assign(window, { localStorage: storage });
}
