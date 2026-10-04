---
name: kicad-design
description: Guide AI-driven KiCad 10 schematic and PCB work through the configured `kicad` MCP. Use this skill to choose between live PCB IPC tools, file-based schematic tools, kicad-cli validation/export, and the run_kicad_script escape hatch; enforce read-before-write discipline and safe handling of unsaved/open projects.
version: 1.0.0
status: active
scope: general
tags:
  - kicad
  - pcb
  - schematic
  - electronics
  - mcp
  - ipc-api
  - kicad-cli
triggers:
  - 用 KiCad 做
  - 用 KiCad 修改
  - 用 KiCad 检查
  - 帮我看这个 KiCad 板子
  - 帮我改这个 KiCad PCB
  - 帮我改这个 KiCad 原理图
  - KiCad PCB review
  - KiCad 原理图检查
  - KiCad DRC
  - KiCad ERC
  - 定位 KiCad 元件
  - 查看 KiCad 网络
  - edit this KiCad board
  - inspect this KiCad schematic
---

# KiCad Design

## Purpose
Provide a thin, reusable execution methodology above the configured MyBuddy MCP named `kicad`.

This skill does **not** replace KiCad, `lucatib/kicad-mcp`, `kicad-cli`, or `pcbnew`.
It tells the AI which capability to use, in what order, what must be checked before writing, and how to avoid common KiCad 10 IPC/file-mode mistakes.

Principle:

`Skill 管方法论，kicad MCP 管实际执行。`

## Required Execution Path
Use the MyBuddy MCP named:

`kicad`

Expected workstation environment:
- KiCad: 10.0.6
- KiCad bundled Python: 3.11.5
- KiCad IPC API: enabled
- `pcbnew`: 10.0.6
- `kicad-python` / `kipy`: 0.8.0
- MCP SDK: 2.1.1
- `kicad-mcp` repo: `C:\Users\servi\Documents\GitHub\kicad-mcp`
- MCP Python: `C:\Users\servi\Documents\GitHub\kicad-mcp\.venv\Scripts\python.exe`
- KiCad CLI: `C:\Program Files\KiCad\10.0\bin\kicad-cli.exe`

The MCP is registered in MyBuddy `design` mode.

Do not replace the MCP with GUI clicking for normal KiCad inspection/editing when the MCP/API can perform the task.

## Capability Boundary

Live PCB operations use official IPC on the API-served board; schematic operations are file-based and must not overwrite unsaved GUI changes. Dedicated tools precede run_kicad_script. Read this map for tool selection: [references/capability-routing.md](references/capability-routing.md).

## First-Call Discipline
For a new KiCad task, normally call `kicad_status` **once** first.

Use its result to decide the path:
- `live.connected=true` and `board_open=true` -> use live PCB tools.
- `live.connected=true` but `board_open=false` -> KiCad is reachable, but the target PCB Editor is not exposed to the API.
- schematic-only work -> file-based tools can work without live PCB IPC.

Do not poll `kicad_status` repeatedly. Re-check only after the user opens/closes/restarts KiCad, changes projects, or after a connection failure that has actually been corrected.

## Standard Read-Only Workflow
When the user asks to inspect, review, explain, locate, compare, or diagnose a KiCad project, default to **read-only**.

1. Call `kicad_status`.
2. Confirm the actual board/project being inspected. Never assume the visible window is the API-served board.
3. For PCB orientation, call `get_board_summary` before broad enumeration.
4. Query only the information needed for the question.
5. Report facts from the board/schematic separately from engineering interpretation.
6. Do not run write tools just to “test” capability.

Useful routing examples:
- Board size/complexity/layer count -> `get_board_summary` + `get_layers` / `get_stackup`
- Find component by ref -> `get_footprint(reference=...)`
- Browse component family -> `list_footprints(reference="R*")` or another narrow filter
- Inspect a net -> `list_nets(name=...)` then `list_tracks_vias(net=...)`
- Inspect copper pours -> `list_zones`
- Understand what the user currently selected -> `get_selection`
- Read schematic structure -> `open_schematic` then `list_schematic_symbols` / `schematic_netlist`
- Locate project files -> `find_project_files`

Prefer a narrow query over dumping the whole board.

## Read-Before-Write Rule
Before any actual design modification:

1. Identify the exact target board or schematic path.
2. Read the target object/net/symbol first.
3. Read nearby or dependent context needed to avoid collateral changes.
4. Decide whether the requested change belongs to live PCB IPC, file-based schematic editing, or `run_kicad_script`.
5. Make the smallest change that satisfies the request.
6. Re-read the changed object after the write.
7. Run the smallest relevant validation.

Do not make speculative cleanup changes, mass-renames, broad re-routing, library substitutions, or formatting-only rewrites unless the user explicitly asks.

## PCB Editing Policy
The curated MCP surface is primarily read-oriented for live PCB access.
When the user explicitly asks to modify a PCB and no dedicated curated write tool exists:

1. Confirm `board_open=true`.
2. Read the exact footprint/net/track/zone involved.
3. Use `run_kicad_script` with a small, purpose-specific script.
4. Prefer the official live `board`/`kipy` API for in-memory board edits.
5. Do not import unrelated modules or touch unrelated filesystem/process/network state.
6. Save only when the user requested an actual persistent edit.
7. Re-read the edited item through curated MCP tools when possible.
8. Run targeted DRC when the edit affects connectivity, copper, clearance, vias, zones, or board rules.

For nontrivial or destructive scripted PCB changes, create a backup/copy of the exact `.kicad_pcb` before writing when practical.

Do not silently reload the board from disk while the user has unsaved GUI edits.

## Schematic Editing Policy
Schematic editing is file-based, not live IPC.
This creates an important unsaved-state hazard.

Before writing an existing `.kicad_sch`:
- Resolve the exact file path.
- Read it with `open_schematic` / `list_schematic_symbols` first.
- If the schematic is currently open with unsaved GUI changes, **do not overwrite the disk file**. Ask the user to save first, or postpone the file-based write.
- Create a backup before modifying an existing schematic file because the current editor implementation writes the file directly and does not create an automatic `.bak` itself.

Prefer dedicated write tools over hand-written S-expression manipulation:
1. `add_symbol_to_schematic`
2. `mark_pins_unused`
3. `rewire_power_symbol`
4. `add_decoupling_capacitors`
5. `create_pinout_schematic` for new generated schematics
6. `run_kicad_script` only when necessary

After schematic writes:
- Re-open/read the schematic.
- Run ERC when the change affects connectivity/power/pin use and the user expects a validated result.
- Do not claim a GUI-unsaved schematic was modified unless the change actually exists in the saved file.

## DRC / ERC / Export Routing
Use the domain-specific command rather than scripting it manually.

- Schematic electrical validation -> `run_erc`
- PCB design-rule validation -> `run_drc`
- BOM -> `export_bom`
- Schematic PDF/SVG export -> `export_schematic`

Do not run broad ERC/DRC automatically for a pure read-only question.
After an edit, use the smallest validation that can catch mistakes introduced by that edit.

Treat pre-existing violations separately from violations caused by the current change.

## Symbol / Library Workflow
When selecting or adding a symbol:

1. `list_symbol_libraries` only if library context is needed.
2. `search_symbols(query=...)` with a narrow query.
3. `get_symbol_pins(lib_id=...)` before wiring or generating a pinout.
4. Confirm power pins, no-connect pins, and alternate functions before generating connections.

Do not guess pin numbers from memory when the installed symbol library can answer directly.

## Imported-Project Awareness
Boards imported from EasyEDA/JLCEDA or other EDA tools may contain:
- imported custom footprint libraries
- blank value fields
- pad-only footprints with empty references
- generic net names such as `$1Nxx`
- renamed layers carried over from the source tool

Do not treat these conditions as MCP failures by themselves.
Use the actual board connectivity, reference data, schematic context, and imported library IDs before deciding something is broken.

For `.epro` / EasyEDA Pro migration itself, use the separate `epro2kicad` skill. This skill begins after a KiCad project/board/schematic exists or when the user wants general KiCad design work.

## IPC Troubleshooting

When disconnected or the intended editor is not API-served, read this recovery path; never kill unrelated instances or retry unchanged conditions: [references/ipc-troubleshooting.md](references/ipc-troubleshooting.md).

## Multiple-Instance Discipline
KiCad can leave multiple project/editor processes alive.
Always trust `kicad_status.board_name` over assumptions based only on a visible window title.

Before a write:
- confirm the MCP-reported board name is the intended board;
- if ambiguous, stop and resolve the instance/project mapping first.

This prevents editing the wrong open board.

## Validation Gates
A KiCad task is not complete merely because a tool returned without exception.

For PCB changes, check as applicable:
- intended reference/net was modified
- layer is correct
- position/rotation are correct
- pad/net association is preserved
- routing/zone operation did not affect unrelated nets
- DRC is acceptable for the scope of the change

For schematic changes, check as applicable:
- intended symbol exists
- reference/lib_id/pins are correct
- wires/labels connect the intended nets
- power symbols are correct
- no-connect state is intentional
- ERC is acceptable for the scope of the change

For read-only tasks, validation means cross-checking the relevant MCP queries, not changing the design.

## Failure Handling
If a curated tool fails:
1. Read the error and remedy.
2. Fix the stated precondition if possible.
3. Retry once after the precondition changes.
4. Use `run_kicad_script` only if the curated surface genuinely lacks the capability.

Do not convert every problem into arbitrary Python immediately.
Do not repeatedly retry a broken live IPC call when the board/editor precondition is unchanged.

If a file-based schematic tool would conflict with unsaved GUI state, stop before writing.

## Engineering Reporting
A successful user-facing result should state only what matters:
- board/schematic actually operated on
- what was read or changed
- key references/nets/layers involved
- validation performed and its result
- saved file path when a persistent write/export occurred
- meaningful warnings or unresolved constraints

Do not dump all 27 MCP tools or the full internal workflow unless the user asks.

## Verified Acceptance Baseline
The local chain has been validated end-to-end as:

`MyBuddy -> kicad MCP -> KiCad 10 official IPC API -> currently open PCB`

and separately:

`MyBuddy -> kicad MCP -> .kicad_sch parser / kicad-cli`

See `references/validated-environment.md` for the concrete acceptance data captured on 2026-09-05.

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
