---
name: loop-agent
description: |
  Write AGENTS.md / project docs that force AI coding agents (Codex, Claude Code,
  Cursor, Copilot, Gemini CLI) into a self-verifying loop instead of a
  single-shot Q&A. Use when the user asks how to make an agent verify its own
  work, when an existing AGENTS.md isn't producing real verification behavior,
  when the agent keeps claiming "done" without evidence, or when authoring /
  auditing AGENTS.md / CLAUDE.md / codex.md style files. Distilled from
  OpenAI Codex's own AGENTS.md, obra/superpowers SKILLs, and applied to a
  real project (VIVION web). References include a copy-paste template, the
  Iron Law / Gate Function / HARD-GATE / TDD-loop patterns, a checklist for
  auditing existing docs, and a library of design patterns.
---

# loop-agent — How to Write AGENTS.md That Loops

The most common failure mode of AI coding agents: they answer once and stop.
They write code, say "done", and never check the work. This skill teaches you
to author `AGENTS.md` (and equivalents) that **mechanically force** agents
into a self-verifying loop. The patterns come from OpenAI Codex's own
AGENTS.md, obra/superpowers, and the constraints that actually work in
practice.

> **TL;DR** — Combine four constructs: an **Iron Law**, **HARD-GATEs** for
> non-trivial work, a **Gate Function** (5-step) before any completion claim,
> and a **TDD loop** for behavior changes. Without all four, agents regress
> to single-shot Q&A.

## When to use this skill

Use this skill when ANY of:

- User asks "怎么让 agent 自己验证 / 自己 loop / 不只答一句"
- User asks to write / improve / audit an `AGENTS.md`, `CLAUDE.md`,
  `codex.md`, `.codex/instructions.md`, `.cursor/rules/*.md`, or similar
- Agent keeps saying "完成了" / "looks good" / "should pass" with no evidence
- Existing AGENTS.md is descriptive prose with no commands, no gates, no
  evidence contract
- User mentions "Codex 工作流" / "Superpowers" / "TDD for agents"

Do NOT use this skill for:

- General prompt engineering for one-off tasks (use plain prompting)
- Non-coding agents (this skill is opinionated for software engineering)
- Adding automated test frameworks (separate concern; this skill provides the
  verify script template, not the test runner)

## Quick start

1. **Audit** the existing `AGENTS.md` against the
   [checklist](references/checklist.md). Score it 0–10.
2. **Copy** the [template](references/template.md) to the project root as
   `AGENTS.md`. Customize the §1 structure, §2 commands, §4 evidence rows.
3. **Wire** the verification script (`scripts/verify-stack.*`) into a
   runnable command. `verify-stack.ps1` from the working example is in
   [references/gate-function.md §4](references/gate-function.md).
4. **Test the loop**: give the agent a 3-step task and watch whether it
   pauses for design approval, runs `verify-stack`, and pastes fresh
   evidence. If not — re-audit.
5. **Iterate** using [design-patterns.md](references/design-patterns.md)
   whenever a failure mode recurs.

## The four constructs (one-screen summary)

### 1. Iron Law

One-line total rule, repeated in every skill / sub-doc. Violating the letter
= violating the spirit. Example:

```
NO CODE CHANGE WITHOUT FRESH VERIFICATION EVIDENCE.
NO COMPLETION CLAIM WITHOUT PROOF (exit code + output).
```

Full breakdown: [references/iron-law.md](references/iron-law.md).

### 2. HARD-GATE

Wrap any non-trivial task in a `<HARD-GATE>` HTML block. The agent MUST stop
and request approval before proceeding. Use for:

- Multi-file changes
- Schema / API contract / route structure changes
- Anything that touches external state (DB, network, deploy)

Triggers, examples, and the exact wording pattern:
[references/design-patterns.md §1](references/design-patterns.md).

### 3. Gate Function (5 steps)

Before any "done / pass / OK" claim:

```
1. IDENTIFY  → which command proves this?
2. RUN       → run it fresh, foreground, complete
3. READ      → full output, exit code, failure count
4. VERIFY    → does output confirm the claim?
                NO  → state actual status + evidence
                YES → state claim WITH evidence (command + tail)
5. ONLY THEN → make the claim
```

Pair with the **4-Item Evidence Contract** (paste back command / exit /
stdout-tail / stderr-tail). Without all four, the claim is rejected. Full
spec: [references/gate-function.md](references/gate-function.md).

### 4. TDD Loop (for behavior changes)

Without automated tests, substitute the closest probe (curl, SQL probe,
port-check, build, lint). Same RED → GREEN → REFACTOR cycle, but with
probes instead of unit tests:

```
RED: write a failing probe
  ↓ (verify it actually fails for the right reason)
GREEN: minimal change
  ↓ (verify it passes AND no regression)
REFACTOR: clean up
  ↓ (verify still green)
loop
```

Full loop diagram + examples:
[references/design-patterns.md §2](references/design-patterns.md).

## What this skill explicitly avoids

These are common anti-patterns that look right but fail:

| Anti-pattern | Why it fails |
|--------------|--------------|
| "请确保代码质量" | Vague, no command, agent skips |
| "修改后请运行测试" | Optional, agent may skip if no tests exist |
| "如失败请修复" | No retry loop, no exit-code requirement |
| Long prose without commands | Models skim, ignore |
| One mega-AGENTS.md for everything | No progressive disclosure |
| "I think it works" / "should pass" | Lies, no evidence |
| Trust subagent "done" reports | Subagents lie too |

If the user shows you an AGENTS.md that does these, point it out and offer
to restructure it.

## Files in this skill

- [references/template.md](references/template.md) — Copy-paste `AGENTS.md`
  template, parameterised by project
- [references/iron-law.md](references/iron-law.md) — Iron Law + anti-rationalization
- [references/gate-function.md](references/gate-function.md) — Gate Function + Evidence Contract + verify-stack.ps1 skeleton
- [references/checklist.md](references/checklist.md) — Audit scoring (0-10) + per-section checks
- [references/design-patterns.md](references/design-patterns.md) — HARD-GATE patterns, TDD-loop diagrams, chunking, dot-graphs, Red Flags tables, project-type adaptations

## Source of truth

- OpenAI Codex repo's own `AGENTS.md`:
  <https://github.com/openai/codex/blob/main/AGENTS.md>
- obra/superpowers (the gold standard for loop-style skills):
  <https://github.com/obra/superpowers>
- Working example for this skill (VIVION web, Windows + PowerShell):
  `C:\Users\servi\Desktop\web\AGENTS.md`,
  `app/AGENTS.md`, `server/AGENTS.md`,
  `docs/skills/{verification-before-completion,tdd-loop}.md`,
  `scripts/verify-stack.{ps1,cmd}`.

## Bottom line

> The agent loops because the **document** loops. The document loops because
> it contains Iron Law + HARD-GATE + Gate Function + TDD-loop. Pick all
> four, or pick none. Half-measures produce agents that loop sometimes —
> which is worse than never.

## Boundary / Output Contract

交付适用仓库的 AGENTS.md/项目规则修改及验证入口；保持授权范围、可执行停止条件，不把无关工作变成强制循环。普通业务代码修复和周报不触发。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
