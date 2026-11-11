import type { GadgetRuntimeState } from '../../../shared/gadget-types';
import { HOME_BROWSER_KEY } from './browserLinks';

export interface GadgetBrowserState {
  activeTaskId: string | null;
  page: string;
  panelOpen: boolean;
  panelMode: string;
  browserUrlByTask: Record<string, string>;
  browserGadgetByTask: Record<string, { gadgetId: string; url: string }>;
  browserUrlInput: string;
  browserFrameKey: number;
}

/** Reconcile only retained entries still owned by this Gadget, without opening UI. */
export function reconcileGadgetBrowser(state: GadgetBrowserState, runtime: GadgetRuntimeState, refresh = false): Partial<Pick<GadgetBrowserState, 'browserUrlByTask' | 'browserGadgetByTask' | 'browserUrlInput' | 'browserFrameKey'>> {
  if (runtime.status !== 'running' || !runtime.url) return {};
  const urls = { ...state.browserUrlByTask };
  const bindings = { ...state.browserGadgetByTask };
  let changed = false;
  let activeChanged = false;
  let activeRefresh = false;
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.gadgetId !== runtime.gadgetId || urls[key] !== binding.url) continue;
    const visible = key === (state.activeTaskId ?? HOME_BROWSER_KEY) && state.page === 'chat' && state.panelOpen && state.panelMode === 'browser';
    if (binding.url !== runtime.url) {
      urls[key] = runtime.url;
      bindings[key] = { gadgetId: runtime.gadgetId, url: runtime.url };
      changed = true;
      activeChanged ||= visible;
    } else activeRefresh ||= visible && refresh;
  }
  return {
    ...(changed ? { browserUrlByTask: urls, browserGadgetByTask: bindings } : {}),
    ...(activeChanged ? { browserUrlInput: runtime.url } : {}),
    ...(activeRefresh ? { browserFrameKey: state.browserFrameKey + 1 } : {}),
  };
}
