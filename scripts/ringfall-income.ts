import assert from "node:assert/strict";
import { accrue, collect, emptyStores, INCOME, parseStores, storeCap, clawBack } from "../src/ringfall/meta/income";
import { newProfile } from "../src/ringfall/meta/profile";
const p = newProfile(3);
const H = 3_600_000, T = Date.UTC(2026, 10, 1);
let s = accrue(emptyStores(), p.poiState, T);
assert.equal(collect(s, p.poiState, T).credits, 0);
const own = Object.values(p.poiState).filter((x) => x.state === "own").length;
assert.equal(collect(s, p.poiState, T + 2 * H).credits, own * 2 * INCOME.perHour);
assert.equal(collect(s, p.poiState, T + 100 * H).credits, own * storeCap());
const c = collect(s, p.poiState, T + 3 * H);
assert.equal(collect(c.stores, p.poiState, T + 3 * H).credits, 0, "collected twice");
const newNode = { ...p.poiState, supply: { state: "own" as const } };
assert.equal(collect(c.stores, newNode, T + 4 * H).credits, own * INCOME.perHour, "a new holding was paid for the time before it was held");
console.log("income ok", own, "holdings");
// A save / load after collecting keeps the holdings (their stores at zero) making from the last look.
{
  const { stores } = collect(accrue(emptyStores(), p.poiState, T), p.poiState, T + H);
  const back = parseStores(JSON.parse(JSON.stringify(stores)));
  assert.equal(collect(back, p.poiState, T + 2 * H).credits, own * INCOME.perHour, "a reload lost the holdings' hours");
}
console.log("income round trip ok");
// Collecting often loses nothing: every 10 s for an hour pays what one collection after the hour does.
{
  let st = accrue(emptyStores(), p.poiState, T);
  let paid = 0;
  for (let t = T + 10_000; t <= T + H; t += 10_000) {
    const r = collect(st, p.poiState, t);
    paid += r.credits;
    st = r.stores;
  }
  const once = collect(accrue(emptyStores(), p.poiState, T), p.poiState, T + H).credits;
  assert.ok(Math.abs(paid - once) <= own, `collected often ${paid}, once ${once}`);
}
console.log("income often ok");
// A holding another player took before the last collection: what it paid then goes back out of the cash.
{
  const st = accrue(emptyStores(), p.poiState, T);
  const after = collect(st, p.poiState, T + 2 * H);
  const node = Object.keys(after.stores.paid ?? {})[0] as keyof NonNullable<typeof after.stores.paid>;
  assert.ok(node, "a collection recorded nothing paid");
  const paid = after.stores.paid![node]![0]!.n;
  const took = clawBack(after.stores, 10_000, [{ node, at: T + H }]);
  assert.equal(took.back, paid, "the income of a holding taken before it was collected stayed paid");
  assert.equal(clawBack(after.stores, 10_000, [{ node, at: T + 3 * H }]).back, 0, "income collected before the holding was taken came back");
  assert.equal(clawBack(after.stores, 5, [{ node, at: T + H }]).back, 5, "more taken back than the cash held");
  assert.equal(clawBack(took.stores, 10_000, [{ node, at: T + H }]).back, 0, "taken back twice");
  assert.deepEqual(parseStores(JSON.parse(JSON.stringify(after.stores))).paid, after.stores.paid);
  // Two raids home before the loss is known: both collections after it come back, not the last alone.
  const twice = collect(after.stores, p.poiState, T + 3 * H);
  const both = paid + twice.stores.paid![node]!.at(-1)!.n;
  assert.equal(clawBack(twice.stores, 10_000, [{ node, at: T + H }]).back, both, "only the last collection came back");
  // Bringing the stores up to date (an AI player's attack) keeps the records.
  assert.deepEqual(accrue(twice.stores, p.poiState, T + 4 * H).paid, twice.stores.paid, "accrue dropped the collections");
  // A save from before the list kept one collection as an object.
  assert.deepEqual(parseStores({ at: {}, since: T, paid: { [node]: { at: T, n: 7 } } }).paid, { [node]: [{ at: T, n: 7 }] });
}
console.log("income claw-back ok");
