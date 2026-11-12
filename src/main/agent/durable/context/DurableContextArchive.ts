import { defineDocFamily } from "@earendil-works/pi-durable";
import type { DurableContextRefLocator } from "./DurableContextState";

/** Cold identities follow the same branch/as-of semantics as the active context document. */
export const DurableContextRefArchive = defineDocFamily({
  kind: "mybuddy.context-ref-archive", version: 1, family: true, scope: "conversation",
  history: "rewindable", fork: "asOf", checkpointWhen: () => true,
  initial: (locators: DurableContextRefLocator[]) => ({ locators }),
});

export const DurableContextBlockArchive = defineDocFamily({
  kind: "mybuddy.context-block-archive", version: 1, family: true, scope: "conversation",
  history: "rewindable", fork: "asOf", checkpointWhen: () => true,
  initial: (entryIds: number[]) => ({ entryIds }),
});
