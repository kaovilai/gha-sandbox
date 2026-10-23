// Deterministic pacing. MOCK_PACE=fast|real|slow, MOCK_SEED=<int> (seeded PRNG, never Math.random).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROFILES = {
  // chunkWords: words per streamed chunk; chunkMs: delay between chunks; toolMs: delay around tool calls
  fast: { chunkWords: 10_000, chunkMs: 0, jitter: 0, toolMs: 0 },
  real: { chunkWords: 4, chunkMs: 40, jitter: 15, toolMs: 450 },
  slow: { chunkWords: 2, chunkMs: 120, jitter: 40, toolMs: 1200 },
};

export function makePace(env = process.env) {
  const name = PROFILES[env.MOCK_PACE] ? env.MOCK_PACE : "real";
  const p = PROFILES[name];
  const rnd = mulberry32(Number(env.MOCK_SEED ?? 1));
  return {
    name,
    chunkWords: p.chunkWords,
    chunkMs(override) {
      if (name === "fast") return 0;
      if (override != null) return override;
      return Math.max(0, Math.round(p.chunkMs + (rnd() * 2 - 1) * p.jitter));
    },
    toolMs: p.toolMs,
  };
}

export function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    if (!(ms > 0)) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
