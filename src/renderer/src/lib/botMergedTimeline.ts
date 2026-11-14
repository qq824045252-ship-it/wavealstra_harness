/** Immutable creation time owns placement; updates must never move an existing row. */
export function mergeBotTimeline<T>(personal: readonly { key: string; createdAt: number; ordinal: number; value: T; foldKey?:string }[], incoming: readonly { collaborationId: string; createdAt: number }[]) {
  return [...personal.map(row => ({kind:'personal' as const, key:'message:'+row.key, createdAt:row.createdAt, ordinal:row.ordinal, value:row.value, foldKey:row.foldKey})),
    ...incoming.map(row => ({kind:'incoming' as const,key:'collaboration:'+row.collaborationId,createdAt:row.createdAt,ordinal:0,collaborationId:row.collaborationId}))]
    .sort((a,b)=>a.createdAt-b.createdAt || (a.kind===b.kind ? a.ordinal-b.ordinal : a.kind==='personal' ? -1 : 1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Fold only adjacent progress after global ordering, never across a peer event. */
export function groupBotTimeline<T extends {kind:string;foldKey?:string}>(rows:readonly T[]):T[][] {
 const groups:T[][]=[];
 for(const row of rows){const last=groups.at(-1);if(row.kind==='personal' && row.foldKey && last?.[0].kind==='personal' && last[0].foldKey===row.foldKey)last.push(row);else groups.push([row]);}
 return groups;
}

/** Hide only copies whose authenticated durable identity is already visible. */
export function unrepresentedIncomingMessages<T extends {message:{collaborationId:string;operationId:string};foregroundMessageIds?:readonly string[]}>(items:readonly T[],personalIds:ReadonlySet<string>,replies:readonly {collaborationId:string;exchangeId:string}[]):T[]{
 return items.filter(item=>!item.foregroundMessageIds?.some(id=>personalIds.has(id)) && !replies.some(reply=>reply.collaborationId===item.message.collaborationId && item.message.operationId===reply.exchangeId+':reply'));
}
