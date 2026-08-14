import assert from "node:assert/strict";
import {
  adjustColorPlanePixel,
  applyColorPlaneAdjustments,
  defaultColorPlaneSettings,
  hasColorPlaneAdjustments,
} from "../src/colorPlaneEngine.js";

function distance(left, right) {
  return Math.hypot(
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  );
}

const identity = defaultColorPlaneSettings();
assert.equal(hasColorPlaneAdjustments(identity), false, "Default V5 plane is not identity");
const identityPixels = new Uint8ClampedArray([
  18, 46, 82, 255,
  128, 128, 128, 255,
  235, 172, 84, 255,
]);
const untouched = new Uint8ClampedArray(identityPixels);
applyColorPlaneAdjustments(untouched, identity);
assert.deepEqual(untouched, identityPixels, "Identity V5 plane changed image data");

const hueEdit = defaultColorPlaneSettings();
hueEdit.hueLayers.global[0] = {
  ...hueEdit.hueLayers.global[0],
  hueShift: 32,
  saturation: 28,
};
const red = [220, 44, 42];
const orange = [220, 118, 36];
const cyan = [35, 172, 182];
const redAdjusted = adjustColorPlanePixel(red, hueEdit);
const orangeAdjusted = adjustColorPlanePixel(orange, hueEdit);
const cyanAdjusted = adjustColorPlanePixel(cyan, hueEdit);
assert.ok(distance(red, redAdjusted) > 18, "A/B node did not move its target hue");
assert.ok(distance(orange, orangeAdjusted) > 3, "A/B edit did not smoothly affect adjacent hues");
assert.ok(
  distance(red, redAdjusted) > distance(cyan, cyanAdjusted) * 3,
  "A/B edit leaked too strongly into the opposite hue",
);

const protectedNeutral = adjustColorPlanePixel([126, 128, 127], hueEdit);
assert.ok(
  distance([126, 128, 127], protectedNeutral) < 2,
  "Neutral protection allowed hue edits to tint gray",
);

const toneEdit = defaultColorPlaneSettings();
toneEdit.luminance[2].shift = 24;
const dark = [24, 24, 24];
const middle = [120, 120, 120];
const bright = [238, 238, 238];
const darkAdjusted = adjustColorPlanePixel(dark, toneEdit);
const middleAdjusted = adjustColorPlanePixel(middle, toneEdit);
const brightAdjusted = adjustColorPlanePixel(bright, toneEdit);
assert.ok(
  distance(middle, middleAdjusted) > distance(dark, darkAdjusted) + 10,
  "C/L middle anchor did not remain localized",
);
assert.ok(
  distance(middle, middleAdjusted) > distance(bright, brightAdjusted) + 10,
  "C/L middle anchor changed highlights too strongly",
);

const extreme = defaultColorPlaneSettings();
for (const layer of Object.values(extreme.hueLayers)) {
  layer.forEach((node, index) => {
    node.hueShift = index % 2 ? 55 : -55;
    node.saturation = 75;
  });
}
extreme.luminance.forEach((node, index) => { node.shift = index < 3 ? -45 : 45; });
const gamutPixels = new Uint8ClampedArray(256 * 4);
for (let index = 0; index < 256; index += 1) {
  gamutPixels.set([index, 255 - index, (index * 73) % 256, 255], index * 4);
}
applyColorPlaneAdjustments(gamutPixels, extreme);
assert.ok(
  gamutPixels.every((value) => Number.isFinite(value) && value >= 0 && value <= 255),
  "V5 color-plane output escaped the display gamut",
);

const previewPixels = new Uint8ClampedArray(720 * 480 * 4);
for (let index = 0; index < previewPixels.length; index += 4) {
  previewPixels.set([(index / 4) % 256, 132, 214, 255], index);
}
const previewStarted = performance.now();
applyColorPlaneAdjustments(previewPixels, hueEdit);
const previewMs = performance.now() - previewStarted;
assert.ok(previewMs < 100, `V5 720px preview took ${previewMs.toFixed(1)}ms`);

const exportPixels = new Uint8ClampedArray(6000 * 4000 * 4);
for (let index = 0; index < exportPixels.length; index += 4) {
  const pixel = index / 4;
  exportPixels[index] = pixel % 256;
  exportPixels[index + 1] = (pixel * 7) % 256;
  exportPixels[index + 2] = (pixel * 17) % 256;
  exportPixels[index + 3] = 255;
}
const exportStarted = performance.now();
applyColorPlaneAdjustments(exportPixels, hueEdit);
const exportMs = performance.now() - exportStarted;
assert.ok(exportMs < 6000, `V5 24MP color-plane pass took ${exportMs.toFixed(1)}ms`);

console.log("Color Engine 5 verification passed", {
  abLocality: true,
  clToneIsolation: true,
  neutralProtection: true,
  gamutSafety: true,
  preview720Ms: Number(previewMs.toFixed(2)),
  export24MpMs: Number(exportMs.toFixed(2)),
});
