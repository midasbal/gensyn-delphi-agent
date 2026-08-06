/**
 * Optional live-news retrieval for forecasting, via Tavily's search API.
 * Gated on SEARCH_API_KEY — NOT configured in this project's .env, so this
 * has never been exercised live. forecast.ts must treat a null return as
 * "no live retrieval available" and say so in its rationale, not silently
 * forecast on stale training knowledge as if it had checked the news.
 */
import { signals } from "../../config/index.js";

const FETCH_TIMEOUT_MS = 10_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function isSearchConfigured(): boolean {
  return !!signals.searchApiKey;
}

export async function search(query: string): Promise<SearchResult[] | null> {
  if (!signals.searchApiKey) return null;

  // Same hard-timeout backstop as llmClient.ts's fetchWithBackoff (Phase 5
  // checkpoint finding): AbortController.abort() has been observed to not
  // reliably unblock either the initial fetch() or a stalled res.json()
  // body read, so both are raced against an independent timer.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const timeoutRejection = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fetch-hard-timeout")), FETCH_TIMEOUT_MS));
  try {
    const res = await Promise.race([
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: signals.searchApiKey, query, max_results: 5 }),
        signal: controller.signal,
      }),
      timeoutRejection(),
    ]);
    if (!res.ok) return null;
    const data = (await Promise.race([res.json(), timeoutRejection()])) as { results?: Array<{ title: string; url: string; content: string }> };
    if (!data.results) return null;
    return data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
