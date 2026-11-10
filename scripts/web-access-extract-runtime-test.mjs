/** Bundle and execute the real HTTP extractor without optional native canvas. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = process.cwd();
mkdirSync(join(root, 'out/tests'), { recursive: true });
const temp = mkdtempSync(join(root, 'out/tests/web-extract-'));
const savedConfig = process.env.PI_CODING_AGENT_DIR;
const savedFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = temp;
try {
  const linkedomRoot = dirname(require.resolve('linkedom/package.json'));
  const pkg = JSON.parse(readFileSync(join(linkedomRoot, 'package.json'), 'utf8'));
  const result = await build({
    entryPoints: [join(root, 'src/main/capabilities/web-access/extract.ts')],
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    outfile: join(temp, 'extract.mjs'), metafile: true, logLevel: 'silent',
    plugins: [{ name: 'bundle-real-dom-without-native-canvas', setup(builder) {
      // Other providers stay external as in runtime. Exercise the actual DOM
      // package import/export selected by production, not a parser test double.
      builder.onResolve({ filter: /^linkedom(?:\/.*)?$/ }, ({ path }) => {
        const key = path === 'linkedom' ? '.' : `.${path.slice('linkedom'.length)}`;
        return { path: join(linkedomRoot, pkg.exports[key].import) };
      });
      builder.onResolve({ filter: /^canvas$/ }, () => {
        throw new Error('Text extraction must not attempt to resolve native canvas');
      });
    }}],
  });
  assert(Object.keys(result.metafile.inputs).some(path => path.endsWith('linkedom/worker.js')));
  assert(!Object.keys(result.metafile.inputs).some(path => /canvas\.cjs$/.test(path)));
  const { extractContent } = await import(pathToFileURL(join(temp, 'extract.mjs')).href);
  const paragraph = '杭州天气测试正文：今天多云，气温十六至二十二摄氏度。出门注意天气变化，以下数据仅用于离线回归夹具，不是实时天气预报。';
  const html = `<html><head><title>杭州天气回归夹具</title></head><body><nav>菜单</nav><article><h1>杭州天气回归夹具</h1>${Array.from({length: 16}, () => `<p>${paragraph}</p>`).join('')}<canvas></canvas></article></body></html>`;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const content = await extractContent('https://example.com/weather', undefined, { lookup });
  assert.equal(content.error, null);
  assert.equal(content.status, 200, "readable transport status is retained for trustworthy watch receipts");
  assert.match(content.title, /杭州天气/);
  assert.match(content.content, /十六至二十二/);
  assert(content.content.length > 500);
  assert.equal(calls.length, 1, 'readable HTML must not trigger fallback providers');
  const raw = await extractContent('https://example.com/weather', undefined, { lookup, mode: 'raw' });
  assert.equal(raw.error, null);
  assert.equal(raw.content, html);
  const controller = new AbortController();
  controller.abort();
  const aborted = await extractContent('https://example.com/weather', controller.signal, { lookup });
  assert.equal(aborted.error, 'Aborted');
  assert.equal(calls.length, 2, 'aborted extraction must not fetch');
  const blocked = await extractContent('http://127.0.0.1/private', undefined, { mode:'raw', lookup });
  assert.equal(blocked.errorCode, 'url-policy');
  assert.equal(blocked.retryable, false);
  const fakeIp = await extractContent('https://example.com/fake-ip', undefined, {mode:'readable', lookup:async()=>[{address:'198.18.0.7',family:4}]});
  assert.equal(fakeIp.errorCode,'url-policy');
  assert.equal(fakeIp.retryable,false);
  const temporary = await extractContent('https://example.com/transient', undefined, {lookup:async()=>{throw new Error('temporary DNS failure')}});
  assert.match(temporary.error, /temporary DNS failure/);
  assert.equal(temporary.retryable, undefined, 'DNS errors are not a policy rejection');

  await build({ entryPoints: [join(root, 'src/main/capabilities/web-access/index.ts')],
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    outfile: join(temp, 'extension.mjs'), logLevel: 'silent' });
  const { createWebAccessCapabilityExtension } = await import(pathToFileURL(join(temp, 'extension.mjs')).href);
  const registered = new Map();
  createWebAccessCapabilityExtension(new Proxy({ registerTool: tool => registered.set(tool.name, tool) },
    { get: (target, key) => target[key] ?? (() => {}) }));
  const fetchTool = registered.get('fetch_content');
  for (const params of [{}, { url: 'http://127.0.0.1/private', mode: 'raw' },
    { urls: ['http://127.0.0.1/a', 'http://127.0.0.1/b'], mode: 'raw' },
    { url: 'https://example.com', mode: 'answer' }]) {
    const response = await fetchTool.execute('error-test', params, new AbortController().signal, undefined, { cwd: temp, hasUI: false });
    assert.equal(response.isError, true, JSON.stringify(params));
    if (params.url?.startsWith('http://127.')) {
      assert.equal(response.details.retryable,false);
      assert.equal(response.details.errorCode,'url-policy');
      assert.match(response.content[0].text,/同一网址/);
    }
    if (params.urls) assert(response.details.results.every(r=>r.retryable===false && r.errorCode==='url-policy'));

  }
  assert.equal(calls.length, 2, 'blocked and invalid requests must never fetch');
  const recovered = await extractContent('https://example.com/fake-ip', undefined, {lookup,mode:'readable'});
  assert.equal(recovered.error,null,'a later healthy lookup is not locked out by an earlier rejection');
  assert.equal(recovered.retryable,undefined);
  assert.equal(calls.length,3);
  if (process.argv.includes('--live-weather')) {
    globalThis.fetch = savedFetch;
    const live = await extractContent('https://www.weather.com.cn/weather1d/101210101.shtml', undefined, { timeoutMs: 15000 });
    assert.equal(live.error, null);
    assert.match(live.title + live.content, /杭州/);
    assert(live.content.length > 500);
    console.log(`PASS: live China Weather Hangzhou extraction (${live.content.length} characters)`);
  }
  console.log('PASS: real extractor bundles without canvas; readable HTML, raw HTML and abort execute successfully');
} finally {
  globalThis.fetch = savedFetch;
  if (savedConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedConfig;
  rmSync(temp, { recursive: true, force: true });
}
