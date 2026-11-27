/*
 * 攻められた記録 on the signal station (docs/ringfall/glossary.md 攻めの記録): each sortie another
 * player made on the player's holdings, newest first, as names and numbers (who, where, the stars,
 * what it cost, how long ago), with its track played on a small map of the holding when it came with
 * one, and やり返す when the attacker has a holding to attack. Reads the profile; changes nothing.
 */
import type { Attack } from "../meta/attacks";
import { ago } from "../meta/neighbours";
import type { Profile } from "../meta/profile";
import { NODES, nodeIndex } from "../sim/map";
import type { ReplayMark } from "../sim/replay-data";
import { TERM } from "./copy";
import { clockIcon, coinIcon, coreIcon, crossIcon, SIDE } from "./icons";
import { IslandMap, islandScene } from "./map";
import { UI } from "./palette";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Metres round the holding's core the small map shows. */
const REACH = 150;
/** Seconds a whole sortie takes to play back. */
const PLAY = 8;

/** The records as the signal station lists them; empty with none. `revenge` gives the やり返す argument for an attacker, or null. */
export function attacksHtml(p: Profile, revenge: (code: string) => string | null, now = Date.now()): string {
  if (!p.attacks.length) return "";
  const rows = [...p.attacks].reverse().map((a) => {
    const stars = `${"★".repeat(a.stars)}${"☆".repeat(3 - a.stars)}`;
    const node = NODES[nodeIndex(a.node)]?.name ?? a.node;
    const cost = [a.won ? `<b class="lost">${TERM.trophy} −${a.won}</b>` : "", a.credits ? `<b class="lost">${coinIcon()}−${a.credits}</b>` : ""].join("");
    const result = a.taken ? `<b class="taken">${crossIcon()}${TERM.lostHolding}</b>` : `<b class="held">${coreIcon(SIDE.own)}${TERM.heldHolding}</b>`;
    const arg = revenge(a.by.code);
    const back = arg ? `<button type="button" class="revenge" data-act="revenge" data-arg="${esc(arg)}">${TERM.revenge}</button>` : "";
    const watch = a.replay ? `<button type="button" class="watch" data-act="attack-play" data-arg="${a.seq}">${TERM.watch}</button>` : "";
    return (
      `<li data-seq="${a.seq}"><div class="attack-line"><span class="who">${esc(a.by.name)}</span><span class="where">${esc(node)}</span>` +
      `<span class="stars">${stars}</span>${result}${cost}<span class="when">${clockIcon()}${ago(a.at, now)}</span>${watch}${back}</div>` +
      (a.replay ? `<canvas class="attack-map" data-seq="${a.seq}" hidden></canvas>` : "") +
      `</li>`
    );
  });
  return `<h3 class="hub-sub">${TERM.attackRecord}</h3><ul class="attack-records">${rows.join("")}</ul>`;
}

/** The record playing, so a second one (or the panel's redraw) stops it. */
let playing = 0;

/** Plays record `seq` on its canvas under `root`: the holding's ground, the attacker's track drawn as it went, its marks as they came. */
export function playAttack(root: ParentNode, p: Profile, seq: number) {
  const a = p.attacks.find((r) => r.seq === seq);
  const canvas = root.querySelector<HTMLCanvasElement>(`canvas.attack-map[data-seq="${seq}"]`);
  if (!a?.replay || !canvas) return;
  for (const c of root.querySelectorAll<HTMLCanvasElement>("canvas.attack-map")) c.hidden = c !== canvas;
  canvas.hidden = false;
  const core = NODES[nodeIndex(a.node)]?.core;
  if (!core) return;
  const map = Object.assign(new IslandMap(canvas), { plain: true, locks: false, unlocks: false });
  map.frame = { x0: core.x - REACH, z0: core.z - REACH, x1: core.x + REACH, z1: core.z + REACH };
  const scene = { ...islandScene(p), names: [] };
  const r = a.replay;
  const end = Math.max(r.every * (r.path.length / 2 - 1), ...r.marks.map((m) => m.t), 1);
  const id = ++playing;
  const t0 = performance.now();
  const frame = (now: number) => {
    if (id !== playing || !canvas.isConnected || canvas.hidden) return;
    // Under a browser driver the whole record at once, so a screenshot shows it the same on any run.
    const t = navigator.webdriver ? end : Math.min(end, ((now - t0) / 1000 / PLAY) * end);
    map.draw(scene);
    track(canvas, map, a, t);
    if (t < end) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The attacker's track to `t` seconds, its marks up to then, and where it stands then. */
function track(canvas: HTMLCanvasElement, map: IslandMap, a: Attack, t: number) {
  const r = a.replay!;
  const g = canvas.getContext("2d")!;
  const dpr = canvas.width / Math.max(1, canvas.clientWidth);
  const at = (x: number, z: number) => {
    const s = map.screenAt(x, z)!;
    return { x: s.x * dpr, y: s.y * dpr };
  };
  const n = r.path.length / 2;
  // The points up to t, and one between the last of them and the next.
  const upto = Math.min(n - 1, Math.floor(t / r.every));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= upto; i++) pts.push(at(r.path[i * 2], r.path[i * 2 + 1]));
  if (upto < n - 1) {
    const f = t / r.every - upto;
    const a0 = r.path.slice(upto * 2, upto * 2 + 2);
    const a1 = r.path.slice(upto * 2 + 2, upto * 2 + 4);
    pts.push(at(a0[0] + (a1[0] - a0[0]) * f, a0[1] + (a1[1] - a0[1]) * f));
  }
  g.save();
  g.lineCap = "round";
  g.lineJoin = "round";
  // A dark edge under a light line, so the track reads on any ground's colour.
  for (const [colour, width] of [[UI.night, 6], [UI.rivalLight, 3]] as const) {
    g.strokeStyle = colour;
    g.lineWidth = width * dpr;
    g.beginPath();
    pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.stroke();
  }
  for (const m of r.marks) if (m.t <= t) mark(g, m, at(m.x, m.z), dpr);
  const head = pts.at(-1);
  if (head && !r.marks.some((m) => m.k === "down" && m.t <= t)) {
    g.fillStyle = UI.rivalLight;
    g.strokeStyle = UI.night;
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.arc(head.x, head.y, 6 * dpr, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  g.restore();
}

/** One moment's pin: the core's capture begun (a ring) and done (a filled diamond), a defender down (a blue cross), the attacker down (a green cross), the end (a small dot). */
function mark(g: CanvasRenderingContext2D, m: ReplayMark, q: { x: number; y: number }, dpr: number) {
  const s = 7 * dpr;
  g.lineWidth = 2.5 * dpr;
  if (m.k === "core") {
    g.strokeStyle = UI.rivalLight;
    g.beginPath();
    g.arc(q.x, q.y, s * 1.4, 0, Math.PI * 2);
    g.stroke();
  } else if (m.k === "taken") {
    g.fillStyle = UI.rival;
    g.strokeStyle = UI.paper;
    g.beginPath();
    g.moveTo(q.x, q.y - s * 1.4);
    g.lineTo(q.x + s * 1.4, q.y);
    g.lineTo(q.x, q.y + s * 1.4);
    g.lineTo(q.x - s * 1.4, q.y);
    g.closePath();
    g.fill();
    g.stroke();
  } else if (m.k === "fall" || m.k === "down") {
    g.strokeStyle = m.k === "fall" ? UI.ownBright : UI.rivalLight;
    g.beginPath();
    g.moveTo(q.x - s * 0.7, q.y - s * 0.7);
    g.lineTo(q.x + s * 0.7, q.y + s * 0.7);
    g.moveTo(q.x + s * 0.7, q.y - s * 0.7);
    g.lineTo(q.x - s * 0.7, q.y + s * 0.7);
    g.stroke();
  } else {
    g.fillStyle = UI.paper;
    g.beginPath();
    g.arc(q.x, q.y, s * 0.45, 0, Math.PI * 2);
    g.fill();
  }
}
