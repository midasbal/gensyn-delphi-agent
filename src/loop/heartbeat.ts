/**
 * Phase 5B — liveness signal for an external watchdog (deploy/watchdog.sh).
 *
 * The retry-after cap (Phase 5A checkpoint fix) bounds any single network
 * call's worst case, but a full pass over many markets, each hitting that
 * worst case in sequence, still adds up — and any fetch path this project
 * hasn't hardened yet (see ARCHITECTURE.md's gotchas) could still wedge the
 * process. This file is the operational backstop for that: written at
 * frequent, meaningful checkpoints (loop tick boundaries AND per-market
 * inside a pass, not just once per pass), so an external watchdog can tell
 * "still making progress" from "wedged" without knowing anything about this
 * project's internals — it just checks whether this file's timestamp is
 * recent.
 *
 * Deliberately fire-and-forget from every call site (`.catch(() => {})`),
 * same convention as logging/ — a heartbeat write failing must never affect
 * a real decision pass.
 */
import { writeJsonFileAtomic, readJsonFile } from "../persistence/store.js";

export interface Heartbeat {
  timestampMs: number;
  label: string;
}

export const DEFAULT_HEARTBEAT_PATH = "state/heartbeat.json";

export async function writeHeartbeat(label: string, path: string = DEFAULT_HEARTBEAT_PATH, nowMs: number = Date.now()): Promise<void> {
  const beat: Heartbeat = { timestampMs: nowMs, label };
  await writeJsonFileAtomic(path, beat);
}

export async function readHeartbeat(path: string = DEFAULT_HEARTBEAT_PATH): Promise<Heartbeat | null> {
  return readJsonFile<Heartbeat>(path);
}

/** Pure — for the watchdog script's Node-based staleness check and unit tests alike. */
export function heartbeatAgeMs(beat: Heartbeat | null, nowMs: number = Date.now()): number {
  if (!beat) return Infinity;
  return nowMs - beat.timestampMs;
}
