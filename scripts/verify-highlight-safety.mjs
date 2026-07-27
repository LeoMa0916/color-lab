import assert from "node:assert/strict";
import { analyzePixels, createToneLutV3 } from "../src/colorEngine.js";
import {
  applySceneLighting,
  normalizeRgbForLighting,
} from "../src/lightingEngine.js";
import {
  applyStyleLuts,
  createIdentityLut,
} from "../src/lut3d.js";
import { createHeuristicSemanticMasks } from "../src/semanticEngine.js";
import { buildStyleLuts } from "../src/styleLutEngine.js";

const darkCaptureLighting = {
  exposureEV: -1.15,
  whitePoint: [1.04, 1, 0.94],
  confidence: 0.85,
};
const capturedHighlight = [232, 205, 184];
const normalizedHighlight = normalizeRgbForLighting(
  capturedHighlight,
  darkCaptureLighting,
  0.5,
  0.5,
);
const restoredHighlight = applySceneLighting(
  normalizedHighlight,
  darkCaptureLighting,
  0.5,
  0.5,
);
assert.ok(
  restoredHighlight.every((value, channel) =>
    Math.abs(value - capturedHighlight[channel]) < 0.75),
  "lighting normalization must be reversible without clipping bright channels",
);

const semanticPixels = new Uint8ClampedArray([
  194, 154, 126, 255,
  194, 154, 126, 255,
  194, 154, 126, 255,
  214, 160, 132, 255,
  214, 160, 132, 255,
]);
const categoryMask = new Uint8Array([0, 0, 0, 3, 3]);
const semanticMasks = createHeuristicSemanticMasks(
  semanticPixels,
  5,
  1,
  categoryMask,
);
assert.ok(
  semanticMasks.skin[0] < 0.05,
  "beige background must not become skin when the portrait model marks it as background",
);
assert.ok(
  semanticMasks.skin[4] > 0.9,
  "model-confirmed face skin must remain available for regional matching",
);

const collapsed = createIdentityLut(17);
for (let index = 0; index < collapsed.data.length; index += 3) {
  collapsed.data[index] = 0.62;
  collapsed.data[index + 1] = 0.62;
  collapsed.data[index + 2] = 0.62;
}
const protectedHighlight = new Uint8ClampedArray([232, 205, 184, 255]);
applyStyleLuts(
  protectedHighlight,
  1,
  1,
  { global: collapsed, residuals: {} },
);
const inputChroma = (232 - 184) / 255;
const outputChroma = (
  Math.max(...protectedHighlight.slice(0, 3))
  - Math.min(...protectedHighlight.slice(0, 3))
) / 255;
const inputLight = (232 * 0.2126 + 205 * 0.7152 + 184 * 0.0722) / 255;
const outputLight = (
  protectedHighlight[0] * 0.2126
  + protectedHighlight[1] * 0.7152
  + protectedHighlight[2] * 0.0722
) / 255;
assert.ok(
  outputLight >= inputLight - 0.035,
  "the final LUT guard must preserve highlight headroom",
);
assert.ok(
  outputChroma >= inputChroma * 0.24,
  "the final LUT guard must not turn colored highlights into gray plateaus",
);

const aggressiveSource = {
  tone: { quantiles: [0, 8, 16, 28, 52, 88, 132, 186, 214, 242, 255] },
};
const aggressiveReference = {
  tone: { quantiles: [0, 18, 30, 48, 88, 158, 206, 226, 238, 248, 255] },
};
const guardedTone = createToneLutV3(aggressiveSource, aggressiveReference, 1);
assert.ok(
  guardedTone[Math.round(0.5 * 1023)] <= 0.59,
  "global composition differences must not cause an excessive midtone lift",
);
assert.ok(
  guardedTone[Math.round(0.82 * 1023)] >= 0.79,
  "the global tone curve must retain a continuous highlight shoulder",
);

function makeGradient(exposure, warm) {
  const width = 96;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.min(1, (0.035 + x / (width - 1) * 0.93) * exposure);
      const index = (y * width + x) * 4;
      data[index] = Math.round(Math.min(1, value * (warm ? 1.06 : 0.98)) * 255);
      data[index + 1] = Math.round(value * 255);
      data[index + 2] = Math.round(Math.min(1, value * (warm ? 0.91 : 1.04)) * 255);
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

const target = makeGradient(0.78, true);
const reference = makeGradient(1, false);
const targetProfile = analyzePixels(target.data, {
  width: target.width,
  height: target.height,
});
const referenceProfile = analyzePixels(reference.data, {
  width: reference.width,
  height: reference.height,
});
const settings = {
  strength: 68,
  referenceLighting: 35,
  temperature: 0,
  contrast: 0,
  saturation: 0,
  grain: 0,
};
const luts = buildStyleLuts(targetProfile, referenceProfile, settings);
const rendered = new Uint8ClampedArray(target.data);
applyStyleLuts(rendered, target.width, target.height, luts);
const highlightCodes = new Set();
for (let x = 72; x < target.width; x += 1) {
  const index = x * 4;
  highlightCodes.add(Math.round(
    rendered[index] * 0.2126
    + rendered[index + 1] * 0.7152
    + rendered[index + 2] * 0.0722,
  ));
}
assert.ok(
  highlightCodes.size >= 14,
  "V4 must preserve highlight gradation instead of producing a flat gray shelf",
);

console.log("Highlight and semantic safety verification passed", {
  roundTripError: Math.max(
    ...restoredHighlight.map((value, channel) =>
      Math.abs(value - capturedHighlight[channel])),
  ),
  protectedHighlight: Array.from(protectedHighlight.slice(0, 3)),
  highlightCodes: highlightCodes.size,
});
