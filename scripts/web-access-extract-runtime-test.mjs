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
