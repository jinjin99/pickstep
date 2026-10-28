# pickstep

Fast browser tests where **Claude Code plans**, **TypeSafe's Jev picks each step**, and **ego lite drives the browser**.

Claude is good at turning "can a shopper put a hammer in the cart and reach checkout?" into a test case. It is slow at the inner loop, though: every look-click-look round trip through a large model costs seconds. pickstep hands that inner loop to [Jev](https://docs.typesafe.ai/introduction), a System One model that answers "which of these numbered elements next?" in about half a second. Completion is checked by code, never by a model.

```
Claude Code ──writes──▶ spec: stages (goal + until), inputs, budget
                          │
                    pickstep run   (one ego-browser process per run)
                          │
     ┌─▶ render probe ─▶ until met? ─▶ observe ─▶ Jev picks ─▶ act ─▶ settle ─┐
     └────────────────────────────────────────────────────────────────────────┘
                          │
        done / budget / stuck / blocked + report.json, report.html
                          │
Claude Code ◀── reads the report; takes over on NONE or low confidence
```

## Demo

Public practice shop [practicesoftwaretesting.com](https://practicesoftwaretesting.com) (made for testing tools), spec [`examples/toolshop.yaml`](examples/toolshop.yaml): open the Thor Hammer product page → add it to the cart → open the cart.

```bash
pickstep run --spec examples/toolshop.yaml
```

Measured on 2026-10-28 on a MacBook with ego lite 0.6.1.13 (Chromium 156) and `jev-latest` (answered by `jev-1.14.0`), 5 runs in a row:

| | result |
| --- | --- |
| status | **done** in 5 of 5 runs, 3 actions and 3 Jev calls each |
| wall time, whole command | **median 11.2 s** (10.8, 11.1, 11.2, 11.4, 20.0 s) |
| browser session start (one `ego-browser nodejs` process) | median 0.35 s |
| open start page (goto + settle) | median 1.7 s |
| stage 1 / 2 / 3 | median 3.2 s / 3.8 s / 2.3 s |
| Jev confidence, stage 1 / 2 / 3 | 0.64–0.75 / 0.80–0.85 / 0.49–0.64 |

Median per step, over all 15 steps:

| render probe | `until` check | observe | Jev | act (click) | settle | screenshot | whole step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 13 ms | 3 ms | 5 ms | 335 ms | 1.18 s | 1.40 s | 158 ms | 3.07 s |

The two waits dominate:

- **settle** waits for the DOM to stop changing *and* the network to go idle, capped at 3 s each. In the 20 s run the network never went idle and every settle hit the cap.
- **act** is almost all browser input latency. On this site the first synthetic mouse event after scrolling to a new target reaches the page about 1 s after it is dispatched (10 of 15 clicks; the others took 10–40 ms). The page's main thread is idle while this happens: no long tasks, and the page sees the event about 970 ms late. ego's own `page.click` has the same delay on this page (about 1.0 s from click to URL change, versus 1.2 s for the CDP path including the 120 ms position-stability wait). On a simple page the same events take 10–60 ms.

## Requirements

- macOS with [ego lite](https://lite.ego.app/) installed, so the `ego-browser` CLI is on your `PATH` (or at `~/.local/bin/ego-browser`, or set `PICKSTEP_EGO_BIN`).
- Node.js 20 or newer.
- A TypeSafe API key in the environment as `TYPESAFE_API_KEY` (from the [TypeSafe console](https://console.typesafe.ai)). pickstep reads it from the environment only; never put it in a spec, a file or a command line.

## Install

```bash
git clone https://github.com/jinjin99/pickstep.git
cd pickstep
npm install
npm link              # puts `pickstep` on your PATH
pickstep doctor       # checks ego-browser, the key, and one Jev call
```

Install the Claude Code skill so Claude knows when and how to use it:

```bash
mkdir -p ~/.claude/skills && cp -r skill/pickstep ~/.claude/skills/
```

Then ask Claude Code something like "test that a shopper can add the Thor Hammer to the cart on practicesoftwaretesting.com". It writes a spec, runs `pickstep run`, and reads the report.

## Usage

```bash
# one stage, no file
pickstep run --url https://practicesoftwaretesting.com/ \
  --goal "Open the product page of the Thor Hammer" --until url:/product/

# several stages from YAML or JSON
pickstep run --spec examples/toolshop.yaml --report ./reports/toolshop

# low-level commands on a persistent session (what Claude uses when Jev hands back)
pickstep act goto https://practicesoftwaretesting.com/
pickstep observe                       # numbered, visible elements
pickstep act click 19                  # CDP click on element 19, prints the new page
pickstep act type 17 --value 2         # values come from the test case or the user
pickstep act select 8 --value M
pickstep step --goal "Add this product to the shopping cart"   # one Jev-chosen step
pickstep finish                        # close the task space
```

`--until` takes `text:<words>`, `url:<fragment>` or `js:<expression>`; repeat it for "any of". Exit codes: 0 done, 2 budget, 3 stuck, 4 blocked, 1 error.

### Spec format

```yaml
name: Add a hammer to the cart
url: https://practicesoftwaretesting.com/   # opened before stage 1
inputs:                                      # the only values pickstep types or selects
  search: "hammer\n"                         # trailing \n presses Enter
budget: { actions: 15, jev: 20 }             # whole run
stages:
  - goal: Open the product page of the Thor Hammer
    until: { url: /product/, text: Thor Hammer }       # one condition: all keys must hold
  - goal: Add this product to the shopping cart
    until:
      js: document.querySelector('[data-test=cart-quantity]')?.textContent.trim() === '1'
  - goal: Open the shopping cart
    maxActions: 5                                       # optional per-stage cap
    until: [{ url: /checkout }, { text: Your cart }]    # a list: any one is enough
```

`js:` conditions run in the page exactly as written, so only run specs you trust.

### Results

Every run writes `report.json` and `report.html` (plus `shots/*.png`) to `./pickstep-reports/<time>/` or `--report <dir>`: each step's action and how it was performed (CDP click, after closing an overlay, direct navigation, DOM click), Jev's choice with confidence and runner-ups, the screenshot, and the time spent in each phase: probe, check, observe, Jev, act, settle, screenshot.

| status | meaning |
| --- | --- |
| `done` | every stage's `until` held |
| `budget` | the action or Jev-call budget ran out |
| `stuck` | three actions in a row changed nothing on the page |
| `blocked` | Jev said NONE or was unsure, the window stopped rendering, the browser process timed out repeatedly, or Jev failed |

## How it works

**One browser process per run.** `pickstep run` starts a single `ego-browser nodejs` process. Inside it, a small driver holds one ego task space and answers HTTP requests on a Unix socket in a private temporary directory (0700). Commands are request/response; nothing travels through stdout, because ego's stdout folds long lines. A few details:

- `ego-browser nodejs` waits for stdin even with `-e`, so the driver program is written to its stdin.
- The embedded Node does not see the parent's environment, so start parameters go through a 0600 file that the driver deletes after reading. The TypeSafe key never enters the browser process; Jev is called from the host.
- The embedded Node is a helper shared with other ego scripts, and killing the `ego-browser` CLI does not stop a running script. So the driver never calls `process.exit()`. It stops by closing its server: on `finish`, after N idle minutes (default 10), on an `abort` from the host, or when it sees the CLI process die.
- When a command times out, the host aborts and kills that process. The next command starts a new one, which reopens the same task space by name and keeps the page as it was.

The low-level commands (`observe`, `act`, `step`) reuse a named session across separate CLI invocations in the same way.

**Observation.** A `page.evaluate` walks the DOM, including open shadow roots, and numbers each interactive element with a `data-pickstep-id` attribute. It does not use the accessibility snapshot, because clickable elements without a role often get no ref there. An element is kept only if it is really shown:

- It is dropped if it is on screen but has a transparent ancestor (a collapsed menu), if it lies outside the viewport to the left or right, or if an `overflow: hidden`/`clip` ancestor cuts it off.
- A transparent element *below* the fold is kept, because many themes fade cards in when they are scrolled to.
- Duplicate link+text pairs are merged. At most 120 elements are kept, the ones on screen first.

**Clicking.** pickstep scrolls the element to the centre and waits until its box and the URL are stable. It then hit-tests a few points with `elementFromPoint` (shadow-aware) and sends `mouseMoved` / `mousePressed` / `mouseReleased` through `page.cdp("Input.dispatchMouseEvent")`. If the element is covered, it closes overlays: cookie banners always get the reject/necessary-only choice, and marketing popups get closed. Then it tries the click once more. If the element is still covered, a same-origin link is opened directly, and anything else gets a DOM `click()`. `target=_blank` links stay in the same tab. Drop-downs use `page.selectOption`. Typed values come only from the spec's `inputs`, never from a model.

**Deciding.** Every step is one `POST https://api.typesafe.ai/v1/systemone` with `{ model, state, questions }`. The state holds the goal, URL, title, headings, open dialogs and recent actions. There is a single `choice` question whose options are the numbered elements plus `NONE`. The answer must be one of those options, and the request times out after 15 s (429/5xx are retried). There is deliberately **no DONE option**: models misjudge completion, for example by taking an "Added to cart" toast for an open cart, so completion is the spec's `until`, checked by code. Elements whose last click changed nothing are left out of the next question.

**Not judging a page that is not painting.** On macOS, Chromium stops painting when the display sleeps, the screen locks or the window is covered. Screenshots then hang and animations freeze, which produces wrong verdicts. Before every step pickstep checks that `requestAnimationFrame` fires (bringing the tab to the front once if needed). If it does not fire, the run ends as `blocked: window not rendering` instead of failing the test. Screenshots give up after 10 s and record why.

## Comparing with Claude driving the browser itself

The interesting question is whether Claude Code plus pickstep is faster than Claude Code driving ego lite itself, one look-think-click round at a time. To compare on your own pages:

1. Write the flow as a spec and run it a few times, taking the median of the `wall time` line:
   ```bash
   for i in 1 2 3 4 5; do pickstep run --spec my-flow.yaml | grep "wall time"; done
   ```
2. In a fresh Claude Code session (with the ego-browser skill and *without* pickstep), give Claude the same goals and the same completion checks. For example: "Using ego-browser, open https://practicesoftwaretesting.com/, open the Thor Hammer product page, add it to the cart, and open the cart (/checkout). Stop when the URL contains /checkout." Measure from sending the prompt to Claude's final answer, and count the `ego-browser` rounds.
3. Compare wall time, rounds, and how many tokens of page snapshots Claude had to read. With pickstep, Claude reads one short summary instead.

What I measured for the demo flow above:

| | wall time | browser rounds | page text read by Claude |
| --- | --- | --- | --- |
| pickstep (`run --spec examples/toolshop.yaml`) | **11.2 s** median of 5 | 1 process for the run | 7-line summary + report |
| Claude driving ego lite itself, step by step | 18.5 s, once | 5 `ego-browser nodejs` rounds (1 wasted on an ambiguous selector) | 3 accessibility snapshots, roughly 18 KB of text |

The step-by-step run is a favourable case for Claude: it was done by a Claude that had already explored this site, knew the cart-count selector, and used the ego skill's batching advice (act, wait, then snapshot in one round). Unfamiliar pages need more rounds and more thinking per round. The gap grows with the number of steps, because each pickstep step costs about 0.35 s of Jev plus the page's own latency, while each Claude round costs model time plus a new `ego-browser` process.

## Tests

```bash
npm test          # unit tests: no browser, no network
npm run test:ego  # checks observation and clicking against the real ego lite on a local tricky page
```

The unit tests run the whole loop on a local fake shop with a fake Jev (done, stuck, budget, NONE, low confidence, not rendering, timeouts and restarts, typed inputs). They also test the persistent session against a fake `ego-browser` binary that reads the program from stdin and serves the socket named in the start file (one process for many commands, reuse across invocations, restart after a timeout, idle exit, 0600/0700 permissions). There are also tests for the driver's click fallbacks, the Jev client against a local HTTP server, spec validation and HTML escaping.

## License

MIT
