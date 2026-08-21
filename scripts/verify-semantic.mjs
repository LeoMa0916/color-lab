import assert from "node:assert/strict";
import { analyzePixels, applyStyleProfile } from "../src/colorEngine.js";
import { createHeuristicSemanticMasks } from "../src/semanticEngine.js";
import { applyStyleLuts } from "../src/lut3d.js";
import { buildStyleLuts } from "../src/styleLutEngine.js";

const width = 80;
const height = 48;
const pixels = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    const isFace = x >= 28 && x < 52 && y >= 10 && y < 39;
    const color = isFace ? [205, 145, 115] : [240, 100, 10];
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
    pixels[index + 3] = 255;
  }
}

const masks = createHeuristicSemanticMasks(pixels, width, height);
const facePixel = 20 * width + 40;
const backgroundPixel = 20 * width + 8;
assert.ok(masks.skin[facePixel] > 0.4, "skin subject should be detected");
assert.ok(masks.skin[backgroundPixel] < 0.12, "saturated orange background must not be skin");

const semanticMasks = {
  version: 1,
  model: "heuristic",
  confidence: 0.58,
  masks,
  regions: {
    skin: { label: "肤色", color: "#ff9f8f", confidence: 0.58 },
  },
};
const profile = analyzePixels(pixels, { width, height, semanticMasks });
assert.equal(profile.version, 3);
assert.ok(profile.semantic?.regions?.skin, "semantic skin profile should be recorded");
assert.ok(
  profile.semantic.regions.skin.coverage < 0.35,
  "skin coverage should remain isolated from the orange background",
);

const emptyProfile = analyzePixels(pixels, { width, height });
const output = new Uint8ClampedArray(pixels);
const identity = Uint8Array.from({ length: 256 }, (_, value) => value);
applyStyleProfile(
  output,
  profile,
  profile,
  { strength: 100, temperature: 0, contrast: 0, saturation: 0, grain: 0 },
  [identity, identity, identity, identity],
  { width, height, semanticMasks },
);
let maximumRoundTripError = 0;
for (let index = 0; index < output.length; index += 4) {
  maximumRoundTripError = Math.max(
    maximumRoundTripError,
    Math.abs(output[index] - pixels[index]),
    Math.abs(output[index + 1] - pixels[index + 1]),
    Math.abs(output[index + 2] - pixels[index + 2]),
  );
}
assert.ok(maximumRoundTripError <= 3, "matching a profile to itself must stay near identity");
assert.equal(emptyProfile.semantic, undefined, "V3 fallback remains available without semantic masks");

function makeGreenPortrait(skin, foliage) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const isFace = x >= 27 && x < 55 && y >= 8 && y < 42;
      const color = isFace ? skin : foliage;
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = 255;
    }
  }
  const semantic = {
    version: 1,
    width,
    height,
    model: "heuristic",
    confidence: 0.58,
    masks: createHeuristicSemanticMasks(data, width, height),
  };
  semantic.regions = {
    skin: { label: "肤色", confidence: 0.58 },
    foliage: { label: "植物", confidence: 0.58 },
  };
  return { data, semantic };
}

const greenTarget = makeGreenPortrait([178, 157, 143], [38, 77, 43]);
const greenReference = makeGreenPortrait([226, 169, 145], [21, 60, 36]);
const greenTargetProfile = analyzePixels(greenTarget.data, {
  width,
  height,
  semanticMasks: greenTarget.semantic,
});
const greenReferenceProfile = analyzePixels(greenReference.data, {
  width,
  height,
  semanticMasks: greenReference.semantic,
});
const greenSettings = {
  strength: 100,
  referenceLighting: 35,
  temperature: 0,
  contrast: 0,
  saturation: 0,
  grain: 0,
};
const greenLuts = buildStyleLuts(
  greenTargetProfile,
  greenReferenceProfile,
  greenSettings,
);
const greenOutput = new Uint8ClampedArray(greenTarget.data);
applyStyleLuts(greenOutput, width, height, greenLuts, greenTarget.semantic);
const skinIndex = (20 * width + 40) * 4;
const beforeSkin = Array.from(greenTarget.data.slice(skinIndex, skinIndex + 3));
const afterSkin = Array.from(greenOutput.slice(skinIndex, skinIndex + 3));
const referenceSkin = [226, 169, 145];
const distance = (left, right) => Math.hypot(
  left[0] - right[0],
  left[1] - right[1],
  left[2] - right[2],
);
const chroma = (rgb) => Math.max(...rgb) - Math.min(...rgb);
console.log("Portrait skin regression", { beforeSkin, afterSkin, referenceSkin });
assert.ok(
  distance(afterSkin, referenceSkin) < distance(beforeSkin, referenceSkin) * 0.44,
  "heuristic fallback must still move skin toward the reference",
);
assert.ok(
  chroma(afterSkin) >= chroma(referenceSkin) * 0.8,
  "green-heavy scenes must not collapse skin into gray-cyan",
);
assert.ok(
  afterSkin[2] <= referenceSkin[2] + 12,
  "skin matching must suppress excess blue instead of leaving a gray cast",
);

console.log("Semantic region verification passed", {
  skinCoverage: Number(profile.semantic.regions.skin.coverage.toFixed(3)),
  maximumRoundTripError,
  greenSkinBefore: beforeSkin,
  greenSkinAfter: afterSkin,
});
