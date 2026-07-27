const REGION_META = {
  skin: { label: "肤色", color: "#ff9f8f" },
  person: { label: "人物", color: "#d6a1ff" },
  hair: { label: "头发", color: "#7c6f91" },
  clothing: { label: "服装", color: "#6fa8ff" },
  sky: { label: "天空", color: "#6dc8ff" },
  foliage: { label: "植物", color: "#6ed889" },
  neutral: { label: "中性色", color: "#c7cbd1" },
  specular: { label: "高光反射", color: "#fff0b0" },
};

let segmenterPromise = null;

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

function rgbMetrics(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return {
    hue,
    saturation: maximum ? delta / maximum : 0,
    luminance: (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255,
  };
}

function blurMask(mask, width, height) {
  const output = new Float32Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const sampleY = Math.min(height - 1, Math.max(0, y + offsetY));
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const sampleX = Math.min(width - 1, Math.max(0, x + offsetX));
          total += mask[sampleY * width + sampleX];
          count += 1;
        }
      }
      output[y * width + x] = total / count;
    }
  }
  return output;
}

function topConnectedMask(candidate, width, height) {
  const connected = new Float32Array(candidate.length);
  const queue = new Int32Array(candidate.length);
  let head = 0;
  let tail = 0;
  const enqueue = (pixel) => {
    if (!candidate[pixel] || connected[pixel]) return;
    connected[pixel] = candidate[pixel];
    queue[tail] = pixel;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) enqueue(x);
  while (head < tail) {
    const pixel = queue[head];
    head += 1;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (y > 0) enqueue(pixel - width);
    if (y + 1 < height) enqueue(pixel + width);
  }
  return connected;
}

function resampleCategoryMask(categoryMask, width, height) {
  if (!categoryMask) return null;
  const source = categoryMask.getAsUint8Array();
  const sourceWidth = categoryMask.width || width;
  const sourceHeight = categoryMask.height || height;
  if (source.length === width * height) return new Uint8Array(source);
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(
      sourceHeight - 1,
      Math.floor(y / height * sourceHeight),
    );
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        sourceWidth - 1,
        Math.floor(x / width * sourceWidth),
      );
      output[y * width + x] = source[sourceY * sourceWidth + sourceX];
    }
  }
  return output;
}

async function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "/models/selfie_multiclass_256x256.tflite",
          delegate: "GPU",
        },
        runningMode: "IMAGE",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })().catch((error) => {
      segmenterPromise = null;
      throw error;
    });
  }
  return segmenterPromise;
}

export function createHeuristicSemanticMasks(data, width, height, categoryMask = null) {
  const masks = Object.fromEntries(
    Object.keys(REGION_META).map((id) => [id, new Float32Array(width * height)]),
  );
  const skyCandidate = new Float32Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const { hue, saturation, luminance } = rgbMetrics(red, green, blue);
    const y = Math.floor(pixel / width) / Math.max(1, height - 1);
    const category = categoryMask?.[pixel] ?? 0;
    const heuristicSkin = red > 45
      && green > 28
      && blue > 18
      && red > green * 1.05
      && red > blue * 1.12
      && hue <= 58
      && saturation >= 0.08
      && saturation <= 0.72;
    const semanticSkin = category === 2 || category === 3;
    masks.skin[pixel] = semanticSkin
      ? 1
      : !categoryMask && heuristicSkin
        ? 0.58
        : 0;
    masks.person[pixel] = category >= 1 && category <= 5
      ? 1
      : !categoryMask
        ? masks.skin[pixel] * 0.35
        : 0;
    masks.hair[pixel] = category === 1 ? 1 : 0;
    masks.clothing[pixel] = category === 4 ? 1 : 0;
    masks.foliage[pixel] = hue >= 68
      && hue <= 178
      && saturation >= 0.14
      && green >= red * 1.01
      ? clampUnit((saturation - 0.1) * 2.4)
      : 0;
    masks.neutral[pixel] = saturation <= 0.105
      && luminance >= 0.045
      && luminance <= 0.965
      ? clampUnit(1 - saturation / 0.105)
      : 0;
    masks.specular[pixel] = luminance >= 0.84 && saturation <= 0.22
      ? clampUnit((luminance - 0.84) / 0.14) * clampUnit(1 - saturation / 0.22)
      : 0;
    const skyColor = (
      (hue >= 178 && hue <= 258 && saturation >= 0.07)
      || (blue >= red * 1.08 && blue >= green * 0.96)
    );
    skyCandidate[pixel] = y <= 0.8 && skyColor && luminance >= 0.18
      ? clampUnit((0.88 - y) * 1.8) * clampUnit(0.35 + saturation)
      : 0;
  }
  masks.sky = topConnectedMask(skyCandidate, width, height);
  Object.keys(masks).forEach((id) => {
    masks[id] = blurMask(masks[id], width, height);
  });
  return masks;
}

function summarizeMasks(masks) {
  const regions = {};
  Object.entries(masks).forEach(([id, mask]) => {
    let total = 0;
    let strong = 0;
    for (let index = 0; index < mask.length; index += 1) {
      total += mask[index];
      if (mask[index] >= 0.45) strong += 1;
    }
    regions[id] = {
      id,
      ...REGION_META[id],
      coverage: total / Math.max(1, mask.length),
      confidence: strong / Math.max(1, mask.length),
    };
  });
  return regions;
}

function timeoutAfter(milliseconds) {
  return new Promise((_, reject) => {
    globalThis.setTimeout(
      () => reject(new DOMException("语义模型加载超时，已切换快速分析", "TimeoutError")),
      milliseconds,
    );
  });
}

export async function analyzeSemanticCanvas(
  canvas,
  { timeoutMs = 6500, heuristicOnly = false } = {},
) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  let categoryMask = null;
  let model = "heuristic";
  try {
    if (heuristicOnly) throw new DOMException("快速分析", "AbortError");
    const segmenter = await Promise.race([
      getSegmenter(),
      timeoutAfter(timeoutMs),
    ]);
    const result = segmenter.segment(canvas);
    categoryMask = resampleCategoryMask(result.categoryMask, canvas.width, canvas.height);
    result.categoryMask?.close?.();
    model = "mediapipe-local";
  } catch {
    categoryMask = null;
  }
  const masks = createHeuristicSemanticMasks(
    imageData.data,
    canvas.width,
    canvas.height,
    categoryMask,
  );
  const regions = summarizeMasks(masks);
  const detectedCoverage = Object.values(regions)
    .filter((region) => region.id !== "neutral")
    .reduce((sum, region) => sum + region.coverage, 0);
  return {
    version: 1,
    width: canvas.width,
    height: canvas.height,
    model,
    confidence: clampUnit(
      (model === "mediapipe-local" ? 0.62 : 0.35) + Math.min(0.28, detectedCoverage),
    ),
    masks,
    regions,
  };
}

export function semanticRegionMeta() {
  return REGION_META;
}
