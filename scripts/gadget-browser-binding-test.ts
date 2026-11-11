import assert from 'node:assert/strict';
import { reconcileGadgetBrowser, type GadgetBrowserState } from '../src/renderer/src/lib/gadgetBrowserBinding';
import { createBrowserNavigationActions } from '../src/renderer/src/store/app/commands/browserNavigation';
const old = 'http://127.0.0.1:41001/';
const next = 'http://127.0.0.1:41002/';
const runtime = { gadgetId: 'g', status: 'running' as const, url: next };
const base: GadgetBrowserState = {
  activeTaskId: 'a', page: 'chat', panelOpen: true, panelMode: 'browser',
  browserUrlByTask: { a: old, b: 'https://example.com/', __home__: old },
  browserGadgetByTask: { a: { gadgetId: 'g', url: old }, __home__: { gadgetId: 'g', url: old } },
  browserUrlInput: old, browserFrameKey: 0,
};
const apply = (state: GadgetBrowserState, refresh = false) => ({ ...state, ...reconcileGadgetBrowser(state, runtime, refresh) });
const recovered = apply(base);
assert.equal(recovered.browserUrlByTask.a, next);
assert.equal(recovered.browserUrlByTask.__home__, next);
assert.equal(recovered.browserUrlByTask.b, 'https://example.com/');
assert.equal(recovered.browserUrlInput, next);
assert.equal(recovered.browserFrameKey, 0, 'new URL needs navigation, not reload of old document');
assert.deepEqual(reconcileGadgetBrowser(base, { gadgetId: 'other', status: 'running', url: next }), {});
for (const status of ['stopped', 'starting', 'error'] as const) assert.deepEqual(reconcileGadgetBrowser(base, { ...runtime, status }), {});
for (const state of [{ ...base, panelOpen: false }, { ...base, activeTaskId: 'b' }, { ...base, page: 'settings' }]) {
  const patched = apply(state);
  assert.equal(patched.browserUrlByTask.a, next, 'retain corrected URL while hidden');
  assert.equal(patched.browserUrlInput, old, 'do not change current other page/address input');
  assert.equal(patched.panelOpen, state.panelOpen);
  assert.equal(patched.browserFrameKey, 0);
}
const manual = { ...base, browserUrlByTask: { ...base.browserUrlByTask, a: 'https://manual.example/' } };
assert.equal(apply(manual).browserUrlByTask.a, 'https://manual.example/');
assert.equal(apply(recovered, true).browserFrameKey, 1, 'source updates refresh only current matching Gadget');
let state: any = { ...base, browserNavigationVersion: 0, sidebarCollapsed: false };
const actions = createBrowserNavigationActions({ get: () => state, set: (update: any) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; } } as any);
actions.setBrowserUrl(old, 'g');
assert.equal(state.browserGadgetByTask.a.gadgetId, 'g');
const version = state.browserNavigationVersion;
actions.setBrowserUrl(old);
assert.equal(state.browserGadgetByTask.a, undefined, 'even manual navigation to same URL drops identity');
assert.equal(state.browserNavigationVersion, version + 1);
assert.equal(apply(state).browserUrlByTask.a, old, 'unbound manual entry is not adopted');
actions.setBrowserUrl(null);
assert.equal(state.browserUrlByTask.a, undefined);
console.log('gadget browser binding: PASS (runtime port replacement, task/home retention, navigation ownership, stopped runtime, source refresh)');
