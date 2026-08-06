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
 */
function timeoutRejection(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("fetch-hard-timeout")), ms));
}

export async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number, init?: RequestInit): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeoutRejection(timeoutMs)]);
    if (!res.ok) return null;
    return await Promise.race([res.json(), timeoutRejection(timeoutMs)]);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
