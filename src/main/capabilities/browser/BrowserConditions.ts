import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { withBrowserDom } from "./BrowserDom";

const selector = Type.String({ minLength: 1, maxLength: 2000 });
const text = Type.String({ maxLength: 1000 });
const match = Type.Optional(Type.Union([Type.Literal("equals"), Type.Literal("contains")]));
const within = Type.Optional(selector);
export const browserConditionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("url"), value: text, match }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("text"), selector: Type.Optional(selector), within, value: text, match }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("value"), selector, within, value: text }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("count"), selector, within, count: Type.Integer({ minimum: 0, maximum: 1_000_000 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("state"), selector, within, state: Type.Union((["attached", "detached", "visible", "hidden", "enabled", "disabled", "checked", "unchecked", "editable", "expanded", "collapsed"] as const).map(value => Type.Literal(value))) }, { additionalProperties: false }),
]);
export type BrowserCondition = Static<typeof browserConditionSchema>;
const evidenceValue = Type.Union([Type.String({ maxLength: 1000 }), Type.Number(), Type.Boolean(), Type.Null()]);
const evidenceSchema = Type.Array(Type.Object({
  kind: Type.Union(["url", "text", "value", "count", "state"].map(value => Type.Literal(value))),
  matched: Type.Boolean(), observed: evidenceValue, expected: evidenceValue,
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
}, { additionalProperties: false }), { maxItems: 16 });
export type BrowserConditionEvidence = Static<typeof evidenceSchema>[number];

export function parseBrowserConditionEvidence(value: unknown): BrowserConditionEvidence[] {
  if (!Value.Check(evidenceSchema, value)) throw new Error("Invalid browser condition evidence");
  return value;
}

/** This is a fixed read-only script; all data is serialized, never executable caller code. */
export function browserConditionsScript(conditions: readonly BrowserCondition[]): string {
  if (conditions.length > 16 || !conditions.every(condition => Value.Check(browserConditionSchema, condition))) throw new Error("Invalid browser conditions");
  const serialized = JSON.stringify(conditions);
  return withBrowserDom(`(() => {
    const conditions = ${serialized};
    const bounded = value => String(value ?? '').slice(0,1000);
    const result = (c, matched, observed, expected, reason) => ({kind:c.kind,matched,observed,expected,...(reason?{reason}: {})});
    const matchText = (actual, expected, mode) => mode === 'contains' ? actual.includes(expected) : actual === expected;
    const visible = el => {
      if (!el.isConnected || !el.checkVisibility({visibilityProperty:true,opacityProperty:true})) return false;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      for(let p=el;p;p=__mbDom.parent(p)) if (p instanceof HTMLDetailsElement && !p.open && !p.querySelector(':scope > summary')?.contains(el)) return false;
      return true;
    };
    const stateValue = (el, state) => {
      if(state==='attached')return true;
      if(state==='detached')return false;
      if(state==='visible')return visible(el);
      if(state==='hidden')return !visible(el);
      if(state==='enabled'||state==='disabled'){
        const disabled=el.matches(':disabled') || el.getAttribute('aria-disabled')==='true';
        return state==='disabled'?disabled:!disabled;
      }
      if(state==='editable') return !el.matches(':disabled') && el.getAttribute('aria-disabled')!=='true' && !el.readOnly && (el instanceof HTMLInputElement && !['button','checkbox','radio','submit','reset','file','hidden','range','color'].includes(el.type) || el instanceof HTMLTextAreaElement || el.isContentEditable);
      if(state==='checked'||state==='unchecked'){
        const aria=el.getAttribute('aria-checked');
        if (!('checked' in el) && aria!=='true' && aria!=='false') return null;
        const checked=aria==='true'||('checked' in el && el.checked===true);
        return state==='checked'?checked:!checked;
      }
      if(state==='expanded'||state==='collapsed'){
        const detail=el instanceof HTMLDetailsElement ? el : el instanceof HTMLElement && el.tagName==='SUMMARY' && el.parentElement instanceof HTMLDetailsElement ? el.parentElement : null;
        const aria=el.getAttribute('aria-expanded');
        if(!detail && aria!=='true' && aria!=='false')return null;
        const expanded=detail?detail.open:aria==='true';
        return state==='expanded'?expanded:!expanded;
      }
      return null;
    };
    return conditions.map(c => {
      const expected = c.kind==='count'?c.count:c.kind==='state'?c.state:c.kind==='value'?'[redacted]':c.value;
      try {
        if(c.kind==='url') {const value=location.href;return result(c,matchText(value,c.value,c.match),value.startsWith('data:')?'[data URL]':bounded(value),bounded(expected));}
        let root=document;
        if(c.within){const scopes=__mbDom.all(c.within);if(scopes.length!==1)return result(c,false,scopes.length,bounded(expected),scopes.length?'ambiguous scope':'scope not found');root=scopes[0];}
        if(c.kind==='text' && !c.selector){const value=__mbDom.text(root===document?document.body:root);return result(c,matchText(value,c.value,c.match),bounded(value),bounded(expected));}
        const found=__mbDom.all(c.selector,root);
        if(c.kind==='count')return result(c,found.length===c.count,found.length,c.count);
        if(found.length>1)return result(c,false,found.length,bounded(expected),'ambiguous target');
        if(!found.length){const matched=c.kind==='state'&&(c.state==='detached'||c.state==='hidden');return result(c,matched,0,bounded(expected),matched?undefined:'target not found');}
        const el=found[0];
        if(c.kind==='text'){const value=__mbDom.text(el);return result(c,matchText(value,c.value,c.match),bounded(value),bounded(expected));}
        if(c.kind==='value'){
          if(!('value' in el) || typeof el.value!=='string')return result(c,false,null,bounded(expected),'target has no value');
          const password=el instanceof HTMLInputElement && el.type==='password';
          return result(c,el.value===c.value,password?'[redacted]':bounded(el.value),password?'[redacted]':bounded(c.value));
        }
        const state=stateValue(el,c.state);
        return result(c,state===true,state,bounded(expected),state===null?'state unsupported':undefined);
      } catch { return result(c,false,null,bounded(expected),'invalid selector or page state'); }
    });
  })()`);
}




