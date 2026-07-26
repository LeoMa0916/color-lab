import assert from "node:assert/strict";
import {
  adjustBasicPixel,
  applyBasicAdjustments,
} from "../src/basicAdjustments.js";

const zeroSettings = {
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
  grain: 0,
};

const identityPixels = new Uint8ClampedArray([24, 68, 112, 255]);
applyBasicAdjustments(identityPixels, 1, 1, zeroSettings);
assert.deepEqual([...identityPixels], [24, 68, 112, 255], "Zero settings changed pixels");

const warmed = new Uint8ClampedArray([128, 128, 128, 255]);
applyBasicAdjustments(warmed, 1, 1, { ...zeroSettings, temperature: 40 });
assert.ok(warmed[0] > warmed[2] + 35, "Temperature did not warm the image");

const contrasted = new Uint8ClampedArray([96, 96, 96, 255, 160, 160, 160, 255]);
applyBasicAdjustments(contrasted, 2, 1, { ...zeroSettings, contrast: 50 });
assert.ok(contrasted[4] - contrasted[0] > 64, "Contrast did not expand tonal separation");

const saturatedDirect = new Uint8ClampedArray([160, 120, 100, 255]);
applyBasicAdjustments(saturatedDirect, 1, 1, { ...zeroSettings, saturation: 100 });
assert.ok(
  Math.max(...saturatedDirect.slice(0, 3)) - Math.min(...saturatedDirect.slice(0, 3)) > 60,
  "Saturation did not expand channel separation",
);

const grainFirst = new Uint8ClampedArray(16 * 4).fill(128);
const grainSecond = new Uint8ClampedArray(grainFirst);
for (let index = 3; index < grainFirst.length; index += 4) {
  grainFirst[index] = 255;
  grainSecond[index] = 255;
}
applyBasicAdjustments(grainFirst, 4, 4, { ...zeroSettings, grain: 30 });
applyBasicAdjustments(grainSecond, 4, 4, { ...zeroSettings, grain: 30 });
assert.deepEqual(grainFirst, grainSecond, "Grain preview was not deterministic");
assert.ok(grainFirst.some((value, index) => index % 4 !== 3 && value !== 128), "Grain did not alter pixels");

const exposed = adjustBasicPixel([64, 64, 64], { ...zeroSettings, exposure: 1 });
assert.ok(exposed[0] > 64, "Positive exposure did not brighten the image");

const shadowDark = adjustBasicPixel([32, 32, 32], { ...zeroSettings, shadows: 100 })[0] - 32;
const shadowBright = adjustBasicPixel([224, 224, 224], { ...zeroSettings, shadows: 100 })[0] - 224;
assert.ok(shadowDark > shadowBright + 20, "Shadows adjustment was not isolated to dark tones");

const highlightDark = 32 - adjustBasicPixel([32, 32, 32], { ...zeroSettings, highlights: -100 })[0];
const highlightBright = 224 - adjustBasicPixel([224, 224, 224], { ...zeroSettings, highlights: -100 })[0];
assert.ok(highlightBright > highlightDark + 20, "Highlights adjustment was not isolated to bright tones");

const whiteDark = adjustBasicPixel([48, 48, 48], { ...zeroSettings, whites: 100 })[0] - 48;
const whiteBright = adjustBasicPixel([232, 232, 232], { ...zeroSettings, whites: 100 })[0] - 232;
assert.ok(whiteBright > whiteDark + 8, "Whites adjustment was not isolated to the white point");

const blackDark = 28 - adjustBasicPixel([28, 28, 28], { ...zeroSettings, blacks: -100 })[0];
const blackBright = 210 - adjustBasicPixel([210, 210, 210], { ...zeroSettings, blacks: -100 })[0];
assert.ok(blackDark > blackBright + 8, "Blacks adjustment was not isolated to the black point");

const tinted = adjustBasicPixel([128, 128, 128], { ...zeroSettings, tint: 50 });
assert.ok(
  tinted[0] + tinted[2] > tinted[1] * 2,
  "Positive tint did not move neutral color toward magenta",
);

const muted = adjustBasicPixel([128, 112, 104], { ...zeroSettings, vibrance: 100 });
const saturated = adjustBasicPixel([220, 42, 32], { ...zeroSettings, vibrance: 100 });
const chromaMultiplier = (input, output) =>
  (Math.max(...output) - Math.min(...output)) / (Math.max(...input) - Math.min(...input));
assert.ok(
  chromaMultiplier([128, 112, 104], muted) > chromaMultiplier([220, 42, 32], saturated),
  "Vibrance did not prioritize muted colors",
);

const detailPixels = new Uint8ClampedArray(7 * 7 * 4);
for (let pixel = 0; pixel < 49; pixel += 1) {
  const value = pixel === 24 ? 156 : 112;
  detailPixels.set([value, value, value, 255], pixel * 4);
}
applyBasicAdjustments(detailPixels, 7, 7, { ...zeroSettings, texture: 100 });
assert.ok(detailPixels[24 * 4] > 156, "Texture did not enhance fine local contrast");

const clarityPixels = new Uint8ClampedArray(7 * 7 * 4);
for (let pixel = 0; pixel < 49; pixel += 1) {
  const x = pixel % 7;
  const y = Math.floor(pixel / 7);
  const value = x >= 2 && x <= 4 && y >= 2 && y <= 4 ? 148 : 108;
  clarityPixels.set([value, value, value, 255], pixel * 4);
}
applyBasicAdjustments(clarityPixels, 7, 7, { ...zeroSettings, clarity: 100 });
assert.ok(clarityPixels[24 * 4] > 148, "Clarity did not enhance broader local contrast");

const dehazed = adjustBasicPixel([128, 128, 128], { ...zeroSettings, dehaze: 100 });
assert.ok(dehazed[0] < 128, "Positive dehaze did not deepen the tonal range");

console.log("Basic adjustments verification passed: live tone, color, detail, and deterministic grain controls.");
