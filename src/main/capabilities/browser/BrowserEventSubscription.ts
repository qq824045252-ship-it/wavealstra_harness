const types = ["click", "dblclick", "change", "input", "submit", "focus", "blur", "drop"] as const;
export type BrowserEventType = typeof types[number];
export const browserEventTypes = [...types];
export interface BrowserEventReceipt { type: BrowserEventType; trusted: boolean; timeStamp: number }

// Chromium discards the registry with its document. The task receives only
// event metadata, including for input/change, never key codes or field values.
export function subscribeToBrowserEvent(slot: string, id: string, selector: string, type: BrowserEventType): string {
  return `(() => {
    const el=__mbDom.one(${JSON.stringify(selector)}), doc=window[${JSON.stringify(slot)}];
    if(!el?.isConnected || !doc)throw Error('Observed event target changed');
    const registry=doc.eventSubscriptions ??= new Map();
    const id=${JSON.stringify(id)};
    if(registry.size>=32)throw Error('Too many pending event subscriptions in this document');
    const controller=new AbortController();
    const item={dispose(){controller.abort();clearTimeout(timer);registry.delete(id)}};
    const timer=setTimeout(()=>item.dispose(),120000);
    registry.set(id,item);
    el.addEventListener(${JSON.stringify(type)}, e=>{
      item.receipt={type:e.type,trusted:e.isTrusted,timeStamp:e.timeStamp};
    },{once:true,capture:true,signal:controller.signal});
  })()`;
}

export function browserEventReceiptScript(slot: string, id: string): string {
  return `(() => {
    const item=window[${JSON.stringify(slot)}]?.eventSubscriptions?.get(${JSON.stringify(id)});
    if(!item)throw Error('Event subscription expired or belongs to another document');
    return item.receipt ?? null;
  })()`;
}
