import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMoveByAddress } from "../src/loop/paperLoop.js";
import type { MoveCheck } from "../src/layers/latency/index.js";

/** Reference implementation — exactly the O(n^2) code this replaces, kept here only to pin equivalence. */
function findByAddress(moveChecks: Array<{ market: { address: string }; move: MoveCheck }>, address: string): MoveCheck | undefined {
  return moveChecks.find((m) => m.market.address === address)?.move;
}

function move(reason: string): MoveCheck {
  return { moved: false, referenceDelta: null, priceDelta: null, reason };
}

test("buildMoveByAddress — matches .find() semantics for a normal (unique-address) set", () => {
  const moveChecks = [
    { market: { address: "0xaaa" }, move: move("a") },
    { market: { address: "0xbbb" }, move: move("b") },
    { market: { address: "0xccc" }, move: move("c") },
  ];
  const byAddress = buildMoveByAddress(moveChecks);

  for (const address of ["0xaaa", "0xbbb", "0xccc", "0xdoesnotexist"]) {
    assert.deepEqual(byAddress.get(address), findByAddress(moveChecks, address));
  }
});

test("buildMoveByAddress — empty input matches .find() on an empty array (both undefined)", () => {
  const byAddress = buildMoveByAddress([]);
  assert.equal(byAddress.get("0xaaa"), undefined);
  assert.equal(findByAddress([], "0xaaa"), undefined);
});

test("buildMoveByAddress — a duplicate address matches .find()'s first-match-wins behavior (defensive; addresses are unique in practice)", () => {
  const moveChecks = [
    { market: { address: "0xaaa" }, move: move("first") },
    { market: { address: "0xaaa" }, move: move("second") },
  ];
  const byAddress = buildMoveByAddress(moveChecks);
  assert.equal(byAddress.get("0xaaa")?.reason, "first");
  assert.equal(findByAddress(moveChecks, "0xaaa")?.reason, "first");
  assert.deepEqual(byAddress.get("0xaaa"), findByAddress(moveChecks, "0xaaa"));
});

test("buildMoveByAddress — every address in a larger set round-trips identically to .find() (equivalence sweep)", () => {
  const moveChecks = Array.from({ length: 50 }, (_, i) => ({
    market: { address: `0x${i.toString(16).padStart(4, "0")}` },
    move: move(`market-${i}`),
  }));
  const byAddress = buildMoveByAddress(moveChecks);

  for (const { market } of moveChecks) {
    assert.deepEqual(byAddress.get(market.address), findByAddress(moveChecks, market.address));
  }
});
