import assert from "node:assert/strict";
import { applyBasicAdjustments } from "../src/basicAdjustments.js";
import { analyzePixels } from "../src/colorEngine.js";
import { rgbaToBmpBuffer } from "../src/exportEncoding.js";
import {
  applyTextureMatch,
  applyTextureMatchTiled,
} from "../src/textureEngine.js";

const width = 96;
const height = 64;
const source = new Uint8ClampedArray(width * height * 4);
const reference = new Uint8ClampedArray(source.length);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    const base = 72 + x / (width - 1) * 120;
    const texture = ((x * 17 + y * 31) % 9 - 4) * (base < 110 ? 1.6 : base > 185 ? 0.35 : 1);
    source.set([base, base, base, 255], index);
    reference.set([base + texture, base + texture * 0.9, base + texture * 1.08, 255], index);
  }
}

const sourceProfile = analyzePixels(source, { width, height, skipLighting: true });
const referenceProfile = analyzePixels(reference, { width, height, skipLighting: true });
assert.equal(referenceProfile.texture.spectrum.length, 4);
assert.equal(referenceProfile.texture.noise.luma.length, 3);
assert.ok(
  referenceProfile.texture.noise.luma[0] > referenceProfile.texture.noise.luma[2],
  "reference analysis should preserve tone-dependent grain energy",
);

const matched = new Uint8ClampedArray(source);
applyTextureMatch(matched, width, height, sourceProfile, referenceProfile, 1);
const matchedProfile = analyzePixels(matched, { width, height, skipLighting: true });
const spectrumDistance = (left, right) =>
  left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0);
assert.ok(
  spectrumDistance(matchedProfile.texture.spectrum, referenceProfile.texture.spectrum)
    < spectrumDistance(sourceProfile.texture.spectrum, referenceProfile.texture.spectrum),
  "multi-scale texture matching should approach the reference spectrum",
);

const directMatch = new Uint8ClampedArray(source);
const tiledMatch = new Uint8ClampedArray(source);
applyTextureMatch(directMatch, width, height, sourceProfile, referenceProfile, 1);
applyTextureMatchTiled(
  tiledMatch,
  width,
  height,
  sourceProfile,
  referenceProfile,
  1,
  { tileSize: 32, directPixelLimit: 1 },
);
let maximumTileDifference = 0;
for (let index = 0; index < directMatch.length; index += 1) {
  maximumTileDifference = Math.max(
    maximumTileDifference,
    Math.abs(directMatch[index] - tiledMatch[index]),
  );
}
assert.ok(
  maximumTileDifference <= 1,
  `tiled texture rendering must not create seams (${maximumTileDifference})`,
);

const bmp = rgbaToBmpBuffer(
  new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
  ]),
  2,
  1,
);
const bmpView = new DataView(bmp);
assert.equal(bmpView.getUint16(0, true), 0x4d42, "BMP signature must be valid");
assert.equal(bmp.byteLength, 62, "BMP byte length must match its dimensions");

const grainSettings = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: 0,
  grain: 30,
  grainSize: 2,
  grainRoughness: 0,
  grainColor: 40,
  grainHighlights: 0,
  grainSeed: 1847,
};
function grayRow(rowWidth, value = 128) {
  const data = new Uint8ClampedArray(rowWidth * 4);
  for (let pixel = 0; pixel < rowWidth; pixel += 1) {
    data.set([value, value, value, 255], pixel * 4);
  }
  return data;
}
const preview = grayRow(1600);
const exportRow = grayRow(3200);
applyBasicAdjustments(preview, 1600, 1, grainSettings);
applyBasicAdjustments(exportRow, 3200, 1, grainSettings);
const previewSample = [...preview.slice(400 * 4, 400 * 4 + 3)];
const exportSample = [...exportRow.slice(800 * 4, 800 * 4 + 3)];
assert.deepEqual(
  previewSample,
  exportSample,
  "grain size must scale with output pixel density",
);
assert.ok(
  new Set(previewSample).size > 1,
  "color grain ratio should create channel-independent noise",
);

const dark = grayRow(1600, 48);
const highlight = grayRow(1600, 232);
applyBasicAdjustments(dark, 1600, 1, grainSettings);
applyBasicAdjustments(highlight, 1600, 1, grainSettings);
const deviation = (data, base) =>
  data.reduce((sum, value, index) => index % 4 === 3 ? sum : sum + Math.abs(value - base), 0);
assert.ok(
  deviation(dark, 48) > deviation(highlight, 232),
  "highlight response should suppress highlight grain",
);

console.log("Texture and film grain verification passed", {
  sourceSpectrum: sourceProfile.texture.spectrum.map((value) => Number(value.toFixed(4))),
  matchedSpectrum: matchedProfile.texture.spectrum.map((value) => Number(value.toFixed(4))),
  referenceSpectrum: referenceProfile.texture.spectrum.map((value) => Number(value.toFixed(4))),
  maximumTileDifference,
  resolutionSamples: { previewSample, exportSample },
});
