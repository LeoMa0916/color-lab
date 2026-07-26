import { analyzeTextureSpectrum } from "./textureEngine.js";

const D65 = [0.95047, 1, 1.08883];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function srgbToLinear(value) {
  const channel = clamp(value / 255, 0, 1);
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function labPivot(value) {
  const delta = 6 / 29;
  return value > delta ** 3
    ? Math.cbrt(value)
    : value / (3 * delta * delta) + 4 / 29;
}

export function rgbToLab(red, green, blue) {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65[0];
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / D65[1];
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / D65[2];
  const fx = labPivot(x);
  const fy = labPivot(y);
  const fz = labPivot(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function degrees(radians) {
  const value = radians * 180 / Math.PI;
  return value < 0 ? value + 360 : value;
}

function radians(value) {
  return value * Math.PI / 180;
}

function hueDelta(first, second) {
  const difference = second - first;
  if (Math.abs(difference) <= 180) return difference;
  return difference > 180 ? difference - 360 : difference + 360;
}

export function ciede2000(first, second) {
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;
  const chroma1 = Math.hypot(a1, b1);
  const chroma2 = Math.hypot(a2, b2);
  const meanChroma = (chroma1 + chroma2) / 2;
  const power = meanChroma ** 7;
  const g = 0.5 * (1 - Math.sqrt(power / (power + 25 ** 7)));
  const adjustedA1 = (1 + g) * a1;
  const adjustedA2 = (1 + g) * a2;
  const adjustedChroma1 = Math.hypot(adjustedA1, b1);
  const adjustedChroma2 = Math.hypot(adjustedA2, b2);
  const hue1 = adjustedChroma1 === 0 ? 0 : degrees(Math.atan2(b1, adjustedA1));
  const hue2 = adjustedChroma2 === 0 ? 0 : degrees(Math.atan2(b2, adjustedA2));
  const deltaLightness = l2 - l1;
  const deltaChroma = adjustedChroma2 - adjustedChroma1;
  const deltaHueAngle = adjustedChroma1 * adjustedChroma2 === 0
    ? 0
    : hueDelta(hue1, hue2);
  const deltaHue = 2
    * Math.sqrt(adjustedChroma1 * adjustedChroma2)
    * Math.sin(radians(deltaHueAngle / 2));
  const meanLightness = (l1 + l2) / 2;
  const adjustedMeanChroma = (adjustedChroma1 + adjustedChroma2) / 2;
  let meanHue;
  if (adjustedChroma1 * adjustedChroma2 === 0) {
    meanHue = hue1 + hue2;
  } else if (Math.abs(hue1 - hue2) <= 180) {
    meanHue = (hue1 + hue2) / 2;
  } else if (hue1 + hue2 < 360) {
    meanHue = (hue1 + hue2 + 360) / 2;
  } else {
    meanHue = (hue1 + hue2 - 360) / 2;
  }
  const t = 1
    - 0.17 * Math.cos(radians(meanHue - 30))
    + 0.24 * Math.cos(radians(2 * meanHue))
    + 0.32 * Math.cos(radians(3 * meanHue + 6))
    - 0.2 * Math.cos(radians(4 * meanHue - 63));
  const lightnessWeight = 1
    + 0.015 * (meanLightness - 50) ** 2
      / Math.sqrt(20 + (meanLightness - 50) ** 2);
  const chromaWeight = 1 + 0.045 * adjustedMeanChroma;
  const hueWeight = 1 + 0.015 * adjustedMeanChroma * t;
  const rotation = 30 * Math.exp(-(((meanHue - 275) / 25) ** 2));
  const chromaPower = adjustedMeanChroma ** 7;
  const rotationCoefficient = -2
    * Math.sqrt(chromaPower / (chromaPower + 25 ** 7))
    * Math.sin(radians(2 * rotation));
  const normalizedLightness = deltaLightness / lightnessWeight;
  const normalizedChroma = deltaChroma / chromaWeight;
  const normalizedHue = deltaHue / hueWeight;
  return Math.sqrt(
    normalizedLightness ** 2
    + normalizedChroma ** 2
    + normalizedHue ** 2
    + rotationCoefficient * normalizedChroma * normalizedHue,
  );
}

function sampleStride(data, maximumSamples) {
  return Math.max(1, Math.floor(data.length / 4 / maximumSamples));
}

function luminanceAt(data, index) {
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function percentile(sorted, amount) {
  if (!sorted.length) return 0;
  const position = clamp(amount, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  const blend = position - lower;
  return sorted[lower] * (1 - blend) + sorted[upper] * blend;
}

export function meanImageDeltaE(reference, candidate, maximumSamples = 12000) {
  const pixelCount = Math.min(reference.length, candidate.length) / 4;
  const stride = Math.max(1, Math.floor(pixelCount / maximumSamples));
  let total = 0;
  let samples = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const index = pixel * 4;
    if (reference[index + 3] < 16 || candidate[index + 3] < 16) continue;
    total += ciede2000(
      rgbToLab(reference[index], reference[index + 1], reference[index + 2]),
      rgbToLab(candidate[index], candidate[index + 1], candidate[index + 2]),
    );
    samples += 1;
  }
  return samples ? total / samples : 0;
}

export function tonePercentileDistance(reference, candidate) {
  const amounts = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99];
  const referenceValues = [];
  const candidateValues = [];
  const stride = Math.max(
    sampleStride(reference, 24000),
    sampleStride(candidate, 24000),
  );
  const pixelCount = Math.min(reference.length, candidate.length) / 4;
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const index = pixel * 4;
    if (reference[index + 3] >= 16) referenceValues.push(luminanceAt(reference, index));
    if (candidate[index + 3] >= 16) candidateValues.push(luminanceAt(candidate, index));
  }
  referenceValues.sort((left, right) => left - right);
  candidateValues.sort((left, right) => left - right);
  return amounts.reduce((sum, amount) => (
    sum + Math.abs(percentile(referenceValues, amount) - percentile(candidateValues, amount))
  ), 0) / amounts.length;
}

export function clippingRates(data) {
  let black = 0;
  let white = 0;
  let samples = 0;
  const stride = sampleStride(data, 48000);
  for (let index = 0; index < data.length; index += 4 * stride) {
    if (data[index + 3] < 16) continue;
    const luminance = luminanceAt(data, index);
    black += luminance <= 1.5 ? 1 : 0;
    white += luminance >= 253.5 ? 1 : 0;
    samples += 1;
  }
  return {
    black: samples ? black / samples : 0,
    white: samples ? white / samples : 0,
  };
}

function colorHistogram(data, bins = 8) {
  const histogram = new Float64Array(bins ** 3);
  let samples = 0;
  const stride = sampleStride(data, 48000);
  for (let index = 0; index < data.length; index += 4 * stride) {
    if (data[index + 3] < 16) continue;
    const red = Math.min(bins - 1, Math.floor(data[index] / 256 * bins));
    const green = Math.min(bins - 1, Math.floor(data[index + 1] / 256 * bins));
    const blue = Math.min(bins - 1, Math.floor(data[index + 2] / 256 * bins));
    histogram[(red * bins + green) * bins + blue] += 1;
    samples += 1;
  }
  if (samples) {
    for (let index = 0; index < histogram.length; index += 1) {
      histogram[index] /= samples;
    }
  }
  return histogram;
}

export function colorDistributionDistance(reference, candidate) {
  const first = colorHistogram(reference);
  const second = colorHistogram(candidate);
  let distance = 0;
  for (let index = 0; index < first.length; index += 1) {
    distance += Math.abs(first[index] - second[index]);
  }
  return distance / 2;
}

function rgbHue(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (!delta) return 0;
  let hue;
  if (maximum === red) hue = ((green - blue) / delta) % 6;
  else if (maximum === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return (hue * 60 + 360) % 360;
}

function isLikelySkin(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const hue = rgbHue(red, green, blue);
  const saturation = maximum ? (maximum - minimum) / maximum : 0;
  return red > 55
    && red > green * 0.92
    && green > blue * 0.72
    && hue <= 70
    && saturation >= 0.08
    && saturation <= 0.72;
}

function circularDistance(first, second) {
  return Math.abs(((first - second + 540) % 360) - 180);
}

export function skinHueError(reference, candidate, mask = null) {
  const pixelCount = Math.min(reference.length, candidate.length) / 4;
  const stride = Math.max(1, Math.floor(pixelCount / 24000));
  let total = 0;
  let weight = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const index = pixel * 4;
    const maskWeight = mask ? mask[pixel] || 0 : (
      isLikelySkin(reference[index], reference[index + 1], reference[index + 2]) ? 1 : 0
    );
    if (maskWeight < 0.05) continue;
    total += circularDistance(
      rgbHue(reference[index], reference[index + 1], reference[index + 2]),
      rgbHue(candidate[index], candidate[index + 1], candidate[index + 2]),
    ) * maskWeight;
    weight += maskWeight;
  }
  return weight ? total / weight : null;
}

export function textureSpectrumDistance(reference, candidate, width, height) {
  const referenceProfile = analyzeTextureSpectrum(reference, width, height);
  const candidateProfile = analyzeTextureSpectrum(candidate, width, height);
  if (!referenceProfile?.spectrum || !candidateProfile?.spectrum) return null;
  return referenceProfile.spectrum.reduce((sum, value, index) => (
    sum + Math.abs(value - candidateProfile.spectrum[index])
  ), 0) / referenceProfile.spectrum.length;
}

export function qualityReport(reference, candidate, width, height, options = {}) {
  const clipping = clippingRates(candidate);
  return {
    ciede2000: meanImageDeltaE(reference, candidate),
    skinHueError: skinHueError(reference, candidate, options.skinMask),
    tonePercentileDistance: tonePercentileDistance(reference, candidate),
    blackClipRate: clipping.black,
    whiteClipRate: clipping.white,
    colorDistributionDistance: colorDistributionDistance(reference, candidate),
    textureSpectrumDistance: textureSpectrumDistance(
      reference,
      candidate,
      width,
      height,
    ),
  };
}
