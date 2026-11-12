import { defineDoc } from "@earendil-works/pi-durable";
import type { JsonRepresentation } from "@earendil-works/chord";
import type { DurableChildIdentity } from "./DurableSubagents";

/** Existing native child identity, shared by execution and terminal evidence reads. */
export const DurableSubagentIdentity = defineDoc({
  kind: "mybuddy.subagent", version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false,
  initial: (): { value: JsonRepresentation<DurableChildIdentity> | null } => ({ value: null }),
});
export const DURABLE_SUBAGENT_TIER_LIMIT_RETRIES = 1;
