import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { applyBasicAdjustments } from "../src/basicAdjustments.js";
import { applyCurveLuts } from "../src/curveMath.js";
import { applyStyleLuts, createIdentityLut } from "../src/lut3d.js";
import { detectRenderBackend, recommendedPreviewSide } from "../src/renderBackend.js";

const identity = createIdentityLut(33);
const curves = {
  master: [{ x: 0, y: 0 }, { x: 128, y: 132 }, { x: 255, y: 255 }],
  red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
};
const settings = {
  temperature: -3,
  tint: 1,
  exposure: 0,
  contrast: -4,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: -2,
  grain: 6,
  grainSize: 1,
  grainRoughness: 50,
  grainColor: 12,
  grainHighlights: 25,
  grainSeed: 1847,
};

function pixels(width, height) {
  const output = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < output.length; index += 4) {
    output[index] = (index * 17) % 251;
    output[index + 1] = (index * 29) % 253;
    output[index + 2] = (index * 43) % 255;
    output[index + 3] = 255;
  }
  return output;
}

function percentile(values, amount) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))];
}

const previewBase = pixels(720, 480);
const previewTimes = [];
const curveTimes = [];
for (let iteration = 0; iteration < 12; iteration += 1) {
  const output = new Uint8ClampedArray(previewBase);
  let started = performance.now();
  applyStyleLuts(output, 720, 480, { global: identity, residuals: {} });
  applyBasicAdjustments(output, 720, 480, settings);
  applyCurveLuts(output, curves);
  previewTimes.push(performance.now() - started);
  started = performance.now();
  applyCurveLuts(output, curves);
  curveTimes.push(performance.now() - started);
}
const previewP95 = percentile(previewTimes.slice(2), 0.95);
const curveP95 = percentile(curveTimes.slice(2), 0.95);
assert.ok(previewP95 < 80, `720px CPU preview P95 ${previewP95.toFixed(1)}ms exceeds 80ms`);
assert.ok(curveP95 < 16, `curve P95 ${curveP95.toFixed(1)}ms exceeds 16ms`);

const exportWidth = 6000;
const exportHeight = 4000;
const exportPixels = pixels(exportWidth, exportHeight);
const exportStart = performance.now();
applyStyleLuts(
  exportPixels,
  exportWidth,
  exportHeight,
  { global: identity, residuals: {} },
);
applyBasicAdjustments(exportPixels, exportWidth, exportHeight, settings);
applyCurveLuts(exportPixels, curves);
const exportMs = performance.now() - exportStart;
assert.ok(exportMs < 15000, `24MP CPU export ${exportMs.toFixed(0)}ms exceeds 15s`);

assert.equal(
  detectRenderBackend({ navigator: { gpu: {} }, isSecureContext: true }).id,
  "webgpu",
);
assert.equal(
  detectRenderBackend({
    navigator: {},
    document: { createElement: () => ({ getContext: (name) => name === "webgl2" ? {} : null }) },
  }).id,
  "webgl2",
);
assert.equal(detectRenderBackend({ navigator: {} }).id, "worker-cpu");
assert.equal(
  recommendedPreviewSide({ previewLimit: 1600 }, 2, false),
  960,
  "low-memory devices should reduce preview resolution",
);

console.log("Performance verification passed", {
  previewP95: Number(previewP95.toFixed(2)),
  curveP95: Number(curveP95.toFixed(2)),
  export24MpMs: Number(exportMs.toFixed(1)),
  mainThreadArchitecture: "worker revision/cancellation",
});
