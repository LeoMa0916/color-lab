import { applyBasicAdjustments } from "./basicAdjustments.js";
import { applyStyleProfile } from "./colorEngine.js";
import { applyCurveLuts, smoothCurveLut } from "./curveMath.js";
import {
  createLutFromRgba,
  lutToRgbaInput,
  residualLut,
  smoothLut,
  tetrahedralSample,
} from "./lut3d.js";

const REGIONAL_LUTS = ["skin", "sky", "foliage", "neutral"];
const IDENTITY = Uint8Array.from({ length: 256 }, (_, value) => value);
const IDENTITY_CURVES = {
  master: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
};

function rounded(values, digits = 5) {
  const scale = 10 ** digits;
  return Array.from(values || [], (value) =>
    Math.round((Number(value) || 0) * scale) / scale);
}

function buildToneGuard(source, reference) {
  const sourceTone = source?.tone?.quantiles;
  const referenceTone = reference?.tone?.quantiles;
  if (!sourceTone || !referenceTone) {
    return { toeLift: 0, shoulderDrop: 0, rangeCompression: 0 };
  }
  const sourceRange = Math.max(12, (sourceTone[9] ?? 255) - (sourceTone[1] ?? 0));
  const referenceRange = Math.max(12, (referenceTone[9] ?? 255) - (referenceTone[1] ?? 0));
  return {
    toeLift: Math.max(0, Math.min(0.22, ((referenceTone[1] ?? 0) - (sourceTone[1] ?? 0)) / 255)),
    shoulderDrop: Math.max(0, Math.min(0.22, ((sourceTone[9] ?? 255) - (referenceTone[9] ?? 255)) / 255)),
    rangeCompression: Math.max(0, Math.min(0.7, (sourceRange - referenceRange) / sourceRange)),
  };
}

function buildSkinColorTarget(source, reference, settings) {
  const sourceMean = source?.semantic?.regions?.skin?.profile?.mean;
  const referenceMean = reference?.semantic?.regions?.skin?.profile?.mean;
  if (sourceMean?.length < 3 || referenceMean?.length < 3 || !sourceMean || !referenceMean) return null;
  if (![...sourceMean.slice(0, 3), ...referenceMean.slice(0, 3)].every(Number.isFinite)) return null;
  const normalizedSource = sourceMean.slice(0, 3).map((value) => value / 255);
  const normalizedReference = referenceMean.slice(0, 3).map((value) => value / 255);
  const sourceLight = normalizedSource[0] * 0.2126
    + normalizedSource[1] * 0.7152
    + normalizedSource[2] * 0.0722;
  const referenceLight = normalizedReference[0] * 0.2126
    + normalizedReference[1] * 0.7152
    + normalizedReference[2] * 0.0722;
  return {
    sourceLight,
    referenceLight,
    sourceChroma: Math.max(...normalizedSource) - Math.min(...normalizedSource),
    referenceOffsets: normalizedReference.map((value) => value - referenceLight),
    strength: Math.max(0, Math.min(1, (settings?.strength ?? 100) / 100)),
  };
}

function buildToneCorrection(globalLut, source, reference, settings) {
  const data = new Uint8ClampedArray(256 * 4);
  for (let value = 0; value < 256; value += 1) {
    const index = value * 4;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  applyStyleProfile(
    data,
    source,
    reference,
    {
      strength: settings.strength,
      referenceLighting: settings.referenceLighting,
      temperature: 0,
      contrast: 0,
      saturation: 0,
      grain: 0,
    },
    [IDENTITY, IDENTITY, IDENTITY, IDENTITY],
    {
      width: 256,
      height: 1,
      samplePosition: [0.5, 0.5],
      skipTexture: true,
    },
  );
  return Float32Array.from({ length: 256 }, (_, value) => {
    const index = value * 4;
    const desired = (
      data[index] * 0.2126
      + data[index + 1] * 0.7152
      + data[index + 2] * 0.0722
    ) / 255;
    const sampled = tetrahedralSample(
      globalLut,
      [value / 255, value / 255, value / 255],
    );
    const rendered = sampled[0] * 0.2126 + sampled[1] * 0.7152 + sampled[2] * 0.0722;
    return Math.max(-0.18, Math.min(0.18, desired - rendered));
  });
}

function compactProfile(profile) {
  if (!profile) return null;
  return {
    version: profile.version,
    mean: rounded(profile.mean, 3),
    std: rounded(profile.std, 3),
    saturation: rounded([profile.saturation], 5)[0],
    tone: rounded(profile.tone?.quantiles, 3),
    zones: (profile.zones || []).map((zone) =>
      rounded([zone.lightness, zone.a, zone.b, zone.chroma, zone.weight], 5)),
    neutral: (profile.neutralZones || []).map((zone) =>
      rounded([zone.a, zone.b, zone.coverage], 5)),
    grid: (profile.colorGrid || []).map((row) =>
      row.map((cell) =>
        rounded([cell.hue, cell.chroma, cell.lightness, cell.coverage], 5))),
  };
}

export function profileFingerprint(profile) {
  if (!profile) return "none";
  const semantic = Object.fromEntries(
    Object.entries(profile.semantic?.regions || {})
      .filter(([, region]) => region?.profile)
      .map(([id, region]) => [
        id,
        {
          coverage: rounded([region.coverage], 5)[0],
          confidence: rounded([region.confidence], 5)[0],
          profile: compactProfile(region.profile),
        },
      ]),
  );
  return JSON.stringify({
    profile: compactProfile(profile),
    intrinsic: compactProfile(profile.lighting?.intrinsic),
    lighting: profile.lighting
      ? rounded([
        profile.lighting.temperature,
        profile.lighting.exposureEV,
        profile.lighting.confidence,
        ...(profile.lighting.grid || []).flatMap((cell) =>
          [cell?.red, cell?.green, cell?.blue, cell?.exposure]),
      ], 5)
      : null,
    semanticModel: profile.semantic?.model,
    semanticConfidence: rounded([profile.semantic?.confidence], 5)[0],
    semantic,
  });
}

function renderLut(source, reference, settings, size, region, includeAdjustments) {
  const data = lutToRgbaInput(size);
  const pixelCount = size ** 3;
  let semanticMasks = null;
  if (region) {
    semanticMasks = {
      width: pixelCount,
      height: 1,
      masks: { [region]: new Float32Array(pixelCount).fill(1) },
    };
  }
  applyStyleProfile(
    data,
    source,
    reference,
    {
      strength: settings.strength,
      referenceLighting: settings.referenceLighting,
      temperature: 0,
      contrast: 0,
      saturation: 0,
      grain: 0,
    },
    [IDENTITY, IDENTITY, IDENTITY, IDENTITY],
    {
      width: pixelCount,
      height: 1,
      semanticMasks,
      samplePosition: [0.5, 0.5],
      skipTexture: true,
    },
  );
  if (includeAdjustments) {
    applyBasicAdjustments(data, pixelCount, 1, {
      ...settings,
      texture: 0,
      clarity: 0,
      grain: 0,
    });
    applyCurveLuts(data, settings.curves || IDENTITY_CURVES);
  }
  // A 33³ global LUT already has enough samples to preserve a smooth tone
  // curve. Heavy neighbourhood smoothing noticeably flattens the shoulder and
  // toe that the analysis just recovered, especially for low-latitude
  // references. Keep a lighter pass for numerical continuity, while residual
  // region LUTs retain a little more smoothing because their 17³ grid is
  // blended through soft masks.
  return smoothLut(createLutFromRgba(data, size), region ? 0.04 : 0.01, 1);
}

export function buildStyleLuts(
  source,
  reference,
  settings,
  { includeAdjustments = false } = {},
) {
  const global = renderLut(source, reference, settings, 33, null, includeAdjustments);
  const residuals = {};
  REGIONAL_LUTS.forEach((region) => {
    if (
      !source?.semantic?.regions?.[region]?.profile
      || !reference?.semantic?.regions?.[region]?.profile
    ) return;
    const regional = renderLut(
      source,
      reference,
      settings,
      17,
      region,
      includeAdjustments,
    );
    residuals[region] = residualLut(global, regional);
  });
  return {
    version: 5,
    global,
    residuals,
    skinColorTarget: buildSkinColorTarget(source, reference, settings),
    toneGuard: buildToneGuard(source, reference),
    toneCorrection: buildToneCorrection(global, source, reference, settings),
    localRegions: Object.keys(residuals),
    includesAdjustments: includeAdjustments,
    limitations: {
      cube: ["semantic-local-luts", "texture", "grain"],
    },
  };
}

export function curveLutsFromSettings(settings) {
  const curves = settings.curves || IDENTITY_CURVES;
  return [
    smoothCurveLut(curves.master),
    smoothCurveLut(curves.red),
    smoothCurveLut(curves.green),
    smoothCurveLut(curves.blue),
  ];
}
