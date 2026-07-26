const GRID_SIZE = 8;
const SRGB_EXPOSURE_GAMMA = 2.2;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function luminance(red, green, blue) {
  return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
}

function saturation(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  return maximum ? (maximum - minimum) / maximum : 0;
}

function median(values, fallback = 0) {
  if (!values.length) return fallback;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function normalizeWhitePoint(channels) {
  const average = (channels[0] + channels[1] + channels[2]) / 3 || 1;
  return channels.map((channel) => clamp(channel / average, 0.72, 1.32));
}

function encodedExposure(exposureEV) {
  return 2 ** (clamp(exposureEV || 0, -2.5, 2.5) / SRGB_EXPOSURE_GAMMA);
}

function makeCell() {
  return { red: 0, green: 0, blue: 0, luminance: 0, weight: 0 };
}

function finishCell(cell, fallback) {
  if (cell.weight < 0.01) return { ...fallback, confidence: 0 };
  const channels = normalizeWhitePoint([
    cell.red / cell.weight,
    cell.green / cell.weight,
    cell.blue / cell.weight,
  ]);
  return {
    whitePoint: channels,
    exposureEV: clamp(
      Math.log2(Math.max(0.035, cell.luminance / cell.weight) / 0.5),
      -2.5,
      2.5,
    ),
    confidence: clamp(cell.weight / 80, 0, 1),
  };
}

export function analyzeSceneLighting(data, width, height, semanticMasks = null) {
  if (!width || !height || data.length < width * height * 4) return null;
  const neutralMask = semanticMasks?.masks?.neutral;
  const neutralSamples = [];
  const highlightSamples = [];
  const channelTotals = [0, 0, 0];
  let neutralWeightTotal = 0;
  const gridCells = Array.from({ length: GRID_SIZE * GRID_SIZE }, makeCell);
  const pixelCount = width * height;
  const step = Math.max(1, Math.floor(pixelCount / 150000));

  for (let pixel = 0; pixel < pixelCount; pixel += step) {
    const index = pixel * 4;
    if (data[index + 3] < 16) continue;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const light = luminance(red, green, blue);
    const chroma = saturation(red, green, blue);
    if (light > 0.82) highlightSamples.push(light);
    const inferredNeutral = clamp(1 - chroma / 0.14, 0, 1);
    const maskWeight = neutralMask?.[pixel] ?? 0;
    const neutralWeight = Math.max(maskWeight, inferredNeutral * 0.72)
      * (light > 0.04 && light < 0.97 ? 1 : 0);
    if (neutralWeight <= 0.02) continue;

    neutralSamples.push(light);
    channelTotals[0] += red * neutralWeight;
    channelTotals[1] += green * neutralWeight;
    channelTotals[2] += blue * neutralWeight;
    neutralWeightTotal += neutralWeight;

    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const cellX = Math.min(GRID_SIZE - 1, Math.floor(x / width * GRID_SIZE));
    const cellY = Math.min(GRID_SIZE - 1, Math.floor(y / height * GRID_SIZE));
    const cell = gridCells[cellY * GRID_SIZE + cellX];
    cell.red += red * neutralWeight;
    cell.green += green * neutralWeight;
    cell.blue += blue * neutralWeight;
    cell.luminance += light * neutralWeight;
    cell.weight += neutralWeight;
  }

  const neutralMedian = median(neutralSamples, 0.5);
  const whitePoint = neutralWeightTotal > 0.01
    ? normalizeWhitePoint(channelTotals.map((value) => value / neutralWeightTotal))
    : [1, 1, 1];
  const exposureEV = clamp(Math.log2(Math.max(0.035, neutralMedian) / 0.5), -2.5, 2.5);
  const highlightPoint = median(highlightSamples, 0.92);
  const temperature = clamp(
    6500 * (whitePoint[2] / Math.max(0.01, whitePoint[0])) ** 0.62,
    2500,
    12000,
  );
  const tint = clamp(
    ((whitePoint[0] + whitePoint[2]) * 0.5 - whitePoint[1]) * 100,
    -35,
    35,
  );
  const confidence = clamp(
    0.12
      + neutralSamples.length / Math.max(1, pixelCount / step) * 2.2
      + (highlightSamples.length ? 0.08 : 0),
    0.12,
    0.94,
  );
  const fallbackCell = { whitePoint, exposureEV };
  const grid = gridCells.map((cell) => finishCell(cell, fallbackCell));

  return {
    version: 1,
    gridSize: GRID_SIZE,
    whitePoint,
    exposureEV,
    temperature,
    tint,
    highlightPoint,
    confidence,
    neutralCoverage: neutralSamples.length / Math.max(1, pixelCount / step),
    grid,
  };
}

function sampleLighting(lighting, x = 0.5, y = 0.5) {
  if (!lighting?.grid?.length) return lighting;
  const size = lighting.gridSize || GRID_SIZE;
  const positionX = clamp(x, 0, 0.9999) * size - 0.5;
  const positionY = clamp(y, 0, 0.9999) * size - 0.5;
  const x0 = clamp(Math.floor(positionX), 0, size - 1);
  const y0 = clamp(Math.floor(positionY), 0, size - 1);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const tx = clamp(positionX - Math.floor(positionX), 0, 1);
  const ty = clamp(positionY - Math.floor(positionY), 0, 1);
  const cells = [
    [lighting.grid[y0 * size + x0], (1 - tx) * (1 - ty)],
    [lighting.grid[y0 * size + x1], tx * (1 - ty)],
    [lighting.grid[y1 * size + x0], (1 - tx) * ty],
    [lighting.grid[y1 * size + x1], tx * ty],
  ];
  const confidence = cells.reduce((sum, [cell, weight]) => sum + cell.confidence * weight, 0);
  if (confidence < 0.08) return lighting;
  return {
    whitePoint: [0, 1, 2].map((channel) =>
      cells.reduce((sum, [cell, weight]) => sum + cell.whitePoint[channel] * weight, 0)),
    exposureEV: cells.reduce((sum, [cell, weight]) => sum + cell.exposureEV * weight, 0),
    confidence,
  };
}

export function normalizeRgbForLighting(rgb, lighting, x, y) {
  if (!lighting) return [...rgb];
  const local = sampleLighting(lighting, x, y);
  const exposure = encodedExposure(local.exposureEV);
  const whitePoint = local.whitePoint || [1, 1, 1];
  return rgb.map((value, channel) =>
    clamp(value / Math.max(0.55, whitePoint[channel]) / exposure, 0, 255));
}

export function blendSceneLighting(source, reference, amount = 0.35) {
  if (!source || !reference) return source || reference || null;
  const reliability = Math.min(source.confidence || 0.2, reference.confidence || 0.2);
  const mix = clamp(amount, 0, 1) * clamp(reliability / 0.55, 0.25, 1);
  const blendPoint = (left, right) => ({
    whitePoint: [0, 1, 2].map((channel) =>
      left.whitePoint[channel]
        + (right.whitePoint[channel] - left.whitePoint[channel]) * mix),
    exposureEV: clamp(
      left.exposureEV + (right.exposureEV - left.exposureEV) * mix,
      -2.5,
      2.5,
    ),
    confidence: left.confidence + (right.confidence - left.confidence) * mix,
  });
  return {
    ...blendPoint(source, reference),
    version: 1,
    gridSize: GRID_SIZE,
    temperature: source.temperature + (reference.temperature - source.temperature) * mix,
    tint: source.tint + (reference.tint - source.tint) * mix,
    confidence: reliability,
    grid: source.grid.map((cell, index) => blendPoint(cell, reference.grid[index] || reference)),
  };
}

export function applySceneLighting(rgb, lighting, x, y) {
  if (!lighting) return [...rgb];
  const local = sampleLighting(lighting, x, y);
  const exposure = encodedExposure(local.exposureEV);
  const whitePoint = local.whitePoint || [1, 1, 1];
  return rgb.map((value, channel) =>
    clamp(value * whitePoint[channel] * exposure, 0, 255));
}

export function normalizeFrameLighting(data, width, height, lighting) {
  const output = new Uint8ClampedArray(data.length);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    const x = (pixel % width) / Math.max(1, width - 1);
    const y = Math.floor(pixel / width) / Math.max(1, height - 1);
    const normalized = normalizeRgbForLighting(
      [data[index], data[index + 1], data[index + 2]],
      lighting,
      x,
      y,
    );
    output[index] = normalized[0];
    output[index + 1] = normalized[1];
    output[index + 2] = normalized[2];
    output[index + 3] = data[index + 3];
  }
  return output;
}

export function lightingProfileWeights(items) {
  if (items.length < 3 || !items.every((item) => item?.lighting)) {
    return items.map(() => 1);
  }
  const temperatures = items.map((item) => Math.log(item.lighting.temperature));
  const exposures = items.map((item) => item.lighting.exposureEV);
  const saturationValues = items.map((item) => item.saturation || 0);
  const centerTemperature = median(temperatures);
  const centerExposure = median(exposures);
  const centerSaturation = median(saturationValues);
  return items.map((item, index) => {
    const lighting = item.lighting;
    const distance = (
      Math.abs(temperatures[index] - centerTemperature) / 0.2
      + Math.abs(exposures[index] - centerExposure) / 1.2
      + Math.abs(saturationValues[index] - centerSaturation) / 0.22
    ) / 3;
    return clamp(Math.exp(-distance * distance) * (0.6 + lighting.confidence * 0.4), 0.2, 1);
  });
}

export function averageLightingProfiles(items, weights = items.map(() => 1)) {
  const available = items
    .map((item, index) => ({ lighting: item?.lighting, weight: weights[index] }))
    .filter((item) => item.lighting);
  if (!available.length) return null;
  const weighted = (read) => {
    const total = available.reduce((sum, item) => sum + item.weight, 0) || 1;
    return available.reduce((sum, item) => sum + read(item.lighting) * item.weight, 0) / total;
  };
  const grid = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => ({
    whitePoint: [0, 1, 2].map((channel) =>
      weighted((lighting) => lighting.grid?.[index]?.whitePoint?.[channel]
        ?? lighting.whitePoint[channel])),
    exposureEV: weighted((lighting) =>
      lighting.grid?.[index]?.exposureEV ?? lighting.exposureEV),
    confidence: weighted((lighting) =>
      lighting.grid?.[index]?.confidence ?? lighting.confidence),
  }));
  return {
    version: 1,
    gridSize: GRID_SIZE,
    whitePoint: [0, 1, 2].map((channel) => weighted((lighting) => lighting.whitePoint[channel])),
    exposureEV: weighted((lighting) => lighting.exposureEV),
    temperature: weighted((lighting) => lighting.temperature),
    tint: weighted((lighting) => lighting.tint),
    highlightPoint: weighted((lighting) => lighting.highlightPoint),
    confidence: weighted((lighting) => lighting.confidence),
    neutralCoverage: weighted((lighting) => lighting.neutralCoverage),
    grid,
  };
}
