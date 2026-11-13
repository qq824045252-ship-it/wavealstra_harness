import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BotAvatar } from "../src/renderer/src/components/common/BotAvatar";
import { BotAvatarSettings } from "../src/renderer/src/components/pages/BotAvatarSettings";
import { useBotAvatarStore } from "../src/renderer/src/lib/botAvatarStore";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
import "../src/renderer/src/styles/global.css";

const standalone=(window as unknown as {avatarPreviewApi?:unknown}).avatarPreviewApi;
Object.assign(window,{api:{botWork:{avatars:standalone ?? (async(request:unknown)=>{
 const response=await fetch('/command',{method:'POST',body:JSON.stringify(request)});return response.json();
})}}});
function Fixture() {
 const [bot,setBot]=useState('a'); const name=bot==='a'?'薄荷搭档':'桃桃搭档';
 return <main className="avatar-fixture"><h1>头像验收 · 合成素材</h1><p>{standalone ? "独立界面预览：选图与存储接口为测试替身。真实 SQLite、文件校验与 GIF 解码另有专项测试。" : "独立测试，使用临时 SQLite 与私有目录。"}</p>
  <nav><button onClick={()=>{document.documentElement.dataset.theme='light';}}>浅色</button><button onClick={()=>{document.documentElement.dataset.theme='dark';}}>深色</button><button onClick={()=>{void fetch('/pick-gif');}}>下次选择 GIF（测试）</button><button onClick={()=>{void fetch('/pick-png');}}>下次选择 PNG（测试）</button><button onClick={()=>setBot('a')}>切换 A</button><button onClick={()=>setBot('b')}>切换 B</button></nav>
  <div className="avatar-fixture-content"><aside aria-label="Bot 列表">{['a','b'].map(id=><button key={id} onClick={()=>setBot(id)}><BotAvatar className="sidebar-bot-avatar" botId={id} name={id==='a'?'薄荷搭档':'桃桃搭档'}/>{id==='a'?'薄荷搭档':'桃桃搭档'}</button>)}</aside>
  <section><header data-testid="header"><BotAvatar botId={bot} name={name} play/><strong>{name}</strong></header>
  <div data-testid="message"><BotAvatar botId={bot} name={name}/><strong>{name}</strong><p>这是验证头像一致性的测试消息。</p></div>
  <div data-testid="collaboration"><BotAvatar botId={bot} name={name}/><span>{name}的协作记录</span></div>
  <BotAvatarSettings key={bot} botId={bot} name={name}/>
  </section></div><section data-testid="many" aria-label="大量 Bot 列表">{Array.from({length:99},(_,i)=><BotAvatar key={i} botId={i%2?'a':'b'} name={`测试列表 ${i}`}/>)}</section>
 </main>;
}
Object.assign(window,{avatarTestStore:useBotAvatarStore});
createRoot(document.getElementById('root')!).render(<Fixture/>);
