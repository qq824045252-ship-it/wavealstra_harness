import { randomUUID } from "node:crypto";
import { findScript } from "./UiAutomationService";
import { withBrowserDom } from "./browser/BrowserDom";

export interface BrowserReadOptions {
  selector?: string;
  role?: string;
  name?: string;
  mode?: "text" | "interactive";
  cursor?: string;
  offset?: number;
  elementOffset?: number;
  maxChars?: number;
  within?: string;
  exact?: boolean;
  label?: string;
  placeholder?: string;
  testId?: string;
}

function documentState(): string {
  return `if(!window[slot]){
    const state={documentId:${JSON.stringify(randomUUID())},revision:0,snapshot:null};
    state.changed=records=>{if(records.some(r=>r.type!=='attributes'||r.attributeName!=='data-mybuddy-ui-ref'))state.revision++};
    state.observer=new MutationObserver(state.changed);
    state.observedRoots=new WeakSet();
    Object.defineProperty(window,slot,{value:state});
  }
  for(const root of __mbDom.roots()){const state=window[slot];if(!state.observedRoots.has(root)){state.observer.observe(root,{subtree:true,childList:true,attributes:true,characterData:true});state.observedRoots.add(root);}}`;
}

export function browserDocumentScript(slot: string): string {
  return withBrowserDom(`(() => {const slot=${JSON.stringify(slot)};${documentState()};return window[slot].documentId})()`);
}

/** Runs in the pinned document. One bounded snapshot per document, never action replay. */
export function browserPageReadScript(slot: string, input: BrowserReadOptions): string {
  const controls = 'a[href],button,details>summary:first-of-type,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[contenteditable="true"]';
  const query = { selector: controls, within: input.selector ?? input.within, role: input.role, name: input.name, exact: input.exact, label: input.label, placeholder: input.placeholder, testId: input.testId, visibleOnly: true };
  return withBrowserDom(`(() => {
    const q=${JSON.stringify(input)},slot=${JSON.stringify(slot)};
    ${documentState()}
    const state=window[slot];state.changed(state.observer.takeRecords());
    let root=document.body;
    if(q.selector){try{const roots=__mbDom.all(q.selector);if(roots.length!==1)return {error:roots.length?'ELEMENT_AMBIGUOUS':'SELECTOR_NOT_FOUND'};root=roots[0];}catch{return {error:'INVALID_SELECTOR'}}}
    if(root instanceof HTMLIFrameElement)return {error:'UNSUPPORTED_SCOPE',detail:'iframe is a separate document; enumerate frames and pass its frameId to observe it'};
    let offset=q.offset||0,elementOffset=q.elementOffset||0;
    if(q.cursor){
      const parts=q.cursor.split(':');const snapshot=state.snapshot;
      if(!snapshot||parts[0]!==snapshot.id||snapshot.revision!==state.revision)return {error:'CURSOR_STALE'};
      offset=Number(parts[1]);elementOffset=Number(parts[2]);
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(elementOffset)||elementOffset<0)return {error:'INVALID_INPUT'};
    }else{
      const text=__mbDom.text(root);
      if(text.length>4000000)return {error:'READ_LIMIT',detail:'scope exceeds 4M UTF-16 units; narrow selector'};
      state.snapshot={id:state.documentId+'-'+state.revision+'-'+(++state.sequence|| (state.sequence=1)),revision:state.revision,text,query:${JSON.stringify(query)},scope:q.selector||'main-document',mode:q.mode||'interactive'};
    }
    const snapshot=state.snapshot;
    if(offset>snapshot.text.length)return {error:'INVALID_INPUT',detail:'offset exceeds snapshot text'};
    const targetResult=snapshot.mode==='text'?{ok:true,matches:[],total:0}:(${findScript(query, { limit: 80, offset: "elementOffset", query: "snapshot.query" })});
    if(!targetResult.ok)return {error:'INVALID_SELECTOR'};
    // Continuations enumerate only the required element page using the same shared locator.
    const rows=targetResult.matches;
    const budget=Math.max(1000,Math.min(100000,q.maxChars||30000));
    const elements=[];let used=700;
    for(const row of rows){const item={selector:row.selector,id:row.id,tag:row.tag,label:row.name||'',role:row.role,type:row.type,visible:row.visible,disabled:row.disabled,checked:row.checked,expanded:row.expanded,options:row.options?.slice(0,8),optionsTruncated:row.optionsTruncated||row.options?.length>8||undefined};const size=JSON.stringify(item).length;if(used+size>budget/2)break;elements.push(item);used+=size;}
    if(rows.length&&!elements.length)return {error:'READ_LIMIT',detail:'control metadata exceeds output budget; increase max_chars or use mode:text'};
    const full=snapshot.text;
    // Never split a UTF-16 surrogate pair at either page boundary.
    if(offset>0&&/[\\uDC00-\\uDFFF]/.test(full[offset]||'')&&/[\\uD800-\\uDBFF]/.test(full[offset-1]||''))return {error:'INVALID_INPUT',detail:'offset splits Unicode'};
    let end=Math.min(full.length,offset+Math.max(1,budget-used));
    if(end<full.length&&/[\\uD800-\\uDBFF]/.test(full[end-1]||''))end--;
    const nextElement=elementOffset+elements.length,elementsTruncated=nextElement<targetResult.total;
    const result=()=>({url:location.href,title:document.title.slice(0,160),titleTruncated:document.title.length>160,text:full.slice(offset,end),textTotal:full.length,textOffset:offset,textTruncated:end<full.length,nextOffset:end<full.length?end:undefined,elements:snapshot.mode==='text'?undefined:elements,elementsTotal:targetResult.total,elementsTruncated,nextCursor:end<full.length||elementsTruncated?snapshot.id+':'+end+':'+nextElement:undefined,documentId:state.documentId,contentRevision:snapshot.revision,scope:snapshot.scope,coverage:{iframe:'selected-document',shadowDOM:'open',closedShadowDOM:'excluded'},contentState:!full.trim()?(document.readyState==='complete'?'empty':'loading'):/^(loading|加载中|正在加载)[.。…\\s]*$/i.test(full.trim())?'loading':'ready'});
    let output=result(),overshoot=JSON.stringify(output).length+250-budget;
    if(overshoot>0){end=Math.max(offset,end-overshoot);if(end>offset&&/[\\uD800-\\uDBFF]/.test(full[end-1]||''))end--;output=result();}
    if(JSON.stringify(output).length+250>budget)return {error:'READ_LIMIT',detail:'metadata exceeds output budget; increase max_chars or narrow scope'};
    return output;
  })()`);
}
