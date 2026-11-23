import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {act} from 'react';
import WorkFilePreview from '../src/renderer/src/components/pages/WorkFilePreview';
import {WorkFiles, WorkReport} from '../src/renderer/src/components/pages/BotWorkResult';
import type { WorkProjectionDto } from '../src/shared/bot-work';
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const prepared:string[]=[];const released:string[]=[];
Object.assign(window,{api:{savedArtifact:{prepare:async(v:any)=>{prepared.push(v.snapshotPath);throw new Error('fixture stops before document execution');},release:async(t:string)=>{released.push(t);}},readWorkspaceFile:async()=>{throw new Error('fixture stops before rendering content');}}});
const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
const files=[{ref:'/a/index.html',name:'index.html',openPath:'/saved/a.html'},{ref:'/b/index.html',name:'index.html',openPath:'/saved/b.html'},{ref:'/readme',name:'README.md',openPath:'/saved/readme.md'}];
await act(async()=>root.render(<WorkFiles files={files} compact/>));
const cards=()=>[...document.querySelectorAll('li')];
const previewButtons=()=>[...document.querySelectorAll<HTMLButtonElement>('button[aria-label="预览 index.html"]')];
assert.equal(previewButtons().length,2);
const initialButton=previewButtons()[0];assert.equal(initialButton.getAttribute('aria-expanded'),'false');
await act(async()=>initialButton.click());assert.equal(previewButtons()[0],initialButton);assert.equal(initialButton.getAttribute('aria-expanded'),'true');assert.equal(document.querySelector('.bot-work-file-preview')!.id,initialButton.getAttribute('aria-controls'));assert(document.querySelector('.bot-work-file-preview.is-expanded'));assert(![...document.querySelectorAll('button')].some(b=>['关闭预览','展开查看','收起查看'].includes(b.textContent!)));
assert.equal(document.querySelectorAll('.bot-work-file-preview').length,1);assert(cards()[0].querySelector('.bot-work-file-preview'));assert(!cards()[1].querySelector('.bot-work-file-preview'));assert.deepEqual(prepared,['/saved/a.html']);
await act(async()=>previewButtons()[1].click());
assert(!cards()[0].querySelector('.bot-work-file-preview'));assert(cards()[1].querySelector('.bot-work-file-preview'));assert.deepEqual(prepared,['/saved/a.html','/saved/b.html']);
const closeButton=previewButtons()[1];await act(async()=>closeButton.click());assert.equal(previewButtons()[1],closeButton);assert.equal(closeButton.getAttribute('aria-expanded'),'false');assert.equal(document.querySelector('.bot-work-file-preview'),null);
await act(async()=>document.querySelector<HTMLButtonElement>('button[aria-label="预览 README.md"]')!.click());assert(cards()[2].querySelector('.bot-work-file-preview'));
await act(async()=>root.render(<WorkFiles files={files.slice(0,2)} compact/>));assert.equal(document.querySelector('.bot-work-file-preview'),null);
const shared = [1,2].map(i => ({ref:'/same.html',name:'same.html',artifact:{bindingId:`binding-${i}`,path:'/original/same.html',snapshotPath:'/saved/same.html',digest:'shared-digest',sizeBytes:1}})) as Parameters<typeof WorkFiles>[0]['files'];
await act(async()=>root.render(<WorkFiles files={shared}/>));
const sharedButtons=()=>[...document.querySelectorAll<HTMLButtonElement>('button[aria-label="预览 same.html"]')];
await act(async()=>sharedButtons()[0].click());assert.equal(document.querySelectorAll('.bot-work-file-preview').length,1);assert(cards()[0].querySelector('.bot-work-file-preview'));assert(!cards()[1].querySelector('.bot-work-file-preview'));
await act(async()=>sharedButtons()[1].click());assert.equal(document.querySelectorAll('.bot-work-file-preview').length,1);assert(!cards()[0].querySelector('.bot-work-file-preview'));assert(cards()[1].querySelector('.bot-work-file-preview'));
await act(async()=>root.render(<WorkFiles files={shared.slice(0,1)}/>));assert.equal(document.querySelector('.bot-work-file-preview'),null);
await act(async()=>root.render(<WorkFilePreview file={files[0]} target={files[0].openPath} onClose={()=>{}}/>));assert([...document.querySelectorAll('button')].some(b=>b.textContent==='展开查看'));assert([...document.querySelectorAll('button')].some(b=>b.textContent==='关闭预览'));
const report: Parameters<typeof WorkReport>[0]['report'] = {
  title: 'Reviewed Work', summary: 'Original result retained', artifactRefs: [], notices: [], current: true,
  reviewStatus: 'accepted', completion: { nextStep: 'deliver', outcome: 'completed' },
  verification: { version: 1, workId: 'work', executionId: 'binding', intentRevision: 1,
    inputSnapshotId: 'snapshot', ownerEpoch: 1, historicalExecution: false, checks: [], omittedCount: 0 },
};
const work = { workId: 'work', intentRevision: 1, inputSnapshotId: 'snapshot', ownerEpoch: 1, executions: [] } as unknown as WorkProjectionDto;
const renderReport = (work: WorkProjectionDto) => act(async () => root.render(<WorkReport
  report={report} originalText={report.summary} executionId="binding" work={work} renderMarkdown={text => <p>{text}</p>} />));
const badge = () => document.querySelector('.bot-result-report .bot-status-badge')?.textContent;
await renderReport(work);
assert.equal(badge(), '已完成');
await renderReport({ ...work, intentRevision: 2 });
assert.match(document.querySelector('.bot-work-verification summary')?.textContent ?? '', /^历史核对记录/);
assert.equal(badge(), '历史成果');
assert.match(document.querySelector('.bot-result-body')?.textContent ?? '', /Original result retained/);
await act(async()=>root.unmount());console.log('PASS file-card previews and historical result presentation');
