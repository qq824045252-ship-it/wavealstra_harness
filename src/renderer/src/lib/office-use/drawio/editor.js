const frame = document.querySelector("#canvas");
const notice = document.querySelector("#notice");
const status = document.querySelector("#status");
const copy = document.querySelector("#copy");
const post = (message) => frame.contentWindow.postMessage(JSON.stringify(message), location.origin);
let config;
let current;
let persisted;
let drafted;
let pending = Promise.resolve();

function show(message, offerCopy = false) {
  status.textContent = message;
  copy.hidden = !offerCopy;
  notice.hidden = !message;
}

function write(action, xml) {
  const next = pending.catch(() => {}).then(async () => {
    if (action === "draft" && (xml === drafted || xml === persisted)) return;
    const result = await fetch(action, { method: "POST", headers: { "Content-Type": "application/xml" }, body: xml });
    const message = await result.text();
    if (!result.ok) throw new Error(message || "图纸保存失败");
    if (action === "draft") { drafted = xml; return; }
    if (action === "save" && result.headers.has("X-Office-Saved")) {
      persisted = xml;
      drafted = undefined;
      post({ action: "status", message, modified: current !== xml });
    }
    show(message, action === "save" && current !== persisted);
  });
  pending = next;
  return next;
}

window.flushDrawioDraft = async () => {
  if (!config || config.readOnly) return;
  // Let the embedded editor's last autosave message reach this window.
  await new Promise(resolve => setTimeout(resolve, 0));
  if (current && current !== persisted) await write("draft", current);
  await pending;
};

window.addEventListener("message", event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin || typeof event.data !== "string") return;
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.event === "init") {
    if (!config) return;
    post({ action: "load", xml: current, title: config.name, autosave: config.readOnly ? 0 : 1,
      readOnly: config.readOnly, noSaveBtn: config.readOnly ? "1" : "0" });
    return;
  }
  if (message.event === "load") {
    show(config.conflict ? "源文件已变化，已恢复草稿。" :
      config.recovered ? "已恢复草稿。" : config.readOnly ? "只读" : "", config.conflict);
    return;
  }
  if (!config || config.readOnly || typeof message.xml !== "string") return;
  if (message.event !== "save" && message.event !== "autosave") return;
  current = message.xml;
  write(message.event === "save" ? "save" : "draft", current).catch(error => show(error.message, true));
});

copy.addEventListener("click", () => write("export", current).catch(error => show(error.message, true)));

async function openDrawing() {
  const [settings, drawing] = await Promise.all([fetch("config"), fetch("source")]);
  if (!settings.ok || !drawing.ok) throw new Error("无法读取 Draw.io 文件");
  config = await settings.json();
  current = await drawing.text();
  persisted = config.recovered ? undefined : current;
  frame.src = "/drawio-runtime/index.html?embed=1&proto=json&offline=1&stealth=1&noExitBtn=1&ui=atlas&lang=zh";
}

openDrawing().catch(error => show(error.message));
