/**
 * Procedural, verified paper-fold puzzle generator.
 *
 * No fixed answer bank is sampled at runtime. A seed instantiates a legal fold
 * program, the flat-fold engine derives its crease pattern, and the correct
 * option is built from that exact result. Difficulty changes the program
 * structure (fold depth, off-centre axes, layer count, and distractor closeness)
 * rather than merely changing colours or shuffling choices.
 */
import { lineSegmentInPolygon, mergeCollinearSegments, simulateFlatFolds, segmentToPath } from "./paper-fold-engine.js";

export const PAPER_BOUNDS = Object.freeze({ min: 8, max: 92 });
export const cloneSegments = segments => segments.map(segment => ({ ...segment }));

export const DIFFICULTY_PROFILES = Object.freeze({
  starter: Object.freeze({
    id: "starter",
    label: "起步 · 3 折",
    description: "中央對半 × 2，加上一條斜折",
    folds: 3,
    offCentre: false,
    terminal: false,
    nestedPair: false
  }),
  standard: Object.freeze({
    id: "standard",
    label: "進階 · 4 折",
    description: "偏心對半、斜折與窄邊收合",
    folds: 4,
    offCentre: true,
    terminal: true,
    nestedPair: false
  }),
  challenge: Object.freeze({
    id: "challenge",
    label: "菁英 · 5 折",
    description: "雙重偏心折軸，16 層後才出現斜折",
    folds: 5,
    offCentre: true,
    terminal: false,
    nestedPair: true
  })
});

function hashSeed(seed) {
  let hash = 2166136261;
  for (const character of String(seed)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function seededRandom(seed) {
  let state = hashSeed(seed) || 0x9e3779b9;
  return {
    next() {
      state |= 0;
      state = (state + 0x6D2B79F5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    },
    pick(items) { return items[Math.floor(this.next() * items.length)]; },
    between(min, max) { return min + (max - min) * this.next(); }
  };
}
/** Deterministic Fisher–Yates shuffle so a public seed replays option order too. */
export function shuffleWithSeed(items, seed) {
  const rng = seededRandom(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng.next() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function quantized(rng, min, max, denominator = 256) {
  return Math.round(rng.between(min, max) * denominator) / denominator;
}

const POINT_TRANSFORMS = Object.freeze([
  { id: "r0", point: ({ x, y }) => ({ x, y }) },
  { id: "r90", point: ({ x, y }) => ({ x: 1 - y, y: x }) },
  { id: "r180", point: ({ x, y }) => ({ x: 1 - x, y: 1 - y }) },
  { id: "r270", point: ({ x, y }) => ({ x: y, y: 1 - x }) },
  { id: "mirror", point: ({ x, y }) => ({ x: 1 - x, y }) },
  { id: "mirror-r90", point: ({ x, y }) => ({ x: y, y: x }) },
  { id: "mirror-r180", point: ({ x, y }) => ({ x, y: 1 - y }) },
  { id: "mirror-r270", point: ({ x, y }) => ({ x: 1 - y, y: 1 - x }) }
]);

function lineThrough(first, second) {
  return {
    a: first.y - second.y,
    b: second.x - first.x,
    c: first.x * second.y - second.x * first.y
  };
}
function cornerToPointOperation(id, corner, target, isOffCentre = true) {
  // Folding a corner onto an interior point uses the perpendicular bisector of
  // the corner→target segment. This is a genuine small corner flap, not a
  // whole-sheet diagonal half-fold.
  const a = 2 * (target.x - corner.x);
  const b = 2 * (target.y - corner.y);
  const c = corner.x * corner.x + corner.y * corner.y - target.x * target.x - target.y * target.y;
  const keepSide = a * target.x + b * target.y + c >= 0 ? 1 : -1;
  return { id, kind: "corner", isOffCentre, line: { a, b, c }, keepSide };
}
function valueOnLine(line, point) { return line.a * point.x + line.b * point.y + line.c; }
function twoPointsOnLine(line) {
  if (Math.abs(line.b) > 1e-9) return [{ x: 0, y: -line.c / line.b }, { x: 1, y: -(line.a + line.c) / line.b }];
  const x = -line.c / line.a;
  return [{ x, y: 0 }, { x, y: 1 }];
}
function transformOperation(operation, transform) {
  const [first, second] = twoPointsOnLine(operation.line).map(transform.point);
  let line = lineThrough(first, second);
  const normalLength = Math.hypot(operation.line.a, operation.line.b);
  const probe = {
    x: twoPointsOnLine(operation.line)[0].x + operation.keepSide * operation.line.a / normalLength * 0.05,
    y: twoPointsOnLine(operation.line)[0].y + operation.keepSide * operation.line.b / normalLength * 0.05
  };
  // `lineThrough` chooses an arbitrary normal orientation. Align its positive
  // side with the original operation's keepSide before using the same sign.
  if (valueOnLine(line, transform.point(probe)) < 0) line = { a: -line.a, b: -line.b, c: -line.c };
  return { ...operation, line };
}

function axialFirstProgram(profile, rng) {
  // Folding the smaller side onto the larger side keeps every reflected face
  // within the paper. Matching x/y fractions preserves a square for diagonal
  // folds, so this recipe is valid for every sampled coordinate.
  const firstRatio = profile.offCentre ? quantized(rng, 0.22, 0.47, 1024) : quantized(rng, 0.42, 0.5, 1024);
  const operations = [
    { id: "first-half", kind: "axial", isOffCentre: profile.offCentre, line: { a: 1, b: 0, c: -firstRatio }, keepSide: 1 },
    { id: "second-half", kind: "axial", isOffCentre: profile.offCentre, line: { a: 0, b: 1, c: -firstRatio }, keepSide: 1 }
  ];
  let min = firstRatio;
  let size = 1 - firstRatio;

  if (profile.nestedPair) {
    const nestedRatio = quantized(rng, 0.24, 0.46, 1024);
    const foldAt = min + nestedRatio * size;
    operations.push(
      { id: "nested-x", kind: "nested", isOffCentre: true, line: { a: 1, b: 0, c: -foldAt }, keepSide: 1 },
      { id: "nested-y", kind: "nested", isOffCentre: true, line: { a: 0, b: 1, c: -foldAt }, keepSide: 1 }
    );
    min = foldAt;
    size *= 1 - nestedRatio;
  }

  operations.push({ id: "diagonal", kind: "diagonal", isOffCentre: false, line: { a: 1, b: 1, c: -(1 + min) }, keepSide: 1 });

  if (profile.terminal) {
    const narrowRatio = quantized(rng, 0.27, 0.5, 1024);
    operations.push({ id: "narrow", kind: "terminal", isOffCentre: narrowRatio < .495, line: { a: 1, b: 0, c: -(min + narrowRatio * size) }, keepSide: 1 });
  }
  return { template: "axial-first", operations };
}

function diagonalFirstProgram(profile, rng) {
  // Begin exactly like the reference puzzle family: a square is first divided
  // diagonally. Subsequent folds deliberately move the smaller half into the
  // larger triangular region, so the recipe is as valid as the axial-first one.
  // Introductory diagonal-first items stay close to centre, but do not repeat
  // one frozen diagram. The small offset is enough to create a new trace while
  // remaining visually forgiving for beginners.
  const earlyAxis = profile.id === "starter" ? quantized(rng, .36, .5, 1024) : quantized(rng, .26, .46, 1024);
  const operations = [
    { id: "opening-diagonal", kind: "diagonal", isOffCentre: false, line: { a: 1, b: 1, c: -1 }, keepSide: 1 },
    { id: "triangle-x", kind: "axial", isOffCentre: earlyAxis !== .5, line: { a: 1, b: 0, c: -earlyAxis }, keepSide: 1 },
    { id: "triangle-y", kind: "axial", isOffCentre: earlyAxis !== .5, line: { a: 0, b: 1, c: -earlyAxis }, keepSide: 1 }
  ];

  if (profile.terminal) {
    // This diagonal is parallel to the first one, but offset within the
    // triangular stack. q <= earlyAxis prevents any reflected point escaping
    // through the outer right/bottom paper edge.
    const q = quantized(rng, .12, earlyAxis - .02, 1024);
    operations.push({ id: "offset-diagonal", kind: "diagonal", isOffCentre: true, line: { a: 1, b: 1, c: -(1 + q) }, keepSide: 1 });
  }

  if (profile.nestedPair) {
    const q = quantized(rng, .12, earlyAxis - .03, 1024);
    const foldAt = quantized(rng, earlyAxis + .04, (1 + earlyAxis) / 2 - .015, 1024);
    operations.push(
      { id: "triangle-diagonal", kind: "diagonal", isOffCentre: true, line: { a: 1, b: 1, c: -(1 + q) }, keepSide: 1 },
      { id: "triangle-narrow", kind: "nested", isOffCentre: true, line: { a: 1, b: 0, c: -foldAt }, keepSide: 1 }
    );
  }
  return { template: "diagonal-first", operations };
}


function kiteCascadeProgram(profile, rng) {
  // A diagonal-first kite sequence: its alternating diagonal and axial folds
  // produce the V / diamond motifs used by well-designed paper-fold items.
  const firstAxis = profile.id === "starter" ? quantized(rng, .42, .5, 1024) : quantized(rng, .36, .45, 1024);
  const secondAxis = profile.id === "starter" ? 0.5 : quantized(rng, .36, .5, 1024);
  const diagonalOffset = profile.id === "challenge" ? quantized(rng, .08, .15, 1024) : profile.id === "starter" ? quantized(rng, .005, .06, 1024) : 0;
  const operations = [
    { id: "opening-diagonal", kind: "diagonal", isOffCentre: false, line: { a: 1, b: 1, c: -1 }, keepSide: 1 },
    { id: "kite-vertical", kind: "axial", isOffCentre: firstAxis !== .5, line: { a: 1, b: 0, c: -firstAxis }, keepSide: 1 },
    { id: "kite-cross-diagonal", kind: "diagonal", isOffCentre: diagonalOffset !== 0, line: { a: 1, b: -1, c: diagonalOffset }, keepSide: 1 }
  ];
  if (profile.folds >= 4) operations.push({ id: "kite-horizontal", kind: "nested", isOffCentre: secondAxis !== .5, line: { a: 0, b: 1, c: -secondAxis }, keepSide: 1 });
  if (profile.folds >= 5) operations.push({ id: "kite-narrow", kind: "nested", isOffCentre: true, line: { a: 1, b: 0, c: -quantized(rng, .6, .75, 1024) }, keepSide: 1 });
  return { template: "kite-cascade", operations };
}

function gateRoofProgram(profile, rng) {
  // Two crossing diagonal folds followed by axial folds form roof / gate
  // silhouettes. This is the second major visual family in the reference item.
  const vertical = profile.id === "starter" ? quantized(rng, .58, .78, 1024) : quantized(rng, .65, .78, 1024);
  const horizontal = profile.id === "starter" ? null : quantized(rng, .38, .52, 1024);
  const diagonalOffset = profile.id === "challenge" ? quantized(rng, .1, .16, 1024) : profile.id === "starter" ? quantized(rng, .005, .08, 1024) : 0;
  const operations = [
    { id: "opening-diagonal", kind: "diagonal", isOffCentre: false, line: { a: 1, b: 1, c: -1 }, keepSide: 1 },
    { id: "roof-cross-diagonal", kind: "diagonal", isOffCentre: diagonalOffset !== 0, line: { a: 1, b: -1, c: diagonalOffset }, keepSide: 1 },
    { id: "roof-vertical", kind: "axial", isOffCentre: true, line: { a: 1, b: 0, c: -vertical }, keepSide: 1 }
  ];
  if (profile.folds >= 4) operations.push({ id: "roof-horizontal", kind: "nested", isOffCentre: true, line: { a: 0, b: 1, c: -horizontal }, keepSide: 1 });
  if (profile.folds >= 5) operations.push({ id: "roof-narrow", kind: "nested", isOffCentre: true, line: { a: 1, b: 0, c: -quantized(rng, .72, .85, 1024) }, keepSide: 1 });
  return { template: "gate-roof", operations };
}


function cornerRoofProgram(profile, rng) {
  // Two small top-corner flaps fold toward an interior target. Unlike a full
  // diagonal half-fold, each first/second action affects only a triangular
  // corner region—exactly the kind of compact opening shown in the reference.
  const depth = profile.id === "starter" ? quantized(rng, .38, .48, 1024) : quantized(rng, .32, .45, 1024);
  const vertical = profile.id === "starter" ? 0.5 : quantized(rng, .4, .48, 1024);
  const horizontal = profile.id === "starter" ? null : quantized(rng, .4, .5, 1024);
  const operations = [
    cornerToPointOperation("corner-top-left", { x: 0, y: 0 }, { x: depth, y: depth }),
    cornerToPointOperation("corner-top-right", { x: 1, y: 0 }, { x: 1 - depth, y: depth }),
    { id: "roof-vertical", kind: "axial", isOffCentre: vertical !== .5, line: { a: 1, b: 0, c: -vertical }, keepSide: 1 }
  ];
  if (profile.folds >= 4) operations.push({ id: "roof-horizontal", kind: "nested", isOffCentre: horizontal !== .5, line: { a: 0, b: 1, c: -horizontal }, keepSide: 1 });
  if (profile.folds >= 5) operations.push({ id: "roof-tip", kind: "diagonal", isOffCentre: true, line: { a: 1, b: 1, c: -quantized(rng, 1.4, 1.6, 1024) }, keepSide: 1 });
  return { template: "corner-roof", operations };
}

function asymmetricRoofProgram(profile, rng) {
  // Reference-inspired roof sequence with deliberate imbalance: two local top
  // flaps land at different depths, then off-centre vertical/horizontal folds
  // copy that uneven roof into a grid-like crease pattern. The result keeps the
  // recognisable "house" scaffold of the demo while avoiding an obvious
  // left/right or top/bottom answer symmetry.
  const leftDepth = quantized(rng, profile.id === "starter" ? .34 : .28, profile.id === "starter" ? .43 : .4, 1024);
  const rightDepth = quantized(rng, profile.id === "starter" ? .24 : .2, profile.id === "starter" ? .34 : .33, 1024);
  const vertical = quantized(rng, profile.id === "starter" ? .46 : .38, profile.id === "starter" ? .54 : .48, 1024);
  const horizontal = profile.id === "starter" ? null : quantized(rng, .38, .5, 1024);
  const operations = [
    cornerToPointOperation("asym-corner-top-left", { x: 0, y: 0 }, { x: leftDepth, y: leftDepth }),
    cornerToPointOperation("asym-corner-top-right", { x: 1, y: 0 }, { x: 1 - rightDepth, y: rightDepth }),
    { id: "asym-roof-vertical", kind: "axial", motion: vertical < .5 ? "左→右" : "右→左", fraction: Math.min(vertical, 1 - vertical), isOffCentre: Math.abs(vertical - .5) > .02, line: { a: 1, b: 0, c: -vertical }, keepSide: vertical < .5 ? 1 : -1 }
  ];
  if (profile.folds >= 4) operations.push({ id: "asym-roof-horizontal", kind: "nested", motion: "上→下", fraction: horizontal, isOffCentre: true, line: { a: 0, b: 1, c: -horizontal }, keepSide: 1 });
  if (profile.folds >= 5) operations.push({ id: "asym-roof-narrow", kind: "nested", motion: "右→左", fraction: quantized(rng, .2, .34, 1024), isOffCentre: true, line: { a: 1, b: 0, c: -quantized(rng, .64, .78, 1024) }, keepSide: -1 });
  return { template: "asymmetric-roof", operations };
}

function pointBounds(points) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x), maxX: Math.max(bounds.maxX, point.x),
    minY: Math.min(bounds.minY, point.y), maxY: Math.max(bounds.maxY, point.y)
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
}
function polygonArea(polygon) {
  return Math.abs(polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return sum + point.x * next.y - point.y * next.x;
  }, 0)) / 2;
}
function isClearCornerFold(beforeSimulation, afterSimulation) {
  const before = beforeSimulation.foldLayersByStep.at(-1).packetOutline;
  const after = afterSimulation.foldLayersByStep.at(-1);
  const beforeArea = polygonArea(before);
  const topArea = polygonArea(after.topOutline);
  const packetArea = polygonArea(after.packetOutline);
  // A diagrammed corner fold must remain visibly local: a small flap moves
  // inside a mostly unchanged packet. This rejects misleading whole-side
  // trapezoids produced when a corner target is too far into a narrow packet.
  return beforeArea > 1e-7 && topArea / beforeArea <= .32 && packetArea / beforeArea >= .68;
}
function uniquePoints(points) {
  const seen = new Set();
  return points.filter(point => {
    const key = `${point.x.toFixed(7)},${point.y.toFixed(7)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function randomFlowProgram(profile, rng) {
  // A constrained random fold walk. Every candidate fold is tested against the
  // current simulated packet, so "random" never means geometrically invalid.
  const operations = [];
  let simulation = simulateFlatFolds([]);
  const fractions = profile.id === "starter" ? [1 / 3, .5] : profile.id === "standard" ? [.25, 1 / 3, .5] : [.25, 1 / 3, .4, .5];
  let offCentreCount = 0;
  let previousMotion = "";

  for (let index = 0; index < profile.folds; index += 1) {
    const silhouette = simulation.silhouettes.at(-1);
    const bounds = pointBounds(silhouette);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const candidates = [];
    const needOffCentre = offCentreCount < (profile.id === "challenge" ? 4 : profile.id === "standard" ? 2 : 0) && (profile.folds - index <= (profile.id === "challenge" ? 4 - offCentreCount : profile.id === "standard" ? 2 - offCentreCount : 0));
    const activeFractions = needOffCentre ? fractions.filter(fraction => fraction !== .5) : fractions;

    activeFractions.forEach(fraction => {
      candidates.push(
        { id: `top-down-${index}`, kind: "axial", motion: "上→下", fraction, isOffCentre: fraction !== .5, line: { a: 0, b: 1, c: -(bounds.minY + fraction * height) }, keepSide: 1 },
        { id: `bottom-up-${index}`, kind: "axial", motion: "下→上", fraction, isOffCentre: fraction !== .5, line: { a: 0, b: 1, c: -(bounds.maxY - fraction * height) }, keepSide: -1 },
        { id: `left-right-${index}`, kind: "axial", motion: "左→右", fraction, isOffCentre: fraction !== .5, line: { a: 1, b: 0, c: -(bounds.minX + fraction * width) }, keepSide: 1 },
        { id: `right-left-${index}`, kind: "axial", motion: "右→左", fraction, isOffCentre: fraction !== .5, line: { a: 1, b: 0, c: -(bounds.maxX - fraction * width) }, keepSide: -1 }
      );
    });

    // Corner folds become candidates at every stage. Their target lies 35–50%
    // of the way toward the packet centre, making a small 1/4-ish corner flap.
    const vertices = uniquePoints(simulation.facesByStep.at(-1).flatMap(face => face.polygon));
    const centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const aspect = Math.max(width, height) / Math.max(Math.min(width, height), 1e-6);
    // Do not corner-fold a very thin packet: the visual result becomes an
    // ambiguous whole-side slant rather than the clear small flap in the
    // reference diagrams.
    if (aspect <= 1.55) vertices.forEach((corner, vertexIndex) => {
      const amount = quantized(rng, .22, .4, 1024);
      const target = { x: corner.x + (centre.x - corner.x) * amount, y: corner.y + (centre.y - corner.y) * amount };
      candidates.push({ ...cornerToPointOperation(`corner-${index}-${vertexIndex}`, corner, target), motion: "角落→內部點", fraction: amount, isOffCentre: true });
    });

    // The first action always offers a full diagonal too, matching the visual
    // language of the reference while still permitting a local corner opening.
    if (index === 0) candidates.push({ id: "opening-diagonal", kind: "diagonal", motion: "對角→內部", fraction: .5, isOffCentre: false, line: { a: 1, b: 1, c: -(bounds.minX + bounds.maxY) }, keepSide: 1 });

    const openingOnly = index === 0 ? candidates.filter(candidate => ["corner", "diagonal"].includes(candidate.kind)) : candidates;
    const withinStarterBudget = profile.id === "starter" && offCentreCount >= 2
      ? openingOnly.filter(candidate => !candidate.isOffCentre)
      : openingOnly;
    const differentDirection = withinStarterBudget.filter(candidate => candidate.motion !== previousMotion);
    const pool = differentDirection.length ? differentDirection : withinStarterBudget;
    let next = null;
    while (pool.length) {
      const candidate = pool.splice(Math.floor(rng.next() * pool.length), 1)[0];
      try {
        const attempted = simulateFlatFolds([...operations, candidate]);
        if (!candidateSimulationIsValid(attempted) || attempted.creasesByStep.at(-1).length === 0) continue;
        if (candidate.kind === "corner" && !isClearCornerFold(simulation, attempted)) continue;
        next = candidate;
        simulation = attempted;
        break;
      } catch { /* Try another legal direction. */ }
    }
    if (!next) throw new Error("Random fold walk could not find a valid next fold.");
    operations.push(next);
    if (next.isOffCentre) offCentreCount += 1;
    previousMotion = next.motion;
  }
  return { template: "mixed-direction", operations };
}

function canonicalProgram(profile, rng, templatePreference = "auto") {
  // Public grammars begin with a diagonal crease or a local corner fold whose
  // crease is diagonal; both match the reference item's opening language.
  // They then branch into different grammars—cascade, kite, gate, or corner
  // roof—plus a constrained mixed-direction walk. Each chooses from corner,
  // half, third and quarter folds while the simulator rejects invalid moves.
  const templates = ["diagonal-first", "kite-cascade", "gate-roof", "corner-roof", "asymmetric-roof", "mixed-direction"];
  const template = templatePreference === "auto" ? rng.pick(templates) : templatePreference;
  if (template === "mixed-direction") return randomFlowProgram(profile, rng);
  if (template === "gate-roof") return gateRoofProgram(profile, rng);
  if (template === "corner-roof") return cornerRoofProgram(profile, rng);
  if (template === "asymmetric-roof") return asymmetricRoofProgram(profile, rng);
  if (template === "kite-cascade") return kiteCascadeProgram(profile, rng);
  if (template === "axial-first") return axialFirstProgram(profile, rng);
  return diagonalFirstProgram(profile, rng);
}

function segmentObjects(segments, group, role) {
  return segments.map(segment => ({ d: segmentToPath(segment), group, role }));
}
function allSegmentObjects(creasesByStep) {
  const diagonalIndex = creasesByStep.length - 1;
  const raw = creasesByStep.flatMap((step, index) => segmentObjects(step, index + 1, index < Math.min(2, diagonalIndex) ? "base" : "crease"));
  return dedupeVisualSegments(raw);
}
function flattenGroups(groups) { return groups.flat().map(segment => ({ ...segment })); }
function normalizedSegmentPath(path) {
  const values = (path.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  const [x1, y1, x2, y2] = values;
  const first = `${x1.toFixed(5)},${y1.toFixed(5)}`;
  const second = `${x2.toFixed(5)},${y2.toFixed(5)}`;
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}
// For a final crease diagram, a segment drawn in the opposite direction is
// still the same visible line. Candidate uniqueness is therefore geometric,
// not dependent on SVG command direction or generation group metadata.
function signature(segments) { return segments.map(segment => normalizedSegmentPath(segment.d)).sort().join("|"); }
function dedupeVisualSegments(segments) {
  const seen = new Set();
  return segments.filter(segment => {
    const key = normalizedSegmentPath(segment.d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function candidateSimulationIsValid(simulation) {
  const inSquare = point => point.x >= -1e-7 && point.x <= 1 + 1e-7 && point.y >= -1e-7 && point.y <= 1 + 1e-7;
  return simulation.creases.length > 0 &&
    simulation.faces.every(face => face.polygon.every(inSquare)) &&
    simulation.silhouettes.every(silhouette => silhouette.every(inSquare));
}

function cloneOperations(operations) {
  return operations.map(operation => ({ ...operation, line: { ...operation.line } }));
}
function shiftedFoldProgram(operations, operationIndex, delta) {
  const copy = cloneOperations(operations);
  copy[operationIndex].line.c += delta;
  return copy;
}
function swappedLateFoldProgram(operations) {
  const copy = cloneOperations(operations);
  const last = copy.length - 1;
  [copy[last - 1], copy[last]] = [copy[last], copy[last - 1]];
  return copy;
}

// Response cards use a canonical crease drawing: merge connected collinear
// fragments after all folds are mapped back. This prevents a single physical
// crease from looking like several accidental broken dashes.
export function choiceSegmentsFromCreases(segments) {
  return segmentObjects(mergeCollinearSegments(segments), 1, "choice");
}

function segmentEndpoints(path) {
  const values = (path.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  return [{ x: values[0], y: values[1] }, { x: values[2], y: values[3] }];
}
function endpointDistance(first, second) { return Math.hypot(first.x - second.x, first.y - second.y); }
function segmentDistance(firstPath, secondPath) {
  const [a1, a2] = segmentEndpoints(firstPath);
  const [b1, b2] = segmentEndpoints(secondPath);
  return Math.min(
    (endpointDistance(a1, b1) + endpointDistance(a2, b2)) / 2,
    (endpointDistance(a1, b2) + endpointDistance(a2, b1)) / 2
  );
}
/** Symmetric average nearest-segment distance in the 8–92 SVG paper space. */
export function creasePatternDistance(left, right) {
  const oneWay = (source, target) => source.reduce((total, segment) =>
    total + Math.min(...target.map(other => segmentDistance(segment.d, other.d))), 0
  ) / Math.max(source.length, 1);
  return (oneWay(left, right) + oneWay(right, left)) / 2;
}
function changedSegmentCount(left, right) {
  const leftKeys = new Set(left.map(segment => normalizedSegmentPath(segment.d)));
  const rightKeys = new Set(right.map(segment => normalizedSegmentPath(segment.d)));
  return [...leftKeys].filter(key => !rightKeys.has(key)).length;
}
function sharedSegmentCount(left, right) {
  const rightKeys = new Set(right.map(segment => normalizedSegmentPath(segment.d)));
  return left.filter(segment => rightKeys.has(normalizedSegmentPath(segment.d))).length;
}
function isVisiblyDistinct(correct, candidate) {
  const minimumChanged = Math.max(2, Math.ceil(correct.length * .3));
  // 7 SVG units is ~8% of the paper side: differences must be noticeable at
  // normal card size, not a one-grid-cell or sub-pixel placement quirk.
  return changedSegmentCount(correct, candidate) >= minimumChanged && creasePatternDistance(correct, candidate) >= 7;
}
function hasUniqueVisibleSegments(segments) {
  return new Set(segments.map(segment => normalizedSegmentPath(segment.d))).size === segments.length;
}
function transformedChoiceSegment(segment, pointTransform) {
  const [first, second] = segmentEndpoints(segment.d);
  const transformSvgPoint = point => {
    const folded = pointTransform({ x: (point.x - 8) / 84, y: (point.y - 8) / 84 });
    return { x: 8 + folded.x * 84, y: 8 + folded.y * 84 };
  };
  return { ...segment, d: segmentToPath([transformSvgPoint(first), transformSvgPoint(second)].map(point => ({ x: (point.x - 8) / 84, y: (point.y - 8) / 84 }))) };
}
function symmetryScore(segments) {
  const original = new Set(segments.map(segment => normalizedSegmentPath(segment.d)));
  return Math.max(...POINT_TRANSFORMS
    .filter(transform => transform.id !== "r0")
    .map(transform => {
      const transformed = segments.map(segment => normalizedSegmentPath(transformedChoiceSegment(segment, transform.point).d));
      return transformed.filter(key => original.has(key)).length / Math.max(segments.length, 1);
    }));
}
function majorFamilyIndices(segments, family) {
  const info = segments.map((segment, index) => {
    const [first, second] = segmentEndpoints(segment.d);
    return { index, dx: second.x - first.x, dy: second.y - first.y, x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  });
  const diagonal = item => Math.abs(item.dx) > 1 && Math.abs(item.dy) > 1;
  let selected;
  if (family === "rising") selected = info.filter(item => diagonal(item) && item.dx * item.dy > 0);
  else if (family === "falling") selected = info.filter(item => diagonal(item) && item.dx * item.dy < 0);
  else if (family === "upper") selected = info.filter(item => item.y < 50);
  else selected = info.filter(item => item.x < 50);
  const minimum = Math.max(2, Math.ceil(segments.length * .3));
  if (selected.length < minimum || selected.length === segments.length) {
    const ordered = [...info].sort((left, right) => family === "left" ? left.x - right.x : left.y - right.y);
    selected = ordered.slice(0, Math.min(Math.ceil(segments.length / 2), segments.length - 1));
  }
  return new Set(selected.map(item => item.index));
}

function transformRawCreases(creasesByStep, firstAffectedIndex, pointTransform) {
  return creasesByStep.flatMap((step, index) =>
    index < firstAffectedIndex ? step : step.map(segment => segment.map(pointTransform))
  );
}

function makeCandidates(operations, simulation, rng) {
  const correctRaw = simulation.creasesByStep.flat();
  const correct = choiceSegmentsFromCreases(correctRaw);
  // Demo-style items are interesting because the final choices are not cleanly
  // symmetric: users must trace layers, not simply recognise a mirrored icon.
  // Regenerate multi-step items whose answer survives too much D4 symmetry.
  if (operations.length >= 4 && symmetryScore(correct) > .74) throw new Error("Generator produced an overly symmetric answer pattern.");
  const transformOrder = [...POINT_TRANSFORMS.filter(transform => transform.id !== "r0")];
  const rotation = Math.floor(rng.next() * transformOrder.length);
  const orderedTransforms = [...transformOrder.slice(rotation), ...transformOrder.slice(0, rotation)];
  const last = operations.length - 1;
  const pool = [];
  const signatures = new Set([signature(correct)]);
  const addCandidate = (id, kind, segments) => {
    const candidateSignature = signature(segments);
    if (segments.length !== correct.length || signatures.has(candidateSignature) || !isVisiblyDistinct(correct, segments)) return;
    signatures.add(candidateSignature);
    pool.push({
      id,
      kind,
      segments,
      distance: creasePatternDistance(correct, segments),
      shared: sharedSegmentCount(correct, segments)
    });
  };

  // Alternative complete folding programs. These are the most rigorous errors:
  // a player has followed a coherent, but wrongly oriented, paper sequence.
  const errorPrograms = [
    ...orderedTransforms.map(transform => ({
      id: `wrong-sheet-orientation-${transform.id}`,
      kind: "wrong-sheet-orientation",
      create: () => operations.map(operation => transformOperation(operation, transform))
    })),
    ...[last, Math.max(1, last - 1)].flatMap(operationIndex => [.08, -.08, .14, -.14].map(delta => ({
      id: `wrong-fold-position-${operationIndex + 1}-${delta > 0 ? "plus" : "minus"}`,
      kind: "wrong-fold-position",
      create: () => shiftedFoldProgram(operations, operationIndex, delta)
    }))),
    ...(operations.length >= 4 ? [{
      id: "wrong-late-order",
      kind: "wrong-fold-order",
      create: () => swappedLateFoldProgram(operations)
    }] : [])
  ];
  errorPrograms.forEach(recipe => {
    try {
      const alternate = simulateFlatFolds(recipe.create());
      if (candidateSimulationIsValid(alternate)) addCandidate(recipe.id, recipe.kind, choiceSegmentsFromCreases(alternate.creasesByStep.flat()));
    } catch { /* Invalid alternate programs are intentionally discarded. */ }
  });

  // Some short beginner sequences have few valid alternative programs. Use
  // large, whole-pattern reflection errors as a rigorous fallback. Each is a
  // valid crease pattern under a differently oriented sheet—not a tiny line
  // nudge—and later-fold-only variants model a wrong inverse-reflection family.
  orderedTransforms.forEach(transform => {
    addCandidate(`wrong-final-orientation-${transform.id}`, "wrong-final-orientation", choiceSegmentsFromCreases(
      correctRaw.map(segment => segment.map(transform.point))
    ));
    [last, Math.max(1, last - 1)].forEach(firstAffectedIndex => {
      addCandidate(`wrong-late-family-${transform.id}-${firstAffectedIndex + 1}`, "wrong-late-family", choiceSegmentsFromCreases(
        transformRawCreases(simulation.creasesByStep, firstAffectedIndex, transform.point)
      ));
    });
  });

  // When a symmetric short sequence makes whole-sheet orientations overlap,
  // model the common error of reflecting one *major crease family* across the
  // wrong axis. This keeps line count unchanged while moving a conspicuous
  // diagonal/region—not an imperceptible one-cell nudge.
  ["rising", "falling", "upper", "left"].forEach(family => {
    const indices = majorFamilyIndices(correct, family);
    orderedTransforms.slice(0, 4).forEach(transform => {
      const segments = correct.map((segment, index) => indices.has(index) ? transformedChoiceSegment(segment, transform.point) : { ...segment });
      if (hasUniqueVisibleSegments(segments)) addCandidate(`wrong-major-${family}-${transform.id}`, "wrong-major-crease-family", segments);
    });
  });

  // Reference-style distractors retain a recognisable base pattern and move a
  // whole late motif. Prefer those shared-base alternatives over global sheet
  // rotations, which make an option obviously unrelated at first glance.
  const minimumShared = Math.max(1, Math.ceil(correct.length * .4));
  const sharedBasePool = pool.filter(candidate => candidate.shared >= minimumShared);
  // Do not fall back to whole-sheet rotations: if a program cannot supply four
  // distractors sharing its visible base structure, regenerate the program.
  // Keeping at least ~40% of the answer's lines makes choices hard to reject by
  // elimination, while the distance floor above keeps every option concrete.
  if (sharedBasePool.length < 4) throw new Error(`Generator could not create four shared-base candidates (got ${sharedBasePool.length}).`);
  const rankedPool = sharedBasePool;
  const selected = [];
  const targetDistance = 16;
  rankedPool.sort((left, right) =>
    right.shared - left.shared || Math.abs(left.distance - targetDistance) - Math.abs(right.distance - targetDistance)
  );
  for (const candidate of rankedPool) {
    if (selected.length === 4) break;
    const separation = selected.length ? Math.min(...selected.map(item => creasePatternDistance(candidate.segments, item.segments))) : candidate.distance;
    if (separation < 4.5) continue;
    selected.push(candidate);
  }
  if (selected.length !== 4) throw new Error(`Generator could not create four coherent, shared-base distractors (got ${selected.length}; correct segments ${correct.length}).`);
  return [{ id: "answer", kind: "correct", segments: correct }, ...selected];
}

function foldFractionLabel(fraction) {
  if (fraction === undefined) return "";
  if (Math.abs(fraction - .25) < .02) return "1/4";
  if (Math.abs(fraction - 1 / 3) < .03) return "1/3";
  if (Math.abs(fraction - .5) < .03) return "對半";
  return `${Math.round(fraction * 100)}%`;
}

function operationCopy(operation, index, creaseCount, profile) {
  const number = index + 1;
  const layerCount = 2 ** index;
  const titles = {
    corner: `第 ${number} 折：角落折向內部點`,
    axial: `第 ${number} 折：沿主軸折疊`,
    nested: `第 ${number} 折：在較小紙面上再偏心折`,
    diagonal: `第 ${number} 折：斜線跨過重疊紙層`,
    terminal: `第 ${number} 折：窄邊收合`
  };
  const descriptions = {
    corner: `這是局部角落折：只有一個三角形角片被帶到內部點，不是整張紙沿對角線對半。攤平後留下 ${creaseCount} 段摺痕。`,
    axial: `這一步發生在最多 ${layerCount} 層紙面上；模擬器將它回映為 ${creaseCount} 段摺線。`, 
    nested: `折軸不在中心，不能直接套用四向對稱。必須追蹤偏心軸兩側的距離；攤平後得到 ${creaseCount} 段。`,
    diagonal: `前面的折疊已把紙壓成最多 ${layerCount} 層。這條斜線會在每個有效鏡像位置出現，共 ${creaseCount} 段。`,
    terminal: `最後的窄邊折在多層三角形上產生短線；少漏掉任何一層，答案都會少一組對應的摺痕。`
  };
  const rules = {
    corner: "先追蹤被折的角與內部落點；摺線是它們的等距分界，只有該角片會被鏡射。",
    axial: "先標出折軸；展開時，折軸兩側的垂直距離必須完全相等。", 
    nested: "偏心折破壞了中心對稱捷徑。比起看圖形外觀，請追蹤每個端點相對折軸的距離。",
    diagonal: "先數此前有幾次會影響這條斜線的折疊；每一次都可能再產生一個鏡像副本。",
    terminal: "最後折的要最先倒著驗證；檢查短線有沒有在所有合理的鏡像位置出現。"
  };
  const motionTitle = operation.motion ? `第 ${number} 折：${operation.motion} ${foldFractionLabel(operation.fraction)}` : titles[operation.kind];
  return { title: motionTitle, description: descriptions[operation.kind], rule: rules[operation.kind], profile };
}

function longestFoldSegment(line, faces) {
  const segments = faces.map(face => lineSegmentInPolygon(line, face.polygon)).filter(Boolean);
  return segments.sort((left, right) => {
    const length = segment => Math.hypot(segment[0].x - segment[1].x, segment[0].y - segment[1].y);
    return length(right) - length(left);
  })[0] || null;
}

function validateGeneratedPuzzle(simulation, candidates, operations = []) {
  const outsidePaper = point => point.x < -1e-7 || point.x > 1 + 1e-7 || point.y < -1e-7 || point.y > 1 + 1e-7;
  if (!simulation.creases.length || simulation.creasesByStep.some(step => step.length === 0) || simulation.creases.some(segment => segment.some(outsidePaper))) {
    throw new Error("Generator produced an empty or out-of-bounds crease.");
  }
  if (simulation.silhouettes.some(silhouette => silhouette.some(outsidePaper)) || simulation.faces.some(face => face.polygon.some(outsidePaper))) {
    throw new Error("Generator produced a folded face outside the paper.");
  }
  operations.forEach((operation, index) => {
    if (operation.kind !== "corner") return;
    const before = simulation.foldLayersByStep[index].packetOutline;
    const after = simulation.foldLayersByStep[index + 1];
    const beforeArea = polygonArea(before);
    const flapRatio = beforeArea ? polygonArea(after.topOutline) / beforeArea : Infinity;
    if (flapRatio > .30) throw new Error("Generator produced a non-local corner fold that would be unclear in the sequence diagram.");
  });
  const signatures = new Set(candidates.map(candidate => signature(candidate.segments)));
  if (signatures.size !== candidates.length) throw new Error("Generator produced duplicate answer options.");
}

/** Create one deterministic puzzle from a difficulty + seed pair. */
export function generateFoldPuzzle({ difficulty = "standard", seed = String(Date.now()), template = "auto" } = {}) {
  const profile = DIFFICULTY_PROFILES[difficulty] || DIFFICULTY_PROFILES.standard;
  // A seed selects a reproducible stream of candidate programs. If one program
  // cannot support four equally complex, physically coherent distractors, the
  // generator advances within that same seeded stream instead of shipping a
  // weak item or relying on an unseeded retry.
  let rng;
  let program;
  let transform;
  let operations;
  let simulation;
  let answerSegments;
  let candidates;
  let generationAttempt = 0;
  let lastError;
  // Weight the mixed-direction grammar so users regularly encounter the
  // top→down / bottom→up / left→right / right→left and local-corner variety,
  // rather than seeing the familiar diagonal cascade on most refreshes.
  const publicTemplates = profile.id === "standard"
    ? ["asymmetric-roof", "mixed-direction", "asymmetric-roof", "corner-roof", "kite-cascade", "mixed-direction", "diagonal-first"]
    : ["asymmetric-roof", "mixed-direction", "asymmetric-roof", "corner-roof", "kite-cascade", "mixed-direction", "gate-roof", "diagonal-first"];
  const templateStart = hashSeed(`${profile.id}:${seed}:grammar`) % publicTemplates.length;
  for (; generationAttempt < 32; generationAttempt += 1) {
    try {
      rng = seededRandom(`${profile.id}:${seed}:candidate-${generationAttempt}`);
      const selectedTemplate = template === "auto"
        ? publicTemplates[(templateStart + generationAttempt) % publicTemplates.length]
        : template;
      program = canonicalProgram(profile, rng, selectedTemplate);
      transform = rng.pick(POINT_TRANSFORMS);
      operations = program.operations.map(operation => transformOperation(operation, transform));
      simulation = simulateFlatFolds(operations);
      answerSegments = allSegmentObjects(simulation.creasesByStep);
      candidates = makeCandidates(operations, simulation, rng);
      validateGeneratedPuzzle(simulation, candidates, operations);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!candidates) throw lastError || new Error("Unable to generate a verified puzzle.");

  const solution = operations.map((operation, index) => {
    const axisSegment = longestFoldSegment(operation.line, simulation.facesByStep[index]);
    // A valid operation always has a crease; this defensive fallback protects
    // presentation if a future template creates a fully coincident layer.
    const safeAxis = axisSegment || simulation.creasesByStep[index][0];
    return {
      ...operationCopy(operation, index, simulation.creasesByStep[index].length, profile),
      axis: segmentToPath(safeAxis),
      revealGroups: Array.from({ length: index + 1 }, (_, group) => group + 1)
    };
  });

  const stageLabels = ["原始方紙", ...operations.map((operation, index) => {
    if (operation.motion) return `第 ${index + 1} 折：${operation.motion} ${foldFractionLabel(operation.fraction)}`;
    if (operation.kind === "corner") return `第 ${index + 1} 折：角落向內折`;
    if (operation.kind === "diagonal") return `第 ${index + 1} 折：斜向收合`;
    if (operation.kind === "terminal") return `第 ${index + 1} 折：窄邊收合`;
    if (operation.kind === "nested") return `第 ${index + 1} 折：偏心再折`;
    return `第 ${index + 1} 折：對半折`;
  })];
  const stageNotes = ["觀察第一條折軸", ...operations.map((operation, index) => {
    const layers = 2 ** (index + 1);
    if (operation.motion === "角落→內部點") return "角片只折向約 1/4–1/2 的內部區域";
    if (operation.kind === "corner") return "只折一個角片到內部點";
    if (operation.kind === "diagonal") return `斜線壓在最多 ${2 ** index} 層上`;
    if (operation.kind === "terminal") return `窄邊覆到多層紙上`;
    return `折後最多 ${layers} 層`;
  })];

  return {
    id: `generated-${profile.id}-${program.template}-${transform.id}-${seed}`,
    seed,
    profile,
    label: `${profile.label} · ${operations[0].kind === "corner" ? "首折角落" : "首折斜向"}`,
    hint: profile.id === "starter"
      ? "先找兩條中央折軸；斜線攤開時，會分別以它們為鏡軸複製。"
      : profile.id === "standard"
        ? "偏心折時，不要把圖案硬湊成中心對稱。比較每個端點到折軸的距離。"
        : "菁英題先倒著處理最後的斜線：它前面經過幾次偏心折，就要逐次找回那些不等距的鏡像副本。",
    operations,
    simulation,
    answerSegments,
    candidates,
    folds: stageLabels,
    stageNotes,
    solution,
    metrics: {
      folds: operations.length,
      offCentreAxes: operations.filter(operation => operation.isOffCentre).length,
      maxLayers: 2 ** operations.length,
      creaseSegments: simulation.creases.length,
      template: program.template,
      transform: transform.id
    }
  };
}
