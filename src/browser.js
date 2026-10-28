// The browser interface the loop uses, backed by a persistent Session.

import { selectElements, DEFAULT_LIMIT } from "./select.js";

export function sessionBrowser(session, { limit = DEFAULT_LIMIT } = {}) {
  return {
    session,
    goto: (url) => session.call("goto", { url }, 60_000),
    probe: () => session.call("probe", {}, 10_000),
    async observe() {
      const raw = await session.call("observe", {}, 20_000);
      return { ...raw, total: raw.elements.length, elements: selectElements(raw.elements, limit) };
    },
    act: (action) => session.call("act", action, 45_000),
    settle: () => session.call("settle", {}, 20_000),
    check: (until) => session.call("check", { until }, 15_000),
    // The driver gives up after 10 s on its own; this outer limit only catches a hung driver.
    screenshot: (file) => session.call("screenshot", { path: file }, 15_000),
    url: () => session.call("url", {}, 10_000),
    finish: (opts) => session.finish(opts),
  };
}
