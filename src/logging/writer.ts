/**
 * Structured JSON-lines logging to disk. One file per log kind per UTC day
 * (logs/<kind>-YYYY-MM-DD.jsonl), append-only.
 *
 * NEVER logs the key/.env: redact() is applied to every serialized line as
 * a defense-in-depth pass — nothing in this project's data model (market
 * data, decisions, trades, resolutions) should ever contain a private key
 * or API key, but this catches it anyway if something upstream ever leaks
 * one into a logged object, rather than trusting every call site to have
 * scrubbed it first.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const LOG_DIR = "logs";

// Defense-in-depth patterns — not exhaustive, but catches the shapes of
// secrets this project actually handles (see RULES.md once written):
// 0x-prefixed 64-hex-char private keys, and common provider API key prefixes.
const SECRET_PATTERNS: RegExp[] = [
  /0x[0-9a-fA-F]{64}/g, // private key
  /gsk_[A-Za-z0-9]{20,}/g, // Groq
  /sk-ant-[A-Za-z0-9-_]{20,}/g, // Anthropic
  /sk-[A-Za-z0-9]{20,}/g, // generic OpenAI-shaped
];

export function redact(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function appendJsonLine(kind: string, entry: unknown, logDir: string = LOG_DIR): Promise<void> {
  const path = `${logDir}/${kind}-${todayUtc()}.jsonl`;
  await mkdir(dirname(path), { recursive: true });
  const line = redact(JSON.stringify(entry)) + "\n";
  await appendFile(path, line, "utf8");
}
