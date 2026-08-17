import { applyBasicAdjustments } from "./basicAdjustments.js";

const clamp = (value, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, Number(value) || 0));

export const DEFAULT_MASK_ADJUSTMENTS = Object.freeze({
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: 0,
  grain: 0,
});

export function createMaskLayer(type = "brush", overrides = {}) {
  const labels = {
    brush: "画笔蒙版",
    linear: "线性渐变",
    radial: "径向渐变",
    subject: "选择主体",
    sky: "选择天空",
  };
  const id = overrides.id || `mask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const semantic = type === "subject" || type === "sky";
  return {
    id,
    type,
    name: overrides.name || labels[type] || "局部蒙版",
    enabled: overrides.enabled ?? true,
    invert: overrides.invert ?? false,
    opacity: overrides.opacity ?? 100,
    adjustments: { ...DEFAULT_MASK_ADJUSTMENTS, ...(overrides.adjustments || {}) },
    sources: overrides.sources || (semantic ? [{ type, mode: "add" }] : []),
  };
}

function distanceToSegment(x, y, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(x - start.x, y - start.y);
  const amount = clamp(((x - start.x) * dx + (y - start.y) * dy) / lengthSquared);
  return Math.hypot(x - (start.x + dx * amount), y - (start.y + dy * amount));
}

function brushSourceAlpha(source, width, height) {
  const result = new Float32Array(width * height);
  const points = source.points || [];
  if (!points.length) return result;
  const radius = Math.max(1, (source.size ?? 18) / 100 * Math.min(width, height) * 0.32);
  const feather = clamp((source.feather ?? 70) / 100, 0.04, 1);
  const innerRadius = radius * (1 - feather);
  const flow = clamp((source.flow ?? 100) / 100);
  const pixelPoints = points.map((point) => ({ x: point.x * width, y: point.y * height }));
  const segments = pixelPoints.length > 1
    ? pixelPoints.slice(1).map((point, index) => [pixelPoints[index], point])
    : [[pixelPoints[0], pixelPoints[0]]];
  for (const [start, end] of segments) {
    const minimumX = Math.max(0, Math.floor(Math.min(start.x, end.x) - radius));
    const maximumX = Math.min(width - 1, Math.ceil(Math.max(start.x, end.x) + radius));
    const minimumY = Math.max(0, Math.floor(Math.min(start.y, end.y) - radius));
    const maximumY = Math.min(height - 1, Math.ceil(Math.max(start.y, end.y) + radius));
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const distance = distanceToSegment(x + 0.5, y + 0.5, start, end);
        if (distance > radius) continue;
        const alpha = distance <= innerRadius
          ? flow
          : flow * (1 - (distance - innerRadius) / Math.max(1, radius - innerRadius));
        const index = y * width + x;
        result[index] = Math.max(result[index], alpha);
      }
    }
  }
  return result;
}

function linearSourceAlpha(source, width, height) {
  const result = new Float32Array(width * height);
  const start = source.start || { x: 0.2, y: 0.5 };
  const end = source.end || { x: 0.8, y: 0.5 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = Math.max(0.000001, dx * dx + dy * dy);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x + 0.5) / width;
      const ny = (y + 0.5) / height;
      const position = ((nx - start.x) * dx + (ny - start.y) * dy) / lengthSquared;
      result[y * width + x] = 1 - clamp(position);
    }
  }
  return result;
}

function radialSourceAlpha(source, width, height) {
  const result = new Float32Array(width * height);
  const center = source.center || { x: 0.5, y: 0.5 };
  const radiusX = Math.max(0.01, source.radiusX ?? 0.28);
  const radiusY = Math.max(0.01, source.radiusY ?? 0.28);
  const feather = clamp((source.feather ?? 65) / 100, 0.04, 1);
  const inner = 1 - feather;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = ((x + 0.5) / width - center.x) / radiusX;
      const ny = ((y + 0.5) / height - center.y) / radiusY;
      const distance = Math.hypot(nx, ny);
      result[y * width + x] = distance <= inner
        ? 1
        : distance >= 1
          ? 0
          : 1 - (distance - inner) / Math.max(0.0001, 1 - inner);
    }
  }
  return result;
}

function semanticSourceAlpha(type, width, height, semanticMasks) {
  const sourceId = type === "subject" ? "person" : "sky";
  const source = semanticMasks?.masks?.[sourceId];
  const sourceWidth = semanticMasks?.width || width;
  const sourceHeight = semanticMasks?.height || height;
  const result = new Float32Array(width * height);
  if (!source?.length) return result;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(y / height * sourceHeight));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(x / width * sourceWidth));
      result[y * width + x] = source[sourceY * sourceWidth + sourceX] || 0;
    }
  }
  return result;
}

function sourceAlpha(source, width, height, semanticMasks) {
  if (source.type === "brush") return brushSourceAlpha(source, width, height);
  if (source.type === "linear") return linearSourceAlpha(source, width, height);
  if (source.type === "radial") return radialSourceAlpha(source, width, height);
  if (source.type === "subject" || source.type === "sky") {
    return semanticSourceAlpha(source.type, width, height, semanticMasks);
  }
  return new Float32Array(width * height);
}

export function rasterizeMaskLayer(layer, width, height, semanticMasks) {
  const result = new Float32Array(width * height);
  for (const source of layer?.sources || []) {
    const alpha = sourceAlpha(source, width, height, semanticMasks);
    if (source.mode === "subtract") {
      for (let index = 0; index < result.length; index += 1) {
        result[index] *= 1 - alpha[index];
      }
    } else {
      for (let index = 0; index < result.length; index += 1) {
        result[index] = Math.max(result[index], alpha[index]);
      }
    }
  }
  const opacity = clamp((layer?.opacity ?? 100) / 100);
  const invert = Boolean(layer?.invert);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = (invert ? 1 - result[index] : result[index]) * opacity;
  }
  return result;
}

export function hasLocalMasks(maskSettings) {
  return Boolean(maskSettings?.layers?.some((layer) => layer.enabled && layer.sources?.length));
}

export function transferableMaskSettings(maskSettings) {
  return {
    ...(maskSettings || {}),
    layers: (maskSettings?.layers || [])
      .filter((layer) => layer.sources?.length
        && layer.sources.every((source) => source.type === "subject" || source.type === "sky"))
      .map((layer) => structuredClone(layer)),
  };
}

export function applyLocalMasks(data, width, height, maskSettings, semanticMasks) {
  if (!hasLocalMasks(maskSettings)) return data;
  for (const layer of maskSettings.layers) {
    if (!layer.enabled || !layer.sources?.length) continue;
    const alpha = rasterizeMaskLayer(layer, width, height, semanticMasks);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let pixel = 0; pixel < alpha.length; pixel += 1) {
      if (alpha[pixel] <= 0.0001) continue;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (maxX < minX || maxY < minY) continue;
    const regionWidth = maxX - minX + 1;
    const regionHeight = maxY - minY + 1;
    const adjusted = new Uint8ClampedArray(regionWidth * regionHeight * 4);
    for (let y = 0; y < regionHeight; y += 1) {
      const sourceStart = ((minY + y) * width + minX) * 4;
      adjusted.set(
        data.subarray(sourceStart, sourceStart + regionWidth * 4),
        y * regionWidth * 4,
      );
    }
    applyBasicAdjustments(adjusted, regionWidth, regionHeight, {
      ...DEFAULT_MASK_ADJUSTMENTS,
      ...(layer.adjustments || {}),
      colorPlane: null,
      grain: 0,
    });
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const pixel = y * width + x;
        const amount = alpha[pixel];
        if (amount <= 0.0001) continue;
        const index = pixel * 4;
        const adjustedIndex = ((y - minY) * regionWidth + x - minX) * 4;
        data[index] += (adjusted[adjustedIndex] - data[index]) * amount;
        data[index + 1] += (adjusted[adjustedIndex + 1] - data[index + 1]) * amount;
        data[index + 2] += (adjusted[adjustedIndex + 2] - data[index + 2]) * amount;
      }
    }
  }
  return data;
}

export function maskOverlayImageData(layer, width, height, semanticMasks) {
  const alpha = rasterizeMaskLayer(layer, width, height, semanticMasks);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    const index = pixel * 4;
    data[index] = 255;
    data[index + 1] = 68;
    data[index + 2] = 92;
    data[index + 3] = Math.round(alpha[pixel] * 118);
  }
  return new ImageData(data, width, height);
}
