/**
 * Shared hard-timeout-backstopped JSON fetch helper.
 *
 * Cleanup pass (closing the known gap from the Phase 5B checkpoint report):
 * src/signals/forecasting/llmClient.ts's `fetchWithBackoff` was hardened
 * against a real, observed failure mode — `AbortController.abort()` not
 * reliably unblocking an in-flight `fetch()` or a stalled `res.json()` body
 * read — by racing both against an independent timer. The three consensus
 * adapters (polymarket.ts, sportsOdds.ts, crypto.ts) each had their own
 * near-identical `fetchJson<T>` helper using ONLY `AbortController`, without
 * that same backstop — this file is the one shared implementation all three
 * now use, so the fix (and any future one) lives in one place.
 *
 * Behavior-preserving: same contract as the three duplicated helpers this
 * replaces — returns `null` on any failure (non-ok status, network error,
 * timeout, malformed JSON), never throws. No retry/backoff logic here (that
 * stays llmClient.ts-specific, driven by 429 handling this file's callers
 * don't need).
 *
 * Fix 2 hardening: the original version's timeout timer was never cleared
 * when the real operation won the race (only the AbortController's own
 * timer was) — a harmless leak normally, but it surfaced as a real problem
 * once llmClient.ts's own timeout was raised to 45s (Fix 2, part a): every
 * fast-resolving stubbed call in tests left a dangling ~45s timer keeping
 * the process alive, tripling this project's test-suite wall-clock time.
 * `raceWithTimeout` below always clears its timer via `finally`, regardless
 * of which side of the race settles first.
 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("fetch-hard-timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number, init?: RequestInit): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await raceWithTimeout(fetch(url, { ...init, signal: controller.signal }), timeoutMs);
    if (!res.ok) return null;
    return await raceWithTimeout(res.json(), timeoutMs);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
