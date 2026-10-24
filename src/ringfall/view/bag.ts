import { BAG, HIDEOUT, MODS, TOOLS, VALUABLES, type ModKind, type ToolKind, type ValuableKind } from "../sim/config";
import { POIS, poiIndex, recordSpot, ROUTES, type RecordId } from "../sim/map";
import type { State } from "../sim/state";
import { factoryNeeded, newProfile, nextFactory, pouchKeep, takenContract, wanted, type Profile } from "../meta/profile";
import { MODULES, nextLevel, pouchSlots, stillNeeded } from "../meta/hideout";
import { offered, need } from "../meta/quests";
import { storyOf } from "../meta/story";
import { RARITY_CSS } from "./models";
import { bagIcon, checkIcon, crossIcon, factoryIcon, hideoutIcon, keyIcon, modIcon, paperIcon, POUCH, pouchIcon, routeIcon } from "./icons";

/*
 * What the player carries, for a glance during a raid: the bag peek (Tab held, or the bag button
 * held on a phone) and the card that slides in when something enters the bag. Both read the raid's
 * state and the profile the raid started from, and change neither: there is nothing to manage.
 * Each thing is drawn as its slots in its rarity's colour, its name, its credits and what it is
 * for, as the base's marks with numbers: a hideout module or the factory whose next level takes it,
 * a quest or the contract taken that asks for it, the route a tool opens; the pouch's mark on what
 * a wipe would still bring home.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** One line of the bag: alike things counted together. */
interface Entry {
  /** What the line is, for telling a pickup's card which line to show. */
  id: string;
  size: number;
  color: string;
  name: string;
  n: number;
  /** Credits, for all `n` (0 for none). */
  value: number;
  /** Marks with numbers (markup). */
  uses: string;
  /** How many of the `n` the pouch keeps through a wipe. */
  kept: number;
}

const chip = (html: string, cls = "") => `<span class="bp-use${cls ? ` ${cls}` : ""}">${html}</span>`;

/** What a valuable is for, from the profile: the modules and factory level that take it, the quests and the contract taken that ask for it. */
function valuableUses(p: Profile, s: State, k: ValuableKind, from: number[]): string {
  const out: string[] = [];
  // Covered: the stash already holds all that the hideout and the factory will take of it.
  const done = wanted(p)[k] <= 0;
  const tick = done ? checkIcon() : "";
  const cls = done ? "done" : "";
  const soon = MODULES.map((m) => [m, nextLevel(p.hideout, m)?.items.find(([x]) => x === k)?.[1] ?? 0] as const).filter(([, n]) => n > 0);
  for (const [m, n] of soon) out.push(chip(`${hideoutIcon()}${esc(HIDEOUT[m].name)}<b>${n}</b>${tick}`, cls));
  const later = stillNeeded(p.hideout)[k];
  if (!soon.length && later > 0) out.push(chip(`${hideoutIcon()}<b>${later}</b>${tick}`, cls));
  const next = nextFactory(p)?.items.find(([x]) => x === k)?.[1] ?? 0;
  if (next) out.push(chip(`${factoryIcon()}Lv${p.factory + 1}<b>${next}</b>${tick}`, cls));
  else if (factoryNeeded(p)[k] > 0) out.push(chip(`${factoryIcon()}<b>${factoryNeeded(p)[k]}</b>${tick}`, cls));
  for (const q of offered(p.quests)) if (q.goal.t === "deliver" && q.goal.valuable === k) out.push(chip(`${paperIcon()}${esc(q.title)}<b>${need(q.goal)}</b>`));
  const c = takenContract(p);
  if (c?.t === "fetch" && c.kind === k) {
    // Only what came out of the contract's POI's bins counts toward it.
    const at = poiIndex(c.poi);
    const here = from.filter((f) => f === at).length;
    const got = here + s.sent.filter((x, i) => x === k && s.sentAt[i] === at).length;
    out.push(chip(`${paperIcon()}${esc(POIS[at].name)}<b>${Math.min(got, c.n)}/${c.n}</b>`, here ? "" : "off"));
  }
  return out.join("");
}

/** The routes a tool would open, in the order `settle()` spends tools on them: one closed route per tool carried. */
function toolUses(p: Profile, k: ToolKind, n: number): string {
  return ROUTES.filter((r) => r.tool === k && !p.routes.includes(r.id))
    .slice(0, n)
    .map((r) => chip(`${routeIcon(false)}${esc(r.name)}`))
    .join("");
}

/** The bag's lines: what the pouch keeps first, then by credits. */
function entries(p: Profile, s: State): Entry[] {
  const pl = s.player;
  const kept = pouchKeep(pl.haul, pl.tools, pouchSlots(p.hideout), pl.records);
  const out: Entry[] = [];
  const keptHaul = new Set(kept.at);
  for (const k of [...new Set(pl.haul)]) {
    const at = pl.haul.flatMap((x, i) => (x === k ? [i] : []));
    const v = VALUABLES[k];
    out.push({ id: `v:${k}`, size: v.size, color: RARITY_CSS[v.rarity], name: v.label, n: at.length, value: v.value * at.length, uses: valuableUses(p, s, k, at.map((i) => pl.haulAt[i])), kept: at.filter((i) => keptHaul.has(i)).length });
  }
  for (const k of [...new Set(pl.tools)]) {
    const n = pl.tools.filter((x) => x === k).length;
    out.push({ id: `t:${k}`, size: TOOLS[k].size, color: RARITY_CSS[3], name: TOOLS[k].label, n, value: TOOLS[k].value * n, uses: toolUses(p, k, n), kept: kept.tools.filter((x) => x === k).length });
  }
  for (const r of [...new Set(pl.records)]) {
    const st = storyOf(r);
    out.push({ id: `r:${r}`, size: 1, color: RARITY_CSS[3], name: recordSpot(r).name, n: 1, value: st.cash, uses: chip(`${paperIcon()}${esc(st.title)}`), kept: kept.records.includes(r) ? 1 : 0 });
  }
  return out.sort((a, b) => Number(b.kept > 0) - Number(a.kept > 0) || b.value - a.value);
}

/** An entry's line: its slots, its name and count, what it is for, the pouch's mark, its credits. */
function row(e: Entry, one = false): string {
  const n = one ? 1 : e.n;
  const kept = one ? Math.min(1, e.kept) : e.kept;
  const value = one ? e.value / e.n : e.value;
  const cells = Array.from({ length: e.size }, () => `<i${kept ? ' class="p"' : ""}></i>`).join("");
  const pouch = kept ? `<span class="bp-pouch">${pouchIcon()}${kept > 1 || (kept && n > 1) ? `<b>${kept}</b>` : ""}</span>` : "";
  return `<div class="bp-row${kept ? " kept" : ""}"><span class="bp-pic" style="--c:${e.color}">${cells}</span><span class="bp-name" style="color:${e.color}">${esc(e.name)}${n > 1 ? `<i>×${n}</i>` : ""}</span>${pouch}<b class="bp-val">${value || ""}</b><span class="bp-uses">${e.uses}</span></div>`;
}

/** What the player has on them outside the bag's slots: keys and mod parts worn. */
function extras(s: State): string {
  const keys = s.player.keys.map((k) => `<span class="bp-x" style="color:${RARITY_CSS[3]}">${keyIcon()}${esc(POIS[k].name)}</span>`);
  const mods = s.player.mods.map((m) => `<span class="bp-x mod">${modIcon()}${esc(MODS[m].name)}</span>`);
  return keys.length || mods.length ? `<div class="bp-extra">${[...keys, ...mods].join("")}</div>` : "";
}

/** Everything a pickup can add, counted, to tell what came in and what went out between two frames. */
function census(s: State): Map<string, number> {
  const m = new Map<string, number>();
  const add = (k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const p = s.player;
  for (const k of p.haul) add(`v:${k}`);
  for (const k of p.tools) add(`t:${k}`);
  for (const r of p.records) add(`r:${r}`);
  for (const k of p.keys) add(`k:${k}`);
  for (const k of p.mods) add(`m:${k}`);
  return m;
}

/** A thing by its census key, as a short line for what left the bag (struck through on a card). */
function lostName(id: string): string {
  const [t, k] = id.split(":");
  if (t === "v") return VALUABLES[k as ValuableKind].label;
  if (t === "t") return TOOLS[k as ToolKind].label;
  if (t === "m") return MODS[k as ModKind].name;
  if (t === "r") return recordSpot(k as RecordId).name;
  return POIS[Number(k)].name;
}

/** Seconds a pickup's card stays, and how many stand at once. */
const CARD_LIFE = 2.2;
const CARD_MAX = 3;
/** Seconds a card takes to slide in, and to fade before it goes. */
const CARD_IN = 0.18;
const CARD_OUT = 0.3;

export class BagView {
  private profile: Profile = newProfile();
  private peekEl = document.getElementById("bag-peek")!;
  private cardsEl = document.getElementById("bag-cards")!;
  private open = false;
  private lastHtml = "";
  private seen: { state: State | null; count: Map<string, number> } = { state: null, count: new Map() };
  private cards: { el: HTMLElement; t: number }[] = [];

  /** The profile the raid started from: what the hideout, the factory, the quests and the contract taken ask for. */
  setProfile(p: Profile) {
    this.profile = p;
    this.lastHtml = "";
  }

  get peeking() {
    return this.open;
  }

  peek(on: boolean) {
    this.open = on;
    this.peekEl.hidden = !on;
    document.body.classList.toggle("peeking", on);
  }

  /** Clears the cards and forgets the bag, for a raid's end. */
  reset() {
    for (const c of this.cards) c.el.remove();
    this.cards = [];
    this.seen = { state: null, count: new Map() };
    this.peek(false);
  }

  /** `strip`: the bag's slots as the objective card draws them. */
  frame(s: State, dt: number, strip: string) {
    this.pickups(s);
    for (const c of this.cards) c.t -= dt;
    for (const c of this.cards.filter((x) => x.t <= 0)) c.el.remove();
    this.cards = this.cards.filter((x) => x.t > 0);
    // The slide in and the fade out follow the game's clock, not the page's animations.
    for (const c of this.cards) {
      const age = CARD_LIFE - c.t;
      const inn = Math.min(1, age / CARD_IN);
      const out = Math.min(1, c.t / CARD_OUT);
      c.el.style.opacity = String(Math.min(inn, out));
      c.el.style.transform = inn < 1 ? `translateX(${Math.round((1 - inn) * (1 - inn) * 40)}px)` : "";
    }
    if (!this.open) return;
    const list = entries(this.profile, s);
    const worth = list.reduce((n, e) => n + (e.id.startsWith("r:") ? 0 : e.value), 0);
    const load = s.player.haul.reduce((n, k) => n + VALUABLES[k].size, 0) + s.player.tools.reduce((n, k) => n + TOOLS[k].size, 0) + s.player.records.length;
    const head = `<div class="bp-head">${bagIcon()}<b>${load}/${BAG.slots}</b>${strip}<b class="bp-worth">${worth}</b><span class="bp-slots" style="color:${POUCH}">${pouchIcon()}<b>${pouchSlots(this.profile.hideout)}</b></span></div>`;
    const html = head + `<div class="bp-rows">${list.map((e) => row(e)).join("")}</div>` + extras(s);
    if (html !== this.lastHtml) {
      this.lastHtml = html;
      this.peekEl.innerHTML = html;
    }
  }

  /** A card for each thing that entered the bag since the last frame, with what left it struck through. */
  private pickups(s: State) {
    const now = census(s);
    if (this.seen.state !== s) {
      this.seen = { state: s, count: now };
      return;
    }
    const was = this.seen.count;
    this.seen.count = now;
    const came = [...now].filter(([k, n]) => n > (was.get(k) ?? 0)).map(([k]) => k);
    if (!came.length) return;
    const went = [...was].filter(([k, n]) => n > (now.get(k) ?? 0)).map(([k]) => k);
    const list = entries(this.profile, s);
    for (const id of came) {
      const [t, k] = id.split(":");
      const e = list.find((x) => x.id === id);
      const body = e
        ? row(e, true)
        : t === "k"
          ? `<div class="bp-row"><span class="bp-pic icon" style="color:${RARITY_CSS[3]}">${keyIcon()}</span><span class="bp-name" style="color:${RARITY_CSS[3]}">${esc(POIS[Number(k)].name)}</span></div>`
          : `<div class="bp-row"><span class="bp-pic icon">${modIcon()}</span><span class="bp-name" style="color:${RARITY_CSS[2]}">${esc(MODS[k as ModKind].name)}</span></div>`;
      const out = went.length ? `<div class="bp-lost">${crossIcon()}${went.map((w) => `<s>${esc(lostName(w))}</s>`).join("")}</div>` : "";
      const el = document.createElement("div");
      el.className = "bag-card";
      el.style.setProperty("--c", e?.color ?? (t === "m" ? RARITY_CSS[2] : RARITY_CSS[3]));
      el.innerHTML = body + out;
      el.style.opacity = "0";
      this.cardsEl.appendChild(el);
      this.cards.push({ el, t: CARD_LIFE });
    }
    while (this.cards.length > CARD_MAX) this.cards.shift()!.el.remove();
  }
}
