import { FACTORY, FACTORY_TOP, PLATE, STRENGTH, THREAT, type EnemyKind } from "./config";
import { CONTESTED_OUTER, isContestedOuter } from "./contested-outer";
import { rivalOf, type PoiHold } from "./holds";
import { NODES, PACKS, POIS, REGIONS, regionHere, TIER, nodeIndex, type Member, type NodeId, type Squad } from "./map";
import { mix } from "./state";

/*
 * What a POI's standing on the island (meta/island.ts) means inside a raid: whether its robots
 * stand there. The rules that move a POI from one standing to another live in the meta.
 *
 * Contested outer hubs (作り順②) held by another player stand a garrison from that owner's
 * 工場の部隊 and 島の守り (extra grunts), not the authored POI squads.
 */

export type { PoiHold, RivalHold } from "./holds";

/**
 * Outer-edge hubs contested with neighbours (must match `CONTESTED_SHORES` / `CONTESTED_OUTER`):
 * derived from the map in `contested-outer.ts`, not a hand list.
 */
export const CONTESTED_POIS: readonly NodeId[] = CONTESTED_OUTER;

export const isContestedPoi = (poi: number | NodeId | string): boolean =>
  typeof poi === "number" ? isContestedOuter(POIS[poi]?.id ?? "") : isContestedOuter(poi);

/** Extra grunts from 島の守り joining a contested defence (matches worker `EXPEDITION.aidPerFight`). */
export const DEFENCE_AID = 2;

/** The squad guarding a POI's vault: the one with a member in armour plate. */
export const isVaultGuard = (sq: Squad) => sq.members.some((m) => m.plate !== undefined);

/** Factory kinds for defence at level `factory` (clamped). */
export const defenceKinds = (factory: number): EnemyKind[] =>
  FACTORY.levels[Math.max(0, Math.min(FACTORY_TOP, Math.round(factory) || 0))].kinds;

/**
 * Members of a contested defence squad at POI `poi`: factory kinds, then up to `aid` grunts from
 * 島の守り, standing round the node's core.
 */
export function defenceMembers(poi: number, factory: number, aid = 0): Member[] {
  const kinds: EnemyKind[] = [...defenceKinds(factory), ...Array(Math.max(0, Math.min(DEFENCE_AID, Math.floor(aid)))).fill("grunt" as EnemyKind)];
  const id = POIS[poi]?.id as NodeId | undefined;
  const n = id !== undefined ? NODES[nodeIndex(id)] : undefined;
  const cx = n?.core.x ?? POIS[poi]?.x ?? 0;
  const cz = n?.core.z ?? POIS[poi]?.z ?? 0;
  const cy = n?.core.y;
  return kinds.map((kind, i) => {
    const a = (i / Math.max(1, kinds.length)) * Math.PI * 2;
    const r = 4 + (i % 3);
    return { kind, x: cx + Math.sin(a) * r, z: cz - Math.cos(a) * r, ...(cy !== undefined ? { y: cy } : {}), face: a + Math.PI };
  });
}

/** One squad defending a contested hub from the owner's 工場 + 島の守り. */
export function rivalDefenceSquad(poi: number, factory: number, aid = 0): Squad {
  return { name: `守備·${POIS[poi]?.id ?? poi}`, members: defenceMembers(poi, factory, aid) };
}

/**
 * The squads of POI `poi` that stand in a raid: the enemy's authored squads while it holds it;
 * for a contested hub another player holds, that owner's factory (+ 島の守り grunts) when
 * `defence` names their factory level; otherwise none.
 */
export const garrison = (poi: number, hold: PoiHold, defence?: { factory: number; aid?: number }): Squad[] => {
  if (hold === "foe") return POIS[poi].squads;
  const who = rivalOf(hold);
  if (!who || !isContestedPoi(poi) || defence === undefined) return [];
  return [rivalDefenceSquad(poi, defence.factory, defence.aid ?? 0)];
};

/** Whether a rival-held contested hub has a standing defence this raid. */
export const hasRivalDefence = (poi: number, hold: PoiHold, defenceOf: (owner: string) => number | undefined): boolean => {
  const who = rivalOf(hold);
  return !!who && isContestedPoi(poi) && defenceOf(who) !== undefined;
};

/** A hash of the raid's seed and a salt, for choices that must not draw on the raid's random numbers. */
const seeded = (seed: number, salt: number, k: number) => mix(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35));

/**
 * The drone packs flying in a raid from `seed` at the enemy's strength `level`: in each region,
 * as many of its packs as the level gives, picked from the seed. All of them at the levels that fly every pack.
 */
export function activePacks(seed: number, level: number): Squad[] {
  const want = STRENGTH.levels[level].packs;
  const keep = new Set<Squad>();
  for (const r of REGIONS) {
    const mine = PACKS.map((sq, i) => ({ sq, i })).filter(({ sq }) => regionHere(sq.patrol?.[0] ?? { x: 0, z: 0 }).id === r.id);
    const n = Math.min(mine.length, want[r.id]);
    if (n >= mine.length) mine.forEach(({ sq }) => keep.add(sq));
    else [...mine].sort((a, b) => seeded(seed, 0x51, a.i) - seeded(seed, 0x51, b.i)).slice(0, n).forEach(({ sq }) => keep.add(sq));
  }
  return PACKS.filter((sq) => keep.has(sq));
}

/** Whether a plain grunt or heavy numbered `id` in a raid from `seed` wears a tier-1 plate at threat `threat`. */
export const netPlated = (seed: number, id: number, threat = 0) => {
  const share = THREAT.levels[threat].plate;
  return share > 0 && (seeded(seed, 0x9a, id) % 10_000) / 10_000 < share;
};

/** The tier of POI `poi`'s garrison plates: its node's tier (`TIER`), 0 for the titan's pad. */
export const poiTier = (poi: number): number => TIER[POIS[poi]?.id as NodeId] ?? 0;

/** Whether a grunt or heavy numbered `id` of a garrison of tier `tier` in a raid from `seed` wears that tier's plate (`PLATE.garrison`). */
export const tierPlated = (seed: number, id: number, tier: number) => tier > 0 && (seeded(seed, 0x7b, id) % 10_000) / 10_000 < PLATE.garrison[tier];
