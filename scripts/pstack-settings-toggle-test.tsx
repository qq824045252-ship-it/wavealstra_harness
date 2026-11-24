/** Headless coverage for the independent pstack/Thermos controls and profile reload. */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import { normalizePstackSettings, type PstackSettings } from "../src/shared/pstack";

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });

async function main() {
  const { createRoot } = await import("react-dom/client");
  const { default: PstackSettingsEditor } = await import("../src/renderer/src/components/settings/PstackSettingsEditor");
  const masterLabel = "启用 pstack 工作流";
  const reviewLabel = "启用 Thermos 深度质量评审";
  const reviewId = "thermo-nuclear-code-quality-review";
  let settings = normalizePstackSettings({ thermos: { changedLines: 37, beforeMerge: true } });
  const initial = structuredClone(settings);
  let enabled = true;
  let saving = false;
  let changes = 0;
  let mount = 0;
  const root = createRoot(document.getElementById("root")!);
  const render = () => root.render(<PstackSettingsEditor key={mount} value={settings}
    enabled={enabled} saving={saving} models={[]} change={change} />);
  function change(next: PstackSettings, active: boolean) {
    settings = next;
    enabled = active;
    changes++;
    render();
  }
  function checkbox(label: string) {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    assert(input, `Missing checkbox: ${label}`);
    return input;
  }
  async function toggle(label: string) {
    await act(async () => {
      const input = checkbox(label);
      // Linkedom has no native checkbox default action; supply the checked value
      // a browser sets before dispatching click, then exercise React's event path.
      input.checked = !input.checked;
      input.click();
    });
  }

  try {
    await act(async () => { render(); });
    assert.equal(document.querySelectorAll(".pstack-top input[type=checkbox]").length, 2,
      "Both independent controls must be visible without opening the Thermos tab");
    assert(checkbox(masterLabel).checked && checkbox(reviewLabel).checked);
    await toggle(reviewLabel);
    assert.equal(changes, 1, "Thermos checkbox must dispatch the settings change");
    assert.equal(enabled, true, "Disabling Thermos must keep pstack active");
    const withoutReview = structuredClone(initial);
    withoutReview.skills[reviewId].enabled = false;
    assert.deepEqual(settings, withoutReview, "Disabling Thermos must preserve poteto, validation and all other settings");

    await toggle(masterLabel);
    assert.equal(enabled, false);
    assert.deepEqual(settings, withoutReview, "Disabling pstack must preserve the independent Thermos preference");
    await toggle(masterLabel);
    assert.equal(enabled, true);
    assert.equal(checkbox(reviewLabel).checked, false, "Re-enabling pstack must not silently turn Thermos back on");

    const stored = JSON.stringify({ pstackThermosEnabled: enabled, pstackThermos: settings });
    const restored = JSON.parse(stored);
    settings = normalizePstackSettings(restored.pstackThermos);
    enabled = restored.pstackThermosEnabled;
    mount++;
    await act(async () => { render(); });
    assert(checkbox(masterLabel).checked);
    assert.equal(checkbox(reviewLabel).checked, false, "Reload must preserve Thermos off independently of pstack");
    assert.deepEqual(settings, withoutReview, "Profile normalization must preserve the disabled skill and review thresholds");

    await toggle(reviewLabel);
    assert.deepEqual(settings, initial, "Re-enabling Thermos must reuse the saved review settings");
    assert.equal(enabled, true);
    saving = true;
    await act(async () => { render(); });
    assert(checkbox(masterLabel).closest("fieldset")?.hasAttribute("disabled"));
    assert(checkbox(reviewLabel).closest("fieldset")?.hasAttribute("disabled"));
    console.log("PASS pstack settings: independent Thermos switch, master off/on, normalized profile reload, preserved thresholds, pending-save lock");
  } finally {
    await act(async () => { root.unmount(); });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
