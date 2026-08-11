import {
  ArrowCounterClockwise,
  CaretDown,
  Check,
  DownloadSimple,
  ImageSquare,
  Minus,
  Plus,
  SlidersHorizontal,
  Sparkle,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import LibRaw from "libraw-wasm";
import {
  CircleCheck,
  Cloud,
  CloudOff,
  FolderOpen,
  History,
  Images,
  LogOut,
  Maximize2,
  RefreshCw,
  Square,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  HUE_BANDS,
  analyzePixels,
  averageProfiles,
  makePalette,
} from "./colorEngine";
import { applyBasicAdjustments } from "./basicAdjustments";
import { applyCurveLuts, smoothCurveLut as curveLut } from "./curveMath";
import {
  imageFrameToCanvas,
  raw16ToPreviewFrame,
  raw16ToRgba8,
} from "./imageFrame";
import { analyzeSemanticCanvas } from "./semanticEngine";
import { applyStyleLuts, cubeFromLut } from "./lut3d";
import { buildStyleLuts, profileFingerprint } from "./styleLutEngine";
import {
  deleteStyle,
  deserializeClstyle,
  loadStyles,
  saveStyle,
  serializeClstyle,
} from "./styleStore";
import { applyTextureMatch } from "./textureEngine";
import { createZipBlob } from "./zipEncoding";
import { engineWorker } from "./engineClient";
import {
  createRenderPipeline,
  detectRenderBackend,
  recommendedPreviewSide,
} from "./renderBackend";
import calibrationResults from "../validation/calibration-results.json";
import {
  cloudAssetUrl,
  deleteCloudAsset,
  deleteCloudStyle,
  listCloudAssets,
  listCloudStyles,
  saveCloudStyle,
  uploadCloudAsset,
} from "./cloudClient";

const IS_MOBILE = typeof navigator !== "undefined"
  && (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || navigator.maxTouchPoints > 2);
const RENDER_BACKEND = detectRenderBackend();
const RENDER_PIPELINE = createRenderPipeline(engineWorker);
const MAX_SIDE = recommendedPreviewSide(
  RENDER_BACKEND,
  typeof navigator !== "undefined" ? navigator.deviceMemory || 4 : 4,
  IS_MOBILE,
);

function formatCloudSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function formatCloudDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function canPreviewCloudAsset(asset) {
  const extension = String(asset.name || "").toLowerCase().split(".").pop();
  return String(asset.contentType || "").startsWith("image/")
    && ["avif", "gif", "jpeg", "jpg", "png", "webp"].includes(extension);
}

const CHANNELS = [
  { id: "master", label: "总体", color: "#f5f5f7" },
  { id: "red", label: "红", color: "#ff5d57" },
  { id: "green", label: "绿", color: "#62d46f" },
  { id: "blue", label: "蓝", color: "#5b8cff" },
];
const BASIC_DEFAULTS = {
  referenceLighting: 35,
  grainSize: 1,
  grainRoughness: 50,
  grainColor: 12,
  grainHighlights: 25,
  grainSeed: 1847,
  tint: 0,
  exposure: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
};
const BASIC_RESET_VALUES = {
  ...BASIC_DEFAULTS,
  temperature: 0,
  contrast: 0,
  saturation: 0,
};
const PRESETS = {
  faithful: { ...BASIC_DEFAULTS, label: "忠于参考", strength: 82, contrast: 0, saturation: 0, temperature: 0, grain: 0 },
  balanced: { ...BASIC_DEFAULTS, label: "自然平衡", strength: 68, contrast: -4, saturation: -2, temperature: -5, grain: 6 },
  cinema: {
    ...BASIC_DEFAULTS,
    label: "电影感",
    strength: 76,
    contrast: 12,
    saturation: -8,
    temperature: 8,
    clarity: 6,
    dehaze: 5,
    grain: 18,
  },
};
const DEFAULT_CURVES = {
  master: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
};
const CURVE_PREVIEW_MAX_SIDE = 720;
const ANALYSIS_MAX_SIDE = IS_MOBILE ? 288 : 384;
const RAW_EXTENSIONS = new Set([
  "3fr", "ari", "arw", "bay", "braw", "cap", "cr2", "cr3", "crw", "dcr",
  "dcs", "dng", "drf", "eip", "erf", "fff", "gpr", "iiq", "k25", "kdc",
  "mdc", "mef", "mos", "mrw", "nef", "nrw", "obm", "orf", "pef", "ptx",
  "pxn", "r3d", "raf", "raw", "rwl", "rw2", "rwz", "sr2", "srf", "srw",
  "x3f",
]);
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,.dng,.cr2,.cr3,.nef,.nrw,.arw,.srf,.sr2,.raf,.orf,.rw2,.rwl,.pef,.srw,.3fr,.fff,.iiq,.x3f,.raw";

function clamp(value, min = 0, max = 255) {
  return Math.min(max, Math.max(min, value));
}

function defaultSettings() {
  return {
    preset: "balanced",
    strength: 68,
    temperature: -5,
    contrast: -4,
    saturation: -2,
    grain: 6,
    ...BASIC_DEFAULTS,
    curves: structuredClone(DEFAULT_CURVES),
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function fileExtension(file) {
  return file.name.split(".").pop()?.toLowerCase() || "";
}

function isRawFile(file) {
  return RAW_EXTENSIONS.has(fileExtension(file));
}

function readFileBuffer(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size;
      onProgress?.({
        stage: "读取文件",
        progress: total ? event.loaded / total * 0.55 : 0.08,
        loaded: event.loaded,
        total,
      });
    };
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.onabort = () => reject(new DOMException("文件读取已取消", "AbortError"));
    reader.onload = () => {
      onProgress?.({
        stage: "读取完成",
        progress: 0.55,
        loaded: file.size,
        total: file.size,
      });
      resolve(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(file);
  });
}

function encodedRasterDimensions(bytes, type) {
  if (type === "image/png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type !== "image/jpeg" || bytes.length < 12) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const size = (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
        .includes(marker)
    ) {
      return {
        height: (bytes[offset + 5] << 8) + bytes[offset + 6],
        width: (bytes[offset + 7] << 8) + bytes[offset + 8],
      };
    }
    if (!size || size < 2) break;
    offset += size + 2;
  }
  return null;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("预览图生成失败")),
      type,
      quality,
    );
  });
}

async function decodeRasterPreview(file, bytes, maxSide, onProgress) {
  const blob = new Blob([bytes], { type: file.type });
  const dimensions = encodedRasterDimensions(bytes, file.type);
  const bitmapOptions = { imageOrientation: "from-image" };
  if (dimensions?.width && dimensions?.height) {
    const scale = Math.min(1, maxSide / Math.max(dimensions.width, dimensions.height));
    bitmapOptions.resizeWidth = Math.max(1, Math.round(dimensions.width * scale));
    bitmapOptions.resizeHeight = Math.max(1, Math.round(dimensions.height * scale));
    bitmapOptions.resizeQuality = "high";
  }
  onProgress?.({ stage: "解码并缩放预览", progress: 0.68, loaded: file.size, total: file.size });
  let bitmap;
  if (typeof createImageBitmap === "function") {
    bitmap = await withTimeout(
      createImageBitmap(blob, bitmapOptions),
      IS_MOBILE ? 12000 : 30000,
      "照片解码超时，请尝试尺寸较小的文件",
    );
  } else {
    const url = URL.createObjectURL(blob);
    try {
      bitmap = await loadImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const decodedWidth = bitmap.width;
  const decodedHeight = bitmap.height;
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  onProgress?.({ stage: "编码工作预览", progress: 0.9, loaded: file.size, total: file.size });
  const previewType = file.type === "image/png" ? "image/png" : "image/jpeg";
  const preview = await canvasToBlob(canvas, previewType, 0.94);
  onProgress?.({ stage: "预览已就绪", progress: 1, loaded: file.size, total: file.size });
  return {
    url: URL.createObjectURL(preview),
    raw: false,
    sourceFile: file,
    metadata: {
      width: dimensions?.width || decodedWidth,
      height: dimensions?.height || decodedHeight,
      preview: "browser-color-managed",
      bitDepth: 8,
      workingSpace: "sRGB → Linear ProPhoto RGB",
    },
  };
}

async function decodeRawCanvas(
  file,
  maxSide = MAX_SIDE,
  allowEmbeddedFallback = true,
  { bytes = null, onProgress } = {},
) {
  const raw = new LibRaw();
  try {
    const sourceBytes = bytes || await readFileBuffer(file, onProgress);
    onProgress?.({
      stage: "初始化 RAW 解码器",
      progress: 0.62,
      loaded: file.size,
      total: file.size,
    });
    await withTimeout(
      raw.open(sourceBytes, {
        useCameraWb: true,
        useCameraMatrix: 3,
        outputColor: 4,
        outputBps: 16,
        halfSize: false,
        noAutoBright: true,
        gamm: [1, 1],
        highlight: 5,
        userQual: 3,
      }),
      IS_MOBILE ? 12000 : 45000,
      "RAW 初始化超时",
    );
    onProgress?.({
      stage: "读取 RAW 元数据",
      progress: 0.69,
      loaded: file.size,
      total: file.size,
    });
    const metadata = await raw.metadata(false);
    const rawWidth = metadata?.width || metadata?.raw_width || 0;
    const rawHeight = metadata?.height || metadata?.raw_height || 0;
    if (IS_MOBILE && rawWidth * rawHeight > 26000000) {
      throw new Error("这张超大 RAW 建议在桌面 Chrome 或 Edge 中处理");
    }
    try {
      onProgress?.({
        stage: "解码 16-bit RAW",
        progress: 0.74,
        loaded: file.size,
        total: file.size,
      });
      const decoded = await withTimeout(
        raw.imageData(),
        IS_MOBILE ? 22000 : 90000,
        "完整 RAW 解码超时",
      );
      if (!decoded?.data || !decoded.width || !decoded.height) {
        throw new Error("RAW 文件没有可用的图像数据");
      }
      let canvas;
      if (Number.isFinite(maxSide) && maxSide <= MAX_SIDE) {
        const frame = raw16ToPreviewFrame(decoded, maxSide, {
          originalFile: file,
          metadata,
        });
        canvas = imageFrameToCanvas(frame);
      } else {
        const output = raw16ToRgba8(decoded, maxSide);
        canvas = document.createElement("canvas");
        canvas.width = output.width;
        canvas.height = output.height;
        canvas.getContext("2d").putImageData(
          new ImageData(output.data, output.width, output.height),
          0,
          0,
        );
      }
      onProgress?.({
        stage: "生成 RAW 工作预览",
        progress: 0.94,
        loaded: file.size,
        total: file.size,
      });
      return {
        canvas,
        metadata: {
          camera: [metadata?.camera_make, metadata?.camera_model].filter(Boolean).join(" "),
          iso: metadata?.iso_speed,
          width: decoded.width,
          height: decoded.height,
          bitDepth: decoded.bits || 16,
          preview: "full-raw",
          workingSpace: "Linear ProPhoto RGB",
        },
      };
    } catch (decodeError) {
      if (!allowEmbeddedFallback) throw decodeError;
      const thumbnail = await raw.thumbnailData();
      if (thumbnail?.format !== "jpeg" || !thumbnail.data?.length) throw decodeError;
      const url = URL.createObjectURL(new Blob([thumbnail.data], { type: "image/jpeg" }));
      try {
        const image = await loadImage(url);
        const canvas = document.createElement("canvas");
        drawSized(image, canvas, maxSide);
        return {
          canvas,
          metadata: {
            camera: [metadata?.camera_make, metadata?.camera_model].filter(Boolean).join(" "),
            iso: metadata?.iso_speed,
            width: rawWidth || image.naturalWidth,
            height: rawHeight || image.naturalHeight,
            bitDepth: 8,
            preview: "embedded",
            workingSpace: "Embedded JPEG",
          },
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } finally {
    raw.dispose();
  }
}

async function fileToAsset(file, { onProgress } = {}) {
  const bytes = await readFileBuffer(file, onProgress);
  if (isRawFile(file)) {
    const { canvas, metadata } = await decodeRawCanvas(
      file,
      MAX_SIDE,
      true,
      { bytes, onProgress },
    );
    onProgress?.({
      stage: "编码 RAW 工作预览",
      progress: 0.96,
      loaded: file.size,
      total: file.size,
    });
    const blob = await canvasToBlob(canvas, "image/png");
    onProgress?.({
      stage: "RAW 预览已就绪",
      progress: 1,
      loaded: file.size,
      total: file.size,
    });
    return {
      url: URL.createObjectURL(blob),
      raw: true,
      sourceFile: file,
      metadata,
    };
  }
  if (!file.type.startsWith("image/")) throw new Error("不支持的文件格式");
  return decodeRasterPreview(file, bytes, MAX_SIDE, onProgress);
}

function drawSized(image, canvas, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context;
}

function makeAnalysisCanvas(source, maxSide = ANALYSIS_MAX_SIDE) {
  const sourceWidth = source.naturalWidth || source.width;
  const sourceHeight = source.naturalHeight || source.height;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function waitForPaint() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = globalThis.setTimeout(
        () => reject(new DOMException(message, "TimeoutError")),
        milliseconds,
      );
    }),
  ]).finally(() => globalThis.clearTimeout(timer));
}

function makeCurvePreviewBase(base) {
  const longestSide = Math.max(base.width, base.height);
  if (longestSide <= CURVE_PREVIEW_MAX_SIDE) return base;
  const scale = CURVE_PREVIEW_MAX_SIDE / longestSide;
  const width = Math.max(1, Math.round(base.width * scale));
  const height = Math.max(1, Math.round(base.height * scale));
  const source = document.createElement("canvas");
  source.width = base.width;
  source.height = base.height;
  source.getContext("2d").putImageData(
    new ImageData(base.data, base.width, base.height),
    0,
    0,
  );
  const preview = document.createElement("canvas");
  preview.width = width;
  preview.height = height;
  const context = preview.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return {
    data: context.getImageData(0, 0, width, height).data,
    width,
    height,
  };
}

function renderAdjustedBase(base, settings, curves, canvas, outputRef) {
  let output = outputRef.current;
  if (!output || output.length !== base.data.length) {
    output = new Uint8ClampedArray(base.data.length);
    outputRef.current = output;
  }
  output.set(base.data);
  applyBasicAdjustments(output, base.width, base.height, settings);
  applyCurveLuts(output, curves);
  if (canvas.width !== base.width) canvas.width = base.width;
  if (canvas.height !== base.height) canvas.height = base.height;
  canvas.getContext("2d").putImageData(
    new ImageData(output, base.width, base.height),
    0,
    0,
  );
  return output;
}

function renderCurveBase(base, curves, canvas, outputRef) {
  let output = outputRef.current;
  if (!output || output.length !== base.data.length) {
    output = new Uint8ClampedArray(base.data.length);
    outputRef.current = output;
  }
  output.set(base.data);
  applyCurveLuts(output, curves);
  if (canvas.width !== base.width) canvas.width = base.width;
  if (canvas.height !== base.height) canvas.height = base.height;
  canvas.getContext("2d").putImageData(
    new ImageData(output, base.width, base.height),
    0,
    0,
  );
  return output;
}

async function analyzeUrl(url, { onStage } = {}) {
  onStage?.("打开工作预览", 0.06);
  await waitForPaint();
  const image = await loadImage(url);
  const canvas = makeAnalysisCanvas(image);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  onStage?.("识别人像与画面区域", 0.18);
  const semanticMasks = await analyzeSemanticCanvas(canvas, {
    timeoutMs: IS_MOBILE ? 2600 : 6500,
  });
  onStage?.(
    semanticMasks.model === "mediapipe-local"
      ? "语义区域识别完成"
      : "已切换快速区域分析",
    0.56,
  );
  await waitForPaint();
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const photoId = `analysis:${url}:${performance.now()}:${Math.random()}`;
  try {
    onStage?.("建立影调、七色与质感档案", 0.68);
    const profile = await withTimeout(
      engineWorker.run(
        "analyze",
        {
          data,
          options: { width: canvas.width, height: canvas.height, semanticMasks },
        },
        { photoId },
      ),
      IS_MOBILE ? 9000 : 18000,
      "颜色分析超时",
    );
    onStage?.("颜色档案已完成", 1);
    return profile;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    engineWorker.cancel(photoId);
    onStage?.("使用兼容模式完成颜色档案", 0.82);
    const profile = analyzePixels(data, {
      width: canvas.width,
      height: canvas.height,
      semanticMasks,
    });
    onStage?.("颜色档案已完成", 1);
    return profile;
  }
}

function downloadCanvas(canvas, name, onDone) {
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const anchor = document.createElement("a");
    anchor.download = `diaoseshi-${name.replace(/\.[^.]+$/, "")}.jpg`;
    anchor.href = URL.createObjectURL(blob);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1500);
    onDone?.();
  }, "image/jpeg", 0.94);
}

function saveBlob(blob, filename) {
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = URL.createObjectURL(blob);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1800);
}

function safeFileStem(value, fallback = "ColorLab") {
  const normalized = String(value || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/g, "");
  return normalized || fallback;
}

async function writeBlobToDirectory(directory, blob, filename) {
  if (!directory) return false;
  if (directory.queryPermission) {
    const current = await directory.queryPermission({ mode: "readwrite" });
    const permission = current === "granted"
      ? current
      : await directory.requestPermission?.({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("未获得所选文件夹的写入权限");
  }
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  return true;
}

function droppedFiles(dataTransfer) {
  const files = [];
  const seen = new Set();
  const push = (file) => {
    if (!file) return;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };
  [...(dataTransfer?.items || [])].forEach((item) => {
    if (item.kind === "file") push(item.getAsFile());
  });
  [...(dataTransfer?.files || [])].forEach(push);
  return files;
}

function xmpPreset(settings, name) {
  const value = (key) => settings[key] ?? 0;
  const tonePoints = settings.curves.master
    .map((point) => `<rdf:li>${Math.round(point.x)}, ${Math.round(point.y)}</rdf:li>`)
    .join("");
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:PresetType="Normal" crs:Name="${name}" crs:ProcessVersion="15.4"
      crs:Temperature="${value("temperature")}" crs:Tint="${value("tint")}"
      crs:Exposure2012="${value("exposure")}" crs:Contrast2012="${value("contrast")}"
      crs:Highlights2012="${value("highlights")}" crs:Shadows2012="${value("shadows")}"
      crs:Whites2012="${value("whites")}" crs:Blacks2012="${value("blacks")}"
      crs:Texture="${value("texture")}" crs:Clarity2012="${value("clarity")}"
      crs:Dehaze="${value("dehaze")}" crs:Vibrance="${value("vibrance")}"
      crs:Saturation="${value("saturation")}" crs:GrainAmount="${value("grain")}">
      <crs:ToneCurvePV2012><rdf:Seq>${tonePoints}</rdf:Seq></crs:ToneCurvePV2012>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function drawArea(context, values, color, width, height, alpha = 0.28) {
  context.beginPath();
  context.moveTo(0, height);
  values.forEach((value, index) => {
    context.lineTo((index / (values.length - 1)) * width, height - value * height * 0.9);
  });
  context.lineTo(width, height);
  context.closePath();
  context.globalAlpha = alpha;
  context.fillStyle = color;
  context.fill();
  context.globalAlpha = 0.85;
  context.strokeStyle = color;
  context.lineWidth = 1.25;
  context.stroke();
  context.globalAlpha = 1;
}

function HistogramCanvas({ histogram }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !histogram) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext("2d");
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    drawArea(context, histogram.red, "#ff544f", width, height);
    drawArea(context, histogram.green, "#4dd563", width, height);
    drawArea(context, histogram.blue, "#4f7fff", width, height);
  }, [histogram]);
  return <canvas ref={ref} className="histogram-canvas" aria-label="当前照片 RGB 直方图" />;
}

function CurveEditor({
  channel,
  points,
  histogram,
  onChange,
  onPreview,
  onInteractionChange,
}) {
  const ref = useRef(null);
  const boundsRef = useRef(null);
  const dragIndex = useRef(null);
  const livePointsRef = useRef(points);
  const pendingPoints = useRef(null);
  const previewFrame = useRef(null);
  const [livePoints, setLivePoints] = useState(points);
  const [readout, setReadout] = useState(null);
  const channelColor = CHANNELS.find((item) => item.id === channel)?.color || "#f5f5f7";

  useEffect(() => {
    if (dragIndex.current !== null) return;
    livePointsRef.current = points;
    setLivePoints(points);
  }, [channel, points]);

  useEffect(() => () => {
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
  }, []);

  function coordinates(event) {
    const rect = boundsRef.current || ref.current.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * 255),
      y: clamp((1 - (event.clientY - rect.top) / rect.height) * 255),
    };
  }

  function nearest(point) {
    let best = -1;
    let distance = 18;
    livePointsRef.current.forEach((item, index) => {
      const value = Math.hypot(item.x - point.x, item.y - point.y);
      if (value < distance) {
        best = index;
        distance = value;
      }
    });
    return best;
  }

  function queuePreview(next) {
    livePointsRef.current = next;
    pendingPoints.current = next;
    setLivePoints(next);
    if (previewFrame.current !== null) return;
    previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = null;
      if (!pendingPoints.current) return;
      onPreview(pendingPoints.current);
    });
  }

  function flushChange() {
    if (!pendingPoints.current) return;
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
    previewFrame.current = null;
    const value = pendingPoints.current;
    pendingPoints.current = null;
    onChange(value);
  }

  function handlePointerDown(event) {
    event.preventDefault();
    boundsRef.current = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = coordinates(event);
    const index = nearest(point);
    onInteractionChange?.(true);
    if (index >= 0) {
      dragIndex.current = index;
      setReadout(livePointsRef.current[index]);
    }
    else {
      const next = [...livePointsRef.current, point].sort((a, b) => a.x - b.x);
      dragIndex.current = next.findIndex((item) => item === point);
      setReadout(point);
      queuePreview(next);
    }
  }

  function handlePointerMove(event) {
    if (dragIndex.current === null) return;
    const point = coordinates(event);
    const current = livePointsRef.current;
    const next = current.map((item, index) => {
      if (index !== dragIndex.current) return item;
      if (index === 0) return { x: 0, y: point.y };
      if (index === current.length - 1) return { x: 255, y: point.y };
      return {
        x: clamp(point.x, current[index - 1].x + 2, current[index + 1].x - 2),
        y: point.y,
      };
    });
    setReadout(next[dragIndex.current]);
    queuePreview(next);
  }

  function finishInteraction(event) {
    flushChange();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    boundsRef.current = null;
    dragIndex.current = null;
    onInteractionChange?.(false);
  }

  function handleDoubleClick(event) {
    const index = nearest(coordinates(event));
    const current = livePointsRef.current;
    if (index > 0 && index < current.length - 1) {
      const next = current.filter((_, item) => item !== index);
      if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
      previewFrame.current = null;
      pendingPoints.current = null;
      livePointsRef.current = next;
      setLivePoints(next);
      setReadout(null);
      onPreview(next);
      onChange(next);
    }
  }

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    context.strokeStyle = "rgba(255,255,255,.08)";
    context.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      context.beginPath();
      context.moveTo((width / 4) * i, 0);
      context.lineTo((width / 4) * i, height);
      context.stroke();
      context.beginPath();
      context.moveTo(0, (height / 4) * i);
      context.lineTo(width, (height / 4) * i);
      context.stroke();
    }
    if (histogram?.[channel]) drawArea(context, histogram[channel], channelColor, width, height, 0.16);

    context.strokeStyle = "rgba(255,255,255,.2)";
    context.beginPath();
    context.moveTo(0, height);
    context.lineTo(width, 0);
    context.stroke();

    const lut = curveLut(livePoints);
    context.strokeStyle = channelColor;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    lut.forEach((output, input) => {
      const x = (input / 255) * width;
      const y = height - (output / 255) * height;
      if (input === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
    const sorted = [...livePoints].sort((a, b) => a.x - b.x);
    sorted.forEach((point) => {
      const x = (point.x / 255) * width;
      const y = height - (point.y / 255) * height;
      context.beginPath();
      context.arc(x, y, 5, 0, Math.PI * 2);
      context.fillStyle = channelColor;
      context.fill();
      context.strokeStyle = "#fff";
      context.lineWidth = 1;
      context.stroke();
    });
  }, [channel, channelColor, livePoints, histogram]);

  return (
    <div className="curve-wrap">
      <output className={readout ? "curve-readout active" : "curve-readout"}>
        {readout
          ? `输入 ${Math.round(readout.x)} · 输出 ${Math.round(readout.y)}`
          : "平滑点曲线"}
      </output>
      <canvas
        ref={ref}
        className="curve-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishInteraction}
        onPointerCancel={finishInteraction}
        onDoubleClick={handleDoubleClick}
        aria-label={`${CHANNELS.find((item) => item.id === channel)?.label}曲线编辑器`}
      />
      <span className="curve-zone left">暗部</span>
      <span className="curve-zone center">中间调</span>
      <span className="curve-zone right">高光</span>
    </div>
  );
}

function GlassButton({ className = "", children, ...props }) {
  return <button className={`glass-button ${className}`} {...props}>{children}</button>;
}

function Range({
  label,
  value,
  min,
  max,
  onChange,
  onPreview,
  onInteractionChange,
  signed = true,
  step = 1,
  decimals = 0,
  defaultValue = null,
  disabled = false,
}) {
  const [liveValue, setLiveValue] = useState(value);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const liveValueRef = useRef(value);
  const draggingRef = useRef(false);
  const previewFrame = useRef(null);

  useEffect(() => {
    if (draggingRef.current || editing) return;
    liveValueRef.current = value;
    setLiveValue(value);
  }, [editing, value]);

  useEffect(() => () => {
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
  }, []);

  function normalize(raw) {
    const clamped = clamp(Number(raw), min, max);
    const snapped = min + Math.round((clamped - min) / step) * step;
    return Number(snapped.toFixed(Math.max(decimals, 4)));
  }

  function format(raw) {
    const formatted = decimals ? Number(raw).toFixed(decimals) : Math.round(raw);
    return `${signed && raw > 0 ? "+" : ""}${formatted}`;
  }

  function queuePreview(next) {
    if (!onPreview) return;
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
    previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = null;
      onPreview(next);
    });
  }

  function commit(raw) {
    const next = normalize(raw);
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
    previewFrame.current = null;
    liveValueRef.current = next;
    setLiveValue(next);
    onPreview?.(next);
    onChange(next);
  }

  function handleSliderChange(event) {
    const next = normalize(event.target.value);
    liveValueRef.current = next;
    setLiveValue(next);
    if (draggingRef.current) {
      queuePreview(next);
      // Commit every drag sample to React state. The synchronous preview keeps
      // the canvas responsive, while this guarantees the final value is not
      // lost when a browser omits pointerup after scrolling or leaving the
      // slider hit area.
      onChange(next);
    } else commit(next);
  }

  function finishPointer() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    commit(liveValueRef.current);
    onInteractionChange?.(false);
  }

  function beginEditing(event) {
    if (disabled) return;
    event.preventDefault();
    setEditValue(String(liveValueRef.current));
    setEditing(true);
  }

  function commitEditing() {
    if (!editing) return;
    const parsed = Number(editValue);
    setEditing(false);
    if (Number.isFinite(parsed)) commit(parsed);
  }

  function resetToDefault() {
    if (disabled || !Number.isFinite(defaultValue)) return;
    commit(defaultValue);
  }

  return (
    <div className="range-row" data-range-label={label}>
      <button
        type="button"
        className="range-label"
        disabled={disabled || !Number.isFinite(defaultValue)}
        title={Number.isFinite(defaultValue)
          ? `双击恢复${label}默认值 ${format(defaultValue)}`
          : label}
        aria-label={Number.isFinite(defaultValue)
          ? `${label}，双击恢复默认值 ${format(defaultValue)}`
          : label}
        onDoubleClick={resetToDefault}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            resetToDefault();
          }
        }}
      >
        {label}
      </button>
      {editing ? (
        <input
          className="range-number-input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={editValue}
          aria-label={`输入${label}数值`}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={commitEditing}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setEditing(false);
              setEditValue("");
            }
          }}
        />
      ) : (
        <output
          title="双击输入数值"
          tabIndex={disabled ? -1 : 0}
          onDoubleClick={beginEditing}
          onKeyDown={(event) => {
            if (event.key === "Enter") beginEditing(event);
          }}
        >
          {format(liveValue)}
        </output>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={liveValue}
        disabled={disabled}
        aria-label={label}
        onPointerDown={(event) => {
          draggingRef.current = true;
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
          } catch {
            // Synthetic events and older mobile engines may not expose an
            // active native pointer even though slider input still works.
          }
          onInteractionChange?.(true);
        }}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onLostPointerCapture={finishPointer}
        onChange={handleSliderChange}
      />
    </div>
  );
}

const BASIC_GROUPS = [
  {
    label: "白平衡",
    controls: [
      {
        key: "referenceLighting",
        label: "参考光线",
        min: 0,
        max: 100,
        suffix: "%",
      },
      { key: "temperature", label: "色温", min: -40, max: 40 },
      { key: "tint", label: "色调", min: -100, max: 100 },
    ],
  },
  {
    label: "光线",
    controls: [
      { key: "exposure", label: "曝光度", min: -3, max: 3, step: 0.05, decimals: 2 },
      { key: "contrast", label: "对比度", min: -100, max: 100 },
      { key: "highlights", label: "高光", min: -100, max: 100 },
      { key: "shadows", label: "阴影", min: -100, max: 100 },
      { key: "whites", label: "白色色阶", min: -100, max: 100 },
      { key: "blacks", label: "黑色色阶", min: -100, max: 100 },
    ],
  },
  {
    label: "质感",
    controls: [
      { key: "texture", label: "纹理", min: -100, max: 100 },
      { key: "clarity", label: "清晰度", min: -100, max: 100 },
      { key: "dehaze", label: "去朦胧", min: -100, max: 100 },
    ],
  },
  {
    label: "色彩",
    controls: [
      { key: "vibrance", label: "鲜艳度", min: -100, max: 100 },
      { key: "saturation", label: "饱和度", min: -100, max: 100 },
    ],
  },
];

function InspectorDisclosure({
  title,
  meta = null,
  action = null,
  defaultOpen = false,
  className = "",
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId().replaceAll(":", "");
  const panelId = `inspector-${id}`;
  return (
    <section className={`inspector-disclosure ${className}`.trim()}>
      <div className="inspector-disclosure-header">
        <button
          type="button"
          className="inspector-disclosure-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{title}</span>
          {meta && <small>{meta}</small>}
          <CaretDown size={15} className={open ? "open" : ""} />
        </button>
        {action && <div className="inspector-disclosure-action">{action}</div>}
      </div>
      {open && (
        <div id={panelId} className="inspector-disclosure-body">
          {children}
        </div>
      )}
    </section>
  );
}

function BasicAdjustmentsPanel({
  settings,
  disabled,
  onChange,
  onPreview,
  onInteractionChange,
}) {
  return (
    <InspectorDisclosure title="基本" className="basic-section" defaultOpen>
      <div className="basic-adjustments">
        {BASIC_GROUPS.map((group) => (
          <div className="basic-group" key={group.label}>
            <p>{group.label}</p>
            {group.controls.map((control) => (
              <Range
                key={control.key}
                {...control}
                value={settings[control.key] ?? 0}
                defaultValue={BASIC_RESET_VALUES[control.key] ?? 0}
                disabled={disabled}
                onInteractionChange={onInteractionChange}
                onPreview={(value) => onPreview?.({
                  ...settings,
                  [control.key]: value,
                  preset: "custom",
                })}
                onChange={(value) => onChange({
                  [control.key]: value,
                  preset: "custom",
                })}
              />
            ))}
          </div>
        ))}
      </div>
    </InspectorDisclosure>
  );
}

function StyleAnalysis({ profile }) {
  if (!profile) {
    return (
      <div className="style-analysis muted-analysis">
        <p>上传参考图后分析影调、中性色、21 分区色彩与自然质感。</p>
      </div>
    );
  }
  if (profile.version < 2 || !profile.tone) {
    return (
      <div className="style-analysis muted-analysis">
        <p>这是旧版滤镜。重新上传参考图即可生成精细色彩档案。</p>
      </div>
    );
  }
  const toneMetrics = [
    ["黑位", profile.tone.blackPoint],
    ["中灰", profile.tone.midtone],
    ["白位", profile.tone.whitePoint],
  ];
  const semantic = profile.semantic;
  const lighting = profile.lighting;
  const semanticRegions = Object.values(semantic?.regions || {})
    .filter((region) => region.coverage >= 0.004)
    .sort((left, right) => right.coverage - left.coverage);
  return (
    <div className="style-analysis">
      {profile.version >= 3 && (
        <p className="profile-intent">
          {semantic
            ? "本地语义蒙版 · 区域独立色彩档案 · 低置信度安全回退"
            : "中性色独立校准 · 21 色域分区 · 自然质感匹配"}
        </p>
      )}
      {semantic && (
        <div className="calibration-summary" aria-label="相机风格校准状态">
          <div>
            <span>参考驱动近似</span>
            <small>达到 30 组跨场景样片后才标记“已校准”</small>
          </div>
          <div className="calibration-brands">
            {Object.values(calibrationResults.brands).map((brand) => (
              <span key={brand.label}>
                {brand.label}
                <strong>
                  {brand.qualifiedGroups}/{calibrationResults.minimumQualifiedGroups}
                </strong>
              </span>
            ))}
          </div>
        </div>
      )}
      {semantic && (
        <div className="semantic-summary" aria-label="语义区域识别状态">
          <div className="semantic-status">
            <span className={`semantic-indicator ${semantic.model === "mediapipe-local" ? "ready" : "fallback"}`} />
            <span>{semantic.model === "mediapipe-local" ? "本地 AI 已启用" : "启发式安全模式"}</span>
            <strong>{Math.round((semantic.confidence || 0) * 100)}%</strong>
          </div>
          <div className="semantic-regions">
            {semanticRegions.slice(0, 6).map((region) => (
              <span key={region.id} title={`画面覆盖 ${Math.round(region.coverage * 100)}%`}>
                <i style={{ background: region.color || "#9ba1ab" }} />
                {region.label}
                <b>{Math.round(region.coverage * 100)}%</b>
              </span>
            ))}
          </div>
        </div>
      )}
      {lighting && (
        <div className="lighting-summary" aria-label="参考光线分析">
          <span>
            <small>参考光源</small>
            <strong>{Math.round(lighting.temperature)}K</strong>
          </span>
          <span>
            <small>场景曝光</small>
            <strong>{lighting.exposureEV >= 0 ? "+" : ""}{lighting.exposureEV.toFixed(2)} EV</strong>
          </span>
          <span>
            <small>可信度</small>
            <strong>{Math.round(lighting.confidence * 100)}%</strong>
          </span>
        </div>
      )}
      {profile.texture?.spectrum && (
        <div className="texture-spectrum" aria-label="多尺度质感分析">
          <div>
            <span>质感频谱</span>
            <small>1 / 2 / 4 / 8 px</small>
          </div>
          <div className="texture-bars">
            {profile.texture.spectrum.map((value, index) => (
              <i key={profile.texture.scales?.[index] || index}>
                <b style={{ height: `${Math.min(100, Math.max(6, value * 1800))}%` }} />
              </i>
            ))}
          </div>
          <p>
            锐度 {Math.round(profile.texture.acutance * 100)}
            <span>·</span>
            边缘过冲 {Math.round(profile.texture.edgeOvershoot * 100)}
            <span>·</span>
            涂抹 {Math.round(profile.texture.smear * 100)}
          </p>
        </div>
      )}
      <div className="tone-metrics" aria-label="影调分析">
        {toneMetrics.map(([label, value]) => (
          <div key={label}><span>{label}</span><strong>{Math.round(value)}</strong></div>
        ))}
      </div>
      <div className="tone-zones">
        {profile.zones.map((zone) => (
          <div key={zone.id}>
            <span
              className="tone-swatch"
              style={{ background: `rgb(${zone.rgb.join(",")})` }}
            />
            <span>{zone.label}</span>
            <b>{Math.round(zone.lightness * 100)}</b>
          </div>
        ))}
      </div>
      <div className="spectrum-heading"><span>七色色谱</span><small>色相 · 浓度</small></div>
      <div className="color-spectrum">
        {profile.colors.map((color, index) => {
          const band = HUE_BANDS[index];
          const amount = Math.max(5, Math.min(100, color.chroma / 0.18 * 100));
          return (
            <div key={color.id} className="spectrum-row">
              <span>{band.label}</span>
              <i><b style={{ width: `${amount}%`, background: band.color }} /></i>
              <output>{Math.round(color.hue)}°</output>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function styleAnalysisMeta(profile) {
  if (!profile) return "等待样片";
  if (profile.version < 2 || !profile.tone) return "兼容模式";
  if (profile.semantic) return "语义区域 v4.3";
  return profile.version >= 3 ? "分区感知 v3" : "感知分析 v2";
}

export function App({ onLogout, session, username = "本机用户" }) {
  const [references, setReferences] = useState([]);
  const [referenceStats, setReferenceStats] = useState(null);
  const [targets, setTargets] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [selectedTargetIds, setSelectedTargetIds] = useState([]);
  const [referencePreview, setReferencePreview] = useState(null);
  const [stagePreviewOpen, setStagePreviewOpen] = useState(false);
  const [stagePreviewSplit, setStagePreviewSplit] = useState(50);
  const [stagePreviewZoom, setStagePreviewZoom] = useState(1);
  const [stagePreviewPan, setStagePreviewPan] = useState({ x: 0, y: 0 });
  const [dragImportActive, setDragImportActive] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [decodeStatus, setDecodeStatus] = useState("");
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [channel, setChannel] = useState("master");
  const [displayHistogram, setDisplayHistogram] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [busyTask, setBusyTask] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [activeBackend, setActiveBackend] = useState(RENDER_BACKEND.label);
  const [curveDragging, setCurveDragging] = useState(false);
  const [basicDragging, setBasicDragging] = useState(false);
  const [baseRevision, setBaseRevision] = useState(0);
  const [exported, setExported] = useState(false);
  const [importErrors, setImportErrors] = useState([]);
  const [savedStyles, setSavedStyles] = useState([]);
  const [cloudAssets, setCloudAssets] = useState([]);
  const [cloudLibraryOpen, setCloudLibraryOpen] = useState(false);
  const [cloudDeleteCandidate, setCloudDeleteCandidate] = useState(null);
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(session?.storageMode === "cloud");
  const [cloudStatus, setCloudStatus] = useState({
    state: session?.storageMode === "cloud" ? "loading" : "local",
    message: session?.storageMode === "cloud" ? "正在读取云端历史" : "本机预览不会上传照片",
  });
  const [cloudUploading, setCloudUploading] = useState(0);
  const [styleDialogOpen, setStyleDialogOpen] = useState(false);
  const [styleName, setStyleName] = useState("");
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportDirectory, setExportDirectory] = useState(null);
  const [exportOptions, setExportOptions] = useState({
    name: "diaoseshi-export",
    resolution: "original",
    format: "jpeg",
    quality: 92,
  });
  const originalCanvas = useRef(null);
  const styledCanvas = useRef(null);
  const stageOriginalPreviewCanvas = useRef(null);
  const stageStyledPreviewCanvas = useRef(null);
  const stagePreviewViewport = useRef(null);
  const stagePreviewView = useRef({ zoom: 1, pan: { x: 0, y: 0 } });
  const stagePreviewPointers = useRef(new Map());
  const stagePreviewGesture = useRef(null);
  const styledBase = useRef(null);
  const styledPreviewBase = useRef(null);
  const curveAdjustedPreviewBase = useRef(null);
  const styledOutput = useRef(null);
  const curvePreviewOutput = useRef(null);
  const semanticMaskCache = useRef(new Map());
  const styleLutCache = useRef(new Map());
  const selectionAnchor = useRef(null);
  const stagePointer = useRef(null);
  const dragDepth = useRef(0);
  const referenceInput = useRef(null);
  const targetInput = useRef(null);
  const styleInput = useRef(null);
  const active = targets.find((item) => item.id === activeId) || targets[0] || null;
  const settings = active?.settings || defaultSettings();
  const selectedTargets = useMemo(() => {
    const selected = new Set(selectedTargetIds);
    const matches = targets.filter((item) => selected.has(item.id));
    return matches.length ? matches : active ? [active] : [];
  }, [active, selectedTargetIds, targets]);
  const palette = useMemo(() => makePalette(referenceStats), [referenceStats]);
  const isReady = references.length > 0 && referenceStats && active;
  const cloudEnabled = session?.storageMode === "cloud";

  useEffect(() => {
    const containsFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
    const onDragEnter = (event) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragImportActive(true);
    };
    const onDragOver = (event) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event) => {
      if (!containsFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragImportActive(false);
    };
    const onDrop = (event) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragImportActive(false);
      const files = droppedFiles(event.dataTransfer);
      if (!files.length) {
        setImportErrors([
          "拖放来源没有向浏览器提供可读取的图片。若微信当前版本不支持直接拖出，请先将图片另存到本机后再拖入。",
        ]);
        return;
      }
      if (analyzing || isExporting) {
        setImportErrors(["请等待当前分析或导出任务完成后再导入照片。"]);
        return;
      }
      void addTargets(files);
    };
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, [analyzing, isExporting, references.length, targets.length]);

  useEffect(() => {
    if (!referencePreview && !stagePreviewOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      setReferencePreview(null);
      setStagePreviewOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [referencePreview, stagePreviewOpen]);

  useEffect(() => {
    if (!stagePreviewOpen || !originalCanvas.current || !styledCanvas.current) return;
    const copyCanvas = (source, target) => {
      if (!target) return;
      target.width = source.width;
      target.height = source.height;
      target.getContext("2d").drawImage(source, 0, 0);
    };
    copyCanvas(originalCanvas.current, stageOriginalPreviewCanvas.current);
    copyCanvas(styledCanvas.current, stageStyledPreviewCanvas.current);
  }, [stagePreviewOpen, active?.id, baseRevision]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadStyles(),
      cloudEnabled ? listCloudStyles().catch(() => []) : Promise.resolve([]),
    ])
      .then(async ([localStyles, cloudStyles]) => {
        if (cancelled) return;
        const merged = new Map();
        [...cloudStyles, ...localStyles].forEach((style) => {
          if (!merged.has(style.id)) merged.set(style.id, style);
        });
        const styles = [...merged.values()]
          .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
        setSavedStyles(styles);
        await Promise.allSettled(cloudStyles.map((style) => saveStyle(style)));
        if (cloudEnabled) {
          const cloudIds = new Set(cloudStyles.map((style) => style.id));
          await Promise.allSettled(
            localStyles
              .filter((style) => !cloudIds.has(style.id))
              .map((style) => saveCloudStyle(style)),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setImportErrors(["无法读取滤镜数据库"]);
      });
    return () => {
      cancelled = true;
    };
  }, [cloudEnabled]);

  useEffect(() => {
    if (!cloudEnabled) return undefined;
    let cancelled = false;
    listCloudAssets()
      .then((assets) => {
        if (cancelled) return;
        setCloudAssets(assets);
        setCloudStatus({
          state: "ready",
          message: assets.length ? `已同步 ${assets.length} 张云端照片` : "云端资料库已就绪",
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setCloudStatus({
          state: "error",
          message: error?.message || "无法读取云端历史",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [cloudEnabled]);

  async function refreshCloudLibrary() {
    if (!cloudEnabled) return;
    setCloudStatus({ state: "loading", message: "正在刷新云端历史" });
    try {
      const assets = await listCloudAssets();
      setCloudAssets(assets);
      setCloudStatus({
        state: "ready",
        message: assets.length ? `已同步 ${assets.length} 张云端照片` : "云端资料库已就绪",
      });
    } catch (error) {
      setCloudStatus({
        state: "error",
        message: error?.message || "无法刷新云端历史",
      });
    }
  }

  async function syncDecodedFiles(decoded, kind) {
    if (!cloudEnabled || !cloudSyncEnabled || !decoded.length) return;
    const pending = decoded.filter(({ file }) =>
      !cloudAssets.some((asset) =>
        asset.kind === kind && asset.name === file.name && asset.size === file.size));
    if (!pending.length) {
      setCloudStatus({ state: "ready", message: "这些照片已存在于云端历史" });
      return;
    }
    setCloudUploading(pending.length);
    setCloudStatus({ state: "uploading", message: `正在上传 0/${pending.length}` });
    const uploaded = [];
    const errors = [];
    for (let index = 0; index < pending.length; index += 1) {
      const { file } = pending[index];
      try {
        uploaded.push(await uploadCloudAsset(file, kind));
      } catch (error) {
        errors.push(`${file.name}：${error?.message || "云端上传失败"}`);
      }
      setCloudUploading(Math.max(0, pending.length - index - 1));
      setCloudStatus({
        state: errors.length ? "error" : "uploading",
        message: `已完成 ${index + 1}/${pending.length}`,
      });
    }
    if (uploaded.length) {
      setCloudAssets((items) => [
        ...uploaded,
        ...items.filter((item) => !uploaded.some((next) => next.id === item.id)),
      ]);
    }
    setCloudStatus({
      state: errors.length ? "error" : "ready",
      message: errors.length
        ? `${uploaded.length} 张已同步，${errors.length} 张失败`
        : `${uploaded.length} 张照片已安全同步`,
    });
    if (errors.length) setImportErrors((items) => [...errors, ...items].slice(0, 8));
  }

  async function restoreCloudAsset(asset) {
    setCloudStatus({ state: "loading", message: `正在取回 ${asset.name}` });
    try {
      const response = await fetch(cloudAssetUrl(asset.id), {
        credentials: "include",
      });
      if (!response.ok) throw new Error("无法下载这张云端照片");
      const blob = await response.blob();
      const file = new File([blob], asset.name, {
        type: asset.contentType || blob.type || "application/octet-stream",
        lastModified: asset.createdAt,
      });
      if (asset.kind === "reference") await addReferences([file]);
      else await addTargets([file]);
      setCloudLibraryOpen(false);
      setCloudStatus({ state: "ready", message: `${asset.name} 已恢复到工作台` });
    } catch (error) {
      setCloudStatus({
        state: "error",
        message: error?.message || "无法恢复云端照片",
      });
    }
  }

  async function removeCloudAsset(asset) {
    try {
      await deleteCloudAsset(asset.id);
      setCloudAssets((items) => items.filter((item) => item.id !== asset.id));
      setCloudDeleteCandidate(null);
      setCloudStatus({ state: "ready", message: `${asset.name} 已从云端删除` });
    } catch (error) {
      setCloudStatus({
        state: "error",
        message: error?.message || "无法删除云端照片",
      });
    }
  }

  async function decodeFiles(files, limit) {
    const selected = [...files].slice(0, limit);
    const decoded = [];
    const errors = [];
    for (let fileIndex = 0; fileIndex < selected.length; fileIndex += 1) {
      const file = selected[fileIndex];
      try {
        await waitForPaint();
        setBusyTask((task) => task ? {
          ...task,
          label: file.name,
          stage: isRawFile(file) ? "准备 RAW 文件" : "准备照片",
          current: fileIndex + 1,
          total: selected.length,
          bytesLoaded: 0,
          bytesTotal: file.size,
          progress: Math.round((fileIndex / Math.max(1, selected.length)) * 30),
        } : task);
        setDecodeStatus(isRawFile(file) ? `正在解码 RAW · ${file.name}` : `正在读取 · ${file.name}`);
        const asset = await fileToAsset(file, {
          onProgress: ({ stage, progress, loaded, total }) => {
            const overall = (
              fileIndex + Math.min(1, Math.max(0, progress))
            ) / Math.max(1, selected.length);
            setBusyTask((task) => task ? {
              ...task,
              label: file.name,
              stage,
              current: fileIndex + 1,
              total: selected.length,
              bytesLoaded: loaded,
              bytesTotal: total || file.size,
              progress: Math.max(task.progress || 0, Math.round(overall * 30)),
            } : task);
            setDecodeStatus(`${stage} · ${file.name}`);
          },
        });
        decoded.push({ file, asset });
      } catch (error) {
        errors.push(`${file.name}：${error.message || "无法解码"}`);
      }
    }
    setDecodeStatus("");
    setImportErrors(errors);
    return decoded;
  }

  async function analyzeItemsSequentially(items, subject) {
    const stats = [];
    const total = Math.max(1, items.length);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.stats) {
        stats.push(item.stats);
        setBusyTask((task) => task ? {
          ...task,
          label: item.name,
          stage: `${subject}已有颜色档案`,
          current: index + 1,
          total,
          bytesLoaded: null,
          bytesTotal: null,
          progress: 30 + Math.round((index + 1) / total * 68),
        } : task);
        continue;
      }
      await waitForPaint();
      const profile = await analyzeUrl(item.url, {
        onStage: (stage, localProgress) => {
          const progress = 30 + Math.round(
            (index + Math.min(1, Math.max(0, localProgress))) / total * 68,
          );
          setBusyTask((task) => task ? {
            ...task,
            label: item.name,
            stage,
            current: index + 1,
            total,
            bytesLoaded: null,
            bytesTotal: null,
            progress: Math.max(task.progress || 0, progress),
          } : task);
          setDecodeStatus(`${stage} · ${item.name}`);
        },
      });
      stats.push(profile);
    }
    setDecodeStatus("");
    return stats;
  }

  function updateActiveSettings(patch) {
    if (!active) return;
    setTargets((items) =>
      items.map((item) => item.id === active.id
        ? { ...item, settings: { ...item.settings, ...patch } }
        : item),
    );
  }

  async function getStyleLuts(
    source,
    reference,
    options = {},
    renderSettings = settings,
    photoId = active?.id,
  ) {
    const key = JSON.stringify({
      engine: "4.3-ab-cl-grid",
      source: profileFingerprint(source),
      reference: profileFingerprint(reference),
      strength: renderSettings.strength,
      referenceLighting: renderSettings.referenceLighting,
      adjustments: options.includeAdjustments
        ? {
          temperature: renderSettings.temperature,
          tint: renderSettings.tint,
          exposure: renderSettings.exposure,
          contrast: renderSettings.contrast,
          highlights: renderSettings.highlights,
          shadows: renderSettings.shadows,
          whites: renderSettings.whites,
          blacks: renderSettings.blacks,
          vibrance: renderSettings.vibrance,
          saturation: renderSettings.saturation,
          dehaze: renderSettings.dehaze,
          curves: renderSettings.curves,
        }
        : false,
    });
    if (!styleLutCache.current.has(key)) {
      if (styleLutCache.current.size >= 8) styleLutCache.current.clear();
      const task = engineWorker.run(
        "build-luts",
        { source, reference, settings: renderSettings, options },
        { photoId: `lut:${photoId || "style"}:${options.includeAdjustments ? "export" : "preview"}` },
      ).catch((error) => {
        if (error?.name === "AbortError") throw error;
        return buildStyleLuts(source, reference, renderSettings, options);
      });
      styleLutCache.current.set(key, task);
    }
    try {
      const luts = await styleLutCache.current.get(key);
      styleLutCache.current.set(key, Promise.resolve(luts));
      return luts;
    } catch (error) {
      styleLutCache.current.delete(key);
      throw error;
    }
  }

  async function createStylePayload(name) {
    const luts = active?.stats && referenceStats
      ? await getStyleLuts(active.stats, referenceStats)
      : null;
    return {
      id: crypto.randomUUID(),
      name,
      formatVersion: 4,
      stats: { ...referenceStats, version: 4 },
      luts,
      settings: active ? settings : null,
      palette: makePalette(referenceStats),
      createdAt: Date.now(),
    };
  }

  async function saveReferenceStyle() {
    if (!referenceStats || !styleName.trim()) return;
    const style = await createStylePayload(styleName.trim());
    const replaced = savedStyles.find((item) => item.name === style.name);
    if (replaced) {
      await deleteStyle(replaced.id);
      if (cloudEnabled) await deleteCloudStyle(replaced.id).catch(() => {});
    }
    await saveStyle(style);
    if (cloudEnabled) {
      await saveCloudStyle(style).catch((error) => {
        setImportErrors((items) => [
          `滤镜已保存到本机，但云端同步失败：${error?.message || "请稍后重试"}`,
          ...items,
        ].slice(0, 8));
      });
    }
    setSavedStyles([
      style,
      ...savedStyles.filter((item) => item.name !== style.name),
    ]);
    setStyleDialogOpen(false);
    setStyleName("");
  }

  function applySavedStyle(item) {
    setReferenceStats(item.stats);
    setReferences([]);
    if (item.settings && active) {
      updateActiveSettings({
        ...item.settings,
        curves: item.settings.curves || structuredClone(DEFAULT_CURVES),
        preset: "custom",
      });
    }
  }

  async function removeSavedStyle(id) {
    await deleteStyle(id);
    if (cloudEnabled) await deleteCloudStyle(id).catch(() => {});
    setSavedStyles(savedStyles.filter((item) => item.id !== id));
  }

  async function importStyleFile(file) {
    try {
      const style = deserializeClstyle(await file.text());
      await saveStyle(style);
      if (cloudEnabled) await saveCloudStyle(style);
      setSavedStyles((items) => [
        style,
        ...items.filter((item) => item.id !== style.id && item.name !== style.name),
      ]);
      applySavedStyle(style);
    } catch (error) {
      setImportErrors([`${file.name}：${error.message || "无法导入风格文件"}`]);
    }
  }

  async function exportClstyle() {
    if (!referenceStats) return;
    const name = exportOptions.name.trim() || active?.name.replace(/\.[^.]+$/, "") || "Color Style";
    const style = await createStylePayload(name);
    await deliverExport(
      new Blob([serializeClstyle(style)], { type: "application/json" }),
      `${safeFileStem(name)}.clstyle`,
    );
  }

  async function chooseExportDirectory() {
    if (typeof window.showDirectoryPicker !== "function") {
      setImportErrors([
        "当前浏览器不支持直接选择导出文件夹，将使用浏览器默认下载位置。桌面 Chrome / Edge 可使用此功能。",
      ]);
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({
        id: "color-lab-export",
        mode: "readwrite",
        startIn: "pictures",
      });
      setExportDirectory(handle);
    } catch (error) {
      if (error?.name !== "AbortError") {
        setImportErrors([`无法使用所选文件夹：${error?.message || "请检查浏览器权限"}`]);
      }
    }
  }

  async function deliverExport(blob, filename) {
    if (exportDirectory) {
      await writeBlobToDirectory(exportDirectory, blob, filename);
      return;
    }
    saveBlob(blob, filename);
  }

  async function renderTargetExport(target, targetIndex, totalTargets) {
    const longEdge = {
      original: Number.POSITIVE_INFINITY,
      "4k": 3840,
      "2k": 2560,
      "1080p": 1920,
    }[exportOptions.resolution];
    const mime = {
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      bmp: "image/bmp",
    }[exportOptions.format];
    const extension = exportOptions.format === "jpeg" ? "jpg" : exportOptions.format;
    const report = (stage, localProgress) => setBusyTask({
      kind: "export",
      label: target.name,
      stage,
      current: targetIndex + 1,
      total: totalTargets,
      progress: Math.min(
        100,
        Math.round((targetIndex + Math.max(0.02, localProgress)) / totalTargets * 100),
      ),
    });
    report("正在准备原始图片", 0.02);
    await waitForPaint();

    let source;
    if (target.raw && target.sourceFile) {
      source = (await decodeRawCanvas(
        target.sourceFile,
        longEdge,
        false,
        {
          onProgress: ({ stage, progress }) => report(stage, progress * 0.08),
        },
      )).canvas;
    } else {
      source = document.createElement("canvas");
      const originalWidth = target.metadata?.width;
      const originalHeight = target.metadata?.height;
      const canResizeBitmap = target.sourceFile
        && typeof createImageBitmap === "function"
        && originalWidth
        && originalHeight;
      let image;
      if (canResizeBitmap) {
        const scale = Number.isFinite(longEdge)
          ? Math.min(1, longEdge / Math.max(originalWidth, originalHeight))
          : 1;
        report("正在解码原始分辨率", 0.04);
        image = await createImageBitmap(target.sourceFile, {
          imageOrientation: "from-image",
          resizeWidth: Math.max(1, Math.round(originalWidth * scale)),
          resizeHeight: Math.max(1, Math.round(originalHeight * scale)),
          resizeQuality: "high",
        });
      } else {
        image = await loadImage(target.url);
      }
      const scale = Number.isFinite(longEdge)
        ? Math.min(1, longEdge / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height))
        : 1;
      source.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
      source.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
      const context = source.getContext("2d", { willReadFrequently: true });
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, source.width, source.height);
      image.close?.();
    }

    report("正在识别画面区域", 0.07);
    const analysisCanvas = makeAnalysisCanvas(source);
    const semanticMasks = await analyzeSemanticCanvas(analysisCanvas, {
      timeoutMs: IS_MOBILE ? 2600 : 6500,
    });
    report("正在读取完整像素", 0.09);
    await waitForPaint();
    const context = source.getContext("2d", { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, source.width, source.height);
    const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
    const analysisData = analysisContext.getImageData(
      0,
      0,
      analysisCanvas.width,
      analysisCanvas.height,
    ).data;
    const sourceProfile = target.stats || await engineWorker.run(
      "analyze",
      {
        data: analysisData,
        options: {
          width: analysisCanvas.width,
          height: analysisCanvas.height,
          semanticMasks,
        },
      },
      { photoId: `export-analysis:${target.id}` },
    );
    const targetSettings = target.settings || defaultSettings();
    const styleLuts = await getStyleLuts(
      sourceProfile,
      referenceStats || sourceProfile,
      {},
      targetSettings,
      target.id,
    );
    const rendered = await engineWorker.run(
      "render-export",
      {
        data: imageData.data,
        width: source.width,
        height: source.height,
        styleLuts,
        semanticMasks,
        source: sourceProfile,
        reference: referenceStats || sourceProfile,
        settings: targetSettings,
        output: {
          format: exportOptions.format,
          mime,
          extension,
          quality: exportOptions.quality / 100,
        },
      },
      {
        photoId: `export-render:${target.id}`,
        transfer: [imageData.data.buffer],
        onProgress: (progress) => report(progress.label, progress.percent / 100),
      },
    );

    if (rendered.blob) return { blob: rendered.blob, extension: rendered.extension };
    if (rendered.buffer) {
      return {
        blob: new Blob([rendered.buffer], { type: rendered.mime }),
        extension: rendered.extension,
      };
    }
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = rendered.width;
    outputCanvas.height = rendered.height;
    outputCanvas.getContext("2d").putImageData(
      new ImageData(rendered.data, rendered.width, rendered.height),
      0,
      0,
    );
    const blob = await new Promise((resolve) =>
      outputCanvas.toBlob(resolve, mime, exportOptions.quality / 100),
    );
    if (!blob) throw new Error("浏览器无法编码当前图片");
    return { blob, extension };
  }

  async function exportImage() {
    if (!active || isExporting) return;
    const exportTargets = selectedTargets;
    if (!exportTargets.length) return;
    const archiveName = safeFileStem(exportOptions.name, "ColorLab-batch");
    const exportedFiles = [];
    const duplicateNames = new Map();
    setIsExporting(true);
    setProcessing(true);
    await waitForPaint();
    try {
      for (let index = 0; index < exportTargets.length; index += 1) {
        const target = exportTargets[index];
        const rendered = await renderTargetExport(target, index, exportTargets.length);
        const sourceStem = exportTargets.length === 1
          ? archiveName
          : `${safeFileStem(target.name, `photo-${index + 1}`)}-ColorLab`;
        const occurrence = (duplicateNames.get(sourceStem) || 0) + 1;
        duplicateNames.set(sourceStem, occurrence);
        const stem = occurrence > 1 ? `${sourceStem}-${occurrence}` : sourceStem;
        const filename = `${stem}.${rendered.extension}`;
        if (exportDirectory) {
          await writeBlobToDirectory(exportDirectory, rendered.blob, filename);
        } else {
          exportedFiles.push({ name: filename, blob: rendered.blob });
        }
      }
      if (!exportDirectory) {
        if (exportedFiles.length === 1) {
          saveBlob(exportedFiles[0].blob, exportedFiles[0].name);
        } else {
          setBusyTask({
            kind: "export",
            label: `${exportedFiles.length} 张照片`,
            stage: "正在打包批量成片",
            current: exportedFiles.length,
            total: exportedFiles.length,
            progress: 98,
          });
          saveBlob(
            await createZipBlob(exportedFiles),
            `${archiveName}-${exportedFiles.length}张.zip`,
          );
        }
      }
      setExportDialogOpen(false);
      setExported(
        exportTargets.length > 1
          ? `已导出 ${exportTargets.length} 张照片`
          : "已导出当前照片",
      );
      window.setTimeout(() => setExported(false), 4000);
    } catch (error) {
      if (error?.name !== "AbortError") {
        setImportErrors([`导出失败：${error?.message || "浏览器无法完成此次导出"}`]);
      }
    } finally {
      setBusyTask(null);
      setIsExporting(false);
      setProcessing(false);
    }
  }

  async function exportPreset(type) {
    if (!active) return;
    const name = exportOptions.name.trim() || active.name.replace(/\.[^.]+$/, "");
    let content;
    if (type === "xmp") content = xmpPreset(settings, name);
    else {
      if (!active.stats || !referenceStats) return;
      setProcessing(true);
      try {
        const luts = await getStyleLuts(active.stats, referenceStats, {
          includeAdjustments: true,
        });
        content = cubeFromLut(luts.global, name);
      } finally {
        setProcessing(false);
      }
    }
    await deliverExport(
      new Blob([content], { type: type === "xmp" ? "application/rdf+xml" : "text/plain" }),
      `${safeFileStem(name)}.${type}`,
    );
  }

  async function addReferences(files) {
    setAnalyzing(true);
    setBusyTask({
      kind: "analysis",
      label: "参考照片",
      stage: "正在建立导入任务",
      progress: 0,
    });
    try {
      const decoded = await decodeFiles(files, Math.max(0, 8 - references.length));
      const next = decoded.map(({ file, asset }) => ({
        id: `${file.name}-${file.lastModified}-${Math.random()}`,
        name: file.name,
        ...asset,
      }));
      if (!next.length) return;
      const all = [...references, ...next].slice(0, 8);
      setReferences(all);
      const stats = await analyzeItemsSequentially(all, "参考照片");
      const profiled = all.map((item, index) => ({ ...item, stats: stats[index] }));
      setReferences(profiled);
      setReferenceStats(averageProfiles(stats));
      void syncDecodedFiles(decoded, "reference");
    } finally {
      setAnalyzing(false);
      setBusyTask(null);
    }
  }

  async function addTargets(files) {
    setAnalyzing(true);
    setBusyTask({
      kind: "analysis",
      label: "待调色照片",
      stage: "正在建立导入任务",
      progress: 0,
    });
    try {
      const decoded = await decodeFiles(files, Math.max(0, 20 - targets.length));
      const next = decoded.map(({ file, asset }) => ({
        id: `${file.name}-${file.lastModified}-${Math.random()}`,
        name: file.name,
        ...asset,
        settings: defaultSettings(),
        stats: null,
      }));
      if (!next.length) return;
      const stats = await analyzeItemsSequentially(next, "待调色照片");
      const complete = next.map((item, index) => ({ ...item, stats: stats[index] }));
      setTargets((items) => [...items, ...complete].slice(0, 20));
      setActiveId((value) => value || complete[0].id);
      setSelectedTargetIds((items) => [
        ...new Set([...items, ...complete.map((item) => item.id)]),
      ]);
      selectionAnchor.current = complete.at(-1)?.id || selectionAnchor.current;
      void syncDecodedFiles(decoded, "target");
    } finally {
      setAnalyzing(false);
      setBusyTask(null);
    }
  }

  async function loadDemo() {
    setAnalyzing(true);
    setBusyTask({ kind: "analysis", label: "正在分析示例照片", progress: 5 });
    const demoReferences = [
      { id: "demo-ref-coast", name: "海岸金色时刻", url: "/demo/coast-reference.png" },
      { id: "demo-ref-street", name: "暖调街巷", url: "/demo/street-reference.png" },
    ];
    const demoTargetDefs = [
      ["demo-a", "海岸街道 01", "/demo/coast-target.png"],
      ["demo-b", "地中海街巷 02", "/demo/street-reference.png"],
      ["demo-c", "海岸街道 03", "/demo/coast-reference.png"],
      ["demo-d", "暖调街景 04", "/demo/street-reference.png"],
      ["demo-e", "海岸街道 05", "/demo/coast-target.png"],
    ];
    try {
      const [refStats, targetStats] = await Promise.all([
        Promise.all(demoReferences.map((item) => analyzeUrl(item.url))),
        Promise.all(demoTargetDefs.map((item) => analyzeUrl(item[2]))),
      ]);
      const demoTargets = demoTargetDefs.map((item, index) => ({
        id: item[0],
        name: item[1],
        url: item[2],
        stats: targetStats[index],
        settings: {
          ...defaultSettings(),
          curves: structuredClone(DEFAULT_CURVES),
        },
      }));
      setReferences(demoReferences.map((item, index) => ({ ...item, stats: refStats[index] })));
      setReferenceStats(averageProfiles(refStats));
      setTargets(demoTargets);
      setActiveId(demoTargets[0].id);
      setSelectedTargetIds(demoTargets.map((item) => item.id));
      selectionAnchor.current = demoTargets[0].id;
    } finally {
      setAnalyzing(false);
      setBusyTask(null);
    }
  }

  function removeReference(id) {
    const removed = references.find((item) => item.id === id);
    if (removed?.url.startsWith("blob:")) URL.revokeObjectURL(removed.url);
    const next = references.filter((item) => item.id !== id);
    setReferences(next);
    if (referencePreview?.id === id) setReferencePreview(null);
    if (!next.length) setReferenceStats(null);
    else {
      setReferenceStats(averageProfiles(next.map((item) => item.stats).filter(Boolean)));
    }
  }

  function removeTarget(id) {
    const removed = targets.find((item) => item.id === id);
    if (removed?.url.startsWith("blob:")) URL.revokeObjectURL(removed.url);
    const next = targets.filter((item) => item.id !== id);
    setTargets(next);
    setSelectedTargetIds((items) => items.filter((item) => item !== id));
    if (activeId === id) setActiveId(next[0]?.id || null);
  }

  function toggleTargetSelection(id, event = {}) {
    setActiveId(id);
    setSelectedTargetIds((current) => {
      if (event.shiftKey && selectionAnchor.current) {
        const start = targets.findIndex((item) => item.id === selectionAnchor.current);
        const end = targets.findIndex((item) => item.id === id);
        if (start >= 0 && end >= 0) {
          const [first, last] = start < end ? [start, end] : [end, start];
          return [...new Set([...current, ...targets.slice(first, last + 1).map((item) => item.id)])];
        }
      }
      const selected = current.includes(id);
      if ((event.metaKey || event.ctrlKey) && selected) {
        return current.filter((item) => item !== id);
      }
      if (selected) return current.filter((item) => item !== id);
      return [...current, id];
    });
    selectionAnchor.current = id;
  }

  function selectAllTargets() {
    setSelectedTargetIds(targets.map((item) => item.id));
    selectionAnchor.current = targets.at(-1)?.id || null;
  }

  async function handleImportDrop(event, kind) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragImportActive(false);
    const files = droppedFiles(event.dataTransfer);
    if (!files.length) {
      setImportErrors([
        "微信没有向浏览器提供可读取文件。请尝试拖动原图消息，或先另存到本机后再导入。",
      ]);
      return;
    }
    if (analyzing || isExporting) {
      setImportErrors(["请等待当前分析或导出任务完成后再导入照片。"]);
      return;
    }
    if (kind === "reference") await addReferences(files);
    else await addTargets(files);
  }

  function applyPreset(key) {
    const item = PRESETS[key];
    updateActiveSettings({ ...item, preset: key });
  }

  function resetActive() {
    if (!active) return;
    setTargets((items) =>
      items.map((item) => item.id === active.id ? { ...item, settings: defaultSettings() } : item),
    );
    setSplit(50);
    setChannel("master");
  }

  function updateCurve(points) {
    updateActiveSettings({
      curves: { ...settings.curves, [channel]: points },
      preset: "custom",
    });
  }

  function previewCurve(points) {
    const base = curveAdjustedPreviewBase.current;
    const canvas = styledCanvas.current;
    if (!canvas) return;
    const curves = { ...settings.curves, [channel]: points };
    if (base) renderCurveBase(base, curves, canvas, curvePreviewOutput);
    else {
      const fallback = styledPreviewBase.current || styledBase.current;
      if (fallback) {
        renderAdjustedBase(fallback, settings, curves, canvas, curvePreviewOutput);
      }
    }
  }

  function previewBasic(previewSettings) {
    const base = styledPreviewBase.current || styledBase.current;
    const canvas = styledCanvas.current;
    if (!base || !canvas) return;
    renderAdjustedBase(
      base,
      previewSettings,
      settings.curves,
      canvas,
      curvePreviewOutput,
    );
  }

  useEffect(() => {
    if (!active?.url || !originalCanvas.current || !styledCanvas.current) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setProcessing(true);
      loadImage(active.url).then(async (image) => {
        if (cancelled) return;
        const originalContext = drawSized(image, originalCanvas.current);
        const styledContext = drawSized(image, styledCanvas.current);
        const imageData = originalContext.getImageData(0, 0, originalCanvas.current.width, originalCanvas.current.height);
        const data = imageData.data;
        const maskKey = `${active.id}:${active.url}:${imageData.width}x${imageData.height}`;
        let semanticMasks = semanticMaskCache.current.get(maskKey);
        if (!semanticMasks) {
          semanticMasks = await analyzeSemanticCanvas(
            makeAnalysisCanvas(originalCanvas.current),
            { timeoutMs: IS_MOBILE ? 2600 : 6500 },
          );
          if (cancelled) return;
          semanticMaskCache.current.set(maskKey, semanticMasks);
        }
        let source = active.stats;
        if (!source) {
          source = await engineWorker.run(
            "analyze",
            {
              data: new Uint8ClampedArray(data),
              options: {
                width: imageData.width,
                height: imageData.height,
                semanticMasks,
              },
            },
            { photoId: `analysis:${active.id}` },
          );
        }
        const reference = referenceStats || source;
        const styleLuts = await getStyleLuts(source, reference);
        applyStyleLuts(
          data,
          imageData.width,
          imageData.height,
          styleLuts,
          semanticMasks,
        );
        applyTextureMatch(
          data,
          imageData.width,
          imageData.height,
          source,
          reference,
          settings.strength / 100,
        );
        if (cancelled) return;
        const base = {
          data: new Uint8ClampedArray(data),
          width: imageData.width,
          height: imageData.height,
        };
        styledBase.current = base;
        styledPreviewBase.current = makeCurvePreviewBase(base);
        curveAdjustedPreviewBase.current = null;
        styledOutput.current = null;
        curvePreviewOutput.current = null;
        styledContext.clearRect(0, 0, imageData.width, imageData.height);
        setBaseRevision((value) => value + 1);
        setProcessing(false);
      }).catch(() => {
        if (!cancelled) setProcessing(false);
      });
    }, 42);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    active?.url,
    active?.stats,
    referenceStats,
    settings.strength,
    settings.referenceLighting,
  ]);

  useEffect(() => {
    const base = styledBase.current;
    const canvas = styledCanvas.current;
    if (!base || !canvas) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      const previewBase = styledPreviewBase.current;
      if (previewBase) {
        const cached = curveAdjustedPreviewBase.current;
        const previewData = cached?.data.length === previewBase.data.length
          ? cached.data
          : new Uint8ClampedArray(previewBase.data.length);
        previewData.set(previewBase.data);
        applyBasicAdjustments(
          previewData,
          previewBase.width,
          previewBase.height,
          settings,
        );
        curveAdjustedPreviewBase.current = {
          data: previewData,
          width: previewBase.width,
          height: previewBase.height,
        };
      }
    });
    RENDER_PIPELINE.renderBasic(
      {
        data: new Uint8ClampedArray(base.data),
        width: base.width,
        height: base.height,
        settings,
        curves: settings.curves,
      },
      { photoId: `render:${active?.id || "preview"}` },
    ).then((result) => {
      if (cancelled) return;
      setActiveBackend(
        result.backend === "webgpu"
          ? "WebGPU"
          : result.backend === "webgl2"
            ? "WebGL 2"
            : "Worker CPU",
      );
      styledOutput.current = result.data;
      if (canvas.width !== result.width) canvas.width = result.width;
      if (canvas.height !== result.height) canvas.height = result.height;
      canvas.getContext("2d").putImageData(
        new ImageData(result.data, result.width, result.height),
        0,
        0,
      );
      setDisplayHistogram(result.histogram);
    }).catch((error) => {
      if (cancelled || error?.name === "AbortError") return;
      const output = renderAdjustedBase(
        base,
        settings,
        settings.curves,
        canvas,
        styledOutput,
      );
      engineWorker.run(
        "histogram",
        { data: new Uint8ClampedArray(output) },
        { photoId: `histogram:${active?.id || "preview"}` },
      ).then((histogram) => {
        if (!cancelled) setDisplayHistogram(histogram);
      }).catch(() => {});
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [
    baseRevision,
    settings.temperature,
    settings.tint,
    settings.exposure,
    settings.contrast,
    settings.highlights,
    settings.shadows,
    settings.whites,
    settings.blacks,
    settings.texture,
    settings.clarity,
    settings.dehaze,
    settings.vibrance,
    settings.saturation,
    settings.grain,
    settings.grainSize,
    settings.grainRoughness,
    settings.grainColor,
    settings.grainHighlights,
    settings.curves,
  ]);

  function updateSplit(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    setSplit(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100));
  }

  function openStagePreview() {
    if (!active || !originalCanvas.current || !styledCanvas.current) return;
    setStagePreviewSplit(split);
    stagePreviewView.current = { zoom: 1, pan: { x: 0, y: 0 } };
    stagePreviewPointers.current.clear();
    stagePreviewGesture.current = null;
    setStagePreviewZoom(1);
    setStagePreviewPan({ x: 0, y: 0 });
    setStagePreviewOpen(true);
  }

  function beginStageInteraction(event) {
    if (event.button !== 0) return;
    stagePointer.current = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }

  function moveStageInteraction(event) {
    const interaction = stagePointer.current;
    if (!interaction) return;
    if (!interaction.moved) {
      interaction.moved = Math.hypot(
        event.clientX - interaction.x,
        event.clientY - interaction.y,
      ) > 4;
    }
    if (interaction.moved) updateSplit(event);
  }

  function finishStageInteraction(event) {
    const interaction = stagePointer.current;
    stagePointer.current = null;
    setDragging(false);
    if (!interaction) return;
    if (interaction.moved) updateSplit(event);
    else openStagePreview();
  }

  function cancelStageInteraction() {
    stagePointer.current = null;
    setDragging(false);
  }

  function updateStagePreviewSplit(event) {
    const viewport = stagePreviewViewport.current || event.currentTarget;
    const rect = viewport.getBoundingClientRect();
    setStagePreviewSplit(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100));
  }

  function clampStagePreviewPan(pan, zoom) {
    const viewport = stagePreviewViewport.current;
    if (!viewport || zoom <= 1) return { x: 0, y: 0 };
    const maximumX = viewport.clientWidth * (zoom - 1) / 2;
    const maximumY = viewport.clientHeight * (zoom - 1) / 2;
    return {
      x: clamp(pan.x, -maximumX, maximumX),
      y: clamp(pan.y, -maximumY, maximumY),
    };
  }

  function applyStagePreviewView(zoom, pan) {
    const boundedZoom = clamp(zoom, 1, 6);
    const boundedPan = clampStagePreviewPan(pan, boundedZoom);
    stagePreviewView.current = { zoom: boundedZoom, pan: boundedPan };
    setStagePreviewZoom(boundedZoom);
    setStagePreviewPan(boundedPan);
  }

  function zoomStagePreview(nextZoom, clientX, clientY) {
    const viewport = stagePreviewViewport.current;
    const current = stagePreviewView.current;
    const zoom = clamp(nextZoom, 1, 6);
    if (!viewport || zoom === current.zoom) return;
    const rect = viewport.getBoundingClientRect();
    const anchorX = Number.isFinite(clientX) ? clientX - rect.left - rect.width / 2 : 0;
    const anchorY = Number.isFinite(clientY) ? clientY - rect.top - rect.height / 2 : 0;
    const ratio = zoom / current.zoom;
    applyStagePreviewView(zoom, {
      x: anchorX - (anchorX - current.pan.x) * ratio,
      y: anchorY - (anchorY - current.pan.y) * ratio,
    });
  }

  function beginStagePreviewGesture(event) {
    const viewport = stagePreviewViewport.current;
    if (!viewport) return;
    try {
      viewport.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; wheel, buttons and direct pointer
      // movement remain usable on engines that do not provide it.
    }
    stagePreviewPointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const pointers = [...stagePreviewPointers.current.values()];
    if (pointers.length >= 2) {
      const [first, second] = pointers;
      stagePreviewGesture.current = {
        type: "pinch",
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        view: stagePreviewView.current,
      };
      return;
    }
    if (stagePreviewView.current.zoom > 1) {
      stagePreviewGesture.current = {
        type: "pan",
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        pan: stagePreviewView.current.pan,
      };
    } else {
      stagePreviewGesture.current = { type: "split", pointerId: event.pointerId };
      updateStagePreviewSplit(event);
    }
  }

  function moveStagePreviewGesture(event) {
    if (!stagePreviewPointers.current.has(event.pointerId)) return;
    stagePreviewPointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const gesture = stagePreviewGesture.current;
    const pointers = [...stagePreviewPointers.current.values()];
    if (pointers.length >= 2) {
      const [first, second] = pointers;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const pinch = gesture?.type === "pinch" ? gesture : {
        distance,
        midpoint,
        view: stagePreviewView.current,
      };
      const viewport = stagePreviewViewport.current;
      const rect = viewport.getBoundingClientRect();
      const zoom = clamp(pinch.view.zoom * distance / pinch.distance, 1, 6);
      const ratio = zoom / pinch.view.zoom;
      const startAnchor = {
        x: pinch.midpoint.x - rect.left - rect.width / 2,
        y: pinch.midpoint.y - rect.top - rect.height / 2,
      };
      const currentAnchor = {
        x: midpoint.x - rect.left - rect.width / 2,
        y: midpoint.y - rect.top - rect.height / 2,
      };
      applyStagePreviewView(zoom, {
        x: currentAnchor.x - (startAnchor.x - pinch.view.pan.x) * ratio,
        y: currentAnchor.y - (startAnchor.y - pinch.view.pan.y) * ratio,
      });
      return;
    }
    if (gesture?.type === "pan" && gesture.pointerId === event.pointerId) {
      applyStagePreviewView(stagePreviewView.current.zoom, {
        x: gesture.pan.x + event.clientX - gesture.start.x,
        y: gesture.pan.y + event.clientY - gesture.start.y,
      });
    } else if (gesture?.type === "split") updateStagePreviewSplit(event);
  }

  function finishStagePreviewGesture(event) {
    stagePreviewPointers.current.delete(event.pointerId);
    const remaining = [...stagePreviewPointers.current.entries()];
    if (remaining.length === 1 && stagePreviewView.current.zoom > 1) {
      const [pointerId, point] = remaining[0];
      stagePreviewGesture.current = {
        type: "pan",
        pointerId,
        start: point,
        pan: stagePreviewView.current.pan,
      };
    } else if (!remaining.length) stagePreviewGesture.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <main className="app-shell editor-shell">
      <header className="topbar">
        <div className="brand"><SlidersHorizontal size={21} weight="bold" /><span>调色室</span><small>Color Engine 4.3</small></div>
        <div className="compare-toggle glass-surface"><span>之前</span><span className="active">之后</span></div>
        <div className="header-actions">
          <GlassButton
            className={`cloud-library-button ${cloudStatus.state}`}
            disabled={!cloudEnabled}
            onClick={() => setCloudLibraryOpen(true)}
            title={cloudEnabled ? cloudStatus.message : "本机预览账户不连接云端"}
          >
            {cloudUploading
              ? <RefreshCw className="spin" size={14} />
              : cloudStatus.state === "ready"
                ? <CircleCheck size={15} />
                : <History size={15} />}
            <span>云端历史</span>
            {!!cloudUploading && <b>{cloudUploading}</b>}
          </GlassButton>
          <div className="editor-account glass-surface" title={`当前账户：${username}`}>
            {cloudEnabled ? <Cloud size={14} /> : <UserRound size={14} />}
            <span>{username}</span>
            <button type="button" onClick={onLogout} aria-label="退出登录" title="退出登录">
              <LogOut size={14} />
            </button>
          </div>
          <GlassButton className="demo-button" onClick={loadDemo}><Sparkle size={15} />加载示例</GlassButton>
          <GlassButton className="icon-button" onClick={resetActive} title="重置当前照片"><ArrowCounterClockwise size={18} /></GlassButton>
          <button
            className="primary-button"
            disabled={!active || isExporting}
            aria-label={selectedTargets.length > 1 ? `导出已选 ${selectedTargets.length} 张照片` : "导出图片与预设"}
            title={selectedTargets.length > 1 ? `导出已选 ${selectedTargets.length} 张照片` : "导出图片与预设"}
            onClick={() => {
              setExportOptions((value) => ({
                ...value,
                name: selectedTargets.length > 1
                  ? "ColorLab-batch"
                  : active.name.replace(/\.[^.]+$/, ""),
              }));
              setExportDialogOpen(true);
            }}
          >
            <DownloadSimple size={17} weight="bold" />
            <span>{selectedTargets.length > 1 ? `导出已选 ${selectedTargets.length} 张` : "导出图片与预设"}</span>
          </button>
        </div>
      </header>
      {exported && <div className="toast glass-surface" role="status"><Check size={16} weight="bold" />{exported}</div>}

      {dragImportActive && (
        <div className="drag-import-overlay" role="dialog" aria-label="拖放导入照片">
          <div className="drag-import-header">
            <Images size={24} />
            <div>
              <strong>松开鼠标即可导入</strong>
              <span>支持从微信聊天、资源管理器或桌面拖入浏览器可读取的图片</span>
            </div>
          </div>
          <div className="drag-import-zones">
            <div
              className="drag-import-zone reference"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleImportDrop(event, "reference")}
            >
              <Sparkle size={28} />
              <strong>作为参考样片</strong>
              <span>加入左侧风格分析，最多 8 张</span>
            </div>
            <div
              className="drag-import-zone target"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleImportDrop(event, "target")}
            >
              <ImageSquare size={28} />
              <strong>作为待调色照片</strong>
              <span>加入批量队列，最多 20 张</span>
            </div>
          </div>
          <small>若微信没有提供文件数据，页面会提示先将原图另存到本机。</small>
        </div>
      )}

      {busyTask && (
        <div className="global-progress" role="status" aria-live="polite">
          <div className="global-progress-card glass-panel">
            <div
              className="progress-orbit"
              style={{ "--progress": `${Math.max(2, busyTask.progress || 0) * 3.6}deg` }}
            >
              <Sparkle size={22} weight="fill" />
            </div>
            <div>
              <strong>{busyTask.label}</strong>
              <small className="global-progress-stage">
                {busyTask.stage || (busyTask.kind === "export" ? "完整分辨率导出" : "本地颜色分析")}
              </small>
              {(busyTask.current || busyTask.bytesTotal) && (
                <span className="global-progress-meta">
                  {busyTask.current ? `第 ${busyTask.current}/${busyTask.total} 张` : ""}
                  {busyTask.current && busyTask.bytesTotal ? " · " : ""}
                  {busyTask.bytesTotal
                    ? `${formatCloudSize(busyTask.bytesLoaded || 0)} / ${formatCloudSize(busyTask.bytesTotal)}`
                    : ""}
                </span>
              )}
              <span className="global-progress-privacy">
                {busyTask.kind === "export"
                  ? "完整分辨率处理在后台进行，页面仍可保持响应"
                  : cloudSyncEnabled && cloudEnabled
                    ? "分析仍在浏览器本地完成；原始文件会按你的云端同步设置私有保存"
                    : "照片仅在浏览器本地分析，当前不会上传云端"}
              </span>
              <div className="global-progress-track">
                <i style={{ transform: `scaleX(${Math.max(2, busyTask.progress || 0) / 100})` }} />
              </div>
            </div>
            <b>{Math.round(busyTask.progress || 0)}%</b>
          </div>
        </div>
      )}

      <section className="workspace">
        <aside className="left-panel glass-panel">
          <div className="panel-heading"><span>参考风格</span><GlassButton className="mini-button" onClick={() => referenceInput.current?.click()}><Plus size={15} /></GlassButton></div>
          <input ref={referenceInput} hidden multiple type="file" accept={IMAGE_ACCEPT} onChange={(event) => addReferences(event.target.files)} />
          <div className="reference-list">
            {references.map((item) => (
              <figure
                key={item.id}
                className="reference-thumb"
                role="button"
                tabIndex={0}
                aria-label={`查看参考样片 ${item.name}`}
                onClick={() => setReferencePreview(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setReferencePreview(item);
                  }
                }}
              >
                <img src={item.url} alt={item.name} />
                <span className="reference-view-cue"><Maximize2 size={13} />查看</span>
                {item.raw && (
                  <span className={`raw-badge ${item.metadata?.preview === "embedded" ? "fallback" : ""}`}>
                    {item.metadata?.preview === "embedded" ? "RAW 预览" : "16-bit"}
                  </span>
                )}
                <button
                  title="移除参考图"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeReference(item.id);
                  }}
                ><X size={12} weight="bold" /></button>
              </figure>
            ))}
          </div>
          {!references.length && (
            <button className="upload-zone" onClick={() => referenceInput.current?.click()}>
              <UploadSimple size={23} /><span>上传参考图</span><small>建议 3–8 张</small>
            </button>
          )}
          <div className="reference-status">
            <span className={referenceStats ? "status-dot ready" : "status-dot"} />
            {analyzing ? (decodeStatus || "正在构建感知色彩档案…") : referenceStats ? "感知风格档案已就绪" : "等待参考图"}
          </div>
          <div className="saved-style-block">
            <div className="saved-style-heading">
              <span>我的滤镜</span>
              <div>
                <GlassButton className="save-style-button" onClick={() => styleInput.current?.click()}>
                  <UploadSimple size={12} />导入
                </GlassButton>
                <GlassButton className="save-style-button" disabled={!referenceStats} onClick={() => setStyleDialogOpen(true)}>
                  <Plus size={13} />保存
                </GlassButton>
              </div>
              <input
                ref={styleInput}
                hidden
                type="file"
                accept=".clstyle,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) importStyleFile(file);
                  event.target.value = "";
                }}
              />
            </div>
            <div className="saved-style-list">
              {savedStyles.map((item) => (
                <div key={item.id} className="saved-style-row">
                  <button onClick={() => applySavedStyle(item)}>
                    <span className="saved-swatch" style={{ background: item.palette?.[2] || "#777" }} />
                    <span>{item.name}</span>
                  </button>
                  <button title="删除滤镜" onClick={() => removeSavedStyle(item.id)}><X size={11} /></button>
                </div>
              ))}
              {!savedStyles.length && <p>保存后可在下次直接调用</p>}
            </div>
          </div>
        </aside>

        <section className="canvas-column">
          <div
            className={`photo-stage ${active ? "has-photo" : ""} ${dragging ? "dragging" : ""}`}
            onPointerDown={beginStageInteraction}
            onPointerMove={moveStageInteraction}
            onPointerUp={finishStageInteraction}
            onPointerCancel={cancelStageInteraction}
            title={active ? "点击放大查看细节；拖动可调整前后对比" : undefined}
          >
            {active ? (
              <>
                <canvas ref={originalCanvas} className="photo-canvas original" />
                <div className="styled-clip" style={{ width: `${split}%` }}><canvas ref={styledCanvas} className="photo-canvas styled" /></div>
                <div className="split-line" style={{ left: `${split}%` }}><span>‹›</span></div>
                <span className="image-label styled-label">调色后</span>
                <span className="image-label original-label">原图</span>
                <button
                  type="button"
                  className="stage-expand-button glass-surface"
                  aria-label="放大查看当前照片细节"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={openStagePreview}
                >
                  <Maximize2 size={14} />
                  <span>查看细节</span>
                </button>
                {active.raw && (
                  <span className={`raw-mode-label glass-surface ${active.metadata?.preview === "embedded" ? "fallback" : ""}`}>
                    {active.metadata?.preview === "embedded"
                      ? "RAW 预览模式 · 完整解码失败"
                      : `${active.metadata?.bitDepth || 16}-bit RAW · ${active.metadata?.workingSpace || "Linear ProPhoto RGB"}`}
                  </span>
                )}
              </>
            ) : (
              <button className="empty-canvas" onClick={() => targetInput.current?.click()}>
                <span className="empty-icon"><ImageSquare size={31} /></span>
                <strong>上传需要调色的照片</strong>
                <span>支持一次选择多张，每张保留独立参数</span>
                <b><UploadSimple size={16} />选择照片</b>
              </button>
            )}
          </div>

          <div className="control-dock glass-surface">
            <div className="strength-control">
              <span>风格强度</span>
              <small className={processing || curveDragging || basicDragging ? "engine-status active" : "engine-status"}>
                {processing
                  ? "正在构建 V4 颜色与质感…"
                  : curveDragging
                    ? "曲线实时预览"
                    : basicDragging
                      ? "基本参数实时预览"
                      : `${activeBackend} · V4 本地渲染`}
              </small>
              <strong>{settings.strength}%</strong>
            </div>
            <input type="range" min="0" max="100" value={settings.strength} disabled={!active} onChange={(event) => updateActiveSettings({ strength: Number(event.target.value), preset: "custom" })} />
            <div className="preset-group">
              {Object.entries(PRESETS).map(([key, item]) => (
                <GlassButton key={key} className={settings.preset === key ? "selected" : ""} disabled={!active} onClick={() => applyPreset(key)}>{item.label}</GlassButton>
              ))}
            </div>
          </div>

          <section className="target-strip glass-surface">
            <div className="target-strip-title">
              <span>待调色照片</span>
              <b>{selectedTargetIds.length ? `已选 ${selectedTargetIds.length} / ${targets.length}` : `${targets.length} 张`}</b>
              {!!targets.length && (
                <div className="target-selection-actions">
                  <button type="button" onClick={selectAllTargets}>全选</button>
                  <button type="button" disabled={!selectedTargetIds.length} onClick={() => setSelectedTargetIds([])}>清除</button>
                </div>
              )}
            </div>
            <div className="target-scroller">
              <button className="add-target" onClick={() => targetInput.current?.click()}><Plus size={24} /><span>添加照片</span></button>
              <input ref={targetInput} hidden multiple type="file" accept={IMAGE_ACCEPT} onChange={(event) => addTargets(event.target.files)} />
              {targets.map((item) => (
                <figure
                  key={item.id}
                  className={[
                    "target-thumb",
                    item.id === active?.id ? "active" : "",
                    selectedTargetIds.includes(item.id) ? "selected" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => setActiveId(item.id)}
                >
                  <img src={item.url} alt={item.name} />
                  <button
                    type="button"
                    className="target-select"
                    aria-label={`${selectedTargetIds.includes(item.id) ? "取消选择" : "选择"} ${item.name}`}
                    aria-pressed={selectedTargetIds.includes(item.id)}
                    title={selectedTargetIds.includes(item.id) ? "取消批量导出" : "加入批量导出"}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleTargetSelection(item.id, event);
                    }}
                  >
                    {selectedTargetIds.includes(item.id)
                      ? <Check size={13} weight="bold" />
                      : <Square size={13} />}
                  </button>
                  {item.raw && (
                    <span className={`raw-badge ${item.metadata?.preview === "embedded" ? "fallback" : ""}`}>
                      {item.metadata?.preview === "embedded" ? "RAW 预览" : "16-bit"}
                    </span>
                  )}
                  {item.id === active?.id && <figcaption>正在编辑</figcaption>}
                  <button className="remove-target" title="移除照片" onClick={(event) => { event.stopPropagation(); removeTarget(item.id); }}><X size={12} weight="bold" /></button>
                </figure>
              ))}
            </div>
          </section>
        </section>

        <aside className="right-panel glass-panel">
          <InspectorDisclosure title="直方图" meta="RGB" className="histogram-section" defaultOpen>
            <HistogramCanvas histogram={displayHistogram || active?.stats?.histogram} />
          </InspectorDisclosure>
          <InspectorDisclosure
            title="风格 DNA"
            meta={styleAnalysisMeta(referenceStats)}
            className="style-analysis-section"
          >
            <StyleAnalysis profile={referenceStats} />
          </InspectorDisclosure>
          <BasicAdjustmentsPanel
            settings={settings}
            disabled={!active}
            onChange={updateActiveSettings}
            onPreview={previewBasic}
            onInteractionChange={setBasicDragging}
          />
          <InspectorDisclosure
            title="曲线"
            meta={CHANNELS.find((item) => item.id === channel)?.label}
            className="curve-section"
            action={(
              <GlassButton
                className="reset-curve"
                onClick={() => updateCurve(structuredClone(DEFAULT_CURVES[channel]))}
              >
                <ArrowCounterClockwise size={13} />重置
              </GlassButton>
            )}
          >
            <div className="channel-tabs glass-surface">
              {CHANNELS.map((item) => (
                <button
                  key={item.id}
                  className={channel === item.id ? `active ${item.id}` : ""}
                  onClick={() => setChannel(item.id)}
                >{item.label}</button>
              ))}
            </div>
            <CurveEditor
              channel={channel}
              points={settings.curves[channel]}
              histogram={displayHistogram || active?.stats?.histogram}
              onChange={updateCurve}
              onPreview={previewCurve}
              onInteractionChange={setCurveDragging}
            />
            <p className="curve-help">点击添加控制点 · 拖动时实时预览 · 双击删除</p>
          </InspectorDisclosure>
          <InspectorDisclosure title="效果" meta="颗粒与质感" className="effects-section">
            <Range
              label="胶片颗粒"
              value={settings.grain}
              min={0}
              max={40}
              signed={false}
              disabled={!active}
              onPreview={(grain) => previewBasic({
                ...settings,
                grain,
                preset: "custom",
              })}
              onInteractionChange={setBasicDragging}
              onChange={(grain) => updateActiveSettings({ grain, preset: "custom" })}
            />
            <Range
              label="颗粒大小"
              value={settings.grainSize}
              min={0.5}
              max={4}
              step={0.1}
              decimals={1}
              signed={false}
              disabled={!active}
              onPreview={(grainSize) => previewBasic({ ...settings, grainSize, preset: "custom" })}
              onInteractionChange={setBasicDragging}
              onChange={(grainSize) => updateActiveSettings({ grainSize, preset: "custom" })}
            />
            <Range
              label="粗糙度"
              value={settings.grainRoughness}
              min={0}
              max={100}
              signed={false}
              disabled={!active}
              onPreview={(grainRoughness) => previewBasic({ ...settings, grainRoughness, preset: "custom" })}
              onInteractionChange={setBasicDragging}
              onChange={(grainRoughness) => updateActiveSettings({ grainRoughness, preset: "custom" })}
            />
            <Range
              label="彩色比例"
              value={settings.grainColor}
              min={0}
              max={100}
              signed={false}
              disabled={!active}
              onPreview={(grainColor) => previewBasic({ ...settings, grainColor, preset: "custom" })}
              onInteractionChange={setBasicDragging}
              onChange={(grainColor) => updateActiveSettings({ grainColor, preset: "custom" })}
            />
            <Range
              label="高光响应"
              value={settings.grainHighlights}
              min={0}
              max={100}
              signed={false}
              disabled={!active}
              onPreview={(grainHighlights) => previewBasic({ ...settings, grainHighlights, preset: "custom" })}
              onInteractionChange={setBasicDragging}
              onChange={(grainHighlights) => updateActiveSettings({ grainHighlights, preset: "custom" })}
            />
          </InspectorDisclosure>
          <InspectorDisclosure title="参考色板" meta="七色取样" className="palette-section">
            <div>{palette.map((color) => <span key={color} style={{ background: color }} />)}</div>
            <p>{referenceStats ? `参考色彩 · ${referenceStats.saturation < 0.35 ? "克制饱和" : "鲜明色彩"} · 21 分区取色` : "上传参考图生成色板"}</p>
          </InspectorDisclosure>
        </aside>
      </section>
      {!!importErrors.length && (
        <div className="import-errors glass-surface" role="alert">
          <strong>部分文件未导入</strong>
          {importErrors.map((item) => <span key={item}>{item}</span>)}
          <button onClick={() => setImportErrors([])}><X size={13} /></button>
        </div>
      )}
      {cloudLibraryOpen && (
        <div className="modal-backdrop" onMouseDown={() => {
          setCloudLibraryOpen(false);
          setCloudDeleteCandidate(null);
        }}>
          <section
            className="modal cloud-library-modal glass-panel"
            aria-label="云端历史"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-title">
              <div><Cloud size={18} /><h2>云端历史</h2></div>
              <GlassButton className="mini-button" onClick={() => {
                setCloudLibraryOpen(false);
                setCloudDeleteCandidate(null);
              }}>
                <X size={14} />
              </GlassButton>
            </div>
            <div className={`cloud-library-status ${cloudStatus.state}`}>
              <span>
                {cloudStatus.state === "ready"
                  ? <CircleCheck size={17} />
                  : cloudStatus.state === "error"
                    ? <CloudOff size={17} />
                    : <RefreshCw className={cloudStatus.state === "loading" ? "spin" : ""} size={17} />}
              </span>
              <div>
                <strong>{cloudStatus.message}</strong>
                <small>私有文件只会通过当前账号读取、恢复或删除</small>
              </div>
              <GlassButton className="cloud-refresh" onClick={refreshCloudLibrary}>
                <RefreshCw size={13} />刷新
              </GlassButton>
            </div>
            <label className="cloud-sync-toggle">
              <span>
                <strong>新照片自动同步</strong>
                <small>关闭后仍可在浏览器本地处理，不影响已同步内容</small>
              </span>
              <input
                type="checkbox"
                checked={cloudSyncEnabled}
                onChange={(event) => setCloudSyncEnabled(event.target.checked)}
              />
              <i aria-hidden="true" />
            </label>
            <div className="cloud-library-heading">
              <span>照片记录</span>
              <b>{cloudAssets.length}</b>
            </div>
            <div className="cloud-asset-grid">
              {cloudAssets.map((asset) => (
                <article key={asset.id} className="cloud-asset-card">
                  <div className="cloud-asset-preview">
                    {canPreviewCloudAsset(asset)
                      ? <img src={cloudAssetUrl(asset.id)} alt="" loading="lazy" />
                      : <span><ImageSquare size={24} /><small>RAW</small></span>}
                    <b>{asset.kind === "reference" ? "参考" : "目标"}</b>
                  </div>
                  <div className="cloud-asset-copy">
                    <strong title={asset.name}>{asset.name}</strong>
                    <small>{formatCloudSize(asset.size)} · {formatCloudDate(asset.createdAt)}</small>
                  </div>
                  <div className="cloud-asset-actions">
                    <GlassButton onClick={() => restoreCloudAsset(asset)}>
                      <ArrowCounterClockwise size={12} />恢复
                    </GlassButton>
                    <button
                      type="button"
                      title="从云端删除"
                      aria-label={`从云端删除 ${asset.name}`}
                      onClick={() => setCloudDeleteCandidate(asset)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </article>
              ))}
              {!cloudAssets.length && (
                <div className="cloud-library-empty">
                  <Cloud size={28} />
                  <strong>还没有云端照片</strong>
                  <span>保持自动同步开启，下一次导入参考图或待调色照片后会出现在这里。</span>
                </div>
              )}
            </div>
            {cloudDeleteCandidate && (
              <div className="cloud-delete-confirm" role="alertdialog" aria-modal="true" aria-label="确认删除云端照片">
                <div>
                  <Trash2 size={17} />
                  <span>
                    <strong>从云端永久删除？</strong>
                    <small>{cloudDeleteCandidate.name}</small>
                  </span>
                </div>
                <div>
                  <GlassButton onClick={() => setCloudDeleteCandidate(null)}>取消</GlassButton>
                  <button type="button" onClick={() => removeCloudAsset(cloudDeleteCandidate)}>删除</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
      {styleDialogOpen && (
        <div className="modal-backdrop" onMouseDown={() => setStyleDialogOpen(false)}>
          <section className="modal glass-panel" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title"><div><Sparkle size={18} /><h2>保存参考风格</h2></div><GlassButton className="mini-button" onClick={() => setStyleDialogOpen(false)}><X size={14} /></GlassButton></div>
            <p>V4 全局与局部 LUT、语义区域、光线、质感和参数会先写入本机 IndexedDB；云端账户会同步完整风格，供其他设备调用。</p>
            <label className="field-label">滤镜名称<input autoFocus value={styleName} placeholder="例如：加州暖阳" onChange={(event) => setStyleName(event.target.value)} /></label>
            <div className="dialog-actions"><GlassButton onClick={() => setStyleDialogOpen(false)}>取消</GlassButton><button className="primary-button" disabled={!styleName.trim()} onClick={saveReferenceStyle}>保存滤镜</button></div>
          </section>
        </div>
      )}
      {referencePreview && (
        <div className="modal-backdrop reference-preview-backdrop" onMouseDown={() => setReferencePreview(null)}>
          <section
            className="reference-preview-modal glass-panel"
            role="dialog"
            aria-modal="true"
            aria-label={`参考样片预览：${referencePreview.name}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-title">
              <div><Sparkle size={18} /><h2>参考样片</h2></div>
              <GlassButton className="mini-button" onClick={() => setReferencePreview(null)}><X size={14} /></GlassButton>
            </div>
            <figure className="reference-preview-stage">
              <img src={referencePreview.url} alt={referencePreview.name} />
            </figure>
            <div className="reference-preview-meta">
              <div>
                <strong>{referencePreview.name}</strong>
                <span>
                  {referencePreview.metadata?.width && referencePreview.metadata?.height
                    ? `${referencePreview.metadata.width} × ${referencePreview.metadata.height}`
                    : "工作预览"}
                  {referencePreview.raw ? ` · ${referencePreview.metadata?.bitDepth || 16}-bit RAW` : ""}
                </span>
              </div>
              <small>点击遮罩或按 Esc 返回工作台</small>
            </div>
          </section>
        </div>
      )}
      {stagePreviewOpen && active && (
        <div
          className="modal-backdrop stage-preview-backdrop"
          onMouseDown={() => setStagePreviewOpen(false)}
        >
          <section
            className="stage-preview-modal glass-panel"
            role="dialog"
            aria-modal="true"
            aria-label={`当前照片细节预览：${active.name}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-title">
              <div><Maximize2 size={18} /><h2>细节查看</h2></div>
              <div className="stage-preview-actions">
                <div className="stage-preview-zoom glass-surface" aria-label="缩放控制">
                  <button
                    type="button"
                    aria-label="缩小"
                    disabled={stagePreviewZoom <= 1}
                    onClick={() => zoomStagePreview(stagePreviewView.current.zoom - 0.5)}
                  ><Minus size={13} /></button>
                  <button
                    type="button"
                    className="stage-preview-zoom-value"
                    title="恢复适合窗口"
                    onClick={() => applyStagePreviewView(1, { x: 0, y: 0 })}
                  >{Math.round(stagePreviewZoom * 100)}%</button>
                  <button
                    type="button"
                    aria-label="放大"
                    disabled={stagePreviewZoom >= 6}
                    onClick={() => zoomStagePreview(stagePreviewView.current.zoom + 0.5)}
                  ><Plus size={13} /></button>
                </div>
                <GlassButton
                  className="mini-button"
                  autoFocus
                  aria-label="关闭细节查看"
                  onClick={() => setStagePreviewOpen(false)}
                ><X size={14} /></GlassButton>
              </div>
            </div>
            <div
              ref={stagePreviewViewport}
              className={`stage-preview-stage ${stagePreviewZoom > 1 ? "zoomed" : ""}`}
              title={stagePreviewZoom > 1 ? "拖动查看放大后的细节" : "滚轮或双击放大；拖动调整前后对比"}
              onWheel={(event) => {
                event.preventDefault();
                const factor = Math.exp(-event.deltaY * 0.0015);
                zoomStagePreview(
                  stagePreviewView.current.zoom * factor,
                  event.clientX,
                  event.clientY,
                );
              }}
              onDoubleClick={(event) => {
                if (stagePreviewView.current.zoom > 1) {
                  applyStagePreviewView(1, { x: 0, y: 0 });
                } else zoomStagePreview(2.5, event.clientX, event.clientY);
              }}
              onPointerDown={beginStagePreviewGesture}
              onPointerMove={moveStagePreviewGesture}
              onPointerUp={finishStagePreviewGesture}
              onPointerCancel={finishStagePreviewGesture}
            >
              <canvas
                ref={stageOriginalPreviewCanvas}
                className="stage-preview-canvas original"
                style={{ transform: `translate3d(${stagePreviewPan.x}px, ${stagePreviewPan.y}px, 0) scale(${stagePreviewZoom})` }}
              />
              <div
                className="stage-preview-styled-clip"
                style={{ clipPath: `inset(0 ${100 - stagePreviewSplit}% 0 0)` }}
              >
                <canvas
                  ref={stageStyledPreviewCanvas}
                  className="stage-preview-canvas styled"
                  style={{ transform: `translate3d(${stagePreviewPan.x}px, ${stagePreviewPan.y}px, 0) scale(${stagePreviewZoom})` }}
                />
              </div>
              <button
                type="button"
                className="stage-preview-divider"
                style={{ left: `${stagePreviewSplit}%` }}
                aria-label="拖动调节调色前后对比"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  try {
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                  } catch {
                    // Keep direct dragging available without pointer capture.
                  }
                  updateStagePreviewSplit(event);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                    updateStagePreviewSplit(event);
                  }
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                }}
              >
                <span>↔</span>
              </button>
              <span className="stage-preview-label after">调色后</span>
              <span className="stage-preview-label before">原图</span>
            </div>
            <div className="stage-preview-meta">
              <div>
                <strong>{active.name}</strong>
                <span>
                  {originalCanvas.current?.width && originalCanvas.current?.height
                    ? `${originalCanvas.current.width} × ${originalCanvas.current.height} · 工作预览`
                    : "工作预览"}
                </span>
              </div>
              <small>滚轮、双击或双指缩放 · 放大后拖动画面 · 分隔线始终可比较前后</small>
            </div>
          </section>
        </div>
      )}
      {exportDialogOpen && active && (
        <div className="modal-backdrop" onMouseDown={() => {
          if (!isExporting) setExportDialogOpen(false);
        }}>
          <section className="modal export-modal glass-panel" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title"><div><DownloadSimple size={18} /><h2>导出图片与专业预设</h2></div><GlassButton className="mini-button" disabled={isExporting} onClick={() => setExportDialogOpen(false)}><X size={14} /></GlassButton></div>
            <div className="export-image-panel">
              <div className="export-block-heading">
                <div>
                  <strong>{selectedTargets.length > 1 ? `批量成片 · ${selectedTargets.length} 张` : "成片导出"}</strong>
                  <span>原始尺寸 · 4K · 2K · 1080p</span>
                </div>
                <small>{selectedTargets.length > 1 && !exportDirectory ? "自动打包 ZIP · " : ""}JPEG / PNG / WebP / BMP</small>
              </div>
              <div className="export-grid">
                <label className="field-label full">
                  {selectedTargets.length > 1 ? "批次名称" : "文件名称"}
                  <input value={exportOptions.name} onChange={(event) => setExportOptions({ ...exportOptions, name: event.target.value })} />
                </label>
                <div className="export-destination full">
                  <div>
                    <span>导出位置</span>
                    <strong>{exportDirectory ? exportDirectory.name : "浏览器默认下载位置"}</strong>
                    <small>
                      {exportDirectory
                        ? `成片与预设会直接写入“${exportDirectory.name}”`
                        : typeof window.showDirectoryPicker === "function"
                          ? "可选择文件夹；未选择时，多图会合并为一个 ZIP"
                          : "当前浏览器不支持目录写入，多图会合并为一个 ZIP"}
                    </small>
                  </div>
                  <div>
                    {exportDirectory && (
                      <button type="button" className="destination-clear" onClick={() => setExportDirectory(null)}>恢复默认</button>
                    )}
                    <GlassButton type="button" onClick={chooseExportDirectory}>
                      <FolderOpen size={15} />选择位置
                    </GlassButton>
                  </div>
                </div>
                <label className="field-label">像素大小<select value={exportOptions.resolution} onChange={(event) => setExportOptions({ ...exportOptions, resolution: event.target.value })}><option value="original">原始完整尺寸</option><option value="4k">4K · 最长边 3840</option><option value="2k">2K · 最长边 2560</option><option value="1080p">1080p · 最长边 1920</option></select></label>
                <label className="field-label">图片格式<select value={exportOptions.format} onChange={(event) => setExportOptions({ ...exportOptions, format: event.target.value })}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option><option value="bmp">BMP</option></select></label>
                <label className="field-label full">质量 <span>{exportOptions.quality}%</span><input type="range" min="50" max="100" value={exportOptions.quality} disabled={!["jpeg", "webp"].includes(exportOptions.format)} onChange={(event) => setExportOptions({ ...exportOptions, quality: Number(event.target.value) })} /></label>
              </div>
            </div>
            <div className="preset-export">
              <div>
                <span className="preset-export-badge">DIRECT PRESET EXPORT</span>
                <strong>带走这套颜色，在专业软件继续编辑</strong>
                <p>XMP 可用于 Lightroom / Camera Raw；33³ CUBE LUT 可用于 Photoshop、DaVinci Resolve 等支持 LUT 的软件；CLSTYLE 保留完整 V4.3 语义风格。</p>
                <small>标准 CUBE 无法包含语义局部调整、质感和随机颗粒。</small>
              </div>
              <div>
                <GlassButton className="preset-primary" onClick={() => exportPreset("xmp")}>Lightroom XMP</GlassButton>
                <GlassButton className="preset-primary" onClick={() => exportPreset("cube")}>33³ CUBE LUT</GlassButton>
                <GlassButton onClick={exportClstyle}>完整 CLSTYLE</GlassButton>
              </div>
            </div>
            <div className="dialog-actions">
              <GlassButton disabled={isExporting} onClick={() => setExportDialogOpen(false)}>取消</GlassButton>
              <button className="primary-button" disabled={isExporting} onClick={exportImage}>
                {isExporting
                  ? `正在导出 ${selectedTargets.length} 张…`
                  : selectedTargets.length > 1
                    ? `导出已选 ${selectedTargets.length} 张`
                    : "导出图片"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
