// A local fake page and a fake Jev, enough to run the whole loop without a browser or network.

import { selectElements } from "../../src/select.js";

let hashSeq = 0;

/** A tiny shop: home -> product -> add to cart -> cart. Elements carry ids like the real observer. */
export function fakeShop({ painting = true, hangOn = null } = {}) {
  const state = { page: "home", cart: 0, slide: 1, searched: null, calls: [] };
  const pages = {
    home: () => ({
      title: "Shop",
      text: `Welcome. Slide ${state.slide}`,
      els: [
        { role: "link", text: "About", href: "https://shop.test/about", go: "about" },
        { role: "link", text: "Blue Kettle", href: "https://shop.test/product/kettle", go: "product" },
        { role: "link", text: "Blue Kettle", href: "https://shop.test/product/kettle", go: "product" }, // duplicate link+text
        { role: "button", text: "Next slide", run: () => state.slide++ },
        { role: "button", text: "Newsletter", run: () => {} },
        { role: "button", text: "Share", run: () => {} },
        { role: "button", text: "Print", run: () => {} },
        { role: "button", text: "Favorite", run: () => {} },
        { role: "searchbox", tag: "input", text: "Search", name: "q" },
      ],
    }),
    about: () => ({ title: "About", text: "About us", els: [{ role: "link", text: "Home", href: "https://shop.test/", go: "home" }] }),
    product: () => ({
      title: "Blue Kettle",
      text: `Blue Kettle $20 ${state.cart ? "Added to cart" : ""}`,
      els: [
        { role: "button", text: "Add to cart", run: () => state.cart++ },
        { role: "link", text: `Cart (${state.cart})`, href: "https://shop.test/cart", go: "cart" },
      ],
    }),
    cart: () => ({ title: "Cart", text: `Your cart ${state.cart} item`, els: [] }),
    search: () => ({ title: "Search", text: `Results for ${state.searched}`, els: [] }),
  };
  const urls = { home: "https://shop.test/", about: "https://shop.test/about", product: "https://shop.test/product/kettle", cart: "https://shop.test/cart", search: "https://shop.test/search" };
  let current = [];
  const textHash = new Map();

  return {
    state,
    async goto(url) {
      state.calls.push(["goto", url]);
      state.page = Object.keys(urls).find((k) => urls[k] === url) || "home";
      return { url: urls[state.page] };
    },
    async probe() {
      return { painting };
    },
    async observe() {
      const p = pages[state.page]();
      current = p.els.map((e, i) => ({ id: i + 1, tag: e.tag || (e.role === "link" ? "a" : "button"), inView: true, below: false, top: i * 30, left: 0, ...e }));
      if (!textHash.has(p.text)) textHash.set(p.text, String(++hashSeq));
      return {
        url: urls[state.page],
        title: p.title,
        textHash: textHash.get(p.text),
        headings: [p.title],
        dialogs: [],
        alerts: [],
        excerpt: p.text,
        elements: selectElements(current),
      };
    },
    async act(action) {
      state.calls.push(["act", action]);
      if (hangOn && action.kind === hangOn.kind && hangOn.times-- > 0) {
        const { StepTimeout } = await import("../../src/session.js");
        throw new StepTimeout("act", 1);
      }
      const el = current.find((e) => e.id === action.id);
      if (!el) throw new Error(`element ${action.id} is gone; observe again`);
      if (action.kind === "type") {
        state.searched = action.value.replace(/\n$/, "");
        if (action.value.endsWith("\n")) state.page = "search";
        return { method: "fill" };
      }
      if (el.go) state.page = el.go;
      if (el.run) el.run();
      return { method: "cdp" };
    },
    async settle() {
      return { ms: 0 };
    },
    async check(until) {
      const conds = Array.isArray(until) ? until : [until];
      const p = pages[state.page]();
      const results = conds.map((c) => {
        let met = true;
        if (c.text) met &&= p.text.toLowerCase().includes(c.text.toLowerCase());
        if (c.url) met &&= urls[state.page].includes(c.url);
        if (c.js) met &&= c.js === "cart>0" ? state.cart > 0 : false;
        return { met, url: urls[state.page] };
      });
      return { met: results.some((r) => r.met), results };
    },
    async screenshot(file) {
      return { path: file };
    },
  };
}

/**
 * Fake Jev: `pick(state, options)` returns an option name (or a {choice, confidence}).
 * Records every question it was asked.
 */
export function fakeJev(pick) {
  const asked = [];
  return {
    asked,
    model: "fake-jev",
    async choose(q) {
      asked.push(q);
      let r = pick(q.state, q.options);
      if (typeof r === "string") r = { choice: r, confidence: 0.9 };
      if (!Object.hasOwn(q.options, r.choice)) throw new Error(`fake picked ${r.choice}, not an option`);
      const probabilities = Object.fromEntries(Object.keys(q.options).map((k) => [k, k === r.choice ? 0.9 : 0.1 / (Object.keys(q.options).length - 1)]));
      return { choice: r.choice, confidence: r.confidence, probabilities, model: "fake-jev", ms: 1 };
    },
  };
}

/** Pick the first option whose description matches the regex. */
export const byText = (re) => (_state, options) => Object.keys(options).find((k) => re.test(options[k])) || "NONE";
