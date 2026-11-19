/** Operate on a retained control and the current selection without touching the OS clipboard. */
export function browserEditorScript(selector: string, action: "focus" | "insert_text" | "paste", text = "", html?: string): string {
  return `(() => {
    const el=__mbDom.one(${JSON.stringify(selector)});
    if(!el?.isConnected || !el.checkVisibility({visibilityProperty:true}) || el.matches(':disabled')) throw Error('Editor target is unavailable');
    el.focus({preventScroll:true});
    if(__mbDom.active()!==el) throw Error('Target did not receive focus');
    if(${action === "focus"}) return;
    if(!(el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement && ['text','search','email','url','tel','number'].includes(el.type)) || el.readOnly) throw Error('Target is not an editable text control');
    const text=${JSON.stringify(text)}, supplied=${JSON.stringify(html ?? "")};
    let markup='';
    if(supplied) {
      const template=document.createElement('template'); template.innerHTML=supplied;
      template.content.querySelectorAll('script,style,template,svg,math,iframe,object,embed').forEach(node=>node.remove());
      const permitted=new Set('b strong em i u s sub sup br p div span h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tr td th blockquote code pre'.split(' '));
      for(const node of template.content.querySelectorAll('*')){
        if(!permitted.has(node.localName)){node.replaceWith(...node.childNodes);continue}
        for(const attr of Array.from(node.attributes))node.removeAttribute(attr.name);
      }
      markup=template.innerHTML;
    }
    if(${action === "paste"}) {
      const data=new DataTransfer(); data.setData('text/plain',text);
      if(markup)data.setData('text/html',markup);
      const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,composed:true,clipboardData:data});
      if(!el.dispatchEvent(event))return;
    }
    if(__mbDom.active()!==el)throw Error('Editing target changed');
    if(!document.execCommand(markup && el.isContentEditable?'insertHTML':'insertText',false,markup && el.isContentEditable?markup:text))throw Error('Editor rejected insertion');
  })()`;
}
