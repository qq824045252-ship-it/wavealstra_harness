## Capability Boundary
KiCad 10 has two different automation paths. Do not confuse them.

### Live PCB path — KiCad official IPC API
Requires the relevant PCB Editor to be open in the API-serving KiCad instance.

Use for the currently open board:
- `kicad_status`
- `get_board_summary`
- `get_layers`
- `get_stackup`
- `list_footprints`
- `get_footprint`
- `list_nets`
- `get_selection`
- `list_tracks_vias`
- `list_zones`

### Schematic path — file-based
KiCad 10 does **not** expose a schematic IPC API through this MCP.
Schematic reads/writes operate on `.kicad_sch` files using parsing/generation plus `kicad-cli` where appropriate.

Use:
- `open_schematic`
- `list_schematic_symbols`
- `schematic_netlist`
- `find_project_files`
- `run_erc`
- `export_bom`
- `export_schematic`
- `list_symbol_libraries`
- `search_symbols`
- `get_symbol_pins`
- `create_pinout_schematic`
- `add_symbol_to_schematic`
- `mark_pins_unused`
- `rewire_power_symbol`
- `add_decoupling_capacitors`

### PCB file/CLI validation
Use `run_drc` for board DRC when requested or after a meaningful PCB edit that needs validation.

### Escape hatch
Use `run_kicad_script` only when curated tools do not cover the task.
It exposes:
- `kicad` — live KiCad client
- `board` — open board or `None`
- `kipy`
- `pcbnew`
- `sexpr`

`run_kicad_script` executes arbitrary local Python with user privileges. Treat it as a controlled engineering escape hatch, not the default tool.
