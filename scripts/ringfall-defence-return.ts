/**
 * Defence-return juice after 夜の襲撃 was removed: tipIsDefence still tags attack hands;
 * overnight night-loss / night-fortify lines are gone.
 */
import assert from "node:assert/strict";
import { tipIsDefence } from "../src/ringfall/view/hub";

assert.equal(tipIsDefence("門から出撃 · 補給所を攻める"), true);
assert.equal(tipIsDefence("門から出撃 · 前線：採石場"), false);

console.log("defence return ok");
