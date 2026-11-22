const assert = require("node:assert/strict");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

run(async env => {
  const { evaluate, restart } = env;
  const { askInChat } = routingControls(env);
  const open = () => evaluate("import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().openDots())");
  const api = (method, ...args) => evaluate("window.api." + method + "(" + args.map(arg => JSON.stringify(arg)).join(",") + ")");
  const { id } = await api("dots.open");
  const atom = await api("memory.create", { kind: "preference", title: "交付口令", content: "每次回答末尾使用 KITE-482。", scopeType: "task", scopeId: id });
  await open();
  assert.match((await askInChat(id, "两加二等于多少？")).answer, /KITE-482/);
  await api("memory.update", { id: atom.id, content: "每次回答末尾使用 PEAR-819。" });
  await restart();
  await open();
  const updated = await askInChat(id, "三加三等于多少？");
  assert.match(updated.answer, /PEAR-819/);
  assert.doesNotMatch(updated.answer, /KITE-482/);
  await api("memory.forget", atom.id);
  const forgotten = await askInChat(id, "四加四等于多少？只给数字。");
  assert.doesNotMatch(forgotten.answer, /PEAR-819|KITE-482/);
  assert.deepEqual(await api("answerRouting.list"), []);
}, { name: "dots-rule-memory-live", liveModel: true, watchRenderer: false, settings: { memoryEnabled: true }, rpcTimeoutMs: 150000 });
