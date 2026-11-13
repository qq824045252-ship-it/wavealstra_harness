import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import SavedFileActions from '../src/renderer/src/components/pages/SavedFileActions';
const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
const document = window.document;
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
let previews = 0, saves = 0, opens = 0;
let cancel = true, failure = false;
const request = { snapshotPath: '/store/artifacts/old.txt', name: 'report.txt' };
Object.assign(window, { api: { savedArtifact: {
 openSystem: async (value: unknown) => { assert.deepEqual(value, request); opens++; if(failure)throw new Error('missing snapshot'); },
 saveAs: async (value: unknown) => { assert.deepEqual(value, request); saves++; return { canceled: cancel, path: '/save/report.txt' }; }
} } });
async function main() {
 const { createRoot } = await import('react-dom/client'); const root = createRoot(document.getElementById('root')!);
 await act(async () => { root.render(<SavedFileActions request={request} onPreview={() => previews++} />); });
 const buttons = () => [...document.querySelectorAll('button')];
 assert.deepEqual(buttons().map(b=>b.textContent), ['预览','系统方式打开','保存']);
 await act(async () => buttons()[0].click()); assert.equal(previews,1); assert.equal(opens+saves,0);
 await act(async () => { buttons()[1].click(); buttons()[1].click(); }); assert.equal(opens,1);
 await act(async () => buttons()[2].click()); assert.equal(saves,1); assert.equal(document.querySelector('[role=status]'),null);
 cancel=false; await act(async () => buttons()[2].click()); assert.match(document.body.textContent!,/已保存副本/);
 failure=true; await act(async () => buttons()[1].click()); assert.match(document.body.textContent!,/missing snapshot/);
 await act(async () => root.render(<SavedFileActions key="missing" onPreview={() => previews++} />));
 assert.equal(buttons()[1].disabled,true); assert.equal(buttons()[2].disabled,true); assert.equal(buttons()[0].disabled,false);
 await act(async () => root.unmount()); console.log('saved file actions DOM PASS: labels, existing preview callback, exact identity, repeated click guard, canceled/saved/error/missing snapshot');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
