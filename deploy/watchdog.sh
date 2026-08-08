#!/usr/bin/env bash
set -euo pipefail

# Phase 5B — operational backstop for the "process wedges" case (retry-after
# class of hang, or any un-hardened fetch path — see ARCHITECTURE.md's
# gotchas). This does NOT replace systemd's own Restart=always (that already
# handles a crash/exit); this catches a process that's still *running* but
# stuck making no progress — Restart=always can't see that on its own.
#
# Run periodically by delphi-agent-watchdog.timer. Reads
# state/heartbeat.json's timestamp (written per-market during every pass —
# see src/loop/heartbeat.ts) and, if it's older than
# WATCHDOG_MAX_STALL_SECONDS, hard-restarts the agent's systemd unit.
# systemd then re-execs scripts/run-agent.ts, which reloads
# state/agent-state.json on startup (src/persistence/index.ts) — the same
# path proven by scripts/demo-persistence-restart.ts and, live, by killing
# and restarting the real process (see README.md "Restart resumes state").
#
# DRY_RUN=1 prints what it would do instead of calling systemctl — used to
# test this script's staleness logic without a real systemd unit installed
# (e.g. in CI or a dev machine that isn't the VPS).

APP_DIR="${DELPHI_AGENT_DIR:-/opt/delphi-agent}"
SERVICE_NAME="${DELPHI_AGENT_SERVICE:-delphi-agent}"
# 30 minutes: comfortably above the bounded worst case of a single pass under
# sustained 429s (10 markets x ~4 retries x 8s-capped backoff each, in both
# the structuring and forecasting loops — see llmClient.ts's MAX_BACKOFF_MS),
# OR under llmClient.ts's 45s per-call hard timeout (Fix 2, raised from 30s
# to absorb search-augmented prompt latency; a genuine non-429 hang gets no
# retry, so this is the real per-call ceiling in that case) — roughly 20
# minutes worst case across a full pass — while still catching a genuine
# wedge well before it silently eats an entire loop cadence.
MAX_STALL_SECONDS="${WATCHDOG_MAX_STALL_SECONDS:-1800}"
HEARTBEAT_FILE="$APP_DIR/state/heartbeat.json"

if [[ ! -f "$HEARTBEAT_FILE" ]]; then
  echo "[watchdog] no heartbeat file yet at $HEARTBEAT_FILE — agent may still be starting, not restarting"
  exit 0
fi

LAST_MTIME=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || stat -f %m "$HEARTBEAT_FILE")
NOW=$(date +%s)
AGE_SECONDS=$((NOW - LAST_MTIME))

echo "[watchdog] heartbeat age: ${AGE_SECONDS}s (max allowed: ${MAX_STALL_SECONDS}s)"

if (( AGE_SECONDS > MAX_STALL_SECONDS )); then
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "[watchdog] STALE (dry run) — would run: systemctl restart $SERVICE_NAME"
  else
    echo "[watchdog] STALE — restarting $SERVICE_NAME (state will resume from state/agent-state.json)"
    systemctl restart "$SERVICE_NAME"
  fi
else
  echo "[watchdog] OK"
fi
