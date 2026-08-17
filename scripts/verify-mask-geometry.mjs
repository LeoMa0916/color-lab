import assert from "node:assert/strict";
import {
  applyLocalMasks,
  createMaskLayer,
  rasterizeMaskLayer,
  transferableMaskSettings,
} from "../src/maskEngine.js";
import {
  applyGeometryTransform,
  cropForAspect,
  defaultGeometrySettings,
  estimateUprightTransform,
  mapGeometryOutputPointToSource,
  sourceLongEdgeForCroppedOutput,
} from "../src/geometryEngine.js";

const width = 48;
const height = 32;
const pixels = new Uint8ClampedArray(width * height * 4);
for (let index = 0; index < pixels.length; index += 4) {
  pixels[index] = 92;
  pixels[index + 1] = 96;
  pixels[index + 2] = 104;
  pixels[index + 3] = 255;
}

const brush = createMaskLayer("brush", {
  sources: [{
    id: "stroke",
    type: "brush",
    mode: "add",
    size: 22,
    feather: 70,
    flow: 100,
    points: [{ x: 0.45, y: 0.5 }, { x: 0.55, y: 0.5 }],
  }],
  adjustments: { exposure: 1.2, saturation: 18 },
});
const alpha = rasterizeMaskLayer(brush, width, height, null);
assert.ok(alpha[Math.floor(height / 2) * width + Math.floor(width / 2)] > 0.8, "brush center should be selected");
assert.equal(alpha[0], 0, "brush should not affect a distant corner");

const masked = new Uint8ClampedArray(pixels);
applyLocalMasks(masked, width, height, { layers: [brush] }, null);
const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
assert.ok(masked[center] > pixels[center] + 20, "local exposure should brighten selected pixels");
assert.equal(masked[0], pixels[0], "local adjustment should preserve unselected pixels");

const semantic = createMaskLayer("sky");
const semanticMasks = {
  width: 2,
  height: 2,
  masks: { sky: new Float32Array([1, 1, 0, 0]) },
};
const semanticAlpha = rasterizeMaskLayer(semantic, width, height, semanticMasks);
assert.ok(semanticAlpha[2] > 0.9, "semantic sky should resample into the output frame");
assert.ok(semanticAlpha[(height - 1) * width + 2] < 0.1, "semantic sky should preserve non-sky pixels");

const squareCrop = cropForAspect("1:1", width, height, null);
const cropped = applyGeometryTransform(pixels, width, height, {
  ...defaultGeometrySettings(),
  aspect: "1:1",
  crop: squareCrop,
});
assert.equal(cropped.width, cropped.height, "1:1 crop should produce a square frame");

const transformed = applyGeometryTransform(pixels, width, height, {
  ...defaultGeometrySettings(),
  rotation: 7.5,
  vertical: 22,
  horizontal: -14,
  scale: 112,
});
assert.equal(transformed.data.length, transformed.width * transformed.height * 4);
assert.ok(transformed.data.every(Number.isFinite), "geometry output must contain finite channel values");

const transformedPoint = mapGeometryOutputPointToSource({ x: 0.25, y: 0.75 }, {
  ...defaultGeometrySettings(),
  rotation: 12,
  horizontal: 20,
  crop: { x: 0.1, y: 0.15, width: 0.7, height: 0.65 },
});
assert.ok(
  Math.abs(transformedPoint.x - 0.25) > 0.01 || Math.abs(transformedPoint.y - 0.75) > 0.01,
  "geometry-aware pointer mapping should account for crop and perspective",
);

const cinematicCrop = cropForAspect("2.39:1", 6000, 4000, null);
assert.ok(
  Math.abs((6000 * cinematicCrop.width) / (4000 * cinematicCrop.height) - 2.39) < 0.002,
  "custom decimal crop ratios should retain the requested output aspect",
);

const projectiveGeometry = {
  ...defaultGeometrySettings(),
  rotation: 6,
  horizontal: 28,
  vertical: -19,
  transformAspect: 24,
  scale: 112,
};
const projectiveLine = [0.2, 0.5, 0.8].map((x) =>
  mapGeometryOutputPointToSource({ x, y: 0.42 }, projectiveGeometry));
const cross = (projectiveLine[1].x - projectiveLine[0].x)
  * (projectiveLine[2].y - projectiveLine[0].y)
  - (projectiveLine[1].y - projectiveLine[0].y)
  * (projectiveLine[2].x - projectiveLine[0].x);
assert.ok(Math.abs(cross) < 1e-6, "projective transform should preserve straight lines");

const aspectPoint = mapGeometryOutputPointToSource(
  { x: 0.25, y: 0.5 },
  { ...defaultGeometrySettings(), transformAspect: 55 },
);
assert.ok(Math.abs(aspectPoint.x - 0.25) > 0.02, "transform aspect must visibly change the mapped image");

const constrainedGeometry = {
  ...defaultGeometrySettings(),
  rotation: 17,
  horizontal: 24,
  vertical: -18,
  constrainCrop: true,
};
for (const point of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]) {
  const mapped = mapGeometryOutputPointToSource(point, constrainedGeometry);
  assert.ok(mapped.x >= -1e-4 && mapped.x <= 1.0001 && mapped.y >= -1e-4 && mapped.y <= 1.0001,
    "constrain crop should keep transformed corners inside the source frame");
}

const upright = estimateUprightTransform(pixels, width, height, "full");
assert.equal(upright.upright, "full");
assert.ok([upright.rotation, upright.horizontal, upright.vertical].every(Number.isFinite),
  "Upright analysis should always return finite manual controls");

const fourKSourceEdge = sourceLongEdgeForCroppedOutput(
  3840,
  6000,
  4000,
  { crop: cropForAspect("1:1", 6000, 4000, null) },
);
assert.equal(Math.round(fourKSourceEdge), 5760, "4K square crop should decode enough source pixels");
assert.equal(Math.round(fourKSourceEdge * (4000 / 6000)), 3840, "cropped output should retain requested long edge");

const white = new Uint8ClampedArray(width * height * 4);
for (let index = 0; index < white.length; index += 4) {
  white[index] = 255;
  white[index + 1] = 255;
  white[index + 2] = 255;
  white[index + 3] = 255;
}
const edgeSafe = applyGeometryTransform(white, width, height, {
  ...defaultGeometrySettings(),
  rotation: 35,
  horizontal: 70,
  vertical: -60,
  offsetX: 55,
});
assert.ok(edgeSafe.data.every((value) => value === 255), "geometry should not introduce opaque black borders");

const transferable = transferableMaskSettings({
  layers: [brush, createMaskLayer("subject"), createMaskLayer("sky")],
});
assert.equal(transferable.layers.length, 2, "saved styles should exclude photo-specific brush masks");
assert.deepEqual(transferable.layers.map((layer) => layer.type), ["subject", "sky"]);

console.log("Mask and geometry verification passed", {
  brushCoverage: Number((alpha.reduce((sum, value) => sum + value, 0) / alpha.length).toFixed(4)),
  crop: `${cropped.width}x${cropped.height}`,
  transformed: `${transformed.width}x${transformed.height}`,
  fourKSourceEdge: Math.round(fourKSourceEdge),
});
