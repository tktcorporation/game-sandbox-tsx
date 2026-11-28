/*
 * A sortie set out from a core of the player's during a raid of the island (`State.jumps`, the
 * `sortieOut` event): the raid of the island waits as it stands, clock and all, while the sortie is
 * played at the other player's same node as a run of its own (`Start.sortie`), and takes the
 * player back at the core they left when it ends.
 *
 * What the player carries goes with them both ways: health, armour, weapons, heals, the bag, keys,
 * tools, mod parts and the leap's charge. A wipe in the sortie is the raid's wipe. Nothing here
 * reads or writes the profile; what the sortie won is settled by `settleSortie()` in meta/profile.ts.
 */
import { finishBattle } from "./battle";
import type { Rarity } from "./config";
import { nodeIndex } from "./map";
import { newRun, type Kit, type Player, type Start, type State } from "./state";

/** The run's own seed for the sortie from `node` at `time` of the raid seeded `seed`. */
const jumpSeed = (seed: number, node: number, time: number) => ((Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(node + 1, 0xc2b2ae35) ^ Math.floor(time)) >>> 0) || 1;

/** What the player carries, as the kit a run starts from. */
const kitOf = (p: Player): Kit => ({
  weapons: p.weapons.flatMap((w) => (w ? [{ kind: w.kind, rarity: w.rarity, ...(w.starter ? { starter: true } : {}) }] : [])),
  armor: p.armor as Rarity,
  heals: { ...p.heals },
  keys: [...p.keys],
});

/** Moves what `from` carries onto `to`, which keeps where it stands and how it moves. */
function carry(from: Player, to: Player) {
  to.hp = from.hp;
  to.shield = from.shield;
  to.armor = from.armor;
  to.weapons = from.weapons.map((w) => (w ? { ...w } : null));
  to.slot = from.slot;
  to.heals = { ...from.heals };
  to.flares = from.flares;
  to.haul = [...from.haul];
  to.haulAt = from.haul.map(() => -1);
  to.keys = [...from.keys];
  to.tools = [...from.tools];
  to.mods = [...from.mods];
  to.ult = from.ult;
  to.tactical = from.tactical;
  to.selfRevive = from.selfRevive;
  to.sinceHurt = from.sinceHurt;
}

/**
 * The sortie's run, set out from the raid `island` as it stands: played at `sortie`'s holding from
 * its depot, with what the player carries and the stash room the raid has left.
 */
export function jumpOut(island: State, sortie: NonNullable<Start["sortie"]>, routes: Start["routes"]): State {
  const p = island.player;
  const out = newRun(jumpSeed(island.seed, nodeIndex(sortie.id), island.time), kitOf(p), island.region, {
    sortie,
    routes,
    known: island.known,
    stashRoom: island.stashRoom,
    stashWant: island.stashWant,
  });
  carry(p, out.player);
  if (island.ally.active && out.ally.active) {
    out.ally.hp = island.ally.hp;
    out.ally.shield = island.ally.shield;
    // A teammate down at the core goes along still down: the revive is owed there as here.
    out.ally.down = island.ally.down;
    out.ally.helped = 0;
    out.ally.rescue = 0;
  }
  return out;
}

/**
 * Back at the core: `island` takes what the player carries out of the sortie `out` as it ended.
 * A wipe there ends the raid of the island as a wipe, its battle reckoned to the end. Returns whether the raid goes on; when it
 * does not, the caller tells the view of the raid's end.
 */
export function jumpBack(island: State, out: State): boolean {
  const origin = [...island.player.haulAt];
  const before = [...island.player.haul];
  carry(out.player, island.player);
  // What was in the bag before and still is keeps where it was found; what the sortie added has no POI of this island.
  const left = before.map((k, i) => ({ k, at: origin[i] ?? -1 }));
  island.player.haulAt = island.player.haul.map((k) => {
    const j = left.findIndex((o) => o.k === k);
    return j < 0 ? -1 : left.splice(j, 1)[0].at;
  });
  island.stashRoom = out.stashRoom;
  if (island.ally.active && out.ally.active) {
    island.ally.hp = out.ally.hp;
    island.ally.shield = out.ally.shield;
    island.ally.down = out.ally.down;
    island.ally.helped = 0;
    island.ally.rescue = 0;
  }
  // A sortie that ended with the player down (its time ran out) brings them back down: the revive is still owed.
  island.player.downed = out.player.downed;
  island.player.awaitAlly = out.player.awaitAlly;
  island.player.healing = null;
  island.player.search = null;
  if (out.outcome === "extracted") return true;
  island.player.hp = 0;
  island.capture = null;
  island.leaving = null;
  island.phase = "done";
  island.outcome = out.outcome ?? "dead";
  // The raid ends here as any raid does: the rest of the island's battle is reckoned, so the nodes stand as it ended.
  finishBattle(island);
  return false;
}
