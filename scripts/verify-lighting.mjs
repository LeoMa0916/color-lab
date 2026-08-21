import assert from "node:assert/strict";
import { analyzePixels } from "../src/colorEngine.js";
import {
  analyzeSceneLighting,
  applySceneLighting,
  blendSceneLighting,
  lightingProfileWeights,
  normalizeRgbForLighting,
} from "../src/lightingEngine.js";

const width = 64;
const height = 48;

function makeScene(cast, exposure) {
  const data = new Uint8ClampedArray(width * height * 4);
  const neutral = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const index = pixel * 4;
      const neutralPatch = x < width / 2;
      const base = neutralPatch
        ? 70 + y / (height - 1) * 130
        : [158, 92 + x, 58 + y];
      const rgb = Array.isArray(base) ? base : [base, base, base];
      data[index] = Math.min(255, rgb[0] * cast[0] * exposure);
      data[index + 1] = Math.min(255, rgb[1] * cast[1] * exposure);
      data[index + 2] = Math.min(255, rgb[2] * cast[2] * exposure);
      data[index + 3] = 255;
      neutral[pixel] = neutralPatch ? 1 : 0;
    }
  }
  return {
    data,
    semantic: {
      version: 1,
      model: "heuristic",
      confidence: 0.8,
      masks: { neutral },
      regions: { neutral: { label: "中性色", confidence: 0.8 } },
    },
  };
}

const warm = makeScene([1.12, 1, 0.84], 0.78);
const cool = makeScene([0.86, 1, 1.15], 1.16);
const warmProfile = analyzePixels(warm.data, {
  width,
  height,
  semanticMasks: warm.semantic,
});
const coolProfile = analyzePixels(cool.data, {
  width,
  height,
  semanticMasks: cool.semantic,
});

assert.ok(warmProfile.lighting && coolProfile.lighting, "scene lighting must be estimated");
assert.equal(warmProfile.lighting.grid.length, 64, "mixed lighting uses an 8x8 grid");
assert.ok(
  Math.abs(
    warmProfile.lighting.intrinsic.tone.midtone
      - coolProfile.lighting.intrinsic.tone.midtone,
  )
    < Math.abs(warmProfile.tone.midtone - coolProfile.tone.midtone),
  "intrinsic style should be more stable than the captured exposure",
);

const sample = [150, 125, 105];
const intrinsic = normalizeRgbForLighting(sample, warmProfile.lighting, 0.5, 0.5);
const sourceLight = blendSceneLighting(warmProfile.lighting, coolProfile.lighting, 0);
const referenceLight = blendSceneLighting(warmProfile.lighting, coolProfile.lighting, 1);
const preserve = applySceneLighting(intrinsic, sourceLight, 0.5, 0.5);
const copy = applySceneLighting(intrinsic, referenceLight, 0.5, 0.5);
assert.ok(
  Math.abs(preserve[0] - sample[0]) < 4
    && Math.abs(preserve[1] - sample[1]) < 4
    && Math.abs(preserve[2] - sample[2]) < 4,
  "0 reference lighting should preserve target illumination",
);
assert.ok(copy[2] / copy[0] > preserve[2] / preserve[0], "100 should move toward cool reference");

const darkCaptureLighting = {
  exposureEV: -0.75,
  whitePoint: [1, 1, 1],
  confidence: 0.8,
};
const brightCapturedSample = [220, 210, 200];
const normalizedHighlight = normalizeRgbForLighting(
  brightCapturedSample,
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
    brightCapturedSample[channel] - value < 24),
  "encoded-light normalization must not collapse highlights from a dark capture",
);

const neutral = makeScene([1, 1, 1], 1);
const outlier = makeScene([1.25, 0.92, 0.7], 0.36);
const weights = lightingProfileWeights([
  warmProfile,
  coolProfile,
  analyzePixels(neutral.data, { width, height, semanticMasks: neutral.semantic }),
  analyzePixels(outlier.data, { width, height, semanticMasks: outlier.semantic }),
]);
assert.ok(weights[3] < Math.max(...weights.slice(0, 3)), "lighting outlier must be down-weighted");

const uncertain = new Uint8ClampedArray(width * height * 4);
for (let index = 0; index < uncertain.length; index += 4) {
  uncertain[index] = 235;
  uncertain[index + 1] = 20;
  uncertain[index + 2] = 150;
  uncertain[index + 3] = 255;
}
const uncertainLight = analyzeSceneLighting(uncertain, width, height);
assert.ok(
  uncertainLight.temperature >= 2500 && uncertainLight.temperature <= 12000,
  "low confidence scenes must never create extreme color temperature",
);

const portraitScene = new Uint8ClampedArray(width * height * 4);
const portraitNeutral = new Float32Array(width * height);
const portraitSkin = new Float32Array(width * height);
for (let pixel = 0; pixel < width * height; pixel += 1) {
  const index = pixel * 4;
  const neutralPatch = pixel % width < 8;
  const color = neutralPatch ? [132, 132, 132] : [181, 163, 151];
  portraitScene[index] = color[0];
  portraitScene[index + 1] = color[1];
  portraitScene[index + 2] = color[2];
  portraitScene[index + 3] = 255;
  portraitNeutral[pixel] = 1;
  portraitSkin[pixel] = neutralPatch ? 0 : 1;
}
const portraitLight = analyzeSceneLighting(portraitScene, width, height, {
  masks: { neutral: portraitNeutral, skin: portraitSkin },
});
assert.ok(
  portraitLight.whitePoint.every((channel) => Math.abs(channel - 1) < 0.025),
  "pale skin must not contaminate the scene white point",
);

console.log("Lighting separation verification passed", {
  warmTemperature: Math.round(warmProfile.lighting.temperature),
  coolTemperature: Math.round(coolProfile.lighting.temperature),
  intrinsicMidtoneDistance: Math.abs(
    warmProfile.lighting.intrinsic.tone.midtone
      - coolProfile.lighting.intrinsic.tone.midtone,
  ),
  outlierWeight: Number(weights[3].toFixed(3)),
});
