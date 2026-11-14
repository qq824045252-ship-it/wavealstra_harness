/** Node-only headless fixtures: no bundler, no provider calls. */
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
registerHooks({
 resolve(specifier,context,next){
  let path;
  if(specifier==='electron')path=resolve(root,'scripts/arch-electron-stub.ts');
  else if(specifier.startsWith('@shared/'))path=resolve(root,'src/shared',specifier.slice(8));
  else if(specifier.startsWith('@/'))path=resolve(root,'src/renderer/src',specifier.slice(2));
  else if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:'))path=fileURLToPath(new URL(specifier,context.parentURL));
  if(path)for(const candidate of [path,path.replace(/\.js$/,'.ts'),path+'.ts',path+'.js',resolve(path,'index.ts')]){
    if(existsSync(candidate)&&statSync(candidate).isFile())return {url:pathToFileURL(candidate).href,shortCircuit:true};
  }
  return next(specifier,context);
 },
 load(url,context,next){
  if(url.startsWith('file:')&&url.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform',sourceUrl:url}),shortCircuit:true};
  return next(url,context);
 }
});
