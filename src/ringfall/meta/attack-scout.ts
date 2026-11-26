/*
 * CoC-style attack scouting for the departure screen (TKT-204 案 B):
 * list contested coastal hubs a neighbour holds, with defence + trophy preview.
 *
 * 作り順⑥ / 2026-11-26: order by trophy closeness within ±RAID_TARGET.trophyBand;
 * mark the leader (懸賞金) among eligible owners. No opponent-team preference.
 */
import { DEFENCE_AID } from "../sim/island";
import { isAiOwner, rivalOf } from "../sim/holds";
import { frontNodes, NEIGHBOURS } from "../sim/front";
import { NODES, nodeIndex, type NodeId } from "../sim/map";
import { aiFactory } from "./ai-islands";
import { contestedDefence } from "./contested-defence";
import { islandHolds, type Island } from "./island";
import { aiLabel, isContestedShore, neighbourNameByCode, type Neighbour } from "./neighbours";
import { SEIZE, raidOdds, trophiesTable, rivalTrophies, winBonusBase } from "./trophies";
import type { Parcel } from "./parcels";
import type { IslandLogEntry } from "./expeditions";
import type { Team } from "./team";
import {
  BOUNTY,
  canRaidOwner,
  foeOwnerKeys,
  isFoeTeamOwner,
  pickLeader,
  raidTargetRank,
} from "./war-score";

/** One attackable contested hub as the depart screen lists it. */
export interface AttackScout {
  id: NodeId;
  /** 「ツバキの浄水場」 / 「カゲウツ · AIの浄水場」 */
  title: string;
  owner: string;
  ownerName: string;
  hubName: string;
  factory: number;
  /** 島の守り grunts expected at the hub (capped). */
  guard: number;
  /**
   * Full ★★★ trophy gain N (raidOdds). Preview shows +N / −M.
   * @deprecated Prefer `win` — kept equal to win for older callers.
   */
  trop: number;
  /** 勝てば +N（★★★）. */
  win: number;
  /** 負ければ −M（0★）. */
  lose: number;
  /** Materials expected from 核 · 制圧 (empty reserve + bonus + bounty). */
  loot: number;
  /** League win-bonus materials at ★★★ for the attacker's band (TKT-219). 0 in 見習い. */
  winBonus: number;
  onFront: boolean;
  /** When not on the front: the enemy node to take first so this hub faces the player. */
  gate: string | null;
  x: number;
  z: number;
  /** Owner is on the current 相手チーム (badge only; not a sort key). */
  foeTeam?: boolean;
  /** Taking this hub pays the leader bounty. */
  bounty?: boolean;
}

/** Optional 作り順⑥ context for bounty / foe badge. */
export type AttackScoutOpts = {
  /** Current 部隊戦 foe team (bounty / badge only — not raid gating). */
  foe?: Pick<Team, "members"> | null;
};

/**
 * Contested coastal hubs held by a neighbour, for the 攻める list.
 * Filter by trophy band (RAID_TARGET.requireBand); sort by trophy closeness then distance.
 * Front ones still float above shut rows.
 */
export function attackScouts(
  poiState: Island,
  day: number,
  neighbours: readonly Neighbour[],
  selfTrop: number,
  parcels: readonly Parcel[] = [],
  salt = 0,
  from: { x: number; z: number } = { x: 0, z: 0 },
  opts: AttackScoutOpts = {},
): AttackScout[] {
  const holds = islandHolds({ poiState });
  const front = frontNodes(holds);
  const defence = new Map(contestedDefence(poiState, day, neighbours, salt).map((d) => [d.owner, d.factory]));
  const table = trophiesTable(neighbours);
  const guardAt = (id: NodeId) => Math.min(DEFENCE_AID, parcels.filter((q) => q.poi === id).length);
  const foeKeys = foeOwnerKeys(opts.foe ?? null);

  const rows: AttackScout[] = [];
  for (const n of NODES) {
    if (!isContestedShore(n.id)) continue;
    const i = nodeIndex(n.id);
    const who = rivalOf(holds[i]);
    if (!who) continue;
    const rivalTrop = rivalTrophies(who, selfTrop, table);
    if (!canRaidOwner(who, selfTrop, rivalTrop)) continue;
    const hit = neighbours.find((x) => x.code === who || (isAiOwner(who) && x.code === who.slice(3)));
    const bare = hit?.name ?? neighbourNameByCode(who, neighbours) ?? "他のプレイヤー";
    const ownerName = hit?.ai || isAiOwner(who) ? aiLabel(bare) : bare;
    const factory =
      defence.get(who) ??
      (Number.isFinite(hit?.factory) ? Math.max(0, Math.round(hit!.factory!)) : aiFactory(hit?.day ?? day));
    const onFront = !!front[i];
    let gate: string | null = null;
    if (!onFront) {
      const k = NEIGHBOURS[i]
        .filter((j) => front[j] && holds[j] === "foe")
        .sort((a, b) => Math.hypot(NODES[a].x - from.x, NODES[a].z - from.z) - Math.hypot(NODES[b].x - from.x, NODES[b].z - from.z))[0];
      if (k !== undefined) gate = NODES[k].name;
    }
    const foeTeam = isFoeTeamOwner(who, foeKeys);
    const { N, M } = raidOdds(selfTrop, rivalTrop);
    rows.push({
      id: n.id,
      title: `${ownerName}の${n.name}`,
      owner: who,
      ownerName,
      hubName: n.name,
      factory: Math.max(0, Math.round(factory)),
      guard: guardAt(n.id),
      trop: N,
      win: N,
      lose: M,
      loot: SEIZE.emptyReserve + SEIZE.bonus,
      winBonus: winBonusBase(selfTrop),
      onFront,
      gate,
      x: n.x,
      z: n.z,
      ...(foeTeam ? { foeTeam: true } : {}),
    });
  }

  // Leader among eligible owners: most outer (neighbour.held), then trophies.
  const byOwner = new Map<string, { id: string; outer?: number; trophies?: number }>();
  for (const r of rows) {
    if (byOwner.has(r.owner)) continue;
    const hit = neighbours.find((x) => x.code === r.owner || (isAiOwner(r.owner) && x.code === r.owner.slice(3)));
    byOwner.set(r.owner, {
      id: r.owner,
      outer: hit?.held,
      trophies: hit?.trophies ?? rivalTrophies(r.owner, selfTrop, table),
    });
  }
  const leader = pickLeader([...byOwner.values()]);
  if (leader) {
    for (const r of rows) {
      if (r.owner !== leader) continue;
      r.bounty = true;
      r.loot = SEIZE.emptyReserve + SEIZE.bonus + BOUNTY.extraMaterials;
    }
  }

  return rows.sort((a, b) => {
    if (a.onFront !== b.onFront) return Number(b.onFront) - Number(a.onFront);
    const ra = raidTargetRank(selfTrop, rivalTrophies(a.owner, selfTrop, table), Math.hypot(a.x - from.x, a.z - from.z));
    const rb = raidTargetRank(selfTrop, rivalTrophies(b.owner, selfTrop, table), Math.hypot(b.x - from.x, b.z - from.z));
    return ra - rb;
  });
}

/**
 * Hub still held by the attacker after a 「取られた」 entry — the やり返す target (TKT-204 案 F).
 * Null when the node is no longer rival-held (already taken back) or is not contested.
 */
export function revengeNode(poiState: Island, entry: Pick<IslandLogEntry, "t" | "node">): NodeId | null {
  if (entry.t !== "taken") return null;
  const id = entry.node as NodeId;
  if (!isContestedShore(id) || nodeIndex(id) < 0) return null;
  const who = rivalOf(poiState[id]?.state ?? "foe");
  return who ? id : null;
}

/**
 * Parse a stored 島の知らせ line for 「取られた」 and resolve the hub while it stays rival-held.
 * 【形】{誰}に{拠点}を取られた · …
 */
export function revengeNodeFromLine(poiState: Island, line: string): NodeId | null {
  const m = /^(.+?)に(.+?)を取られた/.exec(line.trim());
  if (!m) return null;
  const hub = m[2];
  const n = NODES.find((x) => x.name === hub && isContestedShore(x.id));
  if (!n) return null;
  return rivalOf(poiState[n.id]?.state ?? "foe") ? n.id : null;
}
