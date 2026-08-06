/**
 * Optional live-news retrieval for forecasting, via Tavily's search API.
 * Gated on SEARCH_API_KEY — NOT configured in this project's .env, so this
 * has never been exercised live. forecast.ts must treat a null return as
 * "no live retrieval available" and say so in its rationale, not silently
 * forecast on stale training knowledge as if it had checked the news.
 */
import { signals } from "../../config/index.js";
import { fetchJsonWithTimeout } from "../../util/fetchJson.js";

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

  // Cleanup pass: was a one-off inline hard-timeout backstop (Phase 5
  // checkpoint finding — AbortController.abort() observed to not reliably
  // unblock either the initial fetch() or a stalled res.json() body read);
  // now shares the same implementation as the consensus adapters via
  // util/fetchJson.ts, one fix instead of four near-identical ones.
  const data = await fetchJsonWithTimeout<{ results?: Array<{ title: string; url: string; content: string }> }>(
    "https://api.tavily.com/search",
    FETCH_TIMEOUT_MS,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: signals.searchApiKey, query, max_results: 5 }),
    }
  );
  if (!data?.results) return null;
  return data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}
