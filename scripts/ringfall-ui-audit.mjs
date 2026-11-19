/**
 * The screens' rules that only a browser can check (docs/ringfall/ui.md): every screenshot the
 * shots gate takes is first measured as a page, and what breaks a rule is a finding.
 *
 *   clip      text cut off by its own box or by a box round it
 *   offscreen text that runs past the window's edge with nothing to scroll
 *   ghost     text showing through a see-through plate laid over it
 *   overlap   two texts drawn on one another
 *   small     text under `MIN_TEXT` px
 *   contrast  text too close to its ground's colour (WCAG's ratio: `CONTRAST`)
 *   bare      text straight on the world with no plate and no shadow
 *   tap       on a phone, something to press smaller than `TAP` px
 *   wordy     a run of text longer than `WORDY` characters: a sentence where a name, a number or a mark would do
 *
 * `audited(browser)` wraps a browser so each page's `screenshot({ path })` is measured under the
 * shot's name; `judge()` compares what was found with `scripts/ringfall-ui-baseline.json`, the
 * findings already known. A finding not in the baseline fails the gate; one in the baseline that
 * is gone asks for the baseline to be rewritten (`UI_AUDIT=write`), so the list only shrinks.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

export const BASELINE = "scripts/ringfall-ui-baseline.json";
const DIR = "shots/ringfall/ui-audit";
/** The numbers the page is measured against. */
export const RULES = { MIN_TEXT: 11, TAP: 40, CONTRAST: 4.5, CONTRAST_LARGE: 3, LARGE: 18, PLATE: 0.4, WORDY: 18 };

/** Runs in the page. Returns `[rule, selector, detail]` for each finding. */
function measure(R) {
  const out = [];
  const seen = new Set();
  const vw = innerWidth;
  const vh = innerHeight;
  const touch = navigator.maxTouchPoints > 0;
  const style = document.createElement("style");
  // Paint order is read with elementsFromPoint, which skips what takes no pointer.
  style.textContent = "*{pointer-events:auto!important}";
  document.head.append(style);
  const name = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      if (e.id) {
        parts.unshift(`#${e.id}`);
        break;
      }
      const cls = [...e.classList].filter((c) => !/^(on|off|active|picked|pick|sel|open|done|ok|low|hot|new|show|live|lit)$/.test(c)).slice(0, 2);
      parts.unshift(e.tagName.toLowerCase() + (cls.length ? `.${cls.join(".")}` : ""));
    }
    return parts.join(" ");
  };
  const add = (rule, el, detail) => {
    const key = `${rule}|${name(el)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([rule, name(el), detail]);
  };
  const rgba = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const over = (top, under) => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), a + under[3] * (1 - a)];
  };
  /** Shown at all: laid out, not hidden, not faded out by itself or anything round it. */
  const shown = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden") return 0;
      o *= Number(s.opacity);
    }
    return o;
  };
  /** The ground a text is read against: the plates behind it laid over one another, and how solid they are together. */
  const ground = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      const c = rgba(s.backgroundColor);
      if (s.backgroundImage !== "none" && c[3] < 0.5) return null; // a gradient or picture: not measured
      if (c[3] > 0) layers.push([c[0], c[1], c[2], c[3] * Number(s.opacity)]);
    }
    let g = [0, 0, 0, 0];
    for (const l of layers.reverse()) g = over(l, g);
    return g;
  };
  /** Fading in or out as the shot is taken, or cut on purpose by a box that fades its edges or ends in an ellipsis. */
  const moving = (el) => {
    for (let e = el; e; e = e.parentElement) if (e.getAnimations().some((a) => a.playState === "running")) return true;
    return false;
  };
  const masked = (el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if ((s.maskImage || s.webkitMaskImage || "none") !== "none") return true;
    }
    return false;
  };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  const related = (a, b) => a === b || a.contains(b) || b.contains(a);
  const solid = (el) => {
    const g = ground(el);
    return g ? g[3] : 1;
  };
  const texts = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("svg, canvas, script, style, #touch, select")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const s = getComputedStyle(el);
    // Something to press on a phone: big enough for a thumb.
    if (touch && /^(BUTTON|A|INPUT|SELECT)$/.test(el.tagName) && shown(el) > 0.3 && !el.disabled && s.pointerEvents !== "none") {
      if (Math.min(r.width, r.height) < R.TAP - 0.5) add("tap", el, `${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    if (!ownText(el)) continue;
    const o = shown(el);
    if (o < 0.08) continue;
    const size = parseFloat(s.fontSize);
    if (size < R.MIN_TEXT - 0.01) add("small", el, `${size}px`);
    // A sentence: the screens say things with names, numbers, marks and where they stand (brief, 使わないもの).
    for (const n of el.childNodes) {
      const text = n.nodeType === 3 ? n.textContent.trim() : "";
      if (text.length > R.WORDY) add("wordy", el, `${text.length}: ${text.slice(0, 28)}`);
    }
    // Cut by its own box.
    const clipsX = /hidden|clip/.test(s.overflowX);
    if (clipsX && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== "ellipsis") add("clip", el, `${el.scrollWidth}>${el.clientWidth} wide`);
    if (/hidden|clip/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2 && s.webkitLineClamp === "none") add("clip", el, `${el.scrollHeight}>${el.clientHeight} high`);
    // The text itself (not its box, which may be wider): where it is drawn.
    const range = document.createRange();
    range.selectNodeContents(el);
    const t = range.getBoundingClientRect();
    if (t.width < 1 || t.height < 1) continue;
    // Cut by a box round it, or by the window, with nothing to scroll.
    let scrolls = false;
    let cut = null;
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const ps = getComputedStyle(e);
      if (/auto|scroll/.test(ps.overflowY) || /auto|scroll/.test(ps.overflowX)) scrolls = true;
      if (/hidden|clip/.test(ps.overflow) && !scrolls && ps.textOverflow !== "ellipsis") {
        const pr = e.getBoundingClientRect();
        if (t.right > pr.right + 2 || t.left < pr.left - 2 || t.bottom > pr.bottom + 3 || t.top < pr.top - 3) cut = e;
      }
    }
    // A box that fades its edges out (the compass) cuts on purpose.
    if (cut && (getComputedStyle(cut).maskImage || getComputedStyle(cut).webkitMaskImage || "none") === "none") add("clip", el, `by ${name(cut)}`);
    if (!scrolls && (t.right > vw + 2 || t.left < -2 || t.bottom > vh + 2 || t.top < -2)) {
      // Wholly outside is a thing parked off the screen, not a thing cut.
      if (t.left < vw && t.right > 0 && t.top < vh && t.bottom > 0) add("offscreen", el, `${Math.round(t.left)},${Math.round(t.top)} ${Math.round(t.width)}x${Math.round(t.height)} in ${vw}x${vh}`);
      continue;
    }
    if (t.right <= 0 || t.left >= vw || t.bottom <= 0 || t.top >= vh) continue;
    texts.push({ el, t, o, s, size });
  }
  for (const { el, t, o, s, size } of texts) {
    // What is painted over the middle of the text.
    const cx = Math.min(vw - 1, Math.max(0, t.left + t.width / 2));
    const cy = Math.min(vh - 1, Math.max(0, t.top + t.height / 2));
    const stack = document.elementsFromPoint(cx, cy);
    const at = stack.findIndex((e) => related(e, el));
    if (at < 0) continue; // scrolled out of its list
    if (masked(el) || moving(el)) continue;
    const above = stack.slice(0, at).filter((e) => !related(e, el) && shown(e) > 0.08 && e.tagName !== "CANVAS");
    let covered = false;
    for (const top of above) {
      const a = solid(top) * shown(top);
      if (a >= 0.9) covered = true;
      else if (a > 0.15 && !covered) {
        add("ghost", el, `under ${name(top)} (${a.toFixed(2)} solid)`);
        covered = true;
      } else if (!covered && ownText(top)) {
        const r2 = document.createRange();
        r2.selectNodeContents(top);
        const u = r2.getBoundingClientRect();
        const w = Math.min(t.right, u.right) - Math.max(t.left, u.left);
        const h = Math.min(t.bottom, u.bottom) - Math.max(t.top, u.top);
        if (w > 2 && h > 2 && (w * h) / Math.min(t.width * t.height, u.width * u.height) > 0.25) add("overlap", el, `with ${name(top)}`);
      }
    }
    if (covered) continue;
    // Read against its ground.
    const g = ground(el);
    if (!g) continue;
    const ink = rgba(s.color);
    const shadowed = s.textShadow !== "none" || s.webkitTextStrokeWidth !== "0px" || /drop-shadow/.test(s.filter);
    if (g[3] < R.PLATE) {
      if (!shadowed && !el.closest(".screen, #hub, #map, #depart, #home, #pause, #title")) add("bare", el, `no plate (${g[3].toFixed(2)} solid) and no shadow`);
      continue;
    }
    // What shows through a plate is the world, which is bright: the day's sand.
    const SAND = [217, 168, 104, 1];
    const bg = over(g, SAND);
    const fg = over([ink[0], ink[1], ink[2], ink[3] * o], bg);
    // What cannot be pressed is dim on purpose, and a swatch (●, ▶) is a shape, not a sentence.
    if (el.closest(":disabled, [aria-disabled=true]")) continue;
    const shape = !/[\p{L}\p{N}]/u.test(el.textContent);
    const need = shape || size >= R.LARGE || (size >= 14 && Number(s.fontWeight) >= 700) ? R.CONTRAST_LARGE : R.CONTRAST;
    const c = ratio(fg, bg);
    if (c < need - 0.05 && !shadowed) add("contrast", el, `${c.toFixed(1)} < ${need} (${Math.round(size)}px)`);
  }
  style.remove();
  return out;
}

const found = new Map();
let file = null;

/** Wrap a browser: every page it makes measures itself before each named screenshot. */
export function audited(browser, part = "all") {
  mkdirSync(DIR, { recursive: true });
  file = `${DIR}/${part}.json`;
  const page = (pg) => {
    const shot = pg.screenshot.bind(pg);
    pg.screenshot = async (o = {}) => {
      if (o.path && !process.env.UI_AUDIT_OFF) {
        const key = basename(o.path, ".png");
        try {
          found.set(key, await pg.evaluate(measure, RULES));
          writeFileSync(file, JSON.stringify(Object.fromEntries(found)));
        } catch (e) {
          console.log(`ui audit: ${key} not measured (${String(e).split("\n")[0]})`);
        }
      }
      return shot(o);
    };
    return pg;
  };
  const context = (ctx) => {
    const make = ctx.newPage.bind(ctx);
    ctx.newPage = async (...a) => page(await make(...a));
    return ctx;
  };
  const newContext = browser.newContext.bind(browser);
  const newPage = browser.newPage.bind(browser);
  browser.newContext = async (...a) => context(await newContext(...a));
  browser.newPage = async (...a) => page(await newPage(...a));
  return browser;
}

/** Forget what earlier runs found (a full run starts clean; a part's run replaces only its own file). */
export function clearAudit() {
  rmSync(DIR, { recursive: true, force: true });
}

const keyOf = ([rule, sel]) => `${rule} ${sel}`;

/**
 * Compare every part's findings on disk with the baseline. Returns the lines to print and whether
 * the gate fails. `whole` says every part ran, so a baseline shot that was not taken is stale.
 */
export function judge({ whole = false, parts = null } = {}) {
  const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  const now = {};
  if (existsSync(DIR)) for (const f of readdirSync(DIR)) if (f.endsWith(".json") && (!parts || parts.includes(basename(f, ".json")))) Object.assign(now, JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));
  const lines = [];
  const fresh = [];
  const gone = [];
  const total = {};
  for (const [shot, list] of Object.entries(now)) {
    const known = new Set(base[shot] ?? []);
    const have = new Set(list.map(keyOf));
    for (const f of list) {
      total[f[0]] = (total[f[0]] ?? 0) + 1;
      if (!known.has(keyOf(f))) fresh.push(`  ${shot}.png  [${f[0]}]  ${f[1]}  ${f[2]}`);
    }
    for (const k of known) if (!have.has(k)) gone.push(`  ${shot}.png  ${k}`);
  }
  if (whole) for (const shot of Object.keys(base)) if (!(shot in now)) gone.push(`  ${shot}.png  (not taken any more)`);
  const count = Object.values(total).reduce((a, b) => a + b, 0);
  lines.push(`ui audit: ${Object.keys(now).length} screens, ${count} findings (${Object.entries(total).map(([r, n]) => `${r} ${n}`).join(", ") || "none"})`);
  if (process.env.UI_AUDIT === "write") {
    const next = whole ? {} : { ...base };
    for (const [shot, list] of Object.entries(now)) {
      const keys = [...new Set(list.map(keyOf))].sort();
      if (keys.length) next[shot] = keys;
      else delete next[shot];
    }
    writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
    lines.push(`ui audit: baseline written (${BASELINE})`);
    return { lines, failed: false };
  }
  if (gone.length) lines.push(`ui audit: ${gone.length} known findings are gone — rewrite the baseline with UI_AUDIT=write so they cannot come back:`, ...gone.slice(0, 40));
  if (fresh.length) lines.push(`ui audit: ${fresh.length} NEW findings (docs/ringfall/ui.md):`, ...fresh);
  return { lines, failed: fresh.length > 0 };
}
