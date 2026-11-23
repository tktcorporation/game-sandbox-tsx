/**
 * Overnight defence lines on return (ux-design Round 7): night losses and held fortifies
 * close into 島の知らせ with existing words only.
 */
import assert from "node:assert/strict";
import { FEATURES } from "../src/ringfall/meta/features";
import { overnightDefence, tipIsDefence } from "../src/ringfall/view/hub";
import { NODES, nodeIndex } from "../src/ringfall/sim/map";

const supply = NODES[nodeIndex("supply")];
const quarry = NODES[nodeIndex("quarry")];
assert.ok(supply && quarry);

// Night took a node: same words as the signal station's taken line.
{
  const lines = overnightDefence(
    { battle: null },
    { night: { gained: [], lost: [supply.id] } },
  );
  assert.deepEqual(lines, [`${supply.name}を取られた · 島の守りが削られた`]);
}

// Fortified night target that held: toast vocabulary.
{
  const i = nodeIndex(supply.id);
  const lines = overnightDefence(
    { battle: { fortified: [i], targets: [i] } },
    { night: { gained: [], lost: [] } },
  );
  assert.deepEqual(lines, [`固めた · ${supply.name} · 夜の襲撃をはねる`]);
}

// Fortified for 来る遠征 (noticed, not a night target): only while reactive defence is on.
{
  const i = nodeIndex(quarry.id);
  FEATURES.reactiveDefense = false;
  assert.deepEqual(
    overnightDefence({ battle: { fortified: [i], targets: [] } }, { night: { gained: [], lost: [] } }),
    [],
  );
  FEATURES.reactiveDefense = true;
  assert.deepEqual(
    overnightDefence({ battle: { fortified: [i], targets: [] } }, { night: { gained: [], lost: [] } }),
    [`固めた · ${quarry.name} · 来る遠征をはねる`],
  );
  FEATURES.reactiveDefense = false;
}

// Lost overnight: fortified does not also claim 固めた.
{
  const i = nodeIndex(supply.id);
  const lines = overnightDefence(
    { battle: { fortified: [i], targets: [i] } },
    { night: { gained: [], lost: [supply.id] } },
  );
  assert.deepEqual(lines, [`${supply.name}を取られた · 島の守りが削られた`]);
}

assert.equal(tipIsDefence("地図の机 · 来る遠征を固める"), true);
assert.equal(tipIsDefence("車両から出撃 · 補給所を攻める"), true);
assert.equal(tipIsDefence("車両から出撃 · 前線：採石場"), false);

console.log("defence return ok");
