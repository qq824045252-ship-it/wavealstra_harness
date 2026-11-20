---
name: drawio-use
description: Use for creating, opening, editing, laying out or exporting Draw.io diagrams. Covers flowcharts, architecture, ER, sequence, class, state, network, mind maps, mockups, wireframes, Mermaid, Draw.io XML and editable PNG, SVG and PDF.
---

# Draw.io Use

The [official Draw.io Skill](references/upstream/plugins/codex/drawio/skills/drawio/SKILL.md) and its references are bundled with this skill. Apply its diagram authoring rules through these MyBuddy tools.

## Create and open a diagram

1. Match labels to the user's language. Choose a short, descriptive, hyphenated filename in the task workspace.
2. Prefer Mermaid for standard diagrams. Use `drawio_reference` with `name: mermaid` for syntax and styling. Pass the Mermaid source and a `.drawio` path to `drawio_create`. It converts to editable shapes and connectors. Set `mermaidImage` only when the user asks for one static image cell.
3. Use Draw.io XML for precise positions, custom styles, specialized stencils, swimlanes and graphs that need explicit layout. Read `name: xml` first. Read `xml-advanced`, `styles` or `schema` for layers, tags, metadata, placeholders, tables, cross-functional grids, adaptive colors and detailed styles. For long references, continue from `nextOffset`.
4. For cloud, network and brand shapes, call `drawio_shapes` with all the queries in one request. Include the library name where known, for example `aws4 lambda`, `azure2 storage`, or `cisco19 router`. Use the returned style and intrinsic dimensions. Enable `includeOnlineIcons` for logos or concept icons missing from the bundled stencils.
5. Author native cells with unique IDs, a root layer, valid parents, relative coordinates inside containers and proper geometry for each edge. Put an edge in the innermost common container of its endpoints. Escape text and attributes. `drawio_create` runs the official XML repair pass before layout or delivery.
6. Open the result from its task artifact. The editor is embedded in MyBuddy. Select the artifact to inspect it visually or continue editing. If the panel cannot open, report the absolute path and the error.

## Layout and edit

- For XML, pass `layout` to `drawio_create`, or use `drawio_layout` on an existing drawing. The presets are `verticalFlow`, `horizontalFlow`, `verticalTree`, `horizontalTree`, `radialTree` and `organic`.
- For custom layout, pass a JSON array with algorithms `elkLayered`, `elkTree`, `elkRadial`, `elkOrganic`, `elkStress`, or `elkBox`. Each entry accepts a config such as `{"elk.direction":"RIGHT","elk.spacing.nodeNode":40,"edgeStyle":"orthogonal","corners":"rounded"}`.
- Use `libavoid` to route connectors around shapes while retaining their positions. Standard Mermaid conversion already lays out the graph.
- Read existing pages and cell IDs with `drawio_read`. Request a cell's XML with `cellId`. Use the returned revision with `drawio_edit` and add, replace, or remove cells on a selected page. For a change spanning pages, supply the updated full `mxfile` with all surviving pages. Save to a new path and read the resulting diagram to check the affected nodes, edges and labels.

## Deliver

- Deliver the editable `.drawio` by default. Keep it available as the task artifact.
- For PNG, SVG or PDF, convert to `.drawio` first and then call `drawio_export` with a `.drawio.png`, `.drawio.svg` or `.drawio.pdf` filename. The output embeds the full diagram by default. Set page with a 1-based index or use `allPages` for PDF. Border, scale and fitted width/height are available. Use transparency for PNG when requested. JPEG is available for ordinary image output.
- To reopen an editable export in MyBuddy, use `drawio_create` with the exported file as `source` and a new `.drawio` path. Open the editable artifact.
- For a browser URL, use `drawio_link` and keep the local `.drawio`. Set `open` only if the user asked to open the link in a browser. If the link is too long, deliver the local drawing and open it in MyBuddy.
- If conversion fails, check Mermaid type and quoting in the reference, or use XML explicitly. If the graph looks blank, check layer parents, root cells, geometry and positions. If layout fails, check the preset or algorithm and configuration.
