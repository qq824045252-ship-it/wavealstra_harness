const assert = require("node:assert/strict");
const path = require("node:path");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

const paragraph = ".assistant-card .md-chat p";
const dotsLabel = ".sidebar-dots-row .desktop-section-label";
const composer = "textarea.input-textarea";
const fontFile = path.join(__dirname, "../src/renderer/src/assets/fonts/source-serif-4-latin.woff2");

run(async (env) => {
  const { evaluate, until, report, restart, rpc } = env;
  const { press, click, fill, screenshot } = routingControls(env);
  const node = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  const controlIds = {
    应用外观: "appearance-mode",
    强调色: "appearance-accent",
    对话宽度: "appearance-chat-width",
    回复标题样式: "appearance-reply-headings",
  };
  const control = (label) => controlIds[label] ? `#${controlIds[label]}` : `select[aria-label="${label}"]`;
  const style = (selector, property) => evaluate(`getComputedStyle(${node(selector)})[${JSON.stringify(property)}]`);
  const token = (property) => evaluate(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(property)}).trim()`);
  const saved = () => evaluate("window.api.agent.getAppSettings()");
  const settingValue = async (setting) => setting.split(".").reduce((value, key) => value?.[key], await saved());
  const openSettings = async () => {
    await click("设置", ".desktop-rail");
    await until(() => evaluate(`!${node(control("界面字号"))}?.disabled && !!${node(control("界面字号"))}`), "font settings loaded");
  };
  const closeSettings = () => click("关闭设置", ".settings-content-head");
  const openDots = async () => {
    await click("MyBuddy Dots", ".sidebar-dots-entry");
    await until(() => evaluate(`${node(".chat-header-title")}?.textContent === 'MyBuddy Dots'`), "Dots selected");
  };
  const choose = async (label, value, setting) => {
    await fill(control(label), value === null ? "" : String(value));
    await until(async () => (await settingValue(setting)) === value, label + " saved");
  };
  const chooseFont = async (label, font, setting) => {
    await click(label, ".typography-flat-layout");
    await click(font, ".typography-font-picker-popover");
    await until(async () => (await settingValue(setting))?.includes(font === "衬线阅读（Claude 风格）" ? "Source Serif 4 Reading" : font), label + " saved");
  };
  const fontsUsed = async (selector) => {
    await rpc("DOM.getDocument");
    const { result } = await rpc("Runtime.evaluate", {
      expression: `(()=>{const element = ${node(selector)};
        return [...element.querySelectorAll("*")].find(child => child.childElementCount === 0 && child.textContent.includes("README")) ?? element;
      })()`,
    });
    const { nodeId } = await rpc("DOM.requestNode", { objectId: result.objectId });
    const { fonts } = await rpc("CSS.getPlatformFontsForNode", { nodeId });
    await rpc("Runtime.releaseObject", { objectId: result.objectId });
    return fonts;
  };
  const enableFontInspection = async () => {
    await rpc("DOM.enable");
    await rpc("CSS.enable");
  };

  await until(() => evaluate(`Boolean(${node(".sidebar-dots-row:not([aria-current])")})`), "Dots visible before selection");
  assert.equal(await style(dotsLabel, "fontWeight"), "700");
  await openDots();
  await press(node(composer), "Dots composer");
  await rpc("Input.insertText", { text: "字体验收" });
  await press(node('button[title="发送 (Enter)"]'), "send typography fixture");
  await until(() => evaluate(`${node(paragraph)}?.textContent.includes('README') && !!${node(".assistant-card .inline-code")}`), "rendered reply and inline code");
  assert.equal(await style(dotsLabel, "fontSize"), "13px");
  assert.equal(await style(dotsLabel, "fontWeight"), "700");
  assert.equal(await style(composer, "fontSize"), "14px");
  assert.equal(await style(paragraph, "fontSize"), "15px");

  await openSettings();
  assert.equal(await evaluate(`${node(control("回复字号"))}.value`), "");
  await choose("界面字号", 18, "uiFontSize");
  await choose("界面粗细", 500, "uiFontWeight");
  await choose("回复字号", 16, "replyFontSize");
  await choose("回复粗细", 500, "replyFontWeight");
  await choose("代码字号", 19, "codeFontSize");
  await chooseFont("回复字体", "衬线阅读（Claude 风格）", "replyFontFamily");
  await choose("应用外观", "light", "desktopAppearance.mode");
  await press(node('.appearance-palette-option:has(input[value="mist"])'), "mist palette");
  await until(async () => (await settingValue("desktopAppearance.palette")) === "mist", "mist palette saved");
  await choose("强调色", "violet", "desktopAppearance.accent");
  await until(() => evaluate("document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.palette === 'mist'"), "light mist rendered");
  assert.equal(await token("--surface-main"), "#f3f8fc");
  assert.equal(await token("--accent"), "#70469b");
  await screenshot("settings-typography");
  await choose("回复行距", 1.95, "replyLayout.lineHeight");
  await choose("回复段距", 1.2, "replyLayout.paragraphGap");
  await choose("对话宽度", "narrow", "replyLayout.width");
  await choose("回复标题样式", "prominent", "replyLayout.headings");
  await closeSettings();
  assert.equal(await style(dotsLabel, "fontWeight"), "800");
  assert.equal(await style(dotsLabel, "fontSize"), "15.6px");
  assert.equal(await style(composer, "fontSize"), "16.8px");
  assert.equal(await style(paragraph, "fontSize"), "16px");
  assert.equal(await style(paragraph, "fontWeight"), "500");
  assert.equal(await style(paragraph, "lineHeight"), "31.2px");
  assert.equal(await style(paragraph, "marginBottom"), "19.2px");
  assert.equal(await style(".assistant-card .md-chat h2", "fontWeight"), "700");
  assert.equal(await style(".message-list", "maxWidth"), "620px");
  assert.equal(await style(".assistant-card .inline-code", "fontSize"), "19px");

  await enableFontInspection();
  await evaluate("document.fonts.ready.then(() => true)");
  const readingFonts = await fontsUsed(paragraph);
  report.checks.push({ readingFonts });
  assert(readingFonts.some((font) => font.isCustomFont && /source.?serif/i.test(font.familyName + font.postScriptName) && font.glyphCount > 0), JSON.stringify(readingFonts));
  await screenshot("chat-typography");

  const imported = await evaluate(`window.api.agent.importUserFont(${JSON.stringify(fontFile)})`);
  await openSettings();
  await chooseFont("界面字体", imported.family, "uiFontFamily");
  await chooseFont("回复字体", imported.family, "replyFontFamily");
  await chooseFont("代码字体", imported.family, "codeFontFamily");
  await press(node(".typography-navigation summary"), "independent navigation fonts");
  await choose("菜单字号", 14, "navigationTypography.menu.size");
  await choose("空间名称字号", 18, "navigationTypography.workspace.size");
  await choose("任务名称字号", 16, "navigationTypography.task.size");
  await choose("任务名称粗细", 700, "navigationTypography.task.weight");
  await chooseFont("空间名称字体", imported.family, "navigationTypography.workspace.family");
  await screenshot("navigation-fonts");
  await closeSettings();
  assert.equal(await evaluate(`[...document.fonts].find(f => f.family === ${JSON.stringify(imported.family)})?.status`), "loaded");
  assert((await fontsUsed(dotsLabel)).some((font) => font.isCustomFont && font.glyphCount > 0));
  assert((await fontsUsed(".assistant-card .inline-code")).some((font) => font.isCustomFont && font.glyphCount > 0));

  await evaluate("import('/src/store/appStore.ts').then(m => m.useAppStore.getState().showTerminal())");
  await press(node(".terminal-empty-add-btn"), "new terminal tab");
  await until(() => evaluate(`!!${node(".xterm-rows")}`), "terminal open");
  assert.equal(await style(".xterm-rows", "fontSize"), "19px");
  assert.match(await style(".xterm-rows", "fontFamily"), /^"source serif 4 latin"/);

  await evaluate(`Promise.all([
    window.api.db.upsertSpace({id: 'appearance-workspace', name: 'Appearance Workspace'}),
    window.api.db.upsertTask({id: 'appearance-task', title: 'Appearance Task', welcomeMode: 'general', updatedAt: Date.now()})
  ])`);
  await restart();
  await openDots();
  await until(() => evaluate(`${node(paragraph)}?.textContent.includes('README')`), "reply restored");
  assert.equal(await style(paragraph, "fontSize"), "16px");
  assert.equal(await style(paragraph, "fontWeight"), "500");
  assert.match(await style(paragraph, "fontFamily"), /^"source serif 4 latin"/);
  assert.equal(await style(paragraph, "lineHeight"), "31.2px");
  assert.equal(await style(".message-list", "maxWidth"), "620px");
  assert.equal(await token("--surface-main"), "#f3f8fc");
  assert.equal(await token("--accent"), "#70469b");
  await until(() => evaluate(`!!${node(".space-name")} && !!${node(".task-item-title")}`), "workspace and task names hydrated");
  assert.equal(await style(".sidebar-cta-text", "fontSize"), "14px");
  assert.equal(await style(".space-name", "fontSize"), "18px");
  assert.match(await style(".space-name", "fontFamily"), /^"source serif 4 latin"/);
  assert.equal(await style(".task-item-title", "fontSize"), "16px");
  assert.equal(await style(".task-item-title", "fontWeight"), "700");
  await openSettings();
  assert.equal(await evaluate(`${node(control("界面字号"))}.value`), "18");
  assert.equal(await evaluate(`${node(control("代码字号"))}.value`), "19");
  await press(node(`button[title="删除 ${imported.family}"]`), "remove imported font");
  await click("删除", ".full-access-dialog-actions");
  await until(async () => {
    const settings = await saved();
    return settings.uiFontFamily === "" && settings.replyFontFamily === "" && settings.codeFontFamily === ""
      && settings.navigationTypography.workspace.family === ""
      && await evaluate("window.api.agent.listUserFonts().then(fonts => fonts.length === 0)");
  }, "removed font and reset all selections");
  await choose("回复字号", null, "replyFontSize");
  await choose("应用外观", "system", "desktopAppearance.mode");
  for (const mode of ["dark", "light"]) {
    await rpc("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode }] });
    await until(() => evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(mode)}`), "system preference changed to " + mode);
    assert.equal(await token("--surface-main"), mode === "dark" ? "#1a2a39" : "#f3f8fc");
    assert.equal(await token("--accent"), mode === "dark" ? "#d4a9fc" : "#70469b");
  }
  await closeSettings();
  assert.equal(await style(paragraph, "fontSize"), "18px");
  assert.equal(await evaluate(`[...document.fonts].some(f => f.family === ${JSON.stringify(imported.family)})`), false);
  report.actualControlChecks.push("Persisted UI, reply and code settings from the real desktop controls. Checked rendered sizes, weights and font glyphs, an open terminal, relaunch and imported-font deletion.");
  report.actualControlChecks.push("Changed the palette, accent, reading layout and independent navigation fonts, checked actual computed styles and relaunch, then verified live system-mode changes.");
}, {
  name: "typography-desktop",
  watchRenderer: false,
  fixtureModel: () => "## 项目文档\n\n项目文档 README 已更新。\n\n示例代码 `const value = 1`。",
});
