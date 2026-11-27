import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { DuckDbStorage } from "./DuckDbStorage";

/** Build a stable identity string for a logical store conversation in DuckDB. */
export function durableHistoryIdentity(
  directory: string,
  conversationId: string,
  storage?: Storage,
): string {
  const identity = storage instanceof DuckDbStorage ? storage.incarnationKey : undefined;
  const storeKey = createHash("sha256").update(identity ?? resolve(directory)).digest("hex").slice(0, 16);
  return `duckdb:${storeKey}:${conversationId}`;
}
