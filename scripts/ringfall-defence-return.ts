/**
 * Defence-return juice after 夜の襲撃 was removed: tipIsDefence still tags attack hands;
 * overnight night-loss / night-fortify lines are gone.
 *
 * Also locks the 届けた-notification removal (design-direction): signal/results must not
 * show 「…届けた」, and 島の守り stays on toast + 「〜に回る／回った」 only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tipIsDefence } from "../src/ringfall/view/hub";
import { PHRASE } from "../src/ringfall/view/copy";

assert.equal(tipIsDefence("門から出撃 · 補給所を攻める"), true);
assert.equal(tipIsDefence("門から出撃 · 前線：採石場"), false);

assert.match(PHRASE.islandGuardVia, /島の守りに回る$/);
assert.match(PHRASE.islandGuardWent, /島の守りに回った$/);

/** Strip comments so JSDoc mentioning the removed copy does not fail the lock. */
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const hub = strip(readFileSync("src/ringfall/view/hub.ts", "utf8"));
const hud = strip(readFileSync("src/ringfall/view/hud.ts", "utf8"));
assert.equal(/namedAid/.test(hub), false, "hub: namedAid should be removed");
assert.equal(/届けた/.test(hub), false, "hub: 「届けた」 lines must not return");
assert.equal(/`届け /.test(hub) || /届け \$\{/.test(hub), false, "hub: 「届け N」 mark must not return");
assert.equal(/届けた/.test(hud), false, "hud: 「届けた」 lines must not return");
assert.equal(/namedAid/.test(hud), false, "hud: namedAid import must be gone");
// Toast + results keep 島の守りに回る／回った.
assert.match(hud, /islandGuardVia/);
assert.match(hud, /islandGuardWent/);

console.log("defence return ok");
