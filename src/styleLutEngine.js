import { applyBasicAdjustments } from "./basicAdjustments.js";
import { applyStyleProfile } from "./colorEngine.js";
import { applyCurveLuts, smoothCurveLut } from "./curveMath.js";
import {
  createLutFromRgba,
  lutToRgbaInput,
  residualLut,
  smoothLut,
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
  return smoothLut(createLutFromRgba(data, size), region ? 0.05 : 0.04, 1);
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
    version: 4,
    global,
    residuals,
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
