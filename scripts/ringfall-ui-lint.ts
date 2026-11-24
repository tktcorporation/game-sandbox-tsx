/**
 * The screens' rules, checked without a browser (docs/ringfall/ui.md):
 *
 *   npm run lint:ringfall            # fails on a broken rule, naming the line
 *   npm run lint:ringfall -- --write # rewrites the stylesheet's palette block from view/palette.ts
 *
 * What it reads: `src/ringfall/style.css`, `ringfall/index.html` and the screens' TypeScript
 * (`src/ringfall/view/`, `touch.ts`, `main.ts`). The rules are in `RULES` below, each with the
 * reason it exists; a rule is added there and in the doc together.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { UI } from "../src/ringfall/view/palette";

const CSS = "src/ringfall/style.css";
const HTML = "ringfall/index.html";
/** The type scale, in px. A size between two of these is one of them. */
export const TYPE_SCALE = [11, 12, 13, 14, 16, 18, 20, 24, 30, 40, 54];
/** The weights the page loads (index.html's font link): 500 and 800 of M PLUS 1p, 600 and 800 of Saira Condensed. */
const WEIGHTS = ["500", "600", "800", "inherit"];
/** The layers, lowest first: what a z-index may be. */
const Z_MAX = 10;
/** The corner radii: square plates, a key cap's 3 px, a pill's 6 px, round buttons. */
const RADII = ["0", "2px", "3px", "6px", "50%", "999px"];
/** TypeScript whose colours are the world's (`PAL`), checked by `npm run models:ringfall`, or the palette itself. */
const WORLD_TS = ["models.ts", "palette.ts", "world.ts", "ground.ts", "shade.ts", "scatter.ts", "streets.ts", "trim.ts", "battle.ts", "camp.ts"];

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const triplet = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

/** The stylesheet's palette block, as view/palette.ts gives it. */
function paletteBlock(): string {
  const lines = Object.entries(UI).flatMap(([k, hex]) => [`  --${kebab(k)}: ${hex};`, `  --${kebab(k)}-rgb: ${triplet(hex)};`]);
  return ["/* palette:start — written from view/palette.ts by `npm run lint:ringfall -- --write`; change a colour there. */", ":root {", ...lines, "}", "/* palette:end */"].join("\n");
}
const BLOCK = /\/\* palette:start[\s\S]*?\/\* palette:end \*\//;

const problems: string[] = [];
const say = (file: string, line: number, rule: string, text: string) => problems.push(`${file}:${line}  [${rule}]  ${text}`);

const COLOUR = /\brgb\(var\(--[a-z0-9-]+\) \/ [0-9.]+\)|#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;
/** A colour literal is allowed only as `rgb(var(--x-rgb) / a)`. */
const tokenRgb = (c: string) => /^rgb\(var\(--[a-z0-9-]+-rgb\) \/ [0-9.]+\)$/.test(c);

function lintCss() {
  let css = readFileSync(CSS, "utf8");
  const want = paletteBlock();
  const have = css.match(BLOCK)?.[0];
  if (process.argv.includes("--write")) {
    if (!have) throw new Error(`${CSS} has no palette block to rewrite`);
    if (have !== want) writeFileSync(CSS, (css = css.replace(BLOCK, want)));
  } else if (have !== want) say(CSS, 1, "palette", "the palette block is not what view/palette.ts gives: run `npm run lint:ringfall -- --write`");
  // A custom property is defined in the stylesheet or set by the screens' code (`style="--c:…"`, setProperty).
  const code = viewFiles().map((f) => readFileSync(f, "utf8")).join("\n");
  const tokens = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), ...code.matchAll(/["'`;\s](--[a-z0-9-]+)[:"'`,]/g)].map((m) => m[1]));
  const body = have ? css.replace(BLOCK, (b) => b.replace(/[^\n]/g, " ")) : css;
  const lines = body.split("\n");
  let depthRoot = false;
  lines.forEach((raw, i) => {
    const n = i + 1;
    const l = raw.trim();
    if (/^:root\s*\{/.test(l)) depthRoot = true;
    else if (depthRoot && l === "}") depthRoot = false;
    if (l.endsWith("{") || !l.includes(":")) return;
    const prop = l.slice(0, l.indexOf(":")).trim();
    const value = l.slice(l.indexOf(":") + 1);
    // Colours: from the palette, so a meaning has one colour on every screen.
    if (!/mask/.test(prop))
      for (const c of value.match(COLOUR) ?? []) {
        if (tokenRgb(c)) continue;
        say(CSS, n, "colour", `${c} — use var(--name) or rgb(var(--name-rgb) / a) from view/palette.ts`);
      }
    for (const v of value.matchAll(/var\((--[a-z0-9-]+)/g)) if (!tokens.has(v[1])) say(CSS, n, "token", `${v[1]} is not defined`);
    if (prop === "font-size") {
      const v = value.replace(/;|!important/g, "").trim();
      const px = v.match(/^([0-9.]+)px$/);
      if (px && !TYPE_SCALE.includes(Number(px[1]))) say(CSS, n, "type-scale", `${v} — the scale is ${TYPE_SCALE.join(", ")} px`);
      if (!px && !/^(clamp\(|[0-9.]+em$|inherit$)/.test(v)) say(CSS, n, "type-scale", `${v} — a px of the scale, an em or a clamp()`);
      for (const c of v.matchAll(/([0-9.]+)px/g)) if (Number(c[1]) < TYPE_SCALE[0]) say(CSS, n, "type-min", `${c[1]}px is under ${TYPE_SCALE[0]} px, too small to read on a phone`);
    }
    if (prop === "font-weight" && !WEIGHTS.includes(value.replace(";", "").trim())) say(CSS, n, "font-weight", `${value.trim()} — the page loads ${WEIGHTS.slice(0, 3).join(", ")} only; another is drawn as the nearest of them`);
    if (prop === "font-family" && !/^\s*(var\(--(num|jp)\)|inherit);?$/.test(value)) say(CSS, n, "font-family", `${value.trim()} — var(--num) for numbers and labels, var(--jp) for sentences`);
    if ((prop === "font" && value.trim() !== "inherit;") || /monospace/.test(value)) say(CSS, n, "font-family", `${l} — no shorthand and no monospace (docs/ringfall/brief.md, 使わないもの)`);
    if (prop === "z-index" && !(Number(value.replace(";", "")) <= Z_MAX)) say(CSS, n, "z-index", `${value.trim()} — the layers run 1 to ${Z_MAX}`);
    if (prop === "border-radius") {
      const v = value.replace(";", "").trim();
      if (!v.split(/\s+/).every((p) => RADII.includes(p))) say(CSS, n, "radius", `${v} — one of ${RADII.join(", ")}`);
    }
  });
}

const viewFiles = () => [...readdirSync("src/ringfall/view").map((f) => `src/ringfall/view/${f}`), "src/ringfall/touch.ts", "src/ringfall/main.ts"].filter((f) => f.endsWith(".ts"));

function lintTs() {
  const files = viewFiles().filter((f) => !WORLD_TS.some((w) => f.endsWith(`/${w}`)));
  for (const f of files) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((l, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
        const code = l.replace(/\/\/.*$/, "");
        for (const c of code.match(/["'`(:]\s*#[0-9a-fA-F]{6}\b|["'`(:]\s*#[0-9a-fA-F]{3}\b|\brgba?\(\s*[0-9]/g) ?? []) say(f, i + 1, "colour", `${c.trim()} — take it from UI in view/palette.ts (alpha(UI.night, 0.9) for a see-through one)`);
        if (/font-size:\s*[0-9]|fontSize\s*=/.test(code)) say(f, i + 1, "type-scale", "a font size set in code — give the element a class and size it in style.css");
        if (/monospace/.test(code)) say(f, i + 1, "font-family", "no monospace (docs/ringfall/brief.md, 使わないもの)");
      });
  }
}

/** Loot's colours are one set: the world's (`RARITY_CSS` in models.ts) and the screens'. */
function lintRarity() {
  const line = readFileSync("src/ringfall/view/models.ts", "utf8").match(/export const RARITY_CSS = \[([^\]]*)\]/)?.[1] ?? "";
  const world = [...line.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase());
  const ui = [UI.r0, UI.r1, UI.r2, UI.r3];
  if (world.join() !== ui.join()) say("src/ringfall/view/models.ts", 1, "palette", `RARITY_CSS is ${world.join(" ")} but UI.r0..r3 are ${ui.join(" ")}`);
}

/** A custom property the code sets (a count, a width, a thing's colour) must not take a palette colour's name: it would replace that colour for everything under it. */
function lintOverrides() {
  const palette = new Set(Object.keys(UI).flatMap((k) => [`--${kebab(k)}`, `--${kebab(k)}-rgb`]));
  for (const f of viewFiles().filter((v) => !v.endsWith("/palette.ts")))
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((l, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
        for (const m of l.matchAll(/["'`;\s(](--[a-z0-9-]+)\s*[:"'`,]/g)) if (palette.has(m[1])) say(f, i + 1, "token", `${m[1]} is a palette colour's name — name what the code sets something else (--own-n for a count)`);
      });
  readFileSync(CSS, "utf8")
    .replace(BLOCK, (b) => b.replace(/[^\n]/g, " "))
    .split("\n")
    .forEach((l, i) => {
      const m = l.match(/^\s*(--[a-z0-9-]+)\s*:/);
      if (m && palette.has(m[1])) say(CSS, i + 1, "token", `${m[1]} is set outside the palette block`);
    });
}

/** An inline icon's class (`svg(body, "exit")`) must not be a class the stylesheet styles on its own: the icon would take that rule (a damage number's place, a card's box). */
function lintIconClasses() {
  const css = readFileSync(CSS, "utf8");
  for (const f of ["src/ringfall/view/icons.ts"])
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((l, i) => {
        for (const m of l.matchAll(/`,\s*"([a-z0-9-]+)"(?:,\s*\d+)?\)/g)) if (new RegExp(`^\\.${m[1]}[ ,{:]`, "m").test(css)) say(f, i + 1, "icon-class", `.${m[1]} is styled on its own in style.css — give the icon another class (i-${m[1]})`);
      });
}

function lintHtml() {
  const html = readFileSync(HTML, "utf8");
  const link = html.match(/fonts\.googleapis\.com\/css2\?[^"]*/)?.[0] ?? "";
  const loaded = new Set([...link.matchAll(/wght@([0-9;]+)/g)].flatMap((m) => m[1].split(";")));
  for (const w of WEIGHTS.slice(0, 3)) if (!loaded.has(w)) say(HTML, 1, "font-weight", `the font link does not load weight ${w}, which the lint allows`);
  html.split("\n").forEach((l, i) => {
    if (/\sstyle="/.test(l)) say(HTML, i + 1, "inline-style", "a style attribute — style it in style.css");
  });
}

lintCss();
lintTs();
lintRarity();
lintOverrides();
lintIconClasses();
lintHtml();
if (problems.length) {
  const by = new Map<string, number>();
  for (const p of problems) {
    const rule = p.match(/\[([a-z-]+)\]/)![1];
    by.set(rule, (by.get(rule) ?? 0) + 1);
  }
  console.error(problems.join("\n"));
  console.error(`\nRINGFALL UI LINT FAILED: ${problems.length} (${[...by].map(([r, n]) => `${r} ${n}`).join(", ")})`);
  process.exit(1);
}
console.log(`RINGFALL UI LINT OK: ${Object.keys(UI).length} colours, type scale ${TYPE_SCALE.join("/")} px`);
