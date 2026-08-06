import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, appendJsonLine } from "../src/logging/writer.js";

test("redact — masks a 0x private-key-shaped hex string", () => {
  const text = `WALLET_PRIVATE_KEY=0x${"a".repeat(64)} rest of line`;
  const result = redact(text);
  assert.ok(!result.includes("a".repeat(64)));
  assert.ok(result.includes("[REDACTED]"));
});

test("redact — masks a Groq-shaped API key", () => {
  const text = "GROQ_API_KEY=gsk_" + "x".repeat(30);
  const result = redact(text);
  assert.ok(!result.includes("gsk_" + "x".repeat(30)));
  assert.ok(result.includes("[REDACTED]"));
});

test("redact — leaves ordinary text (market addresses, questions) untouched", () => {
  const text = JSON.stringify({ marketAddress: "0x4de9db1b4c717cadc14b1001ea70f7f0bb9cf3c7", question: "Will X happen?" });
  assert.equal(redact(text), text);
});

test("appendJsonLine — writes valid, parseable JSONL to a per-kind, per-day file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delphi-agent-logging-test-"));
  try {
    await appendJsonLine("decisions", { a: 1 }, dir);
    await appendJsonLine("decisions", { a: 2 }, dir);

    const today = new Date().toISOString().slice(0, 10);
    const raw = await readFile(join(dir, `decisions-${today}.jsonl`), "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ a: 1 }, { a: 2 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendJsonLine — redacts a secret if one somehow ends up in a logged object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delphi-agent-logging-test-"));
  try {
    await appendJsonLine("decisions", { leaked: "0x" + "b".repeat(64) }, dir);
    const today = new Date().toISOString().slice(0, 10);
    const raw = await readFile(join(dir, `decisions-${today}.jsonl`), "utf8");
    assert.ok(!raw.includes("b".repeat(64)));
    assert.ok(raw.includes("[REDACTED]"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
