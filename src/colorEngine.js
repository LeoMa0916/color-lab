import {
  analyzeSceneLighting,
  applySceneLighting,
  averageLightingProfiles,
  blendSceneLighting,
  lightingProfileWeights,
  normalizeFrameLighting,
  normalizeRgbForLighting,
} from "./lightingEngine.js";
import { analyzeTextureSpectrum } from "./textureEngine.js";

export const HUE_BANDS = [
  { id: "red", label: "红", anchor: 25, color: "#ff5b62" },
  { id: "orange", label: "橙", anchor: 55, color: "#ff984f" },
  { id: "yellow", label: "黄", anchor: 95, color: "#f4d75e" },
  { id: "green", label: "绿", anchor: 145, color: "#58cf83" },
  { id: "cyan", label: "青", anchor: 195, color: "#4fd2d0" },
  { id: "blue", label: "蓝", anchor: 255, color: "#658cff" },
  { id: "purple", label: "紫", anchor: 315, color: "#bd72e8" },
];

const TONE_PERCENTILES = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1];
const ZONES = [
  { id: "shadows", label: "暗部", center: 0.16, spread: 0.24 },
  { id: "midtones", label: "中间调", center: 0.5, spread: 0.25 },
  { id: "highlights", label: "高光", center: 0.84, spread: 0.24 },
];
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
});

export function clampByte(value) {
  return Math.min(255, Math.max(0, value));
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0, edge1, value) {
  const amount = clampUnit((value - edge0) / Math.max(0.00001, edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}

function circularDistance(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function circularDelta(target, source) {
  return ((target - source + 540) % 360) - 180;
}

function zoneWeights(lightness) {
  const weights = ZONES.map((zone) => {
    const distance = (lightness - zone.center) / zone.spread;
    return Math.exp(-distance * distance);
  });
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return weights.map((value) => value / total);
}

function hueWeights(hue) {
  const weights = HUE_BANDS.map((band) => {
    const distance = circularDistance(hue, band.anchor) / 34;
    return Math.exp(-0.5 * distance * distance);
  });
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return weights.map((value) => value / total);
}

function linearToSrgb(value) {
  const channel = Math.max(0, value);
  const encoded = channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055;
  return clampByte(encoded * 255);
}

export function rgbToOklab(red, green, blue) {
  const r = SRGB_TO_LINEAR[Math.round(clampByte(red))];
  const g = SRGB_TO_LINEAR[Math.round(clampByte(green))];
  const b = SRGB_TO_LINEAR[Math.round(clampByte(blue))];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb(lightness, a, b) {
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function normalizedHistogram(counts) {
  const peak = Math.max(...counts, 1);
  return counts.map((value) => value / peak);
}

export function getHistogram(data, bins = 96) {
  const counts = {
    red: Array(bins).fill(0),
    green: Array(bins).fill(0),
    blue: Array(bins).fill(0),
    master: Array(bins).fill(0),
  };
  const step = 256 / bins;
  const pixelCount = data.length / 4;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 240000));
  for (let pixel = 0; pixel < pixelCount; pixel += sampleStep) {
    const index = pixel * 4;
    if (data[index + 3] < 16) continue;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const [lightness] = rgbToOklab(red, green, blue);
    counts.red[Math.min(bins - 1, Math.floor(red / step))] += 1;
    counts.green[Math.min(bins - 1, Math.floor(green / step))] += 1;
    counts.blue[Math.min(bins - 1, Math.floor(blue / step))] += 1;
    counts.master[Math.min(bins - 1, Math.floor(clampUnit(lightness) * bins))] += 1;
  }
  return Object.fromEntries(
    Object.entries(counts).map(([channel, values]) => [channel, normalizedHistogram(values)]),
  );
}

function quantilesFromCounts(counts, total) {
  const result = [];
  let cumulative = 0;
  let percentileIndex = 0;
  for (let value = 0; value < counts.length && percentileIndex < TONE_PERCENTILES.length; value += 1) {
    cumulative += counts[value];
    while (
      percentileIndex < TONE_PERCENTILES.length
      && cumulative >= TONE_PERCENTILES[percentileIndex] * total
    ) {
      result.push(value);
      percentileIndex += 1;
    }
  }
  while (result.length < TONE_PERCENTILES.length) result.push(255);
  return result;
}

function emptyZone(zone) {
  return { id: zone.id, label: zone.label, weight: 0, lightness: 0, a: 0, b: 0, chroma: 0 };
}

function emptyHueBand(band) {
  return {
    id: band.id,
    label: band.label,
    anchor: band.anchor,
    color: band.color,
    weight: 0,
    hue: band.anchor,
    chroma: 0,
    lightness: 0,
    coverage: 0,
    sin: 0,
    cos: 0,
  };
}

function emptyNeutralZone(zone) {
  return {
    id: zone.id,
    label: zone.label,
    weight: 0,
    a: 0,
    b: 0,
    coverage: 0,
  };
}

function emptyColorCell(zone, band) {
  return {
    zone: zone.id,
    id: band.id,
    weight: 0,
    hue: band.anchor,
    chroma: 0,
    lightness: 0,
    coverage: 0,
    sin: 0,
    cos: 0,
  };
}

function finalizeZone(zone) {
  const weight = Math.max(zone.weight, 0.00001);
  const lightness = zone.lightness / weight;
  const a = zone.a / weight;
  const b = zone.b / weight;
  return {
    ...zone,
    lightness,
    a,
    b,
    chroma: zone.chroma / weight,
    rgb: oklabToRgb(lightness, a, b).map(Math.round),
  };
}

function finalizeHueBand(band, totalSamples) {
  const weight = Math.max(band.weight, 0.00001);
  const hue = band.weight
    ? (Math.atan2(band.sin / weight, band.cos / weight) * 180 / Math.PI + 360) % 360
    : band.anchor;
  return {
    ...band,
    hue,
    chroma: band.chroma / weight,
    lightness: band.weight ? band.lightness / weight : 0.5,
    coverage: band.weight / Math.max(totalSamples, 1),
  };
}

function finalizeNeutralZone(zone, totalSamples) {
  const weight = Math.max(zone.weight, 0.00001);
  return {
    ...zone,
    a: zone.a / weight,
    b: zone.b / weight,
    coverage: zone.weight / Math.max(totalSamples, 1),
  };
}

function finalizeColorCell(cell, totalSamples) {
  const weight = Math.max(cell.weight, 0.00001);
  return {
    ...cell,
    hue: cell.weight
      ? (Math.atan2(cell.sin / weight, cell.cos / weight) * 180 / Math.PI + 360) % 360
      : cell.hue,
    chroma: cell.chroma / weight,
    lightness: cell.weight ? cell.lightness / weight : 0.5,
    coverage: cell.weight / Math.max(totalSamples, 1),
  };
}

function analyzeTexture(data, width, height) {
  return analyzeTextureSpectrum(data, width, height);
}

function analyzeSemanticProfiles(data, semanticMasks, maxSamples) {
  if (!semanticMasks?.masks) return null;
  const regions = {};
  Object.entries(semanticMasks.masks).forEach(([id, mask]) => {
    if (!mask || mask.length * 4 !== data.length) return;
    const filtered = new Uint8ClampedArray(data.length);
    let coverage = 0;
    let selected = 0;
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      const weight = clampUnit(mask[pixel]);
      coverage += weight;
      if (weight < 0.24) continue;
      const index = pixel * 4;
      filtered[index] = data[index];
      filtered[index + 1] = data[index + 1];
      filtered[index + 2] = data[index + 2];
      filtered[index + 3] = 255;
      selected += 1;
    }
    const coverageRatio = coverage / Math.max(1, mask.length);
    if (selected < 24 || coverageRatio < 0.0015) return;
    const profile = analyzePixels(filtered, Math.min(maxSamples, 36000));
    regions[id] = {
      ...semanticMasks.regions?.[id],
      id,
      coverage: coverageRatio,
      sampleCount: selected,
      profile,
    };
  });
  return {
    version: semanticMasks.version || 1,
    model: semanticMasks.model || "heuristic",
    confidence: semanticMasks.confidence ?? 0.4,
    regions,
  };
}

export function analyzePixels(data, options = 180000) {
  const maxSamples = typeof options === "number" ? options : options.maxSamples ?? 180000;
  const width = typeof options === "number" ? null : options.width;
  const height = typeof options === "number" ? null : options.height;
  const semanticMasks = typeof options === "number" ? null : options.semanticMasks;
  const skipLighting = typeof options === "number" ? true : options.skipLighting;
  const pixelCount = data.length / 4;
  const sampleStep = Math.max(1, Math.floor(pixelCount / maxSamples));
  const sums = [0, 0, 0];
  const squares = [0, 0, 0];
  const toneCounts = Array(256).fill(0);
  const zones = ZONES.map(emptyZone);
  const colors = HUE_BANDS.map(emptyHueBand);
  const neutralZones = ZONES.map(emptyNeutralZone);
  const colorGrid = ZONES.map((zone) => HUE_BANDS.map((band) => emptyColorCell(zone, band)));
  let saturation = 0;
  let sampled = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += sampleStep) {
    const index = pixel * 4;
    if (data[index + 3] < 16) continue;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const rgb = [red, green, blue];
    const [lightness, a, b] = rgbToOklab(red, green, blue);
    const safeLightness = clampUnit(lightness);
    const chroma = Math.hypot(a, b);
    const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);

    sampled += 1;
    saturation += maximum ? (maximum - minimum) / maximum : 0;
    toneCounts[Math.round(safeLightness * 255)] += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      sums[channel] += rgb[channel];
      squares[channel] += rgb[channel] * rgb[channel];
    }

    const tonalWeights = zoneWeights(safeLightness);
    tonalWeights.forEach((weight, zoneIndex) => {
      const zone = zones[zoneIndex];
      zone.weight += weight;
      zone.lightness += safeLightness * weight;
      zone.a += a * weight;
      zone.b += b * weight;
      zone.chroma += chroma * weight;
    });

    const neutralConfidence = 1 - smoothstep(0.012, 0.055, chroma);
    if (neutralConfidence > 0.001 && safeLightness > 0.04 && safeLightness < 0.96) {
      tonalWeights.forEach((toneWeight, zoneIndex) => {
        const weight = toneWeight * neutralConfidence;
        const neutral = neutralZones[zoneIndex];
        neutral.weight += weight;
        neutral.a += a * weight;
        neutral.b += b * weight;
      });
    }

    if (chroma > 0.008 && safeLightness > 0.025 && safeLightness < 0.985) {
      const chromaConfidence = smoothstep(0.008, 0.07, chroma);
      const chromaticWeights = hueWeights(hue);
      chromaticWeights.forEach((baseWeight, colorIndex) => {
        const weight = baseWeight * chromaConfidence;
        const color = colors[colorIndex];
        color.weight += weight;
        color.chroma += chroma * weight;
        color.lightness += safeLightness * weight;
        color.sin += Math.sin(hue * Math.PI / 180) * weight;
        color.cos += Math.cos(hue * Math.PI / 180) * weight;
      });
      tonalWeights.forEach((toneWeight, zoneIndex) => {
        chromaticWeights.forEach((hueWeight, colorIndex) => {
          const weight = toneWeight * hueWeight * chromaConfidence;
          const cell = colorGrid[zoneIndex][colorIndex];
          cell.weight += weight;
          cell.chroma += chroma * weight;
          cell.lightness += safeLightness * weight;
          cell.sin += Math.sin(hue * Math.PI / 180) * weight;
          cell.cos += Math.cos(hue * Math.PI / 180) * weight;
        });
      });
    }
  }

  const count = Math.max(sampled, 1);
  const quantileValues = quantilesFromCounts(toneCounts, count);
  const mean = sums.map((sum) => sum / count);
  const std = squares.map((sum, channel) =>
    Math.sqrt(Math.max(1, sum / count - mean[channel] * mean[channel])),
  );

  const profile = {
    version: 3,
    sampleCount: sampled,
    mean,
    std,
    saturation: saturation / count,
    histogram: getHistogram(data),
    tone: {
      percentiles: TONE_PERCENTILES,
      quantiles: quantileValues,
      blackPoint: quantileValues[1],
      shadows: quantileValues[3],
      midtone: quantileValues[5],
      highlights: quantileValues[7],
      whitePoint: quantileValues[9],
      dynamicRange: quantileValues[9] - quantileValues[1],
    },
    zones: zones.map(finalizeZone),
    colors: colors.map((band) => finalizeHueBand(band, count)),
    neutralZones: neutralZones.map((zone) => finalizeNeutralZone(zone, count)),
    colorGrid: colorGrid.map((row) => row.map((cell) => finalizeColorCell(cell, count))),
    texture: analyzeTexture(data, width, height),
  };
  const semantic = analyzeSemanticProfiles(data, semanticMasks, maxSamples);
  if (semantic) profile.semantic = semantic;
  if (width && height && !skipLighting) {
    const lighting = analyzeSceneLighting(data, width, height, semanticMasks);
    if (lighting) {
      const normalized = normalizeFrameLighting(data, width, height, lighting);
      lighting.intrinsic = analyzePixels(normalized, Math.min(maxSamples, 120000));
      profile.lighting = lighting;
    }
  }
  return profile;
}

function robustAverage(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
  return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
}

function circularAverage(items, fallback) {
  let sin = 0;
  let cos = 0;
  let total = 0;
  items.forEach(({ hue, weight }) => {
    sin += Math.sin(hue * Math.PI / 180) * weight;
    cos += Math.cos(hue * Math.PI / 180) * weight;
    total += weight;
  });
  if (!total) return fallback;
  return (Math.atan2(sin / total, cos / total) * 180 / Math.PI + 360) % 360;
}

export function averageProfiles(items) {
  if (!items.length) return null;
  const sourceItems = items;
  const profileWeights = lightingProfileWeights(sourceItems);
  if (items.length >= 3) {
    items = sourceItems.flatMap((item, index) =>
      Array.from({ length: Math.max(1, Math.round(profileWeights[index] * 4)) }, () => item));
  }
  if (!items.every((item) => item?.version >= 2 && item.tone && item.zones && item.colors)) {
    const count = items.length;
    return {
      mean: [0, 1, 2].map((channel) =>
        items.reduce((sum, item) => sum + item.mean[channel], 0) / count,
      ),
      std: [0, 1, 2].map((channel) =>
        items.reduce((sum, item) => sum + item.std[channel], 0) / count,
      ),
      saturation: items.reduce((sum, item) => sum + item.saturation, 0) / count,
    };
  }

  const quantiles = TONE_PERCENTILES.map((_, index) =>
    robustAverage(items.map((item) => item.tone.quantiles[index])),
  );
  const zones = ZONES.map((zone, zoneIndex) => {
    const sourceZones = items.map((item) => item.zones[zoneIndex]);
    const lightness = robustAverage(sourceZones.map((item) => item.lightness));
    const a = robustAverage(sourceZones.map((item) => item.a));
    const b = robustAverage(sourceZones.map((item) => item.b));
    return {
      id: zone.id,
      label: zone.label,
      weight: robustAverage(sourceZones.map((item) => item.weight)),
      lightness,
      a,
      b,
      chroma: robustAverage(sourceZones.map((item) => item.chroma)),
      rgb: oklabToRgb(lightness, a, b).map(Math.round),
    };
  });
  const colors = HUE_BANDS.map((band, colorIndex) => {
    const sourceColors = items.map((item) => item.colors[colorIndex]);
    const weightedHues = sourceColors.map((item) => ({
      hue: item.hue,
      weight: Math.max(0.0001, item.coverage),
    }));
    return {
      ...band,
      hue: circularAverage(weightedHues, band.anchor),
      chroma: robustAverage(sourceColors.map((item) => item.chroma)),
      lightness: robustAverage(sourceColors.map((item) => item.lightness)),
      coverage: robustAverage(sourceColors.map((item) => item.coverage)),
      weight: robustAverage(sourceColors.map((item) => item.weight)),
    };
  });
  const histogram = {};
  ["red", "green", "blue", "master"].forEach((channel) => {
    const length = items[0].histogram[channel].length;
    const values = Array.from({ length }, (_, index) =>
      robustAverage(items.map((item) => item.histogram[channel][index])),
    );
    const peak = Math.max(...values, 1);
    histogram[channel] = values.map((value) => value / peak);
  });

  const isVersion3 = items.every((item) =>
    item.version >= 3 && item.neutralZones && item.colorGrid);
  const profile = {
    version: isVersion3 ? 3 : 2,
    sourceCount: sourceItems.length,
    sampleCount: items.reduce((sum, item) => sum + item.sampleCount, 0),
    mean: [0, 1, 2].map((channel) => robustAverage(items.map((item) => item.mean[channel]))),
    std: [0, 1, 2].map((channel) => robustAverage(items.map((item) => item.std[channel]))),
    saturation: robustAverage(items.map((item) => item.saturation)),
    histogram,
    tone: {
      percentiles: TONE_PERCENTILES,
      quantiles,
      blackPoint: quantiles[1],
      shadows: quantiles[3],
      midtone: quantiles[5],
      highlights: quantiles[7],
      whitePoint: quantiles[9],
      dynamicRange: quantiles[9] - quantiles[1],
    },
    zones,
    colors,
  };
  if (!isVersion3) return profile;

  const neutralZones = ZONES.map((zone, zoneIndex) => {
    const sourceZones = items.map((item) => item.neutralZones[zoneIndex]);
    return {
      id: zone.id,
      label: zone.label,
      weight: robustAverage(sourceZones.map((item) => item.weight)),
      a: robustAverage(sourceZones.map((item) => item.a)),
      b: robustAverage(sourceZones.map((item) => item.b)),
      coverage: robustAverage(sourceZones.map((item) => item.coverage)),
    };
  });
  const colorGrid = ZONES.map((zone, zoneIndex) =>
    HUE_BANDS.map((band, colorIndex) => {
      const cells = items.map((item) => item.colorGrid[zoneIndex][colorIndex]);
      return {
        zone: zone.id,
        id: band.id,
        hue: circularAverage(
          cells.map((cell) => ({
            hue: cell.hue,
            weight: Math.max(0.0001, cell.coverage),
          })),
          band.anchor,
        ),
        chroma: robustAverage(cells.map((cell) => cell.chroma)),
        lightness: robustAverage(cells.map((cell) => cell.lightness)),
        coverage: robustAverage(cells.map((cell) => cell.coverage)),
        weight: robustAverage(cells.map((cell) => cell.weight)),
      };
    }));
  const textureItems = items.map((item) => item.texture).filter(Boolean);
  const texture = textureItems.length
    ? {
      version: 2,
      microContrast: robustAverage(textureItems.map((item) => item.microContrast)),
      edgeP95: robustAverage(textureItems.map((item) => item.edgeP95)),
      acutance: robustAverage(textureItems.map((item) => item.acutance)),
      scales: [1, 2, 4, 8],
      spectrum: [0, 1, 2, 3].map((index) =>
        robustAverage(textureItems.map((item) => item.spectrum?.[index] ?? 0))),
      edgeOvershoot: robustAverage(textureItems.map((item) => item.edgeOvershoot ?? 0)),
      smear: robustAverage(textureItems.map((item) => item.smear ?? 0)),
      noise: {
        luma: [0, 1, 2].map((index) =>
          robustAverage(textureItems.map((item) => item.noise?.luma?.[index] ?? 0))),
        color: [0, 1, 2].map((index) =>
          robustAverage(textureItems.map((item) => item.noise?.color?.[index] ?? 0))),
      },
    }
    : null;
  const shoulderWidth = Math.max(1, quantiles[9] - quantiles[7]);
  const highlightRolloff = (quantiles[9] - quantiles[8]) / shoulderWidth;
  const result = {
    ...profile,
    neutralZones,
    colorGrid,
    texture,
    renderIntent: {
      highlightRolloff,
      shadowDensity: quantiles[3] / Math.max(1, quantiles[5]),
      neutralCoolness: -robustAverage(neutralZones.map((zone) => zone.b)),
      chromaRestraint: 1 - clampUnit(profile.saturation),
    },
  };
  const lighting = averageLightingProfiles(sourceItems, profileWeights);
  if (lighting) {
    const intrinsicItems = sourceItems
      .map((item) => item.lighting?.intrinsic)
      .filter(Boolean);
    if (intrinsicItems.length === sourceItems.length) {
      lighting.intrinsic = averageProfiles(intrinsicItems);
    }
    result.lighting = lighting;
    result.referenceWeights = profileWeights;
  }
  const semanticItems = items.map((item) => item.semantic).filter(Boolean);
  if (semanticItems.length) {
    const regionIds = [...new Set(
      semanticItems.flatMap((item) => Object.keys(item.regions || {})),
    )];
    const regions = {};
    regionIds.forEach((id) => {
      const available = items
        .map((item) => item.semantic?.regions?.[id])
        .filter((region) => region?.profile);
      if (!available.length) return;
      regions[id] = {
        id,
        label: available.find((region) => region.label)?.label || id,
        color: available.find((region) => region.color)?.color,
        coverage: robustAverage(available.map((region) => region.coverage)),
        confidence: robustAverage(available.map((region) => region.confidence ?? 0.5)),
        sampleCount: available.reduce((sum, region) => sum + region.sampleCount, 0),
        profile: averageProfiles(available.map((region) => region.profile)),
      };
    });
    result.semantic = {
      version: 1,
      model: semanticItems.every((item) => item.model === "mediapipe-local")
        ? "mediapipe-local"
        : "heuristic",
      confidence: robustAverage(semanticItems.map((item) => item.confidence)),
      regions,
    };
  }
  return result;
}

function monotoneToneMap(sourceValues, targetValues) {
  const points = [];
  sourceValues.forEach((source, index) => {
    const x = Math.round(clampByte(source));
    const y = Math.round(clampByte(targetValues[index]));
    const previous = points.at(-1);
    if (previous?.x === x) previous.y = Math.max(previous.y, y);
    else points.push({ x, y });
  });
  if (points[0]?.x !== 0) points.unshift({ x: 0, y: 0 });
  if (points.at(-1)?.x !== 255) points.push({ x: 255, y: 255 });
  for (let index = 1; index < points.length; index += 1) {
    points[index].y = Math.max(points[index - 1].y, points[index].y);
  }

  const widths = points.slice(0, -1).map((point, index) =>
    Math.max(1, points[index + 1].x - point.x));
  const slopes = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    return (next.y - point.y) / widths[index];
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes.at(-1);
    const previousSlope = slopes[index - 1];
    const nextSlope = slopes[index];
    if (previousSlope <= 0 || nextSlope <= 0) return 0;
    const previousWidth = widths[index - 1];
    const nextWidth = widths[index];
    const previousWeight = 2 * nextWidth + previousWidth;
    const nextWeight = nextWidth + 2 * previousWidth;
    return (previousWeight + nextWeight)
      / (previousWeight / previousSlope + nextWeight / nextSlope);
  });
  slopes.forEach((slope, index) => {
    if (slope <= 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      return;
    }
    const alpha = tangents[index] / slope;
    const beta = tangents[index + 1] / slope;
    const magnitude = Math.hypot(alpha, beta);
    if (magnitude <= 3) return;
    const scale = 3 / magnitude;
    tangents[index] = scale * alpha * slope;
    tangents[index + 1] = scale * beta * slope;
  });

  return (x) => {
    let segment = 0;
    while (segment < points.length - 2 && x > points[segment + 1].x) segment += 1;
    const start = points[segment];
    const end = points[segment + 1];
    const width = Math.max(1, end.x - start.x);
    const t = clampUnit((x - start.x) / width);
    const t2 = t * t;
    const t3 = t2 * t;
    const value = (2 * t3 - 3 * t2 + 1) * start.y
      + (t3 - 2 * t2 + t) * width * tangents[segment]
      + (-2 * t3 + 3 * t2) * end.y
      + (t3 - t2) * width * tangents[segment + 1];
    return clampByte(value);
  };
}

export function createToneLut(source, reference, strength = 1) {
  const sourceValues = source?.tone?.quantiles;
  const targetValues = reference?.tone?.quantiles;
  if (!sourceValues || !targetValues) {
    return Uint8Array.from({ length: 256 }, (_, value) => value);
  }
  const map = monotoneToneMap(sourceValues, targetValues);
  const lut = new Uint8Array(256);
  let previous = 0;
  for (let value = 0; value < 256; value += 1) {
    const blended = value + (map(value) - value) * clampUnit(strength);
    previous = Math.max(previous, Math.round(clampByte(blended)));
    lut[value] = previous;
  }
  return lut;
}

export function createToneLutV3(source, reference, strength) {
  const sourceValues = source?.tone?.quantiles;
  const targetValues = reference?.tone?.quantiles;
  if (!sourceValues || !targetValues) {
    return Float32Array.from({ length: 1024 }, (_, value) => value / 1023);
  }
  const map = monotoneToneMap(sourceValues, targetValues);
  const lut = new Float32Array(1024);
  const sourceRange = Math.max(
    0.04,
    ((sourceValues[9] ?? 255) - (sourceValues[1] ?? 0)) / 255,
  );
  const targetRange = Math.max(
    0.04,
    ((targetValues[9] ?? 255) - (targetValues[1] ?? 0)) / 255,
  );
  const rangeCompression = clampUnit((sourceRange - targetRange) / sourceRange);
  const targetMidtone = (targetValues[5] ?? 128) / 255;
  const sourceMidtone = (sourceValues[5] ?? 128) / 255;
  const midtoneDistance = Math.abs(targetMidtone - sourceMidtone);
  let previous = 0;
  for (let value = 0; value < 1024; value += 1) {
    const input = value / 1023;
    const mapped = map(input * 255) / 255;
    // V4.2 makes the guard adaptive. A genuinely compressed reference is
    // allowed to lift the toe and bend the shoulder substantially, while the
    // final few code values stay anchored so specular detail cannot turn into
    // a flat grey ceiling.
    const endpointProtection = smoothstep(0.0015, 0.018, input)
      * (1 - smoothstep(0.996, 1, input));
    const midtoneWeight = 1 - Math.min(1, Math.abs(input - 0.5) * 2);
    const highlightWeight = smoothstep(0.72, 0.985, input);
    const shadowWeight = 1 - smoothstep(0.025, 0.34, input);
    const adaptiveLatitude = rangeCompression * (0.29 + midtoneDistance * 0.16);
    const maximumLift = 0.037
      + midtoneWeight * 0.048
      + adaptiveLatitude * (0.72 + shadowWeight * 0.38);
    const maximumDrop = 0.043
      + midtoneWeight * 0.052
      + adaptiveLatitude * (0.76 + highlightWeight * 0.42);
    const shift = mapped - input;
    const guardedMapped = input + Math.max(
      -maximumDrop,
      Math.min(maximumLift, shift),
    );
    const shoulderBlend = 1 - smoothstep(0.996, 1, input);
    const adjusted = input + (guardedMapped - input)
      * strength
      * Math.max(endpointProtection, shoulderBlend * 0.12);
    previous = Math.max(previous, clampUnit(adjusted));
    lut[value] = previous;
  }
  lut[0] = 0;
  lut[lut.length - 1] = 1;
  return lut;
}

function buildVersion3Lookups(source, reference) {
  const toneBins = 64;
  const hueBins = 72;
  const neutralA = new Float32Array(toneBins);
  const neutralB = new Float32Array(toneBins);
  const zoneA = new Float32Array(toneBins);
  const zoneB = new Float32Array(toneBins);
  const hueShift = new Float32Array(toneBins * hueBins);
  const logChroma = new Float32Array(toneBins * hueBins);
  const lightnessShift = new Float32Array(toneBins * hueBins);
  const gridEvidence = new Float32Array(toneBins * hueBins);
  const abHueShift = new Float32Array(hueBins);
  const abLogChroma = new Float32Array(hueBins);

  const neutralDeltas = source.neutralZones.map((zone, index) => {
    const target = reference.neutralZones[index];
    const evidence = Math.min(zone.coverage, target.coverage);
    return {
      a: Math.max(-0.035, Math.min(0.035, target.a - zone.a)),
      b: Math.max(-0.035, Math.min(0.035, target.b - zone.b)),
      confidence: smoothstep(0.002, 0.06, evidence),
    };
  });
  const zoneDeltas = source.zones.map((zone, index) => ({
    a: Math.max(-0.055, Math.min(0.055, reference.zones[index].a - zone.a)),
    b: Math.max(-0.055, Math.min(0.055, reference.zones[index].b - zone.b)),
  }));
  const globalChromaRatio = Math.max(
    0.56,
    Math.min(1.7, reference.saturation / Math.max(0.025, source.saturation)),
  );
  const gridDeltas = source.colorGrid.map((row, zoneIndex) =>
    row.map((cell, colorIndex) => {
      const target = reference.colorGrid[zoneIndex][colorIndex];
      const evidence = Math.min(cell.coverage, target.coverage);
      return {
        hue: Math.max(-24, Math.min(24, circularDelta(target.hue, cell.hue))),
        // Global colorfulness remains a base layer. The hue/saturation plane
        // is then handled separately from the tone-dependent color residual.
        chroma: Math.max(
          0.72,
          Math.min(
            1.42,
            target.chroma / Math.max(0.014, cell.chroma) / globalChromaRatio,
          ),
        ),
        lightness: Math.max(-0.06, Math.min(0.06, target.lightness - cell.lightness)),
        confidence: smoothstep(0.0002, 0.012, evidence),
      };
    }));

  for (let toneIndex = 0; toneIndex < toneBins; toneIndex += 1) {
    const tone = toneIndex / (toneBins - 1);
    const tonalWeights = zoneWeights(tone);
    tonalWeights.forEach((weight, zoneIndex) => {
      const neutral = neutralDeltas[zoneIndex];
      neutralA[toneIndex] += neutral.a * neutral.confidence * weight;
      neutralB[toneIndex] += neutral.b * neutral.confidence * weight;
      zoneA[toneIndex] += zoneDeltas[zoneIndex].a * weight;
      zoneB[toneIndex] += zoneDeltas[zoneIndex].b * weight;
    });
    for (let hueIndex = 0; hueIndex < hueBins; hueIndex += 1) {
      const hue = hueIndex / hueBins * 360;
      const chromaticWeights = hueWeights(hue);
      let hueTotal = 0;
      let chromaTotal = 0;
      let lightnessTotal = 0;
      let evidence = 0;
      tonalWeights.forEach((toneWeight, zoneIndex) => {
        chromaticWeights.forEach((hueWeight, colorIndex) => {
          const delta = gridDeltas[zoneIndex][colorIndex];
          const reliableWeight = toneWeight * hueWeight * delta.confidence;
          hueTotal += delta.hue * reliableWeight;
          chromaTotal += Math.log(delta.chroma) * reliableWeight;
          lightnessTotal += delta.lightness * reliableWeight;
          evidence += reliableWeight;
        });
      });
      const index = toneIndex * hueBins + hueIndex;
      if (evidence > 0.0001) {
        hueShift[index] = hueTotal / evidence;
        logChroma[index] = chromaTotal / evidence;
        lightnessShift[index] = lightnessTotal / evidence;
        gridEvidence[index] = evidence;
      }
    }
  }
  // Keep the A/B color plane independent from brightness, then leave the
  // remaining per-tone response to the C/L plane. This mirrors a professional
  // LUT workflow: hue and saturation stay smooth across luminance, while a
  // color's shadow/highlight behavior is still free to differ.
  for (let hueIndex = 0; hueIndex < hueBins; hueIndex += 1) {
    let hueTotal = 0;
    let chromaTotal = 0;
    let evidence = 0;
    for (let toneIndex = 0; toneIndex < toneBins; toneIndex += 1) {
      const index = toneIndex * hueBins + hueIndex;
      const weight = gridEvidence[index];
      hueTotal += hueShift[index] * weight;
      chromaTotal += logChroma[index] * weight;
      evidence += weight;
    }
    if (evidence > 0.0001) {
      abHueShift[hueIndex] = hueTotal / evidence;
      abLogChroma[hueIndex] = chromaTotal / evidence;
    }
  }
  for (let toneIndex = 0; toneIndex < toneBins; toneIndex += 1) {
    for (let hueIndex = 0; hueIndex < hueBins; hueIndex += 1) {
      const index = toneIndex * hueBins + hueIndex;
      hueShift[index] -= abHueShift[hueIndex];
      logChroma[index] -= abLogChroma[hueIndex];
    }
  }
  return {
    toneBins,
    hueBins,
    neutralA,
    neutralB,
    zoneA,
    zoneB,
    hueShift,
    logChroma,
    lightnessShift,
    abHueShift,
    abLogChroma,
    globalChromaRatio,
  };
}

function sampleHueLookup(values, hue, hueBins) {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const position = normalizedHue / 360 * hueBins;
  const lower = Math.floor(position) % hueBins;
  const upper = (lower + 1) % hueBins;
  const amount = position - Math.floor(position);
  return values[lower] + (values[upper] - values[lower]) * amount;
}

function sampleToneHueLookup(values, tone, hue, toneBins, hueBins) {
  const tonePosition = clampUnit(tone) * (toneBins - 1);
  const lowerTone = Math.floor(tonePosition);
  const upperTone = Math.min(toneBins - 1, lowerTone + 1);
  const toneAmount = tonePosition - lowerTone;
  const normalizedHue = ((hue % 360) + 360) % 360;
  const huePosition = normalizedHue / 360 * hueBins;
  const lowerHue = Math.floor(huePosition) % hueBins;
  const upperHue = (lowerHue + 1) % hueBins;
  const hueAmount = huePosition - Math.floor(huePosition);
  const lowerStart = lowerTone * hueBins;
  const upperStart = upperTone * hueBins;
  const lower = values[lowerStart + lowerHue]
    + (values[lowerStart + upperHue] - values[lowerStart + lowerHue]) * hueAmount;
  const upper = values[upperStart + lowerHue]
    + (values[upperStart + upperHue] - values[upperStart + lowerHue]) * hueAmount;
  return lower + (upper - lower) * toneAmount;
}

const SEMANTIC_PRIORITY = [
  "skin",
  "hair",
  "clothing",
  "sky",
  "foliage",
  "neutral",
  "specular",
  "person",
];

function buildSemanticLookups(source, reference) {
  const sourceRegions = source?.semantic?.regions;
  const referenceRegions = reference?.semantic?.regions;
  if (!sourceRegions || !referenceRegions) return [];
  const reliablePortraitMasks = source.semantic.model === "mediapipe-local"
    && reference.semantic.model === "mediapipe-local";
  return SEMANTIC_PRIORITY.flatMap((id) => {
    if (
      ["skin", "person", "hair", "clothing"].includes(id)
      && !reliablePortraitMasks
    ) return [];
    const sourceRegion = sourceRegions[id];
    const referenceRegion = referenceRegions[id];
    if (
      !sourceRegion?.profile?.colorGrid
      || !referenceRegion?.profile?.colorGrid
      || sourceRegion.coverage < 0.0015
      || referenceRegion.coverage < 0.0015
    ) return [];
    const evidence = smoothstep(
      0.0015,
      0.065,
      Math.min(sourceRegion.coverage, referenceRegion.coverage),
    );
    return [{
      id,
      confidence: evidence
        * Math.min(
          sourceRegion.confidence ?? 0.7,
          referenceRegion.confidence ?? 0.7,
        ),
      lookups: buildVersion3Lookups(sourceRegion.profile, referenceRegion.profile),
      toneLut: createToneLutV3(sourceRegion.profile, referenceRegion.profile, 1),
    }];
  });
}

function strongestSemanticRegion(
  semanticLookups,
  semanticMasks,
  pixel,
  targetWidth = semanticMasks?.width,
  targetHeight = semanticMasks?.height,
) {
  if (!semanticLookups.length || !semanticMasks?.masks) return null;
  let selected = null;
  let bestWeight = 0.16;
  semanticLookups.forEach((entry) => {
    const mask = semanticMasks.masks[entry.id];
    let maskPixel = pixel;
    if (
      mask
      && targetWidth
      && targetHeight
      && semanticMasks.width
      && semanticMasks.height
      && mask.length !== targetWidth * targetHeight
    ) {
      const x = pixel % targetWidth;
      const y = Math.floor(pixel / targetWidth);
      const sourceX = Math.min(
        semanticMasks.width - 1,
        Math.floor(x / targetWidth * semanticMasks.width),
      );
      const sourceY = Math.min(
        semanticMasks.height - 1,
        Math.floor(y / targetHeight * semanticMasks.height),
      );
      maskPixel = sourceY * semanticMasks.width + sourceX;
    }
    const maskWeight = mask?.[maskPixel] || 0;
    const priorityBoost = entry.id === "skin" ? 1.18 : entry.id === "person" ? 0.72 : 1;
    const weight = maskWeight * priorityBoost * entry.confidence;
    if (weight > bestWeight) {
      selected = { ...entry, maskWeight: clampUnit(maskWeight) };
      bestWeight = weight;
    }
  });
  return selected;
}

function oklabToLinearRgb(lightness, a, b) {
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function gamutMappedOklabToRgb(lightness, a, b) {
  const inGamut = (channels) => channels.every((value) => value >= 0 && value <= 1);
  if (inGamut(oklabToLinearRgb(lightness, a, b))) {
    return oklabToRgb(lightness, a, b);
  }
  const chroma = Math.hypot(a, b);
  if (chroma < 0.00001) return oklabToRgb(lightness, 0, 0);
  const hueA = a / chroma;
  const hueB = b / chroma;
  let lower = 0;
  let upper = chroma;
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const middle = (lower + upper) * 0.5;
    if (inGamut(oklabToLinearRgb(lightness, hueA * middle, hueB * middle))) lower = middle;
    else upper = middle;
  }
  return oklabToRgb(lightness, hueA * lower, hueB * lower);
}

function applyTextureProfile(data, width, height, source, reference, strength) {
  if (!width || !height || !source?.texture || !reference?.texture) return;
  const microRatio = reference.texture.microContrast
    / Math.max(0.0005, source.texture.microContrast);
  const edgeRatio = reference.texture.edgeP95 / Math.max(0.001, source.texture.edgeP95);
  const microAdjustment = Math.max(-0.24, Math.min(0.18, (microRatio - 1) * strength * 0.55));
  const edgeAdjustment = Math.max(-0.16, Math.min(0.12, (edgeRatio - 1) * strength * 0.25));
  if (Math.abs(microAdjustment) + Math.abs(edgeAdjustment) < 0.012) return;

  const lightness = new Float32Array(width * height);
  for (let pixel = 0; pixel < lightness.length; pixel += 1) {
    const index = pixel * 4;
    lightness[pixel] = (
      data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722
    ) / 255;
  }
  const macroRadius = Math.max(2, Math.round(Math.min(width, height) / 420));
  for (let y = macroRadius; y < height - macroRadius; y += 1) {
    for (let x = macroRadius; x < width - macroRadius; x += 1) {
      const pixel = y * width + x;
      const center = lightness[pixel];
      const microBlur = (
        lightness[pixel - 1]
        + lightness[pixel + 1]
        + lightness[pixel - width]
        + lightness[pixel + width]
      ) * 0.25;
      const macroBlur = (
        lightness[pixel - macroRadius]
        + lightness[pixel + macroRadius]
        + lightness[pixel - macroRadius * width]
        + lightness[pixel + macroRadius * width]
      ) * 0.25;
      const midtoneWeight = smoothstep(0.03, 0.2, center)
        * (1 - smoothstep(0.82, 0.98, center));
      const detail = (
        (center - microBlur) * microAdjustment
        + (center - macroBlur) * edgeAdjustment
      ) * midtoneWeight * 255;
      const index = pixel * 4;
      data[index] = clampByte(data[index] + detail);
      data[index + 1] = clampByte(data[index + 1] + detail);
      data[index + 2] = clampByte(data[index + 2] + detail);
    }
  }
}

function legacyTransfer(rgb, source, reference, strength) {
  return rgb.map((value, channel) => {
    const transferred = ((value - source.mean[channel]) / Math.max(8, source.std[channel]))
      * reference.std[channel] + reference.mean[channel];
    return value + (transferred - value) * strength;
  });
}

export function applyStyleProfile(
  data,
  source,
  reference,
  settings,
  curveLuts,
  dimensions = null,
) {
  const strength = clampUnit(settings.strength / 100);
  const lightingAware = Number.isFinite(settings.referenceLighting)
    && source?.lighting?.intrinsic
    && reference?.lighting?.intrinsic;
  const styleSource = lightingAware ? source.lighting.intrinsic : source;
  const styleReference = lightingAware ? reference.lighting.intrinsic : reference;
  const blendedLighting = lightingAware
    ? blendSceneLighting(
      source.lighting,
      reference.lighting,
      settings.referenceLighting / 100,
    )
    : null;
  const advanced = styleSource?.version >= 2 && styleReference?.version >= 2;
  const version3 = styleSource?.version >= 3
    && styleReference?.version >= 3
    && styleSource.neutralZones
    && styleReference.neutralZones
    && styleSource.colorGrid
    && styleReference.colorGrid;
  const toneLut = version3
    ? createToneLutV3(styleSource, styleReference, strength)
    : createToneLut(styleSource, styleReference, strength);
  const version3Lookups = version3
    ? buildVersion3Lookups(styleSource, styleReference)
    : null;
  const semanticLookups = version3 ? buildSemanticLookups(source, reference) : [];
  const zoneDeltas = advanced && !version3
    ? styleSource.zones.map((zone, index) => ({
      a: Math.max(-0.075, Math.min(0.075, styleReference.zones[index].a - zone.a)),
      b: Math.max(-0.075, Math.min(0.075, styleReference.zones[index].b - zone.b)),
    }))
    : [];
  const colorDeltas = advanced && !version3
    ? styleSource.colors.map((color, index) => {
      const target = styleReference.colors[index];
      const evidence = Math.min(color.coverage, target.coverage);
      return {
        hue: Math.max(-28, Math.min(28, circularDelta(target.hue, color.hue))),
        chroma: Math.max(0.6, Math.min(1.75, target.chroma / Math.max(0.018, color.chroma))),
        lightness: Math.max(-0.08, Math.min(0.08, target.lightness - color.lightness)),
        confidence: smoothstep(0.0005, 0.018, evidence),
      };
    })
    : [];
  const contrastFactor = (259 * (settings.contrast + 255)) / (255 * (259 - settings.contrast));
  const saturationFactor = 1 + settings.saturation / 100;
  const [masterLut, redLut, greenLut, blueLut] = curveLuts;
  const colorLuts = [redLut, greenLut, blueLut];

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 16) continue;
    const originalRgb = [data[index], data[index + 1], data[index + 2]];
    const pixel = index / 4;
    const positionX = dimensions?.samplePosition?.[0] ?? (dimensions?.width
      ? (pixel % dimensions.width) / Math.max(1, dimensions.width - 1)
      : 0.5);
    const positionY = dimensions?.samplePosition?.[1] ?? (dimensions?.width && dimensions?.height
      ? Math.floor(pixel / dimensions.width) / Math.max(1, dimensions.height - 1)
      : 0.5);
    const workingRgb = lightingAware
      ? normalizeRgbForLighting(originalRgb, source.lighting, positionX, positionY)
      : originalRgb;
    let mapped;

    if (version3) {
      let [lightness, a, b] = rgbToOklab(...workingRgb);
      const originalLightness = clampUnit(lightness);
      const toneIndex = Math.min(
        version3Lookups.toneBins - 1,
        Math.round(originalLightness * (version3Lookups.toneBins - 1)),
      );
      lightness = toneLut[Math.round(originalLightness * 1023)];

      let chroma = Math.hypot(a, b);
      let hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
      const originalHue = hue;
      const neutralConfidence = 1 - smoothstep(0.018, 0.08, chroma);
      a += (
        version3Lookups.neutralA[toneIndex] * neutralConfidence
        + version3Lookups.zoneA[toneIndex] * 0.18
      ) * strength;
      b += (
        version3Lookups.neutralB[toneIndex] * neutralConfidence
        + version3Lookups.zoneB[toneIndex] * 0.18
      ) * strength;

      chroma = Math.hypot(a, b);
      hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
      if (chroma > 0.007) {
        const lookupHue = hue;
        const colorfulnessWeight = smoothstep(0.006, 0.095, chroma);
        const globalRatio = version3Lookups.globalChromaRatio || 1;
        chroma *= Math.exp(
          Math.log(globalRatio)
          * strength
          * colorfulnessWeight
          * 0.94,
        );
        let hueShift = sampleHueLookup(
          version3Lookups.abHueShift,
          lookupHue,
          version3Lookups.hueBins,
        ) + sampleToneHueLookup(
          version3Lookups.hueShift,
          originalLightness,
          lookupHue,
          version3Lookups.toneBins,
          version3Lookups.hueBins,
        );
        let logChroma = sampleHueLookup(
          version3Lookups.abLogChroma,
          lookupHue,
          version3Lookups.hueBins,
        ) + sampleToneHueLookup(
          version3Lookups.logChroma,
          originalLightness,
          lookupHue,
          version3Lookups.toneBins,
          version3Lookups.hueBins,
        );
        const skinLike = hue >= 20
          && hue <= 75
          && originalLightness >= 0.38
          && originalLightness <= 0.92
          && chroma >= 0.015
          && chroma <= 0.2;
        if (skinLike) {
          hueShift = Math.max(-12, Math.min(12, hueShift));
          logChroma = Math.max(Math.log(0.75), Math.min(Math.log(1.3), logChroma));
        }
        hue += hueShift * strength * 0.88;
        chroma *= Math.exp(logChroma * strength * 0.76);
        lightness += sampleToneHueLookup(
          version3Lookups.lightnessShift,
          originalLightness,
          lookupHue,
          version3Lookups.toneBins,
          version3Lookups.hueBins,
        ) * strength * 0.34;
        chroma = Math.min(0.36, chroma);
        a = Math.cos(hue * Math.PI / 180) * chroma;
        b = Math.sin(hue * Math.PI / 180) * chroma;
      }
      const semantic = strongestSemanticRegion(
        semanticLookups,
        dimensions?.semanticMasks,
        index / 4,
        dimensions?.width,
        dimensions?.height,
      );
      if (semantic) {
        const lookup = semantic.lookups;
        const factor = semantic.maskWeight * semantic.confidence * strength * 0.64;
        const semanticTone = semantic.toneLut[Math.round(originalLightness * 1023)];
        const semanticToneIndex = Math.min(
          lookup.toneBins - 1,
          Math.round(originalLightness * (lookup.toneBins - 1)),
        );
        lightness += (semanticTone - lightness) * factor * 0.34;
        a += (
          lookup.neutralA[semanticToneIndex]
          + lookup.zoneA[semanticToneIndex] * 0.12
        ) * factor;
        b += (
          lookup.neutralB[semanticToneIndex]
          + lookup.zoneB[semanticToneIndex] * 0.12
        ) * factor;
        chroma = Math.hypot(a, b);
        hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
        const semanticLookupHue = hue;
        const hueLimit = semantic.id === "skin" ? 10 : 18;
        const hueShift = Math.max(
          -hueLimit,
          Math.min(
            hueLimit,
            sampleHueLookup(lookup.abHueShift, semanticLookupHue, lookup.hueBins)
              + sampleToneHueLookup(
                lookup.hueShift,
                originalLightness,
                semanticLookupHue,
                lookup.toneBins,
                lookup.hueBins,
              ),
          ),
        );
        const logChroma = Math.max(
          Math.log(0.72),
          Math.min(
            Math.log(1.38),
            sampleHueLookup(lookup.abLogChroma, semanticLookupHue, lookup.hueBins)
              + sampleToneHueLookup(
                lookup.logChroma,
                originalLightness,
                semanticLookupHue,
                lookup.toneBins,
                lookup.hueBins,
              ),
          ),
        );
        hue += hueShift * factor;
        chroma *= Math.exp(logChroma * factor);
        lightness += sampleToneHueLookup(
          lookup.lightnessShift,
          originalLightness,
          semanticLookupHue,
          lookup.toneBins,
          lookup.hueBins,
        ) * factor * 0.16;
        a = Math.cos(hue * Math.PI / 180) * Math.min(0.36, chroma);
        b = Math.sin(hue * Math.PI / 180) * Math.min(0.36, chroma);
      }
      mapped = gamutMappedOklabToRgb(clampUnit(lightness), a, b);
    } else if (advanced) {
      let [lightness, a, b] = rgbToOklab(...workingRgb);
      const originalLightness = clampUnit(lightness);
      lightness = toneLut[Math.round(originalLightness * 255)] / 255;

      const tonalWeights = zoneWeights(originalLightness);
      tonalWeights.forEach((weight, zoneIndex) => {
        a += zoneDeltas[zoneIndex].a * weight * strength * 0.72;
        b += zoneDeltas[zoneIndex].b * weight * strength * 0.72;
      });

      let chroma = Math.hypot(a, b);
      let hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
      if (chroma > 0.007) {
        const weights = hueWeights(hue);
        let hueShift = 0;
        let logChroma = 0;
        let lightnessShift = 0;
        let evidence = 0;
        weights.forEach((weight, colorIndex) => {
          const delta = colorDeltas[colorIndex];
          const reliableWeight = weight * delta.confidence;
          hueShift += delta.hue * reliableWeight;
          logChroma += Math.log(delta.chroma) * reliableWeight;
          lightnessShift += delta.lightness * reliableWeight;
          evidence += reliableWeight;
        });
        if (evidence > 0.0001) {
          hue += (hueShift / evidence) * strength * 0.74;
          chroma *= Math.exp((logChroma / evidence) * strength * 0.82);
          lightness += (lightnessShift / evidence) * strength * 0.16;
        }
        chroma = Math.min(0.36, chroma);
        a = Math.cos(hue * Math.PI / 180) * chroma;
        b = Math.sin(hue * Math.PI / 180) * chroma;
      }
      mapped = oklabToRgb(clampUnit(lightness), a, b);
    } else {
      mapped = legacyTransfer(workingRgb, styleSource, styleReference, strength);
    }
    if (lightingAware) {
      mapped = applySceneLighting(mapped, blendedLighting, positionX, positionY);
    }

    mapped[0] += settings.temperature * 0.55;
    mapped[2] -= settings.temperature * 0.55;
    const luminance = mapped[0] * 0.299 + mapped[1] * 0.587 + mapped[2] * 0.114;
    let hash = (index / 4) ^ 0x9e3779b9;
    hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
    hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
    hash ^= hash >>> 15;
    const midtoneWeight = 0.35 + 0.65 * (1 - Math.abs(luminance - 128) / 128);
    const noise = (((hash >>> 0) / 4294967295) - 0.5)
      * settings.grain * 2 * midtoneWeight;

    for (let channel = 0; channel < 3; channel += 1) {
      const saturated = luminance + (mapped[channel] - luminance) * saturationFactor;
      const adjusted = clampByte(contrastFactor * (saturated - 128) + 128 + noise);
      data[index + channel] = colorLuts[channel][masterLut[Math.round(adjusted)]];
    }
  }

  if (version3 && dimensions && !dimensions.skipTexture) {
    applyTextureProfile(
      data,
      dimensions.width,
      dimensions.height,
      source,
      reference,
      strength,
    );
  }
}

function rgbToHex(rgb) {
  return `#${rgb.map((value) => Math.round(clampByte(value)).toString(16).padStart(2, "0")).join("")}`;
}

export function makePalette(profile) {
  if (!profile) return ["#292b2f", "#53565c", "#888b90", "#b8b9bc", "#e2e2e4"];
  if (profile.version >= 2 && profile.zones) {
    const [shadow, midtone, highlight] = profile.zones.map((zone) => zone.rgb);
    const mix = (first, second) => first.map((value, index) => (value + second[index]) / 2);
    return [shadow, mix(shadow, midtone), midtone, mix(midtone, highlight), highlight].map(rgbToHex);
  }
  return [-0.85, -0.35, 0, 0.4, 0.8].map((factor) =>
    rgbToHex(profile.mean.map((value, channel) => value + profile.std[channel] * factor)),
  );
}
