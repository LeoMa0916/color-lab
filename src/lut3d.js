function clampUnit(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

const REGIONAL_RESIDUAL_LIMITS = {
  // Portrait references often encode substantially more red/yellow separation
  // than the scene's global look.  Give the skin LUT enough range to restore
  // that chroma without asking the global LUT to tint neutral objects.
  skin: 0.135,
  sky: 0.11,
  foliage: 0.1,
  neutral: 0.055,
};

const REGIONAL_OPACITY = {
  skin: 0.96,
  sky: 0.72,
  foliage: 0.7,
  neutral: 0.52,
};

function luminance(red, green, blue) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function smoothstep(start, end, value) {
  const amount = clampUnit((value - start) / Math.max(0.00001, end - start));
  return amount * amount * (3 - 2 * amount);
}

function protectSkinChroma(red, green, blue, mapped, skinWeight) {
  if (skinWeight < 0.05) return mapped;
  const inputLight = luminance(red, green, blue);
  const mappedLight = luminance(mapped[0], mapped[1], mapped[2]);
  const inputChroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const mappedChroma = Math.max(mapped[0], mapped[1], mapped[2])
    - Math.min(mapped[0], mapped[1], mapped[2]);
  const highlightWeight = smoothstep(0.48, 0.9, inputLight);
  const minimumChroma = inputChroma * (0.62 + highlightWeight * 0.14);
  if (inputChroma < 0.018 || mappedChroma >= minimumChroma) return mapped;
  const collapse = clampUnit(
    (minimumChroma - mappedChroma) / Math.max(0.001, minimumChroma),
  );
  const scale = minimumChroma / Math.max(0.001, inputChroma);
  const blend = clampUnit(skinWeight) * collapse * 0.88;
  mapped[0] = clampUnit(mapped[0] + (
    mappedLight + (red - inputLight) * scale - mapped[0]
  ) * blend);
  mapped[1] = clampUnit(mapped[1] + (
    mappedLight + (green - inputLight) * scale - mapped[1]
  ) * blend);
  mapped[2] = clampUnit(mapped[2] + (
    mappedLight + (blue - inputLight) * scale - mapped[2]
  ) * blend);
  return mapped;
}

export function matchSkinColorTarget(red, green, blue, mapped, skinWeight, target) {
  if (skinWeight < 0.05 || !target?.referenceOffsets?.length) return mapped;
  const inputChroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const sourceChroma = Math.max(0.012, target.sourceChroma || inputChroma);
  const detailScale = Math.max(0.58, Math.min(1.5, inputChroma / sourceChroma));
  const inputLight = luminance(red, green, blue);
  const blend = clampUnit(skinWeight) * clampUnit(target.strength ?? 1) * 0.82;
  const referenceLight = inputLight
    + ((target.referenceLight ?? inputLight) - (target.sourceLight ?? inputLight));
  // Preserve the reference hue at the gamut boundary. Clipping each channel
  // separately turns bright warm skin yellow/white and crushes shadow color.
  const desiredLight = Math.max(0.005, Math.min(0.995, referenceLight));
  let chromaScale = detailScale * 1.12;
  for (let channel = 0; channel < 3; channel += 1) {
    const offset = target.referenceOffsets[channel];
    if (offset > 0) chromaScale = Math.min(chromaScale, (1 - desiredLight) / offset);
    if (offset < 0) chromaScale = Math.min(chromaScale, -desiredLight / offset);
  }
  for (let channel = 0; channel < 3; channel += 1) {
    const desired = desiredLight + target.referenceOffsets[channel] * chromaScale;
    mapped[channel] = clampUnit(mapped[channel] + (desired - mapped[channel]) * blend);
  }
  return mapped;
}

function protectToneRange(red, green, blue, mapped) {
  const inputLight = luminance(red, green, blue);
  const mappedLight = luminance(mapped[0], mapped[1], mapped[2]);
  const midtoneWeight = Math.max(0, 1 - Math.abs(inputLight - 0.5) * 2);
  const highlightWeight = smoothstep(0.88, 0.99, inputLight);
  const shadowWeight = 1 - smoothstep(0.018, 0.15, inputLight);
  let maximumLift = (0.065 + midtoneWeight * 0.095)
    * (1 - highlightWeight * 0.72)
    * (1 - shadowWeight * 0.08);
  let maximumDrop = (0.058 + midtoneWeight * 0.09)
    * (1 - highlightWeight * 0.68)
    * (1 - shadowWeight * 0.1);
  const collapseRisk = smoothstep(0.075, 0.19, Math.abs(mappedLight - inputLight));
  maximumLift *= 1 - collapseRisk * 0.58;
  maximumDrop *= 1 - collapseRisk * 0.7;
  const limitedShift = Math.max(
    -maximumDrop,
    Math.min(maximumLift, mappedLight - inputLight),
  );
  const correction = inputLight + limitedShift - mappedLight;
  const protectedRed = clampUnit(mapped[0] + correction);
  const protectedGreen = clampUnit(mapped[1] + correction);
  const protectedBlue = clampUnit(mapped[2] + correction);
  const inputChroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const protectedLight = luminance(protectedRed, protectedGreen, protectedBlue);
  const protectedChroma = Math.max(protectedRed, protectedGreen, protectedBlue)
    - Math.min(protectedRed, protectedGreen, protectedBlue);
  const chromaHighlightWeight = smoothstep(0.52, 0.9, inputLight);
  const minimumChroma = inputChroma * (0.34 + chromaHighlightWeight * 0.24);
  if (
    chromaHighlightWeight <= 0.02
    || inputChroma <= 0.012
    || protectedChroma >= minimumChroma
  ) {
    mapped[0] = protectedRed;
    mapped[1] = protectedGreen;
    mapped[2] = protectedBlue;
    return mapped;
  }

  const hueScale = minimumChroma / inputChroma;
  const blend = chromaHighlightWeight
    * clampUnit((minimumChroma - protectedChroma) / Math.max(0.001, minimumChroma))
    * 0.86;
  mapped[0] = clampUnit(protectedRed + (
    clampUnit(protectedLight + (red - inputLight) * hueScale) - protectedRed
  ) * blend);
  mapped[1] = clampUnit(protectedGreen + (
    clampUnit(protectedLight + (green - inputLight) * hueScale) - protectedGreen
  ) * blend);
  mapped[2] = clampUnit(protectedBlue + (
    clampUnit(protectedLight + (blue - inputLight) * hueScale) - protectedBlue
  ) * blend);
  return mapped;
}

function protectToneRangeAdaptive(red, green, blue, mapped, toneGuard) {
  const inputLight = luminance(red, green, blue);
  const mappedLight = luminance(mapped[0], mapped[1], mapped[2]);
  const midtoneWeight = Math.max(0, 1 - Math.abs(inputLight - 0.5) * 2);
  const highlightWeight = smoothstep(0.88, 0.99, inputLight);
  const shadowWeight = 1 - smoothstep(0.018, 0.15, inputLight);
  const toeLift = toneGuard.toeLift;
  const shoulderDrop = toneGuard.shoulderDrop;
  const rangeCompression = toneGuard.rangeCompression;
  let maximumLift = (0.065 + midtoneWeight * 0.095)
    * (1 - highlightWeight * 0.72)
    * (1 - shadowWeight * 0.08)
    + toeLift * (0.74 + shadowWeight * 0.2)
    + rangeCompression * shadowWeight * 0.045;
  let maximumDrop = (0.058 + midtoneWeight * 0.09
    + shoulderDrop * 0.78
    + rangeCompression * highlightWeight * 0.055)
    * (1 - highlightWeight * 0.24)
    * (1 - shadowWeight * 0.1);
  const collapseRisk = smoothstep(0.075, 0.19, Math.abs(mappedLight - inputLight));
  const supportedLift = clampUnit(toeLift / 0.12 + rangeCompression * 0.45);
  const supportedDrop = clampUnit(shoulderDrop / 0.12 + rangeCompression * 0.45);
  maximumLift *= 1 - collapseRisk * (0.58 - supportedLift * 0.38);
  maximumDrop *= 1 - collapseRisk * (0.7 - supportedDrop * 0.5);
  const limitedShift = Math.max(
    -maximumDrop,
    Math.min(maximumLift, mappedLight - inputLight),
  );
  const correction = inputLight + limitedShift - mappedLight;
  const protectedRed = clampUnit(mapped[0] + correction);
  const protectedGreen = clampUnit(mapped[1] + correction);
  const protectedBlue = clampUnit(mapped[2] + correction);
  const inputChroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const protectedLight = luminance(protectedRed, protectedGreen, protectedBlue);
  const protectedChroma = Math.max(protectedRed, protectedGreen, protectedBlue)
    - Math.min(protectedRed, protectedGreen, protectedBlue);
  const chromaHighlightWeight = smoothstep(0.52, 0.9, inputLight);
  const minimumChroma = inputChroma * (0.34 + chromaHighlightWeight * 0.24);
  if (
    chromaHighlightWeight <= 0.02
    || inputChroma <= 0.012
    || protectedChroma >= minimumChroma
  ) {
    mapped[0] = protectedRed;
    mapped[1] = protectedGreen;
    mapped[2] = protectedBlue;
    return mapped;
  }

  const hueScale = minimumChroma / inputChroma;
  const blend = chromaHighlightWeight
    * clampUnit((minimumChroma - protectedChroma) / Math.max(0.001, minimumChroma))
    * 0.86;
  mapped[0] = clampUnit(protectedRed + (
    clampUnit(protectedLight + (red - inputLight) * hueScale) - protectedRed
  ) * blend);
  mapped[1] = clampUnit(protectedGreen + (
    clampUnit(protectedLight + (green - inputLight) * hueScale) - protectedGreen
  ) * blend);
  mapped[2] = clampUnit(protectedBlue + (
    clampUnit(protectedLight + (blue - inputLight) * hueScale) - protectedBlue
  ) * blend);
  return mapped;
}

function lutIndex(size, red, green, blue) {
  return ((blue * size + green) * size + red) * 3;
}

export function createIdentityLut(size = 33) {
  const data = new Float32Array(size ** 3 * 3);
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const index = lutIndex(size, red, green, blue);
        data[index] = red / (size - 1);
        data[index + 1] = green / (size - 1);
        data[index + 2] = blue / (size - 1);
      }
    }
  }
  return { size, data, identity: true };
}

export function createLutFromRgba(data, size) {
  if (data.length !== size ** 3 * 4) throw new Error("LUT 节点数量不匹配");
  const output = new Float32Array(size ** 3 * 3);
  for (let source = 0, target = 0; source < data.length; source += 4, target += 3) {
    output[target] = clampUnit(data[source] / 255);
    output[target + 1] = clampUnit(data[source + 1] / 255);
    output[target + 2] = clampUnit(data[source + 2] / 255);
  }
  return { size, data: output };
}

export function lutToRgbaInput(size) {
  const output = new Uint8ClampedArray(size ** 3 * 4);
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const pixel = (blue * size + green) * size + red;
        const index = pixel * 4;
        output[index] = red / (size - 1) * 255;
        output[index + 1] = green / (size - 1) * 255;
        output[index + 2] = blue / (size - 1) * 255;
        output[index + 3] = 255;
      }
    }
  }
  return output;
}

export function smoothLut(lut, amount = 0.12, passes = 1) {
  let source = new Float32Array(lut.data);
  const size = lut.size;
  for (let pass = 0; pass < passes; pass += 1) {
    const output = new Float32Array(source.length);
    for (let blue = 0; blue < size; blue += 1) {
      for (let green = 0; green < size; green += 1) {
        for (let red = 0; red < size; red += 1) {
          const index = lutIndex(size, red, green, blue);
          const neighbours = [
            [Math.max(0, red - 1), green, blue],
            [Math.min(size - 1, red + 1), green, blue],
            [red, Math.max(0, green - 1), blue],
            [red, Math.min(size - 1, green + 1), blue],
            [red, green, Math.max(0, blue - 1)],
            [red, green, Math.min(size - 1, blue + 1)],
          ];
          for (let channel = 0; channel < 3; channel += 1) {
            const average = neighbours.reduce((sum, coordinates) =>
              sum + source[lutIndex(size, ...coordinates) + channel], 0) / neighbours.length;
            output[index + channel] = clampUnit(
              source[index + channel] + (average - source[index + channel]) * amount,
            );
          }
        }
      }
    }
    source = output;
  }
  return enforceLutConstraints({ size, data: source });
}

export function enforceLutConstraints(lut) {
  const data = new Float32Array(lut.data.length);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = clampUnit(lut.data[index]);
  }
  let previousLuminance = 0;
  for (let point = 0; point < lut.size; point += 1) {
    const index = lutIndex(lut.size, point, point, point);
    const rgb = [data[index], data[index + 1], data[index + 2]];
    const light = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    if (light < previousLuminance) {
      const lift = previousLuminance - light;
      data[index] = clampUnit(data[index] + lift);
      data[index + 1] = clampUnit(data[index + 1] + lift);
      data[index + 2] = clampUnit(data[index + 2] + lift);
    }
    previousLuminance = Math.max(previousLuminance, light);
  }
  return { size: lut.size, data };
}

export function tetrahedralSample(lut, rgb) {
  const output = [0, 0, 0];
  tetrahedralSampleInto(lut, rgb[0], rgb[1], rgb[2], output);
  return output;
}

function tetrahedralSampleInto(lut, redInput, greenInput, blueInput, output) {
  const maximum = lut.size - 1;
  const scaledRed = clampUnit(redInput) * maximum;
  const scaledGreen = clampUnit(greenInput) * maximum;
  const scaledBlue = clampUnit(blueInput) * maximum;
  const red = Math.min(maximum - 1, Math.floor(scaledRed));
  const green = Math.min(maximum - 1, Math.floor(scaledGreen));
  const blue = Math.min(maximum - 1, Math.floor(scaledBlue));
  const fr = scaledRed - red;
  const fg = scaledGreen - green;
  const fb = scaledBlue - blue;
  const greenStride = lut.size * 3;
  const blueStride = lut.size * greenStride;
  const i000 = blue * blueStride + green * greenStride + red * 3;
  const i100 = i000 + 3;
  const i010 = i000 + greenStride;
  const i001 = i000 + blueStride;
  const i110 = i010 + 3;
  const i101 = i001 + 3;
  const i011 = i001 + greenStride;
  const i111 = i011 + 3;
  for (let channel = 0; channel < 3; channel += 1) {
    const c000 = lut.data[i000 + channel];
    let value = c000;
    if (fr >= fg) {
      if (fg >= fb) {
        value += (lut.data[i100 + channel] - c000) * fr
          + (lut.data[i110 + channel] - lut.data[i100 + channel]) * fg
          + (lut.data[i111 + channel] - lut.data[i110 + channel]) * fb;
      } else if (fr >= fb) {
        value += (lut.data[i100 + channel] - c000) * fr
          + (lut.data[i101 + channel] - lut.data[i100 + channel]) * fb
          + (lut.data[i111 + channel] - lut.data[i101 + channel]) * fg;
      } else {
        value += (lut.data[i001 + channel] - c000) * fb
          + (lut.data[i101 + channel] - lut.data[i001 + channel]) * fr
          + (lut.data[i111 + channel] - lut.data[i101 + channel]) * fg;
      }
    } else if (fr >= fb) {
      value += (lut.data[i010 + channel] - c000) * fg
        + (lut.data[i110 + channel] - lut.data[i010 + channel]) * fr
        + (lut.data[i111 + channel] - lut.data[i110 + channel]) * fb;
    } else if (fg >= fb) {
      value += (lut.data[i010 + channel] - c000) * fg
        + (lut.data[i011 + channel] - lut.data[i010 + channel]) * fb
        + (lut.data[i111 + channel] - lut.data[i011 + channel]) * fr;
    } else {
      value += (lut.data[i001 + channel] - c000) * fb
        + (lut.data[i011 + channel] - lut.data[i001 + channel]) * fg
        + (lut.data[i111 + channel] - lut.data[i011 + channel]) * fr;
    }
    output[channel] = clampUnit(value);
  }
}

function maskValue(semanticMasks, region, pixel, width, height) {
  const mask = semanticMasks?.masks?.[region];
  if (!mask) return 0;
  if (mask.length === width * height) return mask[pixel] || 0;
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  const sourceX = Math.min(
    semanticMasks.width - 1,
    Math.floor(x / width * semanticMasks.width),
  );
  const sourceY = Math.min(
    semanticMasks.height - 1,
    Math.floor(y / height * semanticMasks.height),
  );
  return mask[sourceY * semanticMasks.width + sourceX] || 0;
}

function sampleToneCorrection(correction, inputLight) {
  if (!correction?.length) return 0;
  const position = clampUnit(inputLight) * (correction.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(correction.length - 1, lower + 1);
  const amount = position - lower;
  return correction[lower] + (correction[upper] - correction[lower]) * amount;
}

export function applyStyleLuts(data, width, height, styleLuts, semanticMasks = null) {
  const residualEntries = Object.entries(styleLuts.residuals || {});
  const mapped = [0, 0, 0];
  const delta = [0, 0, 0];
  const residual = [0, 0, 0];
  const hasResiduals = residualEntries.length > 0;
  const toneCorrectionLut = styleLuts.toneCorrection;
  const hasToneCorrection = Boolean(toneCorrectionLut?.length);
  const toneGuard = styleLuts.toneGuard;
  const skinColorTarget = styleLuts.skinColorTarget;
  const hasToneGuard = Boolean(
    toneGuard
    && (toneGuard.toeLift || toneGuard.shoulderDrop || toneGuard.rangeCompression),
  );
  if (
    styleLuts.global?.identity
    && !hasResiduals
    && !hasToneCorrection
    && !hasToneGuard
    && !skinColorTarget
  ) return data;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    if (data[index + 3] < 16) continue;
    const red = data[index] / 255;
    const green = data[index + 1] / 255;
    const blue = data[index + 2] / 255;
    tetrahedralSampleInto(styleLuts.global, red, green, blue, mapped);
    const skinWeight = clampUnit(maskValue(
      semanticMasks,
      "skin",
      pixel,
      width,
      height,
    ));
    if (hasToneCorrection) {
      // The neutral-axis correction is measured from a grayscale ramp. Keep it
      // authoritative for neutrals, but let the A/B and C/L color planes drive
      // saturated pixels so colored skies and foliage do not cross histogram
      // boundaries merely because their luminance matches a gray sample.
      const inputChroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const neutralWeight = 1 - smoothstep(0.06, 0.28, inputChroma) * 0.9;
      const toneCorrection = sampleToneCorrection(
        toneCorrectionLut,
        luminance(red, green, blue),
      ) * neutralWeight;
      mapped[0] = clampUnit(mapped[0] + toneCorrection);
      mapped[1] = clampUnit(mapped[1] + toneCorrection);
      mapped[2] = clampUnit(mapped[2] + toneCorrection);
    }
    if (!hasResiduals) {
      matchSkinColorTarget(red, green, blue, mapped, skinWeight, skinColorTarget);
      protectSkinChroma(red, green, blue, mapped, skinWeight);
      const protectedColor = hasToneGuard
        ? protectToneRangeAdaptive(red, green, blue, mapped, toneGuard)
        : protectToneRange(red, green, blue, mapped);
      data[index] = protectedColor[0] * 255;
      data[index + 1] = protectedColor[1] * 255;
      data[index + 2] = protectedColor[2] * 255;
      continue;
    }
    let totalWeight = 0;
    residual[0] = 0;
    residual[1] = 0;
    residual[2] = 0;
    for (let entry = 0; entry < residualEntries.length; entry += 1) {
      const [region, lut] = residualEntries[entry];
      const weight = clampUnit(maskValue(semanticMasks, region, pixel, width, height))
        * (REGIONAL_OPACITY[region] ?? 0.65);
      if (weight < 0.01) continue;
      tetrahedralSampleInto(lut, red, green, blue, delta);
      const limit = REGIONAL_RESIDUAL_LIMITS[region] ?? 0.08;
      residual[0] += Math.max(-limit, Math.min(limit, delta[0] - 0.5)) * weight;
      residual[1] += Math.max(-limit, Math.min(limit, delta[1] - 0.5)) * weight;
      residual[2] += Math.max(-limit, Math.min(limit, delta[2] - 0.5)) * weight;
      totalWeight += weight;
    }
    const normalization = totalWeight > 1 ? 1 / totalWeight : 1;
    delta[0] = mapped[0] + residual[0] * normalization;
    delta[1] = mapped[1] + residual[1] * normalization;
    delta[2] = mapped[2] + residual[2] * normalization;
    matchSkinColorTarget(red, green, blue, delta, skinWeight, skinColorTarget);
    protectSkinChroma(red, green, blue, delta, skinWeight);
    const protectedColor = hasToneGuard
      ? protectToneRangeAdaptive(red, green, blue, delta, toneGuard)
      : protectToneRange(red, green, blue, delta);
    data[index] = protectedColor[0] * 255;
    data[index + 1] = protectedColor[1] * 255;
    data[index + 2] = protectedColor[2] * 255;
  }
  return data;
}

export function residualLut(globalLut, regionalLut) {
  const data = new Float32Array(regionalLut.data.length);
  const size = regionalLut.size;
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const index = lutIndex(size, red, green, blue);
        const input = [red, green, blue].map((value) => value / (size - 1));
        const global = tetrahedralSample(globalLut, input);
        data[index] = clampUnit(0.5 + regionalLut.data[index] - global[0]);
        data[index + 1] = clampUnit(0.5 + regionalLut.data[index + 1] - global[1]);
        data[index + 2] = clampUnit(0.5 + regionalLut.data[index + 2] - global[2]);
      }
    }
  }
  return { size, data };
}

export function cubeFromLut(lut, name = "Color Engine 5") {
  const lines = [
    `TITLE "${name.replaceAll("\"", "'")}"`,
    `LUT_3D_SIZE ${lut.size}`,
    "DOMAIN_MIN 0.0 0.0 0.0",
    "DOMAIN_MAX 1.0 1.0 1.0",
  ];
  for (let index = 0; index < lut.data.length; index += 3) {
    lines.push(
      `${lut.data[index].toFixed(8)} ${lut.data[index + 1].toFixed(8)} ${lut.data[index + 2].toFixed(8)}`,
    );
  }
  return lines.join("\n");
}

export function lutFromCube(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sizeLine = lines.find((line) => line.startsWith("LUT_3D_SIZE"));
  const size = Number(sizeLine?.split(/\s+/)[1]);
  if (!Number.isInteger(size) || size < 2 || size > 65) throw new Error("无效的 CUBE 尺寸");
  const values = lines
    .filter((line) => /^[+-]?(?:\d|\.)/.test(line))
    .flatMap((line) => line.split(/\s+/).map(Number));
  if (values.length !== size ** 3 * 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("CUBE 数据不完整");
  }
  return enforceLutConstraints({ size, data: Float32Array.from(values) });
}
