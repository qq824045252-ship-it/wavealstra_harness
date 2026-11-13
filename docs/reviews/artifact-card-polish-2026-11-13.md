# Artifact card visual polish (2026-11-13)

Base: main 6664eccd, separate from deleted-participant fixes. Candidate was independently reviewed against its 333c506d base; these UI files had no intervening changes. File actions now have 40px targets and 20px glyphs, stronger cascade protection against workspace button padding, file-type heading treatment, and compact bordered cards. Selection identity, direct preview toggle and IPC stay unchanged.

Final integrated checks passed without Codex/esbuild: three focused DOM tests, full typecheck, production SSR visual fixture generation, and isolated Electron/Chromium CSS assertions. Actual captured viewport widths were 801px and 361px: button 40px, glyph 20px, padding 0px, card padding 14px, no horizontal document overflow. The app used a unique temporary userData and hidden fixture window, closed after capture; user application/profile were untouched.

Screenshots are isolated production-component SSR plus production workspace CSS, not a screenshot of the user's current application. They do not prove runtime HTML execution or interaction in the running user app. Generated HTML/PNG outputs are ignored, while the reproducible fixture and GUI-classified test entry are committed. On systems inheriting ELECTRON_RUN_AS_NODE, clear it for this Electron test as documented in AGENTS.md.
