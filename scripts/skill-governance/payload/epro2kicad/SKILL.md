---
name: epro2kicad
description: Convert EasyEDA Pro / JLCEDA Professional .epro projects to KiCad on the user's Windows workstation using the locally installed epro2kicad tool and KiCad native importer. Use for single-board or multi-PCB migration, conversion, packaging, and basic post-conversion validation.
version: 1.0.0
status: active
scope: general
tags:
  - kicad
  - easyeda-pro
  - jlceda
  - pcb
  - migration
triggers:
  - convert epro to kicad
  - import EasyEDA Pro project into KiCad
  - import JLCEDA project into KiCad
  - convert 嘉立创 project to KiCad
  - 嘉立创导入KiCad
  - 嘉立创多PCB导入KiCad
  - epro2kicad
---

# epro2kicad

## Purpose
Use the validated local `epro2kicad` installation to convert EasyEDA Pro / 嘉立创 EDA Professional `.epro` projects into KiCad-ready project files, including multi-PCB projects.

This skill is an execution guide, not a replacement PCB parser. Always use the installed converter and KiCad native importer rather than reimplementing conversion logic.

## When to Use
Use this skill when the user wants to:
- Convert a `.epro` project to KiCad.
- Migrate a 嘉立创 EDA Professional / EasyEDA Pro project to KiCad.
- Convert all PCBs in a multi-PCB `.epro` project.
- Package converted KiCad files as a zip.
- Check whether converted `.kicad_pcb` files can be loaded by the installed KiCad.

## When Not to Use
Do not use this skill for:
- Editing or designing a KiCad schematic/PCB after migration.
- General KiCad automation, routing, ERC/DRC, BOM, Gerber, or simulation.
- EasyEDA Standard JSON projects that are not EasyEDA Pro `.epro` exports.
- Recreating schematics headlessly: the current converter does not provide headless EasyEDA Pro schematic conversion.

## Required Environment
Expected workstation paths:
- Converter repo: `C:\Users\servi\Documents\GitHub\epro2kicad`
- Windows launcher: `C:\Users\servi\Documents\GitHub\epro2kicad\epro2kicad-win.cmd`
- KiCad CLI: `C:\Program Files\KiCad\10.0\bin\kicad-cli.exe`
- KiCad Python: `C:\Program Files\KiCad\10.0\bin\python.exe`

Validated baseline:
- KiCad 10.0.6
- KiCad bundled Python 3.11.5
- `pcbnew` 10.0.6
- `epro2kicad` 1.1.0

## Inputs
Required:
- Absolute path to the source `.epro` file.

Optional:
- Output directory.
- Whether to create a zip archive.
- Whether to run post-conversion KiCad validation.

If the user gives a folder but not an exact `.epro` filename, inspect that folder first. If exactly one `.epro` exists, use it. If multiple candidates exist, report them instead of guessing.

## Execution Workflow
1. Confirm the `.epro` source file exists.
2. Confirm KiCad bundled Python and the converter script exist.
3. From Git Bash, invoke KiCad bundled Python and epro2kicad.py directly (the same interpreter/script selected by the compatibility launcher).
4. Preserve converter stdout/stderr in the task result.
5. Enumerate generated `.kicad_pro` and `.kicad_pcb` files.
6. For each generated PCB, perform a lightweight KiCad load validation when practical.
7. If requested, create the converter's zip output using `--zip`.
8. Report output paths and validation status. Do not claim schematic conversion succeeded unless it was actually imported separately in KiCad GUI.

## Commands
Preferred AI-facing command after this Skill is installed:

```bash
"C:/Program Files/KiCad/10.0/bin/python.exe" "C:/Users/servi/Documents/GitHub/epro2kicad/epro2kicad.py" "C:/path/project.epro" --zip
```

The `.cmd` wrappers remain for compatibility; default Git Bash execution directly selects the identical KiCad Python and converter script. This dedicated interpreter is required for pcbnew.

With explicit output directory:

```bash
"C:/Program Files/KiCad/10.0/bin/python.exe" "C:/Users/servi/Documents/GitHub/epro2kicad/epro2kicad.py" "C:/path/project.epro" -o "C:/path/project_kicad" --zip
```

Do not call the system Python directly for conversion. The user's general Python does not contain `pcbnew`; use the validated launcher or KiCad bundled Python.

## Validation
Minimum validation is structural:
- Conversion command exits successfully.
- Expected `.kicad_pro` exists.
- One or more expected `.kicad_pcb` files exist.

Preferred PCB load validation:

```bash
'C:/Program Files/KiCad/10.0/bin/python.exe' -c "import pcbnew; b=pcbnew.LoadBoard(r'C:/path/board.kicad_pcb'); print('LOAD_OK', len(b.GetFootprints()), len(b.GetTracks()), b.GetNetCount())"
```

Optional render validation:

```bash
'C:/Program Files/KiCad/10.0/bin/kicad-cli.exe' pcb render 'C:/path/board.kicad_pcb' -o 'C:/path/board-render.png' --side top
```

A successful render is useful evidence but is not required for every conversion.

## Multi-PCB Behavior
The converter is specifically useful for EasyEDA Pro multi-PCB projects because it can convert every PCB in the `.epro` package instead of forcing the KiCad GUI board chooser.

After conversion:
- Enumerate all generated `.kicad_pcb` files.
- Report each board separately.
- Do not assume every PCB represents a unique logical board; panels and variants may also appear.

## Schematic Boundary
EasyEDA Pro schematic import remains a separate KiCad GUI step. When schematic migration is needed, instruct or automate the GUI only through a suitable KiCad/UI capability:

`KiCad → File → Import Non-KiCad Project → EasyEDA (JLCEDA) Pro Project`

Do not state that `epro2kicad` performed headless schematic conversion.

## Failure Handling
If `pcbnew` cannot import:
- Verify KiCad bundled Python directly with `import pcbnew`.
- Prefer the fixed Windows launcher before changing the upstream Python code.

If a converted board emits warnings:
- Distinguish warnings from conversion failure.
- Preserve warnings in the report when they may affect geometry, pads, fonts, nets, or fabrication data.
- Do not silently repair PCB geometry unless the user explicitly asks.

If net counts differ between importer-time output and a saved/reloaded board:
- Treat the saved/reloaded KiCad board as the authoritative count.
- Do not immediately classify this as net loss without inspecting actual connectivity.

## Safety and Change Policy
- Do not modify the source `.epro` in place.
- Default to a new output directory.
- Do not modify upstream `epro2kicad.py` merely to work around environment selection when the validated Windows launcher works.
- Do not commit third-party repository changes unless the user explicitly requests it.
- Keep validation lightweight; do not launch broad ERC/DRC or fabrication export unless requested.

## Success Report
A successful response should include:
- Source `.epro` path.
- Output directory.
- Number and names of generated PCB files.
- Whether KiCad load validation passed for each board.
- Zip path if requested.
- Any meaningful warnings.
- A clear note that schematic conversion is separate if schematics were not imported.

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
