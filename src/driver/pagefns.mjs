// Functions that run inside the web page through page.evaluate().
// Each one is serialized on its own, so it must not reference anything
// outside its own body.

/**
 * Build the element table: number every visible interactive element with a
 * data attribute and return one record per element, plus a short page summary.
 * Selection (dedupe, ordering, limit) happens on the host, see select.js.
 */
export function observePage(opts) {
  const ATTR = opts.attr;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const styles = new Map();
  const style = (el) => {
    let s = styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };

  const all = [];
  const collect = (root) => {
    for (const el of root.querySelectorAll("*")) {
      all.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };
  collect(document);
  for (const el of all) if (el.hasAttribute(ATTR)) el.removeAttribute(ATTR);

  const SEL = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=menuitem]", "[role=tab]", "[role=checkbox]",
    "[role=radio]", "[role=option]", "[role=switch]", "[role=combobox]", "[onclick]",
    "[tabindex]:not([tabindex='-1'])", "[contenteditable='']", "[contenteditable=true]",
  ].join(",");
  // Clickable without a role: cursor:pointer on an element whose parent is not.
  const POINTER_TAGS = new Set(["DIV", "SPAN", "LI", "IMG", "LABEL", "SVG", "P", "TD", "H2", "H3", "H4", "I"]);
  let pointerChecks = 0;
  const isCandidate = (el) => {
    if (el.matches(SEL)) return true;
    if (!POINTER_TAGS.has(el.tagName.toUpperCase())) return false;
    if (pointerChecks++ > 3000) return false;
    if (style(el).cursor !== "pointer") return false;
    const p = parentOf(el);
    return !p || style(p).cursor !== "pointer";
  };

  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toUpperCase();
    if (t === "A") return "link";
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "SELECT") return "select";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      const ty = (el.type || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      if (ty === "search") return "searchbox";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "clickable";
  };

  const labelOf = (el) => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
      if (t) return t;
    }
    const t = el.tagName.toUpperCase();
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") {
      const fromLabel = el.labels && el.labels[0] ? clean(el.labels[0].innerText) : "";
      if (t === "INPUT" && ["submit", "button", "reset"].includes((el.type || "").toLowerCase())) {
        return clean(el.value) || fromLabel;
      }
      return fromLabel || clean(el.placeholder) || clean(el.getAttribute("name")) || clean(el.title);
    }
    const text = clean(el.innerText);
    if (text) return text;
    if (t === "IMG") return clean(el.alt);
    const img = el.querySelector && el.querySelector("img[alt]");
    if (img && clean(img.alt)) return clean(img.alt);
    return clean(el.title) || clean(el.getAttribute("name"));
  };

  // Shown on screen, or below the fold where scrolling will reveal it.
  const placement = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = style(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return null;
    if (el.checkVisibility && !el.checkVisibility()) return null;
    if (r.right <= 0 || r.left >= vw) return null; // off to the left or right
    let opacity = Number(cs.opacity);
    for (let a = parentOf(el); a && a !== document.documentElement; a = parentOf(a)) {
      if (a.nodeType !== 1) continue;
      const s = style(a);
      opacity *= Number(s.opacity);
      const clipX = s.overflowX === "hidden" || s.overflowX === "clip";
      const clipY = s.overflowY === "hidden" || s.overflowY === "clip";
      if (clipX || clipY) {
        const ar = a.getBoundingClientRect();
        if (clipX && (r.right <= ar.left + 1 || r.left >= ar.right - 1)) return null;
        if (clipY && (r.bottom <= ar.top + 1 || r.top >= ar.bottom - 1)) return null;
      }
    }
    const below = r.top >= vh;
    const inView = r.bottom > 0 && r.top < vh;
    // A transparent ancestor on screen is a collapsed menu; below the fold it
    // is usually a card that fades in when scrolled to, so keep those.
    if (opacity < 0.05 && !below) return null;
    return { r, inView, below };
  };

  const elements = [];
  let n = 0;
  for (const el of all) {
    if (!isCandidate(el)) continue;
    const p = placement(el);
    if (!p) continue;
    const role = roleOf(el);
    const text = labelOf(el).slice(0, 100);
    if (role === "clickable" && !text) continue; // a bare pointer area tells the model nothing
    n += 1;
    el.setAttribute(ATTR, String(n));
    const tag = el.tagName.toLowerCase();
    const rec = {
      id: n,
      tag,
      role,
      text,
      inView: p.inView,
      below: p.below,
      top: Math.round(p.r.top),
      left: Math.round(p.r.left),
      w: Math.round(p.r.width),
      h: Math.round(p.r.height),
    };
    if (typeof el.href === "string" && el.href) rec.href = el.href;
    if (tag === "input") {
      rec.type = (el.type || "text").toLowerCase();
      if (rec.type === "checkbox" || rec.type === "radio") rec.checked = el.checked;
    }
    if (el.getAttribute("name")) rec.name = el.getAttribute("name").slice(0, 60);
    if (el.placeholder) rec.placeholder = clean(el.placeholder).slice(0, 60);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") rec.disabled = true;
    if (tag === "select") {
      rec.options = [...el.options].slice(0, 12).map((o, i) => ({
        index: i, value: o.value, label: clean(o.label || o.text).slice(0, 60), selected: o.selected, disabled: o.disabled,
      }));
    }
    elements.push(rec);
  }

  const visibleText = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && style(el).visibility !== "hidden" ? clean(el.innerText) : "";
  };
  const pick = (selector, max, len) => {
    const out = [];
    for (const el of all) {
      if (out.length >= max) break;
      if (!el.matches(selector)) continue;
      const t = visibleText(el);
      if (t) out.push(t.slice(0, len));
    }
    return out;
  };

  const bodyText = document.body ? document.body.innerText || "" : "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < bodyText.length; i++) {
    hash ^= bodyText.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const main = document.querySelector("main") || document.body;

  return {
    url: location.href,
    title: document.title,
    viewport: { width: vw, height: vh },
    scrollY: Math.round(window.scrollY),
    docHeight: document.documentElement.scrollHeight,
    textHash: hash.toString(16),
    textLength: bodyText.length,
    headings: pick("h1,h2", 8, 80),
    dialogs: pick("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]", 3, 300),
    alerts: pick("[role=alert],[role=status],[aria-live=polite],[aria-live=assertive]", 3, 160),
    excerpt: main ? clean(main.innerText).slice(0, 600) : "",
    scanned: all.length,
    elements,
  };
}

/**
 * Scroll the element to the middle of the viewport, wait until its position
 * and the URL stop moving, then hit test a few points inside it.
 */
export async function prepareClick(arg) {
  const { attr, id } = arg;
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const find = (root) => {
    const hit = root.querySelector("[" + attr + '="' + id + '"]');
    if (hit) return hit;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const f = find(el.shadowRoot);
        if (f) return f;
      }
    }
    return null;
  };
  const el = find(document);
  if (!el) return { found: false };

  // Keep navigation in this tab so the session's page follows it.
  if (el.tagName === "A" && el.target && el.target !== "_self") el.removeAttribute("target");
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

  // setTimeout, not requestAnimationFrame: rAF stops when the window is not painting.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const urlAtStart = location.href;
  let prev = "";
  let stable = 0;
  let waited = 0;
  for (let i = 0; i < 20 && stable < 2; i++) {
    await sleep(40);
    waited += 40;
    const r = el.getBoundingClientRect();
    const key = [r.left, r.top, r.width, r.height].map(Math.round).join(",");
    stable = key === prev && location.href === urlAtStart ? stable + 1 : 0;
    prev = key;
  }

  const deepAt = (x, y) => {
    let e = document.elementFromPoint(x, y);
    while (e && e.shadowRoot) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  };
  const labels = el.labels ? [...el.labels] : [];
  const owns = (h) => {
    for (let n = h; n; n = parentOf(n)) if (n === el || labels.includes(n)) return true;
    return false;
  };
  const describe = (e) => {
    const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const text = String(e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60);
    return e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (cls ? "." + cls : "") + (text ? ' "' + text + '"' : "");
  };

  const r = el.getBoundingClientRect();
  const href = typeof el.href === "string" ? el.href : "";
  let sameOrigin = false;
  if (href) {
    try {
      const u = new URL(href);
      sameOrigin = u.origin === location.origin && (u.protocol === "http:" || u.protocol === "https:");
    } catch {}
  }
  const meta = { found: true, tag: el.tagName.toLowerCase(), href, sameOrigin, stableMs: waited, stable: stable >= 2 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let blocker = null;
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]]) {
    const x = Math.min(vw - 1, Math.max(0, r.left + r.width * fx));
    const y = Math.min(vh - 1, Math.max(0, r.top + r.height * fy));
    const h = deepAt(x, y);
    if (h && owns(h)) return { ...meta, hit: true, x: Math.round(x), y: Math.round(y) };
    if (!blocker && h) blocker = describe(h);
  }
  return { ...meta, hit: false, blocker };
}

/** Close cookie banners (always the reject choice) and marketing popups. */
export function dismissOverlays() {
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const all = [];
  const collect = (root) => {
    for (const el of root.querySelectorAll("*")) {
      all.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };
  collect(document);
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const textOf = (el) => clean(el.getAttribute("aria-label") || el.innerText || el.value || el.title).toLowerCase();
  const ancestorMatches = (el, test, depth) => {
    for (let a = parentOf(el), i = 0; a && i < depth; a = parentOf(a), i++) if (a.nodeType === 1 && test(a)) return true;
    return false;
  };
  const isOverlay = (a) => {
    if (a.matches("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]")) return true;
    const cls = (typeof a.className === "string" ? a.className : "") + " " + (a.id || "");
    if (/modal|popup|pop-up|overlay|newsletter|subscribe|lightbox|drawer-overlay|interstitial/i.test(cls)) return true;
    const cs = getComputedStyle(a);
    return (cs.position === "fixed" || cs.position === "sticky") && Number(cs.zIndex) >= 10;
  };
  const isConsent = (a) => /cookie|consent|gdpr|privacy|tracking/i.test(clean(a.innerText).slice(0, 2000) + " " + a.id + " " + (typeof a.className === "string" ? a.className : ""));

  const REJECT = /^(reject|decline|deny|refuse|disagree|opt out|necessary only|only necessary|essential only|only essential|use necessary|use essential|continue without|拒绝)/;
  const CLOSE = /^(close|dismiss|no thanks|no, thanks|not now|maybe later|关闭)\b|^(×|✕|✖|x)$/;
  const buttons = all.filter((el) => el.matches("button,a,[role=button],input[type=button],input[type=submit],[aria-label]"));
  const done = [];
  for (const el of buttons) {
    if (!shown(el)) continue;
    const t = textOf(el);
    if (t.length > 40) continue;
    if (REJECT.test(t) && ancestorMatches(el, isConsent, 12)) {
      el.click();
      done.push("cookie: " + t);
    }
  }
  for (const el of buttons) {
    if (!shown(el)) continue;
    const t = textOf(el);
    if (t.length > 40) continue;
    if ((CLOSE.test(t) || /\bclose\b/.test(clean(el.getAttribute("aria-label")).toLowerCase())) && ancestorMatches(el, isOverlay, 12)) {
      el.click();
      done.push("popup: " + t);
    }
  }
  return done;
}

/** DOM click: the last resort when the target stays covered. */
export function domClick(arg) {
  const find = (root) => {
    const hit = root.querySelector("[" + arg.attr + '="' + arg.id + '"]');
    if (hit) return hit;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const f = find(el.shadowRoot);
        if (f) return f;
      }
    }
    return null;
  };
  const el = find(document);
  if (!el) return false;
  el.click();
  return true;
}

/** Resolve after the DOM has been quiet for quietMs, or after maxMs. */
export function waitQuiet(arg) {
  const { quietMs, maxMs } = arg;
  return new Promise((resolve) => {
    const start = Date.now();
    let last = Date.now();
    let mutations = 0;
    let unloading = false;
    const onHide = () => {
      unloading = true;
    };
    window.addEventListener("pagehide", onHide, { once: true });
    window.addEventListener("beforeunload", onHide, { once: true });
    // Only content changes count; style and class churn from animations would never go quiet.
    const mo = new MutationObserver((list) => {
      mutations += list.length;
      last = Date.now();
    });
    mo.observe(document, { subtree: true, childList: true, characterData: true });
    const tick = () => {
      const now = Date.now();
      if (unloading || now - last >= quietMs || now - start >= maxMs) {
        mo.disconnect();
        resolve({ ms: now - start, mutations, unloading, readyState: document.readyState, url: location.href });
      } else {
        setTimeout(tick, 50);
      }
    };
    setTimeout(tick, 50);
  });
}

/** Is the page still painting? requestAnimationFrame stops when it is not. */
export function renderProbe(arg) {
  return new Promise((resolve) => {
    let settled = false;
    const t0 = performance.now();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ painting: false, visibility: document.visibilityState, ms: Math.round(performance.now() - t0) });
    }, arg.timeoutMs);
    requestAnimationFrame(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ painting: true, visibility: document.visibilityState, ms: Math.round(performance.now() - t0) });
    });
  });
}

/** Text and URL parts of a completion condition. */
export function checkCondition(cond) {
  const collectText = () => {
    const parts = [document.body ? document.body.innerText || "" : ""];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          for (const child of el.shadowRoot.children) parts.push(child.innerText || child.textContent || "");
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return parts.join("\n").replace(/\s+/g, " ").toLowerCase();
  };
  const out = { url: location.href };
  if (cond.text != null) out.text = collectText().includes(String(cond.text).replace(/\s+/g, " ").toLowerCase());
  if (cond.url != null) out.urlMatch = location.href.includes(String(cond.url));
  return out;
}
