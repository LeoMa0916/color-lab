const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, Number(value) || 0));

export function defaultGeometrySettings() {
  return {
    aspect: "original",
    crop: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    horizontal: 0,
    vertical: 0,
    scale: 100,
    offsetX: 0,
    offsetY: 0,
  };
}

export function normalizeGeometrySettings(settings) {
  const defaults = defaultGeometrySettings();
  const crop = settings?.crop || defaults.crop;
  const width = clamp(crop.width, 0.05, 1);
  const height = clamp(crop.height, 0.05, 1);
  return {
    ...defaults,
    ...(settings || {}),
    crop: {
      x: clamp(crop.x, 0, 1 - width),
      y: clamp(crop.y, 0, 1 - height),
      width,
      height,
    },
    rotation: clamp(settings?.rotation, -45, 45),
    horizontal: clamp(settings?.horizontal, -100, 100),
    vertical: clamp(settings?.vertical, -100, 100),
    scale: clamp(settings?.scale ?? 100, 100, 200),
    offsetX: clamp(settings?.offsetX, -100, 100),
    offsetY: clamp(settings?.offsetY, -100, 100),
  };
}

export function hasGeometryAdjustments(settings) {
  const value = normalizeGeometrySettings(settings);
  const crop = value.crop;
  return crop.x > 0.0001 || crop.y > 0.0001
    || crop.width < 0.9999 || crop.height < 0.9999
    || Math.abs(value.rotation) > 0.001
    || Math.abs(value.horizontal) > 0.001
    || Math.abs(value.vertical) > 0.001
    || Math.abs(value.scale - 100) > 0.001
    || Math.abs(value.offsetX) > 0.001
    || Math.abs(value.offsetY) > 0.001;
}

function bilinear(data, width, height, x, y, channel, edgeMode) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
    if (edgeMode === "transparent") return 0;
    x = clamp(x, 0, width - 1);
    y = clamp(y, 0, height - 1);
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const top = data[(y0 * width + x0) * 4 + channel] * (1 - tx)
    + data[(y0 * width + x1) * 4 + channel] * tx;
  const bottom = data[(y1 * width + x0) * 4 + channel] * (1 - tx)
    + data[(y1 * width + x1) * 4 + channel] * tx;
  return top * (1 - ty) + bottom * ty;
}

function mapNormalizedGeometryOutputPointToSource(point, geometry) {
  const radians = -geometry.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotationGuard = 1 + Math.abs(Math.sin(geometry.rotation * Math.PI / 180)) * 0.36;
  const scale = geometry.scale / 100 * rotationGuard;
  const horizontal = geometry.horizontal / 100 * 0.34;
  const vertical = geometry.vertical / 100 * 0.34;
  const offsetX = geometry.offsetX / 400;
  const offsetY = geometry.offsetY / 400;
  let nx = (point.x - 0.5) * 2;
  let ny = (point.y - 0.5) * 2;
  nx = nx / scale - offsetX;
  ny = ny / scale - offsetY;
  const rotatedX = nx * cosine - ny * sine;
  const rotatedY = nx * sine + ny * cosine;
  const denominatorX = Math.max(0.42, 1 + vertical * rotatedY);
  const denominatorY = Math.max(0.42, 1 + horizontal * rotatedX);
  const warpedX = rotatedX / denominatorX + horizontal * rotatedY;
  const warpedY = rotatedY / denominatorY + vertical * rotatedX;
  return {
    x: geometry.crop.x + (warpedX * 0.5 + 0.5) * geometry.crop.width,
    y: geometry.crop.y + (warpedY * 0.5 + 0.5) * geometry.crop.height,
  };
}

export function mapGeometryOutputPointToSource(point, settings) {
  return mapNormalizedGeometryOutputPointToSource(point, normalizeGeometrySettings(settings));
}

export function applyGeometryTransform(data, width, height, settings, options = {}) {
  const geometry = normalizeGeometrySettings(settings);
  if (!hasGeometryAdjustments(geometry)) return { data, width, height };
  const { crop } = geometry;
  const outputWidth = Math.max(1, Math.round(width * crop.width));
  const outputHeight = Math.max(1, Math.round(height * crop.height));
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  const edgeMode = options.edgeMode || "clamp";
  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const source = mapNormalizedGeometryOutputPointToSource({
        x: (x + 0.5) / outputWidth,
        y: (y + 0.5) / outputHeight,
      }, geometry);
      const sourceX = source.x * width - 0.5;
      const sourceY = source.y * height - 0.5;
      const outputIndex = (y * outputWidth + x) * 4;
      output[outputIndex] = bilinear(data, width, height, sourceX, sourceY, 0, edgeMode);
      output[outputIndex + 1] = bilinear(data, width, height, sourceX, sourceY, 1, edgeMode);
      output[outputIndex + 2] = bilinear(data, width, height, sourceX, sourceY, 2, edgeMode);
      output[outputIndex + 3] = bilinear(data, width, height, sourceX, sourceY, 3, edgeMode);
    }
  }
  return { data: output, width: outputWidth, height: outputHeight };
}

export function sourceLongEdgeForCroppedOutput(outputLongEdge, imageWidth, imageHeight, settings) {
  if (!Number.isFinite(outputLongEdge) || !imageWidth || !imageHeight) return outputLongEdge;
  const { crop } = normalizeGeometrySettings(settings);
  const originalLongEdge = Math.max(imageWidth, imageHeight);
  const croppedLongEdge = Math.max(imageWidth * crop.width, imageHeight * crop.height);
  if (!croppedLongEdge) return outputLongEdge;
  return Math.min(originalLongEdge, outputLongEdge * originalLongEdge / croppedLongEdge);
}

export function cropForAspect(aspect, imageWidth, imageHeight, currentCrop) {
  if (aspect === "free") return { ...(currentCrop || defaultGeometrySettings().crop) };
  if (aspect === "original") return { x: 0, y: 0, width: 1, height: 1 };
  const [wide, tall] = String(aspect).split(":").map(Number);
  if (!wide || !tall) return { x: 0, y: 0, width: 1, height: 1 };
  const desired = wide / tall;
  const source = imageWidth / Math.max(1, imageHeight);
  if (source > desired) {
    const width = desired / source;
    return { x: (1 - width) / 2, y: 0, width, height: 1 };
  }
  const height = source / desired;
  return { x: 0, y: (1 - height) / 2, width: 1, height };
}
