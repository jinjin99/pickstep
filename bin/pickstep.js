#!/usr/bin/env node
// pickstep: Claude plans, Jev picks each step, ego lite drives the browser.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { Session, findEgo } from "../src/session.js";
import { sessionBrowser } from "../src/browser.js";
import { createJev } from "../src/jev.js";
import { decideAndAct, runSpec, DEFAULTS } from "../src/loop.js";
import { formatObservation } from "../src/select.js";
import { loadSpec, validateSpec, parseUntil, checkUrl } from "../src/spec.js";
import { writeReport, phaseStats } from "../src/report.js";

const USAGE = `pickstep - Claude plans, Jev picks each step, ego lite drives the browser

Usage:
  pickstep run --url <url> --goal <text> --until <cond> [options]
  pickstep run --spec <file.yaml|json> [options]
  pickstep observe [--json]
  pickstep act click <id> | type <id> --value <v> | select <id> --value <v>
               | goto <url> | back | scroll [dy] | press <key>
  pickstep step --goal <text> [--input key=value ...]
  pickstep finish [--keep]
  pickstep doctor

Conditions (--until, repeatable; any one is enough):
  text:<words>     the page shows these words
  url:<fragment>   the URL contains this fragment
  js:<expression>  this expression is truthy in the page

Options:
  --session <name>        session for observe/act/step/finish (default "default")
  --input key=value       test-case value Jev may type or select (repeatable)
  --report <dir>          report directory (default ./pickstep-reports/<time>)
  --no-screenshots        skip per-step screenshots
  --keep-open             keep the page open after run
  --max-actions <n>       action budget (default ${DEFAULTS.maxActions})
  --max-jev <n>           Jev call budget (default ${DEFAULTS.maxJevCalls})
  --min-confidence <x>    hand over below this Jev confidence (default ${DEFAULTS.minConfidence})
  --idle <minutes>        close an unused session after this long (default 10)
  --json                  machine-readable output

Environment: TYPESAFE_API_KEY (required for run and step), PICKSTEP_EGO_BIN, PICKSTEP_JEV_MODEL.
`;

const EXIT = { done: 0, budget: 2, stuck: 3, blocked: 4 };

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      session: { type: "string", default: "default" },
      url: { type: "string" },
      goal: { type: "string" },
      until: { type: "string", multiple: true },
      spec: { type: "string" },
      input: { type: "string", multiple: true },
      value: { type: "string" },
      report: { type: "string" },
      "no-screenshots": { type: "boolean" },
      "keep-open": { type: "boolean" },
      keep: { type: "boolean" },
      "max-actions": { type: "string" },
      "max-jev": { type: "string" },
      "min-confidence": { type: "string" },
      idle: { type: "string" },
      json: { type: "boolean" },
      "no-observe": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function parseInputs(list = []) {
  const out = {};
  for (const item of list) {
    const i = item.indexOf("=");
    if (i < 1) throw new Error(`--input must be key=value, got "${item}"`);
    out[item.slice(0, i)] = item.slice(i + 1);
  }
  return out;
}

const num = (v, name) => {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number`);
  return n;
};

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function historyFile(session) {
  return path.join(session.dir, "history.json");
}
function readHistory(session) {
  try {
    return JSON.parse(fs.readFileSync(historyFile(session), "utf8"));
  } catch {
    return [];
  }
}
function writeHistory(session, h) {
  fs.writeFileSync(historyFile(session), JSON.stringify(h.slice(-10)), { mode: 0o600 });
}

function out(obj, json, text) {
  process.stdout.write(json ? JSON.stringify(obj, null, 2) + "\n" : text + "\n");
}

async function cmdObserve(browser, v) {
  const obs = await browser.observe();
  out(obs, v.json, formatObservation(obs) + `\n(${obs.elements.length} of ${obs.total} elements; scanned ${obs.scanned} nodes)`);
}

async function cmdAct(browser, session, pos, v) {
  const [kind, target] = pos;
  const id = () => {
    const n = Number(target);
    if (!Number.isInteger(n) || n < 1) throw new Error(`act ${kind} needs an element id from observe`);
    return n;
  };
  let action;
  switch (kind) {
    case "click":
      action = { kind, id: id() };
      break;
    case "type":
    case "select":
      if (v.value == null) throw new Error(`act ${kind} needs --value`);
      action = { kind, id: id(), value: v.value };
      break;
    case "goto":
      action = { kind, url: target };
      break;
    case "back":
      action = { kind };
      break;
    case "scroll":
      action = { kind, dy: Number(target) || 600 };
      break;
    case "press":
      if (!target) throw new Error("act press needs a key, e.g. Enter");
      action = { kind, key: target };
      break;
    default:
      throw new Error(`unknown action "${kind}"`);
  }
  const t0 = Date.now();
  const result = kind === "goto" ? await browser.goto(target) : await browser.act(action);
  const settle = await browser.settle();
  const h = kind === "goto" ? [] : readHistory(session);
  h.push(`${kind}${action.id ? " e" + action.id : ""}${kind === "goto" ? " " + target : ""}`);
  writeHistory(session, h);
  const ms = Date.now() - t0;
  if (v["no-observe"]) return out({ action, result, settle, ms }, v.json, `${kind} done in ${ms} ms (${result.method || "ok"})`);
  const obs = await browser.observe();
  out({ action, result, settle, ms, observation: obs }, v.json, `${kind} done in ${ms} ms (${result.method || "ok"})\n` + formatObservation(obs));
}

async function cmdStep(browser, session, v) {
  if (!v.goal) throw new Error("step needs --goal");
  const jev = createJev();
  const probe = await browser.probe();
  if (!probe.painting) throw new Error("window not rendering: Chromium stopped painting (display asleep, screen locked, or window hidden)");
  const history = readHistory(session);
  const minConfidence = num(v["min-confidence"], "--min-confidence") ?? DEFAULTS.minConfidence;
  const t0 = Date.now();
  const r = await decideAndAct({ browser, jev, goal: v.goal, inputs: parseInputs(v.input), history, minConfidence });
  if (r.verdict === "acted") {
    history.push(`${r.step.action.kind} ${r.step.action.target}`);
    writeHistory(session, history);
  }
  const s = r.step;
  const lines = [`verdict: ${r.verdict} (${Date.now() - t0} ms)`];
  if (s.jev) lines.push(`jev: ${s.jev.choice} confidence ${s.jev.confidence} | top: ${s.jev.top.map((t) => `${t.option} ${t.p}`).join(", ")}`);
  if (s.action) lines.push(`action: ${s.action.kind} ${s.action.target} via ${s.result.method || "-"}`);
  if (r.verdict !== "acted") {
    lines.push("Jev did not act. Candidates:");
    lines.push(formatObservation(r.obs));
  }
  lines.push(`timings: ${Object.entries(s.timings).map(([k, ms]) => `${k} ${ms} ms`).join(", ")}`);
  out({ verdict: r.verdict, step: s }, v.json, lines.join("\n"));
  return r.verdict === "acted" ? 0 : 4;
}

async function cmdRun(v) {
  let spec;
  if (v.spec) {
    spec = loadSpec(v.spec);
    if (v.url) spec.url = checkUrl(v.url, "--url");
    if (v.input) spec.inputs = { ...spec.inputs, ...parseInputs(v.input) };
  } else {
    if (!v.url || !v.goal || !v.until?.length) throw new Error("run needs --spec, or --url, --goal and --until");
    const until = v.until.map(parseUntil);
    spec = validateSpec({ url: v.url, inputs: parseInputs(v.input), stages: [{ goal: v.goal, until: until.length === 1 ? until[0] : until }] });
  }
  const jev = createJev();
  const reportDir = path.resolve(v.report || path.join("pickstep-reports", stamp()));
  const shotDir = path.join(reportDir, "shots");
  if (!v["no-screenshots"]) fs.mkdirSync(shotDir, { recursive: true });
  // One run, one ego-browser process: a fresh session that is finished at the end.
  const session = new Session({ name: `run-${randomBytes(4).toString("hex")}`, idleMinutes: num(v.idle, "--idle") ?? 10 });
  const browser = sessionBrowser(session);
  const log = (m) => process.stderr.write(`[pickstep] ${m}\n`);
  const t0 = Date.now();
  let result;
  try {
    await session.ensure();
    log(`browser session up in ${Date.now() - t0} ms`);
    result = await runSpec({
      browser,
      jev,
      spec,
      log,
      options: {
        shotDir,
        screenshots: !v["no-screenshots"],
        ...(v["max-actions"] && { maxActions: num(v["max-actions"], "--max-actions") }),
        ...(v["max-jev"] && { maxJevCalls: num(v["max-jev"], "--max-jev") }),
        ...(v["min-confidence"] && { minConfidence: num(v["min-confidence"], "--min-confidence") }),
      },
    });
  } finally {
    await session.finish({ keep: Boolean(v["keep-open"]) }).catch((e) => log(`finish failed: ${e.message}`));
  }
  result.wallMs = Date.now() - t0;
  result.session = { spawns: session.spawns, startMs: session.startMs };
  result.jevModel = jev.model;
  const files = writeReport(reportDir, result);
  const stats = phaseStats(result);
  const lines = [
    `status: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
    `wall time: ${(result.wallMs / 1000).toFixed(1)} s, ${result.counts.actions} actions, ${result.counts.jevCalls} Jev calls, browser start ${session.startMs.join("/")} ms`,
    ...result.stages.map((s) => `  stage ${s.index} ${s.status}: ${s.goal} (${s.steps.length} steps, ${(s.ms / 1000).toFixed(1)} s)`),
    `per step (median): ${Object.entries(stats).map(([k, x]) => `${k} ${x.median} ms`).join(", ")}`,
    `report: ${files.html}`,
  ];
  const last = result.stages.at(-1);
  if (last?.handover) lines.push(`hand over to Claude; Jev's top options: ${last.handover.top.map((t) => `${t.option} ${t.p} ${t.description}`).join(" | ")}`);
  out({ ...result, report: files }, v.json, lines.join("\n"));
  return EXIT[result.status] ?? 1;
}

async function cmdDoctor() {
  const lines = [];
  let ok = true;
  try {
    lines.push(`ego-browser: ${findEgo()}`);
  } catch (e) {
    ok = false;
    lines.push(`ego-browser: MISSING (${e.message})`);
  }
  if (!process.env.TYPESAFE_API_KEY) {
    ok = false;
    lines.push("TYPESAFE_API_KEY: not set");
  } else {
    try {
      const jev = createJev();
      const r = await jev.choose({ state: "The page has a link labelled Cart.", instructions: "Which element opens the cart?", options: { e1: "link Cart", e2: "link About" } });
      lines.push(`Jev: ok (${r.model}, ${r.ms} ms, chose ${r.choice})`);
    } catch (e) {
      ok = false;
      lines.push(`Jev: FAILED (${e.message})`);
    }
  }
  out({ ok, lines }, false, lines.join("\n"));
  return ok ? 0 : 1;
}

async function main() {
  const { values: v, positionals } = parse(process.argv.slice(2));
  const [cmd, ...pos] = positionals;
  if (v.help || !cmd) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd === "run") return cmdRun(v);
  if (cmd === "doctor") return cmdDoctor();
  const session = new Session({ name: v.session, idleMinutes: num(v.idle, "--idle") ?? 10 });
  const browser = sessionBrowser(session);
  switch (cmd) {
    case "observe":
      await cmdObserve(browser, v);
      return 0;
    case "act":
      await cmdAct(browser, session, pos, v);
      return 0;
    case "step":
      return cmdStep(browser, session, v);
    case "finish": {
      const r = await session.finish({ keep: Boolean(v.keep) });
      fs.rmSync(historyFile(session), { force: true });
      out(r, v.json, r.finished ? "session finished" : r.reason);
      return 0;
    }
    default:
      throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    process.stderr.write(`pickstep: ${e.message}\n`);
    process.exit(1);
  },
);
