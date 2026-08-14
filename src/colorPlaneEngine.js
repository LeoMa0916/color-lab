const HUE_COUNT = 12;
const TONE_IDS = ["global", "shadows", "midtones", "highlights"];
const LUMINANCE_LEVELS = [0, 0.25, 0.5, 0.75, 1];

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function wrapDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function shortestAngle(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function smoothstep(start, end, value) {
  const amount = clamp((value - start) / Math.max(1e-6, end - start));
  return amount * amount * (3 - 2 * amount);
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function defaultHueNodes() {
  return Array.from({ length: HUE_COUNT }, (_, index) => ({
    hue: index * (360 / HUE_COUNT),
    hueShift: 0,
    saturation: 0,
  }));
}

export function defaultColorPlaneSettings() {
  return {
    version: 1,
    enabled: true,
    smoothness: 68,
    neutralProtection: 72,
    hueLayers: Object.fromEntries(TONE_IDS.map((id) => [id, defaultHueNodes()])),
    luminance: LUMINANCE_LEVELS.map((level) => ({ level, shift: 0 })),
  };
}

function normalizeHueLayer(layer) {
  const fallback = defaultHueNodes();
  return fallback.map((node, index) => ({
    hue: node.hue,
    hueShift: clamp(Number(layer?.[index]?.hueShift) || 0, -55, 55),
    saturation: clamp(Number(layer?.[index]?.saturation) || 0, -75, 75),
  }));
}

export function normalizeColorPlaneSettings(value) {
  const defaults = defaultColorPlaneSettings();
  return {
    version: 1,
    enabled: value?.enabled !== false,
    smoothness: clamp(finiteOr(value?.smoothness, defaults.smoothness), 10, 100),
    neutralProtection: clamp(
      finiteOr(value?.neutralProtection, defaults.neutralProtection),
      0,
      100,
    ),
    hueLayers: Object.fromEntries(TONE_IDS.map((id) => [
      id,
      normalizeHueLayer(value?.hueLayers?.[id]),
    ])),
    luminance: LUMINANCE_LEVELS.map((level, index) => ({
      level,
      shift: clamp(Number(value?.luminance?.[index]?.shift) || 0, -45, 45),
    })),
  };
}

export function hasColorPlaneAdjustments(value) {
  if (!value || value.enabled === false) return false;
  const settings = normalizeColorPlaneSettings(value);
  return hasNormalizedAdjustments(settings);
}

function hasNormalizedAdjustments(settings) {
  if (!settings.enabled) return false;
  return settings.luminance.some((node) => Math.abs(node.shift) > 0.001)
    || TONE_IDS.some((id) => settings.hueLayers[id].some((node) =>
      Math.abs(node.hueShift) > 0.001 || Math.abs(node.saturation) > 0.001));
}

function srgbToLinear(value) {
  const normalized = clamp(value / 255);
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value) {
  const bounded = Math.max(0, value);
  return 255 * (bounded <= 0.0031308
    ? bounded * 12.92
    : 1.055 * bounded ** (1 / 2.4) - 0.055);
}

function rgbToOklch(red, green, blue) {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lRoot = Math.cbrt(Math.max(0, l));
  const mRoot = Math.cbrt(Math.max(0, m));
  const sRoot = Math.cbrt(Math.max(0, s));
  const lightness = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const labB = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;
  return {
    lightness,
    chroma: Math.hypot(a, labB),
    hue: wrapDegrees(Math.atan2(labB, a) * 180 / Math.PI),
  };
}

function oklchToRgb(lightness, chroma, hue) {
  const radians = hue * Math.PI / 180;
  const a = Math.cos(radians) * chroma;
  const labB = Math.sin(radians) * chroma;
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * labB;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * labB;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * labB;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function toneWeights(lightness) {
  return {
    global: 1,
    shadows: 1 - smoothstep(0.18, 0.5, lightness),
    midtones: Math.max(
      smoothstep(0.14, 0.46, lightness) * (1 - smoothstep(0.58, 0.88, lightness)),
      0,
    ),
    highlights: smoothstep(0.54, 0.88, lightness),
  };
}

function sampleHueLayer(nodes, hue, smoothness) {
  const sigma = 10 + smoothness * 0.28;
  let total = 0;
  let hueShift = 0;
  let saturation = 0;
  for (const node of nodes) {
    const distance = Math.abs(shortestAngle(hue - node.hue));
    const weight = Math.exp(-0.5 * (distance / sigma) ** 2);
    total += weight;
    hueShift += node.hueShift * weight;
    saturation += node.saturation * weight;
  }
  return total > 1e-6
    ? { hueShift: hueShift / total, saturation: saturation / total }
    : { hueShift: 0, saturation: 0 };
}

function sampleLuminance(nodes, lightness) {
  const scaled = clamp(lightness) * (nodes.length - 1);
  const left = Math.min(nodes.length - 2, Math.floor(scaled));
  const amount = scaled - left;
  const eased = amount * amount * (3 - 2 * amount);
  return nodes[left].shift + (nodes[left + 1].shift - nodes[left].shift) * eased;
}

function compileColorPlane(settings) {
  const hueLayers = {};
  for (const id of TONE_IDS) {
    const table = new Float32Array(360 * 2);
    for (let hue = 0; hue < 360; hue += 1) {
      const sampled = sampleHueLayer(settings.hueLayers[id], hue, settings.smoothness);
      table[hue * 2] = sampled.hueShift;
      table[hue * 2 + 1] = sampled.saturation;
    }
    hueLayers[id] = table;
  }
  const luminance = Float32Array.from(
    { length: 256 },
    (_, index) => sampleLuminance(settings.luminance, index / 255),
  );
  return { hueLayers, luminance };
}

function sampleCompiledHue(table, hue) {
  const wrapped = wrapDegrees(hue);
  const left = Math.floor(wrapped);
  const right = (left + 1) % 360;
  const amount = wrapped - left;
  return {
    hueShift: table[left * 2] + (table[right * 2] - table[left * 2]) * amount,
    saturation: table[left * 2 + 1]
      + (table[right * 2 + 1] - table[left * 2 + 1]) * amount,
  };
}

function compressToSrgb(lightness, chroma, hue) {
  let boundedChroma = Math.max(0, chroma);
  let rgb = oklchToRgb(lightness, boundedChroma, hue);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    if (rgb.every((value) => Number.isFinite(value) && value >= 0 && value <= 255)) return rgb;
    boundedChroma *= 0.82;
    rgb = oklchToRgb(lightness, boundedChroma, hue);
  }
  return rgb.map((value) => clamp(Number.isFinite(value) ? value : 0, 0, 255));
}

function buildColorPlaneLut(settings, size = 33) {
  const compiled = compileColorPlane(settings);
  const data = new Float32Array(size ** 3 * 3);
  const maximum = size - 1;
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const index = ((blue * size + green) * size + red) * 3;
        const adjusted = adjustNormalizedColorPlanePixel([
          red / maximum * 255,
          green / maximum * 255,
          blue / maximum * 255,
        ], settings, compiled);
        data[index] = adjusted[0];
        data[index + 1] = adjusted[1];
        data[index + 2] = adjusted[2];
      }
    }
  }
  return { size, data };
}

function sampleColorPlaneLut(lut, red, green, blue, output) {
  const size = lut.size;
  const maximum = size - 1;
  const scaledRed = red / 255 * maximum;
  const scaledGreen = green / 255 * maximum;
  const scaledBlue = blue / 255 * maximum;
  const red0 = Math.floor(scaledRed);
  const green0 = Math.floor(scaledGreen);
  const blue0 = Math.floor(scaledBlue);
  const red1 = Math.min(maximum, red0 + 1);
  const green1 = Math.min(maximum, green0 + 1);
  const blue1 = Math.min(maximum, blue0 + 1);
  const redAmount = scaledRed - red0;
  const greenAmount = scaledGreen - green0;
  const blueAmount = scaledBlue - blue0;
  const row = size;
  const plane = size * size;
  const base = blue0 * plane + green0 * row + red0;
  const redOffset = red1 - red0;
  const greenOffset = (green1 - green0) * row;
  const blueOffset = (blue1 - blue0) * plane;
  const data = lut.data;
  for (let channel = 0; channel < 3; channel += 1) {
    const i000 = base * 3 + channel;
    const i100 = (base + redOffset) * 3 + channel;
    const i010 = (base + greenOffset) * 3 + channel;
    const i110 = (base + greenOffset + redOffset) * 3 + channel;
    const i001 = (base + blueOffset) * 3 + channel;
    const i101 = (base + blueOffset + redOffset) * 3 + channel;
    const i011 = (base + blueOffset + greenOffset) * 3 + channel;
    const i111 = (base + blueOffset + greenOffset + redOffset) * 3 + channel;
    const top0 = data[i000] + (data[i100] - data[i000]) * redAmount;
    const top1 = data[i010] + (data[i110] - data[i010]) * redAmount;
    const bottom0 = data[i001] + (data[i101] - data[i001]) * redAmount;
    const bottom1 = data[i011] + (data[i111] - data[i011]) * redAmount;
    const top = top0 + (top1 - top0) * greenAmount;
    const bottom = bottom0 + (bottom1 - bottom0) * greenAmount;
    output[channel] = top + (bottom - top) * blueAmount;
  }
}

function adjustNormalizedColorPlanePixel(rgb, settings, compiled = null) {
  const color = rgbToOklch(rgb[0], rgb[1], rgb[2]);
  const weights = toneWeights(color.lightness);
  let hueShift = 0;
  let saturation = 0;
  for (const id of TONE_IDS) {
    const sampled = compiled
      ? sampleCompiledHue(compiled.hueLayers[id], color.hue)
      : sampleHueLayer(settings.hueLayers[id], color.hue, settings.smoothness);
    const layerWeight = id === "global" ? 1 : weights[id] * 0.82;
    hueShift += sampled.hueShift * layerWeight;
    saturation += sampled.saturation * layerWeight;
  }
  const neutralThreshold = 0.012 + settings.neutralProtection / 100 * 0.055;
  const chromaProtection = smoothstep(neutralThreshold * 0.45, neutralThreshold * 1.5, color.chroma);
  const highlightProtection = 1 - smoothstep(0.88, 1.01, color.lightness) * 0.74;
  const shadowProtection = smoothstep(0.015, 0.09, color.lightness);
  const colorWeight = chromaProtection * highlightProtection * shadowProtection;
  const lightnessShift = (compiled
    ? compiled.luminance[Math.round(clamp(color.lightness) * 255)]
    : sampleLuminance(settings.luminance, color.lightness)) / 100;
  const shoulderWeight = 1 - smoothstep(0.82, 1, color.lightness) * 0.58;
  const nextLightness = clamp(color.lightness + lightnessShift * shoulderWeight, 0.004, 0.996);
  const nextChroma = color.chroma * Math.exp(saturation / 100 * 0.72 * colorWeight);
  return compressToSrgb(
    nextLightness,
    nextChroma,
    wrapDegrees(color.hue + hueShift * colorWeight),
  );
}

export function adjustColorPlanePixel(rgb, value) {
  const settings = normalizeColorPlaneSettings(value);
  if (!hasNormalizedAdjustments(settings)) return rgb;
  return adjustNormalizedColorPlanePixel(rgb, settings);
}

export function applyColorPlaneAdjustments(data, value) {
  const settings = normalizeColorPlaneSettings(value);
  if (!hasNormalizedAdjustments(settings)) return data;
  const lut = buildColorPlaneLut(settings);
  const adjusted = new Float32Array(3);
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 16) continue;
    sampleColorPlaneLut(lut, data[index], data[index + 1], data[index + 2], adjusted);
    data[index] = adjusted[0];
    data[index + 1] = adjusted[1];
    data[index + 2] = adjusted[2];
  }
  return data;
}

export const COLOR_PLANE_TONES = TONE_IDS;
export const COLOR_PLANE_HUES = Array.from(
  { length: HUE_COUNT },
  (_, index) => index * (360 / HUE_COUNT),
);
