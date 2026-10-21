import { MOD, MOD_KINDS, MODS, THREAT, type ModKind } from "./config";
import { terrainHeight } from "./terrain";
import { mix, type Bin, type Enemy, type Loot, type Player, type State } from "./state";

/*
 * Mod parts (改造パーツ, `MODS`): found in bins and on fallen robots, worn in `MOD.slots` body
 * slots, lost when the raid ends. Which bin or robot holds one is a hash of the raid's seed and
 * the bin or robot, and the parts lie under ids of their own below every other: a raid in which
 * none is picked up draws the same random numbers and numbers its things as one without them.
 */

/** Whether the player wears a mod of kind `k`. */
export const hasMod = (p: Pick<Player, "mods">, k: ModKind) => !!p.mods?.includes(k);

/** The factor mod `k` puts on its number while worn (`MODS[k].value`), else 1. */
export const modScale = (p: Pick<Player, "mods">, k: ModKind) => (hasMod(p, k) ? MODS[k].value : 1);

/** What the raid's threat sets (`THREAT.levels`). */
export const threatOf = (s: Pick<State, "threat">) => THREAT.levels[s.threat ?? 0];

/** A uniform number in [0, 1) from the raid's seed, a salt and an id, drawing nothing from `rand`. */
const hashed = (seed: number, salt: number, id: number) => mix(Math.imul(seed ^ 0x6d2b79f5, 0x9e3779b1) + Math.imul(id, 7919) + Math.imul(salt + 1, 104729)) / 4294967296;

/** The kind picked from `pool` by a hash, or null for an empty pool. */
const pickKind = (pool: readonly ModKind[], h: number): ModKind | null => (pool.length ? pool[Math.min(pool.length - 1, Math.floor(h * pool.length))] : null);

/** The chance a source of base chance `base` holds a part this raid: more at a higher threat, none in a raid without parts. */
const chance = (s: State, base: number) => (s.modOdds ?? 1) * threatOf(s).mods * base;

/** The mod part bin `b` holds this raid, of a kind the profile knows (`State.known`), or null. Vaults hold none. */
export function binMod(s: State, b: Bin): ModKind | null {
  if (b.vault || hashed(s.seed, 1, b.id) >= chance(s, MOD.bin)) return null;
  return pickKind(s.known ?? [], hashed(s.seed, 2, b.id));
}

/**
 * The mod part robot `e` drops as it falls this raid, of any kind, or null: the titan always, a
 * salvage crew's member or a raider (elite) with `MOD.elite`, any other with `MOD.robot`.
 */
export function robotMod(s: State, e: Enemy): ModKind | null {
  const base = e.kind === "titan" ? 1 : e.elite || s.squads[e.squad]?.crew ? MOD.elite : MOD.robot;
  if (hashed(s.seed, 3, e.id) >= Math.min(1, chance(s, base))) return null;
  return pickKind(MOD_KINDS, hashed(s.seed, 4, e.id));
}

/** A part tossed out of `at` toward the player as loot is, its direction from the hash, under `id`. */
function toss(s: State, at: { x: number; y: number; z: number }, mod: ModKind, id: number) {
  const p = s.player;
  const a = Math.atan2(p.pos.z - at.z, p.pos.x - at.x) + (hashed(s.seed, 5, id) - 0.5) * 1.6;
  const sp = at.y > terrainHeight(at.x, at.z) + 0.5 ? 1.2 : 2.6;
  s.loot.push({ id, kind: "mod", mod, rarity: 2, pos: { x: at.x, y: at.y + 1.0, z: at.z }, vel: { x: Math.cos(a) * sp, y: 4.2, z: Math.sin(a) * sp }, age: 0 });
}

/** Spills bin `b`'s part, if it holds one. */
export function spillBinMod(s: State, b: Bin) {
  const m = binMod(s, b);
  if (m) toss(s, b, m, -(3_000_000 + b.id));
}

/** Drops robot `e`'s part where it fell (`at`), if it carries one. */
export function dropRobotMod(s: State, e: Enemy, at: { x: number; y: number; z: number }) {
  const m = robotMod(s, e);
  if (m) toss(s, { x: at.x, y: at.y - 1, z: at.z }, m, -(4_000_000 + e.id));
}

/**
 * Puts on the part `l`: in a free slot, or, with every slot worn, in place of the one worn
 * longest, which is left on the ground. A kind already worn is not put on twice.
 */
export function wearMod(s: State, l: Loot) {
  const p = s.player;
  const k = l.mod;
  if (!k || hasMod(p, k)) return;
  s.loot = s.loot.filter((o) => o !== l);
  const off = p.mods.length >= MOD.slots ? p.mods.shift() : undefined;
  p.mods.push(k);
  if (off) s.loot.push({ id: s.nextId++, kind: "mod", mod: off, rarity: 2, pos: { ...l.pos }, vel: { x: 0, y: 2, z: 0 }, age: 0 });
  s.events.push({ t: "pickup", kind: "mod", rarity: 2, label: `改造パーツ：${MODS[k].name}${off ? `（${MODS[off].name}を外した）` : ""}` });
}
