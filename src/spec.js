// Test specs: a start URL, test-case inputs, a budget, and one or more stages.

import fs from "node:fs";
import YAML from "yaml";

const COND_KEYS = new Set(["text", "url", "js"]);

/** Parse a CLI completion condition: "text:Your cart", "url:/cart", "js:document.title === 'x'". */
export function parseUntil(s) {
  const m = /^(text|url|js):([\s\S]+)$/.exec(String(s));
  if (!m) throw new Error(`--until must look like text:<words>, url:<fragment> or js:<expression>, got "${s}"`);
  return { [m[1]]: m[2] };
}

function checkCond(c, where) {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${where}: a condition is an object with text, url or js`);
  const keys = Object.keys(c);
  if (!keys.length) throw new Error(`${where}: empty condition`);
  for (const k of keys) {
    if (!COND_KEYS.has(k)) throw new Error(`${where}: unknown condition key "${k}" (use text, url, js)`);
    if (typeof c[k] !== "string" || !c[k].length || c[k].length > 2000) throw new Error(`${where}.${k} must be a non-empty string`);
  }
  return c;
}

/** `until` is one condition (all keys must hold) or a list of them (any one is enough). */
export function checkUntil(u, where) {
  if (Array.isArray(u)) {
    if (!u.length) throw new Error(`${where}: empty condition list`);
    return u.map((c, i) => checkCond(c, `${where}[${i}]`));
  }
  return checkCond(u, where);
}

export function checkUrl(u, where) {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new Error(`${where} is not a URL: ${u}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${where} must be http(s)`);
  return url.href;
}

const posInt = (v, where) => {
  if (!Number.isInteger(v) || v < 1 || v > 1000) throw new Error(`${where} must be an integer 1-1000`);
  return v;
};

export function validateSpec(raw) {
  if (!raw || typeof raw !== "object") throw new Error("spec must be an object");
  const spec = { name: raw.name, stages: [] };
  if (raw.name != null && typeof raw.name !== "string") throw new Error("name must be a string");
  if (raw.url != null) spec.url = checkUrl(raw.url, "url");
  if (raw.inputs != null) {
    if (typeof raw.inputs !== "object" || Array.isArray(raw.inputs)) throw new Error("inputs must map names to strings");
    spec.inputs = {};
    for (const [k, v] of Object.entries(raw.inputs)) {
      if (typeof v !== "string" || v.length > 2000) throw new Error(`inputs.${k} must be a string`);
      spec.inputs[k] = v;
    }
  }
  if (raw.budget != null) {
    spec.budget = {};
    if (raw.budget.actions != null) spec.budget.maxActions = posInt(raw.budget.actions, "budget.actions");
    if (raw.budget.jev != null) spec.budget.maxJevCalls = posInt(raw.budget.jev, "budget.jev");
  }
  const stages = raw.stages ?? (raw.goal ? [{ goal: raw.goal, until: raw.until }] : null);
  if (!Array.isArray(stages) || !stages.length) throw new Error("spec needs stages (or goal + until)");
  stages.forEach((st, i) => {
    const where = `stages[${i}]`;
    if (typeof st.goal !== "string" || !st.goal.trim() || st.goal.length > 1000) throw new Error(`${where}.goal must be a non-empty string`);
    if (st.until == null) throw new Error(`${where}.until is required: completion is checked by code, not by the model`);
    const stage = { goal: st.goal.trim(), until: checkUntil(st.until, `${where}.until`) };
    if (st.url != null) stage.url = checkUrl(st.url, `${where}.url`);
    if (st.maxActions != null) stage.maxActions = posInt(st.maxActions, `${where}.maxActions`);
    spec.stages.push(stage);
  });
  return spec;
}

export function loadSpec(file) {
  const text = fs.readFileSync(file, "utf8");
  const raw = /\.json$/i.test(file) ? JSON.parse(text) : YAML.parse(text);
  return validateSpec(raw);
}
