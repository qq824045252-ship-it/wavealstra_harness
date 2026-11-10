import { createRoot } from "react-dom/client";
import { BotRename } from "../src/renderer/src/components/pages/BotRename";
import { useAppStore } from "../src/renderer/src/store/appStore";
import type { BotDto } from "../src/shared/bot-work";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
const initial = { botId: "rename-test", displayName: "原名称", updatedAt: 1 } as BotDto;
let bot = JSON.parse(localStorage.getItem("rename-bot") ?? "null") as BotDto | null;
bot ??= initial;
const calls: unknown[] = [];
Object.assign(window, { renameCalls: calls, api: { botWork: { renameBot: async (request: {displayName:string; expectedUpdatedAt:number}) => {
  calls.push(request); await new Promise(resolve=>setTimeout(resolve,150));
  if (request.displayName === "重复") return {ok:false,message:"已有同名 Bot，请换一个名称"};
  if (request.expectedUpdatedAt !== bot!.updatedAt) return {ok:false,message:"Bot 已在其他位置更新，请关闭后重新打开重命名"};
  bot = {...bot!, displayName:request.displayName, updatedAt:bot!.updatedAt+1}; localStorage.setItem("rename-bot",JSON.stringify(bot));
  return {ok:true,bot,replayed:false};
} } }, concurrentRename: () => { bot={...bot!,displayName:"其他窗口",updatedAt:bot!.updatedAt+1}; useAppStore.setState({botIdentities:[bot]}); } });
useAppStore.setState({botIdentities:[bot],refreshBotWork:async()=>{},refreshSpaces:async()=>{}});
function Fixture() {
 const current = useAppStore(state=>state.botIdentities[0]);
 return <main style={{padding:24}}><header className="bot-heading-title"><h1>{current.displayName}</h1><BotRename bot={current}/></header><aside>侧栏：{current.displayName}</aside><p>团队成员：{current.displayName}</p><p>原对话和任务</p></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
