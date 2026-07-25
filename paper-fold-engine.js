/**
 * A small exact (flat-fold) paper simulator for the practice generator.
 *
 * A face stores a polygon in the current folded plane plus an affine map from
 * that plane back to the original square. At each fold we split every face at
 * the fold line, reflect the moving side, and retain the mapping. A crease is
 * recorded on every layer before folding, then mapped back to original paper.
 * This makes the final answer a consequence of the fold sequence—not artwork
 * chosen to resemble an answer.
 */

const EPSILON = 1e-8;
const unitSquare = Object.freeze([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);

export const identity = () => [1, 0, 0, 0, 1, 0];
export const applyMatrix = (matrix, point) => ({
  x: matrix[0] * point.x + matrix[1] * point.y + matrix[2],
  y: matrix[3] * point.x + matrix[4] * point.y + matrix[5]
});

// matrix A after B: A(B(point))
export function composeMatrices(a, b) {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5]
  ];
}

export const lineValue = (line, point) => line.a * point.x + line.b * point.y + line.c;

export function reflectionMatrix(line) {
  const normSquared = line.a * line.a + line.b * line.b;
  if (normSquared < EPSILON) throw new Error("A fold line needs a non-zero normal.");
  const { a, b, c } = line;
  return [
    1 - (2 * a * a) / normSquared, (-2 * a * b) / normSquared, (-2 * a * c) / normSquared,
    (-2 * a * b) / normSquared, 1 - (2 * b * b) / normSquared, (-2 * b * c) / normSquared
  ];
}

function samePoint(a, b) { return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON; }
function uniquePoints(points) {
  return points.reduce((result, point) => (result.some(existing => samePoint(existing, point)) ? result : [...result, point]), []);
}
function edgeLineIntersection(start, end, line) {
  const startValue = lineValue(line, start);
  const endValue = lineValue(line, end);
  const ratio = startValue / (startValue - endValue);
  return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
}

/** Clip a convex polygon to the positive (side=1) or negative (side=-1) line half-plane. */
export function clipPolygon(polygon, line, side) {
  const output = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const startInside = side * lineValue(line, start) >= -EPSILON;
    const endInside = side * lineValue(line, end) >= -EPSILON;
    if (startInside) output.push(start);
    if (startInside !== endInside) output.push(edgeLineIntersection(start, end, line));
  }
  return uniquePoints(output);
}

/** Return the part of a line that lies within a convex polygon. */
export function lineSegmentInPolygon(line, polygon) {
  const intersections = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const startValue = lineValue(line, start);
    const endValue = lineValue(line, end);
    if (Math.abs(startValue) < EPSILON) intersections.push(start);
    if (startValue * endValue < -EPSILON) intersections.push(edgeLineIntersection(start, end, line));
  }
  const unique = uniquePoints(intersections);
  if (unique.length < 2) return null;
  let furthest = [unique[0], unique[1]];
  let maxDistance = -1;
  for (let left = 0; left < unique.length; left += 1) {
    for (let right = left + 1; right < unique.length; right += 1) {
      const dx = unique[left].x - unique[right].x;
      const dy = unique[left].y - unique[right].y;
      const distance = dx * dx + dy * dy;
      if (distance > maxDistance) { maxDistance = distance; furthest = [unique[left], unique[right]]; }
    }
  }
  return maxDistance > EPSILON ? furthest : null;
}

function reflectPolygon(polygon, reflection) { return polygon.map(point => applyMatrix(reflection, point)); }
function rounded(point) { return { x: Number(point.x.toFixed(8)), y: Number(point.y.toFixed(8)) }; }

// Every sequence used by the app stays convex after folding. The hull gives a
// clean top-view silhouette for the instruction cards without pretending that
// the hidden paper layers are a single face.
export function convexHull(points) {
  const sorted = uniquePoints(points.map(rounded)).sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (sorted.length <= 2) return sorted;
  const cross = (origin, a, b) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower = [];
  sorted.forEach(point => {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= EPSILON) lower.pop();
    lower.push(point);
  });
  const upper = [];
  [...sorted].reverse().forEach(point => {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= EPSILON) upper.pop();
    upper.push(point);
  });
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function silhouette(faces) { return convexHull(faces.flatMap(face => face.polygon)); }
function segmentKey(segment) {
  const points = [rounded(segment[0]), rounded(segment[1])].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  return `${points[0].x},${points[0].y}:${points[1].x},${points[1].y}`;
}
function dedupeSegments(segments) {
  const seen = new Set();
  return segments.filter(segment => {
    const key = segmentKey(segment);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/**
 * A physical crease can be split into adjacent fragments as layers are mapped
 * back to the original sheet. For a final crease-pattern diagram those
 * fragments should read as one continuous line, not a sequence of unrelated
 * dashes. Merge only fragments that are collinear *and connected*; never bridge
 * a genuine gap.
 */
export function mergeCollinearSegments(segments, epsilon = 1e-6) {
  const groups = new Map();
  segments.forEach(([start, end]) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= epsilon) return;
    let ux = dx / length;
    let uy = dy / length;
    if (ux < -epsilon || (Math.abs(ux) <= epsilon && uy < 0)) { ux = -ux; uy = -uy; }
    const nx = -uy;
    const ny = ux;
    const offset = nx * start.x + ny * start.y;
    const first = ux * start.x + uy * start.y;
    const second = ux * end.x + uy * end.y;
    const key = `${ux.toFixed(6)},${uy.toFixed(6)}|${offset.toFixed(6)}`;
    const entry = groups.get(key) || { ux, uy, nx, ny, offset, intervals: [] };
    entry.intervals.push({ start: Math.min(first, second), end: Math.max(first, second) });
    groups.set(key, entry);
  });

  const merged = [];
  groups.forEach(({ ux, uy, nx, ny, offset, intervals }) => {
    intervals.sort((left, right) => left.start - right.start || left.end - right.end);
    let current = intervals[0];
    intervals.slice(1).forEach(interval => {
      if (interval.start <= current.end + epsilon) current.end = Math.max(current.end, interval.end);
      else {
        merged.push([
          rounded({ x: ux * current.start + nx * offset, y: uy * current.start + ny * offset }),
          rounded({ x: ux * current.end + nx * offset, y: uy * current.end + ny * offset })
        ]);
        current = interval;
      }
    });
    if (current) merged.push([
      rounded({ x: ux * current.start + nx * offset, y: uy * current.start + ny * offset }),
      rounded({ x: ux * current.end + nx * offset, y: uy * current.end + ny * offset })
    ]);
  });
  return dedupeSegments(merged);
}

/**
 * @param {Array<{id: string, line: {a:number,b:number,c:number}, keepSide: 1|-1}>} operations
 * @returns {{creases: Array<[Point,Point]>, creasesByStep: Array<Array<[Point,Point]>>, faces: Array}}
 */
export function simulateFlatFolds(operations) {
  let faces = [{ polygon: unitSquare.map(point => ({ ...point })), toOriginal: identity() }];
  const creasesByStep = [];
  const silhouettes = [silhouette(faces)];
  const facesByStep = [faces.map(face => ({ polygon: face.polygon.map(point => ({ ...point })), toOriginal: [...face.toOriginal] }))];
  const foldLayersByStep = [{
    packetOutline: unitSquare.map(point => ({ ...point })),
    baseOutline: unitSquare.map(point => ({ ...point })),
    topOutline: []
  }];

  operations.forEach(operation => {
    if (![1, -1].includes(operation.keepSide)) throw new Error(`${operation.id} must define keepSide as 1 or -1.`);
    // Each folded layer contributes a crease; map its local segment back to
    // the original sheet before the next fold changes the layer arrangement.
    const mappedStepCreases = [];
    faces.forEach(face => {
      const segment = lineSegmentInPolygon(operation.line, face.polygon);
      if (segment) mappedStepCreases.push(segment.map(point => rounded(applyMatrix(face.toOriginal, point))));
    });
    creasesByStep.push(dedupeSegments(mappedStepCreases));

    const reflection = reflectionMatrix(operation.line);
    const nextFaces = [];
    const stationaryFaces = [];
    const movedFaces = [];
    faces.forEach(face => {
      const stationary = clipPolygon(face.polygon, operation.line, operation.keepSide);
      const moving = clipPolygon(face.polygon, operation.line, -operation.keepSide);
      if (stationary.length >= 3) {
        const stationaryFace = { polygon: stationary, toOriginal: face.toOriginal };
        nextFaces.push(stationaryFace);
        stationaryFaces.push(stationaryFace);
      }
      if (moving.length >= 3) {
        const movedFace = {
          polygon: reflectPolygon(moving, reflection),
          toOriginal: composeMatrices(face.toOriginal, reflection)
        };
        nextFaces.push(movedFace);
        movedFaces.push(movedFace);
      }
    });
    faces = nextFaces;
    const packetOutline = silhouette(faces);
    silhouettes.push(packetOutline);
    // This layer record is specifically for diagrams: it preserves which area
    // stayed as B and which area A moved on top of, without rendering every
    // individual hidden layer boundary as a misleading black line.
    foldLayersByStep.push({
      packetOutline,
      baseOutline: stationaryFaces.length ? silhouette(stationaryFaces) : packetOutline,
      topOutline: movedFaces.length ? silhouette(movedFaces) : []
    });
    facesByStep.push(faces.map(face => ({ polygon: face.polygon.map(point => ({ ...point })), toOriginal: [...face.toOriginal] })));
  });

  return { creasesByStep, creases: dedupeSegments(creasesByStep.flat()), faces, silhouettes, facesByStep, foldLayersByStep };
}

export function segmentToPath(segment, { min = 8, size = 84 } = {}) {
  const point = value => Number((min + value * size).toFixed(3));
  return `M ${point(segment[0].x)} ${point(segment[0].y)} L ${point(segment[1].x)} ${point(segment[1].y)}`;
}
