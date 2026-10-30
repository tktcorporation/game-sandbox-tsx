import { CONTRACT, CREW, FRONT, PARTY, STRENGTH, VALUABLES, type Rarity, type ValuableKind, type WeaponKind } from "../sim/config";
import { nodeIndex, PACKS, POIS, poiIndex, poiRegion, regionHere, REGIONS, regionOf, type PoiId, type RegionId } from "../sim/map";
import { activePacks, garrison, type IslandEvent, type PoiHold } from "../sim/island";
import { shopRarity } from "./island";
import { enemyNodes, frontNodes, nodeHolds } from "../sim/front";
import type { Task } from "../sim/objective";
import { crewKey, mix, partyKey, squadKey, strengthFor, type State } from "../sim/state";
import { haulOrigins } from "../sim/world";
import { MODULES, nextLevel, type Hideout } from "./hideout";
import type { RewardItem } from "./quests";

/*
 * The camp's contract board: each island day a few contracts built from the island's state and
 * the profile, fixed for the day by the next raid's seed and the day, so they stand while the
 * player is in the camp. The player takes one of them, or none; it counts in the next raid only,
 * and a contract not done by the end of that day goes with the board.
 */

export interface Reward {
  cash: number;
  items: RewardItem[];
}

/** What an intercept contract names: one of the drone packs (`PACKS`), a region's hunting party (`PARTY`), or its salvage crew (`CREW`). */
export type InterceptTarget = { t: "pack"; name: string } | { t: "party"; region: RegionId } | { t: "crew"; region: RegionId };

/** A contract, told apart by `t`: each type asks for one thing the raid already holds. */
export type Contract =
  /** Take a named POI: capture its core. */
  | { t: "free"; id: string; poi: PoiId; reward: Reward }
  /** Bring home `n` of a valuable taken out of the named POI's bins. */
  | { t: "fetch"; id: string; poi: PoiId; kind: ValuableKind; n: number; reward: Reward }
  /** Destroy every member of the named squad. */
  | { t: "intercept"; id: string; target: InterceptTarget; reward: Reward };

export type ContractType = Contract["t"];

export const CONTRACT_NAME: Record<ContractType, string> = { free: "制圧", fetch: "回収", intercept: "迎撃" };

/** A day's board. */
export interface Board {
  day: number;
  contracts: Contract[];
}

/** What a board is built from. */
export interface BoardBasis {
  seed: number;
  day: number;
  poiState: Record<PoiId, { state: PoiHold }>;
  hideout: Hideout;
  stash: readonly { t: string; kind?: string }[];
  entries: readonly string[];
  depots: readonly PoiId[];
  /** Today's event and tomorrow's: today's may bring a contract of its own. */
  events?: readonly (IslandEvent | null)[];
}

const round50 = (n: number) => Math.round(n / 50) * 50;

/** A drone pack's region: the one its loop starts in. */
const packRegion = (name: string) => regionHere(PACKS.find((p) => p.name === name)?.patrol?.[0] ?? { x: 0, z: 0 }).id;

/** The region a contract sends the player to. */
export function contractRegion(c: Contract): RegionId {
  if (c.t !== "intercept") return poiRegion(c.poi).id;
  return targetRegion(c.target);
}

/** The region an intercept's target is in. */
const targetRegion = (t: InterceptTarget): RegionId => (t.t === "pack" ? packRegion(t.name) : t.region);

/** The squad key (`squadKey()`) an intercept's target is destroyed under. */
export const targetKey = (t: InterceptTarget) => (t.t === "party" ? partyKey(t.region) : t.t === "crew" ? crewKey(t.region) : t.name);

/** The target's name. */
export const targetName = (t: InterceptTarget) => (t.t === "party" ? `${regionOf(t.region).name}の${PARTY.name}` : t.t === "crew" ? `${CREW.name}（${regionOf(t.region).name}）` : t.name);

/** The contract's ask, in a line. */
export function contractText(c: Contract): string {
  switch (c.t) {
    case "free":
      return `${POIS[poiIndex(c.poi)].name}の核を制圧する`;
    case "fetch":
      return `${POIS[poiIndex(c.poi)].name}の補給箱から、${VALUABLES[c.kind].label}を ${c.n} 個持ち帰る`;
    case "intercept":
      return `${targetName(c.target)}を全滅させる`;
  }
}

/** The weapons an intercept may pay. */
const PAY_WEAPONS: WeaponKind[] = ["pike", "hornet", "maul", "lance", "talon"];

/**
 * The day's board, from the next raid's seed and the day: a contract to take a POI of the
 * enemy's on the front (not the titan's pad), to bring home a valuable the hideout's next buildable level lacks (else
 * one its POI is known for), and to destroy a drone pack or a hunting party, and on some days a
 * fourth (another POI to free, else another target). Places in the regions the camp can send the
 * player to come first; the others only when those have none.
 */
export function makeBoard(p: BoardBasis): Board {
  const hash = (k: number) => mix(Math.imul(p.seed + 1, 0x9e3779b1) ^ Math.imul(p.day + 7, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35));
  const reach = REGIONS.filter((r) => r.entries.some((e) => p.entries.includes(e)) || p.depots.some((d) => r.pois.includes(d))).map((r) => r.id);
  /** Of `list`, those in the regions within reach, else all of them. */
  const near = <T>(list: T[], region: (x: T) => RegionId) => {
    const inReach = list.filter((x) => reach.includes(region(x)));
    return inReach.length ? inReach : list;
  };
  const shuffle = <T>(list: T[], salt: number) => list.map((x, i) => ({ x, h: hash(salt * 31 + i) })).sort((a, b) => a.h - b.h).map((o) => o.x);
  const factor = (r: RegionId) => CONTRACT.region[r];
  const poiRegionOf = (id: PoiId) => REGIONS.find((r) => r.pois.includes(id))!.id;
  const out: Contract[] = [];
  const id = () => `d${p.day}-${out.length}`;
  const today = p.events?.[0] ?? null;
  const nodes = nodeHolds((id) => p.poiState[id].state);
  const strength = strengthFor(enemyNodes(nodes));

  // Free: a POI on the front (only those can be taken), paid by the garrison that stands there in the next raid.
  const front = frontNodes(nodes);
  const frees = shuffle(near(POIS.filter((o) => !o.boss && p.poiState[o.id].state !== "freed" && front[nodeIndex(o.id)]).map((o) => o.id), poiRegionOf), 1);
  const freeOf = (poi: PoiId): Contract => {
    const robots = garrison(poiIndex(poi), p.poiState[poi].state).reduce((n, sq) => n + sq.members.length, 0);
    return { t: "free", id: id(), poi, reward: { cash: round50(robots * CONTRACT.freePerRobot * factor(poiRegionOf(poi))), items: [] } };
  };
  let nextFree = 0;
  if (frees.length) out.push(freeOf(frees[nextFree++]));

  // Fetch: what the next level the hideout could build still lacks, from the POI whose bins hold it most.
  const have = (k: ValuableKind) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
  const lacking: ValuableKind[] = [];
  for (const m of MODULES) {
    const l = nextLevel(p.hideout, m);
    if (!l) continue;
    for (const [k, n] of l.items) if (have(k) < n && !lacking.includes(k) && POIS.some((o) => o.loot.valuable.some(([v]) => v === k))) lacking.push(k);
  }
  const share = (poi: (typeof POIS)[number], k: ValuableKind) => (poi.loot.valuable.find(([v]) => v === k)?.[1] ?? 0) / poi.loot.valuable.reduce((n, [, w]) => n + w, 0);
  let kind: ValuableKind;
  let at: (typeof POIS)[number];
  if (lacking.length) {
    kind = lacking[hash(2) % lacking.length];
    // The titan's pad only when no other POI's bins hold it.
    const safe = POIS.filter((o) => share(o, kind) > 0 && !o.boss);
    const holders = near(safe.length ? safe : POIS.filter((o) => share(o, kind) > 0), (o) => poiRegionOf(o.id));
    const best = Math.max(...holders.map((o) => share(o, kind)));
    const top = holders.filter((o) => share(o, kind) >= best * 0.75);
    at = top[hash(3) % top.length];
  } else {
    // The hideout lacks nothing it can build: a POI and what its bins hold most, the rarer on a tie.
    const pois = near(POIS.filter((o) => !o.boss), (o) => poiRegionOf(o.id));
    at = pois[hash(4) % pois.length];
    kind = [...at.loot.valuable].sort((a, b) => b[1] - a[1] || VALUABLES[b[0]].rarity - VALUABLES[a[0]].rarity)[0][0];
  }
  const bins = at.bins.filter((b) => !b.vault).length;
  const n = Math.max(1, Math.min(CONTRACT.fetchMax, Math.round(bins * share(at, kind))));
  out.push({
    t: "fetch",
    id: id(),
    poi: at.id,
    kind,
    n,
    reward: { cash: Math.max(CONTRACT.fetchMin, round50(n * VALUABLES[kind].value * CONTRACT.fetchShare * factor(poiRegionOf(at.id)))), items: [{ t: "valuable", kind }] },
  });

  // Intercept: a drone pack or a region's hunting party; on a crews' visit, the salvage crews first.
  const crews = today?.t === "crews" ? shuffle(near(REGIONS.map((r): InterceptTarget => ({ t: "crew", region: r.id })), targetRegion), 11).slice(0, 1) : [];
  const targets = [
    ...crews,
    ...shuffle(
      near([...activePacks(p.seed, strength).map((q): InterceptTarget => ({ t: "pack", name: q.name })), ...REGIONS.filter((r) => STRENGTH.levels[strength].parties[r.id] > 0).map((r): InterceptTarget => ({ t: "party", region: r.id }))], targetRegion),
      5,
    ),
  ];
  const interceptOf = (target: InterceptTarget, salt: number): Contract => {
    const region = targetRegion(target);
    const h = hash(salt);
    // A weapon paid rises a step every few days, no better than the trader's shelf (at least rare).
    const rarity = Math.min(3, 1 + Math.floor((p.day - 1) / CONTRACT.rarityEvery), Math.max(1, shopRarity(p))) as Rarity;
    const items: RewardItem[] = h % 3 === 0 ? [{ t: "weapon", kind: PAY_WEAPONS[(h >>> 4) % PAY_WEAPONS.length], rarity: rarity as 0 | 1 | 2 | 3 }] : h % 3 === 1 ? [{ t: "heal", kind: (h >>> 4) % 2 ? "battery" : "medkit" }] : [];
    return { t: "intercept", id: id(), target, reward: { cash: round50(CONTRACT.intercept[target.t] * factor(region)), items } };
  };
  out.push(interceptOf(targets[0], 6));

  // On some days a fourth: another POI to free, else another target.
  const count = CONTRACT.count[hash(8) % CONTRACT.count.length];
  if (count > out.length) {
    if (frees.length > nextFree) out.push(freeOf(frees[nextFree]));
    else if (targets.length > 1) out.push(interceptOf(targets[1], 9));
  }
  return { day: p.day, contracts: out };
}

/** A valuable that came home, and the POI (index) whose bin it came out of, or -1. */
export interface Fetched {
  kind: ValuableKind;
  from: number;
}

/** How far a raid has gone with a contract, for the objective card: the line, and whether its ask is met. */
export function contractProgress(c: Contract, s: State): { line: string; met: boolean } {
  switch (c.t) {
    case "free": {
      const i = poiIndex(c.poi);
      const name = POIS[i].name;
      const node = nodeIndex(c.poi);
      if (s.nodes[node] === "freed") return { line: `${name}：核を制圧した`, met: true };
      if (s.capture?.node === node) return { line: `${name}の核を制圧中 ${Math.floor(s.capture.t)}/${FRONT.capture} 秒`, met: false };
      return { line: `${name}：核を制圧する`, met: false };
    }
    case "fetch": {
      const i = poiIndex(c.poi);
      const got = [...haulOrigins(s.player).map((from, n) => ({ kind: s.player.haul[n], from })), ...sentOrigins(s)].filter((v) => v.kind === c.kind && v.from === i).length;
      return { line: `${VALUABLES[c.kind].label} ${Math.min(got, c.n)}/${c.n}（${POIS[i].name}）`, met: got >= c.n };
    }
    case "intercept": {
      const key = targetKey(c.target);
      if (s.stats.wiped.includes(key)) return { line: `${targetName(c.target)}：全滅させた`, met: true };
      if (c.target.t === "crew") {
        const region = c.target.region;
        if (region !== s.region) return { line: `${targetName(c.target)}：今日はこの地域に来ていない`, met: false };
        const here = s.squads.map((q, n) => ({ q, n })).filter(({ q, n }) => q.crew && s.enemies.some((e) => e.squad === n));
        if (!here.length) return { line: s.crewsDue.length ? `${targetName(c.target)}：まだ来ていない` : `${targetName(c.target)}：逃げられた`, met: false };
        const left = here.map(({ n }) => s.enemies.filter((e) => e.squad === n).length);
        return { line: `${targetName(c.target)}：残り ${Math.min(...left)}`, met: false };
      }
      const squads = s.squads.map((q, n) => ({ q, n })).filter(({ q }) => squadKey(q) === key);
      const left = squads.map(({ n }) => s.enemies.filter((e) => e.squad === n).length).filter((k) => k > 0);
      return { line: `${targetName(c.target)}：残り ${left.length ? Math.min(...left) : "-"}`, met: false };
    }
  }
}

/** The valuables sent home from a depot, with where each came from. */
export function sentOrigins(s: Pick<State, "sent"> & { sentAt?: number[] }): Fetched[] {
  const at = s.sentAt?.length === s.sent.length ? s.sentAt : s.sent.map(() => -1);
  return s.sent.map((kind, n) => ({ kind, from: at[n] }));
}

/**
 * Whether a settled raid did what a contract asked: the POI the player's overnight, the valuables of
 * its POI's bins come home (`home`), or the squad destroyed (which counts on a wipe too).
 */
export function contractDone(c: Contract, r: { freed: PoiId[]; home: Fetched[]; wiped: readonly string[] }): boolean {
  switch (c.t) {
    case "free":
      return r.freed.includes(c.poi);
    case "fetch":
      return r.home.filter((v) => v.kind === c.kind && v.from === poiIndex(c.poi)).length >= c.n;
    case "intercept":
      return r.wiped.includes(targetKey(c.target));
  }
}

/** Where a contract points on the map: a POI, a pack's loop, or a region (a hunting party walks all of it). */
export type ContractMark = { t: "poi"; x: number; z: number } | { t: "loop"; points: { x: number; z: number }[] } | { t: "region"; region: RegionId };

export function contractMark(c: Contract): ContractMark {
  if (c.t !== "intercept") {
    const o = POIS[poiIndex(c.poi)];
    return { t: "poi", x: o.x, z: o.z };
  }
  if (c.target.t !== "pack") return { t: "region", region: c.target.region };
  const name = c.target.name;
  return { t: "loop", points: [...(PACKS.find((q) => q.name === name)?.patrol ?? [])] };
}

/** A saved board, kept only when it is the day's and every contract in it reads; null otherwise. */
export function parseBoard(raw: unknown, day: number): Board | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.day !== day || !Array.isArray(o.contracts)) return null;
  const poi = (x: unknown) => typeof x === "string" && poiIndex(x as PoiId) >= 0;
  const reward = (x: unknown) => !!x && typeof x === "object" && typeof (x as Reward).cash === "number" && Array.isArray((x as Reward).items);
  const ok = (c: unknown): c is Contract => {
    if (!c || typeof c !== "object") return false;
    const x = c as Record<string, unknown>;
    if (typeof x.id !== "string" || !reward(x.reward)) return false;
    if (x.t === "free") return poi(x.poi);
    if (x.t === "fetch") return poi(x.poi) && typeof x.kind === "string" && x.kind in VALUABLES && Number.isInteger(x.n) && (x.n as number) > 0;
    if (x.t === "intercept") {
      const t = x.target as Record<string, unknown> | undefined;
      return !!t && ((t.t === "pack" && PACKS.some((q) => q.name === t.name)) || ((t.t === "party" || t.t === "crew") && REGIONS.some((r) => r.id === t.region)));
    }
    return false;
  };
  return o.contracts.every(ok) ? { day, contracts: o.contracts as Contract[] } : null;
}

/** What a contract asks of the raid, as the objective's steps read it (sim/objective.ts). */
export function contractTask(c: Contract): Task {
  switch (c.t) {
    case "free":
      return { t: "capture", node: nodeIndex(c.poi) };
    case "fetch":
      return { t: "fetch", poi: c.poi, kind: c.kind, n: c.n };
    case "intercept": {
      const loop = c.target.t === "pack" ? (PACKS.find((q) => q.name === (c.target as { name: string }).name)?.patrol?.[0] ?? undefined) : undefined;
      return { t: "intercept", key: targetKey(c.target), name: targetName(c.target), region: targetRegion(c.target), at: loop };
    }
  }
}
