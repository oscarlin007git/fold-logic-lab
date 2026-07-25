import test from "node:test";
import assert from "node:assert/strict";
import { choiceSegmentsFromCreases, creasePatternDistance, DIFFICULTY_PROFILES, generateFoldPuzzle, PAPER_BOUNDS, shuffleWithSeed } from "../../puzzle-data.js";
import { numbersInPath, outsideCoordinates, pathIsWithinBounds } from "../../svg-geometry.js";
import { lineSegmentInPolygon, mergeCollinearSegments, reflectionMatrix, applyMatrix, segmentToPath, simulateFlatFolds } from "../../paper-fold-engine.js";

const allDifficulties = Object.keys(DIFFICULTY_PROFILES);
const seeds = Array.from({ length: 50 }, (_, index) => `quality-seed-${index}`);
const signature = puzzle => puzzle.answerSegments.map(({ d }) => d).sort().join("|");
const visualSegmentKey = ({ d }) => {
  const values = d.match(/[-+]?\d*\.?\d+/g).map(Number);
  const first = `${values[0].toFixed(5)},${values[1].toFixed(5)}`;
  const second = `${values[2].toFixed(5)},${values[3].toFixed(5)}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
};

test("SVG coordinate parser handles straight path commands and decimal values", () => {
  assert.deepEqual(numbersInPath("M 8 51 L 47.5 8 H 92 V 75"), [8, 51, 47.5, 8, 92, 75]);
  assert.throws(() => numbersInPath(""), /non-empty SVG path/);
});

test("boundary guard accepts paper edges and catches the former overflow coordinate", () => {
  assert.equal(pathIsWithinBounds("M 8 51 L 47 8 L 92 51", PAPER_BOUNDS), true);
  assert.equal(pathIsWithinBounds("M 8 51 L 47 8 L 97 51", PAPER_BOUNDS), false);
  assert.deepEqual(outsideCoordinates("M 8 51 L 47 8 L 97 51", PAPER_BOUNDS), [97]);
});

test("flat-fold engine reflects a moving face and maps its crease back to original paper", () => {
  const verticalHalf = { id: "vertical", line: { a: 1, b: 0, c: -0.5 }, keepSide: 1 };
  const result = simulateFlatFolds([verticalHalf]);
  assert.deepEqual(result.creasesByStep[0], [[{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }]]);
  assert.equal(result.faces.length, 2);
  assert.equal(result.facesByStep.length, 2);
  assert.equal(result.facesByStep[1].length, 2);
  assert.deepEqual(result.silhouettes[1], [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }]);
  assert.deepEqual(applyMatrix(reflectionMatrix(verticalHalf.line), { x: 0.25, y: 0.3 }), { x: 0.75, y: 0.3 });
  assert.deepEqual(lineSegmentInPolygon(verticalHalf.line, result.silhouettes[0]), [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }]);
});

test("contiguous collinear crease fragments merge without bridging genuine gaps", () => {
  const merged = mergeCollinearSegments([
    [{ x: 0, y: .5 }, { x: .25, y: .5 }],
    [{ x: .25, y: .5 }, { x: .75, y: .5 }],
    [{ x: .9, y: .5 }, { x: 1, y: .5 }]
  ]);
  assert.deepEqual(merged, [
    [{ x: 0, y: .5 }, { x: .75, y: .5 }],
    [{ x: .9, y: .5 }, { x: 1, y: .5 }]
  ]);
});

test("generator is seed-deterministic but produces varied fold programs", () => {
  for (const difficulty of allDifficulties) {
    const first = generateFoldPuzzle({ difficulty, seed: "replayable-seed" });
    const second = generateFoldPuzzle({ difficulty, seed: "replayable-seed" });
    assert.deepEqual(second, first, `${difficulty} must replay exactly from its seed`);

    const variants = new Set(seeds.map(seed => signature(generateFoldPuzzle({ difficulty, seed }))));
    assert.ok(variants.size >= 44, `${difficulty} generator produced too few distinct crease patterns (${variants.size}/50)`);
  }
});

test("a seed also deterministically fixes option order", () => {
  const candidates = ["answer", "only-direct-layer", "partial-reflection", "wrong-axis", "wrong-offset"];
  const first = shuffleWithSeed(candidates, "standard:REPLAY1234:option-order");
  assert.deepEqual(first, shuffleWithSeed(candidates, "standard:REPLAY1234:option-order"));
  assert.deepEqual([...first].sort(), [...candidates].sort(), "deterministic shuffle must preserve every option");
});

test("public fold grammars use diagonal or local-corner openings and retain multiple structural families", () => {
  const motions = new Set();
  const fractions = new Set();
  for (const difficulty of allDifficulties) {
    const generated = seeds.map(seed => generateFoldPuzzle({ difficulty, seed }));
    generated.forEach(puzzle => puzzle.operations.forEach(operation => {
      if (operation.motion) motions.add(operation.motion);
      if (operation.fraction !== undefined) fractions.add(operation.fraction);
    }));
    generated.forEach(puzzle => {
      assert.ok(["diagonal", "corner"].includes(puzzle.operations[0].kind), `${puzzle.metrics.template} must open with a diagonal or corner crease`);
      const { a, b } = puzzle.operations[0].line;
      assert.ok(Math.abs(a) > 1e-7 && Math.abs(b) > 1e-7, `${puzzle.metrics.template} opening crease must be diagonal`);
    });
    const templates = new Set(generated.map(puzzle => puzzle.metrics.template));
    assert.ok(templates.size >= 2, `${difficulty} needs more than one usable fold grammar`);
    assert.ok(new Set(generated.map(signature)).size >= 44, `${difficulty} grammars must yield varied crease structures`);
  }
  ["上→下", "下→上", "左→右", "右→左", "角落→內部點"].forEach(motion => {
    assert.ok(motions.has(motion), `public generator never produced ${motion}`);
  });
  [.25, 1 / 3, .5].forEach(fraction => {
    assert.ok([...fractions].some(value => Math.abs(value - fraction) < .03), `public generator never produced a ${fraction} fold`);
  });
});

test("every generated canonical crease, distractor and explanation axis stays inside the paper", () => {
  const invalid = [];
  for (const difficulty of allDifficulties) {
    for (const seed of seeds) {
      const puzzle = generateFoldPuzzle({ difficulty, seed });
      const allPaths = [
        ...puzzle.answerSegments.map(({ d }) => ({ source: "answer", d })),
        ...puzzle.candidates.flatMap(candidate => candidate.segments.map(({ d }) => ({ source: `candidate ${candidate.id}`, d }))),
        ...puzzle.solution.map(({ axis }, stepIndex) => ({ source: `solution axis ${stepIndex + 1}`, d: axis }))
      ];
      for (const { source, d } of allPaths) {
        if (!pathIsWithinBounds(d, PAPER_BOUNDS)) invalid.push(`${difficulty}/${seed} / ${source}: ${d}`);
      }
    }
  }
  assert.deepEqual(invalid, []);
});

test("the answer option is calculated from each generated fold program, not separately illustrated", () => {
  for (const difficulty of allDifficulties) {
    for (const seed of seeds) {
      const puzzle = generateFoldPuzzle({ difficulty, seed });
      const simulationResult = simulateFlatFolds(puzzle.operations);
      puzzle.operations.forEach((operation, index) => {
        if (operation.kind !== "corner") return;
        const beforeArea = Math.abs(simulationResult.foldLayersByStep[index].packetOutline.reduce((sum, point, pointIndex, polygon) => {
          const next = polygon[(pointIndex + 1) % polygon.length];
          return sum + point.x * next.y - point.y * next.x;
        }, 0)) / 2;
        const top = simulationResult.foldLayersByStep[index + 1].topOutline;
        const topArea = Math.abs(top.reduce((sum, point, pointIndex, polygon) => {
          const next = polygon[(pointIndex + 1) % polygon.length];
          return sum + point.x * next.y - point.y * next.x;
        }, 0)) / 2;
        assert.ok(topArea / beforeArea <= .30, `${difficulty}/${seed} corner fold must remain a local flap, not turn a whole side diagonal`);
      });
      const generated = simulationResult.creasesByStep.flatMap((step, stepIndex) =>
        step.map(segment => ({ d: segmentToPath(segment), group: stepIndex + 1, role: stepIndex < 2 ? "base" : "crease" }))
      );
      assert.deepEqual(generated, puzzle.answerSegments, `${difficulty}/${seed} answer differs from the fold simulator`);
      assert.deepEqual(
        puzzle.candidates.find(candidate => candidate.kind === "correct").segments,
        choiceSegmentsFromCreases(simulationResult.creasesByStep.flat()),
        `${difficulty}/${seed} correct option differs from the canonical merged crease drawing`
      );
      assert.equal(new Set(puzzle.candidates.map(candidate => candidate.segments.map(({ d }) => d).sort().join(" | "))).size, 5, `${difficulty}/${seed} has duplicate choices`);
      const answer = puzzle.candidates.find(candidate => candidate.kind === "correct");
      const answerCount = answer.segments.length;
      puzzle.candidates.forEach(candidate => assert.equal(candidate.segments.length, answerCount, `${difficulty}/${seed}/${candidate.id} must match the answer's visual complexity`));
      const wrongCandidates = puzzle.candidates.filter(candidate => candidate.kind !== "correct");
      const answerKeys = new Set(answer.segments.map(visualSegmentKey));
      const minimumSharedBase = Math.max(1, Math.ceil(answer.segments.length * .25));
      wrongCandidates.forEach(candidate => {
        assert.match(candidate.kind, /^wrong-/, `${difficulty}/${seed}/${candidate.id} must encode a realistic incorrect unfolding transformation`);
        assert.ok(creasePatternDistance(answer.segments, candidate.segments) >= 7, `${difficulty}/${seed}/${candidate.id} is too visually similar to the correct pattern`);
        assert.ok(candidate.segments.filter(segment => answerKeys.has(visualSegmentKey(segment))).length >= minimumSharedBase, `${difficulty}/${seed}/${candidate.id} must retain a recognisable shared base pattern`);
      });
      wrongCandidates.forEach((candidate, index) => wrongCandidates.slice(index + 1).forEach(other => {
        assert.ok(creasePatternDistance(candidate.segments, other.segments) >= 4.5, `${difficulty}/${seed}/${candidate.id} and ${other.id} are near-twin distractors`);
      }));
    }
  }
});

test("difficulty tiers differ structurally, not merely cosmetically", () => {
  const starter = generateFoldPuzzle({ difficulty: "starter", seed: "tier-proof" });
  const standard = generateFoldPuzzle({ difficulty: "standard", seed: "tier-proof" });
  const challenge = generateFoldPuzzle({ difficulty: "challenge", seed: "tier-proof" });

  assert.deepEqual([starter.metrics.folds, standard.metrics.folds, challenge.metrics.folds], [3, 4, 5]);
  assert.deepEqual([starter.metrics.maxLayers, standard.metrics.maxLayers, challenge.metrics.maxLayers], [8, 16, 32]);
  assert.ok(starter.metrics.offCentreAxes <= 2, "起步題只容許近中央的輕微偏移");
  assert.ok(standard.metrics.offCentreAxes >= 2);
  assert.ok(challenge.metrics.offCentreAxes >= 4);
  assert.ok(challenge.metrics.creaseSegments > standard.metrics.creaseSegments);
  assert.equal(starter.solution.length, 3);
  assert.equal(standard.solution.length, 4);
  assert.equal(challenge.solution.length, 5);
});
