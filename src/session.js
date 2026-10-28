// Host side of the persistent browser session: start one `ego-browser nodejs`
// process per session, talk to its driver over a Unix socket, restart it on
// the same task space when a command times out.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "driver", "main.mjs");
const NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;

export class StepTimeout extends Error {
  constructor(op, ms) {
    super(`${op} took longer than ${ms} ms; the browser process was restarted`);
    this.name = "StepTimeout";
    this.op = op;
  }
}

export function checkName(name) {
  if (!NAME_RE.test(name)) throw new Error(`session name must match ${NAME_RE}`);
  return name;
}

/** Create (or verify) a directory only this user can enter. */
export function privateDir(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return dir;
}

export function sessionDir(name) {
  const base = process.env.PICKSTEP_HOME || path.join(os.tmpdir(), `pickstep-${process.getuid?.() ?? "u"}`);
  privateDir(base);
  return privateDir(path.join(base, checkName(name)));
}

export function findEgo() {
  if (process.env.PICKSTEP_EGO_BIN) return process.env.PICKSTEP_EGO_BIN;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, "ego-browser");
    if (dir && fs.existsSync(p)) return p;
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "ego-browser");
  if (fs.existsSync(fallback)) return fallback;
  throw new Error("ego-browser not found; install ego lite or set PICKSTEP_EGO_BIN");
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class Session {
  constructor({ name = "default", egoBin, idleMinutes = 10, timeoutMs = 45_000, startTimeoutMs = 20_000 } = {}) {
    this.name = checkName(name);
    this.egoBin = egoBin;
    this.idleMs = Math.round(idleMinutes * 60_000);
    this.timeoutMs = timeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.dir = sessionDir(this.name);
    this.socket = path.join(this.dir, "driver.sock");
    this.spawns = 0;
    this.restarts = 0;
    this.startMs = [];
    this.up = false;
    if (Buffer.byteLength(this.socket) > 100) throw new Error(`socket path too long: ${this.socket}; set PICKSTEP_HOME to a shorter directory`);
  }

  get space() {
    return `pickstep-${this.name}`;
  }

  request(op, args = {}, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(args);
      const req = http.request(
        { socketPath: this.socket, method: "POST", path: `/${op}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let parsed;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              return reject(new Error(`driver sent a non-JSON reply to ${op}`));
            }
            if (parsed.ok) resolve(parsed.result);
            else reject(new Error(parsed.error || `${op} failed`));
          });
        },
      );
      req.setTimeout(timeoutMs, () => {
        const err = new Error(`timeout ${op}`);
        err.code = "PICKSTEP_TIMEOUT";
        req.destroy(err);
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  async isUp() {
    if (!fs.existsSync(this.socket)) return false;
    try {
      await this.request("ping", {}, 1500);
      return true;
    } catch {
      return false;
    }
  }

  async ensure() {
    if (await this.isUp()) return;
    await this.start();
  }

  async start() {
    const t0 = Date.now();
    fs.rmSync(this.socket, { force: true });
    // The embedded Node cannot read our environment, so the start parameters
    // go through a file only this user can read.
    const startFile = path.join(this.dir, `start-${randomBytes(6).toString("hex")}.json`);
    const cfg = { socket: this.socket, space: this.space, page: "p1", idleMs: this.idleMs, attr: "data-pickstep-id" };
    const fd = fs.openSync(startFile, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify(cfg));
    fs.closeSync(fd);

    // `ego-browser nodejs` waits for stdin even with -e, so the program goes
    // in through stdin. Its stdout folds long lines, so results use the socket.
    const program = `const m = await import(${JSON.stringify(pathToFileURL(DRIVER).href)});\nawait m.main(${JSON.stringify(startFile)});\n`;
    const logFd = fs.openSync(path.join(this.dir, "ego.log"), "a", 0o600);
    const child = spawn(this.egoBin || findEgo(), ["nodejs"], { detached: true, stdio: ["pipe", logFd, logFd] });
    fs.closeSync(logFd);
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(program);
    child.unref();
    this.spawns += 1;
    fs.writeFileSync(path.join(this.dir, "cli.pid"), String(child.pid), { mode: 0o600 });

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (await this.isUp()) {
        await this.request("hello", { cliPid: child.pid }, 5000);
        this.startMs.push(Date.now() - t0);
        return;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    this.kill(child.pid);
    fs.rmSync(startFile, { force: true });
    const tail = fs.readFileSync(path.join(this.dir, "ego.log"), "utf8").slice(-600);
    throw new Error(`ego-browser driver did not start within ${this.startTimeoutMs} ms\n${tail}`);
  }

  kill(pid) {
    if (!alive(pid)) return;
    try {
      process.kill(-pid, "SIGKILL"); // detached: its own process group
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }

  /** Stop the driver without finishing the task space; the next call starts a new one on it. */
  async restart() {
    this.restarts += 1;
    await this.request("abort", {}, 1500).catch(() => {});
    const pidFile = path.join(this.dir, "cli.pid");
    if (fs.existsSync(pidFile)) this.kill(Number(fs.readFileSync(pidFile, "utf8")));
    fs.rmSync(this.socket, { force: true });
  }

  async call(op, args = {}, timeoutMs = this.timeoutMs) {
    if (!this.up) {
      await this.ensure();
      this.up = true;
    }
    try {
      return await this.request(op, args, timeoutMs);
    } catch (e) {
      if (e.code === "PICKSTEP_TIMEOUT") {
        this.up = false;
        await this.restart();
        throw new StepTimeout(op, timeoutMs);
      }
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        // The driver went away (idle exit, browser restart): start a new one once.
        this.up = false;
        await this.ensure();
        this.up = true;
        return this.request(op, args, timeoutMs);
      }
      throw e;
    }
  }

  /** Close the task space and let the driver exit. */
  async finish({ keep = false } = {}) {
    this.up = false;
    if (!(await this.isUp())) return { finished: false, reason: "no running session" };
    const r = await this.request("finish", { keep }, 20_000);
    const deadline = Date.now() + 5000;
    while (fs.existsSync(this.socket) && (await this.isUp()) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    return r;
  }
}
