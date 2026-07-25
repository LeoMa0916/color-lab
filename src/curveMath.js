function clampByte(value) {
  return Math.min(255, Math.max(0, value));
}

export function smoothCurveLut(points) {
  const sorted = [...points]
    .map((point) => ({ x: clampByte(point.x), y: clampByte(point.y) }))
    .sort((a, b) => a.x - b.x);
  const slopes = sorted.slice(0, -1).map((point, index) => {
    const next = sorted[index + 1];
    return (next.y - point.y) / Math.max(1, next.x - point.x);
  });
  const tangents = sorted.map((_, index) => {
    if (index === 0) return slopes[0] ?? 0;
    if (index === sorted.length - 1) return slopes.at(-1) ?? 0;
    const previousSlope = slopes[index - 1];
    const nextSlope = slopes[index];
    if (!previousSlope || !nextSlope || previousSlope * nextSlope <= 0) return 0;
    const previousWidth = sorted[index].x - sorted[index - 1].x;
    const nextWidth = sorted[index + 1].x - sorted[index].x;
    const firstWeight = 2 * nextWidth + previousWidth;
    const secondWeight = nextWidth + 2 * previousWidth;
    return (firstWeight + secondWeight)
      / (firstWeight / previousSlope + secondWeight / nextSlope);
  });

  const lut = new Uint8Array(256);
  let segment = 0;
  for (let input = 0; input < 256; input += 1) {
    while (segment < sorted.length - 2 && input > sorted[segment + 1].x) segment += 1;
    const start = sorted[segment];
    const end = sorted[Math.min(segment + 1, sorted.length - 1)];
    const width = Math.max(1, end.x - start.x);
    const amount = Math.min(1, Math.max(0, (input - start.x) / width));
    const amount2 = amount * amount;
    const amount3 = amount2 * amount;
    const value = (2 * amount3 - 3 * amount2 + 1) * start.y
      + (amount3 - 2 * amount2 + amount) * width * tangents[segment]
      + (-2 * amount3 + 3 * amount2) * end.y
      + (amount3 - amount2) * width * tangents[Math.min(segment + 1, tangents.length - 1)];
    const lower = Math.min(start.y, end.y);
    const upper = Math.max(start.y, end.y);
    lut[input] = Math.round(clampByte(Math.min(upper, Math.max(lower, value))));
  }
  return lut;
}

export function applyCurveLuts(data, curves) {
  const master = smoothCurveLut(curves.master);
  const channels = [
    smoothCurveLut(curves.red),
    smoothCurveLut(curves.green),
    smoothCurveLut(curves.blue),
  ];
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 16) continue;
    data[index] = channels[0][master[data[index]]];
    data[index + 1] = channels[1][master[data[index + 1]]];
    data[index + 2] = channels[2][master[data[index + 2]]];
  }
  return data;
}
