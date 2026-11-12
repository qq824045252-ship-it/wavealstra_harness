import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/appStore';
import { IconBot } from './common/icons';
import type { BotDisplayGroupCommand, BotDisplayGroups as Snapshot } from '@shared/bot-display-groups';
import './BotDisplayGroups.css';
import { useTextPrompt } from './common/useTextPrompt';
export function BotDisplayGroups({onSelect}:{onSelect?:()=>void}) {
 const host=useAppStore(s=>s.botHostStatus);
 const bots=useAppStore(s=>s.botIdentities), active=useAppStore(s=>s.activeBotId), team=useAppStore(s=>s.activeTeam), select=useAppStore(s=>s.setActiveBotId);
 const [data,setData]=useState<Snapshot>({groups:[],membership:{}}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[menu,setMenu]=useState<string|null>(null);
 const [menuPosition,setMenuPosition]=useState({top:0,left:0});
 function toggleMenu(id:string,element:HTMLElement){const r=element.getBoundingClientRect();setMenuPosition({top:Math.max(8,Math.min(r.bottom+4,window.innerHeight-310)),left:Math.max(8,Math.min(r.right-200,window.innerWidth-248))});setMenu(menu===id?null:id);}
 const {requestText,textPromptDialog}=useTextPrompt();
 useEffect(()=>{if(!menu)return;const close=(event:PointerEvent)=>{if(!(event.target as Element).closest('.bot-display-actions'))setMenu(null);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[menu]);
 const flight=useRef(false);
 useEffect(()=>{let live=true;Promise.resolve().then(()=>window.api!.botWork.displayGroups({kind:'list'})).then(d=>{if(live)setData(d);}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[]);
 async function mutate(command:BotDisplayGroupCommand){if(flight.current)return false;flight.current=true;setBusy(true);setError('');try{setData(await window.api!.botWork.displayGroups(command));setMenu(null);return true;}catch(e){setError(e instanceof Error?e.message:String(e));return false;}finally{flight.current=false;setBusy(false);}}
 async function edit(id?:string,botId?:string){setMenu(null);setError('');const name=await requestText({title:id?'重命名分组':'创建分组',label:'分组名称',initialValue:data.groups.find(g=>g.id===id)?.name??'',placeholder:'例如：工作、学习、生活',confirmLabel:'保存',maxLength:60,description:'仅整理 Bot 列表，不影响任务、对话或工作空间。'});if(name!==null)await mutate(id?{kind:'rename',id,name}:{kind:'create',name,botId});}
 function rows(id:string|null){return bots.filter(b=>(data.membership[b.botId]??null)===id).map(b=><div className="bot-display-row" key={b.botId}>
  <button type="button" className="sidebar-bot-row sidebar-bot-identity" aria-pressed={!team&&active===b.botId} onClick={()=>{select(b.botId);onSelect?.();}}><span className="sidebar-bot-avatar"><IconBot size={18}/></span><span><strong title={b.displayName}>{b.displayName}</strong><small data-state={b.status==='active'?(host?.online?'online':'offline'):b.status}>{b.status==='active'?(host?(host.online?'在线':'离线'):'未核实'):b.status==='paused'?'已暂停':'已停用'}</small></span></button>
  <div className="bot-display-actions"><button type="button" aria-label={`移动 ${b.displayName} 到分组`} aria-expanded={menu===b.botId} onClick={e=>toggleMenu(b.botId,e.currentTarget)}>⋯</button>{menu===b.botId&&<div className="bot-display-menu" style={menuPosition} role="menu" aria-label="移至分组"><span>移至</span>{[{id:null,name:'未分组'},...data.groups].map(g=><button role="menuitemradio" aria-checked={id===g.id} disabled={busy} key={g.id??'none'} onClick={()=>void mutate({kind:'move',botId:b.botId,groupId:g.id})}>{id===g.id?'✓ ':''}{g.name}</button>)}<button role="menuitem" onClick={()=>edit(undefined,b.botId)}>＋ 创建分组</button></div>}</div>
 </div>);}
 return <section className="bot-display-groups" aria-label="Bot 分组" onKeyDown={e=>{if(e.key==='Escape')setMenu(null);}}>
  <button className="bot-display-create" type="button" onClick={()=>edit()}>＋ 创建分组</button>
  {error&&<p role="alert" className="bot-alert">{error}</p>}
  {data.groups.map(g=><section key={g.id} className="bot-display-group"><header><button type="button" aria-expanded={!g.collapsed} disabled={busy} onClick={()=>void mutate({kind:'collapse',id:g.id,collapsed:!g.collapsed})}><span>{g.collapsed?'▸':'▾'}</span> {g.name}<small>{bots.filter(b=>data.membership[b.botId]===g.id).length}</small></button><div className="bot-display-actions"><button aria-label={`管理分组 ${g.name}`} aria-expanded={menu===g.id} onClick={e=>toggleMenu(g.id,e.currentTarget)}>⋯</button>{menu===g.id&&<div role="menu" className="bot-display-menu" style={menuPosition}><button role="menuitem" onClick={()=>edit(g.id)}>重命名分组</button><button role="menuitem" disabled={busy} onClick={()=>void mutate({kind:'delete',id:g.id})}>删除分组</button><small>Bot 将移回未分组，不会被删除</small></div>}</div></header>{!g.collapsed&&(rows(g.id).length?rows(g.id):<p className="bot-display-empty">暂无 Bot，通过 Bot 旁的「⋯」移入</p>)}</section>)}
  <section className="bot-display-group"><header><span>未分组</span><small>{bots.filter(b=>!data.membership[b.botId]).length}</small></header>{rows(null)}</section>
  {textPromptDialog}
 </section>;
}
