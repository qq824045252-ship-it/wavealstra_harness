---
name: root-cause-debugging
display_name: 根因调试 · Root Cause Debugging
description: "Investigate recurring or intermittent failures, races, lifecycle ownership, streaming/scrolling timing, performance, cache and IPC consistency, especially previously failed fixes. A first deterministic bug without these mechanisms belongs to dimagent-debug."
version: 1.0.0
---

# Root Cause Debugging

## Purpose

This skill exists to prevent iterative symptom patching.

The goal is NOT:

> make the failing test green

The goal is:

> identify the mechanism that produces the observed failure, prove that
> mechanism from runtime/code/dependency behavior, remove the conflicting
> ownership or invalid assumption, and then apply the smallest coherent fix.

A successful debugging session must explain both:

1. Why the bug happened.
2. Why the proposed change makes that mechanism impossible or controlled.

---

## Intent

可重复的运行时 Bug 的根因定位与最小一致修复，而非症状打补丁。覆盖：滚动/流式/生命周期/虚拟化/Observer/动画/异步状态/并发/IPC/缓存/重试/竞态/Electron-浏览器运行时/性能，以及“已修但复现 / 测试通过但实际失败”。

## Trigger

Use this skill when the request clearly matches the intent above.

Positive examples:
- 滚动时还是会闪，之前修过又出现了，还是闪/还是会跳
- 流式输出时手动向上滚动会被拉回到底部，测试通过但实际不行
- 虚拟列表 + Markdown 流式闪烁，已经加过 flag 还是会闪
- 并发/IPC/缓存/重试逻辑时好时坏，来回打补丁越补越乱
- 之前修过同一症状，附近又出现了新症状（patch stacking）

Negative examples:
- 帮我写一个新功能的需求文档（无 Bug 上下文）
- 翻译这段论文摘要（纯文本任务）
- 生成一张产品海报图（生图任务）

## Boundary

Do not invoke this skill for unrelated work. 当是首次出现的简单一次性 Bug 且无复发/竞态/生命周期混淆时，优先走常规修复；本技能用于“已复发/间歇/运行时/多所有者/补丁堆叠”场景。User instructions and safety constraints override this skill.

---

## 1. Trigger Conditions

以下 UI/runtime/scrolling/IPC 条件均以反复失败、间歇性或复杂状态/时序机制为前提；普通首次确定性错误走 dimagent-debug。

Activate this skill when ANY of the following is true:

- The same user-visible bug has already been patched once and still exists.
- A previous fix created a new symptom nearby.
- The bug is intermittent or timing-dependent.
- The problem involves:
  - scrolling
  - streaming
  - React lifecycle
  - virtualization
  - observers
  - animation
  - async state
  - concurrency
  - IPC
  - caching
  - retries
  - race conditions
  - Electron/browser runtime behavior
  - performance
- Unit/static tests pass but the real application still fails.
- Multiple components appear to control the same state/resource.
- The current solution is accumulating refs, flags, timers, retries,
  observers, effects, or special-case branches.
- The user says:
  - "还是不行"
  - "又出现了"
  - "还是闪"
  - "还是会跳"
  - "之前修过"
  - "测试通过但实际不行"
  - or equivalent language.

Once triggered, do NOT continue normal patching.

---

## 2. Escalation Rule

### First failed fix

A second implementation attempt is allowed only after reviewing why the
first fix failed.

Do not blindly modify the same mechanism again.

### Second failed fix

STOP WRITING CODE.

Enter Root Cause Investigation Mode.

The next action must be diagnosis, not another patch.

### Third attempt rule

On the third attempt for the same bug, the following are FORBIDDEN unless
their necessity has first been demonstrated from the root cause:

- adding new state
- adding new refs
- adding timers
- adding setTimeout
- adding requestAnimationFrame
- adding retries
- adding debounce/throttle
- adding observers
- adding polling
- adding scroll compensation
- adding synchronization flags
- adding "ignore next event" logic
- adding compatibility branches
- adding another ownership layer

If the current architecture requires these, explain exactly why.

---

## 3. Root Cause Investigation Mode

When entering this mode, do not edit production code.

Perform the following sequence.

### Step A — Define the observable failure

Describe exactly what the user sees.

Bad:

> scrolling is broken

Good:

> while assistant text is streaming, manually scrolling upward causes the
> viewport to return toward the latest message within one frame.

Separate visual symptoms that may have different causes.

Examples:

- viewport movement
- DOM repaint/flicker
- content disappearing
- layout height change
- component remount
- data duplication

Do not treat all of them as one bug.

---

### Step B — Identify all owners

For the affected resource/state, find EVERY writer.

Examples:

For scroll position:

> Who can write scrollTop / scrollTo / scrollToIndex?

For streaming content:

> Who buffers, parses, batches, replaces, or schedules text updates?

For cache:

> Who can insert, invalidate, evict, refresh, or rebuild entries?

For application state:

> Which effects, callbacks, reducers, observers, events, and IPC handlers can
> modify it?

Produce an ownership map:

```
SOURCE
  ↓
WRITER A
WRITER B
WRITER C
  ↓
OBSERVED STATE
```

If multiple independent systems own the same resource, treat ownership
conflict as a primary root-cause candidate.

---

### Step C — Trace the complete event chain

Do not inspect only the line that appears wrong.

Trace:

```
USER / PROVIDER EVENT
        ↓
EVENT HANDLER
        ↓
STATE CHANGE
        ↓
REACT COMMIT
        ↓
LAYOUT / OBSERVER
        ↓
DEPENDENCY INTERNAL BEHAVIOR
        ↓
SECONDARY STATE CHANGE
        ↓
VISIBLE FAILURE
```

Include browser/Electron/library behavior where relevant.

---

### Step D — Read dependency source when behavior is unclear

Do not guess how a dependency behaves.

If the bug depends on:

- TanStack Virtual
- markstream
- React library internals
- editor frameworks
- state managers
- IPC libraries
- caching libraries
- browser APIs

inspect the installed dependency source or authoritative implementation.

Determine:

- what causes reconciliation
- what causes remount
- what schedules RAF/timers
- what changes identity
- what writes layout
- what performs retries
- what replaces DOM
- what changes measurements

Treat dependency implementation as part of the application runtime.

---

### Step E — Build a mechanism hypothesis

A valid hypothesis must have causal form:

```
WHEN X happens
  → Y changes
  → subsystem Z reacts by doing A
  → A causes B
  → user observes C
```

Example:

```
WHEN parsed Markdown top-level node count changes
  → markstream batch state resets
  → visible node count temporarily returns to initial batch
  → existing nodes become placeholders
  → user sees a large block flash.
```

This is much stronger than:

> markstream might be causing flicker.

---

### Step F — Try to falsify the hypothesis

Before modifying production code, ask:

> If this hypothesis is correct, what evidence should exist?

Then inspect for that evidence.

Also ask:

> What observation would prove this hypothesis wrong?

Prefer a small diagnostic probe over another implementation change.

---

## 4. Fix Design Rules

Only after the mechanism is sufficiently supported may production code change.

Prefer fixes in this order:

1. Remove duplicate ownership.
2. Remove redundant scheduling.
3. Remove redundant abstraction.
4. Remove conflicting lifecycle behavior.
5. Change the owner boundary.
6. Simplify state transitions.
7. Only then add new synchronization/state if unavoidable.

Prefer deletion over compensation.

Prefer:

> only one subsystem controls scrolling

over:

> two scrolling systems plus a flag preventing them from fighting.

Prefer:

> disable redundant internal batching

over:

> detect when batching flashes and temporarily hide it.

Prefer:

> keep render context identity stable

over:

> repaint and mask the repaint with CSS.

---

## 5. Runtime Truth Over Test Truth

Tests are evidence, not reality.

Never conclude:

> bug fixed because tests pass

when the original failure is runtime/UI behavior.

For UI/runtime problems distinguish:

```
STATIC TEST
UNIT TEST
INTEGRATION TEST
REAL APPLICATION BEHAVIOR
```

A passing static assertion proves only that the expected architecture exists.

It does NOT prove:

- browser event ordering
- real scroll behavior
- React commit timing
- layout stability
- repaint behavior
- GPU rendering
- observer ordering
- race-condition absence

When direct UI automation is unavailable, explicitly state that visual
behavior has not been physically verified.

Do not overclaim.

---

## 6. Do Not Patch Symptoms

Watch for these warning signs:

```
BUG
 ↓
add flag
 ↓
new bug
 ↓
add another flag
 ↓
special-case effect
 ↓
timeout
 ↓
ignore-next-event ref
 ↓
tests pass
```

This usually means the architecture has lost a clear owner.

STOP.

Return to ownership analysis.

---

## 7. Minimal Coherent Fix

The preferred patch should make the code easier to explain afterward.

After the fix, it should be possible to state a simple invariant.

Examples:

> Only ChatView may directly write the main chat scroll position.

> Markdown rendering uses the provider stream as its only streaming clock.

> Message virtualization belongs to MessageList; Markdown does not run a
> second virtualization layer.

> assistant_end changes business state but does not replace the existing
> Markdown render context.

If no simple invariant can describe the result, reconsider the design.

---

## 8. Verification

Verification must target the root cause.

For every fix, verify:

```
ROOT CAUSE
  ↓
ARCHITECTURAL INVARIANT
  ↓
REGRESSION TEST
  ↓
RUNTIME OBSERVATION WHEN POSSIBLE
```

Do not only test the original symptom.

Also test that the removed conflicting behavior cannot silently return.

Example:

If fixing duplicate scroll ownership:

- assert only one direct scroll writer remains
- assert automatic streaming layout cannot call scrollToIndex
- assert user intent still takes ownership
- test real scrolling if runtime access exists

---

## 9. Final Report Format

At completion, report in this exact conceptual order:

**ROOT CAUSE**

Explain the concrete mechanism.

**EVIDENCE**

State what code/runtime/dependency behavior proves it.

**CHANGE**

Explain what ownership or lifecycle behavior changed.

**WHY THIS FIX**

Explain why the mechanism can no longer occur.

**IMPACT**

State intended behavior changes and meaningful edge cases.

**VERIFICATION**

State tests performed.

**VISUAL/RUNTIME STATUS**

Explicitly distinguish tested behavior from behavior that still requires
human observation.

Do not say "fixed" solely because tests pass.

---

## 10. Stop Conditions

Stop coding and re-investigate when:

- the same symptom survives the proposed fix
- a nearby regression appears
- another workaround becomes necessary
- the explanation of the bug changes after every patch
- more state is required to explain existing state
- two libraries appear to compensate for each other
- tests pass while the user still sees the bug

At that point the previous root-cause hypothesis was incomplete.

Do NOT defend the previous patch.

Discard the hypothesis if evidence contradicts it.

---

## Core Principle

Never ask:

> What code can I add to stop this symptom?

Ask:

> What mechanism makes this symptom inevitable in the current architecture?

Then change that mechanism.

---

## Workflow

Follow §1–§3 to establish the mechanism, §4–§7 to design the smallest coherent fix, then §8–§10 for verification, reporting and re-investigation.

## Routing Boundary

第一次稳定复现、无并发/生命周期/时序问题的普通 bug 交给 dimagent-debug；本 Skill 是复杂机制与失败修复的升级路径。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
