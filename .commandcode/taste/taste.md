# Taste

- When asked to commit/update git after a feature, keeps the commit tightly scoped: stages only files belonging to the current feature and leaves unrelated pre-existing working-tree changes untouched rather than committing everything. Confidence: 0.7

- Prefers to keep the chat message stream clean: auxiliary runtime detail (e.g., the per-round todo list) should be reachable via a click-triggered button/popover anchored in the chat header next to the related chip (e.g., right of "设定 Goal"), rather than rendered as always-visible inline cards inside each assistant message. Confidence: 0.5

- When asked to clean up remaining/pre-existing uncommitted work after a feature commit, wants the changes classified by feature first (with an explanation), then consolidated into a single commit — explicitly chose "全部合成 1 个 commit" over per-feature splits, with the commit message summarizing each grouped feature. Confidence: 0.7

- Expects the working tree to be left completely clean at the end of a work session: actively asks about any leftover dirty files ("还有一个脏文件?") and wants them resolved/committed rather than left dangling. Confidence: 0.5
