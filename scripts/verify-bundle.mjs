import { existsSync, readdirSync, readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(existsSync(new URL("../dist/index.html", import.meta.url)), "Production build is missing");
assert(
  existsSync(new URL("../public/models/selfie_multiclass_256x256.tflite", import.meta.url)),
  "Local semantic model is missing",
);
const assetDirectory = new URL("../dist/assets/", import.meta.url);
const assets = readdirSync(assetDirectory);
assert(assets.some((name) => name.startsWith("engine.worker-")), "Engine Worker bundle is missing");
assert(assets.some((name) => name.endsWith(".wasm")), "LibRaw WASM bundle is missing");
const scripts = assets
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(new URL(name, assetDirectory), "utf8"))
  .join("\n");
assert(scripts.includes("Color Engine 4"), "Production bundle does not identify Color Engine 4");
assert(scripts.includes("参考驱动近似"), "Calibration disclosure is missing from production bundle");
assert(scripts.includes("RAW 预览模式"), "RAW fallback disclosure is missing");
assert(scripts.includes("worker-cpu"), "CPU compatibility backend is missing");

console.log("Production bundle verification passed", {
  worker: assets.find((name) => name.startsWith("engine.worker-")),
  wasm: assets.find((name) => name.endsWith(".wasm")),
  calibrationDisclosure: true,
});
