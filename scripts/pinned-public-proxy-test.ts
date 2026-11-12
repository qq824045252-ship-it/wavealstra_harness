import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import {execFileSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
import {fetchRemoteUrl,validateRemoteUrl,configuredPinnedProxy,PINNED_PUBLIC_PROXY} from "../src/main/capabilities/web-access/ssrf-protection";
import {stringify} from "yaml";
import {isPublicProxyAddress,parseExistingProxy,parsePublicDns,fetchThroughExistingPublicProxy} from "../src/main/capabilities/web-access/pinned-public-proxy";
for(const ip of ['0.0.0.0','10.0.0.1','100.64.1.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','198.18.0.1','224.0.0.1','255.255.255.255','192.0.2.1','::','::1','fc00::1','fe80::1','ff02::1','::ffff:127.0.0.1','64:ff9b::7f00:1','2002:7f00::1','2001::1','2001:db8::1','3fff::1'])assert.equal(isPublicProxyAddress(ip),false,ip);
for(const ip of ['8.8.8.8','223.5.5.5','2606:4700::1111'])assert(isPublicProxyAddress(ip),ip);
const config={tun:{enable:true},dns:{enable:true,'enhanced-mode':'fake-ip','fake-ip-range':'198.18.0.1/16',nameserver:['https://dns.alidns.com/dns-query']},'allow-lan':false,'mixed-port':7890};
assert(parseExistingProxy(config));
for(const patch of [{authentication:['a:b']},{authentication:'bad'},{'allow-lan':true},{'mixed-port':0},{tun:{enable:false}},{dns:{...config.dns,nameserver:['https://unknown.test/dns-query']}}])assert.equal(parseExistingProxy({...config,...patch}),undefined);
const dns={Status:0,TC:false,Question:[{name:'example.com.',type:1}],Answer:[{name:'example.com.',type:1,data:'8.8.8.8'}]};
assert.deepEqual(parsePublicDns(dns,'example.com',1),['8.8.8.8']);
assert.deepEqual(parsePublicDns({...dns,Question:dns.Question[0]},'example.com',1),['8.8.8.8']);
for(const patch of [{Status:3},{TC:true},{Question:[{name:'wrong.test',type:1}]},{Answer:[...dns.Answer,{name:'example.com.',type:28,data:'::1'}]},{Answer:[{name:'example.com.',type:5,data:'example.com.'}]}])assert.throws(()=>parsePublicDns({...dns,...patch},'example.com',1));
const authorities:string[]=[];
const proxy=net.createServer(socket=>{socket.once('data',chunk=>{authorities.push(chunk.toString().split('\r\n')[0]);socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');});});
proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
const port=(proxy.address() as net.AddressInfo).port;
try{
 await assert.rejects(fetchThroughExistingPublicProxy(new URL('https://example.com/'),{},{port,fakeIpRange:'198.18.0.1/16'}));
 assert(authorities.length>0);assert(authorities.every(x=>x==='CONNECT 223.5.5.5:443 HTTP/1.1'),'actual proxy CONNECT uses fixed DNS IP, never DNS hostname');
 const oldHome=process.env.HOME,oldUserProfile=process.env.USERPROFILE;const fixture=mkdtempSync(join(tmpdir(),'pinned-rebinding-'));
 try {
  process.env.HOME=fixture;process.env.USERPROFILE=fixture;const directory=join(fixture,'.local/share/com.follow.clash');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'config.yaml'),stringify({...config,'mixed-port':port}));
  let dnsCalls=0,ordinaryFetch=0;const sequence=['198.18.0.8','8.8.8.8','127.0.0.1'];
  const lookup=async()=>[{address:sequence[Math.min(dnsCalls++,2)],family:4}];
  let ticket;try {await validateRemoteUrl('https://example.com/',{lookup});}catch(error){ticket=configuredPinnedProxy(error);}
  assert(ticket,'preflight fake-IP retains verified existing proxy');
  await assert.rejects(fetchRemoteUrl('https://example.com/',{}, {[PINNED_PUBLIC_PROXY]:ticket,lookup,fetch:async()=>{ordinaryFetch++;return new Response('must not happen');}}));
  assert.equal(dnsCalls,1,'no second local DNS after selecting pinned route');assert.equal(ordinaryFetch,0,'fake-public-private rebinding never falls back to ordinary fetch');
 }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldUserProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=oldUserProfile;rmSync(fixture,{recursive:true,force:true});}
 const before=authorities.length;
 for(const url of ['http://example.com/','https://127.0.0.1/','https://localhost/','https://a.local/','https://user:password@example.com/'])await assert.rejects(fetchThroughExistingPublicProxy(new URL(url),{},{port,fakeIpRange:'198.18.0.1/16'}));
 await assert.rejects(fetchThroughExistingPublicProxy(new URL('https://example.com/'),{method:'POST'},{port,fakeIpRange:'198.18.0.1/16'}));
 assert.equal(authorities.length,before,'invalid requests never contact proxy');
}finally{proxy.close();}
if(process.argv.includes('--live')) {
const certDir=mkdtempSync(join(tmpdir(),'pinned-proxy-cert-'));
try {
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=wrong.invalid','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem')],{stdio:'ignore'});
 let acceptedRequests=0;
 const wrongTls=tls.createServer({key:readFileSync(join(certDir,'key.pem')),cert:readFileSync(join(certDir,'cert.pem'))},socket=>{socket.on('data',()=>{acceptedRequests++;socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}');});});
 wrongTls.on('tlsClientError',()=>{});wrongTls.listen(0,'127.0.0.1');await once(wrongTls,'listening');
 const badProxy=net.createServer(socket=>socket.once('data',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');const upstream=net.connect((wrongTls.address() as net.AddressInfo).port,'127.0.0.1',()=>{socket.pipe(upstream);upstream.pipe(socket);});socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());}));
 badProxy.listen(0,'127.0.0.1');await once(badProxy,'listening');
 try {await assert.rejects(fetchThroughExistingPublicProxy(new URL('https://example.com/'),{},{port:(badProxy.address() as net.AddressInfo).port,fakeIpRange:'198.18.0.1/16'}));assert.equal(acceptedRequests,0,'untrusted certificate cannot reach HTTP request');}
 finally {badProxy.close();wrongTls.close();}
}finally{rmSync(certDir,{recursive:true,force:true});}
}
console.log('PASS pinned-public-proxy: public-only IPv4/IPv6; existing config trust; DNS identity/mixed-private/CNAME; literal CONNECT; 407 zero fallback; invalid input zero network');
if(process.argv.includes('--live')) {
 const connects:string[]=[];const hellos:Buffer[]=[];
 const relay=net.createServer(client=>{let head=Buffer.alloc(0);const first=(chunk:Buffer)=>{
  head=Buffer.concat([head,chunk]);if(!head.includes('\r\n\r\n'))return;
  client.off('data',first);connects.push(head.toString().split('\r\n')[0]);
  const upstream=net.connect(7890,'127.0.0.1',()=>{upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  client.on('data',data=>{if(hellos.length<10)hellos.push(Buffer.from(data));});
  client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());
 };client.on('data',first);});
 relay.listen(0,'127.0.0.1');await once(relay,'listening');
 try {
  const response=await fetchThroughExistingPublicProxy(new URL('https://example.com/'),{}, {port:(relay.address() as net.AddressInfo).port,fakeIpRange:'198.18.0.1/16'});
  assert.equal(response.status,200);assert.match(await response.text(),/Example Domain/);
  assert(connects.length>=3);assert(connects.every(c=>/^CONNECT (?:[0-9.]+|\[[a-f0-9:]+\]):443 HTTP\/1\.1$/.test(c)));
  assert(connects.filter(c=>c==='CONNECT 223.5.5.5:443 HTTP/1.1').length>=2);
  assert(hellos.some(b=>b.includes('dns.alidns.com')));assert(hellos.some(b=>b.includes('example.com')));
  console.log('PASS LIVE: real AliDNS bootstrap TLS + literal public-IP CONNECT + original-host SNI + actual example.com content',connects);
 }finally{relay.close();}
}
