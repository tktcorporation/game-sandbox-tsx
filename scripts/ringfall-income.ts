import assert from "node:assert/strict";
import { accrue, collect, emptyStores, INCOME, parseStores, storeCap } from "../src/ringfall/meta/income";
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
