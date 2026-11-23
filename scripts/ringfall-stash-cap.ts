/**
 * Warehouse capacity vs overflow under a "hoarder" settle: keep gear and materials,
 * only auto-sell what does not fit. Prints room and overflow by 倉庫 level for the
 * report (docs/ringfall/warehouse.md). Economy numbers themselves are unchanged by
 * the shelves UI entry; this shows what leveling the warehouse buys.
 *
 *   npx tsx scripts/ringfall-stash-cap.ts
 */
import { HIDEOUT, HIDEOUT_EFFECT, META, VALUABLES, type ValuableKind } from "../src/ringfall/sim/config";
import { emptyHideout, stashCap } from "../src/ringfall/meta/hideout";
import { build, newProfile, sellPrice, type Item, type Profile } from "../src/ringfall/meta/profile";
import { nextHandFor } from "../src/ringfall/view/hub";
import { PHRASE } from "../src/ringfall/view/copy";

const haulBag = (n: number): Item[] => {
  const kinds = Object.keys(VALUABLES) as ValuableKind[];
  return Array.from({ length: n }, (_, i): Item => ({ t: "valuable", kind: kinds[i % kinds.length]! }));
};

/** Same rule as settle's store(): what fits stays, the rest is sold. */
function storeOverflow(storageLv: number, filled: number, incoming: number): { cap: number; kept: number; sold: number; soldFor: number } {
  const h = { ...emptyHideout(), storage: storageLv };
  const cap = stashCap(h);
  const used = Math.min(filled, cap);
  const room = Math.max(0, cap - used);
  const haul = haulBag(incoming);
  const kept = haul.slice(0, room);
  const sold = haul.slice(room);
  const soldFor = sold.reduce((n, i) => n + sellPrice(i), 0);
  return { cap, kept: kept.length, sold: sold.length, soldFor };
}

function raiseCost(fromLv: number): { items: string; cash: number } | null {
  const level = HIDEOUT.storage.levels[fromLv];
  if (!level) return null;
  const items = level.items.map(([k, n]) => `${VALUABLES[k].label}×${n}`).join("、");
  return { items, cash: level.cash };
}

const give = (prof: Profile, items: [ValuableKind, number][]): Profile => {
  const add: Item[] = [];
  for (const [k, n] of items) for (let i = 0; i < n; i++) add.push({ t: "valuable", kind: k });
  return { ...prof, stash: [...prof.stash, ...add] };
};

console.log("倉庫 容量と溢れ（抱え込み想定：枠をほぼ埋めた状態でカバン分を持ち帰る）\n");
console.log("| 倉庫 Lv | 上限 | 効果 | 次レベルへのコスト | カバン10個持ち帰り時の溢れ |");
console.log("| --- | --- | --- | --- | --- |");
for (let lv = 0; lv <= HIDEOUT.storage.levels.length; lv++) {
  const cap = META.stash + HIDEOUT_EFFECT.storage[lv]!;
  const next = raiseCost(lv);
  const cost = next ? `${next.items} + ${next.cash}` : "（上限）";
  const o = storeOverflow(lv, cap - 2, 10);
  console.log(`| ${lv} | ${cap} | +${HIDEOUT_EFFECT.storage[lv]} | ${cost} | ${o.sold} 点（${o.soldFor} クレジット） |`);
}

console.log("\n同じ抱え込みで、レベルを上げたあと（中身は上げる前のまま、枠だけ増えた）:");
for (let lv = 0; lv < HIDEOUT.storage.levels.length; lv++) {
  const filled = stashCap({ ...emptyHideout(), storage: lv }) - 2;
  const before = storeOverflow(lv, filled, 10);
  const after = storeOverflow(lv + 1, filled, 10);
  console.log(`  Lv${lv}→Lv${lv + 1}: 溢れ ${before.sold} → ${after.sold} 点（枠 ${before.cap} → ${after.cap}）`);
}

let p = { ...newProfile(), cash: 50_000 };
for (let lv = 0; lv < HIDEOUT.storage.levels.length; lv++) {
  const need = HIDEOUT.storage.levels[lv]!;
  p = give(p, need.items);
  const next = build(p, "storage");
  if (!next || next.hideout.storage !== lv + 1) {
    console.error(`build failed at Lv${lv + 1}`);
    process.exit(1);
  }
  p = next;
  if (stashCap(p.hideout) !== META.stash + HIDEOUT_EFFECT.storage[lv + 1]!) {
    console.error(`cap mismatch at Lv${lv + 1}`);
    process.exit(1);
  }
}
const caps = Array.from({ length: HIDEOUT.storage.levels.length + 1 }, (_, lv) => META.stash + HIDEOUT_EFFECT.storage[lv]!);
console.log(`\n建設チェック: 倉庫 Lv0→${HIDEOUT.storage.levels.length} まで建てられ、上限は ${caps.join(" / ")}。OK`);

/** Rough total cost (cash + sell value of items) so late levels sit above other hideout tops. */
const levelWorth = (items: [ValuableKind, number][], cash: number) =>
  cash + items.reduce((n, [k, c]) => n + VALUABLES[k].value * c, 0);
console.log("\nコスト帯（クレジット + 回収品の売値。貪欲法が安い順に建てる目安）:");
for (const m of ["infirmary", "workbench", "storage", "radio", "pouch"] as const) {
  for (let l = 0; l < HIDEOUT[m].levels.length; l++) {
    const lv = HIDEOUT[m].levels[l]!;
    console.log(`  ${HIDEOUT[m].name} Lv${l + 1}: ${levelWorth(lv.items, lv.cash)}`);
  }
}

// next-hand tips at the shelves when storage can be built (intro front done; nothing higher).
const tipBase = {
  ...newProfile(),
  cash: HIDEOUT.storage.levels[0]!.cash,
  quests: { progress: {}, done: ["front"] },
  taken: "x" as string | null, // board has contracts; mark as taken so quest-pick does not win
  board: { ...newProfile().board, contracts: [] },
};
const funded = give(tipBase, HIDEOUT.storage.levels[0]!.items);
const hand = nextHandFor(funded);
if (hand !== PHRASE.nextStashRaise) {
  console.error(`next-hand: expected ${PHRASE.nextStashRaise}, got ${hand}`);
  process.exit(1);
}
console.log(`次の一手チェック: 倉庫 Lv1 が作れるとき「${PHRASE.nextStashRaise}」。OK`);
