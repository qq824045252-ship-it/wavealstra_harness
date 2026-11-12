/** Reuse the real conversation/store host fixture; this adds only directory data. */
import './bot-conversation-concurrent-desktop-fixture';
import { createRoot } from 'react-dom/client';
import { applyFontSettings } from '../src/renderer/src/lib/fontSettings';
Object.assign(window, { setPreviewFontSize: (uiFontSize: number) => applyFontSettings({uiFontSize}) });
import { useAppStore } from '../src/renderer/src/store/appStore';
import { BotDisplayGroups } from '../src/renderer/src/components/BotDisplayGroups';
import { BotTeamsNavigation } from '../src/renderer/src/components/BotTeamsNavigation';
const state = useAppStore.getState();
const bot = state.botIdentities[0];
useAppStore.setState({ botIdentities: [
  { ...bot, displayName: '工作搭子' },
  { ...bot, botId: 'design', displayName: '产品与设计' },
  { ...bot, botId: 'erp', displayName: 'ERP 前端 · 很长的名称也要保持完整可访问', status: 'paused' },
] });
Object.assign(window.api!.botWork, {
  collaborations: async () => ({items:[],total:0,nextCursor:null}),
  displayGroups: async () => ({ groups: [{id:'work', name:'工作', collapsed:false}], membership:{ bot:'work', design:'work' } }),
  teamControl: async () => ({ok:true, templates:[{templateId:'product', name:'产品研发团队', ownerBotId:'bot', members:[{botId:'design'}]}]}),
  queryWorks: async () => ({works:[], workExecutionTaskIds:[], total:0, filtered:0, page:1, pageSize:24, pages:0, filterCounts:{}, viewCounts:{active:0,completed:0,closed:0,all:0}, deletedCount:0, watermark:{epoch:'fixture',sequence:0,revision:'0'}}),
});
const sidebar = document.createElement('aside');
sidebar.className = 'sidebar interface-directory';
sidebar.setAttribute('aria-label', 'Bot 目录');
document.body.prepend(sidebar);
const directoryRoot = createRoot(sidebar);
Object.assign(window, { disposeDirectoryFixture: () => directoryRoot.unmount() });
directoryRoot.render(<><div className="sidebar-tree-header"><span className="section-title">我的 Bot</span><span className="sidebar-section-count">3</span></div><BotDisplayGroups/><BotTeamsNavigation/></>);
const style = document.createElement('style');
style.textContent = `body{display:flex;margin:0}#root{display:flex;flex:1;min-width:0;height:100dvh;overflow:hidden}.interface-directory{width:264px;flex:0 0 264px;padding-top:24px;height:100dvh;overflow:auto}.interface-directory .sidebar-tree-header{padding:0 18px 12px}@media(max-width:900px){.interface-directory{display:none}}`;
document.head.append(style);
