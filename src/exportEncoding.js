export function rgbaToBmpBuffer(data, width, height, onProgress) {
  const headerSize = 54;
  const rowSize = width * 4;
  const buffer = new ArrayBuffer(headerSize + rowSize * height);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4d42, true);
  view.setUint32(2, buffer.byteLength, true);
  view.setUint32(10, headerSize, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(34, rowSize * height, true);
  let offset = headerSize;
  const reportEvery = Math.max(1, Math.floor(height / 20));
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      view.setUint8(offset++, data[source + 2]);
      view.setUint8(offset++, data[source + 1]);
      view.setUint8(offset++, data[source]);
      view.setUint8(offset++, data[source + 3]);
    }
    if (y % reportEvery === 0) onProgress?.((height - y) / height);
  }
  onProgress?.(1);
  return buffer;
}
