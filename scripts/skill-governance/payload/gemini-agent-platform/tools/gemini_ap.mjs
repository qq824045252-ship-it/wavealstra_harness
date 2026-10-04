import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

// CLI > process environment > Windows user environment > config.env.
// Read only the named values; never print credentials or request URLs.
export function configuration(configPath, env=process.env, registry=true) {
  const names=['GEMINI_AP_API_KEY','GEMINI_AP_PROJECT','GEMINI_AP_LOCATION','GEMINI_AP_MODEL','GEMINI_API_KEY','GEMINI_DEV_MODEL'];
  const config={};
  if(fs.existsSync(configPath)) for(const line of fs.readFileSync(configPath,'utf8').split(/\r?\n/)) {
    const match=line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if(match && names.includes(match[1])) config[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
  }
  for(const name of names) {
    if(registry && process.platform==='win32' && !env[name]) {
      const result=spawnSync('reg.exe',['query','HKCU\\Environment','/v',name],{encoding:'utf8',windowsHide:true,shell:false});
      if(result.status===0) {
        const match=result.stdout.match(new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`,'m'));
        if(match) config[name]=match[1].trim();
      }
    }
    if(env[name]) config[name]=env[name];
  }
  return config;
}
const numeric = {'temperature':[0,2], 'top-p':[0,1], 'top-k':[1,Infinity], 'max-output-tokens':[1,Infinity], resize:[1,Infinity]};
export function request(v, config) {
  if(!v.prompt) throw Error('--prompt is required');
  if(!['agentplatform','developer'].includes(v.endpoint)) throw Error('Invalid --endpoint');
  for(const [key,[min,max]] of Object.entries(numeric)) if(v[key]!==undefined) {
    const value=Number(v[key]);
    if(!Number.isFinite(value)||value<min||value>max||(['top-k','max-output-tokens','resize'].includes(key)&&!Number.isInteger(value))) throw Error(`Invalid --${key}`);
  }
  if(v.size) throw Error('--size was a no-op in the legacy wrapper; use --aspect-ratio, --resize or describe size in --prompt');
  const developer=v.endpoint==='developer';
  const key=config[developer?'GEMINI_API_KEY':'GEMINI_AP_API_KEY'];
  const model=v.model || config[developer?'GEMINI_DEV_MODEL':'GEMINI_AP_MODEL'] || 'gemini-2.5-flash';
  const project=v.project || config.GEMINI_AP_PROJECT;
  const location=v.location || config.GEMINI_AP_LOCATION || 'global';
  if(!key || (!developer&&!project)) throw Error(developer?'Missing GEMINI_API_KEY':'Missing GEMINI_AP_API_KEY or GEMINI_AP_PROJECT');
  const part=[{text:v.prompt}];
  if(v['image-path']) {
    const mimes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.heic':'image/heic'};
    const mimeType=mimes[path.extname(v['image-path']).toLowerCase()];
    if(!mimeType) throw Error('Unsupported input image format');
    part.push({inlineData:{mimeType,data:fs.readFileSync(v['image-path']).toString('base64')}});
  }
  const body={contents:[{role:'user',parts:part}]};
  if(v['system-instruction']) body.systemInstruction={parts:[{text:v['system-instruction']}]};
  const generationConfig={};
  for(const [flag,key] of [['temperature','temperature'],['top-p','topP'],['top-k','topK'],['max-output-tokens','maxOutputTokens']]) if(v[flag]!==undefined) generationConfig[key]=Number(v[flag]);
  if(v['generate-image']) {
    generationConfig.responseModalities=['TEXT','IMAGE'];
    if(v['aspect-ratio']) generationConfig.imageConfig={aspectRatio:v['aspect-ratio']};
  } else if(v['aspect-ratio'] || v.resize || v['out-image']) throw Error('Image options require --generate-image');
  if(Object.keys(generationConfig).length) body.generationConfig=generationConfig;
  const enc=encodeURIComponent;
  const url=developer ? `https://generativelanguage.googleapis.com/v1beta/models/${enc(model)}:generateContent` : `https://aiplatform.googleapis.com/v1/projects/${enc(project)}/locations/${enc(location)}/publishers/google/models/${enc(model)}:generateContent`;
  return {url,headers:{'Content-Type':'application/json','x-goog-api-key':key},body,model};
}
export function saveResponse(resp,v,model) {
  const parts=resp.candidates?.[0]?.content?.parts || [];
  const texts=parts.filter(p=>p.text && !p.thought).map(p=>p.text);
  const images=parts.map(p=>p.inlineData || p.inline_data).filter(Boolean);
  if(!texts.length&&!images.length) throw Error(`Response has no text or image (finishReason=${resp.candidates?.[0]?.finishReason || resp.promptFeedback?.blockReason || 'unknown'})`);
  if(v['generate-image']&&!images.length) throw Error('Requested images but response contains no image');
  if(v.raw) { console.log(JSON.stringify(resp,null,2));return []; }
  if(texts.length) console.log(texts.join('\n'));
  const saved=[];
  for(const [index,img] of images.entries()) {
    const mime=img.mimeType || img.mime_type;
    const ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'}[mime];
    if(!ext || !img.data) throw Error('Unsupported or empty output image');
    const bytes=Buffer.from(img.data,'base64');
    if(!bytes.length) throw Error('Empty decoded image');
    let target=v['out-image'] || `${model.replace(/[^\w.-]/g,'_')}_${Date.now()}${ext}`;
    const parsed=path.parse(target);
    // Actual MIME is authoritative; never write JPEG bytes to a .png filename.
    target=path.resolve(parsed.dir,parsed.name+(images.length>1?`_${index+1}`:'')+ext);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,bytes,{flag:'wx'});
    saved.push(target);
    console.log(`[image] ${target} (${bytes.length} bytes; ${mime})`);
    if(v.resize) {
      const resized=target.slice(0,-ext.length)+`_${v.resize}x${v.resize}`+ext;
      if(fs.existsSync(resized)) throw Error(`Refusing to overwrite ${resized}`);
      const code='from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.resize((int(sys.argv[3]),int(sys.argv[3])),Image.Resampling.LANCZOS).save(sys.argv[2])';
      const result=spawnSync('uv',['run','--no-project','python','-c',code,target,resized,String(v.resize)],{stdio:'inherit',shell:false,windowsHide:true});
      if(result.error || result.status!==0) throw Error(`Resize failed; original retained at ${target}. Check uv/Pillow.`);
      saved.push(resized);console.log(`[image] ${resized}`);
    }
  }
  if(resp.usageMetadata) console.error(`[usage] ${JSON.stringify(resp.usageMetadata)}`);
  return saved;
}
async function main() {
  const stringOptions=['prompt','endpoint','model','project','location','system-instruction','temperature','max-output-tokens','top-p','top-k','image-path','aspect-ratio','out-image','resize','size'];
  const options=Object.fromEntries(stringOptions.map(k=>[k,{type:'string'}]));
  for(const name of ['generate-image','raw','help']) options[name]={type:'boolean'};
  options.endpoint.default='agentplatform';
  const {values:v}=parseArgs({options});
  if(v.help) { console.log('node gemini_ap.mjs --prompt TEXT [--endpoint agentplatform|developer] [--model ID] [--image-path FILE] [--generate-image --out-image FILE --aspect-ratio RATIO --resize N] [--system-instruction TEXT] [--temperature N] [--top-p N] [--top-k N] [--max-output-tokens N] [--raw]');return; }
  const config=configuration(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../config.env'));
  const req=request(v,config);
  const response=await fetch(req.url,{method:'POST',headers:req.headers,body:JSON.stringify(req.body),signal:AbortSignal.timeout(180000)});
  const data=await response.json();
  if(!response.ok) {
    const message=String(data.error?.message || 'Request failed').replaceAll(req.headers['x-goog-api-key'],'[REDACTED]');
    throw Error(`HTTP ${response.status}: ${message}`);
  }
  saveResponse(data,v,req.model);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{
  console.error(JSON.stringify({error:'gemini_request_failed',message:error.message}));process.exitCode=1;
});
