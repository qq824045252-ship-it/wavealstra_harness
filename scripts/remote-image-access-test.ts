import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { RemoteImageService, RemoteImageError, type RemoteArtifactReader } from '../src/main/remote/RemoteImageService';
import { RemoteAccessServer } from '../src/main/remote/RemoteAccessServer';
import { RemoteAccessPairing } from '../src/main/remote/RemoteAccessPairing';
import { RemoteDeviceStore } from '../src/main/remote/RemoteDeviceStore';
import { RemoteEventBus } from '../src/main/remote/RemoteEventBus';
import { RemoteClient } from '../app/remote/src/api/RemoteClient';
import { reduceRemotePatch } from '../app/remote/src/store/remotePatch';
import { buildRemoteTimeline } from '../app/remote/src/store/remoteTimeline';
import { loadRemoteImage } from '../app/remote/src/components/RemoteImages';
import { resolveRemoteImageReference, remoteImageReference } from '../shared/src/remote-images';
import type { ArtifactDescriptor } from '../src/shared/artifact-types';
import type { RemoteImageArtifact, RemoteTaskHistory } from '../shared/src/remote-contract';

const report: string[] = [];
function pass(name: string) { report.push(name); console.log('PASS ' + name); }
const root = mkdtempSync(join(tmpdir(), 'mybuddy-image-test-'));
const safeRoot = join(root, 'task'); mkdirSync(safeRoot);
const outside = join(root, 'outside'); mkdirSync(outside);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const rows = new Map<string, ArtifactDescriptor>();
function add(id: string, name: string, bytes: Buffer | string, options: Partial<ArtifactDescriptor> = {}) {
  const file = join(safeRoot, name); writeFileSync(file, bytes);
  const d: ArtifactDescriptor = { id, taskId: 't1', kind: 'image', source: { type: 'workspace-file', rootDir: safeRoot, entryFile: file }, version: 1, capabilities: {}, mimeType: 'image/png', createdAt: 1, updatedAt: 1, createdByToolCallId: 'image-tool', ...options };
  rows.set(id, d); return d;
}
const image = add('image-one', 'plan.png', png);
add('other-task', 'other.png', png, { taskId: 't2' });
add('not-image', 'secret.txt', 'private', { kind: 'code' });
add('spoof', 'fake.png', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
add('jpeg', 'picture.jpg', Buffer.from([255,216,255,224,0,0,0]), { mimeType: 'text/plain' });
const managed = add('managed', 'encoded.bin', 'data:image/png;base64,' + png.toString('base64'));
managed.source = { type: 'managed-content', rootDir: safeRoot, storagePath: 'encoded.bin' };
const large = add('too-large', 'large.png', png);
const fd = openSync((large.source as { entryFile: string }).entryFile, 'r+'); ftruncateSync(fd, 24 * 1024 * 1024); closeSync(fd);
writeFileSync(join(outside, 'outside.png'), png);
symlinkSync(outside, join(safeRoot, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
rows.set('escape', { ...image, id: 'escape', source: { type: 'workspace-file', rootDir: safeRoot, entryFile: join(safeRoot, 'junction', 'outside.png') } });
rows.set('missing', { ...image, id: 'missing', source: { type: 'workspace-file', rootDir: safeRoot, entryFile: join(safeRoot, 'gone.png') } });
const source: RemoteArtifactReader = {
  get: id => rows.get(id) ?? null,
  getSnapshot: taskId => ({ taskId, state: 'ready', revision: 1, artifacts: [...rows.values()].filter(d => d.taskId === taskId) }),
  entryPathOf: id => { const d = rows.get(id); return d ? d.source.type === 'workspace-file' ? d.source.entryFile : join(d.source.rootDir, d.source.storagePath) : null; },
  listMessageRefs: () => [],
};
const service = new RemoteImageService({ getTask: id => ['t1','t2'].includes(id) ? { id, cwd: safeRoot } as never : undefined } as never, () => source);
let server: RemoteAccessServer | undefined;
try {
  assert.deepEqual((await service.read('t1', 'image-one', 1)).bytes, png); pass('registered PNG bytes are read intact');
  assert.equal((await service.read('t1', 'jpeg')).mimeType, 'image/jpeg'); pass('Content-Type is derived from bytes, not declared MIME');
  assert.deepEqual((await service.read('t1', 'managed')).bytes, png); pass('managed data-URI images share the bounded binary endpoint');
  for (const [task, id, status] of [['t1','other-task',404],['t1','not-image',404],['absent','image-one',404],['t1','missing',404],['t1','escape',404],['t1','spoof',415],['t1','too-large',413]] as const) {
    await assert.rejects(service.read(task,id), (e: unknown) => e instanceof RemoteImageError && e.status === status);
    pass('rejects ' + id + ' with ' + status);
  }
  await assert.rejects(service.read('t1', 'image-one', 2), (e: unknown) => e instanceof RemoteImageError && e.status === 409); pass('stale versions cannot be served under a new cache key');
  const history: RemoteTaskHistory = { taskId: 't1', messages: [
    { id: 'hist-user', role: 'user', text: 'generate', createdAt: 1 },
    { id: 'hist-assistant', role: 'assistant', text: '图片已生成', createdAt: 2, tools: [{ id: 'image-tool', tool: 'image_generate', summary: '', status: 'success' }] },
    { id: 'next-user', role: 'user', text: 'next', createdAt: 3 },
    { id: 'unrelated', role: 'assistant', text: 'unrelated', createdAt: 4 },
  ] };
  const enriched = service.enrichHistory('t1', history);
  assert.ok(enriched.messages[1].artifacts?.some(a => a.id === image.id));
  assert.equal(enriched.messages[3].artifacts, undefined);
  assert.equal(enriched.imageArtifacts?.some(a => a.id === 'other-task'), false);
  pass('history restores image provenance without relying on regenerated message IDs or guessing other replies');
  const descriptor = enriched.imageArtifacts!.find(a => a.id === image.id)!;
  for (const ref of [(image.source as {entryFile:string}).entryFile, (image.source as {entryFile:string}).entryFile.replace(/\\/g,'/'), 'plan.png', remoteImageReference(image.id)]) assert.equal(resolveRemoteImageReference(ref,[descriptor])?.id,image.id);
  assert.equal(resolveRemoteImageReference('../plan.png',[descriptor]), undefined);
  assert.equal(resolveRemoteImageReference('https://evil.test/plan.png',[descriptor]), undefined);
  assert.equal(resolveRemoteImageReference('other/plan.png',[descriptor]), undefined);
  const winImage: RemoteImageArtifact = { ...descriptor, sources: ['C:\\Tasks\\Photos\\plan.png', 'generated/image/plan.png'] };
  assert.equal(resolveRemoteImageReference('file:///C:/Tasks/Photos/plan.png',[winImage])?.id,image.id);
  assert.equal(resolveRemoteImageReference('C:%5CTasks%5CPhotos%5Cplan.png',[winImage])?.id,image.id);
  pass('path aliases resolve exact registered images, including Windows and encoded paths, never basename/suffix matches');
  const live = reduceRemotePatch({}, history.messages.slice(0,1), { apiVersion: 1,id: 1,at: 2,type:'agent.patch',payload:{ type:'artifact_ref',taskId:'t1',messageId:'live-a',artifactId:image.id,name:'plan',kind:'image',change:'created' } });
  assert.equal(buildRemoteTimeline(history.messages.slice(0,1),live)[1].artifacts?.[0].id,image.id); pass('live artifact_ref renders an image-only response beneath its user');

  const devices = new RemoteDeviceStore(join(root,'devices.json'));
  const issued = devices.issue('Image test');
  server = new RemoteAccessServer({ port:0,devices,pairing:new RemoteAccessPairing(devices),events:new RemoteEventBus(),commands:{} as never,service:{ image:(task: string,id: string,v?:number)=>service.read(task,id,v) } as never });
  const {port}=await server.start();
  const path = '/v1/tasks/t1/artifacts/image-one/image?v=1';
  const http = (pathname = path, headers: Record<string,string> = {}, method='GET') => new Promise<{status:number;headers:Record<string,unknown>;body:Buffer}>((resolve,reject) => {
    const req=request({host:'127.0.0.1',port,path:pathname,method,headers},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end();
  });
  assert.equal((await http()).status,401); pass('HTTP image endpoint requires device authentication');
  const headers={authorization:'Bearer '+issued.token,origin:'https://localhost'};
  const response=await http(path,headers); assert.equal(response.status,200); assert.deepEqual(response.body,png);
  assert.equal(response.headers['access-control-allow-origin'],'https://localhost'); assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');
  pass('authenticated Android CORS returns real binary image with private cache policy');
  assert.equal((await http(path,{...headers,origin:'https://evil.test'})).status,403);pass('untrusted browser origin is rejected');
  assert.equal((await http(path.replace('t1/artifacts','t2/artifacts'),headers)).status,404);pass('HTTP cross-task artifact ID is rejected');
  assert.equal((await http(path+'&path=C:/private.png',headers)).status,400);pass('arbitrary-path query is not a file-read API');
  assert.equal((await http(path.replace('v=1','v=2'),headers)).status,409);
  assert.equal((await http(path,headers,'HEAD')).body.length,0);pass('HEAD and version validation preserve the same authorization boundary');
  const client=new RemoteClient('http://127.0.0.1:'+port,issued.token);
  let downloads=0;const original=client.image.bind(client);client.image=async(...args)=>{downloads++;return original(...args)};
  const [b1,b2]=await Promise.all([loadRemoteImage(client,'t1',descriptor),loadRemoteImage(client,'t1',descriptor)]);
  assert.strictEqual(b1,b2);assert.equal(downloads,1);assert.deepEqual(Buffer.from(await b1.arrayBuffer()),png);pass('duplicate references share one authenticated request; snapshots do not re-download');
  image.version=2;
  await loadRemoteImage(client,'t1',{...descriptor,version:2});assert.equal(downloads,2);pass('new artifact version refetches instead of reusing stale bytes');
  devices.revoke(issued.device.id);assert.equal((await http(path,headers)).status,401);pass('revoked device cannot load image bytes');
  console.log(JSON.stringify({ok:true,passed:report.length}));
} finally { await server?.stop();rmSync(root,{recursive:true,force:true}); }
