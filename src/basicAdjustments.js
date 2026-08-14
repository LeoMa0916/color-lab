import {
  applyColorPlaneAdjustments,
  hasColorPlaneAdjustments,
} from "./colorPlaneEngine.js";

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(start, end, value) {
  const amount = clamp((value - start) / (end - start));
  return amount * amount * (3 - 2 * amount);
}

function luminance(red, green, blue) {
  return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
}

function srgbToLinear(value) {
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value) {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055;
}

function adjustZone(value, control, weight, lift, lower) {
  const amount = clamp(control / 100, -1, 1);
  if (amount >= 0) return value + (1 - value) * amount * weight * lift;
  return value + value * amount * weight * lower;
}

function hashNoise(x, y, seed) {
  let value = Math.imul((x | 0) ^ seed, 0x45d9f3b)
    ^ Math.imul((y | 0) + seed, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value ^= value >>> 15;
  return (value >>> 0) / 4294967295 - 0.5;
}

function smoothNoise(x, y, cellSize, seed) {
  if (cellSize === 1) return hashNoise(Math.floor(x), Math.floor(y), seed);
  const gridX = x / cellSize;
  const gridY = y / cellSize;
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const tx = gridX - x0;
  const ty = gridY - y0;
  const smoothX = tx * tx * (3 - 2 * tx);
  const smoothY = ty * ty * (3 - 2 * ty);
  const topLeft = hashNoise(x0, y0, seed);
  const topRight = hashNoise(x0 + 1, y0, seed);
  const bottomLeft = hashNoise(x0, y0 + 1, seed);
  const bottomRight = hashNoise(x0 + 1, y0 + 1, seed);
  const top = topLeft + (topRight - topLeft) * smoothX;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * smoothX;
  return top + (bottom - top) * smoothY;
}

function filmGrainAt(pixel, width, height, light, settings) {
  const amount = clamp(settings.grain ?? 0, 0, 100);
  if (!amount) return [0, 0, 0];
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  const densityScale = Math.max(width, height) / 1600;
  const requestedSize = clamp(settings.grainSize ?? 1, 0.5, 4);
  const cellSize = Math.max(1, requestedSize * densityScale);
  const roughness = clamp((settings.grainRoughness ?? 50) / 100);
  const colorRatio = clamp((settings.grainColor ?? 12) / 100);
  const highlightResponse = clamp((settings.grainHighlights ?? 25) / 100);
  const seed = Math.round(settings.grainSeed ?? 1847);
  const coarse = smoothNoise(x, y, cellSize, seed);
  const fine = hashNoise(x, y, seed ^ 0x68bc21eb);
  const luminanceNoise = coarse * (1 - roughness * 0.58) + fine * roughness * 0.72;
  const shadowWeight = 0.82 + (1 - light) * 0.36;
  const highlightFade = 1 - smoothstep(0.58, 0.98, light) * (1 - highlightResponse);
  const amplitude = amount * 2.15 * shadowWeight * highlightFade;
  const base = luminanceNoise * amplitude;
  // Derive the low-amplitude chroma grain from the two independent noise
  // bands already sampled above. This preserves deterministic film-like
  // channel variation without two additional four-corner noise lookups per
  // pixel, which is significant for 24MP Worker exports.
  const redNoise = coarse * amplitude * colorRatio;
  const blueNoise = -coarse * 0.73 * amplitude * colorRatio;
  return [
    base + redNoise,
    base - (redNoise + blueNoise) * 0.28,
    base + blueNoise,
  ];
}

function adjustedLuminance(value, settings) {
  const exposure = clamp(settings.exposure ?? 0, -3, 3);
  let result = linearToSrgb(clamp(srgbToLinear(value) * (2 ** exposure)));
  result = adjustZone(
    result,
    settings.highlights ?? 0,
    smoothstep(0.42, 0.96, result),
    0.52,
    0.42,
  );
  result = adjustZone(
    result,
    settings.shadows ?? 0,
    1 - smoothstep(0.04, 0.58, result),
    0.42,
    0.72,
  );
  result = adjustZone(
    result,
    settings.whites ?? 0,
    smoothstep(0.68, 1, result),
    0.72,
    0.34,
  );
  result = adjustZone(
    result,
    settings.blacks ?? 0,
    1 - smoothstep(0, 0.34, result),
    0.24,
    0.86,
  );

  const dehaze = clamp((settings.dehaze ?? 0) / 100, -1, 1);
  if (dehaze > 0) {
    const blackOffset = dehaze * 0.11;
    result = (result - blackOffset) / (1 - blackOffset);
  } else if (dehaze < 0) {
    result += (1 - result) * -dehaze * 0.13;
  }
  return clamp(result);
}

export function adjustBasicPixel(rgb, settings) {
  let [red, green, blue] = rgb;
  const tint = clamp(settings.tint ?? 0, -100, 100);
  red += tint * 0.32;
  green -= tint * 0.42;
  blue += tint * 0.28;

  const beforeLuminance = luminance(red, green, blue);
  const afterLuminance = adjustedLuminance(beforeLuminance, settings);
  const toneDelta = (afterLuminance - beforeLuminance) * 255;
  red += toneDelta;
  green += toneDelta;
  blue += toneDelta;

  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const saturation = maximum > 0 ? (maximum - minimum) / maximum : 0;
  const vibrance = clamp((settings.vibrance ?? 0) / 100, -1, 1);
  const dehaze = clamp((settings.dehaze ?? 0) / 100, -1, 1);
  const colorFactor = (1 + vibrance * (vibrance > 0 ? 1 - saturation : 0.82) * 0.9)
    * (1 + dehaze * 0.14);
  const currentLuminance = luminance(red, green, blue) * 255;
  return [red, green, blue].map((value) =>
    clamp(currentLuminance + (value - currentLuminance) * colorFactor, 0, 255));
}

function boxBlur(source, width, height, radius) {
  const windowSize = radius * 2 + 1;
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += source[row + clamp(offset, 0, width - 1)];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / windowSize;
      sum -= source[row + clamp(x - radius, 0, width - 1)];
      sum += source[row + clamp(x + radius + 1, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += horizontal[clamp(offset, 0, height - 1) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / windowSize;
      sum -= horizontal[clamp(y - radius, 0, height - 1) * width + x];
      sum += horizontal[clamp(y + radius + 1, 0, height - 1) * width + x];
    }
  }
  return output;
}

export function applyBasicAdjustments(data, width, height, settings) {
  const hasColorPlane = hasColorPlaneAdjustments(settings.colorPlane);
  const hasPixelAdjustments = [
    "temperature",
    "tint",
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "dehaze",
    "vibrance",
    "saturation",
    "grain",
  ].some((key) => settings[key]);
  const texture = clamp((settings.texture ?? 0) / 100, -1, 1);
  const clarity = clamp((settings.clarity ?? 0) / 100, -1, 1);
  if (!hasPixelAdjustments && !texture && !clarity && !hasColorPlane) return data;

  if (hasColorPlane) applyColorPlaneAdjustments(data, settings.colorPlane);

  if (hasPixelAdjustments) {
    const toneLut = Float32Array.from(
      { length: 1024 },
      (_, index) => adjustedLuminance(index / 1023, settings),
    );
    const tint = clamp(settings.tint ?? 0, -100, 100);
    const temperature = clamp(settings.temperature ?? 0, -100, 100);
    const redTint = tint * 0.32;
    const greenTint = tint * -0.42;
    const blueTint = tint * 0.28;
    const vibrance = clamp((settings.vibrance ?? 0) / 100, -1, 1);
    const saturationFactor = 1 + clamp((settings.saturation ?? 0) / 100, -1, 1);
    const contrast = clamp(settings.contrast ?? 0, -100, 100);
    const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    const dehaze = clamp((settings.dehaze ?? 0) / 100, -1, 1);
    const dehazeColorFactor = 1 + dehaze * 0.14;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 16) continue;
      let red = data[index] + redTint + temperature * 0.55;
      let green = data[index + 1] + greenTint;
      let blue = data[index + 2] + blueTint - temperature * 0.55;
      const beforeLuminance = luminance(red, green, blue);
      const toneIndex = Math.round(clamp(beforeLuminance) * 1023);
      const toneDelta = (toneLut[toneIndex] - beforeLuminance) * 255;
      red += toneDelta;
      green += toneDelta;
      blue += toneDelta;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const saturation = maximum > 0 ? (maximum - minimum) / maximum : 0;
      const colorFactor = (1 + vibrance * (vibrance > 0 ? 1 - saturation : 0.82) * 0.9)
        * dehazeColorFactor
        * saturationFactor;
      const currentLuminance = luminance(red, green, blue) * 255;
      const grain = filmGrainAt(
        index / 4,
        width,
        height,
        clamp(currentLuminance / 255),
        settings,
      );
      data[index] = contrastFactor
        * (currentLuminance + (red - currentLuminance) * colorFactor - 128)
        + 128 + grain[0];
      data[index + 1] = contrastFactor
        * (currentLuminance + (green - currentLuminance) * colorFactor - 128)
        + 128 + grain[1];
      data[index + 2] = contrastFactor
        * (currentLuminance + (blue - currentLuminance) * colorFactor - 128)
        + 128 + grain[2];
    }
  }

  if (!texture && !clarity) return data;

  const lightness = new Float32Array(width * height);
  for (let pixel = 0; pixel < lightness.length; pixel += 1) {
    const index = pixel * 4;
    lightness[pixel] = luminance(data[index], data[index + 1], data[index + 2]);
  }
  const textureBlur = texture ? boxBlur(lightness, width, height, 1) : null;
  const clarityRadius = Math.max(3, Math.round(Math.min(width, height) * 0.007));
  const clarityBlur = clarity ? boxBlur(lightness, width, height, clarityRadius) : null;

  for (let pixel = 0; pixel < lightness.length; pixel += 1) {
    const index = pixel * 4;
    if (data[index + 3] < 16) continue;
    const midtoneWeight = 1 - Math.abs(lightness[pixel] - 0.5) * 2;
    const textureDetail = textureBlur
      ? (lightness[pixel] - textureBlur[pixel]) * texture * 0.82
      : 0;
    const clarityDetail = clarityBlur
      ? (lightness[pixel] - clarityBlur[pixel]) * clarity * midtoneWeight * 1.18
      : 0;
    const detail = (textureDetail + clarityDetail) * 255;
    data[index] = clamp(data[index] + detail, 0, 255);
    data[index + 1] = clamp(data[index + 1] + detail, 0, 255);
    data[index + 2] = clamp(data[index + 2] + detail, 0, 255);
  }
  return data;
}
