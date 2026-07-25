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
  const hasPixelAdjustments = [
    "tint",
    "exposure",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "dehaze",
    "vibrance",
  ].some((key) => settings[key]);
  const texture = clamp((settings.texture ?? 0) / 100, -1, 1);
  const clarity = clamp((settings.clarity ?? 0) / 100, -1, 1);
  if (!hasPixelAdjustments && !texture && !clarity) return data;

  if (hasPixelAdjustments) {
    const toneLut = Float32Array.from(
      { length: 1024 },
      (_, index) => adjustedLuminance(index / 1023, settings),
    );
    const tint = clamp(settings.tint ?? 0, -100, 100);
    const redTint = tint * 0.32;
    const greenTint = tint * -0.42;
    const blueTint = tint * 0.28;
    const vibrance = clamp((settings.vibrance ?? 0) / 100, -1, 1);
    const dehaze = clamp((settings.dehaze ?? 0) / 100, -1, 1);
    const dehazeColorFactor = 1 + dehaze * 0.14;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 16) continue;
      let red = data[index] + redTint;
      let green = data[index + 1] + greenTint;
      let blue = data[index + 2] + blueTint;
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
        * dehazeColorFactor;
      const currentLuminance = luminance(red, green, blue) * 255;
      data[index] = currentLuminance + (red - currentLuminance) * colorFactor;
      data[index + 1] = currentLuminance + (green - currentLuminance) * colorFactor;
      data[index + 2] = currentLuminance + (blue - currentLuminance) * colorFactor;
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
