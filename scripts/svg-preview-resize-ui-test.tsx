/** Real Chromium/React SVG preview resizing; includes an animated SVG and a
 * no-viewBox fallback. The test collects, rather than suppresses, browser errors. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import DetailCard from '../src/renderer/src/components/chat/DetailCard';
import '../src/renderer/src/styles/global.css';
const host=document.getElementById('root')!;
host.style.width='700px';host.style.margin='20px';
const result:{errors:string[];cases:Array<{name:string;heights:number[];stable:boolean}>;unmounted?:boolean}={errors:[],cases:[]};
window.addEventListener('error',e=>result.errors.push(e.message));
window.addEventListener('unhandledrejection',e=>result.errors.push(String(e.reason)));
host.addEventListener('load',e=>{const frame=e.target;if(frame instanceof HTMLIFrameElement)frame.contentWindow?.addEventListener('error',error=>result.errors.push('iframe: '+error.message));},true);
const root=createRoot(host);
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const height=()=>document.querySelector('iframe')?.getBoundingClientRect().height||0;
const fixtures=[
 {name:'intrinsic animated SVG',source:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"><rect width="800" height="400" fill="white"/><circle cx="150" cy="200" r="40"><animate attributeName="cx" values="150;650;150" dur="4s" repeatCount="indefinite"/></circle></svg>'},
 {name:'no-viewBox DOM fallback',source:'<svg xmlns="http://www.w3.org/2000/svg" style="height:240px;width:100%"><rect width="100%" height="240" fill="white"/><circle cx="120" cy="120" r="30"/></svg>'},
];
(window as unknown as {runResizeTest:()=>Promise<typeof result>}).runResizeTest=async()=>{
 for(const fixture of fixtures){
  root.render(<DetailCard content={fixture.source} contentKind="svg"/>);await wait(450);
  const heights:number[]=[];
  for(let i=0;i<20;i++){host.style.width=(i%2?710:480)+'px';await wait(70);heights.push(height());}
  const settled=height();await wait(250);result.cases.push({name:fixture.name,heights,stable:Math.abs(height()-settled)<2});
 }
 host.style.width='650px';root.unmount();await wait(100);result.unmounted=document.querySelector('iframe')===null;
 return result;
};
