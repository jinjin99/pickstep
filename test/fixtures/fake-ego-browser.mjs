#!/usr/bin/env node
// Stand-in for `ego-browser nodejs` in tests. Like the real one it reads the
// program from stdin; it then finds the start file the program names, and
// serves the driver protocol on that file's socket with canned answers.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

if (process.argv[2] !== "nodejs") {
  process.stderr.write("fake ego-browser only supports `nodejs`\n");
  process.exit(2);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const program = Buffer.concat(chunks).toString("utf8");
const m = /m\.main\(("(?:[^"\\]|\\.)*")\)/.exec(program);
if (!m) {
  process.stderr.write("no start file in program\n");
  process.exit(3);
}
const startFile = JSON.parse(m[1]);
const startMode = fs.statSync(startFile).mode & 0o777;
const cfg = JSON.parse(fs.readFileSync(startFile, "utf8"));
fs.rmSync(startFile);

const dir = path.dirname(cfg.socket);
const logLine = (o) => fs.appendFileSync(path.join(dir, "fake-ego.jsonl"), JSON.stringify(o) + "\n");
logLine({ event: "start", pid: process.pid, startMode, dirMode: fs.statSync(dir).mode & 0o777, space: cfg.space, idleMs: cfg.idleMs });

const obs = {
  url: "https://shop.test/",
  title: "Fake shop",
  textHash: "1",
  headings: ["Fake shop"],
  dialogs: [],
  alerts: [],
  excerpt: "",
  scanned: 3,
  elements: [{ id: 1, tag: "a", role: "link", text: "Cart", href: "https://shop.test/cart", inView: true, below: false, top: 10, left: 10, w: 40, h: 20 }],
};

let idleTimer;
const server = http.createServer((req, res) => {
  const op = req.url.slice(1);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    clearTimeout(idleTimer);
    if (cfg.idleMs) idleTimer = setTimeout(() => quit("idle"), cfg.idleMs);
    const args = body ? JSON.parse(body) : {};
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    };
    logLine({ event: "op", op, pid: process.pid });
    switch (op) {
      case "ping":
        return reply({ pid: process.pid, space: cfg.space });
      case "hello":
        return reply({ ok: true, cliPid: args.cliPid });
      case "observe":
        return reply(obs);
      case "hang":
        return; // never answers: the host must time out and restart us
      case "finish":
        reply({ finished: true });
        return quit("finish");
      case "abort":
        reply({ aborted: true });
        return quit("abort");
      default:
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `unknown op: ${op}` }));
    }
  });
});

function quit(reason) {
  logLine({ event: "exit", reason, pid: process.pid });
  server.close();
  setTimeout(() => process.exit(0), 20);
}

fs.rmSync(cfg.socket, { force: true });
server.listen(cfg.socket, () => fs.chmodSync(cfg.socket, 0o600));
if (cfg.idleMs) idleTimer = setTimeout(() => quit("idle"), cfg.idleMs);
