// The run loop: observe -> Jev picks -> act -> settle, until code says the stage is done.

import path from "node:path";
import { NONE, INSTRUCTIONS, buildOptions, buildState, topChoices } from "./decide.js";
import { signature, describe } from "./select.js";
import { StepTimeout } from "./session.js";

export const DEFAULTS = {
  maxActions: 25,
  maxJevCalls: 30,
  stuckAfter: 3,
  minConfidence: 0.25,
  maxRestarts: 2,
  screenshots: true,
};

const NOT_RENDERING =
  "window not rendering: Chromium stopped painting (display asleep, screen locked, or window hidden), so the page cannot be judged";

async function timed(timings, key, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    timings[key] = (timings[key] || 0) + (Date.now() - t0);
  }
}

/**
 * One decision: observe, ask Jev, act, settle. Used by `run` and by the `step` command.
 * Returns { step, obs, verdict } where verdict is "acted" | "none" | "low-confidence" | "no-candidates".
 */
export async function decideAndAct({ browser, jev, goal, stage = "1/1", inputs = {}, history = [], exclude = new Set(), minConfidence = DEFAULTS.minConfidence, timings = {}, obs = null }) {
  if (!obs) obs = await timed(timings, "observe", () => browser.observe());
  const { options, actions } = buildOptions(obs, { inputs, exclude });
  const step = { url: obs.url, elements: obs.elements.length, timings };
  if (Object.keys(options).length <= 1) {
    return { step, obs, verdict: "no-candidates" };
  }
  const state = buildState({ goal, stage, obs, history });
  const answer = await timed(timings, "jev", () => jev.choose({ state, instructions: INSTRUCTIONS, options }));
  step.jev = {
    choice: answer.choice,
    confidence: answer.confidence,
    model: answer.model,
    top: topChoices(answer.probabilities, options),
    apiMs: answer.ms,
  };
  if (answer.choice === NONE) return { step, obs, verdict: "none" };
  if (answer.confidence != null && answer.confidence < minConfidence) return { step, obs, verdict: "low-confidence" };

  const action = actions[answer.choice];
  const el = obs.elements.find((e) => e.id === action.id);
  step.action = {
    kind: action.kind,
    id: action.id,
    target: el ? describe(el) : undefined,
    // Typed values come from the test case; the report names the input, not the value.
    input: action.inputKey,
    option: action.label,
  };
  step.result = await timed(timings, "act", () => browser.act(action));
  step.settle = await timed(timings, "settle", () => browser.settle());
  return { step, obs, verdict: "acted", action };
}

function summarizeTimings(stages) {
  const totals = {};
  for (const st of stages) for (const s of st.steps) for (const [k, v] of Object.entries(s.timings || {})) totals[k] = (totals[k] || 0) + v;
  return totals;
}

/**
 * Run a spec: { name, url, inputs, budget, stages: [{ goal, until, url?, maxActions? }] }.
 * Status per stage and overall: done | budget | stuck | blocked.
 */
export async function runSpec({ browser, jev, spec, options = {}, log = () => {} }) {
  const opt = { ...DEFAULTS, ...spec.budget, ...options };
  const started = Date.now();
  const result = {
    name: spec.name || spec.stages[0].goal,
    startedAt: new Date(started).toISOString(),
    status: "done",
    reason: null,
    stages: [],
    counts: { actions: 0, jevCalls: 0, restarts: 0 },
  };
  let shotN = 0;
  const shoot = async (timings, label) => {
    if (!opt.screenshots || !opt.shotDir) return undefined;
    shotN += 1;
    const file = path.join(opt.shotDir, `${String(shotN).padStart(3, "0")}-${label}.jpg`);
    const r = await timed(timings, "screenshot", () => browser.screenshot(file));
    return r.error ? { error: r.error } : { file: path.basename(r.path || file) };
  };

  try {
    if (spec.url) {
      const t = {};
      const r = await timed(t, "goto", () => browser.goto(spec.url));
      await timed(t, "settle", () => browser.settle());
      result.open = { url: r.url, timings: t };
      log(`opened ${r.url} in ${t.goto} ms`);
    }

    for (let si = 0; si < spec.stages.length; si++) {
      const stageSpec = spec.stages[si];
      const stageLabel = `${si + 1}/${spec.stages.length}`;
      const stage = { index: si + 1, goal: stageSpec.goal, until: stageSpec.until, status: null, reason: null, steps: [] };
      result.stages.push(stage);
      const stageStart = Date.now();
      const stageMaxActions = stageSpec.maxActions ?? Infinity;
      let stageActions = 0;
      if (stageSpec.url) {
        await browser.goto(stageSpec.url);
        await browser.settle();
      }
      const history = [];
      const exclude = new Set();
      let lastSig = null;
      let lastStep = null;
      let noChange = 0;

      const end = (status, reason) => {
        stage.status = status;
        stage.reason = reason;
      };

      while (!stage.status) {
        const iterStart = Date.now();
        const timings = {};
        const probe = await timed(timings, "probe", () => browser.probe());
        if (!probe.painting) {
          end("blocked", NOT_RENDERING);
          stage.probe = probe;
          break;
        }
        const check = await timed(timings, "check", () => browser.check(stageSpec.until));
        if (check.met) {
          end("done", null);
          stage.doneAt = { url: check.results?.[0]?.url, checkMs: timings.check };
          stage.finalShot = await shoot(timings, `stage${si + 1}-done`);
          break;
        }
        if (result.counts.actions >= opt.maxActions || stageActions >= stageMaxActions) {
          end("budget", `action budget used (${result.counts.actions} actions)`);
          break;
        }
        if (result.counts.jevCalls >= opt.maxJevCalls) {
          end("budget", `Jev call budget used (${result.counts.jevCalls} calls)`);
          break;
        }

        const obs = await timed(timings, "observe", () => browser.observe());
        const sig = signature(obs);
        if (lastStep) {
          lastStep.changed = sig !== lastSig;
          if (lastStep.changed) {
            noChange = 0;
            exclude.clear();
          } else {
            noChange += 1;
            if (lastStep.action?.id) exclude.add(lastStep.action.id);
            history[history.length - 1] += " -> nothing changed";
          }
        }
        if (noChange >= opt.stuckAfter) {
          end("stuck", `${noChange} actions in a row changed nothing on the page`);
          break;
        }
        lastSig = sig;

        let out;
        try {
          result.counts.jevCalls += 1;
          out = await decideAndAct({ browser, jev, goal: stageSpec.goal, stage: stageLabel, inputs: spec.inputs, history, exclude, minConfidence: opt.minConfidence, timings, obs });
        } catch (e) {
          const step = { n: stage.steps.length + 1, url: obs.url, error: String(e.message || e), timings, ms: Date.now() - iterStart };
          stage.steps.push(step);
          if (e instanceof StepTimeout) {
            result.counts.restarts += 1;
            if (result.counts.restarts > opt.maxRestarts) end("blocked", `browser process timed out ${result.counts.restarts} times: ${e.message}`);
          } else if (e.name === "JevError") {
            end("blocked", e.message);
          } else {
            // Most often the element went away between observe and act; observe again.
            result.counts.actions += 1;
            stageActions += 1;
            history.push(`error: ${step.error.slice(0, 120)}`);
            lastStep = step;
          }
          log(`step ${step.n}: ${step.error}`);
          continue;
        }
        const step = { n: stage.steps.length + 1, ...out.step };
        stage.steps.push(step);
        if (out.verdict === "no-candidates") {
          end("blocked", "no interactive elements to choose from");
        } else if (out.verdict === "none") {
          end("blocked", "Jev answered NONE: no element moves toward the goal");
          stage.handover = { top: step.jev.top };
        } else if (out.verdict === "low-confidence") {
          end("blocked", `Jev confidence ${step.jev.confidence} is below ${opt.minConfidence}`);
          stage.handover = { top: step.jev.top };
        } else {
          result.counts.actions += 1;
          stageActions += 1;
          history.push(`${step.action.kind} ${step.action.target || "e" + step.action.id}`);
          step.shot = await shoot(timings, `step${step.n}`);
          lastStep = step;
          log(`stage ${stageLabel} step ${step.n}: ${step.action.kind} ${step.action.target} (conf ${step.jev.confidence}) via ${step.result.method || "-"}`);
        }
        step.ms = Date.now() - iterStart;
      }
      stage.ms = Date.now() - stageStart;
      if (stage.status !== "done") {
        result.status = stage.status;
        result.reason = `stage ${stageLabel}: ${stage.reason}`;
        break;
      }
    }
  } catch (e) {
    result.status = "blocked";
    result.reason = `error: ${e.message || e}`;
  }
  result.totalMs = Date.now() - started;
  result.timings = summarizeTimings(result.stages);
  return result;
}
