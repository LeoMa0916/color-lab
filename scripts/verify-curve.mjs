import assert from "node:assert/strict";
import { applyCurveLuts, smoothCurveLut } from "../src/curveMath.js";

const identityPoints = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
const identity = smoothCurveLut(identityPoints);
for (let value = 0; value < 256; value += 1) {
  assert.equal(identity[value], value, `Identity curve changed input ${value}`);
}

const points = [
  { x: 0, y: 0 },
  { x: 64, y: 42 },
  { x: 128, y: 176 },
  { x: 255, y: 255 },
];
const smooth = smoothCurveLut(points);
for (const point of points) {
  assert.equal(smooth[point.x], point.y, `Curve missed control point ${point.x}`);
}

for (let index = 0; index < points.length - 1; index += 1) {
  const start = points[index];
  const end = points[index + 1];
  const lower = Math.min(start.y, end.y);
  const upper = Math.max(start.y, end.y);
  for (let input = start.x; input <= end.x; input += 1) {
    assert.ok(
      smooth[input] >= lower && smooth[input] <= upper,
      `Curve overshot segment ${index} at input ${input}`,
    );
  }
}

const midpoint = 80;
const linearMidpoint = Math.round(
  points[1].y
    + ((midpoint - points[1].x) / (points[2].x - points[1].x))
      * (points[2].y - points[1].y),
);
assert.notEqual(
  smooth[midpoint],
  linearMidpoint,
  "Curve fell back to straight point-to-point interpolation",
);

const curves = {
  master: points,
  red: [{ x: 0, y: 8 }, { x: 255, y: 245 }],
  green: identityPoints,
  blue: [{ x: 0, y: 0 }, { x: 128, y: 150 }, { x: 255, y: 255 }],
};
const pixels = new Uint8ClampedArray([32, 96, 180, 255, 48, 64, 80, 0]);
const expectedMaster = smoothCurveLut(curves.master);
const expectedRed = smoothCurveLut(curves.red);
const expectedBlue = smoothCurveLut(curves.blue);
applyCurveLuts(pixels, curves);
assert.deepEqual(
  [...pixels],
  [
    expectedRed[expectedMaster[32]],
    expectedMaster[96],
    expectedBlue[expectedMaster[180]],
    255,
    48,
    64,
    80,
    0,
  ],
  "Curve LUT composition did not match master-then-channel behavior",
);

console.log("Curve verification passed: smooth interpolation, control points, no overshoot, LUT composition.");
