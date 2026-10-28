// Manual check against the real ego lite (not part of `npm test`):
//   node test/ego/tricky.ego.js
// Serves test/fixtures/tricky.html on 127.0.0.1 and checks observation and clicking.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../../src/session.js";
import { sessionBrowser } from "../../src/browser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "fixtures", "tricky.html"));
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(req.url === "/" ? html : `<title>${req.url}</title><h1>${req.url.replace(/[^a-z0-9/-]/gi, "")}</h1>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const session = new Session({ name: "tricky" });
const b = sessionBrowser(session);
const find = (obs, text) => obs.elements.find((e) => e.text === text);
try {
  await b.goto(base);
  await b.settle();
  let obs = await b.observe();
  const texts = obs.elements.map((e) => e.text);
  console.log(texts);
  assert.ok(texts.includes("Cart (0)"), "button inside an open shadow root");
  assert.ok(texts.includes("Clickable card without a role"), "cursor:pointer element without a role");
  assert.ok(texts.includes("Fades in when scrolled to"), "transparent below the fold is kept");
  assert.ok(texts.includes("Slide one") && !texts.includes("Slide two"), "overflow-clipped slide dropped");
  for (const gone of ["Hidden menu item", "Off to the left", "Off to the right"]) assert.ok(!texts.includes(gone), `${gone} dropped`);
  assert.ok(obs.elements.findIndex((e) => e.text === "Fades in when scrolled to") > obs.elements.findIndex((e) => e.text === "Buy now"), "in-view first");

  // "Buy now" sits under the cookie overlay: dismiss (reject) and retry with a trusted CDP click.
  let r = await b.act({ kind: "click", id: find(obs, "Buy now").id });
  console.log("buy:", r);
  assert.equal(r.method, "cdp-after-dismiss");
  assert.ok(r.dismissed.some((d) => d.startsWith("cookie: reject")));
  assert.equal((await b.check({ text: "bought, trusted=true" })).met, true);
  assert.equal((await b.check({ text: "ACCEPTED" })).met, false, "never accepts cookies");

  obs = await b.observe();
  r = await b.act({ kind: "click", id: find(obs, "Cart (0)").id });
  assert.equal(r.method, "cdp");
  assert.equal((await b.check({ text: "cart opened" })).met, true);

  obs = await b.observe();
  r = await b.act({ kind: "click", id: find(obs, "Clickable card without a role").id });
  assert.equal((await b.check({ text: "card clicked" })).met, true);

  obs = await b.observe();
  await b.act({ kind: "click", id: find(obs, "Open in new tab").id });
  await b.settle();
  assert.equal((await b.check({ url: "/new-tab.html" })).met, true, "target=_blank opened in the same page");

  const probe = await b.probe();
  console.log("probe:", probe);
  const shot = await b.screenshot(path.join(session.dir, "tricky.jpg"));
  console.log("screenshot:", shot);
  console.log("ok: all checks passed");
} finally {
  await session.finish();
  server.closeAllConnections();
  server.close();
}
