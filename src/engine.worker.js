import { applyBasicAdjustments } from "./basicAdjustments.js";
import { analyzePixels, getHistogram } from "./colorEngine.js";
import { applyCurveLuts } from "./curveMath.js";
import { rgbaToBmpBuffer } from "./exportEncoding.js";
import { applyStyleLuts } from "./lut3d.js";
import { buildStyleLuts } from "./styleLutEngine.js";
import { applyTextureMatchTiled } from "./textureEngine.js";

const latestRevisions = new Map();

function profileDistance(source, reference) {
  const tone = source?.tone?.quantiles || [];
  const targetTone = reference?.tone?.quantiles || [];
  const toneDistance = tone.reduce(
    (sum, value, index) => sum + Math.abs(value - (targetTone[index] ?? value)),
    0,
  ) / Math.max(1, tone.length);
  const saturationDistance = Math.abs(
    (source?.saturation || 0) - (reference?.saturation || 0),
  ) * 255;
  return toneDistance + saturationDistance;
}

function sampledDifference(before, after) {
  const stride = Math.max(4, Math.floor(before.length / 24000 / 4) * 4);
  let difference = 0;
  let samples = 0;
  for (let index = 0; index < before.length; index += stride) {
    difference += Math.abs(before[index] - after[index]);
    difference += Math.abs(before[index + 1] - after[index + 1]);
    difference += Math.abs(before[index + 2] - after[index + 2]);
    samples += 3;
  }
  return difference / Math.max(1, samples);
}

function isCurrent(photoId, revision) {
  return (latestRevisions.get(photoId) || revision) <= revision;
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === "cancel") {
    latestRevisions.set(message.photoId, message.revision);
    return;
  }
  const { id, photoId = "global", revision = 0, type, payload } = message;
  latestRevisions.set(photoId, Math.max(latestRevisions.get(photoId) || 0, revision));
  try {
    const report = (percent, label) => {
      if (!isCurrent(photoId, revision)) return;
      self.postMessage({
        id,
        photoId,
        revision,
        progress: { percent: Math.round(percent), label },
      });
    };
    let result;
    let transfer = [];
    if (type === "analyze") {
      result = analyzePixels(payload.data, payload.options);
    } else if (type === "histogram") {
      result = getHistogram(payload.data, payload.bins);
    } else if (type === "build-luts") {
      result = buildStyleLuts(
        payload.source,
        payload.reference,
        payload.settings,
        payload.options,
      );
    } else if (type === "render-basic") {
      const output = new Uint8ClampedArray(payload.data);
      applyBasicAdjustments(output, payload.width, payload.height, payload.settings);
      applyCurveLuts(output, payload.curves);
      result = {
        data: output,
        histogram: getHistogram(output),
        width: payload.width,
        height: payload.height,
      };
      transfer = [output.buffer];
    } else if (type === "render-export") {
      const output = payload.data instanceof Uint8ClampedArray
        ? payload.data
        : new Uint8ClampedArray(payload.data);
      const sourceSample = new Uint8ClampedArray(output);
      report(12, "正在应用 V5 色彩映射");
      applyStyleLuts(
        output,
        payload.width,
        payload.height,
        payload.styleLuts,
        payload.semanticMasks,
      );
      report(30, "正在匹配多尺度质感");
      applyTextureMatchTiled(
        output,
        payload.width,
        payload.height,
        payload.source,
        payload.reference,
        payload.settings.strength / 100,
        {
          onProgress: (progress) =>
            report(30 + progress * 38, "正在分块匹配质感与颗粒"),
        },
      );
      report(72, "正在应用基本调整");
      applyBasicAdjustments(output, payload.width, payload.height, payload.settings);
      report(82, "正在应用曲线");
      applyCurveLuts(output, payload.settings.curves);
      if (
        payload.settings.strength > 5
        && profileDistance(payload.source, payload.reference) > 3
        && sampledDifference(sourceSample, output) < 0.12
      ) {
        throw new Error("仿色结果意外等于原图，请重新分析参考图后再导出");
      }
      report(88, "正在编码图片");

      if (payload.output.format === "bmp") {
        const buffer = rgbaToBmpBuffer(
          output,
          payload.width,
          payload.height,
          (progress) => report(88 + progress * 11, "正在编码 BMP"),
        );
        result = {
          buffer,
          mime: "image/bmp",
          extension: "bmp",
          width: payload.width,
          height: payload.height,
        };
        transfer = [buffer];
      } else if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(payload.width, payload.height);
        canvas.getContext("2d").putImageData(
          new ImageData(output, payload.width, payload.height),
          0,
          0,
        );
        const blob = await canvas.convertToBlob({
          type: payload.output.mime,
          quality: payload.output.quality,
        });
        result = {
          blob,
          mime: payload.output.mime,
          extension: payload.output.extension,
          width: payload.width,
          height: payload.height,
        };
      } else {
        result = {
          data: output,
          mime: payload.output.mime,
          extension: payload.output.extension,
          width: payload.width,
          height: payload.height,
        };
        transfer = [output.buffer];
      }
      report(100, "导出完成");
    } else {
      throw new Error(`未知引擎任务：${type}`);
    }
    if (!isCurrent(photoId, revision)) {
      self.postMessage({ id, photoId, revision, cancelled: true });
      return;
    }
    self.postMessage({ id, photoId, revision, result }, transfer);
  } catch (error) {
    self.postMessage({
      id,
      photoId,
      revision,
      error: error?.message || String(error),
    });
  }
};
