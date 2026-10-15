import type { EnemyKind, Rarity, WeaponKind } from "../sim/config";
import { Mixer, getMixer, swapMixer, unlock, type P3 } from "./audio";
import { sfx } from "./sfx";

/*
 * The sound check (`?sfx` on the RINGFALL page): a panel on the title screen with
 * a button per cue, positional demos that move a sound round the listener, and
 * `window.ringfallSfxCheck()`, which renders every cue offline through the same
 * mixer the game uses and reports peak, loudness and bad samples
 * (scripts/ringfall-sfx.mjs fails on silent, NaN or clipping cues).
 */

interface Cue {
  id: string;
  label: string;
  group: string;
  /** `step` counts the repeats of a demo that moves round the listener; offline renders step 0 only. */
  run(step: number): void;
  /** Demos repeat this many times, 0.45 s apart. */
  repeat?: number;
}

/** A point `d` metres from the listener at `deg` (0 ahead, 90 right, 180 behind, 270 left). */
function around(deg: number, d: number, dy = 0): P3 {
  const m = getMixer();
  const ear = m?.ear ?? { x: 0, y: 0, z: 0 };
  const f = m?.fwd ?? { x: 0, y: 0, z: -1 };
  const len = Math.hypot(f.x, f.z) || 1;
  const fx = f.x / len;
  const fz = f.z / len;
  const a = (deg * Math.PI) / 180;
  // right = (-fz, fx) in x/z
  return { x: ear.x + (Math.cos(a) * fx - Math.sin(a) * fz) * d, y: ear.y + dy, z: ear.z + (Math.cos(a) * fz + Math.sin(a) * fx) * d };
}

/** Plays with walls ignored (demos), or with every source behind one. */
function walls(blocked: boolean | null, body: () => void) {
  const m = getMixer();
  if (!m) return;
  const keep = m.occluder;
  m.occluder = blocked === null ? null : () => blocked;
  body();
  m.occluder = keep;
}

const WEAPON_NAMES: Record<WeaponKind, string> = { pike: "PIKE（アサルトライフル）", hornet: "HORNET（サブマシンガン）", maul: "MAUL（ショットガン）", lance: "LANCE（マークスマン）", talon: "TALON（スナイパー）" };
const KINDS: WeaponKind[] = ["pike", "hornet", "maul", "lance", "talon"];
const ROBOTS: [EnemyKind, string][] = [
  ["drone", "ドローン"],
  ["grunt", "兵士"],
  ["charger", "突進型"],
  ["heavy", "重装"],
  ["titan", "タイタン"],
];

export const CUES: Cue[] = [
  ...KINDS.map((k) => ({ id: `shot-${k}`, label: WEAPON_NAMES[k], group: "武器", run: () => sfx.shot(k) })),
  ...KINDS.map((k) => ({ id: `reload-${k}`, label: `${k.toUpperCase()} リロード`, group: "武器", run: () => sfx.reload(k === "maul" ? 1.6 : k === "talon" ? 1.5 : 1.2, k) })),
  ...KINDS.map((k) => ({ id: `reloaded-${k}`, label: `${k.toUpperCase()} 装填完了`, group: "武器", run: () => sfx.reloaded(k) })),
  ...(["pike", "maul", "talon"] as WeaponKind[]).map((k) => ({ id: `dry-${k}`, label: `${k.toUpperCase()} 弾切れ`, group: "武器", run: () => sfx.dry(k) })),
  { id: "hit", label: "命中（本体）", group: "命中", run: () => sfx.hit(false, false) },
  { id: "hit-shield", label: "命中（シールド）", group: "命中", run: () => sfx.hit(false, true) },
  { id: "hit-crit", label: "弱点命中", group: "命中", run: () => sfx.hit(true, false) },
  { id: "hit-flank", label: "背後から命中", group: "命中", run: () => sfx.hit(false, false, true) },
  { id: "hit-plate", label: "命中（装甲）", group: "命中", run: () => sfx.hit(false, false, false, true) },
  ...([0, 1, 2, 3] as Rarity[]).map((t) => ({ id: `shield-break-${t}`, label: `シールド破壊（${["白", "青", "紫", "金"][t]}）`, group: "命中", run: () => sfx.shieldBreak(t) })),
  { id: "kill", label: "撃破", group: "命中", run: () => sfx.kill(false) },
  { id: "kill-crit", label: "撃破（弱点）", group: "命中", run: () => sfx.kill(true) },
  { id: "hurt-shield", label: "被弾（シールド）", group: "自分", run: () => sfx.hurt(true) },
  { id: "hurt", label: "被弾（体力）", group: "自分", run: () => sfx.hurt(false) },
  { id: "my-shield-break", label: "自分のシールド破壊", group: "自分", run: () => sfx.myShieldBreak() },
  { id: "slide", label: "スライディング", group: "自分", run: () => sfx.slide() },
  { id: "jump", label: "ジャンプ", group: "自分", run: () => sfx.jump() },
  { id: "mantle", label: "よじ登り", group: "自分", run: () => sfx.mantle() },
  { id: "land", label: "着地", group: "自分", run: () => sfx.land(12) },
  { id: "tactical", label: "アーク", group: "自分", run: () => sfx.tactical() },
  { id: "leap", label: "離脱ジャンプ", group: "自分", run: () => sfx.leap() },
  { id: "leap-land", label: "離脱ジャンプ着地", group: "自分", run: () => sfx.leapLand() },
  { id: "heal-cell", label: "シールドセル", group: "自分", run: () => sfx.heal("cell") },
  { id: "heal-battery", label: "シールドバッテリー", group: "自分", run: () => sfx.heal("battery") },
  { id: "heal-syringe", label: "注射器", group: "自分", run: () => sfx.heal("syringe") },
  { id: "heal-medkit", label: "医療キット", group: "自分", run: () => sfx.heal("medkit") },
  { id: "heal-done", label: "回復完了", group: "自分", run: () => sfx.healDone() },
  { id: "down", label: "ダウン", group: "自分", run: () => sfx.down() },
  { id: "revive", label: "蘇生", group: "自分", run: () => sfx.revive() },
  ...([0, 1, 2, 3] as Rarity[]).map((r) => ({ id: `pickup-${r}`, label: `拾う（${["白", "青", "紫", "金"][r]}）`, group: "拾う", run: () => sfx.pickup(r) })),
  { id: "shard", label: "シールドの欠片", group: "拾う", run: () => sfx.shard() },
  { id: "search", label: "補給箱を調べる", group: "拾う", run: () => sfx.search() },
  { id: "bin", label: "補給箱が開く", group: "拾う", run: () => sfx.bin() },
  { id: "locked", label: "鍵がかかっている", group: "拾う", run: () => sfx.locked() },
  { id: "depot-on", label: "中継ボックス起動", group: "拾う", run: () => sfx.depotOn() },
  { id: "deposit", label: "倉庫へ送る", group: "拾う", run: () => sfx.deposit() },
  ...ROBOTS.map(([k, n]) => ({ id: `enemy-fire-${k}`, label: `${n}の射撃（正面 12 m）`, group: "敵", run: () => walls(null, () => sfx.enemyFire(around(0, 12), k)) })),
  { id: "telegraph", label: "予兆（右 8 m）", group: "敵", run: () => walls(null, () => sfx.telegraph(false, around(90, 8))) },
  { id: "telegraph-big", label: "予兆・大（左 12 m）", group: "敵", run: () => walls(null, () => sfx.telegraph(true, around(270, 12))) },
  { id: "lunge", label: "突進（後ろ 6 m）", group: "敵", run: () => walls(null, () => sfx.lunge(around(180, 6))) },
  { id: "stomp", label: "タイタンの踏みつけ", group: "敵", run: () => walls(null, () => sfx.stomp(around(30, 14))) },
  ...ROBOTS.map(([k, n]) => ({ id: `step-${k}`, label: `${n}の足音（右 5 m）`, group: "敵", run: () => walls(null, () => sfx.step(around(90, 5), k, true)) })),
  { id: "spawn", label: "ロボットの転送", group: "敵", run: () => walls(null, () => sfx.spawn(around(300, 15))) },
  { id: "arrive", label: "増援の着地（遠く）", group: "敵", run: () => walls(null, () => sfx.arrive(around(120, 70, 2), false)) },
  { id: "arrive-raiders", label: "レイダーの着地（遠く）", group: "敵", run: () => walls(null, () => sfx.arrive(around(240, 70, 2), true)) },
  { id: "suspect", label: "気づかれかけ", group: "合図", run: () => sfx.suspect() },
  { id: "engage", label: "発見された", group: "合図", run: () => sfx.engage() },
  { id: "reinforce", label: "増援の合図", group: "合図", run: () => sfx.reinforce() },
  { id: "raiders", label: "レイダーの合図", group: "合図", run: () => sfx.raiders() },
  { id: "banner", label: "見出し", group: "合図", run: () => sfx.banner() },
  { id: "ult-ready", label: "離脱ジャンプ準備完了", group: "合図", run: () => sfx.ultReady() },
  { id: "tactical-miss", label: "使えない", group: "合図", run: () => sfx.tacticalMiss() },
  { id: "victory", label: "制圧・脱出", group: "合図", run: () => sfx.victory() },
  { id: "ally-shot", label: "リオの射撃（左 10 m）", group: "リオ", run: () => walls(null, () => sfx.allyShot(around(270, 10, 0.4))) },
  { id: "ally-down", label: "リオのダウン", group: "リオ", run: () => sfx.allyDown() },
  { id: "ally-up", label: "リオの復帰", group: "リオ", run: () => sfx.allyUp() },
  { id: "wreck", label: "リオが倒したロボット", group: "リオ", run: () => walls(null, () => sfx.wreck(around(45, 15))) },
  { id: "care-drop", label: "補給物資の落下", group: "世界", run: () => walls(null, () => sfx.careDrop(around(60, 30, 40))) },
  { id: "care-land", label: "補給物資の着地", group: "世界", run: () => walls(null, () => sfx.careLand(around(60, 30))) },
  { id: "creak", label: "金属のきしみ（遠く）", group: "世界", run: () => sfx.creak(around(200, 40, 2)) },
  { id: "machinery", label: "遠くの機械", group: "世界", run: () => sfx.machinery(around(100, 90)) },
  { id: "gull", label: "カモメ", group: "世界", run: () => sfx.gull(around(320, 60, 15)) },
  { id: "tab", label: "タブ切り替え", group: "拠点", run: () => sfx.tab() },
  { id: "click", label: "選ぶ", group: "拠点", run: () => sfx.click() },
  { id: "buy", label: "買う", group: "拠点", run: () => sfx.buy() },
  { id: "sell", label: "売る", group: "拠点", run: () => sfx.sell() },
  { id: "deliver", label: "納品・依頼達成", group: "拠点", run: () => sfx.deliver() },
  { id: "deploy", label: "出撃", group: "拠点", run: () => sfx.deploy() },
  { id: "extracted", label: "結果：生還", group: "拠点", run: () => sfx.extracted() },
  { id: "lost", label: "結果：全滅", group: "拠点", run: () => sfx.lost() },
  // Positional demos: the same sound walks round the listener.
  { id: "demo-circle-fire", label: "周回：敵の射撃（前→右→後→左）", group: "位置", repeat: 8, run: (i) => walls(null, () => sfx.enemyFire(around(i * 45, 10), "grunt")) },
  { id: "demo-circle-steps", label: "周回：兵士の足音", group: "位置", repeat: 12, run: (i) => walls(null, () => sfx.step(around(i * 30, 4), "grunt", i % 3 === 0)) },
  { id: "demo-lr", label: "左右：予兆", group: "位置", repeat: 2, run: (i) => walls(null, () => sfx.telegraph(false, around(i ? 90 : 270, 7))) },
  { id: "demo-behind", label: "真後ろ：突進", group: "位置", run: () => walls(null, () => sfx.lunge(around(180, 5))) },
  { id: "demo-far", label: "距離：10 m → 30 m → 60 m の射撃", group: "位置", repeat: 3, run: (i) => walls(null, () => sfx.enemyFire(around(20, [10, 30, 60][i]), "grunt")) },
  { id: "demo-wall", label: "壁越し：見える射撃 → 壁の向こうの射撃", group: "位置", repeat: 2, run: (i) => walls(i === 1, () => sfx.enemyFire(around(60, 12), "grunt")) },
  { id: "demo-ally", label: "周回：リオの射撃", group: "位置", repeat: 4, run: (i) => walls(null, () => sfx.allyShot(around(i * 90 + 45, 9, 0.4))) },
];

export interface CueReport {
  id: string;
  peak: number;
  rms: number;
  /** Loudest 20 ms window, RMS: short cues are judged by this, not by the whole render. */
  loud: number;
  nan: number;
  /** Samples at or above full scale. */
  clipped: number;
}

/** Renders one cue offline through a fresh mixer at full volume. */
async function render(cue: Cue, secs = 3.2): Promise<CueReport> {
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.floor(sr * secs), sr);
  const m = new Mixer(off, false);
  m.volume.gain.value = 1;
  const prev = swapMixer(m);
  try {
    cue.run(0);
  } finally {
    swapMixer(prev);
  }
  const buf = await off.startRendering();
  let peak = 0;
  let sum = 0;
  let nan = 0;
  let clipped = 0;
  let loud = 0;
  const win = Math.floor(sr * 0.02);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i + win <= d.length; i += win) {
      let w = 0;
      for (let j = i; j < i + win; j++) w += Number.isFinite(d[j]) ? d[j] * d[j] : 0;
      loud = Math.max(loud, Math.sqrt(w / win));
    }
  }
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      if (!Number.isFinite(x)) {
        nan++;
        continue;
      }
      const a = Math.abs(x);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sum += x * x;
    }
  }
  return { id: cue.id, peak, rms: Math.sqrt(sum / (buf.length * buf.numberOfChannels)), loud, nan, clipped };
}

/** Every cue rendered, plus the voice cap under a burst of 80 enemy shots. */
async function checkAll() {
  const cues: CueReport[] = [];
  for (const c of CUES) cues.push(await render(c));
  const off = new OfflineAudioContext(2, 44100, 44100);
  const m = new Mixer(off, false);
  const prev = swapMixer(m);
  try {
    for (let i = 0; i < 80; i++) sfx.enemyFire(around(i * 13, 5 + (i % 7)), "grunt");
  } finally {
    swapMixer(prev);
  }
  return { cues, burstVoices: m.active };
}

declare global {
  interface Window {
    ringfallSfxCheck?: typeof checkAll;
  }
}

/** Shows the panel and the offline check when the page was opened with `?sfx`. */
export function setupSoundCheck() {
  if (!new URLSearchParams(location.search).has("sfx")) return;
  window.ringfallSfxCheck = checkAll;
  const panel = document.createElement("aside");
  panel.id = "sfx-panel";
  const groups = [...new Set(CUES.map((c) => c.group))];
  panel.innerHTML = `<h3>サウンドチェック</h3><p>位置のデモは、いま向いている方向を正面にして鳴る。</p>${groups
    .map((g) => `<h4>${g}</h4><div class="sfx-grid">${CUES.filter((c) => c.group === g)
      .map((c) => `<button type="button" data-cue="${c.id}">${c.label}</button>`)
      .join("")}</div>`)
    .join("")}`;
  panel.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cue]");
    const cue = b && CUES.find((c) => c.id === b.dataset.cue);
    if (!cue) return;
    unlock();
    for (let i = 0; i < (cue.repeat ?? 1); i++) setTimeout(() => cue.run(i), i * 450);
  });
  document.getElementById("title")?.append(panel);
}
