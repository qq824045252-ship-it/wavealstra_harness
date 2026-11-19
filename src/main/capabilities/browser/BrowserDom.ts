/** Shared document operations for native UI and browser automation. No globals
 * or page prototypes are patched; each invocation visits accessible open roots. */
export const browserDomPrelude = `const __mbDom=(()=>{
  const roots=(root=document)=>{const result=[root],seen=new Set(result);if(root.shadowRoot){result.push(root.shadowRoot);seen.add(root.shadowRoot);}for(let i=0;i<result.length;i++)for(const el of result[i].querySelectorAll('*'))if(el.shadowRoot&&!seen.has(el.shadowRoot)){seen.add(el.shadowRoot);result.push(el.shadowRoot);}return result;};
  const all=(selector,root=document)=>[...new Set([...(root instanceof Element&&root.matches(selector)?[root]:[]),...roots(root).flatMap(part=>Array.from(part.querySelectorAll(selector)))])];
  const one=(selector,root=document)=>{
    const nodes=all(selector,root);
    if(/^\\[data-mybuddy-ui-ref="[^"]+"\\]$/.test(selector))return nodes.find(el=>window.__mybuddyUiRefs?.get(el)===el.getAttribute('data-mybuddy-ui-ref'))||null;
    return nodes[0]||null;
  };
  const parent=el=>el.assignedSlot||el.parentElement||(el.getRootNode() instanceof ShadowRoot?el.getRootNode().host:null);
  const contains=(ancestor,node)=>{for(let current=node;current;current=parent(current))if(current===ancestor)return true;return false;};
  const active=()=>{let el=document.activeElement;while(el?.shadowRoot?.activeElement)el=el.shadowRoot.activeElement;return el;};
  const hit=(x,y)=>{let el=document.elementFromPoint(x,y),previous;while(el&&el!==previous){previous=el;el=el.shadowRoot?.elementFromPoint(x,y)||el;}return el;};
  const composedText=root=>{
    const seen=new Set();
    const walk=node=>{
      if(!node||seen.has(node))return '';seen.add(node);
      if(node.nodeType===Node.TEXT_NODE)return node.textContent||'';
      if(!(node instanceof Element||node instanceof ShadowRoot))return '';
      if(node instanceof HTMLSlotElement){const assigned=node.assignedNodes({flatten:true});return (assigned.length?assigned:Array.from(node.childNodes)).map(walk).join('');}
      if(node instanceof Element&&node.matches('script,style,noscript,input,textarea'))return '';
      return Array.from(node.shadowRoot?.childNodes||node.childNodes).map(walk).join('');
    };
    return walk(root);
  };
  const text=root=>{
    if(!root)return '';
    if(!all('*',root).some(el=>el.shadowRoot||el instanceof HTMLSlotElement)&&!root.shadowRoot)return root.innerText??root.textContent??'';
    const seen=new Set();
    const walk=node=>{
      if(seen.has(node))return '';seen.add(node);
      if(node.nodeType===Node.TEXT_NODE)return node.textContent||'';
      if(!(node instanceof Element||node instanceof ShadowRoot))return '';
      if(node instanceof Element){
        if(node instanceof HTMLSlotElement){const assigned=node.assignedNodes({flatten:true});return (assigned.length?assigned:Array.from(node.childNodes)).map(walk).join('');}
        if(node.matches('script,style,noscript,input,textarea')||!node.checkVisibility({visibilityProperty:true,opacityProperty:true}))return '';
        if(node.localName==='br')return '\\n';
      }
      const children=node.shadowRoot?.childNodes||node.childNodes;
      const value=Array.from(children).map(walk).join('');
      if(node instanceof Element&&['TD','TH'].includes(node.tagName))return value+'\\t';
      if(node instanceof Element&&['block','flex','grid','table-row','list-item'].includes(getComputedStyle(node).display))return value+'\\n';
      return value;
    };
    return walk(root).replace(/\\t\\n/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();
  };
  return {roots,all,one,parent,contains,active,hit,text,composedText};
})();`;

export function withBrowserDom(script: string): string {
  return `(() => {${browserDomPrelude}\nreturn (${script});})()`;
}
