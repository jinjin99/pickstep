// Turn an observation into a Jev choice question, and Jev's answer back into an action.
// There is deliberately no DONE option: completion is checked by code.

import { describe } from "./select.js";

export const NONE = "NONE";
const MAX_OPTIONS = 250;
const MAX_SELECT_OPTIONS = 6;

export const INSTRUCTIONS = [
  "You are operating a web page to reach the goal in `goal`.",
  "Pick the one element to interact with next that makes the most progress toward the goal.",
  "Options that type or select give the value the test case provides; you never invent values.",
  "Ignore cookie banners and newsletter popups; the tool closes them when they get in the way.",
  "Elements marked (below the fold) can be chosen; the tool scrolls to them.",
  "Avoid repeating an action that `recent_actions` says changed nothing.",
  `Choose ${NONE} only if no listed element moves the task forward.`,
].join(" ");

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9À-￿]+/g, " ").trim();

/** Find the test-case input whose key names this field. */
export function matchInput(el, inputs) {
  if (!inputs) return null;
  const hay = norm([el.text, el.name, el.placeholder, el.type].join(" "));
  for (const key of Object.keys(inputs)) {
    const k = norm(key);
    if (!k) continue;
    if (hay.split(" ").includes(k) || hay.includes(k)) return key;
  }
  return null;
}

const isTextField = (el) => el.role === "textbox" || el.role === "searchbox" || (el.role === "combobox" && el.tag === "input");

/**
 * Build Jev's options. Returns { options: {name: description}, actions: {name: action} }.
 * `exclude` holds element ids whose last action changed nothing.
 */
export function buildOptions(obs, { inputs = {}, exclude = new Set() } = {}) {
  const options = {};
  const actions = {};
  const add = (name, desc, action) => {
    if (Object.keys(options).length >= MAX_OPTIONS) return;
    options[name] = desc;
    actions[name] = action;
  };
  for (const el of obs.elements) {
    if (el.disabled || exclude.has(el.id)) continue;
    const d = describe(el);
    if (el.tag === "select") {
      const key = matchInput(el, inputs);
      if (key) {
        add(`e${el.id}`, `select the test value for "${key}" in ${d}`, { kind: "select", id: el.id, value: inputs[key], inputKey: key });
      } else {
        const opts = (el.options || []).filter((o) => !o.selected && !o.disabled && o.value !== "").slice(0, MAX_SELECT_OPTIONS);
        for (const o of opts) add(`e${el.id}o${o.index}`, `choose "${o.label}" in ${d}`, { kind: "select", id: el.id, index: o.index, label: o.label });
      }
      continue;
    }
    if (isTextField(el)) {
      const key = matchInput(el, inputs);
      // An empty text field is only worth offering when the test case has a value for it.
      if (key) add(`e${el.id}`, `type the test value for "${key}" into ${d}`, { kind: "type", id: el.id, value: inputs[key], inputKey: key });
      continue;
    }
    add(`e${el.id}`, `click ${d}`, { kind: "click", id: el.id });
  }
  options[NONE] = "None of the listed elements moves the task toward the goal";
  return { options, actions };
}

export function buildState({ goal, stage, obs, history }) {
  return {
    goal,
    stage,
    page: {
      url: obs.url,
      title: obs.title,
      headings: obs.headings,
      open_dialogs: obs.dialogs,
      alerts: obs.alerts,
      text_excerpt: obs.excerpt,
    },
    recent_actions: history.slice(-6),
  };
}

/** Top-n alternatives, for the report and for handing over to Claude. */
export function topChoices(probabilities, options, n = 3) {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, p]) => ({ option: name, p: Math.round(p * 1000) / 1000, description: options[name] }));
}
