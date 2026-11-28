import type { Context } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiStorageClient, RuntimeAuditDurableSnapshot, RuntimeAuditReader } from "../../platform/runtime-audit";
import { claimDurableStorageLease, type DurableStorageLease } from "./DurableStorageLease";
import {
  DuckDbStorage,
  duckDbStoreInfo,
  purgeDuckDbStore,
  resolveStoreId,
} from "./DuckDbStorage";

export interface DurableStorageHandle {
  storage: Storage;
  lease?: DurableStorageLease;
}

let defaultPiStorageClient: PiStorageClient | undefined;
let defaultHostGeneration: string | undefined;

export function setDefaultPiStorageClient(client: PiStorageClient | undefined): void {
  defaultPiStorageClient = client;
}

export function getDefaultPiStorageClient(): PiStorageClient | undefined {
  return defaultPiStorageClient;
}

export function setDefaultPiHostGeneration(hostGeneration: string | undefined): void {
  defaultHostGeneration = hostGeneration;
}

export function getDefaultPiHostGeneration(): string | undefined {
  return defaultHostGeneration;
}

export function resolvePiStorageClient(client?: PiStorageClient): PiStorageClient {
  const resolved = client ?? defaultPiStorageClient;
  if (!resolved) {
    throw new Error("DuckDbStorage requires a PiStorageClient (RuntimeAuditReader not initialized)");
  }
  return resolved;
}

export async function durableStorageExists(
  directory: string,
  reader?: PiStorageClient,
): Promise<boolean> {
  const client = reader ?? defaultPiStorageClient;
  if (!client) return false;
  const storeId = await resolveStoreId(client, directory);
  const info = await duckDbStoreInfo(client, storeId);
  return info.exists && !info.retired;
}

export async function purgeDurableStorage(
  directory: string,
  reader?: PiStorageClient,
): Promise<void> {
  const client = reader ?? defaultPiStorageClient;
  if (!client) return;
  const storeId = await resolveStoreId(client, directory);
  await purgeDuckDbStore(client, storeId);
}

export function openDurableStorage(
  directory: string,
  context: Context,
  options?: { readOnly?: false; reader?: PiStorageClient },
): Promise<DurableStorageHandle & { lease: DurableStorageLease }>;
export function openDurableStorage(
  directory: string,
  context: Context,
  options: { readOnly?: boolean; reader?: PiStorageClient },
): Promise<DurableStorageHandle>;
export async function openDurableStorage(
  directory: string,
  context: Context,
  options: { readOnly?: boolean; reader?: PiStorageClient } = {},
): Promise<DurableStorageHandle> {
  context.abortSignal?.throwIfAborted();
  const client = resolvePiStorageClient(options.reader);
  if (options.readOnly) {
    const storeId = await resolveStoreId(client, directory);
    context.abortSignal?.throwIfAborted();
    return { storage: await DuckDbStorage.openReadOnly(client, storeId) };
  }
  const lease = claimDurableStorageLease(directory);
  try {
    const storeId = await resolveStoreId(client, directory);
    context.abortSignal?.throwIfAborted();
    const storage = await DuckDbStorage.openWriter(client, storeId, {
      hostGeneration: defaultHostGeneration,
      leaseHolder: `${lease.owner.host}:${lease.owner.pid}:${lease.owner.token ?? ""}`,
      forceTakeover: true,
      // 生产写者一次领一整块 id 在内存里发号，把「一次发送 3 趟 mintId」压成 0–1 趟。
      idBlock: DuckDbStorage.ID_BLOCK,
    });
    return { storage, lease };
  } catch (error) {
    lease.release();
    throw error;
  }
}

export async function openDurablePassiveStorage(
  directory: string,
  _context: Context,
  reader?: PiStorageClient,
): Promise<Storage | undefined> {
  const client = reader ?? defaultPiStorageClient;
  if (!client) return undefined;
  const storeId = await resolveStoreId(client, directory);
  const info = await duckDbStoreInfo(client, storeId);
  if (!info.exists || info.retired) return undefined;
  return await DuckDbStorage.openReadOnly(client, storeId);
}

export async function openRustDurableStorage(
  directory: string,
  reader?: RuntimeAuditReader,
): Promise<{ storage: Storage; snapshot: RuntimeAuditDurableSnapshot } | undefined> {
  if (!reader) return undefined;
  const storeId = await resolveStoreId(reader, directory);
  const info = await duckDbStoreInfo(reader, storeId);
  if (!info.exists || info.retired) return undefined;
  const storage = await DuckDbStorage.openReadOnly(reader, storeId);
  const snapshot = await reader.openDurable(directory, storage.incarnationKey);
  if (!snapshot) {
    await storage.close(BACKGROUND_CONTEXT);
    return undefined;
  }
  const close = storage.close.bind(storage);
  storage.close = async context => {
    try { await close(context); } finally { await snapshot.close(); }
  };
  return { storage, snapshot };
}
