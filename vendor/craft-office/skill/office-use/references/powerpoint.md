# DeckCraft

Plan one point per slide and use speaker notes for detail. For a new deck, pass `{kind:"ppt",slides:[{title,bullets,notes}]}` as `office_document_create` content.

1. Inspect the deck with `office_document_read`. Read the specific `slideIndex` to discover object IDs and their text. Use `shapeId` from that slide to read one object, or `notes:true` to read its notes. Slide and paragraph indices start at zero.
2. For text, use `office_selection_read` with the slide index, shape ID, exact original text and, when needed, paragraph index. Submit the replacement with `office_selection_propose`. For notes, use `office_edit_propose` and `operation:{kind:"ppt",action:"slideNotes",slideIndex,text}` with the complete new notes. For a diagram, use `insertShape` with a preset, slide index, and explicit `x`, `y`, `width`, and `height` in points. Compare these with `slideSize` and the `bounds` of existing slide objects.
3. Check the receipt and reread the target slide or notes. Render the affected slides with `office_document_render` and `target:{kind:"ppt",slideIndex:0}`. Inspect for text overflow, overlap, contrast, and unintended placeholder text.

Source [upstream DeckCraft skill](https://github.com/hermes-pro/storytold-skills/blob/7cd83887800508c3f6f0dd1efa2fc7601b3753ca/deckcraft/SKILL.md)
