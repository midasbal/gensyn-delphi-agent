/**
 * Fractional-Kelly sizing for a binary bet: buying a share at `price` that
 * pays exactly 1 (LMSR competition — see competition.md) if our probability
 * `q` is right.
 *
 *   f* = (q - p) / (1 - p) = edge / (1 - price)     [full Kelly bankroll fraction]
 *
 * Used at a CONSERVATIVE fraction of full Kelly (config.risk.kellyFraction,
 * default 0.25x) because q is an estimate with error — over-betting a wrong
 * q blows up fast under full Kelly. Further scaled down by the combined
 * signal's confidence, and by any ambiguity/extreme-zone shrink factors the
 * gate pipeline applies on top (see risk/gates.ts).
 */
export function fullKellyFraction(edge: number, price: number): number {
  const denom = 1 - price;
  if (denom <= 0) return 0; // price === 1, no room to buy — shouldn't reach here past the extremes gate
  return edge / denom;
}

/**
 * Bankroll fraction to actually risk, after applying the conservative Kelly
 * multiplier, confidence scaling, and any additional shrink factors (e.g.
 * oracle-ambiguity shrink, extreme-zone shrink). Clamped to [0, 1] — full
 * Kelly can exceed 1 for a large edge at a low price, which is never sane to
 * act on literally.
 */
export function conservativeKellyFraction(edge: number, price: number, kellyMultiplier: number, confidence: number, extraShrinkFactors: number[] = []): number {
  const full = fullKellyFraction(edge, price);
  const shrink = extraShrinkFactors.reduce((a, b) => a * b, 1);
  const fraction = full * kellyMultiplier * confidence * shrink;
  return Math.min(1, Math.max(0, fraction));
}
