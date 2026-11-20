// The export page uses the draw.io Desktop renderer's message interface.
// This bridge has no Node access. Main only passes render options and reads progress.
(() => {
  const listeners = new Map();
  let active;
  window.electron = {
    registerMsgListener(name, callback) { listeners.set(name, callback); },
    sendMessage(name, value) {
      if (!active) return;
      if (name.endsWith("error") || value == null) {
        active.reject(new Error(value || "Draw.io could not render this diagram"));
      } else if (name === "render-finished" && active.format === "svg") {
        listeners.get("get-svg-data")?.();
      } else {
        active.resolve(value);
      }
    },
  };
  window.myBuddyDrawioRender = options => new Promise((resolve, reject) => {
    active = { resolve, reject, format: options.format };
    const render = listeners.get("render");
    if (!render) { reject(new Error("Draw.io export renderer did not load")); return; }
    render(options);
  });
})();
