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

export function analyzePixels(data, maxSamples = 180000) {
  const pixelCount = data.length / 4;
  const sampleStep = Math.max(1, Math.floor(pixelCount / maxSamples));
  const sums = [0, 0, 0];
  const squares = [0, 0, 0];
  const toneCounts = Array(256).fill(0);
  const zones = ZONES.map(emptyZone);
  const colors = HUE_BANDS.map(emptyHueBand);
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

    zoneWeights(safeLightness).forEach((weight, zoneIndex) => {
      const zone = zones[zoneIndex];
      zone.weight += weight;
      zone.lightness += safeLightness * weight;
      zone.a += a * weight;
      zone.b += b * weight;
      zone.chroma += chroma * weight;
    });

    if (chroma > 0.008 && safeLightness > 0.025 && safeLightness < 0.985) {
      const chromaConfidence = smoothstep(0.008, 0.07, chroma);
      hueWeights(hue).forEach((baseWeight, colorIndex) => {
        const weight = baseWeight * chromaConfidence;
        const color = colors[colorIndex];
        color.weight += weight;
        color.chroma += chroma * weight;
        color.lightness += safeLightness * weight;
        color.sin += Math.sin(hue * Math.PI / 180) * weight;
        color.cos += Math.cos(hue * Math.PI / 180) * weight;
      });
    }
  }

  const count = Math.max(sampled, 1);
  const quantileValues = quantilesFromCounts(toneCounts, count);
  const mean = sums.map((sum) => sum / count);
  const std = squares.map((sum, channel) =>
    Math.sqrt(Math.max(1, sum / count - mean[channel] * mean[channel])),
  );

  return {
    version: 2,
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
  };
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

  return {
    version: 2,
    sourceCount: items.length,
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

  const slopes = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    return (next.y - point.y) / Math.max(1, next.x - point.x);
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes.at(-1);
    if (slopes[index - 1] * slopes[index] <= 0) return 0;
    return (slopes[index - 1] + slopes[index]) / 2;
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

function legacyTransfer(rgb, source, reference, strength) {
  return rgb.map((value, channel) => {
    const transferred = ((value - source.mean[channel]) / Math.max(8, source.std[channel]))
      * reference.std[channel] + reference.mean[channel];
    return value + (transferred - value) * strength;
  });
}

export function applyStyleProfile(data, source, reference, settings, curveLuts) {
  const strength = clampUnit(settings.strength / 100);
  const advanced = source?.version >= 2 && reference?.version >= 2;
  const toneLut = createToneLut(source, reference, strength);
  const zoneDeltas = advanced
    ? source.zones.map((zone, index) => ({
      a: Math.max(-0.075, Math.min(0.075, reference.zones[index].a - zone.a)),
      b: Math.max(-0.075, Math.min(0.075, reference.zones[index].b - zone.b)),
    }))
    : [];
  const colorDeltas = advanced
    ? source.colors.map((color, index) => {
      const target = reference.colors[index];
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
    let mapped;

    if (advanced) {
      let [lightness, a, b] = rgbToOklab(...originalRgb);
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
      mapped = legacyTransfer(originalRgb, source, reference, strength);
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
