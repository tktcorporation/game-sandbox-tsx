/**
 * 倉庫の整理: sell / keep one-by-one until pending is empty; no silent sale.
 * Run: `npx tsx scripts/ringfall-organize.ts`
 */
import { META } from "../src/ringfall/sim/config";
import {
  keepPending,
  needsOrganize,
  newProfile,
  sellForOrganize,
  sellPending,
  settle,
  stashUsed,
  withStarters,
  type Item,
  type Profile,
} from "../src/ringfall/meta/profile";
import { stashCap } from "../src/ringfall/meta/hideout";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { ITEM_SECTION, rows } from "../src/ringfall/view/hub";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

// Full stash of heals (starters free); raid brings only valuables (empty kit / heals).
let p: Profile = {
  ...newProfile(3),
  stash: [...Array.from({ length: META.stash }, (): Item => ({ t: "heal", kind: "cell" })), ...withStarters([])],
};
const kit = starterKit();
kit.weapons = [{ kind: "pike", rarity: 0, mag: -1, starter: true }, { kind: "talon", rarity: 0, mag: -1, starter: true }];
kit.heals = { cell: 0, battery: 0, syringe: 0, medkit: 0 };
kit.armor = 0;
kit.keys = [];
const s = newRun(3, kit);
s.outcome = "extracted";
s.player.weapons = [kit.weapons[0], kit.weapons[1]];
s.player.heals = { cell: 0, battery: 0, syringe: 0, medkit: 0 };
s.player.armor = 0;
s.player.haul = ["wire", "parts", "fuse"];
const settled = settle(p, s);
check(settled.pending.length === 3, `settle pending ${settled.pending.length} (want 3)`);
check(needsOrganize(settled.profile), "needsOrganize after settle");
check(settled.soldFor === 0, "soldFor 0");

let cur = settled.profile;
const cash0 = cur.cash;
const sold = sellPending(cur, 0);
check(!!sold && sold.profile.pending.length === 2, `sellPending left ${sold?.profile.pending.length}`);
cur = sold!.profile;
check(cur.cash === cash0 + sold!.soldFor, "cash from sellPending");

const kept = keepPending(cur, 0);
check(!kept, "keepPending while full");

const healAt = cur.stash.findIndex((i) => i.t === "heal");
const freed = sellForOrganize(cur, healAt);
check(!!freed && stashUsed(freed.profile) === stashCap(freed.profile.hideout) - 1, "sellForOrganize frees a slot");
cur = freed!.profile;
const inStash = keepPending(cur, 0);
check(!!inStash && inStash.pending.length === 1, `keepPending after room left ${inStash?.pending.length}`);
cur = inStash!;

while (cur.pending.length) {
  const r = sellPending(cur, 0);
  check(!!r, "drain pending");
  cur = r!.profile;
}
check(!needsOrganize(cur), "done");

// Stacked rows: identical heals collapse; sell still removes one.
{
  const stacked = rows([
    { t: "heal", kind: "cell" },
    { t: "heal", kind: "cell" },
    { t: "valuable", kind: "wire" },
    { t: "valuable", kind: "wire" },
    { t: "valuable", kind: "parts" },
  ]);
  check(stacked.length === 3, `rows stack length ${stacked.length}`);
  check(stacked[0]!.index.length === 2 && stacked[0]!.item.t === "heal", "heals stacked");
  check(stacked[1]!.item.t === "valuable" && stacked[1]!.index.length === 2, "wire stacked");
  check(stacked[2]!.item.t === "valuable" && stacked[2]!.index.length === 1, "parts alone");
  check(ITEM_SECTION.weapon === "武器" && ITEM_SECTION.valuable === "回収品", "section labels");
}

if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  process.exit(1);
}
console.log("organize ok");
