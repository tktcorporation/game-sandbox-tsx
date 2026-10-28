/**
 * The fixed cameras of the island's tour, shared by the shots gate (`ringfall-shots.mjs`) and the
 * look tool (`ringfall-look.ts`). Each is [name, frame, dx, y, dz, yaw, pitch, abs]: (dx, dz) in
 * the frame named (a POI by its id, a hamlet by its name, an area as "area:" and its id; null for
 * the world's own coordinates), y above the ground at the camera or, with `abs`, absolute.
 */

export const TOUR = [
  // The reservoir, at eye height unless marked absolute (a crest, a floor up a tower).
  ["tour-1-lakebed-from-dam", "area:heart", 0, 17.7, -120, Math.PI, -0.25, true],
  ["tour-2-dam-face", "area:heart", 0, 1.7, -70, 0, 0.25],
  ["tour-3-town-street", "area:heart", 0, 1.7, 45, 0, 0.05],
  ["tour-4-church-spire", "area:heart", -5, 1.7, 15, -0.7, 0.3],
  ["tour-5-spillway", "area:heart", 112, 1.7, -108, 0, 0.15],
  ["tour-6-quarry-pit", "quarry", 20, 1.7, -75, Math.PI, -0.3],
  ["tour-7-high-rise-view", "area:heart", -26, 4.6, -14, 2.5, -0.25, true],
  ["tour-8-plateau-over-lakebed", "area:heart", -95, 1.7, -5, 1.57, -0.15],
  ["tour-9-terraced-fields", "area:village", 60, 1.7, 75, -0.66, 0.08],
  ["tour-10-over-supply", "supply", 130, 45, -120, -2.32, -0.3, true],
  ["tour-11-mesa-relay", "relay", -50, 1.7, 25, 1.08, 0.3],
  // The tether's anchor over the titan's arena, the view south from its gallery over the pad, the
  // fallen tether from beside it and through its corridor, and both from above the pad.
  ["tour-60-anchor-from-pad", "pad", 30, 1.7, 20, -0.15, 0.32],
  ["tour-61-anchor-gallery", "area:anchor", 0, 16 + 34.3 + 1.6, 7.5, Math.PI, -0.3, true],
  ["tour-62-fallen-tether", "area:anchor", -66, 1.7, 30, -1.25, 0.06],
  ["tour-63-tether-corridor", "area:anchor", -86, 1.7, 0, -1.57, 0.02],
  ["tour-64-anchor-and-tether", "area:anchor", -20, 70, 110, -0.55, -0.42, true],
];

// The harbor and the ways there.
export const HARBOR_TOUR = [
  ["tour-12-pass-saddle", "area:pass", -60, 1.7, -228, 0.05, -0.05],
  ["tour-13-railway-bridge", "area:railway", 100, 1.7, -191, 1.45, 0.32],
  ["tour-14-bridge-deck", "area:railway", 122, 11.8, -168, 0, -0.04, true],
  // Under the viaduct's corner, looking west along it.
  ["tour-15-viaduct", null, 165, 1.7, -622, -1.42, 0.16],
  ["tour-16-wreck", "wreck", -12, 1.7, 40, 0.12, 0.1],
  ["tour-17-wreck-deck", "wreck", -38, -3 + 13.5 + 1.7, 4, 1.5, 0.02, true],
  ["tour-17b-wreck-bridge-wing", "wreck", 58, -3 + 13.5 + 13.6 + 1.7, -19, -1.57, -0.18, true],
  ["tour-18-yard-alley", "yard", -46, 1.7, -29.5, 1.57, 0.02],
  ["tour-19-yard-crane", "yard", 46.4, 13.6 + 1.6, 14, 0, -0.2, true],
  ["tour-19b-yard-quay-crane", "yard", 46, 34 + 1.7, -45, Math.PI, -0.3, true],
  ["tour-20-smelter", "smelter", 8, 1.7, 44, 0, 0.14],
  ["tour-21-lighthouse", "area:bay", -66, 1.7, -514, -0.97, 0.22],
  ["tour-22-lighthouse-view", "area:bay", -112.9, 33.4, -552, 1.45, -0.2, true],
  ["tour-23-salt-flats", "area:bay", -40, 1.7, -468, 0.75, 0.0],
  ["tour-24-quay-boat", "area:bay", 94, 1.7, -578, 1.32, -0.1],
  // The open ground between the areas, its outcrops and hamlets.
  ["tour-25-open-ground", null, 60, 1.7, 250, -0.3, 0.0],
  ["tour-26-west-farm", "西の農場", 20, 1.7, 18, -0.84, 0.05],
  ["tour-27-water-tower", "給水所", -25, 1.7, -20, 2.24, 0.08],
  ["tour-28-checkpoint", "東の検問所", -25, 5, 17, 0.97, -0.08],
  ["tour-29-fishing-village", "西の漁村", 25, 1.7, 20, -0.9, 0.05],
  ["tour-30-signal-box", "信号所", 20, 1.7, 20, -0.79, 0.08],
  ["tour-31-reservoir-from-above", null, 0, 150, 560, 0, -0.36, true],
  // The routes' obstacles, all closed in this fresh profile: the tunnel's two choked mouths,
  // the dam's chained gallery door, the wreck's gangway hauled up against its hull.
  ["tour-32-tunnel-rubble", null, 40, 1.7, -287, 0, 0.12],
  ["tour-33-tunnel-rubble-north", null, 40, 1.7, -422, Math.PI, 0.12],
  ["tour-34-dam-gate", "area:heart", 20, 1.7, -97, 0, 0.12],
  // The open ground north of the landing pad, toward the mountains, and the harbor's south plain from the pass.
  ["tour-36-north-of-pad", "pad", -30, 1.7, -110, 0.2, 0.05],
  ["tour-37-harbor-plain", null, -96, 1.7, -440, 0.3, -0.04],
  ["tour-35-gangway-hauled", "wreck", -31, 1.7, -30, Math.PI - 0.45, 0.5],
  // Each POI's landmark from the way in, and the smelter's roofs from the bridge between its halls.
  ["tour-38-supply-silos", "supply", 20, 1.7, 170, -0.16, 0.08],
  // The supply depot at its own scale, from eye height: the tanker's bow over the beach, the
  // street between the assembly hall and the long shed, the yard from the east dune's crest.
  ["tour-46-supply-tanker-from-beach", "supply", 30, 1.7, 160, 0.2, 0.15],
  ["tour-47-supply-street", "supply", -40, 1.7, -15, 1.62, 0.1],
  ["tour-48-supply-dune-crest", "supply", 90, 1.7, 22, -2.2, -0.04],
  // The ring-segment assembly hall: its south face torn open over the segment, the floor from its
  // west end along the segment and the cranes, and the hall from the crane runway's walkway.
  ["tour-65-assembly-hall", "supply", 0, 1.7, 8, -0.15, 0.32],
  ["tour-66-assembly-floor", "supply", -64, 1.7, -30, 1.4, 0.15],
  ["tour-67-assembly-crane-walk", "supply", -66, 28.8, -58.4, 1.85, -0.4, true],
  ["tour-39-quarry-plant", "quarry", -10, 1.7, 25, 0, 0.2],
  // The bucket-wheel excavator from the rim yard, from beside its crawlers, and down its boom from the machine house's roof.
  ["tour-68-quarry-excavator", "quarry", 60, 1.7, -95, 3.05, 0.15],
  ["tour-69-excavator-crawlers", "quarry", 70, 1.7, 40, 0.71, 0.35],
  ["tour-70-excavator-boom", "quarry", 96, 11.6, 12, -1.57, -0.2, true],
  ["tour-40-relay-mast", "relay", -20, 1.7, 20, -0.57, 0.35],
  // The big dish: from the mesa's top, from its gallery into the bowl, and over the works from the south-west.
  ["tour-71-relay-dish", "relay", -20, 1.7, 20, 1.2, 0.35],
  ["tour-72-dish-gallery", "relay", 14.5, 39.3, -5, 1.57, 0.25, true],
  ["tour-73-dish-from-works", "relay", -60, 1.7, 230, 0.2, 0.12],
  ["tour-41-pad-hangars", "pad", 0, 1.7, 60, 0, 0.1],
  // The reservoir's POIs and districts at their own scale, from eye height: the quarry's
  // terraces from its floor and its tunnel, the mesa from its foot and from its ledge road,
  // the pad's runway, the intake tower before the dam, the fields from the hill and the
  // windmill, the sawtooth works and the car park, the drowned town from a roof.
  ["tour-49-quarry-from-floor", "quarry", -30, 1.7, 30, 1.57, 0.2],
  ["tour-50-quarry-tunnel", "quarry", -60, 1.7, 22, -1.57, 0.05],
  ["tour-51-mesa-from-foot", "relay", -130, 1.7, 60, 1.2, 0.25],
  ["tour-52-mesa-ledge", "relay", 30, 1.7, 52, -1.57, 0.05],
  ["tour-53-pad-runway", "pad", 60, 1.7, -42, -1.57, 0.02],
  ["tour-54-intake-tower", "area:heart", -20, 1.7, -60, -0.4, 0.35],
  ["tour-55-fields-from-hill", "area:village", -10, 1.7, -50, Math.PI, -0.1],
  ["tour-56-windmill", "area:village", -25, 1.7, -15, -0.2, 0.25],
  ["tour-57-factory-sawtooth", "area:factory", -55, 1.7, 10, 0, 0.12],
  ["tour-58-housing-carpark", "area:factory", 30, 1.7, 20, 0.6, 0.12],
  ["tour-59-drowned-roofs", "area:heart", 10, -8.9, -20, 0.8, -0.05, true],
  ["tour-42-wreck-length", "wreck", 40, 1.7, 50, -0.67, 0.12],
  ["tour-43-yard-gantries", "yard", 0, 1.7, 60, 0, 0.12],
  ["tour-44-smelter-chimneys", "smelter", 20, 1.7, 70, -0.28, 0.18],
  ["tour-45-smelter-deck", "smelter", -14, 3 + 34 + 1.7, -4, Math.PI / 2, -0.22, true],
  // The outposts between the POIs, and the works that lead from one to the next: the power line
  // north from the substation toward the quay, the freight line east past the yard.
  ["tour-74-substation", "変電所", -40, 1.7, 25, 1.01, 0.12],
  ["tour-75-fuel-depot", "燃料基地", -45, 1.7, 30, 0.98, 0.1],
  ["tour-76-marshalling-yard", "貨物操車場", 45, 1.7, 40, -0.84, 0.08],
  ["tour-77-power-line", null, 112, 1.7, -660, -0.08, 0.15],
  ["tour-78-freight-line", null, -175, 1.7, -775, 1.4, 0.04],
  ["tour-79-pipeline", null, 330, 1.7, -800, -1.2, 0.12],
  ["tour-80-harbor-from-above", null, 0, 230, -520, 0, -0.5, true],
  ["tour-81-wharf", "荷揚げ場", 30, 1.7, 40, -0.64, 0.12],
  ["tour-82-engine-depot", "保線基地", -35, 1.7, 40, 0.72, 0.08],
  ["tour-83-east-substation", "東の変電所", -45, 1.7, 30, 0.98, 0.12],
  ["tour-84-pumping-station", "揚水ポンプ場", -45, 1.7, 35, 0.91, 0.08],
  // The streets, the town on the ring road, and the fences with their gates.
  ["tour-85-town-street", "湖畔の町", -45, 1.7, -7, 1.6, 0.04],
  ["tour-86-town-from-above", "湖畔の町", 0, 45, 55, 0, -0.6],
  ["tour-87-ring-road-traffic", null, 170, 1.7, 212, -1.6, 0.02],
  ["tour-88-yard-fence", null, -120, 1.7, -648, -0.67, 0.05],
  ["tour-89-supply-fence", null, -30, 1.7, 285, 3.14, 0.05],
  // The ring's wreckage: a gap between lengths, the tunnel, a leaning length, the canyon on the east shore.
  ["tour-90-ring-wreck-south-of-quarry", null, -300, 1.7, 320, -0.4, 0.1],
  ["tour-91-ring-wreck-tunnel", null, -340, 1.7, 230, 1.57, 0],
  ["tour-92-ring-wreck-leaning", null, -334, 22, 300, 0, -0.1],
  ["tour-93-ring-wreck-east-shore", null, 400, 1.7, 125, 1.57, 0.06],
  ["tour-94-ring-wreck-harbor", null, -240, 1.7, -490, 0, 0.08],
  // The ring's habitat section on the dry bay (its floor at -5.5): from the bay, its gash, down
  // the west bay's hall, the middle bay's gallery over its hall, and over the bay from its roof.
  ["tour-95-ring-node", "環の結節点", -110, 1.7, 80, 0.94, 0.12],
  ["tour-96-ring-node-rim", "環の結節点", -66, 1.7, 38, 1.05, -0.05],
  ["tour-97-ring-node-corridor", "環の結節点", -62, -2.43 + 1.7, 0, Math.PI / 2, 0.06, true],
  ["tour-98-ring-node-core", "環の結節点", -13, -2.43 + 1.7, 13, 0.785, 0.35, true],
  ["tour-99-ring-node-hall", "環の結節点", -36, -2.43 + 11 + 1.7, -14, 1.2, 0, true],
  ["tour-100-ring-node-roof", "環の結節点", 20, -2.43 + 22 + 1.7, -40, -2.68, -0.22, true],
  ["tour-101-ring-node-breach", "環の結節点", 72, 1.7, -52, -2.16, 0.18],
];

/** A tour camera placed in the world: [name, x, dy, z, yaw, pitch, abs], from `frames` (window.ringfallFrames()). */
export const place = (frames, [name, frame, dx, y, dz, yaw, pitch, abs]) => {
  const f = frame ? frames[frame] : { x: 0, z: 0 };
  if (!f) throw new Error(`tour camera ${name}: no frame ${frame}`);
  return [name, f.x + dx, y, f.z + dz, yaw, pitch, !!abs];
};
