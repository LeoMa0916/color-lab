import {
  ciede2000,
  clippingRates,
  colorDistributionDistance,
  meanImageDeltaE,
  qualityReport,
  rgbToLab,
  tonePercentileDistance,
} from "../src/qualityMetrics.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function image(values) {
  return new Uint8ClampedArray(values.flatMap((rgb) => [...rgb, 255]));
}

const publishedPair = ciede2000(
  [50, 2.6772, -79.7751],
  [50, 0, -82.7485],
);
assert(
  Math.abs(publishedPair - 2.0425) < 0.0001,
  `CIEDE2000 reference pair mismatch: ${publishedPair}`,
);

const blackLab = rgbToLab(0, 0, 0);
const whiteLab = rgbToLab(255, 255, 255);
assert(Math.abs(blackLab[0]) < 0.0001, "Black must map to L*=0");
assert(Math.abs(whiteLab[0] - 100) < 0.001, "White must map to L*=100");

const reference = image([
  [18, 18, 18],
  [82, 65, 56],
  [128, 132, 136],
  [210, 171, 149],
  [245, 246, 247],
  [45, 104, 192],
  [49, 154, 74],
  [204, 73, 52],
]);
const identical = new Uint8ClampedArray(reference);
const shifted = image([
  [0, 0, 0],
  [108, 55, 42],
  [148, 136, 125],
  [238, 158, 128],
  [255, 255, 255],
  [71, 89, 213],
  [61, 177, 55],
  [236, 54, 44],
]);

assert(meanImageDeltaE(reference, identical) === 0, "Identity image delta must be zero");
assert(meanImageDeltaE(reference, shifted) > 3, "Color shift must be measurable");
assert(tonePercentileDistance(reference, identical) === 0, "Identity tone distance must be zero");
assert(
  colorDistributionDistance(reference, identical) === 0,
  "Identity color distribution distance must be zero",
);
const clipping = clippingRates(shifted);
assert(clipping.black > 0 && clipping.white > 0, "Clipping rates must detect both endpoints");

const tiledReference = new Uint8ClampedArray(32 * 32 * 4);
const tiledShifted = new Uint8ClampedArray(tiledReference.length);
for (let pixel = 0; pixel < 32 * 32; pixel += 1) {
  const sourceIndex = (pixel % (reference.length / 4)) * 4;
  const targetIndex = (pixel % (shifted.length / 4)) * 4;
  tiledReference.set(reference.subarray(sourceIndex, sourceIndex + 4), pixel * 4);
  tiledShifted.set(shifted.subarray(targetIndex, targetIndex + 4), pixel * 4);
}
const report = qualityReport(tiledReference, tiledShifted, 32, 32);
assert(
  Object.entries(report).every(([, value]) => value === null || Number.isFinite(value)),
  "Quality report emitted a non-finite metric",
);

console.log("Quality metrics verification passed", {
  ciede2000Reference: Number(publishedPair.toFixed(4)),
  shiftedMeanDelta: Number(report.ciede2000.toFixed(3)),
  toneDistance: Number(report.tonePercentileDistance.toFixed(3)),
  clipping,
});
