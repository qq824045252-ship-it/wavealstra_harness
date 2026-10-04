---
name: ansys-simulation
description: Guide AI-driven Ansys Electronics Desktop simulations through the configured `ansys-aedt` MCP. Use this skill to choose the right AEDT solver, plan the model, enforce setup/validation gates, execute through MCP, and report real simulation results without confusing analytical estimates with solver output.
version: 1.1.0
status: active
scope: general
tags:
  - ansys
  - aedt
  - pyaedt
  - maxwell
  - hfss
  - q3d
  - electromagnetic-simulation
triggers:
  - 用 ansys 仿真
  - 用 maxwell 仿真
  - 用 hfss 仿真
  - 用 q3d 仿真
  - ansys 电磁仿真
  - maxwell 静电仿真
  - 电容场仿真
  - 寄生参数仿真
  - electromagnetic simulation in AEDT
---

# Ansys Simulation

## Purpose
Provide a thin, reusable simulation methodology layer above the configured `ansys-aedt` MCP.

This skill does **not** replace PyAEDT, AEDT, or the MCP server. It tells the AI how to choose the solver, sequence the work, validate the setup, handle MCP limitations, and interpret results.

Principle:

`Skill 管方法论，MCP 管实际执行。`

## Required Execution Path
Use the MyBuddy MCP named:

`ansys-aedt`

Expected environment:
- AEDT: 2026 R1 / 2026.1
- MCP: official `ansys/pyaedt-mcp`
- PyAEDT-backed execution over AEDT gRPC

Do not replace the MCP with GUI clicking unless the MCP/AEDT APIs cannot perform the required operation.

## Solver Routing
Choose the solver before creating geometry.

- Electrostatic field, electrode capacitance, charge, guard/shield sensitivity -> **Maxwell 3D Electrostatic**
- Primarily 2D cross-section electrostatics or magnetics with valid translational/axisymmetric assumptions -> **Maxwell 2D**
- Conductor/package/interconnect parasitic R/L/C/G extraction -> **Q3D**
- High-frequency full-wave RF/microwave structures, resonances, S-parameters, antennas -> **HFSS**
- Circuit/system co-simulation -> **Circuit**
- Low-frequency magnetic components, coils, motors, inductive structures -> **Maxwell 2D/3D** as geometry requires

If solver choice is materially ambiguous, explain the tradeoff briefly and choose the solver that matches the requested quantity of interest.

## Pre-flight
Before building a model:
1. Call the `ansys-aedt` MCP status/installation capability.
2. Confirm AEDT version and connection state.
3. Detect whether an existing AEDT session is suitable before launching another one.
4. Confirm the intended solver and solution type.
5. Establish model units explicitly.
6. Identify required material properties and their units.
7. Identify the requested output quantity before selecting setup details.

Do not start by generating a large Python script blindly.

## Standard Workflow
Use this sequence unless the solver requires a different order:

1. Define objective and quantity of interest.
2. Select solver and solution type.
3. Define units and parameters.
4. Create/import geometry.
5. Assign materials.
6. Create surrounding region when required.
7. Assign excitations and boundaries.
8. Define matrix/ports/sources needed for the requested result.
9. Create mesh controls only where justified; otherwise begin with adaptive/default meshing.
10. Create solution setup.
11. Validate design before solving when the MCP exposes validation.
12. Solve through AEDT.
13. Read actual solver results.
14. Compare against analytical/simple sanity checks where available.
15. Save the `.aedt` project and export requested numeric results.
16. Report warnings, convergence quality, assumptions, and result provenance.

## Electrostatic / Capacitance Rules
For capacitance simulations:
- Prefer Maxwell 3D Electrostatic for finite 3D electrode structures.
- Define conductor potentials explicitly, commonly one conductor at 1 V and reference conductor at 0 V for simple validation cases.
- Create a capacitance matrix when the user needs conductor-to-conductor capacitance or multi-electrode coupling.
- Include guard, shield, dielectric coatings, grounded metal, and surrounding dielectric when they materially influence the electric field.
- Keep the outer region far enough from the electrodes that artificial boundaries do not dominate the result.
- For differential sensors, extract the full capacitance matrix rather than only one scalar when practical.
- Do not infer ppm sensitivity directly from capacitance unless dielectric-property-to-concentration assumptions are explicitly defined.

### Electrostatic pitfalls

Before creating an electrostatic design, assigning voltage faces or reading a capacitance matrix, read the verified API pitfalls: [references/electrostatic-pitfalls.md](references/electrostatic-pitfalls.md).

## Validation Gates
A simulation is not considered complete merely because AEDT returned without an exception.

Check, as applicable:
- geometry dimensions and relative placement
- model units
- material assignment
- permittivity / conductivity / permeability values
- excitation magnitude and reference
- boundary conditions
- region size and boundary placement
- matrix/port/source definitions
- mesh/adaptive convergence
- solver convergence / residual or adaptive pass status
- requested result exists and has correct units
- result magnitude is physically plausible

For simple models, compare against an analytical result. Report both values separately.

## Result Provenance Discipline
Never present an analytical estimate as an AEDT result.

Always distinguish:
- **AEDT simulated result**
- **analytical/reference result**
- **difference / deviation**

If solve or result extraction fails, do not fabricate or back-fill the missing solver value from a formula.

## MCP Fallback Policy
Prefer high-level dedicated MCP tools first.

Fallback order:

1. Dedicated `ansys-aedt` MCP tool.
2. `run_python_code` with PyAEDT APIs inside the existing MCP/AEDT session.
3. `run_python_code` with AEDT native APIs (`odesktop`, `oproject`, `odesign`) when the high-level PyAEDT wrapper is the failure point.

Do not repeatedly retry the same failing call.

If `create_design` or `launch_aedt(application=...)` fails while the base AEDT connection works:
- stop retrying that wrapper;
- keep the current MCP session if healthy;
- use `launch_aedt` for Desktop only if needed;
- create or activate the design through PyAEDT/native AEDT APIs via `run_python_code`;
- continue only after confirming the active project/design is valid.

If the gRPC object/session becomes invalid (`NoneType`, missing `objectID`, invalid active design), do not keep issuing dependent tool calls. Report the failure boundary and recover with a clean AEDT session.

### Python execution

Keep model → assign → solve → read → save in one run_python_code block when relying on PyAEDT object state. Separate calls may see empty setups. Read session details before this fallback: [references/python-session.md](references/python-session.md).

## Session Discipline
Avoid unnecessary AEDT instances.

- Reuse one healthy session for one task.
- Do not launch multiple AEDT sessions merely because one MCP call is slow.
- Long solver calls are not evidence of failure by themselves.
- Do not poll aggressively.
- When creating temporary sessions for validation, close them cleanly if the API supports it.

## Engineering Reporting
A successful result should state:
- solver and solution type
- AEDT version
- project/design name
- key geometry and material assumptions
- excitation/boundary summary
- setup name
- solve/validation status
- requested numeric result with units
- convergence or adaptive-pass evidence when available
- analytical/reference comparison when relevant
- warnings/errors
- saved project/export paths

## Minimal First Acceptance Case
For a first Maxwell 3D electrostatic test, a useful sanity model is:
- two PEC plates
- each 25 mm x 25 mm
- 1 mm face-to-face vacuum gap
- top = 1 V
- bottom = 0 V
- extract capacitance matrix

Ideal infinite-plate estimate:

`C = epsilon0 * A / d ≈ 5.53 pF`

The AEDT result may differ due to finite-plate fringing. Treat 5.53 pF as a reference, not as the expected exact solver output.

See `scripts/electrostatic-cmatrix.py` for a **verified working template** that implements this model end-to-end in one `run_python_code` block, including all workarounds for known bugs.

## User-facing Behavior
For normal user requests, do not dump this entire workflow back to the user. Execute it internally and report the important engineering decisions and results.

For example, a request such as:

`用 Maxwell 仿真这个差分电容探头，看看 guard 和 PFA 对灵敏度的影响`

should be expanded internally into the appropriate geometry/material/boundary/matrix/sweep/convergence workflow and then executed through `ansys-aedt` MCP.

## References
This skill ships with:
- `references/validated-environment.md` — validated AEDT 2026.1 environment
- `references/known-bugs.md` — known PyAEDT 1.5.0 bugs and workarounds (updated from real execution)
- `scripts/electrostatic-cmatrix.py` — verified parallel-plate capacitance simulation template

## Boundary / Output Contract

交付已保存工程和请求的结果，包含单位、收敛证据、假设、警告；求解失败不得用解析公式伪装结果。单纯解释电磁概念、其他仿真软件或 PCB 布线不触发。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
