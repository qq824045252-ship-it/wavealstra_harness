import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = mkdtempSync(join(tmpdir(), "mybuddy-source-address-"));
const configPath = join(profile, "web-search.json");
process.env.PI_CODING_AGENT_DIR = profile;

const { loadSsrfConfig, validateRemoteUrl, fetchRemoteUrl } = await import("../src/main/capabilities/web-access/ssrf-protection");
let passed = 0;
try {
  writeFileSync(configPath, JSON.stringify({ ssrf: { enabled: false } }));
  const allSources = loadSsrfConfig();
  assert.equal(allSources.enabled, false);
  const urls = [
    "http://localhost/page", "http://test.localhost/page", "http://127.0.0.1/page",
    "http://10.1.2.3/page", "http://172.16.0.1/page", "http://192.168.1.1/page",
    "http://100.64.0.1/page", "http://169.254.1.1/page", "http://198.18.0.79/page",
    "http://[::1]/page", "http://[fd00::1]/page", "http://[fe80::1]/page",
    "http://[::ffff:127.0.0.1]/page", "https://slack.com/page", "https://feishu.cn/page",
  ];
  for (const url of urls) {
    assert.equal((await validateRemoteUrl(url, {
      ...allSources,
      lookup: async () => { throw new Error("Local DNS preflight must not filter allowed sources"); },
    })).href, new URL(url).href);
    passed++;
  }
  const visits: string[] = [];
  const response = await fetchRemoteUrl("https://slack.com/page", {}, {
    ...allSources,
    fetch: async (url) => {
      visits.push(String(url));
      return visits.length === 1
        ? new Response(null, { status: 302, headers: { location: "http://localhost/page" } })
        : new Response("local source body");
    },
  });
  assert.equal(await response.text(), "local source body");
  assert.deepEqual(visits, ["https://slack.com/page", "http://localhost/page"]);
  passed++;
  await assert.rejects(validateRemoteUrl("file:///source.txt", allSources), /Only HTTP and HTTPS/);
  passed++;
  // Explicit query/domain choices remain separate from address-range filtering.
  await assert.rejects(validateRemoteUrl("https://excluded.example", {
    ...allSources, domainPolicy: { allow: [], deny: ["excluded.example"] },
  }), /domain policy/);
  passed++;
  writeFileSync(configPath, JSON.stringify({ ssrf: { enabled: true } }));
  assert.equal(loadSsrfConfig().enabled, true, "configuration updates take effect without restart");
  await assert.rejects(validateRemoteUrl("http://localhost/page", loadSsrfConfig()), /Blocked internal hostname/);
  passed++;
  writeFileSync(configPath, JSON.stringify({ ssrf: { enabled: "false" } }));
  assert.throws(loadSsrfConfig, /ssrf.enabled.*boolean/);
  passed++;
  const redirectVisits: Array<{url:string;headers:Headers}> = [];
  await fetchRemoteUrl('https://one.example/start',{headers:{Authorization:'test-secret',Cookie:'test-cookie',Host:'wrong-host'}},{enabled:true,lookup:async()=>[{address:'8.8.8.8',family:4}],fetch:async(url,init)=>{
    redirectVisits.push({url:String(url),headers:new Headers(init?.headers)});
    return redirectVisits.length===1?new Response(null,{status:302,headers:{location:'https://two.example/final'}}):new Response('ok');
  }});
  assert.equal(redirectVisits.length,2);for(const name of ['authorization','cookie','host'])assert.equal(redirectVisits[1].headers.has(name),false,'cross-origin '+name+' removed');passed++;
  let privateVisits=0;
  await assert.rejects(fetchRemoteUrl('https://one.example/start',{}, {enabled:true,lookup:async()=>[{address:'8.8.8.8',family:4}],fetch:async()=>{privateVisits++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});}}),/Blocked internal/);
  assert.equal(privateVisits,1,'redirect target private IP is rejected before request');passed++;
  console.log(JSON.stringify({ status: "passed", tests: passed, addresses: urls.length }));
} finally {
  unlinkSync(configPath);
}
