---
name: office-use
description: Create, inspect, edit, and verify DOCX, XLSX, or PPTX in the current MyBuddy task with the bundled Office editors.
---

# Office Use

Follow the workflow for the file format.

- [WordCraft for DOCX](references/word.md) covers headings, document structure, targeted text edits, and page review.
- [GridCraft for XLSX](references/excel.md) covers named sheets, explicit A1 ranges, formulas, and chart review.
- [DeckCraft for PPTX](references/powerpoint.md) covers slide structure, shape IDs, speaker notes, and slide review.

Use `office_document_create` for a new editable file in the current task. Open the returned artifact in the task to use the reader and editor on it. For an existing file, inspect the open document with `office_document_read` before choosing a target.

Use the coordinates and identifiers from the reader. For text or values, capture the exact target using `office_selection_read` and submit the replacement with `office_selection_propose`. Use `office_edit_propose` for the supported structural changes in the format reference. The review panel displays one pending change at a time and the user applies it.

When a proposal is pending, tell the user what is ready to review and end the turn. After confirmation, query `office_review_status` with the returned `proposalId`. Check `verification.matched` and any formula errors on an applied change. Save is a separate user action. A `saved` receipt requires both a successful save and a matching target readback at save time. If the editor was closed or changed since confirmation, reopen or reread the target to check the current result. For Word pages and PowerPoint slides, render the affected pages or slides and review the images.

This skill adapts the WordCraft, GridCraft, and DeckCraft 0.5.0 skills at [upstream revision 7cd8388](https://github.com/hermes-pro/storytold-skills/tree/7cd83887800508c3f6f0dd1efa2fc7601b3753ca). See [LICENSE](LICENSE).
