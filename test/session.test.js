import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session, StepTimeout } from "../src/session.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-ego-browser.mjs");
let home;

before(() => {
  fs.chmodSync(FAKE, 0o755);
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-"));
  process.env.PICKSTEP_HOME = path.join(home, "h");
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

const events = (s) =>
  fs
    .readFileSync(path.join(s.dir, "fake-ego.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
};

test("one process serves many commands over a private socket", async () => {
  const s = new Session({ name: "one", egoBin: FAKE, timeoutMs: 2000 });
  const a = await s.call("ping");
  const obs = await s.call("observe");
  const b = await s.call("ping");
  assert.equal(a.pid, b.pid);
  assert.equal(obs.elements[0].text, "Cart");
  assert.equal(s.spawns, 1);
  assert.equal(a.space, "pickstep-one");

  const start = events(s).find((e) => e.event === "start");
  assert.equal(start.startMode, 0o600, "start file is 0600");
  assert.equal(start.dirMode, 0o700, "session dir is 0700");
  assert.equal(fs.statSync(path.dirname(s.dir)).mode & 0o777, 0o700, "base dir is 0700");
  assert.equal(fs.statSync(s.socket).mode & 0o077, 0, "socket is private");
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.startsWith("start-")), [], "start file is removed");
  await s.finish();
});

test("a later CLI invocation reuses the running driver", async () => {
  const first = new Session({ name: "reuse", egoBin: FAKE });
  const { pid } = await first.call("ping");
  const second = new Session({ name: "reuse", egoBin: FAKE });
  assert.equal((await second.call("ping")).pid, pid);
  assert.equal(second.spawns, 0);
  await second.finish();
});

test("a timed-out step kills the process; the next step restarts it on the same task space", async () => {
  const s = new Session({ name: "hang", egoBin: FAKE, timeoutMs: 2000 });
  const { pid } = await s.call("ping");
  await assert.rejects(s.call("hang", {}, 300), StepTimeout);
  assert.ok(await waitFor(() => !alive(pid)), "old process is gone");
  const again = await s.call("ping");
  assert.notEqual(again.pid, pid);
  assert.equal(again.space, "pickstep-hang");
  assert.equal(s.spawns, 2);
  assert.equal(s.restarts, 1);
  await s.finish();
});

test("finish stops the process and removes the socket", async () => {
  const s = new Session({ name: "fin", egoBin: FAKE });
  const { pid } = await s.call("ping");
  const r = await s.finish();
  assert.equal(r.finished, true);
  assert.ok(await waitFor(() => !alive(pid)));
  assert.equal(fs.existsSync(s.socket), false);
  assert.equal((await s.finish()).finished, false);
});

test("the driver exits by itself after the idle period", async () => {
  const s = new Session({ name: "idle", egoBin: FAKE, idleMinutes: 0.005 }); // 300 ms
  const { pid } = await s.call("ping");
  assert.ok(await waitFor(() => !alive(pid), 3000));
  assert.ok(events(s).some((e) => e.event === "exit" && e.reason === "idle"));
  assert.equal(await s.isUp(), false);
});

test("session names are validated", () => {
  assert.throws(() => new Session({ name: "../etc", egoBin: FAKE }), /session name/);
});

test("a driver that went away is started again on the next call", async () => {
  const s = new Session({ name: "gone", egoBin: FAKE });
  const { pid } = await s.call("ping");
  await s.request("abort");
  assert.ok(await waitFor(() => !alive(pid)));
  const again = await s.call("observe");
  assert.equal(again.elements.length, 1);
  assert.equal(s.spawns, 2);
  await s.finish();
});
