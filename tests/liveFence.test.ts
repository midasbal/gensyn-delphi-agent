/**
 * Proves the mechanism scripts/paper-run.ts's synthetic-candidate fence
 * depends on (`isLive()`) actually flips correctly under AGENT_MODE=live —
 * via a subprocess, since config/index.ts reads process.env.AGENT_MODE at
 * module-load time (it must, to stay a frozen, tamper-resistant constant
 * for the rest of the process's life — see config/index.ts's header
 * comment on why a loaded signer key must never be inferred as "safe to
 * trade").
 *
 * Deliberately does NOT run scripts/paper-run.ts itself with AGENT_MODE=live
 * — that script's real per-market pass could reach a live buyShares call if
 * a candidate ever cleared every gate, and running that against a real
 * wallet without explicit user confirmation is exactly the kind of
 * hard-to-reverse action these tests must never risk, even against an
 * unfunded testnet wallet. This test only imports config/index.ts in
 * isolation — no chain interaction possible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function isLiveUnderMode(agentMode: string): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", "import { isLive, isPaper } from './src/config/index.js'; console.log(JSON.stringify({ isLive: isLive(), isPaper: isPaper() }));"],
    { env: { ...process.env, AGENT_MODE: agentMode }, cwd: process.cwd() }
  );
  return stdout.trim();
}

test("live fence mechanism — AGENT_MODE=paper (default): isLive() is false", async () => {
  const result = JSON.parse(await isLiveUnderMode("paper"));
  assert.equal(result.isLive, false);
  assert.equal(result.isPaper, true);
});

test("live fence mechanism — AGENT_MODE=live: isLive() correctly flips true (this is what the paper-run.ts synthetic fence checks)", async () => {
  const result = JSON.parse(await isLiveUnderMode("live"));
  assert.equal(result.isLive, true);
  assert.equal(result.isPaper, false);
});

test("live fence mechanism — an invalid AGENT_MODE throws at startup rather than silently defaulting", async () => {
  await assert.rejects(() => isLiveUnderMode("definitely-not-a-real-mode"));
});
