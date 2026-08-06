import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/loop/finalizedLoop.js";

test("withRetry — succeeds immediately without retrying when fn succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      return "ok";
    },
    { maxRetries: 3, baseDelayMs: 1, sleep: async () => {} }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry — retries on failure and eventually succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "recovered";
    },
    { maxRetries: 5, baseDelayMs: 1, sleep: async () => {} }
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 3);
});

test("withRetry — exhausts retries and throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} }
      ),
    /fail 3/
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
});

test("withRetry — calls onRetry with the attempt number and error, not on the final failed attempt", async () => {
  const retries: number[] = [];
  await assert.rejects(() =>
    withRetry(
      async () => {
        throw new Error("nope");
      },
      { maxRetries: 2, baseDelayMs: 1, sleep: async () => {}, onRetry: (attempt) => retries.push(attempt) }
    )
  );
  assert.deepEqual(retries, [1, 2]); // 2 retries logged; the 3rd (final) failure just throws, no onRetry call
});

test("withRetry — backs off exponentially (delay doubles each retry)", async () => {
  const delays: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls < 4) throw new Error("transient");
      return "ok";
    },
    {
      maxRetries: 5,
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }
  );
  assert.deepEqual(delays, [100, 200, 400]);
});
