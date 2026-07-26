import { applyBasicAdjustments } from "./basicAdjustments.js";
import { analyzePixels, getHistogram } from "./colorEngine.js";
import { applyCurveLuts } from "./curveMath.js";
import { buildStyleLuts } from "./styleLutEngine.js";

const latestRevisions = new Map();

function isCurrent(photoId, revision) {
  return (latestRevisions.get(photoId) || revision) <= revision;
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "cancel") {
    latestRevisions.set(message.photoId, message.revision);
    return;
  }
  const { id, photoId = "global", revision = 0, type, payload } = message;
  latestRevisions.set(photoId, Math.max(latestRevisions.get(photoId) || 0, revision));
  try {
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
