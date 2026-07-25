/**
 * Small, dependency-free SVG path checks used by the puzzle data tests.
 * Puzzle paths use straight M/L/H/V commands, so every numeric token is an
 * x or y coordinate. The helper intentionally rejects invalid inputs instead
 * of silently passing a malformed path to the renderer.
 */
export const PATH_NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

export function numbersInPath(path) {
  if (typeof path !== "string" || !path.trim()) throw new TypeError("A non-empty SVG path is required.");
  const numbers = path.match(PATH_NUMBER)?.map(Number) ?? [];
  if (!numbers.length || numbers.some(number => !Number.isFinite(number))) {
    throw new TypeError(`Invalid SVG path: ${path}`);
  }
  return numbers;
}

export function pathIsWithinBounds(path, bounds) {
  if (!bounds || !Number.isFinite(bounds.min) || !Number.isFinite(bounds.max) || bounds.min > bounds.max) {
    throw new TypeError("Bounds must contain a finite min and max.");
  }
  return numbersInPath(path).every(number => number >= bounds.min && number <= bounds.max);
}

export function outsideCoordinates(path, bounds) {
  return numbersInPath(path).filter(number => number < bounds.min || number > bounds.max);
}
