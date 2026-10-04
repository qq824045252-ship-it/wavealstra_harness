// 分析 Ardot authorize 页面 chunk，找出授权信息 API 调用
const chunks = ["8c34f07e6aeb8917.js", "1627bf2f54f2038d.js"];
for (const chunk of chunks) {
  const url = `https://ardot.tencent.com/open/_next/static/chunks/${chunk}`;
  const res = await fetch(url);
  const js = await res.text();
  console.log(`=== ${chunk} size=${js.length} ===`);
  let idx = js.indexOf("oauth");
  let n = 0;
  while (idx >= 0 && n < 25) {
    const start = Math.max(0, idx - 150);
    const len = Math.min(320, js.length - start);
    const snippet = js.slice(start, start + len).replace(/\s+/g, " ");
    if (/api|fetch|axios|request|client|authorize|scope|redirect/i.test(snippet)) {
      console.log(`--- @${idx}:`);
      console.log(snippet);
      console.log("");
    }
    idx = js.indexOf("oauth", idx + 1);
    n++;
  }
}
