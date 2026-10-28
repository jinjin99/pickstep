// The whole loop against a local fake page and a fake Jev.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSpec } from "../src/loop.js";
import { validateSpec } from "../src/spec.js";
import { fakeShop, fakeJev, byText } from "./helpers/fake-shop.js";

const spec = (raw) => validateSpec({ url: "https://shop.test/", ...raw });

test("multi-stage run reaches done; completion is decided by code", async () => {
  const browser = fakeShop();
  const jev = fakeJev((state, options) => {
    if (/product page/.test(state.goal)) return byText(/Blue Kettle/)(state, options);
    if (/Add/.test(state.goal)) return byText(/Add to cart/)(state, options);
    return byText(/Cart \(/)(state, options);
  });
  const r = await runSpec({
    browser,
    jev,
    spec: spec({
      stages: [
        { goal: "Open the product page of the kettle", until: { url: "/product/" } },
        { goal: "Add it to the cart", until: { js: "cart>0" } },
        { goal: "Open the cart", until: { url: "/cart", text: "Your cart" } },
      ],
    }),
  });
  assert.equal(r.status, "done");
  assert.deepEqual(r.stages.map((s) => s.status), ["done", "done", "done"]);
  assert.equal(r.counts.actions, 3);
  assert.equal(r.counts.jevCalls, 3);
  for (const q of jev.asked) {
    assert.ok(Object.hasOwn(q.options, "NONE"), "NONE is offered");
    assert.ok(!Object.keys(q.options).some((k) => /^done$/i.test(k)), "no DONE option");
  }
  // duplicate link+text appears once
  assert.equal(Object.values(jev.asked[0].options).filter((d) => /Blue Kettle/.test(d)).length, 1);
  const step = r.stages[0].steps[0];
  for (const k of ["probe", "check", "observe", "jev", "act", "settle"]) assert.equal(typeof step.timings[k], "number", k);
});

test("three actions in a row with no page change -> stuck, and no-op elements are not offered again", async () => {
  const browser = fakeShop();
  const jev = fakeJev(byText(/Newsletter|Share|Print|Favorite/));
  const r = await runSpec({ browser, jev, spec: spec({ goal: "Subscribe", until: { text: "never" } }) });
  assert.equal(r.status, "stuck");
  assert.equal(r.counts.actions, 3);
  const clicked = browser.state.calls.filter((c) => c[0] === "act").map((c) => c[1].id);
  assert.equal(new Set(clicked).size, 3, "each no-op element was tried once");
  assert.equal(r.stages[0].steps[0].changed, false);
});

test("action budget -> budget", async () => {
  const browser = fakeShop();
  const jev = fakeJev(byText(/Next slide/));
  const r = await runSpec({ browser, jev, spec: spec({ goal: "Look at slides", until: { text: "never" } }), options: { maxActions: 4 } });
  assert.equal(r.status, "budget");
  assert.equal(r.counts.actions, 4);
});

test("Jev call budget -> budget", async () => {
  const browser = fakeShop();
  const jev = fakeJev(byText(/Next slide/));
  const r = await runSpec({ browser, jev, spec: spec({ goal: "Look at slides", until: { text: "never" }, budget: { jev: 2 } }) });
  assert.equal(r.status, "budget");
  assert.match(r.reason, /Jev call budget/);
  assert.equal(jev.asked.length, 2);
});

test("NONE -> blocked with a handover for Claude", async () => {
  const r = await runSpec({ browser: fakeShop(), jev: fakeJev(() => "NONE"), spec: spec({ goal: "Book a flight", until: { url: "/flight" } }) });
  assert.equal(r.status, "blocked");
  assert.match(r.reason, /NONE/);
  assert.ok(r.stages[0].handover.top.length > 0);
  assert.equal(r.counts.actions, 0);
});

test("low confidence -> blocked, nothing clicked", async () => {
  const browser = fakeShop();
  const r = await runSpec({ browser, jev: fakeJev(() => ({ choice: "e1", confidence: 0.1 })), spec: spec({ goal: "Something", until: { url: "/x" } }) });
  assert.equal(r.status, "blocked");
  assert.match(r.reason, /confidence 0.1 is below/);
  assert.equal(browser.state.calls.filter((c) => c[0] === "act").length, 0);
});

test("a window that stopped painting is reported, not judged", async () => {
  const jev = fakeJev(() => "e1");
  const r = await runSpec({ browser: fakeShop({ painting: false }), jev, spec: spec({ goal: "Open about", until: { url: "/about" } }) });
  assert.equal(r.status, "blocked");
  assert.match(r.reason, /window not rendering/);
  assert.equal(jev.asked.length, 0);
});

test("typed values come only from the test case, and the report names the input, not the value", async () => {
  const browser = fakeShop();
  const jev = fakeJev(byText(/type the test value/));
  const r = await runSpec({ browser, jev, spec: spec({ inputs: { search: "kettle\n" }, goal: "Search for the kettle", until: { text: "Results for kettle" } }) });
  assert.equal(r.status, "done");
  assert.equal(browser.state.searched, "kettle");
  const step = r.stages[0].steps[0];
  assert.equal(step.action.kind, "type");
  assert.equal(step.action.input, "search");
  assert.ok(!JSON.stringify(r).includes("kettle\\n"));
});

test("without a test value, text fields are not offered", async () => {
  const jev = fakeJev(() => "NONE");
  await runSpec({ browser: fakeShop(), jev, spec: spec({ goal: "Search", until: { url: "/x" } }) });
  assert.ok(!Object.values(jev.asked[0].options).some((d) => /Search/.test(d)));
});

test("a step timeout restarts the browser process and the run continues", async () => {
  const browser = fakeShop({ hangOn: { kind: "click", times: 1 } });
  const r = await runSpec({ browser, jev: fakeJev(byText(/About/)), spec: spec({ goal: "Open about", until: { url: "/about" } }) });
  assert.equal(r.status, "done");
  assert.equal(r.counts.restarts, 1);
  assert.match(r.stages[0].steps[0].error, /restarted/);
});

test("repeated timeouts -> blocked", async () => {
  const browser = fakeShop({ hangOn: { kind: "click", times: 10 } });
  const r = await runSpec({ browser, jev: fakeJev(byText(/About/)), spec: spec({ goal: "Open about", until: { url: "/about" } }) });
  assert.equal(r.status, "blocked");
  assert.match(r.reason, /timed out 3 times/);
});
