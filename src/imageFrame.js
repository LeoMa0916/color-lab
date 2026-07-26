const SRGB_TO_XYZ_D65 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const XYZ_D65_TO_D50 = [
  [1.0479298, 0.0229468, -0.0501922],
  [0.0296278, 0.9904345, -0.0170738],
  [-0.009243, 0.0150552, 0.7518743],
];
const XYZ_D50_TO_PROPHOTO = [
  [1.3459433, -0.2556075, -0.0511118],
  [-0.5445989, 1.5081673, 0.0205351],
  [0, 0, 1.2118128],
];
const PROPHOTO_TO_XYZ_D50 = [
  [0.7976749, 0.1351917, 0.0313534],
  [0.2880402, 0.7118741, 0.0000857],
  [0, 0, 0.82521],
];
const XYZ_D50_TO_D65 = [
  [0.9554734, -0.0230985, 0.0632593],
  [-0.0283697, 1.0099955, 0.0210414],
  [0.012314, -0.0205077, 1.3303659],
];
const XYZ_D65_TO_SRGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

function multiplyMatrix(matrix, vector) {
  return matrix.map((row) =>
    row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
}

function transform(vector, matrices) {
  return matrices.reduce((value, matrix) => multiplyMatrix(matrix, value), vector);
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

function srgbToLinear(value) {
  const channel = clampUnit(value);
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value) {
  const channel = Math.max(0, value);
  return clampUnit(channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055);
}

export function linearSrgbToProPhoto(rgb) {
  return transform(rgb, [SRGB_TO_XYZ_D65, XYZ_D65_TO_D50, XYZ_D50_TO_PROPHOTO]);
}

export function proPhotoToLinearSrgb(rgb) {
  return transform(rgb, [PROPHOTO_TO_XYZ_D50, XYZ_D50_TO_D65, XYZ_D65_TO_SRGB]);
}

/**
 * @typedef {Object} ImageFrame
 * @property {Float32Array} pixels Linear RGB pixels.
 * @property {number} width
 * @property {number} height
 * @property {number} bitDepth
 * @property {"linear-prophoto-rgb"} workingSpace
 * @property {File|null} originalFile
 * @property {Object|null} metadata
 * @property {number[]|null} cameraMatrix
 */

export function createImageFrame({
  pixels,
  width,
  height,
  bitDepth = 32,
  originalFile = null,
  metadata = null,
  cameraMatrix = null,
}) {
  if (!(pixels instanceof Float32Array) || pixels.length !== width * height * 3) {
    throw new Error("ImageFrame 像素尺寸不匹配");
  }
  return {
    pixels,
    width,
    height,
    bitDepth,
    workingSpace: "linear-prophoto-rgb",
    originalFile,
    metadata,
    cameraMatrix,
  };
}

export function rgba8ToImageFrame(data, width, height, details = {}) {
  const pixels = new Float32Array(width * height * 3);
  for (let source = 0, target = 0; target < pixels.length; source += 4, target += 3) {
    const proPhoto = linearSrgbToProPhoto([
      srgbToLinear(data[source] / 255),
      srgbToLinear(data[source + 1] / 255),
      srgbToLinear(data[source + 2] / 255),
    ]);
    pixels[target] = proPhoto[0];
    pixels[target + 1] = proPhoto[1];
    pixels[target + 2] = proPhoto[2];
  }
  return createImageFrame({ pixels, width, height, bitDepth: 8, ...details });
}

export function raw16ToPreviewFrame(decoded, maxSide = 1600, details = {}) {
  const sourceWidth = decoded.width;
  const sourceHeight = decoded.height;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const pixels = new Float32Array(width * height * 3);
  const colors = decoded.colors || 3;
  const divisor = decoded.bits > 8 || decoded.data instanceof Uint16Array ? 65535 : 255;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(y / height * sourceHeight));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(x / width * sourceWidth));
      const source = (sourceY * sourceWidth + sourceX) * colors;
      const target = (y * width + x) * 3;
      pixels[target] = decoded.data[source] / divisor;
      pixels[target + 1] = decoded.data[source + Math.min(1, colors - 1)] / divisor;
      pixels[target + 2] = decoded.data[source + Math.min(2, colors - 1)] / divisor;
    }
  }
  return createImageFrame({
    pixels,
    width,
    height,
    bitDepth: decoded.bits || 16,
    ...details,
  });
}

export function raw16ToRgba8(decoded, maxSide = Number.POSITIVE_INFINITY) {
  const sourceWidth = decoded.width;
  const sourceHeight = decoded.height;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const colors = decoded.colors || 3;
  const divisor = decoded.bits > 8 || decoded.data instanceof Uint16Array ? 65535 : 255;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(y / height * sourceHeight));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(x / width * sourceWidth));
      const source = (sourceY * sourceWidth + sourceX) * colors;
      const target = (y * width + x) * 4;
      const srgb = proPhotoToLinearSrgb([
        decoded.data[source] / divisor,
        decoded.data[source + Math.min(1, colors - 1)] / divisor,
        decoded.data[source + Math.min(2, colors - 1)] / divisor,
      ]);
      rgba[target] = linearToSrgb(srgb[0]) * 255;
      rgba[target + 1] = linearToSrgb(srgb[1]) * 255;
      rgba[target + 2] = linearToSrgb(srgb[2]) * 255;
      rgba[target + 3] = 255;
    }
  }
  return { data: rgba, width, height, bitDepth: decoded.bits || 16 };
}

export function imageFrameToRgba8(frame) {
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let source = 0, target = 0; source < frame.pixels.length; source += 3, target += 4) {
    const srgb = proPhotoToLinearSrgb([
      frame.pixels[source],
      frame.pixels[source + 1],
      frame.pixels[source + 2],
    ]);
    rgba[target] = linearToSrgb(srgb[0]) * 255;
    rgba[target + 1] = linearToSrgb(srgb[1]) * 255;
    rgba[target + 2] = linearToSrgb(srgb[2]) * 255;
    rgba[target + 3] = 255;
  }
  return rgba;
}

export function imageFrameToCanvas(frame, canvas = document.createElement("canvas")) {
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.getContext("2d").putImageData(
    new ImageData(imageFrameToRgba8(frame), frame.width, frame.height),
    0,
    0,
  );
  return canvas;
}
