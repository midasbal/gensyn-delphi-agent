// Applied ONLY when the API category is missing or "miscellaneous", in this
// order — first match wins. Best-effort; a market that matches nothing falls
// through to "miscellaneous", which is a safe default since domain only
// routes signal adapters (Phase 2), it never gates risk.
const KEYWORD_RULES: Array<{ domain: string; pattern: RegExp }> = [
  { domain: "weather", pattern: /°[CF]\b|temperature|precipitation|rainfall|wind speed|humidity/i },
  { domain: "crypto", pattern: /\b(BTC|ETH|bitcoin|ethereum|token|blockchain|crypto|stablecoin)\b/i },
  {
    domain: "tech",
    pattern: /\b(model|GPT|Gemini|Claude|AI|software update|app store|release|launch|SpaceX|rocket|satellite|Dragon)\b/i,
  },
  {
    domain: "sports",
    pattern: /\b(win|match|game|championship|kickoff|score|tournament|league|cup|regulation|innings|goal)\b/i,
  },
  {
    domain: "politics",
    pattern: /\b(President|Senate|Congress|election|attorney|resign|minister|governor|impeach|nominee)\b/i,
  },
  {
    domain: "economics",
    pattern: /\b(jobless claims|interest rate|GDP|CPI|inflation|Fed\b|central bank|unemployment|payrolls)\b/i,
  },
];

/**
 * Classify a market's domain. `category` is the PRIMARY signal and is
 * treated as an OPEN string — the API is not limited to the documented enum
 * (crypto/culture/economics/miscellaneous/politics/sports); live data has
 * already shown "tech". Any non-empty category other than "miscellaneous" is
 * returned as-is (lowercased), unmodified — an unrecognized category is not
 * an error, it just becomes the domain string verbatim, and every downstream
 * consumer (signal routing) must treat an unknown domain as "no domain-
 * specific adapter applies, use the generic/forecasting path" rather than
 * throwing.
 *
 * The keyword pass over the question text is a fallback used ONLY when
 * category is empty or "miscellaneous", so an obvious weather/tech market
 * isn't lost in the catch-all bucket.
 */
export function classifyDomain(category: string, question: string): string {
  const normalizedCategory = category.trim().toLowerCase();
  if (normalizedCategory && normalizedCategory !== "miscellaneous") {
    return normalizedCategory;
  }

  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(question)) {
      return rule.domain;
    }
  }

  return "miscellaneous";
}
