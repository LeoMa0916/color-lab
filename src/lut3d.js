function clampUnit(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
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
  return { size, data };
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
  const i000 = lutIndex(lut.size, red, green, blue);
  const i100 = lutIndex(lut.size, red + 1, green, blue);
  const i010 = lutIndex(lut.size, red, green + 1, blue);
  const i001 = lutIndex(lut.size, red, green, blue + 1);
  const i110 = lutIndex(lut.size, red + 1, green + 1, blue);
  const i101 = lutIndex(lut.size, red + 1, green, blue + 1);
  const i011 = lutIndex(lut.size, red, green + 1, blue + 1);
  const i111 = lutIndex(lut.size, red + 1, green + 1, blue + 1);
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

export function applyStyleLuts(data, width, height, styleLuts, semanticMasks = null) {
  const residualEntries = Object.entries(styleLuts.residuals || {});
  const mapped = [0, 0, 0];
  const delta = [0, 0, 0];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    if (data[index + 3] < 16) continue;
    const red = data[index] / 255;
    const green = data[index + 1] / 255;
    const blue = data[index + 2] / 255;
    tetrahedralSampleInto(styleLuts.global, red, green, blue, mapped);
    let totalWeight = 0;
    const residual = [0, 0, 0];
    residualEntries.forEach(([region, lut]) => {
      const weight = clampUnit(maskValue(semanticMasks, region, pixel, width, height));
      if (weight < 0.01) return;
      tetrahedralSampleInto(lut, red, green, blue, delta);
      residual[0] += (delta[0] - 0.5) * weight;
      residual[1] += (delta[1] - 0.5) * weight;
      residual[2] += (delta[2] - 0.5) * weight;
      totalWeight += weight;
    });
    const normalization = totalWeight > 1 ? 1 / totalWeight : 1;
    data[index] = clampUnit(mapped[0] + residual[0] * normalization) * 255;
    data[index + 1] = clampUnit(mapped[1] + residual[1] * normalization) * 255;
    data[index + 2] = clampUnit(mapped[2] + residual[2] * normalization) * 255;
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

export function cubeFromLut(lut, name = "Color Engine 4") {
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
