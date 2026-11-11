# Gadget task working-directory copies

## Behavior

The UI term is **任务工作目录**. This means the concrete execution folder resolved by Main's existing `resolveTaskExecutionWorkspaceCwd`, not the logical 工作空间 and not the renderer's current directory.

- Task-side Gadgets, including inherited workspace/personal tools, can save a source copy directly into the current task directory.
- My Gadgets and workspace toolboxes offer a destination-task chooser. An eligible active task is preselected, but the user confirms. With no active task, there is no default destination and saving stays disabled until a task is chosen.
- Promoting a task Gadget to My Gadgets does not remove the save capability.
- Each export creates `gadgets/<safe name>-<Gadget ID>/` with `code/`, `gadget.json`, and a short README. Later copies use numeric suffixes. Existing directories, files, and user-edited exports are never replaced.
- The original Gadget, its scope, runtime state and source remain unchanged. Runtime data/browser state are not copied. The UI shows the selected task and actual saved path, with an Open Folder action.
- Main validates task visibility before resolving a destination. Private sibling-task Gadgets are rejected. Output symlinks/non-directories and source symlinks are rejected. Missing bound directories fail rather than silently changing destinations.

## Verification

- `pnpm -s typecheck`: passed.
- `pnpm -s test:gadget-blueprint`: passed, extended with exact nested text/binary copies, manifest/source preservation, repeat-save/user-edit protection, task visibility, inherited/personal exports, output-link rejection, existing-file protection and source-link rejection.
- `pnpm -s test:gadget-save-directory-desktop`: passed against actual Electron dev with an isolated HOME/database and native mouse/keyboard input:
  1. Task-side save and repeat-save preservation.
  2. Promote to My Gadgets, cancel a save, then save again without moving the personal tool.
  3. No active task: empty target selection and disabled Save, then native task selection and correct isolated-folder export.
  4. Task switching, private sibling rejection and personal-tool saving.
  5. Missing bound folder produces an error, with no fallback or false success.
  6. Renderer reload preserves original Gadget and independent edited copies.
- `pnpm -s test:gadget-menu-dev`: passed the final shared-menu regression, including global/workspace/task menus, narrow sizes and 125% zoom; see the local report under `out/diagnostics/gadget-menu`.
- `node scripts/test-all.mjs --audit`: the new desktop test is explicitly GUI-only.

This change does not modify model prompts/tools or runtime lifecycle. Full headless regression and live-model evaluation were not run for this bounded filesystem/UI feature. Windows filename-case behavior is covered by a Windows-gated regression and source review; this acceptance ran on Linux, not a Windows desktop. No product package or release was built.

Local screenshots/results are in `out/tests/gadget-save-directory`. Test profiles and temporary directories are kept within the isolated checkout; production MyBuddy data is not used.
