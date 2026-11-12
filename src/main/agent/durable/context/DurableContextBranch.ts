import type { Context } from '@earendil-works/chord/context';
import type { Storage, Cursor, EntryId, Tx, ConversationId } from '@earendil-works/pi-durable';
import { createInitialState } from '../../../../../vendor/acp-kernel/src/index.ts';
import { DurableContextStateDoc, emptyPersistedState, parseKernelState, type DurableContextPersistedState, type DurableContextRefLocator } from './DurableContextState';
import { DurableContextRefArchive, DurableContextBlockArchive } from './DurableContextArchive';

export interface DurableContextBranchSnapshot {
  state?: DurableContextPersistedState;
  refs: Record<string, DurableContextRefLocator[]>;
  blocks: Record<string, number[]>;
}

/** Read the actual entry owner's historical commit, never the source's latest state. */
export async function captureContextBranchAt(storage: Storage, conversationId: ConversationId, entryId: EntryId, ctx: Context): Promise<DurableContextBranchSnapshot> {
  const source = await storage.entry(conversationId, entryId, ctx);
  if (!source) throw Error(`分支上下文锚点不存在：${entryId}`);
  const scope = { kind: 'conversation' as const, conversationId: source.entry.conversationId };
  const result: DurableContextBranchSnapshot = { refs: {}, blocks: {} };
  for (const kind of [DurableContextStateDoc.definition.kind, DurableContextRefArchive.definition.kind, DurableContextBlockArchive.definition.kind]) {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments({scope, at: source.commitSeq, kind}, 100, cursor, ctx);
      for (const record of page.items) {
        const doc = await storage.document(record.id, source.commitSeq, ctx);
        if (!doc) throw Error(`分支上下文历史文档缺失：${record.id}`);
        if (kind === DurableContextStateDoc.definition.kind) result.state = doc.value as unknown as DurableContextPersistedState;
        else if (record.key !== undefined && kind === DurableContextRefArchive.definition.kind) result.refs[record.key] = doc.value.locators as unknown as DurableContextRefLocator[];
        else if (record.key !== undefined) result.blocks[record.key] = doc.value.entryIds as number[];
      }
      cursor = page.next;
    } while (cursor);
  }
  return result;
}

/** Rebuild coverage in the new session, but carry immutable identities and exact originals. */
export async function seedContextBranch(tx: Tx, conversationId: ConversationId, snapshot: DurableContextBranchSnapshot,
  ids: ReadonlyMap<string, EntryId>): Promise<void> {
  const remap = (id: number): number => {
    const mapped = ids.get(String(id));
    if (mapped === undefined) throw Error(`分支上下文引用不在锚点范围内：${id}`);
    return mapped;
  };
  const refs = structuredClone(snapshot.refs);
  const blocks = structuredClone(snapshot.blocks);
  const state = snapshot.state;
  const kernel = state && parseKernelState(state);
  const locate = (raw: string): DurableContextRefLocator | undefined => {
    const match = /^e(\d+):(\d+)(?:\.(?:t|c\d+))?$/.exec(raw);
    return match ? {entryId:Number(match[1]),slot:Number(match[2]),role:'unknown'} : undefined;
  };
  for (const map of [state?.refs ?? {}, ...(state?.archivedRefs ?? []).map(item=>item.refs)]) {
    for (const [ref,locator] of Object.entries(map)) (refs[ref] ??= []).push(locator);
  }
  for (const [ref,raw] of Object.entries(kernel?.messageRefs.byRef ?? {})) {
    const locator = locate(raw);
    if (locator) (refs[ref] ??= []).push(locator);
  }
  for (const summary of state?.summaries ?? []) blocks[summary.blockId] ??= summary.entryIds;
  for (const block of kernel?.blocks ?? []) {
    blocks[block.blockId] ??= [...new Set(block.effectiveMessageIds.flatMap(raw=>{const locator=locate(raw);return locator?[locator.entryId]:[]}))];
  }
  for (const [key,locators] of Object.entries(refs)) {
    const remapped = locators.map(locator=>({...locator,entryId:remap(locator.entryId)}));
    const unique = remapped.filter((locator,index)=>remapped.findIndex(other=>other.entryId===locator.entryId && other.slot===locator.slot)===index);
    (await tx.doc(DurableContextRefArchive,conversationId,key,[])).locators=unique;
  }
  for (const [key,entryIds] of Object.entries(blocks)) (await tx.doc(DurableContextBlockArchive,conversationId,key,[])).entryIds=entryIds.map(remap);
  if (!state && !Object.keys(refs).length && !Object.keys(blocks).length) return;
  const rebuilt = createInitialState();
  const highest = [...Object.keys(refs),...Object.keys(kernel?.messageRefs.byRef ?? {})].reduce((max,ref)=>/^m\d+$/.test(ref)?Math.max(max,Number(ref.slice(1))):max,0);
  if (highest) {
    const ref=`m${String(highest).padStart(5,'0')}`, raw=`retired:branch:${highest}`;
    rebuilt.messageRefs.byRaw[raw]=ref; rebuilt.messageRefs.byRef[ref]=raw;
  }
  rebuilt.nextBlockId=Math.max(kernel?.nextBlockId ?? 1,...Object.keys(blocks).filter(key=>/^b\d+$/.test(key)).map(key=>Number(key.slice(1))+1));
  rebuilt.nextRunId=kernel?.nextRunId ?? 1;
  // No source operation authority, session UUID or cursors survive a separate task.
  const target = {...emptyPersistedState(),kernelVersion:state?.kernelVersion ?? '',
    headEntryId:state?.headEntryId == null ? null : remap(state.headEntryId),
    epoch:(state?.epoch ?? 0)+1,stateJson:JSON.stringify(rebuilt)};
  Object.assign(await tx.doc(DurableContextStateDoc,conversationId),target);
}
