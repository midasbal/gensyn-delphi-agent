/**
 * Pins fetchJsonWithTimeout's contract against the three near-identical
 * `fetchJson<T>` helpers it replaces in polymarket.ts/sportsOdds.ts/
 * crypto.ts — same behavior for every case those files relied on (ok status
 * -> parsed JSON, non-ok -> null, network error -> null), PLUS the new hard
 * timeout backstop (the actual bug fix from the cleanup pass): a fetch that
 * never resolves must still return null within the timeout window, not hang
 * forever, exactly like llmClient.ts's fetchWithBackoff.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJsonWithTimeout } from "../src/util/fetchJson.js";

async function withStubbedFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

test("fetchJsonWithTimeout — ok response returns the parsed JSON body", async () => {
  await withStubbedFetch(
    (async () => jsonResponse(200, { hello: "world" })) as typeof fetch,
    async () => {
      const result = await fetchJsonWithTimeout<{ hello: string }>("https://example.test/x", 1000);
      assert.deepEqual(result, { hello: "world" });
    }
  );
});

test("fetchJsonWithTimeout — non-ok status returns null, same as the old per-file fetchJson helpers", async () => {
  await withStubbedFetch(
    (async () => jsonResponse(500, { error: "boom" })) as typeof fetch,
    async () => {
      const result = await fetchJsonWithTimeout("https://example.test/x", 1000);
      assert.equal(result, null);
    }
  );
});

test("fetchJsonWithTimeout — a rejected fetch (network error) returns null, never throws", async () => {
  await withStubbedFetch(
    (async () => {
      throw new Error("network down");
    }) as typeof fetch,
    async () => {
      const result = await fetchJsonWithTimeout("https://example.test/x", 1000);
      assert.equal(result, null);
    }
  );
});

test("fetchJsonWithTimeout — malformed JSON body returns null, never throws", async () => {
  await withStubbedFetch(
    (async () => new Response("not json{{{", { status: 200 })) as typeof fetch,
    async () => {
      const result = await fetchJsonWithTimeout("https://example.test/x", 1000);
      assert.equal(result, null);
    }
  );
});

test("fetchJsonWithTimeout — a fetch() that never resolves still returns null within the timeout (the actual hard-timeout backstop fix)", async () => {
  await withStubbedFetch(
    (() => new Promise<Response>(() => {})) as typeof fetch, // never resolves, simulating the observed AbortController-doesn't-help hang
    async () => {
      const start = Date.now();
      const result = await fetchJsonWithTimeout("https://example.test/x", 200);
      const elapsed = Date.now() - start;
      assert.equal(result, null);
      assert.ok(elapsed < 1000, `expected the hard timeout to fire well under 1s, took ${elapsed}ms`);
    }
  );
});

test("fetchJsonWithTimeout — an ok response whose .json() never resolves still returns null within the timeout", async () => {
  await withStubbedFetch(
    (async () => {
      const res = new Response("{}", { status: 200 });
      res.json = () => new Promise(() => {}); // stalled body read, same failure mode as llmClient.ts's res.json() finding
      return res;
    }) as typeof fetch,
    async () => {
      const start = Date.now();
      const result = await fetchJsonWithTimeout("https://example.test/x", 200);
      const elapsed = Date.now() - start;
      assert.equal(result, null);
      assert.ok(elapsed < 1000, `expected the hard timeout to fire well under 1s, took ${elapsed}ms`);
    }
  );
});
