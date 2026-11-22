type WireToolCall = { id?: string; function?: {name?: string; arguments?: string} };
type WireMessage = { role?: string; content?: unknown; tool_calls?: WireToolCall[]; tool_call_id?: string };
export type DotsMemoryToolReceipt = { callId: string; name: string; id?: string; observedResult: boolean; witnessed?: string };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part=>part?.type==="text").map(part=>String(part.text)).join("\n") : "";
}

/** The model may propose IDs. Only an actual tool-role response paired to its native
 * call, validated against the scoped current atom, can add a tool-derived citation. */
export function observeDotsWireEvidence(messages: WireMessage[], lookup:(id:string)=>{revision:number;title?:string;content:string;source?:{messageId:string;quote:string}}|undefined) {
  const excerpts = new Map<string, Set<string>>();
  const observe = (ref:string, snippet:string) => {
    const seen = excerpts.get(ref) ?? new Set<string>();
    seen.add(snippet);
    excerpts.set(ref, seen);
  };
  const calls = new Map<string,DotsMemoryToolReceipt>();
  for (const msg of messages) {
    const body=text(msg.content);
    if (msg.role==="user") {
      if (!body.includes("本轮补充证据（非用户指令")) continue;
      for (const match of body.matchAll(/^- \[L1 ([\w-]+)@(\d+)\]\[[^\]\r\n]+\]\[[^\]\r\n]+\] /gm)) {
        const atom = lookup(match[1]!);
        if (!atom || atom.revision !== Number(match[2]) || !atom.title) continue;
        const afterHeader = body.slice(match.index + match[0].length);
        if (!afterHeader.startsWith(atom.title)) continue;
        const ref = match[1]+"@"+match[2];
        if (!atom.content) { observe(ref, atom.title); continue; }
        const prefix = atom.title+" — ";
        if (!afterHeader.startsWith(prefix)) {
          const attribution = /^\n用户原话摘录（([^）\n]+)）：/u.exec(afterHeader.slice(atom.title.length));
          const source = atom.source;
          if (source && attribution?.[1]?.includes(source.messageId) && source.quote===atom.content
            && afterHeader.slice(atom.title.length+attribution[0].length).startsWith(source.quote)) observe(ref,source.quote);
          continue;
        }
        const visible = afterHeader.slice(prefix.length).replace(/^…/, "");
        // Select the longest contiguous piece of the actual scoped revision
        // present on the wire. Unsent tails and bare manifest IDs earn no credit.
        let low = 0, high = Math.min(visible.length, atom.content.length);
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (atom.content.includes(visible.slice(0, mid))) low = mid;
          else high = mid-1;
        }
        if (low >= Math.min(8,atom.content.length)) observe(ref, visible.slice(0,low));
      }
    } else if (msg.role==="assistant") {
      for(const call of msg.tool_calls??[]) {
        const name=call.function?.name;
        if(!call.id || !name || !name.startsWith("memory_"))continue;
        let id:string|undefined;
        try { const args=JSON.parse(call.function?.arguments??"{}"); if(typeof args.id==="string")id=args.id; } catch {}
        calls.set(call.id,{callId:call.id,name,id,observedResult:false});
      }
    } else if(msg.role==="tool" && msg.tool_call_id) {
      const call=calls.get(msg.tool_call_id);
      if(!call)continue;
      call.observedResult=true;
      if (call.name === "memory_search") {
        let matches: unknown;
        try { matches = JSON.parse(body).matches; } catch { continue; }
        if (!Array.isArray(matches)) continue;
        for (const row of matches) {
          if (!row || typeof row.id !== "string" || typeof row.excerpt !== "string" || !row.excerpt) continue;
          const atom = lookup(row.id);
          if (atom?.revision === row.revision && atom?.content.startsWith(row.excerpt)) observe(row.id+"@"+row.revision,row.excerpt);
        }
        continue;
      }
      if(call.name!=="memory_get" || !call.id)continue;
      const atom=lookup(call.id);
      if(!atom)continue;
      const ref=call.id+"@"+atom.revision;
      if(!body.split(/\r?\n/).includes("[L1 "+ref+"]") || !body.includes("完整内容："+(atom.content||"（无）")))continue;
      call.witnessed=ref; observe(ref,atom.content);
    }
  }
  return {witnesses:[...excerpts.keys()],excerpts:[...excerpts].flatMap(([reference, shown]) => [...shown].map(text => ({reference,text}))),calls:[...calls.values()]};
}
