import assert from "node:assert/strict";
import { UiAutomationService, UiAutomationError } from "../src/main/capabilities/UiAutomationService";
const row = { selector: "body", tag: "body", visible: true, disabled: false, bounds: { x: 0, y: 0, width: 100, height: 100 } };
function fixture() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const pending = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  const events: unknown[] = [];
  const wc = { isDestroyed: () => false, getURL: () => "https://test.invalid", getTitle: () => "fixture", executeJavaScript: () => pending, sendInputEvent: (e: unknown) => events.push(e) };
  let current: typeof wc | null = wc;
  return { service: new UiAutomationService({ app: () => null, browser: () => current as any, artifact: () => null }), events, resolve, reject, replace: () => { current = null; } };
}
const input = { action: "scroll" as const, target: "browser" as const, selector: "body", deltaY: -1200, timeoutMs: 100 };
// The real failed path: a renderer lookup never resolves and the caller aborts.
{
 const f=fixture(), controller=new AbortController();
 const result=f.service.execute(input,controller.signal);
 await Promise.resolve(); controller.abort();
 await assert.rejects(result, (e:any)=>e.name==='AbortError');
 f.resolve({ok:true,matches:[row]}); await new Promise(r=>setTimeout(r,0));
 assert.equal(f.events.length,0);
}
// A timeout must release the caller even without cancellation; late lookup cannot scroll.
{
 const f=fixture(); await assert.rejects(f.service.execute(input),(e:any)=>e instanceof UiAutomationError&&e.code==='WAIT_TIMEOUT');
 f.resolve({ok:true,matches:[row]}); await new Promise(r=>setTimeout(r,0)); assert.equal(f.events.length,0);
}
// Late native rejection is observed, not an unhandled rejection.
{
 const f=fixture(), c=new AbortController(); const p=f.service.execute(input,c.signal); await Promise.resolve(); c.abort();
 await assert.rejects(p,(e:any)=>e.name==='AbortError'); f.reject(new Error('renderer destroyed')); await new Promise(r=>setTimeout(r,0));
}
{
 const f=fixture(); const p=f.service.execute(input); f.replace(); f.resolve({ok:true,matches:[row]});
 await assert.rejects(p,(e:any)=>e.code==='SURFACE_CHANGED'); assert.equal(f.events.length,0);
}
{
 const f=fixture(); const p=f.service.execute(input); f.resolve({ok:true,matches:[row]});
 assert.equal((await p).action,'scroll'); assert.equal(f.events.length,1);
}
// wait_for's outer polling deadline must also bound an individual renderer lookup.
{
 const f=fixture(); await assert.rejects(f.service.execute({...input,action:'wait_for'}),(e:any)=>e.code==='WAIT_TIMEOUT');
}
console.log('PASS UI renderer lookup abort, deadline, late resolve/reject, surface replacement, ordinary scroll and wait_for');

