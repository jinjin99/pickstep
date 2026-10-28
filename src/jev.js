// Minimal client for TypeSafe's System One endpoint (Jev).
// Docs: https://docs.typesafe.ai/api/system-one

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export function createJev({
  apiKey = process.env.TYPESAFE_API_KEY,
  model = process.env.PICKSTEP_JEV_MODEL || "jev-latest",
  baseUrl = process.env.PICKSTEP_JEV_URL || "https://api.typesafe.ai",
  timeoutMs = 15_000,
  retries = 2,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new JevError("TYPESAFE_API_KEY is not set");
  const endpoint = new URL("/v1/systemone", baseUrl).href;

  /**
   * Ask one choice question. `options` maps option names to descriptions.
   * The answer is rejected unless it names one of the options.
   */
  async function choose({ state, instructions, options }) {
    const names = Object.keys(options);
    if (names.length < 1 || names.length > 255) throw new JevError(`a choice needs 1-255 options, got ${names.length}`);
    const body = JSON.stringify({
      model,
      state,
      questions: { next: { type: "choice", instructions, criteria: options } },
    });
    const t0 = Date.now();
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 250 * 3 ** (attempt - 1)));
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        lastErr = new JevError(e.name === "TimeoutError" ? `Jev did not answer within ${timeoutMs} ms` : `Jev request failed: ${e.message}`);
        if (e.name === "TimeoutError") throw lastErr;
        continue;
      }
      if (RETRYABLE.has(res.status)) {
        lastErr = new JevError(`Jev returned HTTP ${res.status}`, res.status);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new JevError(`Jev returned HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new JevError("Jev returned invalid JSON");
      }
      const a = parsed?.answers?.next;
      if (!a || a.type !== "choice" || typeof a.choice !== "string") throw new JevError("Jev response has no choice answer");
      if (!Object.hasOwn(options, a.choice)) throw new JevError(`Jev chose "${a.choice}", which is not one of the options`);
      return {
        choice: a.choice,
        confidence: typeof a.confidence === "number" ? a.confidence : null,
        probabilities: a.probabilities || {},
        model: parsed.model,
        usage: parsed.usage,
        ms: Date.now() - t0,
      };
    }
    throw lastErr;
  }

  return { choose, model };
}
