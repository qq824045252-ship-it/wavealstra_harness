import { createRoot } from "react-dom/client";
import ModesTab from "../src/renderer/src/components/settings/ModesTab";
import { PSTACK_SKILLS, PSTACK_PLAYBOOKS, PSTACK_ROLES, THERMOS_CRITERIA } from "../src/shared/pstack";
import "../src/renderer/src/styles/global.css";

async function until<T>(read: () => T | undefined | null | false, description: string): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() <= deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw Error("Missing " + description + ". Visible: " + document.body.innerText.slice(-1000));
}
async function button(name: string) {
  const b = await until(() => [...document.querySelectorAll("button")].find(item =>
    (item.getAttribute("aria-label") === name || item.textContent?.trim() === name) && !item.disabled && item.getClientRects().length > 0), name);
  b.click();
}
function assert(condition: unknown, description: string): asserts condition {
  if (!condition) throw Error(description);
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function field(name: string) {
  return until(() => [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea")].find(el => el.getAttribute("aria-label") === name), name);
}
async function enter(name: string, value: string, expected = value) {
  const el = await field(name);
  const select = el instanceof HTMLSelectElement;
  const proto = select ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(select ? "change" : "input", { bubbles: true }));
  await tick();
  assert(el.value === expected, "Value was rejected: " + name);
}
async function toggle(name: string) {
  const input = await field(name);
  assert(input instanceof HTMLInputElement && input.type === "checkbox", name + " needs a checkbox");
  input.click();
  await tick();
}
async function selectSection(name: string) {
  await button(name);
  await until(() => document.querySelector(`.pstack-tabs button[aria-label="${name}"][aria-pressed="true"]`), name);
}
async function selectItem(id: string) {
  const row = await until(() => document.querySelector<HTMLButtonElement>(`.pstack-list button[title="${id}"]`), id);
  row.click();
  await until(() => row.getAttribute("aria-current") === "true", id);
}
async function openEditor() {
  await button("代码开发");
  await button("pstack 工作流");
  await field("启用 pstack 工作流");
}
async function save() {
  await button("保存");
  await until(() => document.body.innerText.includes("已保存。将在新任务中生效"), "saved profile");
}
async function readPolicy() {
  return (await window.api!.agent.getModeProfile("coding")).policy;
}
export async function run() {
  const mount = document.createElement("div");
  document.body.append(mount);
  let root = createRoot(mount);
  root.render(<ModesTab />);
  await openEditor();
  const activation = "启用 pstack 工作流";
  const thermosActivation = "启用 Thermos 深度质量评审";
  await button("预设 / Tags");
  const routeField = "启用 pstack 时的默认流程";
  async function pickTag(id: string) {
    const tag = await until(() => [...document.querySelectorAll<HTMLButtonElement>(".modes-preset-rail-item")].find(el =>
      el.querySelector(".modes-preset-rail-id")?.textContent === id), id);
    tag.click(); await tick();
  }
  const initialPolicy = await readPolicy();
  assert(JSON.stringify(initialPolicy.presets?.map(tag => tag.id)) === JSON.stringify(["minimal", "web-html"]),
    "Coding presets should contain only minimal and HTML by default");
  for (const id of ["minimal", "web-html"]) {
    await pickTag(id);
    const route = await field(routeField) as HTMLSelectElement;
    assert(route.value === "" && initialPolicy.presets?.find(tag => tag.id === id)?.pstackRoute === undefined,
      id + " should follow the poteto setting without an implicit route override");
    assert([...route.options].find(option => option.value === "")?.textContent === "跟随 poteto 设置",
      "Default route must explain that it follows poteto settings");
    assert([...route.options].find(option => option.value === "auto")?.textContent === "由 poteto 按本次任务选择",
      "Automatic routing must explain selection by the current task");
  }
  await pickTag("minimal");
  await enter(routeField, "prototype");
  await button("保存");
  await until(() => !document.querySelector<HTMLButtonElement>(".modes-editor-actions .primary")?.matches(":enabled"), "tag route save");
  assert((await readPolicy()).presets?.find(tag => tag.id === "minimal")?.pstackRoute === "prototype", "Explicit tag route did not reach disk");
  await pickTag("web-html");
  assert((await field(routeField)).value === "", "Changing minimal must not override HTML's poteto setting");
  await pickTag("minimal");
  assert((await field(routeField)).value === "prototype","Saved tag route not displayed");
  await button("pstack 工作流");
  assert(!(await field(activation) as HTMLInputElement).checked, "Builtin workflow should start disabled");
  assert((await field(thermosActivation) as HTMLInputElement).checked, "Thermos should initially be enabled within pstack");
  await toggle(thermosActivation);
  assert(!(await field(activation) as HTMLInputElement).checked, "Thermos preference must not enable the pstack workflow");
  assert(document.querySelector(".pstack-top")?.textContent?.includes("所有代码开发任务"), "The switch must explain its mode-wide scope");
  assert(document.querySelectorAll(".pstack-list button").length === PSTACK_SKILLS.length, "Incomplete skill catalog");
  for (const skill of PSTACK_SKILLS) {
    await selectItem(skill.id);
    for (const p of skill.parameters) await field(p.label);
    assert(document.querySelector(".pstack-rules")?.textContent?.includes(skill.instructions), "Missing rules " + skill.id);
    assert(document.querySelectorAll(".pstack-stages li").length === (skill.stages?.length ?? 0), "Missing skill stages " + skill.id);
  }
  await enter("技能类别", "principle");
  assert(document.querySelectorAll(".pstack-list button").length === PSTACK_SKILLS.filter(skill => skill.kind === "principle").length, "Incomplete principle catalog");
  await enter("搜索当前分类", "principle-attack-the-premise");
  await toggle("启用此原则");
  await enter("技能类别", "");
  await enter("搜索当前分类", "samplesPerVariant");
  await enter("每个方案测量次数", "7");
  await enter("搜索当前分类", "verificationCommands");
  const commandField = PSTACK_SKILLS.find(skill => skill.id === "poteto-mode")!.parameters.find(p => p.id === "verificationCommands")!;
  assert(await field(commandField.label) instanceof HTMLTextAreaElement, "Project checks need a multiline editor");
  await enter(commandField.label, "pnpm -s typecheck\npnpm -s test:workflow");
  await enter("搜索当前分类", "no-item-matches-this");
  assert(document.querySelector(".pstack-empty"), "Missing empty search state");

  await selectSection("流程");
  assert(document.querySelectorAll(".pstack-list button").length === PSTACK_PLAYBOOKS.length, "Incomplete playbook catalog");
  for (const book of PSTACK_PLAYBOOKS) {
    await selectItem(book.id);
    assert(document.querySelectorAll(".pstack-stages li").length === book.stages.length, "Incomplete playbook " + book.id);
    for (const p of book.parameters) await field(p.label);
  }
  await selectItem("eval");
  await enter("评判项数量", "5");
  await toggle("启用此流程");
  await selectItem("feature");
  const summaries = [...document.querySelectorAll<HTMLElement>(".pstack-stages summary")];
  summaries.find(el => el.textContent === "比较架构")!.click();
  await button("架构设计");
  await field("实现前等待确认");
  await toggle("实现前等待确认");
  await selectSection("模型角色");
  await selectItem("architect-runners");
  await until(() => document.body.innerText.includes("需配置 2 个不同的可用模型，目前有 1 个"), "distinct-model preflight");

  assert(document.querySelectorAll(".pstack-list button").length === PSTACK_ROLES.length, "Incomplete role catalog");
  for (const role of PSTACK_ROLES) {
    await selectItem(role.id);
    for (const f of ["模型选择", "推理预算"]) await field(f);
    if (role.id === "arena-cross-judge") {
      await enter("模型选择", "diverse");
      const count = await field("裁判候选池大小") as HTMLInputElement;
      assert(count.min === "1", "A single eligible judge must be selectable");
      await enter("裁判候选池大小", "1");
      assert(!document.querySelector('select[aria-label="工作目录隔离"]') && document.body.innerText.includes("只读独立文档空间"), "Judge exposed ineffective isolation settings");
      await until(() => document.body.innerText.includes("可供选取的一名裁判"), "candidate-pool readiness");
    } else {
      await field("代理数量"); await field("工作目录隔离");
      if (role.id === "arena-runners") assert(document.body.innerText.includes("受控评估始终给每位作者分配独立文档空间"), "Missing author isolation semantics");
    }
  }
  await selectItem("architect-runners");
  await enter("模型选择", "fixture/alpha");
  await enter("代理数量", "3");
  await enter("推理预算", "medium");
  await enter("工作目录隔离", "worktree");
  const limits = document.querySelector<HTMLDetailsElement>(".pstack-host-settings")!;
  limits.querySelector("summary")!.click();
  await enter("单批任务上限", "8");
  await enter("最多同时运行", "2");
  await button("保存并行限制");
  await until(() => limits.innerText.includes("并行限制已保存"), "parallel settings echo");
  await enter("为 diverse 添加候选模型", "fixture/beta", "");
  await button("保存设置");
  await until(() => limits.innerText.includes("执行限制已保存"), "global model pool save");

  await selectSection("Thermos 审查");
  for (const condition of THERMOS_CRITERIA) await field(condition.label);
  await enter("变更行数阈值", "-1");
  await button("保存");
  await until(() => [...document.querySelectorAll("button")].some(b => b.textContent?.trim() === "保存" && !b.disabled), "invalid draft remains editable");
  assert(!(await readPolicy()).pstackThermos, "Invalid draft must not be written to disk");
  await enter("变更行数阈值", "37");
  await enter("单文件行数阈值", "780");
  await enter("分散特例数量阈值", "4");
  await enter("审查角色", "judgment");
  await toggle("合并前评审");
  await toggle("类型边界");
  await toggle(activation);
  const otherWindow = await readPolicy();
  await window.api!.agent.saveModePolicy("coding", { ...otherWindow, presets: [
    ...(otherWindow.presets ?? []), { id: "parallel-editor", label: "另一窗口的个人标签" },
  ] });
  await save();
  const policy = await readPolicy();
  const config = policy.pstackThermos!;
  assert(policy.pstackThermosEnabled, "App did not enable workflow");
  assert(!config.skills["thermo-nuclear-code-quality-review"].enabled && config.skills["poteto-mode"].enabled,
    "Saving Thermos off must keep poteto enabled");
  assert(policy.presets?.some(tag => tag.id === "parallel-editor"), "A workflow save overwrote changes in another mode settings window");
  assert(config.skills["benchmark-checklist"].parameters.samplesPerVariant === 7 && !config.skills["principle-attack-the-premise"].enabled, "Lost skill edits");
  assert(config.skills.architect.parameters.checkpoint === true && config.playbooks.eval.parameters.rubricCount === 5 && !config.playbooks.eval.enabled, "Lost playbook edits");
  assert(config.skills["poteto-mode"].parameters.verificationCommands === "pnpm -s typecheck\npnpm -s test:workflow", "Lost multiline project checks");
  assert(config.roles["architect-runners"].count === 3 && config.roles["architect-runners"].model === "fixture/alpha" &&
    config.roles["architect-runners"].effort === "medium" && config.roles["architect-runners"].isolation === "worktree", "Lost role edits");
  assert(config.thermos.changedLines === 37 && config.thermos.fileLines === 780 && config.thermos.specialCases === 4 &&
    !config.thermos.beforeMerge && !config.thermos.criteria["type-boundaries"] && config.thermos.reviewerRole === "judgment", "Lost review edits");
  root.unmount();
  root = createRoot(mount);
  root.render(<ModesTab />);
  await openEditor();
  assert((await field(activation) as HTMLInputElement).checked, "Reopen lost activation");
  assert(!(await field(thermosActivation) as HTMLInputElement).checked, "Reopen lost independent Thermos preference");
  await selectSection("Thermos 审查");
  assert((await field("变更行数阈值")).value === "37", "Reopen lost changed threshold");
  await toggle(activation);
  await save();
  const off = await readPolicy();
  assert(!off.pstackThermosEnabled && JSON.stringify(off.pstackThermos) === JSON.stringify(config), "Deactivation dropped settings");
  const panel = document.querySelector<HTMLElement>(".pstack-settings")!;
  panel.style.width = "320px";
  await selectSection("流程");
  assert(panel.scrollWidth <= panel.clientWidth + 1, "Narrow settings need horizontal scrolling");
  await selectItem("feature");
  panel.style.width = "";
  panel.scrollTop = 0;
  window.scrollTo(0, 0);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return `PASS Electron ModesTab → isolated ModeProfileStore: ${PSTACK_SKILLS.length} skills, ${PSTACK_SKILLS.filter(skill => skill.kind === "principle").length} principles, ${PSTACK_PLAYBOOKS.length} playbooks, ${PSTACK_ROLES.length} roles, ${THERMOS_CRITERIA.length} review criteria, validation, global controls, independent Thermos toggle, save, reopen, disable, narrow layout.`;
}

export async function resetAndVerify() {
  const before = await readPolicy();
  await button("恢复");
  await button("恢复默认");
  await until(() => document.body.innerText.includes("已恢复为出厂默认"), "restored profile");
  const after = await readPolicy();
  assert(!after.pstackThermosEnabled && !after.pstackThermos, "Reset must clear builtin overrides");
  assert(JSON.stringify(after.skillPolicy) === JSON.stringify(before.skillPolicy) &&
    JSON.stringify(after.presets) === JSON.stringify(before.presets), "Reset changed sibling policies");
  return "PASS reset only the builtin configuration";
}
