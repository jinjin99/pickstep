// JSON and HTML reports for a run.

import fs from "node:fs";
import path from "node:path";

export function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const PHASES = ["probe", "check", "observe", "jev", "act", "settle", "screenshot"];

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function phaseStats(result) {
  const steps = result.stages.flatMap((s) => s.steps);
  const stats = {};
  for (const p of PHASES) {
    const xs = steps.map((s) => s.timings?.[p]).filter((v) => typeof v === "number");
    if (xs.length) stats[p] = { total: xs.reduce((a, b) => a + b, 0), median: median(xs), n: xs.length };
  }
  return stats;
}

function ms(v) {
  return v == null ? "" : `${(v / 1000).toFixed(2)} s`;
}

function condText(u) {
  const one = (c) => Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(" and ");
  return Array.isArray(u) ? u.map(one).join(" OR ") : one(u);
}

export function renderHtml(result) {
  const stats = phaseStats(result);
  const COLORS = { done: "#1a7f37", budget: "#9a6700", stuck: "#bc4c00", blocked: "#cf222e" };
  const statusColor = COLORS[result.status] || "#57606a";
  const rows = [];
  for (const st of result.stages) {
    rows.push(`<h2>Stage ${st.index}: ${escapeHtml(st.goal)} <span class="pill" style="background:${COLORS[st.status] || "#57606a"}">${escapeHtml(st.status)}</span></h2>`);
    rows.push(`<p class="muted">until ${escapeHtml(condText(st.until))} &middot; ${ms(st.ms)}${st.reason ? ` &middot; ${escapeHtml(st.reason)}` : ""}</p>`);
    if (st.handover) {
      rows.push(`<p>Handed over. Jev's top options: ${st.handover.top.map((t) => `${escapeHtml(t.option)} (${t.p}) ${escapeHtml(t.description)}`).join("; ")}</p>`);
    }
    rows.push("<table><thead><tr><th>#</th><th>action</th><th>Jev</th><th>observe</th><th>Jev</th><th>act</th><th>settle</th><th>shot</th><th>step</th><th>screenshot</th></tr></thead><tbody>");
    for (const s of st.steps) {
      const t = s.timings || {};
      const action = s.error
        ? `<span class="err">${escapeHtml(s.error)}</span>`
        : s.action
          ? `${escapeHtml(s.action.kind)} ${escapeHtml(s.action.target || "e" + s.action.id)}${s.action.input ? ` &larr; input <code>${escapeHtml(s.action.input)}</code>` : ""}<br><span class="muted">${escapeHtml(s.result?.method || "")}${s.result?.blockedBy ? ` (blocked by ${escapeHtml(s.result.blockedBy)})` : ""}${s.changed === false ? " &middot; no change" : ""}</span>`
          : `<span class="muted">no action</span>`;
      const jev = s.jev
        ? `${escapeHtml(s.jev.choice)} <b>${s.jev.confidence == null ? "?" : s.jev.confidence.toFixed(2)}</b><br><span class="muted">${s.jev.top.slice(1).map((x) => `${escapeHtml(x.option)} ${x.p}`).join(", ")}</span>`
        : "";
      const shot = s.shot?.file ? `<a href="shots/${encodeURIComponent(s.shot.file)}"><img src="shots/${encodeURIComponent(s.shot.file)}" loading="lazy"></a>` : s.shot?.error ? `<span class="err">${escapeHtml(s.shot.error)}</span>` : "";
      rows.push(`<tr><td>${s.n}</td><td>${action}<br><span class="muted url">${escapeHtml(s.url)}</span></td><td>${jev}</td><td>${ms(t.observe)}</td><td>${ms(t.jev)}</td><td>${ms(t.act)}</td><td>${ms(t.settle)}</td><td>${ms(t.screenshot)}</td><td>${ms(s.ms)}</td><td>${shot}</td></tr>`);
    }
    rows.push("</tbody></table>");
    if (st.finalShot?.file) rows.push(`<p>Final state:<br><img class="final" src="shots/${encodeURIComponent(st.finalShot.file)}"></p>`);
  }
  const statRows = Object.entries(stats)
    .map(([p, v]) => `<tr><td>${p}</td><td>${ms(v.total)}</td><td>${ms(v.median)}</td><td>${v.n}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>pickstep report</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#57606a;--line:#d0d7de}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#8d96a0;--line:#30363d}}
body{font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:1200px;padding:16px}
table{border-collapse:collapse;width:100%;margin:8px 0 24px}th,td{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}
.muted{color:var(--muted);font-size:12px}.url{word-break:break-all}.err{color:#cf222e}
.pill{color:#fff;border-radius:10px;padding:1px 8px;font-size:12px;vertical-align:middle}
img{max-width:220px;border:1px solid var(--line)}img.final{max-width:100%}code{font-size:12px}
</style></head><body>
<h1>${escapeHtml(result.name)} <span class="pill" style="background:${statusColor}">${escapeHtml(result.status)}</span></h1>
<p>${escapeHtml(result.startedAt)} &middot; total ${ms(result.totalMs)} &middot; ${result.counts.actions} actions &middot; ${result.counts.jevCalls} Jev calls &middot; ${result.counts.restarts} restarts${result.reason ? ` &middot; ${escapeHtml(result.reason)}` : ""}</p>
<table><thead><tr><th>phase</th><th>total</th><th>median per step</th><th>steps</th></tr></thead><tbody>${statRows}</tbody></table>
${rows.join("\n")}
</body></html>
`;
}

export function writeReport(dir, result) {
  fs.mkdirSync(dir, { recursive: true });
  const withStats = { ...result, phaseStats: phaseStats(result) };
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(withStats, null, 2));
  fs.writeFileSync(path.join(dir, "report.html"), renderHtml(result));
  return { json: path.join(dir, "report.json"), html: path.join(dir, "report.html") };
}
