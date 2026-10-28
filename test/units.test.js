import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { selectElements, signature } from "../src/select.js";
import { buildOptions, matchInput, NONE } from "../src/decide.js";
import { parseUntil, validateSpec, loadSpec } from "../src/spec.js";
import { createJev, JevError } from "../src/jev.js";
import { renderHtml, escapeHtml } from "../src/report.js";

const el = (id, extra) => ({ id, tag: "a", role: "link", text: `t${id}`, inView: true, below: false, top: id * 10, left: 0, ...extra });

test("selectElements: on-screen first, then below the fold, then above; link+text deduped; capped", () => {
  const raw = [
    el(1, { inView: false, below: true, top: 2000 }),
    el(2, { inView: false, below: false, top: -500 }),
    el(3, { top: 300 }),
    el(4, { top: 100, href: "https://x.test/a", text: "Shoes" }),
    el(5, { top: 900, inView: false, below: true, href: "https://x.test/a", text: "shoes" }),
    el(6, { top: 200, href: "https://x.test/a", text: "Shoes (2)" }),
  ];
  assert.deepEqual(selectElements(raw).map((e) => e.id), [4, 6, 3, 1, 2]);
  const many = Array.from({ length: 300 }, (_, i) => el(i + 1, { role: "button" }));
  assert.equal(selectElements(many).length, 120);
  assert.equal(selectElements(many, 10).length, 10);
});

test("signature ignores scroll but sees text, url and element changes", () => {
  const obs = { url: "u", title: "t", textHash: "1", dialogs: [], scrollY: 0, elements: [el(1)] };
  assert.equal(signature(obs), signature({ ...obs, scrollY: 900 }));
  assert.notEqual(signature(obs), signature({ ...obs, textHash: "2" }));
  assert.notEqual(signature(obs), signature({ ...obs, url: "v" }));
  assert.notEqual(signature(obs), signature({ ...obs, elements: [el(1, { text: "other" })] }));
});

test("buildOptions: clicks, selects, typed test values, NONE; disabled and excluded skipped", () => {
  const obs = {
    elements: [
      el(1, { role: "button", tag: "button", text: "Add to cart" }),
      el(2, { role: "button", tag: "button", text: "Buy", disabled: true }),
      el(3, { role: "textbox", tag: "input", text: "Email", type: "email", name: "email" }),
      el(4, { role: "select", tag: "select", text: "Size", options: [{ index: 0, value: "", label: "Choose", selected: true }, { index: 1, value: "m", label: "M" }, { index: 2, value: "l", label: "L" }] }),
      el(5, { role: "button", tag: "button", text: "Close" }),
      el(6, { role: "textbox", tag: "input", text: "Coupon", name: "coupon" }),
    ],
  };
  const { options, actions } = buildOptions(obs, { inputs: { email: "a@b.test" }, exclude: new Set([5]) });
  assert.deepEqual(Object.keys(options), ["e1", "e3", "e4o1", "e4o2", NONE]);
  assert.deepEqual(actions.e3, { kind: "type", id: 3, value: "a@b.test", inputKey: "email" });
  assert.deepEqual(actions.e4o2, { kind: "select", id: 4, index: 2, label: "L" });
  assert.ok(!Object.keys(options).includes("DONE"));
});

test("matchInput uses label, name, placeholder and type", () => {
  assert.equal(matchInput({ text: "", name: "q", placeholder: "Search products" }, { search: "x" }), "search");
  assert.equal(matchInput({ text: "Postal code", name: "zip" }, { "postal code": "x" }), "postal code");
  assert.equal(matchInput({ text: "Name" }, { email: "x" }), null);
});

test("parseUntil", () => {
  assert.deepEqual(parseUntil("text:Your cart"), { text: "Your cart" });
  assert.deepEqual(parseUntil("url:/checkout"), { url: "/checkout" });
  assert.deepEqual(parseUntil("js:a:b === 1"), { js: "a:b === 1" });
  assert.throws(() => parseUntil("Your cart"), /--until/);
});

test("validateSpec rejects bad input", () => {
  assert.throws(() => validateSpec({ url: "javascript:alert(1)", goal: "g", until: { url: "x" } }), /http/);
  assert.throws(() => validateSpec({ goal: "g" }), /until is required/);
  assert.throws(() => validateSpec({ goal: "g", until: { css: "x" } }), /unknown condition key/);
  assert.throws(() => validateSpec({ goal: "g", until: { url: "x" }, inputs: { a: 1 } }), /inputs.a/);
  assert.throws(() => validateSpec({ goal: "g", until: { url: "x" }, budget: { actions: -1 } }), /budget.actions/);
  const s = validateSpec({ goal: " g ", until: [{ url: "a" }, { text: "b" }], budget: { actions: 5, jev: 6 } });
  assert.deepEqual(s.budget, { maxActions: 5, maxJevCalls: 6 });
  assert.equal(s.stages[0].goal, "g");
});

test("loadSpec reads YAML and JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pss-"));
  fs.writeFileSync(path.join(dir, "a.yaml"), "url: https://x.test/\nstages:\n  - goal: Open cart\n    until:\n      url: /cart\n");
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ url: "https://x.test/", goal: "Open cart", until: { url: "/cart" } }));
  assert.deepEqual(loadSpec(path.join(dir, "a.yaml")), loadSpec(path.join(dir, "a.json")));
  fs.rmSync(dir, { recursive: true });
});

function fakeJevServer(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        handler(req, res, seen.length, JSON.parse(body));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
const answer = (res, choice, extra = {}) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: "jev-x", answers: { next: { type: "choice", choice, confidence: 0.8, probabilities: { [choice]: 0.9 }, ...extra } }, usage: { input_tokens: 1, output_tokens: 1 } }));
};

test("Jev client: request shape, bearer key, answer validation", async () => {
  const { server, seen, url } = await fakeJevServer((req, res, n) => answer(res, n === 1 ? "e1" : "DONE"));
  const jev = createJev({ apiKey: "test-key", baseUrl: url, model: "jev-latest" });
  const r = await jev.choose({ state: { goal: "g" }, instructions: "pick", options: { e1: "click a", NONE: "none" } });
  assert.equal(r.choice, "e1");
  assert.equal(r.confidence, 0.8);
  assert.equal(seen[0].url, "/v1/systemone");
  assert.equal(seen[0].auth, "Bearer test-key");
  assert.deepEqual(seen[0].body, { model: "jev-latest", state: { goal: "g" }, questions: { next: { type: "choice", instructions: "pick", criteria: { e1: "click a", NONE: "none" } } } });
  await assert.rejects(jev.choose({ state: "s", instructions: "pick", options: { e1: "a", NONE: "n" } }), /not one of the options/);
  server.close();
});

test("Jev client: retries 429, gives up on 401, times out", async () => {
  const { server, url } = await fakeJevServer((req, res, n, body) => {
    if (body.state === "slow") return; // never answers
    if (body.state === "auth") {
      res.writeHead(401);
      return res.end("bad key");
    }
    if (n === 1) {
      res.writeHead(429);
      return res.end();
    }
    answer(res, "e1");
  });
  const jev = createJev({ apiKey: "k", baseUrl: url, timeoutMs: 300 });
  assert.equal((await jev.choose({ state: "retry", instructions: "i", options: { e1: "a" } })).choice, "e1");
  await assert.rejects(jev.choose({ state: "auth", instructions: "i", options: { e1: "a" } }), (e) => e instanceof JevError && e.status === 401);
  await assert.rejects(jev.choose({ state: "slow", instructions: "i", options: { e1: "a" } }), /within 300 ms/);
  server.closeAllConnections();
  server.close();
});

test("Jev client needs a key from the environment", () => {
  assert.throws(() => createJev({ apiKey: "" }), /TYPESAFE_API_KEY/);
});

test("HTML report escapes page-controlled text", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">&'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
  const html = renderHtml({
    name: "<script>alert(1)</script>",
    status: "done",
    startedAt: "now",
    totalMs: 1,
    counts: { actions: 1, jevCalls: 1, restarts: 0 },
    stages: [{ index: 1, goal: "g", until: { text: "<b>" }, status: "done", ms: 1, steps: [{ n: 1, url: "https://x.test/\"><script>", timings: { jev: 5 }, action: { kind: "click", id: 1, target: 'link "<svg onload=x>"' }, result: { method: "cdp" }, jev: { choice: "e1", confidence: 0.5, top: [] } }] }],
  });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<svg onload"));
  assert.ok(!html.includes('"><script>'));
});
