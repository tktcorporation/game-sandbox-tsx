import type { EnemyKind, Rarity, WeaponKind } from "../sim/config";
import { Mixer, getMixer, loop, swapMixer, unlock, type P3 } from "./audio";
import { BEDS, windGain } from "./soundscape";
import { sfx } from "./sfx";
import { Music, type Mood } from "./music";
import { REGIONS, type RegionId } from "../sim/map";

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
  { id: "alarm", label: "核の警報（制圧開始）", group: "前線", run: () => sfx.alarm() },
  { id: "core-taken", label: "拠点の制圧", group: "前線", run: () => sfx.coreTaken() },
  { id: "landing-ship", label: "敵のドロップシップの降下（遠く 300 m）", group: "前線", run: () => walls(null, () => sfx.landing(around(30, 300, 60), false)) },
  { id: "landing-boat", label: "敵の船の着岸（遠く 300 m）", group: "前線", run: () => walls(null, () => sfx.landing(around(330, 300, 2), true)) },
  { id: "touchdown-ship", label: "ドロップシップの着地（200 m）", group: "前線", run: () => walls(null, () => sfx.touchdown(around(30, 200, 2), false)) },
  { id: "touchdown-boat", label: "船が浜に着く（200 m）", group: "前線", run: () => walls(null, () => sfx.touchdown(around(330, 200, 2), true)) },
  { id: "gate", label: "野営地の門が開く（40 m）", group: "前線", run: () => walls(null, () => sfx.gate(around(180, 40, 2))) },
  { id: "depot-out", label: "中継ボックスから出撃（30 m）", group: "前線", run: () => walls(null, () => sfx.depotOut(around(90, 30, 1))) },
  { id: "threat", label: "拠点の核に敵", group: "前線", run: () => sfx.threat() },
  { id: "hit", label: "命中（本体）", group: "命中", run: () => sfx.hit(false, false) },
  { id: "hit-shield", label: "命中（シールド）", group: "命中", run: () => sfx.hit(false, true) },
  { id: "hit-crit", label: "弱点命中", group: "命中", run: () => sfx.hit(true, false) },
  { id: "hit-flank", label: "背後から命中", group: "命中", run: () => sfx.hit(false, false, true) },
  { id: "hit-plate", label: "跳弾（装甲）", group: "命中", run: () => sfx.hit(false, false, false, true) },
  ...([1, 2, 3] as Rarity[]).map((t) => ({ id: `plate-break-${t}`, label: `装甲板が割れる（${["白", "青", "紫", "金"][t]}）`, group: "命中", run: () => sfx.plateBreak(t) })),
  ...([0, 1, 2, 3] as Rarity[]).map((t) => ({ id: `shield-break-${t}`, label: `シールド破壊（${["白", "青", "紫", "金"][t]}）`, group: "命中", run: () => sfx.shieldBreak(t) })),
  { id: "kill", label: "撃破", group: "命中", run: () => sfx.kill(false) },
  { id: "kill-crit", label: "撃破（弱点）", group: "命中", run: () => sfx.kill(true) },
  { id: "collapse", label: "残骸が倒れる（正面 10 m）", group: "命中", run: () => walls(null, () => sfx.collapse(around(0, 10), false)) },
  { id: "collapse-big", label: "重装の残骸が倒れる（右 14 m）", group: "命中", run: () => walls(null, () => sfx.collapse(around(60, 14), true)) },
  { id: "stagger", label: "よろめき（正面 12 m）", group: "命中", run: () => walls(null, () => sfx.stagger(around(0, 12), false)) },
  { id: "stagger-cut", label: "よろめき・予兆を止めた", group: "命中", run: () => walls(null, () => sfx.stagger(around(20, 12), true)) },
  { id: "hurt-shield", label: "被弾（シールド）", group: "自分", run: () => sfx.hurt(true) },
  { id: "hurt", label: "被弾（体力）", group: "自分", run: () => sfx.hurt(false) },
  { id: "my-shield-break", label: "自分のシールド破壊", group: "自分", run: () => sfx.myShieldBreak() },
  { id: "slide", label: "スライディング", group: "自分", run: () => sfx.slide() },
  { id: "jump", label: "ジャンプ", group: "自分", run: () => sfx.jump() },
  { id: "mantle", label: "よじ登り", group: "自分", run: () => sfx.mantle() },
  { id: "land", label: "着地", group: "自分", run: () => sfx.land(12) },
  { id: "land-hop", label: "着地（跳ねた後）", group: "自分", run: () => sfx.land(5.5) },
  { id: "slide-jump", label: "スライドジャンプ", group: "自分", run: () => sfx.slideJump(11) },
  { id: "climb", label: "壁登り", group: "自分", run: () => sfx.climb(5) },
  { id: "climb-top", label: "壁登り・縁を越える", group: "自分", run: () => sfx.climbTop() },
  { id: "zip-on", label: "ジップラインをつかむ", group: "自分", run: () => sfx.zipOn() },
  { id: "zip-off", label: "ジップラインを離す", group: "自分", run: () => sfx.zipOff(false) },
  { id: "zip-cut", label: "ジップラインが切れる", group: "自分", run: () => sfx.zipOff(true) },
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
  { id: "bag-peek", label: "バッグを見る", group: "拾う", run: () => sfx.bagPeek() },
  { id: "shard", label: "シールドの欠片", group: "拾う", run: () => sfx.shard() },
  { id: "search", label: "補給箱を調べる", group: "拾う", run: () => sfx.search() },
  { id: "bin", label: "補給箱が開く", group: "拾う", run: () => sfx.bin() },
  { id: "locked", label: "選べない", group: "拾う", run: () => sfx.locked() },
  { id: "depot-on", label: "中継ボックス起動", group: "拾う", run: () => sfx.depotOn() },
  { id: "deposit", label: "倉庫へ送る", group: "拾う", run: () => sfx.deposit() },
  ...ROBOTS.map(([k, n]) => ({ id: `enemy-fire-${k}`, label: `${n}の射撃（正面 12 m）`, group: "敵", run: () => walls(null, () => sfx.enemyFire(around(0, 12), k)) })),
  { id: "far-fire", label: "遠くの撃ち合い（200 m）", group: "敵", run: () => walls(null, () => sfx.farFire(around(40, 200, 2), "grunt")) },
  { id: "telegraph", label: "予兆（右 8 m）", group: "敵", run: () => walls(null, () => sfx.telegraph(false, around(90, 8))) },
  { id: "telegraph-big", label: "予兆・大（左 12 m）", group: "敵", run: () => walls(null, () => sfx.telegraph(true, around(270, 12))) },
  { id: "lunge", label: "突進（後ろ 6 m）", group: "敵", run: () => walls(null, () => sfx.lunge(around(180, 6))) },
  { id: "stomp", label: "タイタンの踏みつけ", group: "敵", run: () => walls(null, () => sfx.stomp(around(30, 14))) },
  ...ROBOTS.map(([k, n]) => ({ id: `step-${k}`, label: `${n}の足音（右 5 m）`, group: "敵", run: () => walls(null, () => sfx.step(around(90, 5), k, true)) })),
  { id: "swarm", label: "ドローンの群れ（遠く 60 m）", group: "敵", run: () => walls(null, () => sfx.swarm(around(60, 60, 4))) },
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
  { id: "buoy", label: "ブイの鐘（港湾）", group: "世界", run: () => sfx.buoy(around(40, 120, 0)) },
  { id: "groan", label: "船体のうなり（港湾）", group: "世界", run: () => sfx.groan(around(300, 60, 2)) },
  { id: "siren", label: "遠いサイレン（機械都市）", group: "世界", run: () => sfx.siren(around(80, 200, 20)) },
  { id: "zap", label: "変圧器の放電（機械都市）", group: "世界", run: () => sfx.zap(around(200, 30, 4)) },
  { id: "ping", label: "レーダーの音（発射場）", group: "世界", run: () => sfx.ping(around(30, 80, 14)) },
  { id: "harp", label: "鉄塔のワイヤーが鳴る（発射場）", group: "世界", run: () => sfx.harp(around(250, 80, 30)) },
  { id: "tab", label: "板を開く", group: "野営地", run: () => sfx.tab() },
  { id: "click", label: "選ぶ", group: "野営地", run: () => sfx.click() },
  { id: "buy", label: "買う", group: "野営地", run: () => sfx.buy() },
  { id: "sell", label: "売る", group: "野営地", run: () => sfx.sell() },
  { id: "deliver", label: "納品・依頼達成", group: "野営地", run: () => sfx.deliver() },
  { id: "deploy", label: "出撃", group: "野営地", run: () => sfx.deploy() },
  { id: "extracted", label: "結果：生還", group: "野営地", run: () => sfx.extracted() },
  { id: "lost", label: "結果：全滅", group: "野営地", run: () => sfx.lost() },
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
  /** How loud it sounds: the loudest 400 ms, K-weighted as broadcast loudness is (BS.1770), in LUFS. */
  lufs: number;
  /** Seconds until it falls for good under -60 dBFS. */
  len: number;
}

/** A biquad's coefficients from the cookbook formulas, normalised by a0. */
function biquad(kind: "shelf" | "highpass", f: number, q: number, gainDb: number, sr: number): number[] {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  if (kind === "highpass") {
    const a0 = 1 + al;
    return [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, (-2 * cw) / a0, (1 - al) / a0];
  }
  const A = Math.pow(10, gainDb / 40);
  const sq = 2 * Math.sqrt(A) * al;
  const a0 = A + 1 - (A - 1) * cw + sq;
  return [(A * (A + 1 + (A - 1) * cw + sq)) / a0, (-2 * A * (A - 1 + (A + 1) * cw)) / a0, (A * (A + 1 + (A - 1) * cw - sq)) / a0, (2 * (A - 1 - (A + 1) * cw)) / a0, (A + 1 - (A - 1) * cw - sq) / a0];
}

function filter(d: ArrayLike<number>, [b0, b1, b2, a1, a2]: number[]): Float32Array {
  const o = new Float32Array(d.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const x = Number.isFinite(d[i]) ? d[i] : 0;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    o[i] = y;
  }
  return o;
}

/** The loudest momentary loudness (400 ms windows, 100 ms apart) of a render, in LUFS. */
export function momentary(buf: AudioBuffer): number {
  const sr = buf.sampleRate;
  const k = [biquad("shelf", 1500, Math.SQRT1_2, 4, sr), biquad("highpass", 38, 0.5, 0, sr)];
  const ch = Array.from({ length: buf.numberOfChannels }, (_, c) => k.reduce<ArrayLike<number>>((d, f) => filter(d, f), buf.getChannelData(c)) as Float32Array);
  const win = Math.floor(sr * 0.4);
  const hop = Math.floor(sr * 0.1);
  let best = 0;
  for (let i = 0; i + win <= buf.length; i += hop) {
    let z = 0;
    for (const d of ch) for (let j = i; j < i + win; j++) z += d[j] * d[j];
    best = Math.max(best, z / win);
  }
  return best > 0 ? -0.691 + 10 * Math.log10(best) : -Infinity;
}

/** Seconds until a render falls for good under -60 dBFS. */
export function tail(buf: AudioBuffer): number {
  let last = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > 0.001) {
      last = i;
      break;
    }
  }
  return last / buf.sampleRate;
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
  return { id: cue.id, peak, rms: Math.sqrt(sum / (buf.length * buf.numberOfChannels)), loud, nan, clipped, lufs: momentary(buf), len: tail(buf) };
}

/** The music's moods, each rendered for four bars through a fresh mixer, measured as a cue is. */
export const MOODS: Exclude<Mood, "off">[] = ["title", "camp", "explore", "alert", "fight", "extract", "result"];
const RAID_MOODS: Exclude<Mood, "off">[] = ["explore", "alert", "fight", "extract"];

const MOOD_NAMES: Record<Mood, string> = { off: "止める", title: "タイトル", camp: "野営地", explore: "探索", alert: "警戒", fight: "交戦", extract: "脱出待ち", result: "結果" };

/** A mood rendered offline through a fresh mixer at full volume. */
async function moodBuffer(mood: Exclude<Mood, "off">, secs: number, region: RegionId = "reservoir", volume = 1): Promise<AudioBuffer> {
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.floor(sr * secs), sr);
  const m = new Mixer(off, false);
  m.volume.gain.value = 1;
  m.musicVolume.gain.value = volume;
  const music = new Music(m);
  music.set(mood, region, 0.01);
  music.schedule(secs - 0.5);
  return off.startRendering();
}

/** A short phrase over the explore's music, measured as a cue. */
async function renderPhrase(kind: "capture" | "home"): Promise<CueReport> {
  const sr = 44100;
  const secs = 4;
  const off = new OfflineAudioContext(2, Math.floor(sr * secs), sr);
  const m = new Mixer(off, false);
  m.volume.gain.value = 1;
  m.musicVolume.gain.value = 1;
  const music = new Music(m);
  music.set("explore", "reservoir", 0.01);
  music.schedule(0.3);
  music.phrase(kind);
  music.schedule(secs - 0.5);
  const buf = await off.startRendering();
  return { id: `music-phrase-${kind}`, rms: 0, loud: 1, lufs: momentary(buf), len: tail(buf), ...peaks(buf) };
}

function peaks(buf: AudioBuffer) {
  let peak = 0;
  let nan = 0;
  let clipped = 0;
  for (let c = 0; c < buf.numberOfChannels; c++)
    for (const x of buf.getChannelData(c)) {
      if (!Number.isFinite(x)) nan++;
      else {
        peak = Math.max(peak, Math.abs(x));
        if (Math.abs(x) >= 0.999) clipped++;
      }
    }
  return { peak, nan, clipped };
}

async function renderMood(mood: Exclude<Mood, "off">, region: RegionId = "reservoir", secs = 10.6): Promise<CueReport> {
  const buf = await moodBuffer(mood, secs, region);
  let peak = 0;
  let nan = 0;
  let clipped = 0;
  let sum = 0;
  for (let c = 0; c < buf.numberOfChannels; c++)
    for (const x of buf.getChannelData(c)) {
      if (!Number.isFinite(x)) {
        nan++;
        continue;
      }
      peak = Math.max(peak, Math.abs(x));
      if (Math.abs(x) >= 0.999) clipped++;
      sum += x * x;
    }
  const rms = Math.sqrt(sum / (buf.length * buf.numberOfChannels));
  return { id: region === "reservoir" ? `music-${mood}` : `music-${region}-${mood}`, peak, rms, loud: rms, nan, clipped, lufs: momentary(buf), len: tail(buf) };
}

/**
 * The beds that never stop, at the levels the soundscape gives them (soundscape.ts `WIND`, `BEDS`),
 * measured as cues are: the breeze on the ground in the open (where most of a raid is walked), the
 * breeze thirty metres up, and each region's bed at its loudest. The check holds them under the music.
 */
async function renderBed(id: string, o: Parameters<typeof loop>[0], gain: number, secs = 6): Promise<CueReport> {
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.floor(sr * secs), sr);
  const m = new Mixer(off, false);
  m.volume.gain.value = 1;
  const prev = swapMixer(m);
  try {
    const l = loop(o);
    if (l) l.gain.gain.value = gain;
  } finally {
    swapMixer(prev);
  }
  const buf = await off.startRendering();
  return { id, rms: 0, loud: 1, lufs: momentary(buf), len: tail(buf), ...peaks(buf) };
}

const BED_RENDERS: [string, Parameters<typeof loop>[0], number][] = [
  ["bed-wind-ground", { bus: "amb", brown: true, freq: 420, q: 0.5 }, windGain(0.25, 0)],
  ["bed-wind-high", { bus: "amb", brown: true, freq: 420, q: 0.5 }, windGain(1, 30)],
  ["bed-harbor", { bus: "amb", brown: true, type: "lowpass", freq: 520, q: 0.4 }, BEDS.harbor[0] + BEDS.harbor[1]],
  ["bed-city", { bus: "amb", type: "bandpass", freq: 130, q: 1.2, hum: 50 }, BEDS.city],
  ["bed-launch", { bus: "amb", type: "bandpass", freq: 1900, q: 3 }, BEDS.launch[0] + BEDS.launch[1]],
];

/** Every cue rendered, plus the voice cap under a burst of 80 enemy shots. */
async function checkAll() {
  const cues: CueReport[] = [];
  for (const c of CUES) cues.push(await render(c));
  for (const mood of MOODS) cues.push(await renderMood(mood));
  for (const kind of ["capture", "home"] as const) cues.push(await renderPhrase(kind));
  // Each other region's tune, in the moods of a raid.
  for (const r of ["harbor", "city", "launch"] as RegionId[]) for (const mood of RAID_MOODS) cues.push(await renderMood(mood, r));
  for (const [id, o, gain] of BED_RENDERS) cues.push(await renderBed(id, o, gain));
  const off = new OfflineAudioContext(2, 44100, 44100);
  const m = new Mixer(off, false);
  const prev = swapMixer(m);
  try {
    for (let i = 0; i < 80; i++) sfx.enemyFire(around(i * 13, 5 + (i % 7)), "grunt");
  } finally {
    swapMixer(prev);
  }
  // The music's slider at zero leaves nothing of it, the reverb included.
  let mutedPeak = 0;
  for (const d of [(await moodBuffer("fight", 4, "reservoir", 0)).getChannelData(0)]) for (const x of d) mutedPeak = Math.max(mutedPeak, Math.abs(x));
  return { cues, burstVoices: m.active, mutedPeak };
}

declare global {
  interface Window {
    ringfallSfxCheck?: typeof checkAll;
    ringfallMusicRender?: (mood: Exclude<Mood, "off">, secs?: number, region?: RegionId) => Promise<number[]>;
  }
}

/** Shows the panel and the offline check when the page was opened with `?sfx`. */
export function setupSoundCheck() {
  if (!new URLSearchParams(location.search).has("sfx")) return;
  window.ringfallSfxCheck = checkAll;
  // A mood's left channel at 22 kHz, for listening to or drawing outside the page.
  window.ringfallMusicRender = async (mood: Exclude<Mood, "off">, secs = 21, region: RegionId = "reservoir") => {
    const d = (await moodBuffer(mood, secs, region)).getChannelData(0);
    return Array.from({ length: Math.floor(d.length / 2) }, (_, i) => Math.round(d[i * 2] * 32767));
  };
  const panel = document.createElement("aside");
  panel.id = "sfx-panel";
  const groups = [...new Set(CUES.map((c) => c.group))];
  panel.innerHTML = `<h3>サウンドチェック</h3><p>位置のデモは、いま向いている方向を正面にして鳴る。</p>${groups
    .map((g) => `<h4>${g}</h4><div class="sfx-grid">${CUES.filter((c) => c.group === g)
      .map((c) => `<button type="button" data-cue="${c.id}">${c.label}</button>`)
      .join("")}</div>`)
    .join("")}<h4>曲</h4><div class="sfx-grid">${["off", ...MOODS].map((m) => `<button type="button" data-mood="${m}">${MOOD_NAMES[m as Mood]}</button>`).join("")}</div><div class="sfx-grid">${REGIONS.map((r) => `<button type="button" data-region="${r.id}">${r.name}</button>`).join("")}</div>`;
  panel.addEventListener("click", (e) => {
    const mood = (e.target as HTMLElement).closest<HTMLElement>("[data-mood]")?.dataset.mood;
    const region = (e.target as HTMLElement).closest<HTMLElement>("[data-region]")?.dataset.region;
    if (mood || region) {
      unlock();
      dispatchEvent(new CustomEvent("ringfall-music", { detail: { mood, region } }));
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cue]");
    const cue = b && CUES.find((c) => c.id === b.dataset.cue);
    if (!cue) return;
    unlock();
    for (let i = 0; i < (cue.repeat ?? 1); i++) setTimeout(() => cue.run(i), i * 450);
  });
  document.getElementById("title")?.append(panel);
}
