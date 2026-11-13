import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseHTML} from 'linkedom';
import BotWorkspacePage from '../src/renderer/src/components/pages/BotWorkspacePage';
import {BotExecutionDiagnosticsButton} from '../src/renderer/src/components/pages/BotExecutionDiagnostics';
import {BotActivityMonitor} from '../src/renderer/src/components/pages/BotActivityMonitor';
import {useAppStore} from '../src/renderer/src/store/appStore';
const state=useAppStore.getState();
Object.assign(state,{activeBotId:'header-bot',activeTeam:null,botIdentities:[{botId:'header-bot',displayName:'测试助理',status:'active',organizationRole:'primary',responsibilitySummary:'测试',authorization:[],settingsRevision:1}],botHistories:{},botWorks:[],selectedWorkId:null});
function inspect(){return parseHTML(renderToStaticMarkup(<BotWorkspacePage/>)).document;}
const doc=inspect();
const labels=['协作记录','执行诊断','新对话','所有消息','Bot 设置与对话管理'];
for(const label of labels){const b=doc.querySelector<HTMLButtonElement>(`.bot-workspace-actions button[aria-label="${label}"]`)!;assert(b,label);assert.equal(b.type,'button');assert.equal(b.title,label);assert.equal(b.textContent,'');assert(b.querySelector('svg'));assert.equal(b.getAttribute('tabindex'),null);assert(b.classList.contains('bot-icon-button'));}
assert(doc.querySelector('.bot-workspace-actions .lucide-settings'));
assert(!doc.querySelector('.bot-workspace-actions .lucide-sliders-horizontal'));
for(const label of ['执行诊断','所有消息']){const b=doc.querySelector(`button[aria-label="${label}"]`)!;assert.equal(b.getAttribute('aria-haspopup'),'dialog');assert.equal(b.getAttribute('aria-expanded'),'false');}
assert.match(renderToStaticMarkup(<BotExecutionDiagnosticsButton request={{kind:'work',workId:'w'}}/>),/>执行诊断<\/button>/);
assert.match(renderToStaticMarkup(<BotActivityMonitor onOpenBotMessage={()=>{}}/>),/>所有消息<\/button>/);
Object.assign(state,{activeTeam:{templateId:'team',name:'产品团队',ownerBotId:'header-bot',members:[]}});
const team=inspect();assert(!team.querySelector('button[aria-label="协作记录"]'));assert(team.querySelector('button[aria-label="团队设置与管理"] svg'));
console.log('PASS header icon labels, titles, native button/focus semantics, gear, dialog state, personal/team scope, shared text defaults; not desktop geometry');
