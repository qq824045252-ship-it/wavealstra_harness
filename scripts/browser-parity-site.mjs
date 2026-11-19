import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

export const fixtureFileText = "Browser parity fixture\n";

export async function startParitySite() {
  const accounts = new Set();
  const drafts = new Map();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const sid = (req.headers.cookie ?? "").match(/(?:^|; )parity_session=([^;]+)/)?.[1];
    const signed = accounts.has(sid);
    res.setHeader("Cache-Control", "no-store");
    if (path === "/signin") {
      const id = randomUUID(); accounts.add(id);
      res.writeHead(303, { "Set-Cookie": `parity_session=${id}; Max-Age=600; HttpOnly; SameSite=Lax; Path=/`, Location: "/work" }).end();
      return;
    }
    if (path === "/api/orders") {
      res.writeHead(signed ? 200 : 401, { "Content-Type": "application/json" }).end(JSON.stringify(signed ? { orders: [11, 19] } : {}));
      return;
    }
    if (path === "/public") {
      res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }).end(JSON.stringify({ currency: "CNY" }));
      return;
    }
    if (path === "/api/draft") {
      res.setHeader("Content-Type", "application/json");
      if (!signed) return void res.writeHead(401).end("{}");
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 4000) return void res.writeHead(413).end("{}"); }
        try { drafts.set(sid, JSON.parse(body).memo); } catch { return void res.writeHead(400).end("{}"); }
      }
      return void res.end(JSON.stringify({ memo: drafts.get(sid) }));
    }
    if (path === "/bytes") {
      res.writeHead(signed ? 200 : 401, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="test.bin"' });
      return void res.end(signed ? Buffer.from([0, 255, 13, 10, 100]) : Buffer.alloc(0));
    }
    if (path === "/file") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="fixture.txt"' }).end(fixtureFileText);
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (path === "/popup") return void res.end("<title>Popup</title><h1>Popup receipt</h1>");
    if (path === "/frame") return void res.end("<button id='inside' onclick='this.textContent=\"Frame clicked\"'>Frame button</button>");
    if (!signed || path === "/entry") return void res.end("<title>Sign in</title><a href='/signin'>Sign in</a>");
    res.end(`<!doctype html><meta charset="utf-8"><title>Order workspace</title>
      <h1 id="account">Order workspace</h1>
      <label>Memo <input id="memo" onkeydown="if(event.key==='Enter') document.querySelector('#result').textContent=this.value"></label>
      <button id="double" ondblclick="this.textContent='Double clicked'">Double click</button>
      <label>City <select id="city"><option>London</option><option>Paris</option></select></label>
      <label><input type="checkbox" id="flag">Final</label>
      <table><tr><td class="amount">11</td></tr><tr><td class="amount">19</td></tr></table>
      <input id="upload" type="file" onchange="this.files[0].text().then(t=>document.querySelector('#uploaded').textContent=t.trim())"><output id="uploaded"></output>
      <button id="chooser" onclick="const f=document.createElement('input');f.type='file';f.onchange=()=>f.files[0].text().then(t=>document.querySelector('#uploaded').textContent='chosen '+t.trim());f.click()">Choose document</button>
      <a href="/file" download>Download fixture</a> <a href="/popup" target="_blank">Open receipt</a>
      <button id="dialog" onclick="document.querySelector('#result').textContent=confirm('Proceed?')?'Accepted':'Declined'">Show dialog</button>
      <button id="delayed" onclick="setTimeout(()=>document.querySelector('#result').textContent='Ready',180)">Wait for result</button>
      <button id="hover" onmouseenter="this.dataset.hovered='yes'">Hover</button>
      <div id="editor" contenteditable="true" aria-label="Rich editor"></div>
      <input id="cursor" onfocus="this.dataset.focused='yes';" aria-label="Cursor test">
      <div style="display:flex"><button id="source">Drag me</button><button id="drop" onmouseup="if(event.isTrusted)this.textContent='Dropped'">Drop here</button></div>
      <div id="wheel" tabindex="0" style="height:42px;overflow:auto" onscroll="if(this.scrollTop>0)this.dataset.scrolled='yes'"><div style="height:250px">Wheel area</div></div>
      <canvas id="pad" width="180" height="42" tabindex="0" onpointerdown="this.dataset.started=event.isTrusted && event.shiftKey?'yes':'no'" onpointermove="if(event.isTrusted && event.shiftKey && event.buttons===1)this.dataset.drew='yes'" onpointerup="if(event.isTrusted && event.shiftKey && this.dataset.started==='yes' && this.dataset.drew==='yes')this.dataset.stroke='done'"></canvas>
      <pre id="result"></pre><iframe title="Child" src="/frame"></iframe><div id="host"></div>
      <script>const shadow=document.querySelector('#host').attachShadow({mode:'open'});const button=document.createElement('button');button.id='shadow';button.textContent='Shadow button';button.onclick=()=>button.textContent='Shadow clicked';shadow.append(button);</script>
    `);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const close = () => {
    server.close();
    // Chromium may have connected a speculative socket without sending a request.
    server.closeAllConnections();
  };
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}

if (process.argv[1]?.endsWith("browser-parity-site.mjs") && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = await startParitySite();
  console.log(site.url);
}
