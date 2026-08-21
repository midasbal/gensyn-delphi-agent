# delphi-agent

An autonomous trading agent for the [Gensyn Delphi Agent Arena](https://delphi.gensyn.ai)
competition (`competition-testnet`, LMSR prediction markets, TST collateral).

**Runs in PAPER mode by default.** No on-chain transaction is ever sent
unless `AGENT_MODE=live` is explicitly set. See
["Switching to LIVE"](#switching-to-live) below before you do that.

## What this is

This is an autonomous agent built to compete in the Gensyn Delphi Agent
Arena, a competition where agents trade on-chain prediction markets and are
ranked purely on profit and loss over a two-week window. Nothing about
appearance, code style, or cleverness is judged directly; the only thing
that matters is whether the agent's trades made money. This repo is that
agent: its market-reading pipeline, its risk controls, and the
infrastructure to run it unattended.

> **A note for reviewers.** The competition is over. The agent ran live,
> traded as engineered, and lost money. Everything from here through
> ["Design principles"](#design-principles) describes the intent going in.
> The [Retrospective](#retrospective) below is the measured outcome,
> written after the fact with no softening. If you only read one section,
> read that gap between intent and outcome, that's the point of this repo.

## The problem, and the reasoning behind the approach

Strip away the blockchain mechanics and the competition is a forecasting
problem. Delphi's markets use LMSR (a logarithmic market scoring rule):
each outcome has a price between 0 and 1, prices across a market's outcomes
sum to 1, and a winning outcome's share pays exactly 1 TST at settlement.
That price *is* the market's current implied probability. So the expected
profit from buying a share is simply your estimate of the true probability
minus the current price, what this codebase calls "edge." Get the estimate
right more often than the market does, size positions sensibly, and the
expected value compounds. Get it wrong, systematically, and it doesn't
matter how well-engineered the rest of the system is.

That framing shaped the central design decision. The obvious, easy build is
an "LLM oracle": point a language model at every market's question and
trade whatever probability it returns. That's also the build most other
entrants are likely to reach for, since it's the path of least resistance.
Two problems follow from that. First, an LLM's raw guess is an unreliable
foundation to bet real capital on. It isn't grounded in any live reference
market, it can't distinguish genuine insight from confident-sounding
pattern completion, and there's no obvious way to know when to trust it.
Second, if most competitors are running some version of the same "ask the
model" strategy, that alone isn't a source of edge. Everyone doing the
same thing pushes prices toward whatever the models collectively agree on,
which then stops being mispriced.

The approach this agent takes instead: wherever a sharper, more liquid
external reference for the same real-world event already exists (a
Polymarket market, a sportsbook's odds, a live asset price), treat that
market's own price discovery as the better estimate, and let this agent be
a **consensus arbitrageur**, checking whether Delphi's price has caught up
to what's already known elsewhere. Only when no such reference exists does
the agent fall back to being a **disciplined forecaster**, spending an LLM
call and treating the result with appropriate skepticism rather than
uncritical trust. Consensus-following is lower-variance and easier to
defend than independent forecasting. Forecasting is the tool for the markets
nothing else prices, not the primary edge source.

## What the bot actually does

At a high level, each pass through the pipeline:

1. **Pulls open markets** from the Delphi API for the current competition.
2. **Parses each market's resolution criteria**: what specifically has to
   happen for an outcome to be declared the winner, and by when.
3. **Estimates a probability** for each outcome, checking first for a
   confident external consensus reference, and only spending an LLM
   forecast on markets where no such reference exists.
4. **Passes every candidate through a risk gate**, in order: is the signal
   confident enough to act on at all; is the resolution criteria itself too
   ambiguous to trust; is the edge large enough to be worth acting on; is
   the price near an extreme (0 or 1) where caution should tighten; how
   large a position does conservative, fractional-Kelly sizing justify; and
   does the market have enough depth to fill that size without excessive
   slippage. Any step can skip or shrink a trade, never expand or force one
   through.
5. **Only then trades**, booked as a simulated fill in PAPER mode, or a
   real on-chain transaction in LIVE mode, depending on `AGENT_MODE`.

On top of that core pipeline sit six additional, individually toggleable
signal/risk layers. Each is described here at the level of *what it's for*.
The specific thresholds and tuning live in a private strategy document,
deliberately kept out of this public README while the competition is live.
In practice, live behavior was dominated by the core pipeline and the
forecasting path; several of these layers fired rarely or not at all over
the competition window. See the [Retrospective](#retrospective):

- **Latency**: notices when an external reference has moved since this
  agent last acted on a market, so it can prioritize re-checking markets
  most likely to have gone stale, rather than working through all of them
  in a fixed order.
- **Long-tail routing**: recognizes markets that are both un-referenced
  and largely untraded, and prioritizes them for deeper research, on the
  theory that the least-priced-in markets are where the most edge remains.
- **Cross-market coherence**: checks whether two different markets that
  describe the same real-world event are pricing it consistently, and can
  act when a genuine, real disagreement between them appears.
- **Opponent modeling**: reads public on-chain trade activity for
  corroborating signal, never as a signal on its own and never from
  anything other than public data.
- **Oracle calibration**: assesses how cleanly a market's resolution
  criteria will actually settle, so ambiguous markets get treated with
  appropriately less confidence.
- **Live calibration and endgame sizing**: intended, once real resolutions
  and a real leaderboard position exist, to check whether the agent's
  stated confidence has actually been trustworthy and to adjust risk
  appetite as the competition window closes.

## Design principles

A few values are visible throughout the codebase, independent of any
specific tactic:

- **PAPER-first, with a hard gate to LIVE.** The agent defaults to
  simulated trading and stays there until an operator explicitly and
  deliberately flips one switch. See ["Switching to LIVE"](#switching-to-live).
- **Rules-compliance enforced in code, not just policy.** Constraints like
  trading from a single wallet, using only public data for opponent
  modeling, and never trading purely to move price are structural
  properties of how the code is written, not conventions an operator has to
  remember to follow.
- **Honest degradation over fabrication.** A missing API key, an
  unconfigured signal source, or no confident match returns `null` and is
  treated as "no information here," never a guessed or fabricated number
  standing in for a real one.
- **Persistence, so a restart isn't a reset.** State survives a process
  restart. A deployment doesn't lose track of what it already knows.
- **Self-healing, so it doesn't need a human on call.** A watchdog process
  detects a stuck (not just crashed) agent and restarts it automatically.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map and data flow,
and [RULES.md](RULES.md) for the complete list of hard constraints and
exactly how each is enforced (both gitignored, local reference, see
["Local docs"](#local-docs-gitignored--not-tracked-for-your-own-reference)
below).

## Retrospective

*Written after the competition concluded, from measured results, not
memory of intent.*

### What we set out to achieve

Build an agent whose edge came primarily from cross-referencing Delphi's
prices against sharper, more liquid external markets (Polymarket, sportsbook
odds, live asset prices), falling back to a disciplined LLM forecast only
where no such reference existed, on the theory, laid out above, that an
LLM's raw probability estimate is not, by itself, a trustworthy foundation
for sizing real capital. The risk pipeline, PAPER/LIVE gating, persistence,
and watchdog were built to let that strategy run unattended and recover
from failure without losing state or over-trading while unsupervised.

### What actually happened

The agent deployed live on testnet and traded roughly a dozen markets over
the competition window. It finished deep in the field, with negative
realized P&L. A trade-scored calibration analysis after the fact
(`scripts/calibration-report.ts`, `reports/calibration-report.json`) showed
why. Capital-weighted, the model's forecast Brier score was 0.274 against
the market's own 0.210 on the same trades. The agent's estimates were
measurably worse than the prices it was trading against, not better. The
gap was worst exactly where the strategy should have been strongest: on the
12 trades where the model's claimed edge over the market price exceeded
0.25, the win rate was 0 of 12, with a model Brier of 0.21 against the
market's 0.022 on that same subset. The single largest loss was not a
long-tail forecast gone wrong. It was a moderate-edge position, sized up
and added to more than once on repeated confidence, that resolved against
the forecast.

### What went to plan

The engineering held up under real conditions. The PAPER/LIVE gate never
leaked a live transaction during testing. State persistence and the
watchdog both did their job. Restarts, including a real `kill -9` and cold
VPS reboot, resumed exactly where the process left off, with no lost
positions or duplicated trades. The risk pipeline's gates (confidence,
oracle ambiguity, extremes, sizing, depth/slippage) all fired as designed
and never let a candidate through that they were supposed to block. When a
state-tracking bug did surface (11 paper-ghost positions accumulating
against 4 real on-chain ones), it was caught, diagnosed, and reconciled
without live funds ever being at risk from it.

### What didn't, and why

The core forecasting thesis was wrong in the way that matters most. The
model's probability estimate, used as `edge = ourProbability - price`,
treated a large disagreement with a liquid market's price as opportunity.
The data says the opposite was almost always true: a large divergence from
the market was far more often the model being wrong than the model seeing
something the market hadn't priced in yet. Nothing in the original pipeline
tested that assumption against real resolutions before sizing capital on
it. `edge` was computed and acted on as if the model's raw probability
deserved the same trust as the market price it was being compared against.
It didn't, and the sizing math (fractional Kelly, scaled by that edge)
turned a bad estimate into a bad-sized bet.

On 2026-08-17, a fix shipped: `MARKET_SHRINK_LAMBDA` shrinks the model's
probability toward the market price before edge or sizing is computed at
all (default 0.5, halfway), and `MAX_RAW_EDGE` refuses to trade at all past
a raw pre-shrink divergence of 0.25, the exact threshold the calibration
data showed was uniformly a loser. That fix ran for the final days of the
competition. There wasn't enough post-fix trading volume to say with
confidence how much it would have changed the final result had it shipped
on day one, only that it was addressing a real, measured failure mode
rather than a guessed one.

### What we'd do differently

Treat "our estimate beats the market" as a hypothesis to validate cheaply
against real resolutions before it is ever allowed to size a live trade,
not as a standing assumption baked into how edge is computed from day one.
Concretely: run the calibration analysis this repo now has continuously
from the start, not as a post-mortem, comparing forecast probabilities to
resolutions as they come in, and gating how much weight a forecast is
allowed in sizing on its own recent track record rather than its
self-reported confidence. The market-shrink and raw-edge-cutoff fix is the
right shape of correction. The mistake was building the system for a
competition-length live run before that correction, or anything like it,
existed.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- `DELPHI_API_ACCESS_KEY`: a **testnet** key from
  https://delphi-api-access.gensyn.ai/ (a mainnet key returns 401).
- `WALLET_PRIVATE_KEY`: required even to just read prices (see
  RULES.md §1 / ARCHITECTURE.md's gotchas, the SDK needs a signer for reads
  too). A loaded key is NOT itself permission to trade; only `AGENT_MODE=live`
  is.
- At least one LLM provider key if you want forecasting for markets with no
  external consensus reference (`GROQ_API_KEY` by default, free tier;
  `ANTHROPIC_API_KEY` or an OpenAI-compatible endpoint also supported, see
  the commented block in `.env.example`).
- Everything else has a documented, sensible default. Leave it commented
  out unless you have a specific reason to change it.

```bash
npx tsc --noEmit     # typecheck
npm test              # 136 tests, should all pass
```

## Running in PAPER

```bash
npm run paper-run     # one pass + a synthetic-candidate demo, human-readable output
npm run loop-demo -- 3   # the real persistent loop, bounded to 3 ticks
npm run agent          # the real persistent loop, unbounded, same entrypoint deploy/ uses
```

`npm run agent` is the production entrypoint (`scripts/run-agent.ts`). It
never terminates on its own. Stop it with Ctrl-C locally, or see
["Deploying on a VPS"](#deploying-on-a-vps) for always-on operation.

State persists to `state/agent-state.json` between runs (Layer A baselines,
forecast/structuring caches, token-usage window, portfolio, oracle
resolution log). A restart resumes exactly where it left off. See
["Restart resumes state"](#restart-resumes-state) below for a real,
two-process/kill-and-restart proof of this, not just a claim.

Structured JSONL logs land in `logs/` (`decisions-YYYY-MM-DD.jsonl`,
`trades-YYYY-MM-DD.jsonl`), enough to reconstruct every decision this agent
made. Secrets are redacted before anything is written (`src/logging/writer.ts`).
**The key/`.env` itself is never logged.**

## Secret handling

- `.env` (your real keys) is gitignored. Never commit it.
- `.env.example` and `.env.production.example` hold only blank/placeholder
  values, safe to commit.
- `logs/` and `state/` are both gitignored (runtime output, not source).
- Structured logging redacts anything that looks like a private key or API
  key before writing (see `src/logging/writer.ts`'s `redact()`), as
  defense-in-depth on top of never intentionally logging a secret.

## Switching to LIVE

Do this deliberately, in order, not as a config toggle flipped casually:

1. **Fund the wallet.** See `.agents/skills/delphi/reference/funding.md` for
   the Sepolia ETH to Gensyn Testnet bridge steps, then mint testnet USDC
   (TST). This agent never touches a faucet or funds a wallet itself. That's
   an operator action.
2. **Register that exact wallet address** on DoraHacks with the SAME address
   `WALLET_PRIVATE_KEY` derives. A mismatched registration is a silent
   failure: trades land on-chain but never rank (RULES.md §1). This agent
   never performs DoraHacks registration itself.
3. **Turn on the layers you want live.** Every `*_ENABLED` flag defaults
   `false`. A straight copy of `.env.example` into production goes live
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
   `isLive()` locally, at the point of the transaction. This is the one and
   only switch that permits an on-chain write (RULES.md §7).

The synthetic-candidate demo in `scripts/paper-run.ts` cannot run live even
by accident: it's fenced by an `isLive()` check AND is structurally
unreachable from `scripts/run-agent.ts` (the production entrypoint never
imports it, proven by `tests/liveEntryIsolation.test.ts`'s static
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
# edit .env: fill in DELPHI_API_ACCESS_KEY, WALLET_PRIVATE_KEY, GROQ_API_KEY.
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

This starts the agent in **whatever `AGENT_MODE` your `.env` has**.
`.env.production.example`'s own template leaves it commented, defaulting to
PAPER, deliberately: the deploy scripts never assume LIVE. Only an operator
explicitly uncommenting `AGENT_MODE=live` (after the checklist above) goes
live.

### Auto-restart on crash

`delphi-agent.service` sets `Restart=always`. Any crash or nonzero exit
gets systemd to restart the process (rate-limited via
`StartLimitIntervalSec`/`StartLimitBurst` so a true crash-loop doesn't spin
forever).

### The watchdog: the operational backstop for a wedged (not crashed) process

`Restart=always` only helps if the process actually exits. A process that's
still *running* but stuck (the retry-after class of hang fixed in Phase 5A,
or any not-yet-hardened fetch path, see ARCHITECTURE.md's gotchas) needs a
different backstop. `src/loop/heartbeat.ts` writes `state/heartbeat.json`
at frequent checkpoints: every loop tick boundary AND, inside a pass, after
every single market in the consensus/structuring/forecasting/decision loops,
not just once per whole pass. `deploy/watchdog.sh`, run every 5 minutes by
`delphi-agent-watchdog.timer`, checks that file's age. If it's stale beyond
`WATCHDOG_MAX_STALL_SECONDS` (default 1800s / 30 min, comfortably above the
bounded worst case of a single pass under sustained rate-limiting, roughly
20 minutes with the Phase 5A retry-after cap and Fix 2's raised 45s
per-call LLM timeout), it hard-restarts `delphi-agent.service`.

Verified locally (dry-run, no real systemd unit needed for this check):

```
$ DELPHI_AGENT_DIR=/tmp/watchdog-test DRY_RUN=1 WATCHDOG_MAX_STALL_SECONDS=1800 bash deploy/watchdog.sh
[watchdog] heartbeat age: 0s (max allowed: 1800s)
[watchdog] OK

$ # (heartbeat file backdated 1 hour)
$ DELPHI_AGENT_DIR=/tmp/watchdog-test DRY_RUN=1 WATCHDOG_MAX_STALL_SECONDS=1800 bash deploy/watchdog.sh
[watchdog] heartbeat age: 3600s (max allowed: 1800s)
[watchdog] STALE (dry run), would run: systemctl restart delphi-agent

$ # (no heartbeat file, fresh deploy)
$ DELPHI_AGENT_DIR=/tmp/watchdog-test DRY_RUN=1 bash deploy/watchdog.sh
[watchdog] no heartbeat file yet at /tmp/watchdog-test/state/heartbeat.json, agent may still be starting, not restarting
```

### Restart resumes state

This is the whole point of pairing a watchdog with persistence. A
kill-triggered restart must not lose Layer A baselines, caches, the token
budget window, or the portfolio. Proven two ways:

1. **Two genuinely separate processes** (`scripts/demo-persistence-restart.ts`).
   See the Checkpoint 5A report for the full transcript: a `write` process
   exits completely, a fresh `read` process reloads everything from
   `state/agent-state.json`.
2. **The real production entrypoint, killed and restarted**, exactly as the
   watchdog would do it: `kill -9` (not a graceful stop, since the
   watchdog's whole point is recovering from a process that ISN'T shutting
   down cleanly), then a fresh `node --import tsx/esm scripts/run-agent.ts`.
   See the Checkpoint 5B report for this run's raw output.

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) (gitignored, local reference) for the
full module map and data flow. Top level:

```
src/            application code (config, markets, signals, layers, risk,
                execution, portfolio, persistence, loop, logging)
scripts/        entrypoints: run-agent.ts (production), paper-run.ts
                (diagnostic/demo), run-loop-demo.ts, healthcheck.ts, etc.
deploy/         systemd unit + watchdog script/timer
tests/          node:test suite (npx tsx --test)
```

## Local docs (gitignored, not tracked, for your own reference)

- [ARCHITECTURE.md](ARCHITECTURE.md): module map, data flow, live-API
  gotchas discovered along the way.
- [RULES.md](RULES.md): every hard constraint and exactly how the code
  enforces it.
- [STRATEGY.md](STRATEGY.md): the full thesis and tuned tactics, written
  for a human evaluator. Kept private during the competition; this README's
  ["What the bot actually does"](#what-the-bot-actually-does) section is the
  public-safe summary of the same ideas.
