'use strict';
// Observation only. Preserve function this, result/Promise identity and errors.
const {AsyncLocalStorage}=require('node:async_hooks'),path=require('node:path');
exports.install=({electron,home,add,clock})=>{
 const scope=new AsyncLocalStorage();let serial=0;
 const safe=p=>typeof p==='string'&&(p===home||p.startsWith(home+path.sep));
 const emit=(kind,data)=>{try{add(kind,clock(),data);}catch{}};
 const originalHandle=electron.ipcMain.handle;
 electron.ipcMain.handle=function(channel,handler){if(channel!=='workspace:openFolder')return Reflect.apply(originalHandle,this,[channel,handler]);
  return Reflect.apply(originalHandle,this,[channel,function(event,...args){if(!safe(args[0]))return Reflect.apply(handler,this,[event,...args]);const self=this,operationId='open-'+(++serial),target=args[0];
   emit('open-ipc-enter',{operationId,target,channel,webContentsId:event.sender?.id});return scope.run({operationId,target},()=>{let result;try{result=Reflect.apply(handler,self,[event,...args]);}catch(error){emit('open-ipc-throw',{operationId,target,errorName:error?.name,errorMessage:String(error?.message||error).slice(0,2000)});throw error;}
    if(result&&typeof result.then==='function')result.then(value=>emit('open-ipc-resolved',{operationId,target,returnType:typeof value}),error=>emit('open-ipc-rejected',{operationId,target,errorName:error?.name,errorMessage:String(error?.message||error).slice(0,2000)}));else emit('open-ipc-return',{operationId,target,returnType:typeof result});return result;
   });
  }]);
 };
 const originalOpen=electron.shell.openPath;
 electron.shell.openPath=function(target,...args){if(!safe(target))return Reflect.apply(originalOpen,this,[target,...args]);const operationId=scope.getStore()?.operationId||'shell-'+(++serial);emit('shell-open-enter',{operationId,target});let result;
  try{result=Reflect.apply(originalOpen,this,[target,...args]);}catch(error){emit('shell-open-throw',{operationId,target,errorName:error?.name,errorMessage:String(error?.message||error).slice(0,2000)});throw error;}
  if(result&&typeof result.then==='function')result.then(value=>emit('shell-open-resolved',{operationId,target,returnedError:String(value||'').slice(0,2000),osRequestAccepted:value===''}),error=>emit('shell-open-rejected',{operationId,target,errorName:error?.name,errorMessage:String(error?.message||error).slice(0,2000)}));return result;
 };
 emit('open-hooks-installed',{scope:'workspace:openFolder and shell.openPath only, paths inside isolated HOME'});
};
