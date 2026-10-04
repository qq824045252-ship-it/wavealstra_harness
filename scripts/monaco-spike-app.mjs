// 1G — Monaco spike 页面逻辑（外部文件：CSP script-src 'self' 允许）
const t = (label, value) => {
  const line = { kind: "metric", name: label, value: `${value}` };
  console.log("SPIKE|" + JSON.stringify(line));
  const rep = document.getElementById("report");
  if (rep) rep.textContent += `${label}: ${value}\n`;
};

const big = (kb) => {
  const line = "// line of padding for large-file benchmark\n";
  const repeat = Math.ceil((kb * 1024) / line.length);
  return line.repeat(repeat);
};

try {
  const t0 = performance.now();
  const monaco = await import("../node_modules/monaco-editor/esm/vs/editor/editor.api.js");
  t("cold ESM import (editor.api)", `${(performance.now() - t0).toFixed(1)} ms`);

  // worker：本地 ESM worker（相对路径，CSP worker-src 'self'）；显式创建一次计时
  self.MonacoEnvironment = {
    getWorker() {
      return new Worker(new URL("../node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), {
        type: "module",
      });
    },
  };
  const tWorker = performance.now();
  const w = self.MonacoEnvironment.getWorker();
  await new Promise((r) => setTimeout(r, 200));
  t("worker 创建+启动", `${(performance.now() - tWorker).toFixed(1)} ms`);
  w.terminate();

  const el = document.getElementById("editor");
  const t1 = performance.now();
  const editor = monaco.editor.create(el, {
    value: "// hello",
    language: "typescript",
    theme: "vs-dark",
    minimap: { enabled: false },
  });
  t("editor.create (首实例)", `${(performance.now() - t1).toFixed(1)} ms`);

  // 大文件：100KB / 1MB / 5MB
  const sizes = [100, 1024, 5120];
  const models = [];
  for (const kb of sizes) {
    const text = big(kb);
    const tm = performance.now();
    const model = monaco.editor.createModel(text, "typescript");
    models.push(model);
    await new Promise((r) => setTimeout(r, 50));
    t(`${kb / 1024 >= 1 ? `${(kb / 1024).toFixed(0)}MB` : `${kb}KB`} createModel+渲染`, `${(performance.now() - tm).toFixed(1)} ms`);
    model.dispose();
  }

  // 多实例：5 个 editor（离屏）
  const t5 = performance.now();
  const editors = [];
  for (let i = 0; i < 5; i++) {
    const div = document.createElement("div");
    div.style.cssText = "width:100px;height:100px;position:absolute;left:-9999px";
    document.body.appendChild(div);
    editors.push(monaco.editor.create(div, { value: `// instance ${i}`, language: "javascript", minimap: { enabled: false } }));
  }
  t("5 实例 create", `${(performance.now() - t5).toFixed(1)} ms`);

  // dispose：全部销毁
  const tD = performance.now();
  for (const e of editors) e.dispose();
  for (const m of models) { try { m.dispose(); } catch {} }
  editor.dispose();
  await new Promise((r) => setTimeout(r, 500));
  t("dispose 全部", `${(performance.now() - tD).toFixed(1)} ms`);

  console.log("SPIKE|" + JSON.stringify({ kind: "done" }));
} catch (err) {
  console.log("ERROR|" + String((err && err.stack) || err).slice(0, 600));
  console.log("SPIKE|" + JSON.stringify({ kind: "done" }));
}
