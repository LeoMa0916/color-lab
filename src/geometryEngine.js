const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, Number(value) || 0));

export function defaultGeometrySettings() {
  return {
    aspect: "original",
    crop: { x: 0, y: 0, width: 1, height: 1 },
    upright: "off",
    rotation: 0,
    horizontal: 0,
    vertical: 0,
    transformAspect: 0,
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    constrainCrop: true,
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
    transformAspect: clamp(settings?.transformAspect, -100, 100),
    scale: clamp(settings?.scale ?? 100, 50, 150),
    offsetX: clamp(settings?.offsetX, -100, 100),
    offsetY: clamp(settings?.offsetY, -100, 100),
    constrainCrop: settings?.constrainCrop !== false,
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
    || Math.abs(value.transformAspect) > 0.001
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

function multiplyMatrix3(a, b) {
  const result = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let index = 0; index < 3; index += 1) {
        result[row * 3 + column] += a[row * 3 + index] * b[index * 3 + column];
      }
    }
  }
  return result;
}

function invertMatrix3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a * (e * i - f * h)
    - b * (d * i - f * g)
    + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-8) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inverse = 1 / determinant;
  return [
    (e * i - f * h) * inverse,
    (c * h - b * i) * inverse,
    (b * f - c * e) * inverse,
    (f * g - d * i) * inverse,
    (a * i - c * g) * inverse,
    (c * d - a * f) * inverse,
    (d * h - e * g) * inverse,
    (b * g - a * h) * inverse,
    (a * e - b * d) * inverse,
  ];
}

function geometryCoefficients(geometry, autoScale = 1) {
  const toRadians = Math.PI / 180;
  const rotation = geometry.rotation * toRadians;
  const horizontal = geometry.horizontal / 100 * 35 * toRadians;
  const vertical = geometry.vertical / 100 * 35 * toRadians;
  const cosX = Math.cos(vertical);
  const sinX = Math.sin(vertical);
  const cosY = Math.cos(horizontal);
  const sinY = Math.sin(horizontal);
  const cosZ = Math.cos(rotation);
  const sinZ = Math.sin(rotation);
  const rotateX = [1, 0, 0, 0, cosX, -sinX, 0, sinX, cosX];
  const rotateY = [cosY, 0, sinY, 0, 1, 0, -sinY, 0, cosY];
  const rotateZ = [cosZ, -sinZ, 0, sinZ, cosZ, 0, 0, 0, 1];
  const rotationMatrix = multiplyMatrix3(rotateZ, multiplyMatrix3(rotateY, rotateX));
  const focalLength = 2.15;
  const forwardHomography = [
    focalLength * rotationMatrix[0], focalLength * rotationMatrix[1], 0,
    focalLength * rotationMatrix[3], focalLength * rotationMatrix[4], 0,
    rotationMatrix[6], rotationMatrix[7], focalLength,
  ];
  return {
    inverseHomography: invertMatrix3(forwardHomography),
    scale: geometry.scale / 100 * autoScale,
    aspectScale: Math.exp(geometry.transformAspect / 100 * Math.log(1.5)),
    offsetX: geometry.offsetX / 100,
    offsetY: geometry.offsetY / 100,
  };
}

function mapNormalizedGeometryOutputPointToSource(point, geometry, autoScale = 1, prepared = null) {
  const coefficients = prepared || geometryCoefficients(geometry, autoScale);
  const outputX = ((point.x - 0.5) * 2 - coefficients.offsetX)
    / (coefficients.scale * coefficients.aspectScale);
  const outputY = ((point.y - 0.5) * 2 - coefficients.offsetY) / coefficients.scale;
  const inverse = coefficients.inverseHomography;
  const denominator = inverse[6] * outputX + inverse[7] * outputY + inverse[8];
  const safeDenominator = Math.abs(denominator) < 1e-6
    ? Math.sign(denominator || 1) * 1e-6
    : denominator;
  const warpedX = (inverse[0] * outputX + inverse[1] * outputY + inverse[2])
    / safeDenominator;
  const warpedY = (inverse[3] * outputX + inverse[4] * outputY + inverse[5])
    / safeDenominator;
  return {
    x: geometry.crop.x + (warpedX * 0.5 + 0.5) * geometry.crop.width,
    y: geometry.crop.y + (warpedY * 0.5 + 0.5) * geometry.crop.height,
  };
}

function geometryAutoScale(geometry) {
  if (!geometry.constrainCrop) return 1;
  const border = [];
  const samples = 24;
  for (let index = 0; index <= samples; index += 1) {
    const position = index / samples;
    border.push(
      { x: position, y: 0 },
      { x: position, y: 1 },
      { x: 0, y: position },
      { x: 1, y: position },
    );
  }
  const inside = (scale) => border.every((point) => {
    const source = mapNormalizedGeometryOutputPointToSource(point, geometry, scale);
    return source.x >= geometry.crop.x - 1e-5
      && source.x <= geometry.crop.x + geometry.crop.width + 1e-5
      && source.y >= geometry.crop.y - 1e-5
      && source.y <= geometry.crop.y + geometry.crop.height + 1e-5;
  });
  if (inside(1)) return 1;
  let low = 1;
  let high = 4;
  if (!inside(high)) return high;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const middle = (low + high) / 2;
    if (inside(middle)) high = middle;
    else low = middle;
  }
  return high;
}

export function mapGeometryOutputPointToSource(point, settings) {
  const geometry = normalizeGeometrySettings(settings);
  return mapNormalizedGeometryOutputPointToSource(point, geometry, geometryAutoScale(geometry));
}

export function applyGeometryTransform(data, width, height, settings, options = {}) {
  const geometry = normalizeGeometrySettings(settings);
  if (!hasGeometryAdjustments(geometry)) return { data, width, height };
  const { crop } = geometry;
  const outputWidth = Math.max(1, Math.round(width * crop.width));
  const outputHeight = Math.max(1, Math.round(height * crop.height));
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  const edgeMode = options.edgeMode || "clamp";
  const autoScale = geometryAutoScale(geometry);
  const coefficients = geometryCoefficients(geometry, autoScale);
  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const source = mapNormalizedGeometryOutputPointToSource({
        x: (x + 0.5) / outputWidth,
        y: (y + 0.5) / outputHeight,
      }, geometry, autoScale, coefficients);
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

function normalizeAngle(angle) {
  let value = angle;
  while (value > 90) value -= 180;
  while (value <= -90) value += 180;
  return value;
}

function weightedMean(samples) {
  const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  if (!weight) return 0;
  return samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / weight;
}

/**
 * Conservative, local-only Upright estimate. It measures dominant structural
 * edges and returns Lightroom-compatible manual controls instead of baking a
 * second transform into the pixels. The result can therefore be refined with
 * the sliders and exported consistently.
 */
export function estimateUprightTransform(data, width, height, mode = "auto") {
  if (!data || width < 8 || height < 8 || mode === "off") {
    return { upright: "off", rotation: 0, horizontal: 0, vertical: 0 };
  }
  const step = Math.max(1, Math.floor(Math.max(width, height) / 420));
  const horizontalEdges = [];
  const verticalEdges = [];
  const luma = (x, y) => {
    const index = (y * width + x) * 4;
    return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
  };
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const gx = luma(x + step, y) - luma(x - step, y);
      const gy = luma(x, y + step) - luma(x, y - step);
      const strength = Math.hypot(gx, gy);
      if (strength < 22) continue;
      const edgeAngle = normalizeAngle(Math.atan2(gy, gx) * 180 / Math.PI + 90);
      const nx = x / width * 2 - 1;
      const ny = y / height * 2 - 1;
      if (Math.abs(edgeAngle) <= 28) {
        horizontalEdges.push({ value: edgeAngle, position: ny, weight: strength });
      } else if (Math.abs(edgeAngle) >= 62) {
        const lean = edgeAngle > 0 ? edgeAngle - 90 : edgeAngle + 90;
        verticalEdges.push({ value: lean, position: nx, weight: strength });
      }
    }
  }
  const rotation = clamp(-weightedMean(horizontalEdges), -12, 12);
  const left = verticalEdges.filter((sample) => sample.position < -0.18);
  const right = verticalEdges.filter((sample) => sample.position > 0.18);
  const top = horizontalEdges.filter((sample) => sample.position < -0.18);
  const bottom = horizontalEdges.filter((sample) => sample.position > 0.18);
  const vertical = clamp((weightedMean(right) - weightedMean(left)) * 2.8, -55, 55);
  const horizontal = clamp((weightedMean(bottom) - weightedMean(top)) * 2.2, -45, 45);
  if (mode === "level") return { upright: mode, rotation, horizontal: 0, vertical: 0 };
  if (mode === "vertical") return { upright: mode, rotation, horizontal: 0, vertical };
  if (mode === "full") return { upright: mode, rotation, horizontal, vertical };
  return {
    upright: mode,
    rotation,
    horizontal: horizontal * 0.55,
    vertical: vertical * 0.72,
  };
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
