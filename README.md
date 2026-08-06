# delphi-agent

An autonomous trading agent for the [Gensyn Delphi Agent Arena](https://delphi.gensyn.ai)
competition (`competition-testnet`, LMSR prediction markets, TST collateral).
Consensus-first, forecast-as-fallback strategy; six opt-in signal/risk layers
on top of a conservative Kelly-sized risk gate. See
[STRATEGY.md](STRATEGY.md) for the reasoning and
[ARCHITECTURE.md](ARCHITECTURE.md) for the module map — both are local-only
(gitignored), generated for the operator's own reference.

**Runs in PAPER mode by default.** No on-chain transaction is ever sent
unless `AGENT_MODE=live` is explicitly set — see
["Switching to LIVE"](#switching-to-live) below before you do that.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- `DELPHI_API_ACCESS_KEY` — a **testnet** key from
  https://delphi-api-access.gensyn.ai/ (a mainnet key returns 401).
- `WALLET_PRIVATE_KEY` — required even to just read prices (see
  RULES.md §1 / ARCHITECTURE.md's gotchas — the SDK needs a signer for reads
  too). A loaded key is NOT itself permission to trade; only `AGENT_MODE=live`
  is.
- At least one LLM provider key if you want forecasting for markets with no
  external consensus reference (`GROQ_API_KEY` by default — free tier;
  `ANTHROPIC_API_KEY` or an OpenAI-compatible endpoint also supported, see
  the commented block in `.env.example`).
- Everything else has a documented, sensible default — leave it commented
  out unless you have a specific reason to change it.

```bash
npx tsc --noEmit     # typecheck
npm test              # 106 tests, should all pass
```

## Running in PAPER

```bash
npm run paper-run     # one pass + a synthetic-candidate demo, human-readable output
npm run loop-demo -- 3   # the real persistent loop, bounded to 3 ticks
npm run agent          # the real persistent loop, unbounded — same entrypoint deploy/ uses
```

`npm run agent` is the production entrypoint (`scripts/run-agent.ts`). It
never terminates on its own — stop it with Ctrl-C locally, or see
["Deploying on a VPS"](#deploying-on-a-vps) for always-on operation.

State persists to `state/agent-state.json` between runs (Layer A baselines,
forecast/structuring caches, token-usage window, portfolio, oracle
resolution log) — a restart resumes exactly where it left off. See
["Restart resumes state"](#restart-resumes-state) below for a real,
two-process/kill-and-restart proof of this, not just a claim.

Structured JSONL logs land in `logs/` (`decisions-YYYY-MM-DD.jsonl`,
`trades-YYYY-MM-DD.jsonl`) — enough to reconstruct every decision this agent
made. Secrets are redacted before anything is written (`src/logging/writer.ts`);
**the key/`.env` itself is never logged.**

## Secret handling

- `.env` (your real keys) is gitignored — never commit it.
- `.env.example` and `.env.production.example` hold only blank/placeholder
  values, safe to commit.
- `logs/` and `state/` are both gitignored (runtime output, not source).
- Structured logging redacts anything that looks like a private key or API
  key before writing (see `src/logging/writer.ts`'s `redact()`), as
  defense-in-depth on top of never intentionally logging a secret.

## Switching to LIVE

Do this deliberately, in order — not as a config toggle flipped casually:

1. **Fund the wallet.** See `.agents/skills/delphi/reference/funding.md` for
   the Sepolia ETH → Gensyn Testnet bridge steps, then mint testnet USDC
   (TST). This agent never touches a faucet or funds a wallet itself — that's
   an operator action.
2. **Register that exact wallet address** on DoraHacks with the SAME address
   `WALLET_PRIVATE_KEY` derives. A mismatched registration is a silent
   failure — trades land on-chain but never rank (RULES.md §1). This agent
   never performs DoraHacks registration itself.
3. **Turn on the layers you want live.** Every `*_ENABLED` flag defaults
   `false` — a straight copy of `.env.example` into production goes live
   with every Phase 4 layer OFF (bare pipeline only). Use
   `.env.production.example` as the reviewed starting profile, not
   `.env.example`.
4. **Validate a PAPER run against this exact config first.** Run
   `npm run agent` with `AGENT_MODE=paper` still set (everything else from
   your production `.env`) and read its decisions before flipping the last
   switch. Confirm the layer flags, thresholds, and forecast provider are
   what you intend.
5. **Only then set `AGENT_MODE=live`.** Every write path
   (`execution/paperTrade.ts`, `execution/settlementSweep.ts`) checks
   `isLive()` locally, at the point of the transaction — this is the one and
   only switch that permits an on-chain write (RULES.md §7).

The synthetic-candidate demo in `scripts/paper-run.ts` cannot run live even
by accident: it's fenced by an `isLive()` check AND is structurally
unreachable from `scripts/run-agent.ts` (the production entrypoint never
imports it — proven by `tests/liveEntryIsolation.test.ts`'s static
import-graph check, not just a runtime branch).

## Deploying on a VPS

Artifacts live in `deploy/`. This targets a Linux host with systemd (the
common case for a VPS); a pm2 ecosystem file would work equally well against
the same `scripts/run-agent.ts` entrypoint if you prefer that instead.

```bash
# On the VPS, as a dedicated non-root user for the app:
git clone <this repo> /opt/delphi-agent
cd /opt/delphi-agent
npm ci
cp .env.production.example .env
# edit .env: fill in DELPHI_API_ACCESS_KEY, WALLET_PRIVATE_KEY, GROQ_API_KEY —
# leave AGENT_MODE=paper (or set it explicitly) until you've completed the
# "Switching to LIVE" checklist above.

# Find your Node binary's absolute path (nvm shims aren't visible to systemd):
which node   # e.g. /home/delphi/.nvm/versions/node/v24.x.x/bin/node
```

Edit `deploy/delphi-agent.service`: set `User`, `WorkingDirectory`, and
`ExecStart`'s node path to match what you just found, then:

```bash
sudo cp deploy/delphi-agent.service /etc/systemd/system/
sudo cp deploy/delphi-agent-watchdog.service deploy/delphi-agent-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now delphi-agent.service
sudo systemctl enable --now delphi-agent-watchdog.timer
sudo systemctl status delphi-agent.service
journalctl -u delphi-agent -f   # tail logs
```

This starts the agent in **whatever `AGENT_MODE` your `.env` has** —
`.env.production.example`'s own template leaves it commented, defaulting to
PAPER, deliberately: the deploy scripts never assume LIVE. Only an operator
explicitly uncommenting `AGENT_MODE=live` (after the checklist above) goes
live.

### Auto-restart on crash

`delphi-agent.service` sets `Restart=always` — any crash or nonzero exit
gets systemd to restart the process (rate-limited via
`StartLimitIntervalSec`/`StartLimitBurst` so a true crash-loop doesn't spin
forever).

### The watchdog — the operational backstop for a wedged (not crashed) process

`Restart=always` only helps if the process actually exits. A process that's
still *running* but stuck (the retry-after class of hang fixed in Phase 5A,
or any not-yet-hardened fetch path — see ARCHITECTURE.md's gotchas) needs a
different backstop. `src/loop/heartbeat.ts` writes `state/heartbeat.json`
at frequent checkpoints — every loop tick boundary AND, inside a pass, after
every single market in the consensus/structuring/forecasting/decision loops
— not just once per whole pass. `deploy/watchdog.sh`, run every 5 minutes by
`delphi-agent-watchdog.timer`, checks that file's age; if it's stale beyond
`WATCHDOG_MAX_STALL_SECONDS` (default 1800s / 30 min — comfortably above the
bounded worst case of a single pass under sustained rate-limiting, roughly
10-15 minutes with the Phase 5A retry-after cap), it hard-restarts
`delphi-agent.service`.

Verified locally (dry-run, no real systemd unit needed for this check):

```
$ DELPHI_AGENT_DIR=/tmp/watchdog-test DRY_RUN=1 WATCHDOG_MAX_STALL_SECONDS=1800 bash deploy/watchdog.sh
[watchdog] heartbeat age: 0s (max allowed: 1800s)
[watchdog] OK

$ # (heartbeat file backdated 1 hour)
$ DELPHI_AGENT_DIR=/tmp/watchdog-test DRY_RUN=1 WATCHDOG_MAX_STALL_SECONDS=1800 bash deploy/watchdog.sh
[watchdog] heartbeat age: 3600s (max allowed: 1800s)
[watchdog] STALE (dry run) — would run: systemctl restart delphi-agent

$ # (no heartbeat file — fresh deploy)
$ DELPHI_AGENT_DIR=/tmp/watchdog-test DRY_RUN=1 bash deploy/watchdog.sh
[watchdog] no heartbeat file yet at /tmp/watchdog-test/state/heartbeat.json — agent may still be starting, not restarting
```

### Restart resumes state

This is the whole point of pairing a watchdog with persistence — a
kill-triggered restart must not lose Layer A baselines, caches, the token
budget window, or the portfolio. Proven two ways:

1. **Two genuinely separate processes** (`scripts/demo-persistence-restart.ts`)
   — see the Checkpoint 5A report for the full transcript: a `write` process
   exits completely, a fresh `read` process reloads everything from
   `state/agent-state.json`.
2. **The real production entrypoint, killed and restarted**, exactly as the
   watchdog would do it — `kill -9` (not a graceful stop, since the
   watchdog's whole point is recovering from a process that ISN'T shutting
   down cleanly), then a fresh `node --import tsx/esm scripts/run-agent.ts`.
   See the Checkpoint 5B report for this run's raw output.

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) (gitignored, local reference) for the
full module map and data flow. Top level:

```
src/            application code (config, markets, signals, layers, risk,
                execution, portfolio, persistence, loop, logging)
scripts/        entrypoints — run-agent.ts (production), paper-run.ts
                (diagnostic/demo), run-loop-demo.ts, healthcheck.ts, etc.
deploy/         systemd unit + watchdog script/timer
tests/          node:test suite (npx tsx --test)
```

## Local docs (gitignored — not tracked, for your own reference)

- [ARCHITECTURE.md](ARCHITECTURE.md) — module map, data flow, live-API
  gotchas discovered along the way.
- [RULES.md](RULES.md) — every hard constraint and exactly how the code
  enforces it.
- [STRATEGY.md](STRATEGY.md) — the thesis and reasoning, written for a human
  evaluator.
