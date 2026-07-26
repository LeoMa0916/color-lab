import assert from "node:assert/strict";
import {
  imageFrameToRgba8,
  linearSrgbToProPhoto,
  proPhotoToLinearSrgb,
  raw16ToPreviewFrame,
} from "../src/imageFrame.js";

const ramp = new Uint16Array(1024 * 3);
for (let index = 0; index < 1024; index += 1) {
  const value = Math.round(index / 1023 * 65535);
  ramp[index * 3] = value;
  ramp[index * 3 + 1] = value;
  ramp[index * 3 + 2] = value;
}
const frame = raw16ToPreviewFrame({
  width: 1024,
  height: 1,
  colors: 3,
  bits: 16,
  data: ramp,
});
assert.equal(frame.workingSpace, "linear-prophoto-rgb");
assert.equal(frame.bitDepth, 16);
assert.ok(
  new Set(Array.from(frame.pixels.filter((_, index) => index % 3 === 0))).size > 256,
  "16-bit working frame must retain more than 256 effective levels",
);

const testColor = [0.18, 0.42, 0.73];
const roundTrip = proPhotoToLinearSrgb(linearSrgbToProPhoto(testColor));
const maximumMatrixError = Math.max(
  ...testColor.map((value, index) => Math.abs(value - roundTrip[index])),
);
assert.ok(maximumMatrixError < 0.0002, "sRGB/ProPhoto matrix round trip must stay accurate");

const highlightRamp = new Uint16Array([
  58982, 58982, 58982,
  62258, 62258, 62258,
  64879, 64879, 64879,
  65535, 65535, 65535,
]);
const highlightFrame = raw16ToPreviewFrame({
  width: 4,
  height: 1,
  colors: 3,
  bits: 16,
  data: highlightRamp,
});
const preview = imageFrameToRgba8(highlightFrame);
assert.ok(preview[0] < preview[4] && preview[4] <= preview[8], "highlights remain monotonic");
assert.ok(preview[0] < 255, "conversion must not newly clip sub-white highlights");

console.log("Color management verification passed", {
  effectiveLevels: new Set(Array.from(frame.pixels.filter((_, index) => index % 3 === 0))).size,
  maximumMatrixError,
  highlightCodes: [preview[0], preview[4], preview[8], preview[12]],
});
