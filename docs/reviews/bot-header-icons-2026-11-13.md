# Bot header icons verification (2026-11-13)

Integrated candidate based on 8aeddf42 onto current main 02b87b61 using a three-way source merge. Preserved current directory activity and primary-Bot organization changes. Only the header presentation changed: collaboration, diagnostics, new conversation and all messages are labelled icons; settings uses a gear without replacing the global settings icon.

Shared diagnostic/activity controls retain their text by default. Existing click handlers, disabled/visibility conditions and new-conversation behavior are unchanged. The separate new-conversation investigation owns behavior changes and did not write this integration checkout.

Checks passed: production-page SSR header test, full web/node/scripts typecheck, diff whitespace check. Independent candidate review found no definite blocker. The SSR test verifies native-button labels, titles, icon rendering, dialog attributes, personal/team visibility and shared text defaults; it is not click/desktop geometry acceptance. The author's broader workspace test encountered a JSON module loader limitation and is not counted as passed. No Codex or esbuild tests were invoked; no running user checkout was changed or reloaded.
