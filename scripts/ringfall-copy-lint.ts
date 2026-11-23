/**
 * Player-copy SoT check (docs/ringfall/glossary.md, src/ringfall/view/copy.ts):
 *
 *   npm run lint:ringfall-copy
 *
 * Fails when UI sources contain a BANNED synonym, or a raw string literal equal to a
 * TERM / PHRASE value (must import from copy.ts). copy.ts itself is exempt.
 *
 * Scans quoted strings and the static segments of template literals (including text
 * around ${…} and inside HTML markup), so toast/panel copy is not skipped.
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

/**
 * Player-facing chunks on a line: contents of "…" / '…', and every static segment of
 * a `…` template (text between ${expressions}, including HTML text nodes).
 * Nested quotes inside templates are kept as part of the segment, not as separate hits.
 */
function stringChunks(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let s = "";
      while (i < line.length) {
        if (line[i] === "\\") {
          s += line[i] + (line[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (line[i] === q) {
          i++;
          break;
        }
        s += line[i++];
      }
      if (s) out.push(s);
      continue;
    }
    if (c === "`") {
      i++;
      let seg = "";
      while (i < line.length) {
        if (line[i] === "\\") {
          seg += line[i] + (line[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (line[i] === "`") {
          i++;
          break;
        }
        if (line[i] === "$" && line[i + 1] === "{") {
          if (seg) out.push(seg);
          seg = "";
          i += 2;
          let depth = 1;
          while (i < line.length && depth > 0) {
            if (line[i] === "{") depth++;
            else if (line[i] === "}") depth--;
            // Skip nested strings inside the expression so braces in them do not confuse depth.
            else if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
              const q = line[i++];
              while (i < line.length) {
                if (line[i] === "\\") {
                  i += 2;
                  continue;
                }
                if (line[i] === q) {
                  i++;
                  break;
                }
                // Nested template: skip its ${…} with a nested walk of the closer only.
                if (q === "`" && line[i] === "$" && line[i + 1] === "{") {
                  i += 2;
                  let d = 1;
                  while (i < line.length && d > 0) {
                    if (line[i] === "{") d++;
                    else if (line[i] === "}") d--;
                    i++;
                  }
                  continue;
                }
                i++;
              }
              continue;
            }
            if (depth > 0) i++;
          }
          continue;
        }
        seg += line[i++];
      }
      if (seg) out.push(seg);
      continue;
    }
    i++;
  }
  return out;
}

/** Text a player might read: strip HTML tags so class names do not hide body copy. */
function readable(chunk: string): string {
  return chunk.replace(/<[^>]*>/g, " ");
}

function checkChunk(file: string, n: number, lit: string): void {
  if (!lit) return;
  const text = readable(lit);
  for (const b of BANNED) {
    // Japanese banned: any chunk. English banned: only inside player-facing JP strings
    // (not code kinds like kind:"depot").
    const hit = /[a-zA-Z]/.test(b.bad)
      ? hasJp(text) && text.toLowerCase().includes(b.bad.toLowerCase())
      : text === b.bad || text.includes(b.bad) || lit === b.bad || lit.includes(b.bad);
    if (hit) problems.push(`${file}:${n}  [banned]  「${b.bad}」→ TERM.${b.keep}（${b.note}）`);
  }
  for (const p of PENDING_SYNONYMS) {
    // Still the live SoT value: rename not applied yet — do not warn on the current TERM word.
    if (TERM[p.keep] === p.bad) continue;
    // Exact match only when `bad` is a substring of another COPY_VALUE (e.g. 送る ⊂ 倉庫へ送る).
    const nestedInOtherTerm = COPY_VALUES.some((v) => v !== p.bad && v.includes(p.bad));
    const hit = nestedInOtherTerm
      ? text === p.bad || lit === p.bad
      : text === p.bad || lit === p.bad || (p.bad.length >= 2 && (text.includes(p.bad) || lit.includes(p.bad)));
    if (hit) warns.push(`${file}:${n}  [pending-synonym]  「${p.bad}」→ TERM.${p.keep}（${p.note}）`);
  }
  // Exact match of a SoT value as a whole literal / static segment → must reference copy.ts.
  const trimmed = lit.trim();
  if (COPY_VALUES.includes(lit) || COPY_VALUES.includes(trimmed)) {
    problems.push(`${file}:${n}  [raw-term]  「${trimmed}」は copy.ts の TERM/PHRASE を使う（生リテラル禁止）`);
  }
}

for (const file of files) {
  const key = rel(file);
  if (ALLOW.has(key) || key === "view/copy.ts") continue;
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const lit of stringChunks(line)) checkChunk(file, n, lit);
  });
}

// Sanity: adopted glossary values (Option A + glossary renames).
if (TERM.workshop !== "作業場") problems.push("copy.ts: TERM.workshop must be 作業場");
if (PHRASE.sideWorkshop !== TERM.workshop) problems.push("copy.ts: PHRASE.sideWorkshop must be TERM.workshop");
if (PHRASE.sideFactory !== TERM.factory) problems.push("copy.ts: PHRASE.sideFactory must be TERM.factory");
if (TERM.raiseLevel !== "レベルを上げる") problems.push("copy.ts: TERM.raiseLevel must be レベルを上げる (glossary; one-line revert if disagreed)");
if (!PHRASE.nextWorkshopRaise.includes(TERM.workshop) || !PHRASE.nextWorkshopRaise.includes(TERM.raiseLevel)) {
  problems.push("copy.ts: PHRASE.nextWorkshopRaise must use 作業場 · レベルを上げる");
}

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
