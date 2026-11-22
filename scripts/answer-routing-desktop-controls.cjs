const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");

exports.routingControls = ({ evaluate, until, rpc, out, report }) => {
  const quote = JSON.stringify;
  const button = (label, scope) => `[...document.querySelectorAll(${quote(scope + " button")})].find(b => !b.disabled && (b.textContent.trim() === ${quote(label)} || b.getAttribute("aria-label") === ${quote(label)}))`;
  const press = async (expression, label) => {
    await rpc("Page.bringToFront");
    await rpc("Emulation.setFocusEmulationEnabled", {enabled:true});
    for (let attempt = 0; attempt < 3; attempt++) {
      let point, previous;
      await until(async () => {
        point = await evaluate(`(() => {
          const el = ${expression};
          if (!el || el.matches(':disabled') || !el.checkVisibility()) return null;
          el.scrollIntoView({block:'nearest', inline:'nearest', behavior:'instant'});
          const r = el.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
          if (!el.contains(document.elementFromPoint(x,y))) return null;
          return {x,y};
        })()`);
        const stable = point && previous && point.x === previous.x && point.y === previous.y;
        previous = point;
        return stable;
      }, label + " visible and clickable");
      await rpc("Input.dispatchMouseEvent", {type:"mouseMoved", ...point});
      await evaluate(`window.routingClickDelivered = false; window.routingObserveClick = e => {
        window.routingClickDelivered = e.composedPath().includes(${expression});
      }; window.addEventListener('click', window.routingObserveClick, true)`);
      await rpc("Input.dispatchMouseEvent", {type:"mousePressed", button:"left", clickCount:1, ...point});
      await rpc("Input.dispatchMouseEvent", {type:"mouseReleased", button:"left", clickCount:1, ...point});
      if (await evaluate("window.removeEventListener('click',window.routingObserveClick,true); window.routingClickDelivered")) {
        report.checks.push("Clicked " + label);
        return;
      }
    }
    throw Error("Pointer click did not reach " + label);
  };
  const askInChat = async (taskId, text) => {
    const api = (method, arg) => evaluate('window.api.' + method + '(' + quote(arg) + ')');
    const teach = '.message-list button[aria-label="下次这样答"]';
    const selector = css => 'document.querySelector(' + quote(css) + ')';
    const before = await evaluate(`document.querySelectorAll('${teach}').length`);
    await press(selector("textarea.input-textarea"), "chat input");
    await rpc("Input.insertText", {text});
    await press(selector('button[title="发送 (Enter)"]'), "send " + text);
    await until(() => evaluate(`document.querySelectorAll('${teach}').length > ${before}`), "completed reply: " + text);
    await until(() => evaluate(`import('/src/store/appStore.ts').then(m=>{
      const task = m.useAppStore.getState().tasks.find(t=>t.id===${quote(taskId)});
      return task?.durable?.busy === false && task.durable.outcome === 'completed';
    })`), "durable turn completed");
    const {messages} = await api("agent.loadTaskHistory", taskId);
    const user = messages.filter(m => m.role === "user").at(-1);
    const reply = messages.filter(m => m.role === "assistant").at(-1);
    assert.ok(user && reply?.text, "persisted question and answer");
    assert.ok(user.inputRequestId, "durable submission id");
    return {answer: reply.text, uses: await api("answerRouting.history", {taskId, inputId: user.inputRequestId})};
  };
  return {
    press, askInChat,
    async openTopBarMenu(id) {
      const trigger = `[aria-controls="${id}"][aria-expanded="false"]`;
      if (await evaluate(`Boolean(document.querySelector(${quote(trigger)}))`)) {
        await press(`document.querySelector(${quote(trigger)})`, `open ${id}`);
      }
    },
    expand(label) {
      return press(`[...document.querySelectorAll('.answer-rule-form details:not([open]) > summary')].find(s=>s.textContent.startsWith(${quote(label)}))`, label);
    },
    async click(label, scope = ".answer-routing") {
      const expression = button(label, scope);
      await press(expression, label);
    },
    async fill(selector, value) {
      await until(() => evaluate(`(() => { const el=document.querySelector(${quote(selector)}); return !!el?.checkVisibility() && !el.matches(':disabled'); })()`), selector + " ready for input");
      await evaluate(`(() => {
        const field = document.querySelector(${quote(selector)});
        if (!field?.checkVisibility() || field.matches(':disabled')) throw Error("Field unavailable: " + ${quote(selector)});
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${quote(value)});
        field.dispatchEvent(new Event(field.tagName === "SELECT" ? "change" : "input", {bubbles: true}));
      })()`);
    },
    async screenshot(name) {
      await rpc("Page.bringToFront");
      let frame;
      try {
        frame = await rpc("Page.captureScreenshot", { format: "png" });
      } catch (error) {
        if (!String(error).includes("CDP timeout: Page.captureScreenshot")) throw error;
        frame = await rpc("Page.captureScreenshot", { format: "png", fromSurface: false });
      }
      await writeFile(path.join(out, name + ".png"), Buffer.from(frame.data, "base64"));
    },
    openSettings() {
      return evaluate("import('/src/store/appStore.ts').then(m => m.useAppStore.getState().setSettingsOpen(true, 'dots'))");
    },
  };
};
