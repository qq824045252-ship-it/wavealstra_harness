import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import type { App } from "electron";
import { currentPlatformId } from "./index";

/** Windows toast activation must launch the same application AND profile, not electron.exe alone. */
export interface NotificationLaunchContext {
  execPath: string;
  appPath: string;
  appName: string;
  userData: string;
  home: string;
  entry: string;
  packaged: boolean;
  rendererUrl?: string;
  environment: Record<string, string>;
}

export function notificationProtocol(context: Pick<NotificationLaunchContext, "appPath" | "userData" | "home">): string {
  const identity = [context.appPath, context.userData, context.home].map(p => p.replaceAll("\\", "/").toLowerCase());
  return `mybuddy-notify-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)}`;
}

export function parseNotificationActivation(value: string, scheme: string): string | null {
  // Do not normalize arbitrary URLs into accepted commands. There are no path/env/command parameters.
  const prefix = `${scheme}://open/`;
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export function notificationToastXml(scheme: string, id: string, title: string, body: string): string {
  const url = `${scheme}://open/${id}`;
  if (!parseNotificationActivation(url, scheme)) throw new Error("Invalid notification identity");
  return `<toast activationType="protocol" launch="${xml(url)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
}

/** A trusted local launcher stores paths only. Activation input can select a notification, never a file or command. */
export function notificationLauncherSource(context: NotificationLaunchContext, scheme: string): string {
  return `"use strict";
const cfg = ${JSON.stringify(context)};
const scheme = ${JSON.stringify(scheme)};
const {app, dialog} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const uri = process.argv.find(v => v.startsWith(scheme + '://open/'));
if (!uri || !new RegExp('^' + scheme + '://open/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','i').test(uri)) { app.exit(1); }
else {
  // Restore profile before loading ANY product module; its imports may open stores.
  for (const [key,value] of Object.entries(cfg.environment)) process.env[key] = value;
  process.env.HOME = cfg.home; process.env.USERPROFILE = cfg.home;
  app.setPath('userData', cfg.userData); app.setAppPath(cfg.appPath); app.setName(cfg.appName);
  process.chdir(cfg.appPath);
  const fail = reason => { dialog.showErrorBox('MyBuddy 通知无法打开', reason); app.exit(1); };
  const load = () => {
    if (!fs.existsSync(cfg.entry)) return fail('通知所属的开发入口已不存在。请重新启动该 MyBuddy 工作区；不会改用其他用户数据。');
    try { require(cfg.entry); return true; } catch(error) { fail(String(error)); return false; }
  };
  const queueDir=path.join(cfg.userData,'notification-launch-queue');
  fs.mkdirSync(queueDir,{recursive:true});
  const valid = value => typeof value==='string' && new RegExp('^'+scheme+'://open/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','i').test(value);
  const enqueue = value => { if(valid(value)) fs.writeFileSync(path.join(queueDir,value.slice(value.lastIndexOf('/')+1)+'.request'),value); };
  const handoff=path.join(queueDir,'handoff.json');
  const readHandoff=()=>{try{return JSON.parse(fs.readFileSync(handoff,'utf8'))}catch{return null}};
  // Keep the product's before-ready initialization synchronous. The startup owner
  // holds the same Electron single-instance lock throughout compilation; queued
  // clicks are handed to its child, never to competing vite processes.
  if (process.env.MYBUDDY_NOTIFICATION_DEV_RESTART === scheme && process.env.ELECTRON_RENDERER_URL) {
    enqueue(uri);
    fs.writeFileSync(handoff,JSON.stringify({pid:process.pid,token:process.env.MYBUDDY_NOTIFICATION_START_ID,expiresAt:Date.now()+15000}));
    const deadline=Date.now()+15000, waitCell=new Int32Array(new SharedArrayBuffer(4));
    let acquired=false;
    while(!(acquired=app.requestSingleInstanceLock()) && Date.now()<deadline) Atomics.wait(waitCell,0,0,50);
    if(!acquired) fail('通知启动交接超时；未读取其他用户的数据。');
    else {
      const own=readHandoff(); if(own?.pid===process.pid) fs.unlinkSync(handoff);
      const consumed=[];
      for(const file of fs.readdirSync(queueDir)) {
        if(!/^[0-9a-f-]{36}[.]request$/i.test(file)) continue;
        const item=path.join(queueDir,file), value=fs.readFileSync(item,'utf8');
        if(valid(value)) {
          if(!process.argv.includes(value)) process.argv.push(value);
          consumed.push(item);
        }
      }
      // Preserve queued identities if importing the product fails. Never consume
      // them merely because this wrapper managed to acquire the process lock.
      if(load()) for(const item of consumed) fs.unlinkSync(item);
    }
  } else if (!app.requestSingleInstanceLock()) app.exit(0);
  else {
    enqueue(uri);
    // During the small lock transfer interval the launched child already owns
    // the handoff marker. A new caller queues its click and yields to that child.
    const transferring=readHandoff();
    let childAlive=false;
    try {
      // A reused PID is not a perpetual promise to receive clicks. A handoff is
      // valid only during the child's bounded lock-acquisition interval.
      if(Number.isSafeInteger(transferring?.pid) && typeof transferring.token==='string' &&
        Number.isSafeInteger(transferring.expiresAt) && transferring.expiresAt>Date.now() && transferring.expiresAt<=Date.now()+15000) {
        process.kill(transferring.pid,0);childAlive=true;
      }
    } catch {}
    if(childAlive){app.releaseSingleInstanceLock();app.exit(0);}
    else {
      app.on('second-instance',(_event,args)=>{for(const value of args) enqueue(value)});
      const cli=path.join(cfg.appPath,'node_modules','electron-vite','bin','electron-vite.js');
      if (!fs.existsSync(cli)) fail('此通知所属的开发服务不可用。请重新运行该工作区的 pnpm dev，再点击通知。');
      else {
        const token=process.pid+'-'+Date.now();
        const env={...process.env,...cfg.environment,ELECTRON_RUN_AS_NODE:'1',MYBUDDY_NOTIFICATION_DEV_RESTART:scheme,MYBUDDY_NOTIFICATION_START_ID:token};
        delete env.ELECTRON_CLI_ARGS; delete env.ELECTRON_RENDERER_URL; delete env.REMOTE_DEBUGGING_PORT;
        const log=fs.openSync(path.join(cfg.userData,'notification-dev-launch.log'),'a');
        const args=['dev','--outDir',path.dirname(path.dirname(cfg.entry)),'--entry',__filename,'--',uri];
        const boot="delete process.env.ELECTRON_RUN_AS_NODE;process.argv=[process.execPath,"+JSON.stringify(cli)+",..."+JSON.stringify(args)+"];import(require('node:url').pathToFileURL("+JSON.stringify(cli)+").href).catch(e=>{console.error(e);process.exit(1)});";
        const child=require('node:child_process').spawn(cfg.execPath,['-e',boot],{cwd:cfg.appPath,env,detached:true,windowsHide:true,stdio:['ignore',log,log]});
        child.once('error',error=>fail(String(error))); child.once('spawn',()=>{child.unref();fs.closeSync(log);});
        const deadline=Date.now()+120000;
        const timer=setInterval(()=>{const ready=readHandoff();if(ready?.token===token){clearInterval(timer);app.releaseSingleInstanceLock();app.exit(0)}else if(Date.now()>deadline){clearInterval(timer);fail('MyBuddy 开发服务启动超时，请查看 notification-dev-launch.log。')}},50);
      }
    }
  }
}
`;
}

export class WindowsNotificationActivation {
  private registered = false;
  readonly scheme: string;
  constructor(private readonly app: Pick<App, "setAsDefaultProtocolClient" | "isDefaultProtocolClient">,
    private readonly context: NotificationLaunchContext,
    private readonly receive: (id: string) => void,
    private readonly platform = currentPlatformId) {
    this.scheme = notificationProtocol(context);
  }

  accept(argv: readonly string[]): boolean {
    if (this.platform !== "windows") return false;
    let accepted = false;
    for (const arg of argv) {
      const id = parseNotificationActivation(arg, this.scheme);
      if (id) { this.receive(id); accepted = true; }
    }
    return accepted;
  }

  toast(id: string, title: string, body = ""): string | undefined {
    if (this.platform !== "windows") return undefined;
    if (!this.registered) {
      if (this.context.packaged) {
        // Packaged executables cannot run the development bootstrap. Never silently
        // substitute the real user's home for a test/portable HOME on cold start.
        const agentDir = this.context.environment.PI_CODING_AGENT_DIR;
        if (this.context.home.toLowerCase() !== userInfo().homedir.toLowerCase() ||
          (agentDir !== undefined && agentDir.toLowerCase() !== join(this.context.home, ".mybuddy").toLowerCase())) {
          throw new Error("Packaged notification activation requires the current Windows user profile");
        }
        const args = [`--user-data-dir=${this.context.userData}`];
        if (!this.app.isDefaultProtocolClient(this.scheme, this.context.execPath, args) &&
          !this.app.setAsDefaultProtocolClient(this.scheme, this.context.execPath, args)) throw new Error("Windows notification activation registration failed");
      } else {
        const launcher = join(this.context.userData, "notification-activation.cjs");
        mkdirSync(dirname(launcher), { recursive: true });
        writeFileSync(launcher, notificationLauncherSource(this.context, this.scheme), "utf8");
        if (!this.app.isDefaultProtocolClient(this.scheme, this.context.execPath, [launcher]) &&
          !this.app.setAsDefaultProtocolClient(this.scheme, this.context.execPath, [launcher])) throw new Error("Windows development notification activation registration failed");
      }
      this.registered = true;
    }
    return notificationToastXml(this.scheme, id, title, body);
  }
}
