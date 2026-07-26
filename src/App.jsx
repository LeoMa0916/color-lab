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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  HUE_BANDS,
  analyzePixels,
  applyStyleProfile,
  averageProfiles,
  getHistogram,
  makePalette,
} from "./colorEngine";
import { adjustBasicPixel, applyBasicAdjustments } from "./basicAdjustments";
import { applyCurveLuts, smoothCurveLut as curveLut } from "./curveMath";
import {
  imageFrameToCanvas,
  raw16ToPreviewFrame,
  raw16ToRgba8,
} from "./imageFrame";
import { analyzeSemanticCanvas } from "./semanticEngine";

const IS_MOBILE = typeof navigator !== "undefined"
  && (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || navigator.maxTouchPoints > 2);
const MAX_SIDE = IS_MOBILE ? 960 : 1600;
const CHANNELS = [
  { id: "master", label: "总体", color: "#f5f5f7" },
  { id: "red", label: "红", color: "#ff5d57" },
  { id: "green", label: "绿", color: "#62d46f" },
  { id: "blue", label: "蓝", color: "#5b8cff" },
];
const BASIC_DEFAULTS = {
  referenceLighting: 35,
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
const IDENTITY_LUT = Uint8Array.from({ length: 256 }, (_, value) => value);
const CURVE_PREVIEW_MAX_SIDE = 720;
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

async function decodeRawCanvas(file, maxSide = MAX_SIDE, allowEmbeddedFallback = true) {
  const raw = new LibRaw();
  try {
    await raw.open(new Uint8Array(await file.arrayBuffer()), {
      useCameraWb: true,
      useCameraMatrix: 3,
      outputColor: 4,
      outputBps: 16,
      halfSize: false,
      noAutoBright: true,
      gamm: [1, 1],
      highlight: 5,
      userQual: 3,
    });
    const metadata = await raw.metadata(false);
    const rawWidth = metadata?.width || metadata?.raw_width || 0;
    const rawHeight = metadata?.height || metadata?.raw_height || 0;
    if (IS_MOBILE && rawWidth * rawHeight > 26000000) {
      throw new Error("这张超大 RAW 建议在桌面 Chrome 或 Edge 中处理");
    }
    try {
      const decoded = await raw.imageData();
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

async function rawToAsset(file) {
  const { canvas, metadata } = await decodeRawCanvas(file, MAX_SIDE, true);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("RAW 预览生成失败");
  return {
    url: URL.createObjectURL(blob),
    raw: true,
    sourceFile: file,
    metadata,
  };
}

async function fileToAsset(file) {
  if (isRawFile(file)) return rawToAsset(file);
  if (!file.type.startsWith("image/")) throw new Error("不支持的文件格式");
  return {
    url: URL.createObjectURL(file),
    raw: false,
    sourceFile: file,
    metadata: { preview: "browser-color-managed", bitDepth: 8, workingSpace: "sRGB → Linear ProPhoto RGB" },
  };
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

async function analyzeUrl(url) {
  const image = await loadImage(url);
  const canvas = document.createElement("canvas");
  const context = drawSized(image, canvas, 640);
  const semanticMasks = await analyzeSemanticCanvas(canvas);
  return analyzePixels(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
    { width: canvas.width, height: canvas.height, semanticMasks },
  );
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

function canvasToBmp(canvas) {
  const { width, height } = canvas;
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
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
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      view.setUint8(offset++, pixels[source + 2]);
      view.setUint8(offset++, pixels[source + 1]);
      view.setUint8(offset++, pixels[source]);
      view.setUint8(offset++, pixels[source + 3]);
    }
  }
  return new Blob([buffer], { type: "image/bmp" });
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

function cubePreset(settings, name, size = 17) {
  const master = curveLut(settings.curves.master);
  const red = curveLut(settings.curves.red);
  const green = curveLut(settings.curves.green);
  const blue = curveLut(settings.curves.blue);
  const lines = [`TITLE "${name}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const input = [r, g, b].map((value) => Math.round((value / (size - 1)) * 255));
        const luminance = input[0] * 0.299 + input[1] * 0.587 + input[2] * 0.114;
        const sat = 1 + settings.saturation / 100;
        const factor = (259 * (settings.contrast + 255)) / (255 * (259 - settings.contrast));
        const adjusted = input.map((value, channel) => {
          let result = luminance + (value - luminance) * sat;
          result = factor * (result - 128) + 128;
          if (channel === 0) result += settings.temperature * 0.55;
          if (channel === 2) result -= settings.temperature * 0.55;
          return clamp(result);
        });
        const refined = adjustBasicPixel(adjusted, settings);
        lines.push([
          red[master[Math.round(refined[0])]],
          green[master[Math.round(refined[1])]],
          blue[master[Math.round(refined[2])]],
        ].map((value) => (value / 255).toFixed(6)).join(" "));
      }
    }
  }
  return lines.join("\n");
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
    if (draggingRef.current) queuePreview(next);
    else commit(next);
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

  return (
    <div className="range-row">
      <span>{label}</span>
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
        onPointerDown={() => {
          draggingRef.current = true;
          onInteractionChange?.(true);
        }}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
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

function BasicAdjustmentsPanel({
  settings,
  disabled,
  onChange,
  onPreview,
  onInteractionChange,
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="inspector-section basic-section">
      <button
        type="button"
        className="basic-toggle"
        aria-expanded={open}
        aria-controls="basic-adjustments"
        onClick={() => setOpen((value) => !value)}
      >
        <span>基本</span>
        <CaretDown size={15} className={open ? "open" : ""} />
      </button>
      {open && (
        <div id="basic-adjustments" className="basic-adjustments">
          {BASIC_GROUPS.map((group) => (
            <div className="basic-group" key={group.label}>
              <p>{group.label}</p>
              {group.controls.map((control) => (
                <Range
                  key={control.key}
                  {...control}
                  value={settings[control.key] ?? 0}
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
      )}
    </section>
  );
}

function StyleAnalysis({ profile }) {
  if (!profile) {
    return (
      <section className="inspector-section style-analysis muted-analysis">
        <div className="section-title"><h2>风格 DNA</h2><span>等待样片</span></div>
        <p>上传参考图后分析影调、中性色、21 分区色彩与自然质感。</p>
      </section>
    );
  }
  if (profile.version < 2 || !profile.tone) {
    return (
      <section className="inspector-section style-analysis muted-analysis">
        <div className="section-title"><h2>风格 DNA</h2><span>兼容模式</span></div>
        <p>这是旧版滤镜。重新上传参考图即可生成精细色彩档案。</p>
      </section>
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
    <section className="inspector-section style-analysis">
      <div className="section-title">
        <h2>风格 DNA</h2>
        <span className="analysis-version">
          {semantic ? "语义区域 v4" : profile.version >= 3 ? "分区感知 v3" : "感知分析 v2"}
        </span>
      </div>
      {profile.version >= 3 && (
        <p className="profile-intent">
          {semantic
            ? "本地语义蒙版 · 区域独立色彩档案 · 低置信度安全回退"
            : "中性色独立校准 · 21 色域分区 · 自然质感匹配"}
        </p>
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
    </section>
  );
}

export function App() {
  const [references, setReferences] = useState([]);
  const [referenceStats, setReferenceStats] = useState(null);
  const [targets, setTargets] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [decodeStatus, setDecodeStatus] = useState("");
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [channel, setChannel] = useState("master");
  const [displayHistogram, setDisplayHistogram] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [curveDragging, setCurveDragging] = useState(false);
  const [basicDragging, setBasicDragging] = useState(false);
  const [baseRevision, setBaseRevision] = useState(0);
  const [exported, setExported] = useState(false);
  const [importErrors, setImportErrors] = useState([]);
  const [savedStyles, setSavedStyles] = useState(() => {
    try { return JSON.parse(localStorage.getItem("diaoseshi-styles") || "[]"); }
    catch { return []; }
  });
  const [styleDialogOpen, setStyleDialogOpen] = useState(false);
  const [styleName, setStyleName] = useState("");
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState({
    name: "diaoseshi-export",
    resolution: "original",
    format: "jpeg",
    quality: 92,
  });
  const originalCanvas = useRef(null);
  const styledCanvas = useRef(null);
  const styledBase = useRef(null);
  const styledPreviewBase = useRef(null);
  const curveAdjustedPreviewBase = useRef(null);
  const styledOutput = useRef(null);
  const curvePreviewOutput = useRef(null);
  const semanticMaskCache = useRef(new Map());
  const referenceInput = useRef(null);
  const targetInput = useRef(null);
  const active = targets.find((item) => item.id === activeId) || targets[0] || null;
  const settings = active?.settings || defaultSettings();
  const palette = useMemo(() => makePalette(referenceStats), [referenceStats]);
  const isReady = references.length > 0 && referenceStats && active;

  async function decodeFiles(files, limit) {
    const selected = [...files].slice(0, limit);
    const decoded = [];
    const errors = [];
    for (const file of selected) {
      try {
        setDecodeStatus(isRawFile(file) ? `正在解码 RAW · ${file.name}` : `正在读取 · ${file.name}`);
        const asset = await fileToAsset(file);
        decoded.push({ file, asset });
      } catch (error) {
        errors.push(`${file.name}：${error.message || "无法解码"}`);
      }
    }
    setDecodeStatus("");
    setImportErrors(errors);
    return decoded;
  }

  function updateActiveSettings(patch) {
    if (!active) return;
    setTargets((items) =>
      items.map((item) => item.id === active.id
        ? { ...item, settings: { ...item.settings, ...patch } }
        : item),
    );
  }

  function persistStyles(next) {
    setSavedStyles(next);
    localStorage.setItem("diaoseshi-styles", JSON.stringify(next));
  }

  function saveReferenceStyle() {
    if (!referenceStats || !styleName.trim()) return;
    const next = [
      ...savedStyles.filter((item) => item.name !== styleName.trim()),
      {
        id: crypto.randomUUID(),
        name: styleName.trim(),
        stats: referenceStats,
        palette: makePalette(referenceStats),
        createdAt: Date.now(),
      },
    ];
    persistStyles(next);
    setStyleDialogOpen(false);
    setStyleName("");
  }

  function applySavedStyle(item) {
    setReferenceStats(item.stats);
    setReferences([]);
  }

  function removeSavedStyle(id) {
    persistStyles(savedStyles.filter((item) => item.id !== id));
  }

  async function exportImage() {
    if (!active) return;
    const longEdge = {
      original: Number.POSITIVE_INFINITY,
      "4k": 3840,
      "2k": 2560,
      "1080p": 1920,
    }[exportOptions.resolution];
    setProcessing(true);
    try {
      let source;
      if (active.raw && active.sourceFile) {
        source = (await decodeRawCanvas(
          active.sourceFile,
          longEdge,
          false,
        )).canvas;
      } else {
        const image = await loadImage(active.url);
        source = document.createElement("canvas");
        const scale = Number.isFinite(longEdge)
          ? longEdge / Math.max(image.naturalWidth, image.naturalHeight)
          : 1;
        source.width = Math.max(1, Math.round(image.naturalWidth * scale));
        source.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = source.getContext("2d", { willReadFrequently: true });
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, source.width, source.height);
      }

      const analysisCanvas = document.createElement("canvas");
      const analysisScale = Math.min(1, 640 / Math.max(source.width, source.height));
      analysisCanvas.width = Math.max(1, Math.round(source.width * analysisScale));
      analysisCanvas.height = Math.max(1, Math.round(source.height * analysisScale));
      analysisCanvas.getContext("2d").drawImage(
        source,
        0,
        0,
        analysisCanvas.width,
        analysisCanvas.height,
      );
      const semanticMasks = await analyzeSemanticCanvas(analysisCanvas);
      const context = source.getContext("2d", { willReadFrequently: true });
      const imageData = context.getImageData(0, 0, source.width, source.height);
      const sourceProfile = active.stats || analyzePixels(imageData.data, {
        width: source.width,
        height: source.height,
      });
      applyStyleProfile(
        imageData.data,
        sourceProfile,
        referenceStats || sourceProfile,
        {
          strength: settings.strength,
          referenceLighting: settings.referenceLighting,
          temperature: 0,
          contrast: 0,
          saturation: 0,
          grain: 0,
        },
        [IDENTITY_LUT, IDENTITY_LUT, IDENTITY_LUT, IDENTITY_LUT],
        { width: source.width, height: source.height, semanticMasks },
      );
      applyBasicAdjustments(imageData.data, source.width, source.height, settings);
      applyCurveLuts(imageData.data, settings.curves);
      context.putImageData(imageData, 0, 0);

      const filename = exportOptions.name.trim() || "diaoseshi-export";
      if (exportOptions.format === "bmp") {
        saveBlob(canvasToBmp(source), `${filename}.bmp`);
      } else {
        const mime = {
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
        }[exportOptions.format];
        const blob = await new Promise((resolve) =>
          source.toBlob(resolve, mime, exportOptions.quality / 100),
        );
        saveBlob(blob, `${filename}.${exportOptions.format === "jpeg" ? "jpg" : exportOptions.format}`);
      }
      setExportDialogOpen(false);
      setExported(true);
      window.setTimeout(() => setExported(false), 4000);
    } finally {
      setProcessing(false);
    }
  }

  function exportPreset(type) {
    if (!active) return;
    const name = exportOptions.name.trim() || active.name.replace(/\.[^.]+$/, "");
    const content = type === "xmp"
      ? xmpPreset(settings, name)
      : cubePreset(settings, name);
    saveBlob(
      new Blob([content], { type: type === "xmp" ? "application/rdf+xml" : "text/plain" }),
      `${name}.${type}`,
    );
  }

  async function addReferences(files) {
    setAnalyzing(true);
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
      const stats = await Promise.all(all.map((item) => analyzeUrl(item.url)));
      setReferenceStats(averageProfiles(stats));
    } finally {
      setAnalyzing(false);
    }
  }

  async function addTargets(files) {
    setAnalyzing(true);
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
      const stats = await Promise.all(next.map((item) => analyzeUrl(item.url)));
      const complete = next.map((item, index) => ({ ...item, stats: stats[index] }));
      setTargets((items) => [...items, ...complete].slice(0, 20));
      setActiveId((value) => value || complete[0].id);
    } finally {
      setAnalyzing(false);
    }
  }

  async function loadDemo() {
    setAnalyzing(true);
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
      setReferences(demoReferences);
      setReferenceStats(averageProfiles(refStats));
      setTargets(demoTargets);
      setActiveId(demoTargets[0].id);
    } finally {
      setAnalyzing(false);
    }
  }

  function removeReference(id) {
    const removed = references.find((item) => item.id === id);
    if (removed?.url.startsWith("blob:")) URL.revokeObjectURL(removed.url);
    const next = references.filter((item) => item.id !== id);
    setReferences(next);
    if (!next.length) setReferenceStats(null);
    else {
      setAnalyzing(true);
      Promise.all(next.map((item) => analyzeUrl(item.url)))
        .then((stats) => setReferenceStats(averageProfiles(stats)))
        .finally(() => setAnalyzing(false));
    }
  }

  function removeTarget(id) {
    const removed = targets.find((item) => item.id === id);
    if (removed?.url.startsWith("blob:")) URL.revokeObjectURL(removed.url);
    const next = targets.filter((item) => item.id !== id);
    setTargets(next);
    if (activeId === id) setActiveId(next[0]?.id || null);
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
          semanticMasks = await analyzeSemanticCanvas(originalCanvas.current);
          if (cancelled) return;
          semanticMaskCache.current.set(maskKey, semanticMasks);
        }
        const fullSource = analyzePixels(data, {
          width: imageData.width,
          height: imageData.height,
          semanticMasks,
        });
        const source = active.stats?.semantic ? active.stats : fullSource;
        const reference = referenceStats || source;
        applyStyleProfile(
          data,
          source,
          reference,
          {
            strength: settings.strength,
            temperature: 0,
            contrast: 0,
            saturation: 0,
            grain: 0,
          },
          [IDENTITY_LUT, IDENTITY_LUT, IDENTITY_LUT, IDENTITY_LUT],
          {
            width: imageData.width,
            height: imageData.height,
            semanticMasks,
          },
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
    let histogramTimer = null;
    const frame = requestAnimationFrame(() => {
      const output = renderAdjustedBase(
        base,
        settings,
        settings.curves,
        canvas,
        styledOutput,
      );
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
      if (cancelled) return;
      histogramTimer = window.setTimeout(() => {
        if (!cancelled) setDisplayHistogram(getHistogram(output));
      }, 140);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (histogramTimer !== null) window.clearTimeout(histogramTimer);
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
    settings.curves,
  ]);

  function updateSplit(event) {
    if (!dragging && event.type === "pointermove") return;
    const rect = event.currentTarget.getBoundingClientRect();
    setSplit(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100));
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><SlidersHorizontal size={21} weight="bold" /><span>调色室</span><small>Color Engine 3</small></div>
        <div className="compare-toggle glass-surface"><span>之前</span><span className="active">之后</span></div>
        <div className="header-actions">
          <GlassButton className="demo-button" onClick={loadDemo}><Sparkle size={15} />加载示例</GlassButton>
          <GlassButton className="icon-button" onClick={resetActive} title="重置当前照片"><ArrowCounterClockwise size={18} /></GlassButton>
          <button
            className="primary-button"
            disabled={!active}
            onClick={() => {
              setExportOptions((value) => ({
                ...value,
                name: active.name.replace(/\.[^.]+$/, ""),
              }));
              setExportDialogOpen(true);
            }}
          ><DownloadSimple size={17} weight="bold" />导出</button>
        </div>
      </header>
      {exported && <div className="toast glass-surface" role="status"><Check size={16} weight="bold" />已导出当前照片</div>}

      <section className="workspace">
        <aside className="left-panel glass-panel">
          <div className="panel-heading"><span>参考风格</span><GlassButton className="mini-button" onClick={() => referenceInput.current?.click()}><Plus size={15} /></GlassButton></div>
          <input ref={referenceInput} hidden multiple type="file" accept={IMAGE_ACCEPT} onChange={(event) => addReferences(event.target.files)} />
          <div className="reference-list">
            {references.map((item) => (
              <figure key={item.id} className="reference-thumb">
                <img src={item.url} alt={item.name} />
                {item.raw && (
                  <span className={`raw-badge ${item.metadata?.preview === "embedded" ? "fallback" : ""}`}>
                    {item.metadata?.preview === "embedded" ? "RAW 预览" : "16-bit"}
                  </span>
                )}
                <button title="移除参考图" onClick={() => removeReference(item.id)}><X size={12} weight="bold" /></button>
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
            <div className="saved-style-heading"><span>我的滤镜</span><GlassButton className="save-style-button" disabled={!referenceStats} onClick={() => setStyleDialogOpen(true)}><Plus size={13} />保存</GlassButton></div>
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
            className={`photo-stage ${active ? "has-photo" : ""}`}
            onPointerDown={(event) => { setDragging(true); updateSplit(event); }}
            onPointerMove={updateSplit}
            onPointerUp={() => setDragging(false)}
            onPointerLeave={() => setDragging(false)}
          >
            {active ? (
              <>
                <canvas ref={originalCanvas} className="photo-canvas original" />
                <div className="styled-clip" style={{ width: `${split}%` }}><canvas ref={styledCanvas} className="photo-canvas styled" /></div>
                <div className="split-line" style={{ left: `${split}%` }}><span>‹›</span></div>
                <span className="image-label styled-label">调色后</span>
                <span className="image-label original-label">原图</span>
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
                  ? "正在进行三代精细匹配…"
                  : curveDragging
                    ? "曲线实时预览"
                    : basicDragging
                      ? "基本参数实时预览"
                      : "三代感知匹配"}
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
            <div className="target-strip-title"><span>待调色照片</span><b>{targets.length}</b></div>
            <div className="target-scroller">
              <button className="add-target" onClick={() => targetInput.current?.click()}><Plus size={24} /><span>添加照片</span></button>
              <input ref={targetInput} hidden multiple type="file" accept={IMAGE_ACCEPT} onChange={(event) => addTargets(event.target.files)} />
              {targets.map((item) => (
                <figure
                  key={item.id}
                  className={`target-thumb ${item.id === active?.id ? "active" : ""}`}
                  onClick={() => setActiveId(item.id)}
                >
                  <img src={item.url} alt={item.name} />
                  {item.raw && (
                    <span className={`raw-badge ${item.metadata?.preview === "embedded" ? "fallback" : ""}`}>
                      {item.metadata?.preview === "embedded" ? "RAW 预览" : "16-bit"}
                    </span>
                  )}
                  {item.id === active?.id && <figcaption>正在编辑</figcaption>}
                  <button title="移除照片" onClick={(event) => { event.stopPropagation(); removeTarget(item.id); }}><X size={12} weight="bold" /></button>
                </figure>
              ))}
            </div>
          </section>
        </section>

        <aside className="right-panel glass-panel">
          <section className="inspector-section histogram-section">
            <div className="section-title"><h2>直方图</h2><CaretDown size={15} /></div>
            <HistogramCanvas histogram={displayHistogram || active?.stats?.histogram} />
          </section>
          <StyleAnalysis profile={referenceStats} />
          <BasicAdjustmentsPanel
            settings={settings}
            disabled={!active}
            onChange={updateActiveSettings}
            onPreview={previewBasic}
            onInteractionChange={setBasicDragging}
          />
          <section className="inspector-section curve-section">
            <div className="section-title"><h2>曲线</h2><GlassButton className="reset-curve" onClick={() => updateCurve(structuredClone(DEFAULT_CURVES[channel]))}><ArrowCounterClockwise size={13} />重置</GlassButton></div>
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
          </section>
          <section className="inspector-section effects-section">
            <div className="section-title"><h2>效果</h2></div>
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
          </section>
          <section className="palette-section">
            <div>{palette.map((color) => <span key={color} style={{ background: color }} />)}</div>
            <p>{referenceStats ? `参考色彩 · ${referenceStats.saturation < 0.35 ? "克制饱和" : "鲜明色彩"} · 21 分区取色` : "上传参考图生成色板"}</p>
          </section>
        </aside>
      </section>
      {!!importErrors.length && (
        <div className="import-errors glass-surface" role="alert">
          <strong>部分文件未导入</strong>
          {importErrors.map((item) => <span key={item}>{item}</span>)}
          <button onClick={() => setImportErrors([])}><X size={13} /></button>
        </div>
      )}
      {styleDialogOpen && (
        <div className="modal-backdrop" onMouseDown={() => setStyleDialogOpen(false)}>
          <section className="modal glass-panel" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title"><div><Sparkle size={18} /><h2>保存参考风格</h2></div><GlassButton className="mini-button" onClick={() => setStyleDialogOpen(false)}><X size={14} /></GlassButton></div>
            <p>影调分位、中性色、21 分区色彩和质感档案会保存在这台设备的浏览器中。</p>
            <label className="field-label">滤镜名称<input autoFocus value={styleName} placeholder="例如：加州暖阳" onChange={(event) => setStyleName(event.target.value)} /></label>
            <div className="dialog-actions"><GlassButton onClick={() => setStyleDialogOpen(false)}>取消</GlassButton><button className="primary-button" disabled={!styleName.trim()} onClick={saveReferenceStyle}>保存滤镜</button></div>
          </section>
        </div>
      )}
      {exportDialogOpen && active && (
        <div className="modal-backdrop" onMouseDown={() => setExportDialogOpen(false)}>
          <section className="modal export-modal glass-panel" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title"><div><DownloadSimple size={18} /><h2>导出</h2></div><GlassButton className="mini-button" onClick={() => setExportDialogOpen(false)}><X size={14} /></GlassButton></div>
            <div className="export-grid">
              <label className="field-label full">文件名称<input value={exportOptions.name} onChange={(event) => setExportOptions({ ...exportOptions, name: event.target.value })} /></label>
              <label className="field-label">像素大小<select value={exportOptions.resolution} onChange={(event) => setExportOptions({ ...exportOptions, resolution: event.target.value })}><option value="original">原始预览尺寸</option><option value="4k">4K · 最长边 3840</option><option value="2k">2K · 最长边 2560</option><option value="1080p">1080p · 最长边 1920</option></select></label>
              <label className="field-label">图片格式<select value={exportOptions.format} onChange={(event) => setExportOptions({ ...exportOptions, format: event.target.value })}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option><option value="bmp">BMP</option></select></label>
              <label className="field-label full">质量 <span>{exportOptions.quality}%</span><input type="range" min="50" max="100" value={exportOptions.quality} disabled={!["jpeg", "webp"].includes(exportOptions.format)} onChange={(event) => setExportOptions({ ...exportOptions, quality: Number(event.target.value) })} /></label>
            </div>
            <div className="preset-export">
              <div><strong>导出调色预设</strong><p>XMP 会保留完整基本参数；CUBE 适用于 Photoshop 等软件，但不包含纹理、清晰度等局部质感处理。</p></div>
              <div><GlassButton onClick={() => exportPreset("xmp")}>导出 XMP</GlassButton><GlassButton onClick={() => exportPreset("cube")}>导出 CUBE</GlassButton></div>
            </div>
            <div className="dialog-actions"><GlassButton onClick={() => setExportDialogOpen(false)}>取消</GlassButton><button className="primary-button" onClick={exportImage}>导出图片</button></div>
          </section>
        </div>
      )}
    </main>
  );
}
