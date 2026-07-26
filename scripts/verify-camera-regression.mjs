import { readFileSync } from "node:fs";
import { analyzePixels, applyStyleProfile } from "../src/colorEngine.js";
import { applyStyleLuts } from "../src/lut3d.js";
import { qualityReport } from "../src/qualityMetrics.js";
import { buildStyleLuts } from "../src/styleLutEngine.js";

const thresholds = JSON.parse(readFileSync(
  new URL("../validation/regression-thresholds.json", import.meta.url),
  "utf8",
));
const WIDTH = 64;
const HEIGHT = 48;
const IDENTITY = Uint8Array.from({ length: 256 }, (_, value) => value);
const SETTINGS = {
  strength: 82,
  referenceLighting: 35,
  temperature: 0,
  contrast: 0,
  saturation: 0,
  grain: 0,
};

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function sourcePixel(scenario, x, y) {
  const horizontal = x / (WIDTH - 1);
  const vertical = y / (HEIGHT - 1);
  const checker = ((x >> 2) + (y >> 2)) % 2 ? 5 : -5;
  switch (scenario) {
    case "portrait": {
      const face = ((x - 32) / 18) ** 2 + ((y - 23) / 20) ** 2 < 1;
      if (face) return [194 + 28 * horizontal, 132 + 27 * vertical, 104 + 19 * vertical];
      return [62 + 74 * horizontal, 82 + 65 * vertical, 99 + 63 * horizontal];
    }
    case "sky":
      return [36 + 92 * vertical, 105 + 91 * vertical, 184 + 60 * vertical];
    case "foliage":
      return [36 + 52 * horizontal + checker, 82 + 105 * vertical, 28 + 58 * horizontal];
    case "mixed-light": {
      const value = 52 + horizontal * 170;
      return x < WIDTH / 2
        ? [value + 31, value + 8, value - 18]
        : [value - 17, value + 4, value + 34];
    }
    case "night":
      return [
        8 + horizontal * 37 + (x % 17 === 0 ? 120 : 0),
        10 + vertical * 31,
        20 + horizontal * 58 + (y % 19 === 0 ? 85 : 0),
      ];
    case "high-contrast": {
      const value = horizontal < 0.38 ? 8 + vertical * 20 : horizontal > 0.62 ? 226 + vertical * 29 : 72 + vertical * 110;
      return [value, value * 0.98, value * 0.94];
    }
    case "neutral": {
      const value = 9 + horizontal * 238;
      return [value, value, value];
    }
    default:
      return [horizontal * 255, vertical * 255, (1 - horizontal) * 255];
  }
}

function referenceStyle([red, green, blue]) {
  const light = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
  const shadow = 1 - Math.min(1, light * 2.25);
  const highlight = Math.max(0, (light - 0.52) / 0.48);
  const softLight = 10 + 226 * light ** 0.91;
  const originalLight = Math.max(1, red * 0.2126 + green * 0.7152 + blue * 0.0722);
  const scale = softLight / originalLight;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const saturation = 0.93 + Math.min(0.11, chroma / 900);
  const gray = (red + green + blue) / 3;
  return [
    gray + (red * scale - gray) * saturation + highlight * 7 - shadow * 3,
    gray + (green * scale - gray) * saturation + highlight * 2 + shadow * 1,
    gray + (blue * scale - gray) * saturation + shadow * 8 - highlight * 4,
  ].map(clampByte);
}

function makeScene(scenario) {
  const source = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const reference = new Uint8ClampedArray(source.length);
  const skinMask = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const pixel = y * WIDTH + x;
      const index = pixel * 4;
      const rgb = sourcePixel(scenario, x, y).map(clampByte);
      source.set([...rgb, 255], index);
      reference.set([...referenceStyle(rgb), 255], index);
      if (scenario === "portrait") {
        skinMask[pixel] = ((x - 32) / 18) ** 2 + ((y - 23) / 20) ** 2 < 1 ? 1 : 0;
      }
    }
  }
  return { source, reference, skinMask: scenario === "portrait" ? skinMask : null };
}

function metricLimit(baseline, ratio, allowance) {
  return baseline * ratio + allowance;
}

function verifyNotRegressed(scenario, v3, v4) {
  const rules = thresholds.maximumV4Regression;
  const comparisons = [
    ["ciede2000", rules.ciede2000Ratio, rules.ciede2000Allowance],
    ["tonePercentileDistance", rules.toneRatio, rules.toneAllowance],
    ["colorDistributionDistance", rules.distributionRatio, rules.distributionAllowance],
    ["textureSpectrumDistance", rules.textureRatio, rules.textureAllowance],
  ];
  if (v3.skinHueError !== null && v4.skinHueError !== null) {
    comparisons.push(["skinHueError", rules.skinHueRatio, rules.skinHueAllowance]);
  }
  for (const [metric, ratio, allowance] of comparisons) {
    if (v4[metric] > metricLimit(v3[metric], ratio, allowance)) {
      throw new Error(
        `${scenario} ${metric} regressed: V4 ${v4[metric]} > V3 ${v3[metric]}`,
      );
    }
  }
  const combinedClip = v4.blackClipRate + v4.whiteClipRate;
  const baselineClip = v3.blackClipRate + v3.whiteClipRate;
  if (combinedClip > baselineClip + rules.clipRateAllowance) {
    throw new Error(`${scenario} clipping regressed: ${combinedClip} > ${baselineClip}`);
  }
  if (combinedClip > thresholds.absolute.maximumCombinedClipRate) {
    throw new Error(`${scenario} exceeds absolute clipping threshold: ${combinedClip}`);
  }
  if (!Object.values(v4).every((value) => value === null || Number.isFinite(value))) {
    throw new Error(`${scenario} emitted a non-finite quality metric`);
  }
}

const scenarios = [
  "portrait",
  "sky",
  "foliage",
  "mixed-light",
  "night",
  "high-contrast",
  "neutral",
];
const results = [];
for (const scenario of scenarios) {
  const scene = makeScene(scenario);
  const sourceProfile = analyzePixels(scene.source, {
    width: WIDTH,
    height: HEIGHT,
    skipLighting: true,
  });
  const referenceProfile = analyzePixels(scene.reference, {
    width: WIDTH,
    height: HEIGHT,
    skipLighting: true,
  });
  const v3Pixels = new Uint8ClampedArray(scene.source);
  applyStyleProfile(
    v3Pixels,
    sourceProfile,
    referenceProfile,
    SETTINGS,
    [IDENTITY, IDENTITY, IDENTITY, IDENTITY],
    { width: WIDTH, height: HEIGHT },
  );
  const styleLuts = buildStyleLuts(sourceProfile, referenceProfile, SETTINGS);
  const v4Pixels = new Uint8ClampedArray(scene.source);
  applyStyleLuts(v4Pixels, WIDTH, HEIGHT, styleLuts);
  const v3 = qualityReport(scene.reference, v3Pixels, WIDTH, HEIGHT, {
    skinMask: scene.skinMask,
  });
  const v4 = qualityReport(scene.reference, v4Pixels, WIDTH, HEIGHT, {
    skinMask: scene.skinMask,
  });
  verifyNotRegressed(scenario, v3, v4);
  results.push({
    scenario,
    v3: Object.fromEntries(
      Object.entries(v3).map(([key, value]) => [key, value === null ? null : Number(value.toFixed(4))]),
    ),
    v4: Object.fromEntries(
      Object.entries(v4).map(([key, value]) => [key, value === null ? null : Number(value.toFixed(4))]),
    ),
  });
}

console.log("Seven-scenario camera regression verification passed");
console.log(JSON.stringify(results, null, 2));
