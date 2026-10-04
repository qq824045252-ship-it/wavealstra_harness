## IPC Troubleshooting
If `kicad_status` says `connected=false`:
- Confirm KiCad is running.
- Confirm `Preferences > Plugins > Enable IPC API server` is enabled.
- Restart KiCad after changing that option.
- Run the MCP `doctor` only when environment diagnosis is actually needed.

If `connected=true` but `board_open=false` while the user visibly has a PCB Editor open:
- Suspect multiple KiCad instances or a standalone PCB Editor connected to a different process.
- Do not repeatedly retry the same MCP call.
- Ensure the desired project is open in the API-serving KiCad project manager and launch that project's PCB Editor from there.
- Re-run `kicad_status` once after the editor is opened.

Do not kill unrelated KiCad instances without explicit permission when the user may have unsaved work.
