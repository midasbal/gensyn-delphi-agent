/**
 * Structured resolution log — one JSON line per market resolution observed.
 * Mirrors layers/oracle's ResolutionLogEntry (the in-memory structure Layer
 * E will eventually fit an empirical ambiguity model to) so the on-disk log
 * and the in-memory/persisted state agree on shape — this is the same data,
 * just also durably logged in the append-only JSONL trail rather than only
 * the mutable state snapshot.
 */
import { appendJsonLine } from "./writer.js";
import type { ResolutionLogEntry } from "../layers/oracle/index.js";

export async function logResolution(entry: ResolutionLogEntry): Promise<void> {
  await appendJsonLine("resolutions", entry);
}
