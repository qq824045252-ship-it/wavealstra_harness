import {registerHooks} from 'node:module';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const compiled=process.env.TSGO_UI_COMPILED;
if(!compiled)throw new Error('Missing compiled test root');
registerHooks({
 resolve(specifier,context,next){
  let path;
  if(specifier.startsWith('@/'))path=resolve(compiled,'src/renderer/src',specifier.slice(2));
  else if(specifier.startsWith('@shared/'))path=resolve(compiled,'src/shared',specifier.slice(8));
  else if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:'))path=fileURLToPath(new URL(specifier,context.parentURL));
  if(path){
   if(path.endsWith('.css'))return {url:'data:text/javascript,export default {}',shortCircuit:true};
   for(const candidate of [path,path+'.js',resolve(path,'index.js')])if(existsSync(candidate) && statSync(candidate).isFile())return {url:pathToFileURL(candidate).href,shortCircuit:true};
  }
  return next(specifier,context);
 },
 load(url,context,next){
  if(url.startsWith(pathToFileURL(compiled).href+'/')&&url.endsWith('.json'))return {format:'module',source:'export default '+readFileSync(fileURLToPath(url),'utf8'),shortCircuit:true};
  if(url.startsWith(pathToFileURL(compiled).href)&&url.endsWith('.js'))return {format:'module',source:readFileSync(fileURLToPath(url),'utf8'),shortCircuit:true};
  return next(url,context);
 }
});
