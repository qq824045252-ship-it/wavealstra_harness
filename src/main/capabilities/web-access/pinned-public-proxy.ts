/** Compatibility for an already configured local FlClash TUN, not an SSRF exception.
 * Resolve through its existing HTTPS DNS provider, then CONNECT only checked public
 * IPs. TLS always authenticates the original host. No config writes or direct fallback.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BlockList, isIP } from "node:net";
import { parse } from "yaml";
import { request as undiciRequest, ProxyAgent } from "undici";

const denied4 = new BlockList();
for (const [network,prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) denied4.addSubnet(network,prefix);
const global6 = new BlockList(); global6.addSubnet("2000::",3,"ipv6");
const denied6 = new BlockList();
for (const [network,prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]] as const) denied6.addSubnet(network,prefix,"ipv6");
export function isPublicProxyAddress(ip: string): boolean {
  return isIP(ip) === 4 ? !denied4.check(ip) : isIP(ip) === 6 && global6.check(ip,"ipv6") && !denied6.check(ip,"ipv6");
}
export interface ExistingProxy { port:number; fakeIpRange:string }
export function parseExistingProxy(value: unknown): ExistingProxy | undefined {
  const c=value as any;
  if (!c || c.tun?.enable !== true || c.dns?.enable !== true || c.dns?.["enhanced-mode"] !== "fake-ip"
    || c["allow-lan"] !== false || (c.authentication !== undefined && (!Array.isArray(c.authentication) || c.authentication.length !== 0)) || !Number.isInteger(c["mixed-port"])
    || c["mixed-port"]<1 || c["mixed-port"]>65535 || c["bind-address"] && !["127.0.0.1","localhost","*"].includes(c["bind-address"])) return;
  // Only the existing configured provider is trusted, not arbitrary resolver URLs.
  if (!Array.isArray(c.dns.nameserver) || !c.dns.nameserver.includes("https://dns.alidns.com/dns-query")) return;
  if (!["198.18.0.1/16","198.18.0.0/16","198.18.0.1/15","198.18.0.0/15"].includes(c.dns["fake-ip-range"])) return;
  return {port:c["mixed-port"],fakeIpRange:c.dns["fake-ip-range"]};
}
export function loadExistingProxy(): ExistingProxy | undefined {
  try {
    const path=join(homedir(),".local/share/com.follow.clash/config.yaml");
    if(statSync(path).size>4*1024*1024) return;
    return parseExistingProxy(parse(readFileSync(path,"utf8"),{maxAliasCount:0}));
  } catch { return; }
}
const normalize=(s:string)=>s.toLowerCase().replace(/\.$/,"");
export function parsePublicDns(value: unknown, hostname: string, type:1|28): string[] {
  const v=value as any;
  const questions=Array.isArray(v?.Question)?v.Question:v?.Question?[v.Question]:[];
  if (!v || v.Status!==0 || v.TC!==false || questions.length!==1
    || normalize(questions[0].name ?? "")!==normalize(hostname) || questions[0].type!==type) throw Error("Unverified public DNS response");
  const answers=Array.isArray(v.Answer)?v.Answer:[];
  if(answers.length>64) throw Error("Oversized public DNS answer");
  const names=new Set([normalize(hostname)]);let current=normalize(hostname);
  for(let n=0;n<=8;n++) {
    const aliases=answers.filter((a:any)=>a.type===5 && normalize(a.name ?? "")===current);
    if(!aliases.length)break;
    if(aliases.length!==1 || n===8 || typeof aliases[0].data!=="string")throw Error("Invalid public DNS CNAME chain");
    const next=normalize(aliases[0].data);if(names.has(next))throw Error("Cyclic public DNS CNAME chain");names.add(next);current=next;
  }
  const addresses=answers.filter((a:any)=>[1,28].includes(a.type) && names.has(normalize(a.name ?? "")));
  for(const a of addresses) if(isIP(a.data)!==(a.type===1?4:6) || !isPublicProxyAddress(a.data)) throw Error("Public DNS returned a non-public target");
  const relevant=addresses.filter((a:any)=>a.type===type);
  return relevant.map((a:any)=>a.data);
}

/** Buffer is deliberately bounded so the per-hop agent cannot leak beyond the
 * verified response lifetime. Redirects are returned to the caller for revalidation. */
async function pinnedFetch(url:URL, ip:string, proxy:ExistingProxy, init:RequestInit={},limit=5*1024*1024):Promise<Response> {
  if(url.protocol!=="https:" || url.username || url.password || !["GET","HEAD"].includes((init.method??"GET").toUpperCase()) || init.body) throw Error("Pinned proxy supports HTTPS GET/HEAD without URL credentials only");
  if(!isPublicProxyAddress(ip)) throw Error("Pinned proxy target is not public");
  const hostname=url.hostname.replace(/^\[|\]$/g,"");
  const address=new URL(url);address.hostname=isIP(ip)===6?`[${ip}]`:ip;
  const agent=new ProxyAgent({uri:`http://127.0.0.1:${proxy.port}`,proxyTunnel:true,
    requestTls:{servername:hostname,rejectUnauthorized:true}});
  const signal=AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(20000)]);
  try {
    const headers=new Headers(init.headers);headers.set("host",url.host);headers.delete("proxy-authorization");headers.set("accept-encoding","identity");
    // Prevent a forged host or a compressed body/header mismatch after fetch decoding.
    // fetch() forbids Host overrides; request() preserves the original authority
    // while the dispatcher CONNECTs only to the already verified literal IP.
    const response=await undiciRequest(address,{method:(init.method??"GET").toUpperCase() as "GET"|"HEAD",
      headers:Object.fromEntries(headers),signal,dispatcher:agent});
    const encoding=response.headers["content-encoding"];
    if(encoding && encoding!=="identity")throw Error("Unexpected encoded pinned response");
    const chunks:Uint8Array[]=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error("Pinned proxy response exceeds limit");chunks.push(chunk);}
    const resultHeaders=new Headers();for(const [name,value]of Object.entries(response.headers))if(value!==undefined)for(const v of Array.isArray(value)?value:[value])resultHeaders.append(name,v);
    resultHeaders.delete("content-length");
    const result=new Response(init.method?.toUpperCase()==="HEAD" || [204,205,304].includes(response.statusCode)?null:Buffer.concat(chunks),{status:response.statusCode,headers:resultHeaders});
    Object.defineProperty(result,"url",{value:url.href});return result;
  } finally { await agent.destroy(); }
}
export function existingProxyForFakeAddresses(addresses:Array<{address:string}>):ExistingProxy|undefined {
  const proxy=loadExistingProxy();
  return proxy && addresses.length && addresses.every(a=>/^198\.18\./.test(a.address) || proxy.fakeIpRange.endsWith("/15") && /^198\.19\./.test(a.address)) ? proxy : undefined;
}
export async function fetchThroughExistingPublicProxy(url:URL, init:RequestInit, proxy:ExistingProxy):Promise<Response> {
  if (!["GET","HEAD"].includes((init.method??"GET").toUpperCase()) || init.body) throw Error("Pinned public proxy supports GET/HEAD only");
  if(url.protocol!=="https:" || isIP(url.hostname.replace(/^\[|\]$/g,""))) throw Error("Fake-IP compatibility requires an HTTPS hostname");
  const hostname=normalize(url.hostname);
  if(!hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan)$/i.test(hostname) || url.username || url.password) throw Error("Pinned proxy requires a public hostname");
  const resolve=async(type:1|28)=>{
    const endpoint=new URL("https://dns.alidns.com/resolve");endpoint.searchParams.set("name",hostname);endpoint.searchParams.set("type",String(type));
    const response=await pinnedFetch(endpoint,"223.5.5.5",proxy,{signal:init.signal},65536);
    if(response.status!==200)throw Error("Existing public DNS service unavailable");
    return parsePublicDns(await response.json(),hostname,type);
  };
  const resolved=(await Promise.all([resolve(1),resolve(28)])).flat();
  if(!resolved.length) throw Error("Existing public DNS returned no verified address");
  return pinnedFetch(url,resolved[0],proxy,init);
}
