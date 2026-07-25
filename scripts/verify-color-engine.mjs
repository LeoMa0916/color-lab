import {
  analyzePixels,
  applyStyleProfile,
} from "../src/colorEngine.js";

function makeImage(transform) {
  const data = new Uint8ClampedArray(384 * 4);
  for (let pixel = 0; pixel < 384; pixel += 1) {
    const band = pixel % 8;
    const tone = Math.floor(pixel / 8) / 47;
    const base = [
      [210, 52, 46],
      [226, 112, 36],
      [218, 190, 42],
      [50, 170, 78],
      [43, 168, 178],
      [48, 86, 205],
      [142, 60, 180],
      [150, 150, 150],
    ][band].map((value) => value * (0.2 + tone * 0.8));
    const [red, green, blue] = transform(base, tone);
    const index = pixel * 4;
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
    data[index + 3] = 255;
  }
  return data;
}

function toneDistance(first, second) {
  return first.tone.quantiles.reduce(
    (sum, value, index) => sum + Math.abs(value - second.tone.quantiles[index]),
    0,
  );
}

function zoneColorDistance(first, second) {
  return first.zones.reduce((sum, zone, index) => {
    const target = second.zones[index];
    return sum + Math.hypot(zone.a - target.a, zone.b - target.b);
  }, 0);
}

const identity = (rgb) => rgb;
const filmReference = ([red, green, blue], tone) => {
  const lifted = 13 + 228 * (tone ** 0.88);
  const originalLightness = red * 0.299 + green * 0.587 + blue * 0.114;
  const scale = lifted / Math.max(1, originalLightness);
  return [
    red * scale + 12 * tone,
    green * scale + 4,
    blue * scale + 10 * (1 - tone),
  ];
};

const sourceData = makeImage(identity);
const referenceData = makeImage(filmReference);
const source = analyzePixels(sourceData);
const reference = analyzePixels(referenceData);
const resultData = new Uint8ClampedArray(sourceData);
const identityLut = Uint8Array.from({ length: 256 }, (_, value) => value);

applyStyleProfile(
  resultData,
  source,
  reference,
  {
    strength: 100,
    temperature: 0,
    contrast: 0,
    saturation: 0,
    grain: 0,
  },
  [identityLut, identityLut, identityLut, identityLut],
);

const result = analyzePixels(resultData);
const sourceToneDistance = toneDistance(source, reference);
const resultToneDistance = toneDistance(result, reference);
const sourceZoneDistance = zoneColorDistance(source, reference);
const resultZoneDistance = zoneColorDistance(result, reference);

if (!(resultToneDistance < sourceToneDistance * 0.72)) {
  throw new Error(`Tone matching regression: ${resultToneDistance} >= ${sourceToneDistance}`);
}
if (!(resultZoneDistance < sourceZoneDistance * 0.9)) {
  throw new Error(`Split-tone matching regression: ${resultZoneDistance} >= ${sourceZoneDistance}`);
}
if (!resultData.every(Number.isFinite)) {
  throw new Error("Color engine emitted a non-finite channel value");
}

console.log(JSON.stringify({
  toneDistance: { before: sourceToneDistance, after: resultToneDistance },
  splitToneDistance: { before: sourceZoneDistance, after: resultZoneDistance },
  sevenColorBands: result.colors.map(({ id, hue, chroma, coverage }) => ({
    id,
    hue: Math.round(hue),
    chroma: Number(chroma.toFixed(4)),
    coverage: Number(coverage.toFixed(4)),
  })),
}, null, 2));
