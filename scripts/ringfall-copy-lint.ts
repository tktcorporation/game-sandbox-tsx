/**
 * Player-copy SoT check (docs/ringfall/glossary.md, src/ringfall/view/copy.ts):
 *
 *   npm run lint:ringfall-copy
 *
 * Fails when UI sources contain a BANNED synonym, or a raw string literal equal to a
 * TERM / PHRASE value (must import from copy.ts). copy.ts itself is exempt.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BANNED, COPY_VALUES, PENDING_SYNONYMS, PHRASE, TERM } from "../src/ringfall/view/copy";

const ROOT = "src/ringfall";
/** Files exempt from raw-term / banned scans (SoT itself, tools, non-chrome). */
const ALLOW = new Set([
  "view/copy.ts",
  "view/soundcheck.ts",
  "view/icons.ts",
  "view/models.ts",
  "view/modelsheet.ts",
  "view/music.ts",
  "view/soundscape.ts",
  "view/map.ts", // draws world; start kinds use internal "depot" ids
]);

const hasJp = (s: string) => /[\u3040-\u30ff\u3400-\u9fff]/.test(s);

const problems: string[] = [];
const warns: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|html)$/.test(name.name)) out.push(p);
  }
  return out;
}

// Player chrome only. World data (map/config) and the SoT file are exempt via ALLOW.
const files = [...walk(join(ROOT, "view")), join(ROOT, "main.ts"), join(ROOT, "touch.ts"), "ringfall/index.html"].filter((f, i, a) => a.indexOf(f) === i);

/** Strip comments so lint does not hit Japanese in // docs. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function rel(f: string): string {
  return f.replace(/\\/g, "/").replace(/^src\/ringfall\//, "");
}

for (const file of files) {
  const key = rel(file);
  if (ALLOW.has(key) || key === "view/copy.ts") continue;
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    // String literals only (rough): "…" or '…' or `…` without ${.
    const lits = [...line.matchAll(/(["'`])([^"'`\\]|\\.)*?\1/g)].map((m) => m[0].slice(1, -1));
    for (const lit of lits) {
      if (!lit || lit.includes("${")) continue;
      for (const b of BANNED) {
        // Japanese banned: any literal. English banned: only inside player-facing JP strings
        // (not code kinds like kind:"depot").
        const hit = /[a-zA-Z]/.test(b.bad)
          ? hasJp(lit) && lit.toLowerCase().includes(b.bad.toLowerCase())
          : lit === b.bad || lit.includes(b.bad);
        if (hit) problems.push(`${file}:${n}  [banned]  「${b.bad}」→ TERM.${b.keep}（${b.note}）`);
      }
      for (const p of PENDING_SYNONYMS) {
        if (lit === p.bad || (p.bad.length >= 2 && lit.includes(p.bad))) {
          warns.push(`${file}:${n}  [pending-synonym]  「${p.bad}」→ TERM.${p.keep}（${p.note}）`);
        }
      }
      // Exact match of a SoT value as a whole literal → must reference copy.ts (no re-typing).
      if (COPY_VALUES.includes(lit)) {
        problems.push(`${file}:${n}  [raw-term]  「${lit}」は copy.ts の TERM/PHRASE を使う（生リテラル禁止）`);
      }
    }
  });
}

// Sanity: SoT itself defines the tip alias and side title.
if (PHRASE.nextWorkshopRaise !== "次：工房 · 次の段を上げる") {
  problems.push("copy.ts: PHRASE.nextWorkshopRaise must stay live「次：工房 · 次の段を上げる」until rename approved");
}
if (TERM.workshop !== "作業場") problems.push("copy.ts: TERM.workshop must be 作業場 (world label)");
if (PHRASE.sideWorkshop !== "隠れ家") problems.push("copy.ts: PHRASE.sideWorkshop must stay 隠れ家 until rename approved");

if (warns.length) {
  console.warn(`RINGFALL COPY LINT warnings (${warns.length}):`);
  for (const w of warns.slice(0, 40)) console.warn(`  ${w}`);
  if (warns.length > 40) console.warn(`  … +${warns.length - 40} more`);
}

if (problems.length) {
  console.error(`RINGFALL COPY LINT FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(
  `RINGFALL COPY LINT OK: ${Object.keys(TERM).length} terms, ${Object.keys(PHRASE).length} phrases, ${BANNED.length} banned` +
    (warns.length ? `, ${warns.length} pending-synonym warnings` : ""),
);
