// Host-side half of observation: dedupe, order and cap the raw element table.

export const DEFAULT_LIMIT = 120;

function band(el) {
  if (el.inView) return 0;
  if (el.below) return 1;
  return 2; // above the viewport
}

/** Elements on screen first, then below the fold, then above; one entry per link+text. */
export function selectElements(raw, limit = DEFAULT_LIMIT) {
  const sorted = [...raw].sort((a, b) => band(a) - band(b) || a.top - b.top || a.left - b.left);
  const seen = new Set();
  const out = [];
  for (const el of sorted) {
    if (el.href) {
      const key = `${el.href}\u0000${(el.text || "").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(el);
    if (out.length >= limit) break;
  }
  return out;
}

/** Fingerprint used to tell whether an action changed anything. Scroll position is left out on purpose. */
export function signature(obs) {
  const els = obs.elements.map((e) => `${e.role}|${e.text}|${e.href || ""}|${e.checked ?? ""}`).join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < els.length; i++) {
    h ^= els.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${obs.url}#${obs.title}#${obs.textHash}#${h.toString(16)}#${(obs.dialogs || []).join("|")}`;
}

export function describe(el) {
  const label = el.text ? `"${el.text}"` : "(no text)";
  let s = `${el.role} ${label}`;
  if (el.href) {
    try {
      const u = new URL(el.href);
      s += ` -> ${u.pathname}${u.search}`.slice(0, 80);
    } catch {}
  }
  if (el.type && !["submit", "button"].includes(el.type) && el.role === "textbox") s += ` [${el.type}]`;
  if (el.checked != null) s += el.checked ? " [checked]" : " [unchecked]";
  if (!el.inView) s += el.below ? " (below the fold)" : " (above the viewport)";
  return s;
}

export function formatObservation(obs) {
  const lines = [`url: ${obs.url}`, `title: ${obs.title}`];
  if (obs.dialogs?.length) lines.push(`dialogs: ${obs.dialogs.map((d) => d.slice(0, 120)).join(" | ")}`);
  for (const el of obs.elements) lines.push(`  [${el.id}] ${describe(el)}${el.disabled ? " (disabled)" : ""}`);
  return lines.join("\n");
}
