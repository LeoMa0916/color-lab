import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

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
const indexHtml = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const heroVideo = new URL("../dist/media/color-lab-hero.mp4", import.meta.url);
assert(assets.some((name) => name.startsWith("engine.worker-")), "Engine Worker bundle is missing");
assert(assets.some((name) => name.endsWith(".wasm")), "LibRaw WASM bundle is missing");
assert(assets.some((name) => name.endsWith(".woff2")), "Local Geist font bundle is missing");
assert(existsSync(heroVideo), "Local landing video is missing");
assert(statSync(heroVideo).size > 7_000_000, "Local landing video is incomplete");
const scripts = assets
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(new URL(name, assetDirectory), "utf8"))
  .join("\n");
const styles = assets
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(new URL(name, assetDirectory), "utf8"))
  .join("\n");
const productionText = `${indexHtml}\n${scripts}\n${styles}`;
assert(scripts.includes("Color Engine 4"), "Production bundle does not identify Color Engine 4");
assert(scripts.includes("参考驱动近似"), "Calibration disclosure is missing from production bundle");
assert(scripts.includes("RAW 预览模式"), "RAW fallback disclosure is missing");
assert(scripts.includes("worker-cpu"), "CPU compatibility backend is missing");
assert(scripts.includes("/media/color-lab-hero.mp4"), "Landing page does not use the local video");
assert(!productionText.includes("fonts.googleapis.com"), "Google Fonts is still a runtime dependency");
assert(!productionText.includes("cloudfront.net"), "CloudFront is still a runtime dependency");

console.log("Production bundle verification passed", {
  worker: assets.find((name) => name.startsWith("engine.worker-")),
  wasm: assets.find((name) => name.endsWith(".wasm")),
  font: assets.find((name) => name.endsWith(".woff2")),
  localHeroVideoBytes: statSync(heroVideo).size,
  externalLandingDependencies: 0,
  calibrationDisclosure: true,
});
