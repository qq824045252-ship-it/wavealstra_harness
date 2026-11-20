# WordCraft

Plan headings, body text, and tables before building a document. For a new report, pass `{kind:"word", title, sections:[{heading, paragraphs, bullets, table:{headers,rows}}]}` as `office_document_create` content. Bullets and tables are optional. The title and section headings use native Word styles.

1. Inspect the open document with `office_document_read` using `action:"inspect"`. Find specific text with `action:"find"`, then read the returned `blockIndex`. A full table read returns rows. The outline and block read show the paragraph style.
2. For an inline change, pass `target:{kind:"word",blockIndex,text}` to `office_selection_read`. Use a unique exact span from the block. The editor checks the old text, nearby text, and format again at confirmation. Change a paragraph style with `office_edit_propose` and `operation:{kind:"word",action:"paragraphStyle",blockIndex,style:"Heading2"}`. Styles include Normal, Title, and Heading1 through Heading3.
3. Read the affected block after applying. Render each affected page using `office_document_render` with `target:{kind:"word",pageIndex:0}`. Review hierarchy, page breaks, clipping, and legibility before treating the document as ready.

Source [upstream WordCraft skill](https://github.com/hermes-pro/storytold-skills/blob/7cd83887800508c3f6f0dd1efa2fc7601b3753ca/wordcraft/SKILL.md)
