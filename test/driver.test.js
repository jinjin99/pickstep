// The in-browser driver, run against a fake ego page.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createDriver } from "../src/driver/main.mjs";
import * as fns from "../src/driver/pagefns.mjs";

function fakePage({ prepare = [], painting = [true], screenshot } = {}) {
  const calls = [];
  const prepQueue = [...prepare];
  const paintQueue = [...painting];
  return {
    label: "p1",
    calls,
    async evaluate(fn, arg) {
      if (fn === fns.prepareClick) {
        calls.push(["prepare", arg.id]);
        return prepQueue.shift();
      }
      if (fn === fns.dismissOverlays) {
        calls.push(["dismiss"]);
        return ["cookie: reject all"];
      }
      if (fn === fns.domClick) {
        calls.push(["domClick", arg.id]);
        return true;
      }
      if (fn === fns.renderProbe) {
        const p = paintQueue.length > 1 ? paintQueue.shift() : paintQueue[0];
        return { painting: p, visibility: "visible", ms: 1 };
      }
      if (fn === fns.checkCondition) return { url: "https://shop.test/cart", text: arg.text != null, urlMatch: arg.url != null };
      if (typeof fn === "string") {
        calls.push(["eval", fn]);
        return fn === "window.ok" ? 1 : 0;
      }
      throw new Error("unexpected evaluate");
    },
    async cdp(method, params) {
      calls.push(["cdp", method, params.type]);
      return {};
    },
    async goto(url) {
      calls.push(["goto", url]);
    },
    async url() {
      return "https://shop.test/";
    },
    async screenshot(opts) {
      calls.push(["screenshot", opts.path]);
      return screenshot ? screenshot() : opts.path;
    },
  };
}

const fakeTask = (page) => ({ spaceId: 7, page: () => page, finished: null, async finish(o) { this.finished = o; } });
const hit = { found: true, hit: true, x: 50, y: 60, stable: true, stableMs: 120 };
const blocked = { found: true, hit: false, blocker: 'div.cookie-banner "We use cookies"', href: "", sameOrigin: false };

test("click: hit test passes, then CDP moved/pressed/released", async () => {
  const page = fakePage({ prepare: [hit] });
  const d = createDriver({ task: fakeTask(page), cfg: {} });
  const r = await d.handle("act", { kind: "click", id: 3 });
  assert.equal(r.method, "cdp");
  assert.deepEqual(
    page.calls.filter((c) => c[0] === "cdp").map((c) => c[2]),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
});

test("click: covered target -> dismiss overlays -> retry with CDP", async () => {
  const page = fakePage({ prepare: [blocked, hit] });
  const d = createDriver({ task: fakeTask(page), cfg: {} });
  const r = await d.handle("act", { kind: "click", id: 3 });
  assert.equal(r.method, "cdp-after-dismiss");
  assert.deepEqual(r.dismissed, ["cookie: reject all"]);
  assert.match(r.blockedBy, /cookie-banner/);
});

test("click: still covered -> same-origin link is opened directly", async () => {
  const link = { ...blocked, href: "https://shop.test/cart", sameOrigin: true };
  const page = fakePage({ prepare: [link, link] });
  const d = createDriver({ task: fakeTask(page), cfg: {} });
  const r = await d.handle("act", { kind: "click", id: 4 });
  assert.equal(r.method, "goto");
  assert.ok(page.calls.some((c) => c[0] === "goto" && c[1] === "https://shop.test/cart"));
  assert.ok(!page.calls.some((c) => c[0] === "cdp"));
});

test("click: still covered and not a link -> DOM click()", async () => {
  const page = fakePage({ prepare: [blocked, blocked] });
  const d = createDriver({ task: fakeTask(page), cfg: {} });
  const r = await d.handle("act", { kind: "click", id: 5 });
  assert.equal(r.method, "dom");
  assert.ok(page.calls.some((c) => c[0] === "domClick" && c[1] === 5));
});

test("click: unknown id or bad id fails", async () => {
  const page = fakePage({ prepare: [{ found: false }] });
  const d = createDriver({ task: fakeTask(page), cfg: {} });
  await assert.rejects(d.handle("act", { kind: "click", id: 9 }), /gone/);
  await assert.rejects(d.handle("act", { kind: "click", id: "1\"]" }), /bad element id/);
});

test("probe: a page that stops painting is reported after one bringToFront", async () => {
  const page = fakePage({ painting: [false, false] });
  const d = createDriver({ task: fakeTask(page), cfg: {} });
  const r = await d.handle("probe");
  assert.equal(r.painting, false);
  assert.equal(r.broughtToFront, true);
  assert.ok(page.calls.some((c) => c[1] === "Page.bringToFront"));
});

test("screenshot: a hung capture gives up with a reason instead of blocking", async () => {
  const page = fakePage({ screenshot: () => new Promise(() => {}) });
  const d = createDriver({ task: fakeTask(page), cfg: { screenshotTimeoutMs: 100 } });
  const t0 = Date.now();
  const r = await d.handle("screenshot", { path: "/tmp/x.png" });
  assert.match(r.error, /timed out after 100 ms/);
  assert.ok(Date.now() - t0 < 1000);
});

test("check: all keys of one condition must hold; a list needs any one", async () => {
  const page = fakePage();
  const d = createDriver({ task: fakeTask(page), cfg: {} });
  assert.equal((await d.handle("check", { until: { url: "/cart", js: "window.ok" } })).met, true);
  assert.equal((await d.handle("check", { until: { url: "/cart", js: "window.no" } })).met, false);
  assert.equal((await d.handle("check", { until: [{ js: "window.no" }, { text: "Your cart" }] })).met, true);
});

test("goto refuses non-http URLs", async () => {
  const d = createDriver({ task: fakeTask(fakePage()), cfg: {} });
  await assert.rejects(d.handle("goto", { url: "file:///etc/passwd" }), /only http/);
});

test("serve: HTTP over a Unix socket; finish closes the task space and stops", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psd-"));
  const socket = path.join(dir, "d.sock");
  const task = fakeTask(fakePage());
  const d = createDriver({ task, cfg: { socket } });
  const served = d.serve();
  const post = (op, body = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath: socket, method: "POST", path: `/${op}` }, (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => resolve(JSON.parse(s)));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  for (let i = 0; i < 50 && !fs.existsSync(socket); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fs.statSync(socket).mode & 0o077, 0);
  assert.deepEqual((await post("ping")).result.space, 7);
  assert.equal((await post("nope")).ok, false);
  assert.equal((await post("finish")).result.finished, true);
  assert.deepEqual(task.finished, { keep: [] });
  assert.deepEqual(await served, { stopped: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
