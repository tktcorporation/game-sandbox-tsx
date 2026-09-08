import { FURNITURE } from "./furniture";
import { displayName, elementMod, speciesOf, SPECIES } from "./species";
import type {
  FurnitureId,
  OwnedTata,
  PartySlot,
  PlacedFurniture,
  Species,
  Stage,
  TataGameState,
} from "./types";
import {
  BERRY_CAP,
  FEED_COST,
  FEED_XP,
  PARTY_SIZE,
  PET_COOLDOWN_MS,
  POWER_COST,
  POWER_MAX,
  SCRAP_CAP,
  SHARD_CAP,
  STAGE_XP,
  STAMINA_MAX,
  STAMINA_MS,
  YARD_H,
  YARD_W,
} from "./types";

export function now(): number {
  return Date.now();
}

export function newId(prefix = "t"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function initialState(): TataGameState {
  return {
    berries: 18,
    shards: 2,
    scrap: 10,
    stamina: STAMINA_MAX,
    staminaAt: now(),
    started: false,
    tatas: [],
    furniture: [{ id: "nest-start", type: "nest", x: 3, y: 3 }],
    seen: [],
    waveBest: 0,
    nestAt: now(),
  };
}

export function hatchTata(speciesId: string, shiny = false): OwnedTata {
  return {
    uid: newId(),
    speciesId,
    stage: 0,
    shiny,
    xp: 0,
    bond: 0,
    power: 0,
    lastPetAt: 0,
    partySlot: null,
  };
}

export function currentStamina(state: TataGameState, t = now()): number {
  if (state.stamina >= STAMINA_MAX) return STAMINA_MAX;
  const gained = Math.floor((t - state.staminaAt) / STAMINA_MS);
  return clamp(state.stamina + gained, 0, STAMINA_MAX);
}

export function spendStamina(state: TataGameState, n = 1): TataGameState | null {
  const t = now();
  const stam = currentStamina(state, t);
  if (stam < n) return null;
  return { ...state, stamina: stam - n, staminaAt: t };
}

export function addBerries(state: TataGameState, n: number): TataGameState {
  return { ...state, berries: clamp(state.berries + n, 0, BERRY_CAP) };
}

export function addShards(state: TataGameState, n: number): TataGameState {
  return { ...state, shards: clamp(state.shards + n, 0, SHARD_CAP) };
}

export function addScrap(state: TataGameState, n: number): TataGameState {
  return { ...state, scrap: clamp(state.scrap + n, 0, SCRAP_CAP) };
}

export function dexCount(state: TataGameState): { owned: number; total: number } {
  const ids = new Set(state.tatas.map((t) => t.speciesId));
  return { owned: ids.size, total: SPECIES.length };
}

export function hasFurniture(state: { furniture: PlacedFurniture[] }, type: FurnitureId): boolean {
  return state.furniture.some((f) => f.type === type);
}

export function feedCost(state: TataGameState): number {
  return hasFurniture(state, "snack") ? FEED_COST - 1 : FEED_COST;
}

export function stageMult(stage: Stage): number {
  return 1 + stage * 0.42;
}

export function tataHp(tata: OwnedTata): number {
  const s = speciesOf(tata.speciesId);
  const shiny = tata.shiny ? 1.12 : 1;
  const role = s.role === "tank" ? 1.18 : 1;
  return Math.round(s.baseHp * stageMult(tata.stage) * shiny * role * (1 + tata.power * 0.06));
}

export function tataAtk(tata: OwnedTata, lanternBonus: boolean): number {
  const s = speciesOf(tata.speciesId);
  const shiny = tata.shiny ? 1.15 : 1;
  const role = s.role === "dps" ? 1.16 : s.role === "support" ? 0.92 : 1;
  const light = lanternBonus && s.element === "light" ? 1.12 : 1;
  return Math.round(s.baseAtk * stageMult(tata.stage) * shiny * role * (1 + tata.power * 0.08) * light);
}

export function canEvolve(tata: OwnedTata): boolean {
  if (tata.stage >= 3) return false;
  return tata.xp >= STAGE_XP[tata.stage];
}

export function evolve(tata: OwnedTata, rng: () => number): { tata: OwnedTata; shinyUnlock: boolean } {
  if (!canEvolve(tata)) return { tata, shinyUnlock: false };
  const next = (tata.stage + 1) as Stage;
  let shiny = tata.shiny;
  let shinyUnlock = false;
  if (!shiny && next === 3 && rng() < 0.12) {
    shiny = true;
    shinyUnlock = true;
  }
  return {
    tata: { ...tata, stage: next, xp: 0, bond: tata.bond + 2 },
    shinyUnlock,
  };
}

export function feedTata(state: TataGameState, uid: string): { state: TataGameState; evolved: boolean; shinyUnlock: boolean; reason?: string } {
  const tata = state.tatas.find((t) => t.uid === uid);
  if (!tata) return { state, evolved: false, shinyUnlock: false, reason: "いない" };
  const cost = feedCost(state);
  if (state.berries < cost) return { state, evolved: false, shinyUnlock: false, reason: "きのみが足りない" };
  const fed: OwnedTata = { ...tata, xp: tata.xp + FEED_XP, bond: tata.bond + 1 };
  let next = fed;
  let evolved = false;
  let shinyUnlock = false;
  if (canEvolve(fed)) {
    const r = evolve(fed, Math.random);
    next = r.tata;
    evolved = true;
    shinyUnlock = r.shinyUnlock;
  }
  return {
    state: {
      ...addBerries(state, -cost),
      tatas: state.tatas.map((t) => (t.uid === uid ? next : t)),
    },
    evolved,
    shinyUnlock,
  };
}

export function powerUp(state: TataGameState, uid: string): { state: TataGameState; reason?: string } {
  const tata = state.tatas.find((t) => t.uid === uid);
  if (!tata) return { state, reason: "いない" };
  if (tata.power >= POWER_MAX) return { state, reason: "もう限界" };
  if (state.shards < POWER_COST) return { state, reason: "かけらが足りない" };
  return {
    state: {
      ...addShards(state, -POWER_COST),
      tatas: state.tatas.map((t) => (t.uid === uid ? { ...t, power: t.power + 1 } : t)),
    },
  };
}

export function petTata(state: TataGameState, uid: string, t = now()): { state: TataGameState; berries: number; poolFun: boolean; reason?: string } {
  const tata = state.tatas.find((x) => x.uid === uid);
  if (!tata) return { state, berries: 0, poolFun: false, reason: "いない" };
  if (t - tata.lastPetAt < PET_COOLDOWN_MS) return { state, berries: 0, poolFun: false, reason: "まだくすぐったい" };
  const s = speciesOf(tata.speciesId);
  const bounce = hasFurniture(state, "bounce");
  const garden = hasFurniture(state, "garden") && s.element === "grass";
  const poolFun = s.id === "nekoori" && hasFurniture(state, "pool");
  let berries = 1;
  if (garden) berries += 1;
  if (poolFun) berries += 2;
  const bond = tata.bond + (bounce ? 2 : 1) + (poolFun ? 2 : 0);
  return {
    state: addBerries(
      {
        ...state,
        tatas: state.tatas.map((x) => (x.uid === uid ? { ...x, lastPetAt: t, bond } : x)),
      },
      berries,
    ),
    berries,
    poolFun,
  };
}

export function assignParty(state: TataGameState, uid: string, slot: PartySlot | null): TataGameState {
  const tatas = state.tatas.map((t) => {
    if (t.uid === uid) return { ...t, partySlot: slot };
    if (slot !== null && t.partySlot === slot) return { ...t, partySlot: null };
    return t;
  });
  return { ...state, tatas };
}

export function partyOf(state: { tatas: OwnedTata[] }): OwnedTata[] {
  const slots: (OwnedTata | null)[] = [null, null, null];
  for (const t of state.tatas) {
    if (t.partySlot !== null) slots[t.partySlot] = t;
  }
  return slots.filter((t): t is OwnedTata => t !== null);
}

export function autoFillParty(state: TataGameState): TataGameState {
  if (partyOf(state).length >= PARTY_SIZE) return state;
  const used = new Set(partyOf(state).map((t) => t.uid));
  const ranked = [...state.tatas]
    .filter((t) => !used.has(t.uid))
    .sort((a, b) => tataAtk(b, false) + tataHp(b) - (tataAtk(a, false) + tataHp(a)));
  const tatas = state.tatas.map((t) => ({ ...t }));
  for (let slot = 0; slot < PARTY_SIZE; slot++) {
    if (tatas.some((t) => t.partySlot === slot)) continue;
    const next = ranked.shift();
    if (!next) break;
    const live = tatas.find((t) => t.uid === next.uid);
    if (live) live.partySlot = slot as PartySlot;
  }
  return { ...state, tatas };
}

export function furnitureAt(furn: PlacedFurniture[], x: number, y: number, ignore?: string): PlacedFurniture | undefined {
  return furn.find((f) => {
    if (ignore && f.id === ignore) return false;
    const def = FURNITURE[f.type];
    return x >= f.x && x < f.x + def.w && y >= f.y && y < f.y + def.h;
  });
}

export function canPlaceFurniture(
  furn: PlacedFurniture[],
  type: FurnitureId,
  x: number,
  y: number,
  ignore?: string,
): boolean {
  const def = FURNITURE[type];
  if (x < 0 || y < 0 || x + def.w > YARD_W || y + def.h > YARD_H) return false;
  for (let dy = 0; dy < def.h; dy++) {
    for (let dx = 0; dx < def.w; dx++) {
      if (furnitureAt(furn, x + dx, y + dy, ignore)) return false;
    }
  }
  return true;
}

export function placeFurniture(state: TataGameState, type: FurnitureId, x: number, y: number): { state: TataGameState; reason?: string } {
  const def = FURNITURE[type];
  if (state.scrap < def.scrap) return { state, reason: "くずが足りない" };
  if (!canPlaceFurniture(state.furniture, type, x, y)) return { state, reason: "おけない" };
  const placed: PlacedFurniture = { id: newId("f"), type, x, y };
  return {
    state: addScrap({ ...state, furniture: [...state.furniture, placed] }, -def.scrap),
  };
}

export function nestBerries(state: TataGameState, t = now()): number {
  const nests = state.furniture.filter((f) => f.type === "nest").length;
  if (nests === 0) return 0;
  const elapsed = Math.max(0, t - state.nestAt);
  return Math.min(24, Math.floor((elapsed / 22000) * nests));
}

export function collectNests(state: TataGameState): { state: TataGameState; amount: number } {
  const amount = nestBerries(state);
  if (amount <= 0) return { state, amount: 0 };
  return { state: addBerries({ ...state, nestAt: now() }, amount), amount };
}

export function startAdventure(state: TataGameState, starterId: string): TataGameState {
  const starter = hatchTata(starterId, false);
  starter.stage = 1;
  starter.partySlot = 0;
  const stone = hatchTata("nanmonaishi", false);
  stone.partySlot = 1;
  return {
    ...state,
    started: true,
    berries: 24,
    stamina: STAMINA_MAX,
    staminaAt: now(),
    nestAt: now(),
    seen: [starterId, "nanmonaishi"],
    tatas: [starter, stone],
  };
}

export type StrollFind =
  | { kind: "tata"; speciesId: string; shiny: boolean }
  | { kind: "berries"; n: number }
  | { kind: "scrap"; n: number }
  | { kind: "wind" };

export function pickWildSpecies(ownedIds: Set<string>, rng: () => number): string {
  const missing = SPECIES.filter((s) => !ownedIds.has(s.id));
  const pool = missing.length > 0 && rng() < 0.72 ? missing : SPECIES;
  const weighted: Species[] = [];
  for (const s of pool) {
    const w = s.rarity === 1 ? 10 : s.rarity === 2 ? 5 : s.rarity === 3 ? 2 : 1;
    for (let i = 0; i < w; i++) weighted.push(s);
  }
  return weighted[Math.floor(rng() * weighted.length)]!.id;
}

export function stroll(state: TataGameState, seed: number): { state: TataGameState; find: StrollFind; reason?: string } {
  const spent = spendStamina(state);
  if (!spent) return { state, find: { kind: "wind" }, reason: "つかれた。すこし待って" };
  const rng = mulberry32(seed);
  const roll = rng();
  const owned = new Set(spent.tatas.map((t) => t.speciesId));
  if (roll < 0.48) {
    const speciesId = pickWildSpecies(owned, rng);
    const shiny = rng() < 1 / 28;
    const seen = spent.seen.includes(speciesId) ? spent.seen : [...spent.seen, speciesId];
    return { state: { ...spent, seen }, find: { kind: "tata", speciesId, shiny } };
  }
  if (roll < 0.74) {
    const n = 2 + Math.floor(rng() * 4);
    return { state: addBerries(spent, n), find: { kind: "berries", n } };
  }
  if (roll < 0.9) {
    const n = 1 + Math.floor(rng() * 3);
    return { state: addScrap(spent, n), find: { kind: "scrap", n } };
  }
  return { state: spent, find: { kind: "wind" } };
}

export function befriend(state: TataGameState, speciesId: string, shiny: boolean): { state: TataGameState; reason?: string } {
  const cost = 2 + speciesOf(speciesId).rarity;
  if (state.berries < cost) return { state, reason: `きのみが${cost}こいる` };
  const tata = hatchTata(speciesId, shiny);
  const seen = state.seen.includes(speciesId) ? state.seen : [...state.seen, speciesId];
  return {
    state: {
      ...addBerries(state, -cost),
      tatas: [...state.tatas, tata],
      seen,
    },
  };
}

export function catchCost(speciesId: string): number {
  return 2 + speciesOf(speciesId).rarity;
}

export function battleRewards(wavesCleared: number, win: boolean): { berries: number; shards: number; scrap: number } {
  const base = wavesCleared;
  return {
    berries: base * 3 + (win ? 6 : 0),
    shards: Math.max(0, Math.floor(wavesCleared / 2) + (win ? 2 : 0)),
    scrap: Math.max(0, Math.floor(wavesCleared / 2) + (win ? 1 : 0)),
  };
}

export function labelTata(tata: OwnedTata): string {
  return displayName(speciesOf(tata.speciesId), tata.stage, tata.shiny);
}

export { elementMod };
