import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeartbeat, readHeartbeat, heartbeatAgeMs } from "../src/loop/heartbeat.js";

async function withTempHeartbeatFile(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "delphi-agent-heartbeat-test-"));
  const path = join(dir, "heartbeat.json");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeHeartbeat/readHeartbeat — round-trips label and timestamp through the real atomic writer", async () => {
  await withTempHeartbeatFile(async (path) => {
    await writeHeartbeat("tick-start:cadence", path, 1_000_000);
    const beat = await readHeartbeat(path);
    assert.deepEqual(beat, { timestampMs: 1_000_000, label: "tick-start:cadence" });
  });
});

test("readHeartbeat — no file yet (fresh deploy) returns null, not an error", async () => {
  await withTempHeartbeatFile(async (path) => {
    const beat = await readHeartbeat(path);
    assert.equal(beat, null);
  });
});

test("writeHeartbeat — a later write overwrites the earlier one (watchdog only ever sees the latest)", async () => {
  await withTempHeartbeatFile(async (path) => {
    await writeHeartbeat("consensus:0xabc", path, 1_000_000);
    await writeHeartbeat("structure:0xdef", path, 1_000_500);
    const beat = await readHeartbeat(path);
    assert.deepEqual(beat, { timestampMs: 1_000_500, label: "structure:0xdef" });
  });
});

test("heartbeatAgeMs — null beat (no heartbeat ever written) is Infinity, so a fresh-boot watchdog check can't misread it as fresh", () => {
  assert.equal(heartbeatAgeMs(null, 5000), Infinity);
});

test("heartbeatAgeMs — computes elapsed time against an injected clock", () => {
  const beat = { timestampMs: 1_000_000, label: "x" };
  assert.equal(heartbeatAgeMs(beat, 1_030_000), 30_000);
});
