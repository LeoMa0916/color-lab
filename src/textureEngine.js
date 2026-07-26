function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function lumaAt(data, index) {
  return (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
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

function hashNoise(x, y, seed) {
  let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y + seed, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value ^= value >>> 15;
  return (value >>> 0) / 4294967295 - 0.5;
}

export function analyzeTextureSpectrum(data, width, height) {
  if (!width || !height || width * height * 4 > data.length) return null;
  const luma = new Float32Array(width * height);
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    luma[pixel] = lumaAt(data, pixel * 4);
  }
  const radii = [1, 2, 4, 8];
  const blurs = radii.map((radius) => boxBlur(luma, width, height, radius));
  const energy = radii.map(() => 0);
  const noiseLuma = [0, 0, 0];
  const noiseColor = [0, 0, 0];
  const toneCounts = [0, 0, 0];
  const differences = [];
  let overshoot = 0;
  let edgeTotal = 0;
  let sampleCount = 0;
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 720));

  for (let y = 8; y < height - 8; y += stride) {
    for (let x = 8; x < width - 8; x += stride) {
      const pixel = y * width + x;
      const center = luma[pixel];
      radii.forEach((_, index) => {
        const detail = center - blurs[index][pixel];
        energy[index] += detail * detail;
      });
      const localDetail = center - blurs[0][pixel];
      const tone = center < 0.3 ? 0 : center > 0.72 ? 2 : 1;
      noiseLuma[tone] += localDetail * localDetail;
      const dataIndex = pixel * 4;
      const channelResiduals = [
        data[dataIndex] / 255 - center,
        data[dataIndex + 1] / 255 - center,
        data[dataIndex + 2] / 255 - center,
      ];
      const colorResidual = (
        channelResiduals[0] ** 2
        + channelResiduals[1] ** 2
        + channelResiduals[2] ** 2
      ) / 3;
      noiseColor[tone] += colorResidual * Math.min(1, Math.abs(localDetail) * 12);
      toneCounts[tone] += 1;

      const left = luma[pixel - 1];
      const right = luma[pixel + 1];
      const top = luma[pixel - width];
      const bottom = luma[pixel + width];
      const edge = (Math.abs(right - left) + Math.abs(bottom - top)) * 0.5;
      const laplacian = Math.abs(4 * center - left - right - top - bottom);
      if (edge > 0.035) {
        overshoot += Math.max(0, laplacian - edge * 1.4);
        edgeTotal += edge;
      }
      differences.push(edge);
      sampleCount += 1;
    }
  }
  differences.sort((left, right) => left - right);
  const edgeP95 = differences[Math.floor(differences.length * 0.95)] || 0;
  const spectrum = energy.map((value) => Math.sqrt(value / Math.max(1, sampleCount)));
  return {
    version: 2,
    scales: radii,
    spectrum,
    microContrast: spectrum[0],
    edgeP95,
    acutance: spectrum[0] / Math.max(0.0001, spectrum[2]),
    edgeOvershoot: overshoot / Math.max(0.0001, edgeTotal),
    smear: clamp(1 - spectrum[0] / Math.max(0.0001, spectrum[1] * 1.5), 0, 1),
    noise: {
      luma: noiseLuma.map((value, index) =>
        Math.sqrt(value / Math.max(1, toneCounts[index]))),
      color: noiseColor.map((value, index) =>
        Math.sqrt(value / Math.max(1, toneCounts[index]))),
    },
  };
}

export function applyTextureMatch(
  data,
  width,
  height,
  source,
  reference,
  strength = 1,
  options = {},
) {
  const sourceTexture = source?.texture;
  const referenceTexture = reference?.texture;
  if (!sourceTexture?.spectrum || !referenceTexture?.spectrum || !width || !height) return data;
  const amount = clamp(strength, 0, 1);
  const luma = new Float32Array(width * height);
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    luma[pixel] = lumaAt(data, pixel * 4);
  }
  const outputScale = options.outputScale ?? Math.max(width, height) / 1600;
  const originX = options.originX || 0;
  const originY = options.originY || 0;
  const radii = [1, 2, 4, 8].map((radius) => Math.max(1, Math.round(radius * outputScale)));
  const blurs = radii.map((radius) => boxBlur(luma, width, height, radius));
  const gains = referenceTexture.spectrum.map((value, index) =>
    clamp(
      (value / Math.max(0.0005, sourceTexture.spectrum[index]) - 1) * amount,
      -0.42,
      0.32,
    ));
  const noiseDelta = [0, 1, 2].map((tone) =>
    Math.sqrt(Math.max(
      0,
      (referenceTexture.noise?.luma?.[tone] || 0) ** 2
        - (sourceTexture.noise?.luma?.[tone] || 0) ** 2,
    )) * amount * 255);
  const colorRatio = clamp(
    (referenceTexture.noise?.color?.[1] || 0)
      / Math.max(0.0001, referenceTexture.noise?.luma?.[1] || 0),
    0,
    0.42,
  );
  const haloLimit = referenceTexture.edgeOvershoot > sourceTexture.edgeOvershoot ? 0.035 : 0.018;

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    if (data[index + 3] < 16) continue;
    const light = luma[pixel];
    let detail = 0;
    let previous = light;
    blurs.forEach((blur, scaleIndex) => {
      const band = previous - blur[pixel];
      detail += band * gains[scaleIndex];
      previous = blur[pixel];
    });
    detail = clamp(detail, -haloLimit, haloLimit) * 255;
    const tone = light < 0.3 ? 0 : light > 0.72 ? 2 : 1;
    const x = pixel % width + originX;
    const y = Math.floor(pixel / width) + originY;
    const grain = hashNoise(x, y, 0x4ce4b17) * noiseDelta[tone] * 1.7;
    const colorNoise = grain * colorRatio;
    data[index] = clamp(data[index] + detail + grain + colorNoise, 0, 255);
    data[index + 1] = clamp(data[index + 1] + detail + grain - colorNoise * 0.35, 0, 255);
    data[index + 2] = clamp(data[index + 2] + detail + grain - colorNoise * 0.65, 0, 255);
  }
  return data;
}

export function applyTextureMatchTiled(
  data,
  width,
  height,
  source,
  reference,
  strength = 1,
  options = {},
) {
  const pixelCount = width * height;
  const tileSize = Math.max(32, options.tileSize || 768);
  const directPixelLimit = options.directPixelLimit || 8000000;
  if (pixelCount <= directPixelLimit) {
    applyTextureMatch(data, width, height, source, reference, strength);
    options.onProgress?.(1);
    return data;
  }

  const sourcePixels = new Uint8ClampedArray(data);
  const outputScale = Math.max(width, height) / 1600;
  const overlap = Math.max(10, Math.ceil(8 * outputScale) + 2);
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const tileCount = columns * rows;
  let completed = 0;

  for (let tileY = 0; tileY < height; tileY += tileSize) {
    const coreHeight = Math.min(tileSize, height - tileY);
    const sourceY = Math.max(0, tileY - overlap);
    const sourceBottom = Math.min(height, tileY + coreHeight + overlap);
    const tileHeight = sourceBottom - sourceY;
    for (let tileX = 0; tileX < width; tileX += tileSize) {
      const coreWidth = Math.min(tileSize, width - tileX);
      const sourceX = Math.max(0, tileX - overlap);
      const sourceRight = Math.min(width, tileX + coreWidth + overlap);
      const tileWidth = sourceRight - sourceX;
      const tile = new Uint8ClampedArray(tileWidth * tileHeight * 4);

      for (let row = 0; row < tileHeight; row += 1) {
        const sourceStart = ((sourceY + row) * width + sourceX) * 4;
        tile.set(
          sourcePixels.subarray(sourceStart, sourceStart + tileWidth * 4),
          row * tileWidth * 4,
        );
      }

      applyTextureMatch(tile, tileWidth, tileHeight, source, reference, strength, {
        outputScale,
        originX: sourceX,
        originY: sourceY,
      });

      const coreOffsetX = tileX - sourceX;
      const coreOffsetY = tileY - sourceY;
      for (let row = 0; row < coreHeight; row += 1) {
        const tileStart = ((coreOffsetY + row) * tileWidth + coreOffsetX) * 4;
        const outputStart = ((tileY + row) * width + tileX) * 4;
        data.set(
          tile.subarray(tileStart, tileStart + coreWidth * 4),
          outputStart,
        );
      }
      completed += 1;
      options.onProgress?.(completed / tileCount);
    }
  }
  return data;
}
