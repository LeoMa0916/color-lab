import assert from "node:assert/strict";
import { createZipBlob } from "../src/zipEncoding.js";

const files = [
  { name: "第一张-ColorLab.jpg", blob: new Blob(["first-image"]) },
  { name: "second-ColorLab.png", blob: new Blob(["second-image"]) },
];
const zip = await createZipBlob(files);
const bytes = new Uint8Array(await zip.arrayBuffer());
const view = new DataView(bytes.buffer);
const decoder = new TextDecoder();
const extracted = [];
let offset = 0;

while (view.getUint32(offset, true) === 0x04034b50) {
  const compressedSize = view.getUint32(offset + 18, true);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const nameStart = offset + 30;
  const dataStart = nameStart + nameLength + extraLength;
  extracted.push({
    name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
    content: decoder.decode(bytes.subarray(dataStart, dataStart + compressedSize)),
  });
  offset = dataStart + compressedSize;
}

assert.deepEqual(extracted, [
  { name: "第一张-ColorLab.jpg", content: "first-image" },
  { name: "second-ColorLab.png", content: "second-image" },
]);
assert.equal(view.getUint32(offset, true), 0x02014b50, "ZIP central directory is missing");
assert.equal(
  view.getUint32(bytes.length - 22, true),
  0x06054b50,
  "ZIP end-of-directory record is missing",
);

console.log("Batch ZIP export verification passed", {
  files: extracted.map((item) => item.name),
  bytes: bytes.length,
});
