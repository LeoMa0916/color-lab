import assert from "node:assert/strict";
import {
  applyStyleLuts,
  createIdentityLut,
  cubeFromLut,
  enforceLutConstraints,
  lutFromCube,
  residualLut,
  smoothLut,
  tetrahedralSample,
} from "../src/lut3d.js";
import { deserializeClstyle, serializeClstyle } from "../src/styleStore.js";

const identity = createIdentityLut(33);
let maximumIdentityError = 0;
for (let index = 0; index < 200; index += 1) {
  const input = [
    ((index * 37) % 199) / 198,
    ((index * 71 + 13) % 197) / 196,
    ((index * 113 + 29) % 193) / 192,
  ];
  const output = tetrahedralSample(identity, input);
  maximumIdentityError = Math.max(
    maximumIdentityError,
    ...input.map((value, channel) => Math.abs(value - output[channel])),
  );
}
assert.ok(maximumIdentityError < 2e-7, "tetrahedral identity interpolation must be exact");

const shaped = createIdentityLut(17);
for (let index = 0; index < shaped.data.length; index += 3) {
  shaped.data[index] = shaped.data[index] ** 0.92;
  shaped.data[index + 1] = shaped.data[index + 1] ** 1.04;
  shaped.data[index + 2] = shaped.data[index + 2] ** 1.1;
}
const smooth = smoothLut(shaped, 0.1, 2);
assert.ok(Array.from(smooth.data).every(Number.isFinite), "LUT output must stay finite");
assert.ok(Array.from(smooth.data).every((value) => value >= 0 && value <= 1), "LUT stays in gamut");

const constrained = enforceLutConstraints(smooth);
let previousLight = -1;
for (let point = 0; point < constrained.size; point += 1) {
  const value = point / (constrained.size - 1);
  const color = tetrahedralSample(constrained, [value, value, value]);
  const light = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
  assert.ok(light + 1e-6 >= previousLight, "neutral ramp must remain monotonic");
  previousLight = light;
}

const cube = cubeFromLut(constrained, "V4 test");
const roundTrip = lutFromCube(cube);
let cubeError = 0;
for (let index = 0; index < roundTrip.data.length; index += 1) {
  cubeError = Math.max(cubeError, Math.abs(roundTrip.data[index] - constrained.data[index]));
}
assert.ok(cubeError <= 1e-7, "CUBE export/import round trip is bounded");

const residual = residualLut(identity, createIdentityLut(17));
const pixels = new Uint8ClampedArray([73, 129, 211, 255]);
applyStyleLuts(
  pixels,
  1,
  1,
  { global: identity, residuals: { skin: residual } },
  { width: 1, height: 1, masks: { skin: new Float32Array([1]) } },
);
assert.ok(Math.abs(pixels[0] - 73) <= 1 && Math.abs(pixels[2] - 211) <= 1);

const collapsed = createIdentityLut(17);
collapsed.data.fill(0.45);
const protectedWhite = new Uint8ClampedArray([255, 255, 255, 255]);
applyStyleLuts(
  protectedWhite,
  1,
  1,
  { global: collapsed, residuals: {} },
);
assert.ok(
  protectedWhite[0] >= 224 && protectedWhite[1] >= 224 && protectedWhite[2] >= 224,
  "last-resort tone protection must prevent a LUT from collapsing white",
);

const styleText = serializeClstyle({
  id: "test-style",
  name: "Test",
  stats: { version: 4, tone: { midtone: 128 } },
  luts: { global: constrained, residuals: { skin: residual } },
});
const restored = deserializeClstyle(styleText);
const styleEnvelope = JSON.parse(styleText);
assert.equal(styleEnvelope.schemaVersion, 6, "CLSTYLE did not advertise the 5.1 settings schema");
assert.equal(styleEnvelope.engine, "Color Engine 5.1");
assert.ok(restored.luts.global.data instanceof Float32Array);
assert.equal(restored.luts.global.data.length, constrained.data.length);
assert.equal(restored.luts.residuals.skin.size, 17);

const legacyStyle = deserializeClstyle(JSON.stringify({
  format: "com.colorlab.clstyle",
  schemaVersion: 4,
  engine: "Color Engine 4.3",
  style: { id: "legacy-v4", name: "Legacy", stats: { version: 4 } },
}));
assert.equal(legacyStyle.id, "legacy-v4", "V4 CLSTYLE compatibility was lost");

console.log("3D LUT verification passed", {
  maximumIdentityError,
  cubeError,
  globalNodes: identity.size ** 3,
  clstyleBytes: styleText.length,
});
