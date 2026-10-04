/* html-js fixture 外部脚本：验证相对资源 + JS 应用逻辑（V3.5 §28） */
(function () {
  "use strict";

  var ITEMS = Array.from({ length: 24 }, function (_, i) {
    return { id: i + 1, name: "任务 " + (i + 1), done: i % 3 === 0, ts: Date.now() - i * 86400000 };
  });

  function fmt(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function render(filter) {
    var app = document.getElementById("app");
    var tpl = document.getElementById("row-tpl");
    var list = document.createElement("ul");
    list.className = "list";
    var shown = 0;
    ITEMS.forEach(function (item) {
      if (filter === "open" && item.done) return;
      var frag = tpl.content.cloneNode(true);
      frag.querySelector(".idx").textContent = String(item.id).padStart(2, "0");
      frag.querySelector(".name").textContent = item.name;
      var status = frag.querySelector(".status");
      status.textContent = item.done ? "已完成" : "进行中";
      status.className = "status " + (item.done ? "ok" : "run");
      frag.querySelector("li").dataset.id = String(item.id);
      list.appendChild(frag);
      shown += 1;
    });
    app.textContent = "";
    app.appendChild(list);
    var meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = "共显示 " + shown + " / " + ITEMS.length + " 条（含外部 JS 动态渲染）";
    app.appendChild(meta);
    return shown;
  }

  // 事件委托：点击行切换状态
  document.addEventListener("click", function (ev) {
    var li = ev.target && ev.target.closest ? ev.target.closest("li.row") : null;
    if (!li) return;
    var id = Number(li.dataset.id);
    var item = ITEMS.find(function (x) { return x.id === id; });
    if (!item) return;
    item.done = !item.done;
    render();
  });

  // 过滤按钮
  var bar = document.createElement("div");
  bar.className = "toolbar";
  ["all", "open"].forEach(function (mode) {
    var btn = document.createElement("button");
    btn.textContent = mode === "all" ? "全部" : "未完成";
    btn.addEventListener("click", function () { render(mode === "open" ? "open" : undefined); });
    bar.appendChild(btn);
  });
  document.body.insertBefore(bar, document.getElementById("app"));

  // 时序状态行（验证 setTimeout 与 DOM 更新在沙箱内正常）
  var clock = document.createElement("p");
  clock.className = "clock";
  clock.textContent = "加载时间: " + fmt(ITEMS[0].ts);
  document.body.appendChild(clock);
  var tick = 0;
  var timer = setInterval(function () {
    tick += 1;
    clock.textContent = "加载时间: " + fmt(ITEMS[0].ts) + " · tick " + tick;
    if (tick >= 5) clearInterval(timer);
  }, 300);

  render();
})();
