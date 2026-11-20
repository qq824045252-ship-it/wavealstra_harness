---
name: office-use
description: Use WordCraft, GridCraft, and DeckCraft to create, open, edit, inspect, render, save, and convert office documents in the current MyBuddy task.
---

# Office Use

Use the upstream skill for the requested application. Its workflows and command references ship with MyBuddy.

- [WordCraft](references/upstream/wordcraft/SKILL.md) and its [command catalog](references/upstream/wordcraft/references/commands.md).
- [GridCraft](references/upstream/gridcraft/SKILL.md), its [command catalog](references/upstream/gridcraft/references/commands.md), and its [function catalog](references/upstream/gridcraft/references/functions.md).
- [DeckCraft](references/upstream/deckcraft/SKILL.md), its [command catalog](references/upstream/deckcraft/references/commands.md), and its [assets and animation catalog](references/upstream/deckcraft/references/catalogs.md).

## Calling upstream tools in MyBuddy

MyBuddy starts the requested native engine on demand. Use `office_native_tools` with `engine` set to `wordcraft`, `gridcraft`, or `deckcraft`. Search by the exact upstream tool name to load its argument schema. Pass that same name and arguments to `office_native_call`. For example, `mcp_gridcraft_evaluate_formula` maps to `{engine:"gridcraft",tool:"evaluate_formula",arguments:{formula:"=SUM(2,3)"}}`. Find native engine commands through the upstream `list_commands` tool and run them with its documented `execute`, `execute_command`, `run_command`, or `batch`.

Use absolute paths inside the task directory for inputs and outputs. Use the native save or export tool and verify the resulting file. To read an upstream resource, pass its URI as `resource` to `office_native_call`.

Use the default `surface:"workspace"` for the headless recipes. For an upstream desktop-only workflow, use `surface:"desktop"` from the first call, including the open or new document step. MyBuddy starts and connects to a dedicated application window. Keep the same engine and surface through save and verification so the calls operate on the same document. A file saved by one surface can be opened by the other surface or in the MyBuddy document panel.

## Reviewing changes in the document panel

Use `office_document_create` to create and attach a DOCX, XLSX, or PPTX directly. Open the artifact in the task and use `office_document_read` before choosing a target. The document panel supports [Word review](references/word.md), [Excel review](references/excel.md), and [PowerPoint review](references/powerpoint.md).

Use the coordinates and identifiers from the reader. For text or values, capture the exact target using `office_selection_read` and submit the replacement with `office_selection_propose`. Use `office_edit_propose` for the supported structural changes in the format reference. The review panel displays one pending change at a time and the user applies it.

When a proposal is pending, tell the user what is ready to review and end the turn. After confirmation, query `office_review_status` with the returned `proposalId`. Check `verification.matched` and any formula errors on an applied change. Save is a separate user action. A `saved` receipt requires both a successful save and a matching target readback at save time. If the editor was closed or changed since confirmation, reopen or reread the target to check the current result. For Word pages and PowerPoint slides, render the affected pages or slides and review the images.

This skill adapts the WordCraft, GridCraft, and DeckCraft 0.5.0 skills at [upstream revision 7cd8388](https://github.com/hermes-pro/storytold-skills/tree/7cd83887800508c3f6f0dd1efa2fc7601b3753ca). See [LICENSE](LICENSE).
