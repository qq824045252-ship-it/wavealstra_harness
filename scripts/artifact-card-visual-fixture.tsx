import {renderToStaticMarkup} from 'react-dom/server';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {WorkFiles} from '../src/renderer/src/components/pages/BotWorkResult';
mkdirSync('.visual-card',{recursive:true});
const files=[{ref:'/index.html',name:'index.html',openPath:'/saved/index.html'},{ref:'/README.md',name:'README.md',openPath:'/saved/README.md'},{ref:'/long.html',name:'GPUI-introduction-with-a-very-long-deliverable-name.html',openPath:'/saved/long.html'}];
const markup=renderToStaticMarkup(<main className="bot-workspace"><div className="bot-assistant-content"><WorkFiles files={files} compact/></div></main>);
const css=readFileSync('src/renderer/src/components/pages/SavedFileActions.css','utf8')+'\n'+readFileSync('src/renderer/src/components/pages/BotWorkspacePage.css','utf8');
writeFileSync('.visual-card/index.html','<!doctype html><meta charset="utf-8"><style>:root{--fg:#202327;--fg-secondary:#68717d;--bg-hover:#edf0f4;--bg-elevated:#fff;--bg-primary:#fff;--border-subtle:#e2e6ec;--border-default:#d5dbe4;--border-strong:#bbc4d0;--accent:#4865d6;}body{margin:0;font-family:Segoe UI,sans-serif;background:#f9fafc;}main.bot-workspace{display:block;padding:24px;box-sizing:border-box;min-height:100vh}.bot-assistant-content{max-width:680px;margin:auto;padding:0!important}'+css+'</style>'+markup);
console.log('SSR production cards and real workspace CSS fixture generated (actions CSS before global CSS deliberately)');
