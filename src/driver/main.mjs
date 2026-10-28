// The driver runs inside `ego-browser nodejs`. It holds one ego task space
// and answers the host's commands over HTTP on a private Unix socket.
//
// The embedded Node is a helper process shared with other ego scripts, so the
// driver never calls process.exit(): it shuts down by closing its server and
// letting main() return, which ends the round.

import fs from "node:fs";
import * as fns from "./pagefns.mjs";


export async function main(startFile) {
  const cfg = JSON.parse(fs.readFileSync(startFile, "utf8"));
  fs.rmSync(startFile, { force: true });
  const task = await globalThis.taskSpace(cfg.space);
  const driver = createDriver({ task, cfg });
  return driver.serve();
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDriver({ task, cfg, log = () => {} }) {
  const attr = cfg.attr || "data-pickstep-id";
  const screenshotTimeoutMs = cfg.screenshotTimeoutMs || 10_000;
  let page = task.page(cfg.page || "p1");
  let shutdown = () => {};
  let idleTimer = null;
  let watchTimer = null;
  let finished = false;

  const selectorFor = (id) => {
    if (!Number.isInteger(id) || id < 1) throw new Error(`bad element id: ${id}`);
    return `[${attr}="${id}"]`;
  };

  // Wait until the DOM is quiet and the network is idle, each capped at maxMs.
  async function settle({ quietMs = 250, maxMs = 3000 } = {}) {
    const t0 = Date.now();
    await sleep(100);
    const idle = page
      .waitForLoadState("networkidle", { idleMs: quietMs, timeout: maxMs })
      .then(() => Date.now() - t0)
      .catch(() => false);
    let r;
    try {
      r = await page.evaluate(fns.waitQuiet, { quietMs, maxMs });
    } catch {
      r = { unloading: true };
    }
    const networkIdle = await idle; // ms until idle, or false on timeout
    if (r.unloading || r.readyState === "loading") {
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { idleMs: quietMs, timeout: maxMs }).catch(() => {});
      try {
        r = await page.evaluate(fns.waitQuiet, { quietMs, maxMs: Math.min(maxMs, 2000) });
      } catch (e) {
        r = { error: String(e.message || e) };
      }
      r.navigated = true;
    }
    return { ...r, quietMs: r.ms, networkIdleMs: networkIdle, ms: Date.now() - t0 };
  }

  async function mouseClick(x, y) {
    const base = { x, y, button: "left", clickCount: 1 };
    const ms = [];
    for (const ev of [{ type: "mouseMoved", x, y }, { ...base, type: "mousePressed", buttons: 1 }, { ...base, type: "mouseReleased", buttons: 0 }]) {
      const t0 = Date.now();
      await page.cdp("Input.dispatchMouseEvent", ev);
      ms.push(Date.now() - t0);
    }
    return ms;
  }

  async function click(id) {
    selectorFor(id);
    const t0 = Date.now();
    let prep = await page.evaluate(fns.prepareClick, { attr, id });
    const prepareMs = Date.now() - t0;
    if (!prep.found) throw new Error(`element ${id} is gone; observe again`);
    if (prep.hit) {
      const mouseMs = await mouseClick(prep.x, prep.y);
      return { method: "cdp", x: prep.x, y: prep.y, stable: prep.stable, stableMs: prep.stableMs, prepareMs, mouseMs };
    }
    const blockedBy = prep.blocker;
    const dismissed = await page.evaluate(fns.dismissOverlays);
    if (dismissed.length) await sleep(400);
    prep = await page.evaluate(fns.prepareClick, { attr, id });
    if (prep.found && prep.hit) {
      await mouseClick(prep.x, prep.y);
      return { method: "cdp-after-dismiss", blockedBy, dismissed, x: prep.x, y: prep.y };
    }
    if (prep.found && prep.href && prep.sameOrigin) {
      await page.goto(prep.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return { method: "goto", blockedBy, dismissed, href: prep.href };
    }
    const ok = await page.evaluate(fns.domClick, { attr, id });
    if (!ok) throw new Error(`element ${id} is gone; observe again`);
    return { method: "dom", blockedBy, dismissed };
  }

  const ops = {
    async ping() {
      return { pid: process.pid, space: task.spaceId, page: page.label };
    },

    // The host tells us which CLI process owns this round. If it dies (killed
    // after a timeout, or the host crashed), the driver stops on its own.
    async hello({ cliPid }) {
      if (Number.isInteger(cliPid) && cliPid > 0) {
        clearInterval(watchTimer);
        watchTimer = setInterval(() => {
          try {
            process.kill(cliPid, 0);
          } catch {
            log(`cli ${cliPid} is gone; stopping`);
            stop();
          }
        }, 2000);
      }
      return { ok: true };
    },

    async goto({ url, timeoutMs = 45_000 }) {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs");
      try {
        await page.url();
      } catch {
        page = await task.newPage();
      }
      const t0 = Date.now();
      await page.goto(u.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      return { url: await page.url(), ms: Date.now() - t0 };
    },

    async url() {
      return { url: await page.url(), title: await page.title() };
    },

    async probe({ timeoutMs = 1500 } = {}) {
      let r = await page.evaluate(fns.renderProbe, { timeoutMs });
      if (!r.painting) {
        // A background tab also stops painting; bring it forward once.
        await page.cdp("Page.bringToFront", {}).catch(() => {});
        r = await page.evaluate(fns.renderProbe, { timeoutMs });
        r.broughtToFront = true;
      }
      return r;
    },

    async observe() {
      return page.evaluate(fns.observePage, { attr });
    },

    async act(action) {
      const t0 = Date.now();
      let detail;
      switch (action.kind) {
        case "click":
          detail = await click(action.id);
          break;
        case "type": {
          const sel = selectorFor(action.id);
          const value = String(action.value);
          const submit = value.endsWith("\n");
          await page.fill(sel, submit ? value.slice(0, -1) : value, { clearFirst: true });
          if (submit) await page.press(sel, "Enter");
          detail = { method: "fill", submit };
          break;
        }
        case "select": {
          const sel = selectorFor(action.id);
          const choice = Number.isInteger(action.index) ? { index: action.index } : String(action.value);
          await page.selectOption(sel, choice);
          detail = { method: "selectOption" };
          break;
        }
        case "press":
          await page.keyboard.press(String(action.key));
          detail = { method: "keyboard" };
          break;
        case "scroll":
          await page.evaluate((dy) => window.scrollBy(0, dy), Number(action.dy) || 600);
          detail = { method: "scrollBy" };
          break;
        case "back":
          await page.evaluate(() => history.back());
          detail = { method: "history.back" };
          break;
        case "goto":
          detail = await ops.goto({ url: action.url });
          break;
        default:
          throw new Error(`unknown action kind: ${action.kind}`);
      }
      return { ...detail, ms: Date.now() - t0 };
    },

    async settle(args) {
      return settle(args);
    },

    async check({ until }) {
      const conds = Array.isArray(until) ? until : [until];
      const results = [];
      for (const c of conds) {
        const r = await page.evaluate(fns.checkCondition, { text: c.text ?? null, url: c.url ?? null });
        let met = true;
        if (c.text != null) met = met && r.text;
        if (c.url != null) met = met && r.urlMatch;
        if (c.js != null) {
          // A JS assertion is code from the test case, evaluated as written.
          const v = await page.evaluate(String(c.js));
          r.js = Boolean(v);
          met = met && r.js;
        }
        results.push({ ...r, met });
      }
      return { met: results.some((r) => r.met), results };
    },

    // A JPEG straight from CDP takes ~0.1 s; ego's PNG screenshot can take ~1 s
    // after the page changes. ego's screenshot stays as the fallback.
    async screenshot({ path }) {
      const t0 = Date.now();
      const capture = async () => {
        try {
          const shot = await page.cdp("Page.captureScreenshot", { format: "jpeg", quality: 70, optimizeForSpeed: true });
          fs.writeFileSync(path, Buffer.from(shot.data, "base64"));
          return path;
        } catch {
          const png = path.replace(/\.jpe?g$/i, "") + ".png";
          await page.screenshot({ path: png });
          return png;
        }
      };
      try {
        const file = await withTimeout(capture(), screenshotTimeoutMs, `screenshot timed out after ${screenshotTimeoutMs} ms; the window may not be rendering`);
        return { path: file, ms: Date.now() - t0 };
      } catch (e) {
        return { error: String(e.message || e), ms: Date.now() - t0 };
      }
    },

    async finish({ keep = false } = {}) {
      if (!finished) {
        finished = true;
        await task.finish({ keep: keep ? [page.label] : [] });
      }
      setTimeout(stop, 10);
      return { finished: true };
    },

    async abort() {
      setTimeout(stop, 10);
      return { aborted: true };
    },
  };

  function armIdle() {
    clearTimeout(idleTimer);
    if (!cfg.idleMs) return;
    idleTimer = setTimeout(async () => {
      log("idle; finishing the task space");
      try {
        await ops.finish({});
      } catch (e) {
        log(`finish failed: ${e.message}`);
        stop();
      }
    }, cfg.idleMs);
  }

  // Commands run one at a time; ping and abort skip the queue.
  let queue = Promise.resolve();
  async function handle(op, args = {}) {
    if (!Object.hasOwn(ops, op)) throw new Error(`unknown op: ${op}`);
    armIdle();
    if (op === "ping" || op === "abort") return ops[op](args);
    const run = queue.then(() => ops[op](args));
    queue = run.catch(() => {});
    return run;
  }

  let server = null;
  function stop() {
    clearTimeout(idleTimer);
    clearInterval(watchTimer);
    if (server) server.close();
    server = null;
    shutdown();
  }

  async function serve() {
    const http = await import("node:http");
    fs.rmSync(cfg.socket, { force: true });
    const done = new Promise((resolve) => {
      shutdown = resolve;
    });
    server = http.createServer((req, res) => {
      const op = (req.url || "/").slice(1);
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        let status = 200;
        let body;
        try {
          const args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          body = { ok: true, result: await handle(op, args) };
        } catch (e) {
          status = 500;
          body = { ok: false, error: String((e && e.message) || e) };
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.socket, resolve);
    });
    fs.chmodSync(cfg.socket, 0o600);
    armIdle();
    await done;
    return { stopped: true };
  }

  return { handle, serve, stop, ops };
}
