import {
  analyzePixels,
  applyStyleProfile,
  createToneLutV3,
} from "../src/colorEngine.js";

function makeImage(transform) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
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

function circularDistance(first, second) {
  return Math.abs(((first - second + 540) % 360) - 180);
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

function neutralDistance(first, second) {
  return first.neutralZones.reduce((sum, zone, index) => {
    const target = second.neutralZones[index];
    return sum + Math.hypot(zone.a - target.a, zone.b - target.b);
  }, 0);
}

function colorGridDistance(first, second) {
  let distance = 0;
  let evidence = 0;
  first.colorGrid.forEach((row, zoneIndex) => {
    row.forEach((cell, colorIndex) => {
      const target = second.colorGrid[zoneIndex][colorIndex];
      const weight = Math.min(cell.coverage, target.coverage);
      distance += (
        circularDistance(cell.hue, target.hue) / 45
        + Math.abs(cell.chroma - target.chroma) / 0.08
        + Math.abs(cell.lightness - target.lightness) / 0.2
      ) * weight;
      evidence += weight;
    });
  });
  return distance / Math.max(0.0001, evidence);
}

function makeTextureImage(amplitude) {
  const width = 72;
  const height = 54;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = 54 + x / (width - 1) * 146;
      const checker = ((x + y) % 2 ? 1 : -1) * amplitude;
      const value = Math.max(0, Math.min(255, base + checker));
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

function makeNeutralImage(cast = [0, 0, 0]) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    const tone = Math.floor(pixel / WIDTH) / (HEIGHT - 1);
    const value = 18 + tone * 218;
    const index = pixel * 4;
    data[index] = value + cast[0];
    data[index + 1] = value + cast[1];
    data[index + 2] = value + cast[2];
    data[index + 3] = 255;
  }
  return data;
}

const WIDTH = 24;
const HEIGHT = 16;
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
const source = analyzePixels(sourceData, { width: WIDTH, height: HEIGHT });
const reference = analyzePixels(referenceData, { width: WIDTH, height: HEIGHT });
const resultData = new Uint8ClampedArray(sourceData);
const identityLut = Uint8Array.from({ length: 256 }, (_, value) => value);
const neutralSettings = {
  strength: 100,
  temperature: 0,
  contrast: 0,
  saturation: 0,
  grain: 0,
};

const aggressiveToneLut = createToneLutV3(
  { tone: { quantiles: [0, 12, 28, 55, 96, 144, 190, 225, 246, 255] } },
  { tone: { quantiles: [0, 4, 10, 19, 30, 45, 64, 83, 102, 120] } },
  1,
);
for (let index = 1; index < aggressiveToneLut.length; index += 1) {
  if (aggressiveToneLut[index] + 1e-7 < aggressiveToneLut[index - 1]) {
    throw new Error(`Tone LUT is not monotonic at ${index}`);
  }
}
if (aggressiveToneLut.at(-1) < 0.93) {
  throw new Error(`Tone LUT collapsed the white point: ${aggressiveToneLut.at(-1)}`);
}

applyStyleProfile(
  resultData,
  source,
  reference,
  neutralSettings,
  [identityLut, identityLut, identityLut, identityLut],
  { width: WIDTH, height: HEIGHT },
);

const result = analyzePixels(resultData, { width: WIDTH, height: HEIGHT });
const sourceToneDistance = toneDistance(source, reference);
const resultToneDistance = toneDistance(result, reference);
const sourceZoneDistance = zoneColorDistance(source, reference);
const resultZoneDistance = zoneColorDistance(result, reference);
const sourceGridDistance = colorGridDistance(source, reference);
const resultGridDistance = colorGridDistance(result, reference);

if (!(resultToneDistance < sourceToneDistance * 0.72)) {
  throw new Error(`Tone matching regression: ${resultToneDistance} >= ${sourceToneDistance}`);
}
if (!(resultZoneDistance < sourceZoneDistance * 0.9)) {
  throw new Error(`Split-tone matching regression: ${resultZoneDistance} >= ${sourceZoneDistance}`);
}
if (!(resultGridDistance < sourceGridDistance * 0.86)) {
  throw new Error(`21-cell color matching regression: ${resultGridDistance} >= ${sourceGridDistance}`);
}
if (!resultData.every(Number.isFinite)) {
  throw new Error("Color engine emitted a non-finite channel value");
}

const foliageMask = {
  version: 1,
  model: "heuristic",
  confidence: 0.9,
  width: WIDTH,
  height: HEIGHT,
  masks: { foliage: new Float32Array(WIDTH * HEIGHT).fill(1) },
  regions: { foliage: { confidence: 0.9, coverage: 1 } },
};
const semanticSource = analyzePixels(sourceData, {
  width: WIDTH,
  height: HEIGHT,
  semanticMasks: foliageMask,
});
const semanticReference = analyzePixels(referenceData, {
  width: WIDTH,
  height: HEIGHT,
  semanticMasks: foliageMask,
});
const semanticResultData = new Uint8ClampedArray(sourceData);
applyStyleProfile(
  semanticResultData,
  semanticSource,
  semanticReference,
  neutralSettings,
  [identityLut, identityLut, identityLut, identityLut],
  { width: WIDTH, height: HEIGHT, semanticMasks: foliageMask },
);
if (!semanticResultData.every(Number.isFinite)) {
  throw new Error("Semantic color transfer emitted a non-finite channel value");
}
if (semanticResultData.every((value, index) => value === sourceData[index])) {
  throw new Error("Semantic color transfer did not modify any channel");
}

const neutralSourceData = makeNeutralImage();
const neutralReferenceData = makeNeutralImage([-3, 0, 8]);
const neutralSource = analyzePixels(neutralSourceData, { width: WIDTH, height: HEIGHT });
const neutralReference = analyzePixels(neutralReferenceData, { width: WIDTH, height: HEIGHT });
const neutralResultData = new Uint8ClampedArray(neutralSourceData);
applyStyleProfile(
  neutralResultData,
  neutralSource,
  neutralReference,
  neutralSettings,
  [identityLut, identityLut, identityLut, identityLut],
  { width: WIDTH, height: HEIGHT },
);
const neutralResult = analyzePixels(neutralResultData, { width: WIDTH, height: HEIGHT });
const sourceNeutralDistance = neutralDistance(neutralSource, neutralReference);
const resultNeutralDistance = neutralDistance(neutralResult, neutralReference);
if (!(resultNeutralDistance < sourceNeutralDistance * 0.55)) {
  throw new Error(`Neutral matching regression: ${resultNeutralDistance} >= ${sourceNeutralDistance}`);
}

const textureSourceImage = makeTextureImage(28);
const textureReferenceImage = makeTextureImage(9);
const textureSource = analyzePixels(textureSourceImage.data, textureSourceImage);
const textureReference = analyzePixels(textureReferenceImage.data, textureReferenceImage);
const textureResultData = new Uint8ClampedArray(textureSourceImage.data);
applyStyleProfile(
  textureResultData,
  textureSource,
  textureReference,
  neutralSettings,
  [identityLut, identityLut, identityLut, identityLut],
  textureSourceImage,
);
const textureResult = analyzePixels(textureResultData, textureSourceImage);
const textureDistance = (profile) =>
  Math.abs(profile.texture.microContrast - textureReference.texture.microContrast)
  + Math.abs(profile.texture.acutance - textureReference.texture.acutance) * 0.25;
if (!(textureDistance(textureResult) < textureDistance(textureSource))) {
  throw new Error("Texture matching regression: spatial detail did not move toward reference");
}

console.log(JSON.stringify({
  engineVersion: result.version,
  toneDistance: { before: sourceToneDistance, after: resultToneDistance },
  splitToneDistance: { before: sourceZoneDistance, after: resultZoneDistance },
  neutralDistance: { before: sourceNeutralDistance, after: resultNeutralDistance },
  colorGridDistance: { before: sourceGridDistance, after: resultGridDistance },
  textureDistance: {
    before: textureDistance(textureSource),
    after: textureDistance(textureResult),
  },
  sevenColorBands: result.colors.map(({ id, hue, chroma, coverage }) => ({
    id,
    hue: Math.round(hue),
    chroma: Number(chroma.toFixed(4)),
    coverage: Number(coverage.toFixed(4)),
  })),
}, null, 2));
