import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const previewPort = await new Promise((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Chrome/Chromium executable not found");
  return executable;
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
        return;
      }
      this.handlers.get(message.method)?.forEach((handler) => handler(message.params));
    });
    this.socket.addEventListener("close", () => {
      this.pending.forEach(({ reject }) => reject(new Error("Chrome DevTools connection closed")));
      this.pending.clear();
    });
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  async send(method, params = {}) {
    await this.opened;
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  close() {
    this.socket.close();
  }
}

async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${previewPort}/`);
      if (response.ok) return;
    } catch {
      // The preview server is still starting.
    }
    await delay(200);
  }
  throw new Error("Vite preview server did not become ready");
}

async function debuggerPort(profile) {
  const path = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const [port] = readFileSync(path, "utf8").split(/\r?\n/);
      if (Number(port)) return Number(port);
    }
    await delay(200);
  }
  throw new Error("Chrome debugging port did not become ready");
}

async function debuggerTarget(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then((response) => response.json());
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {
      // The target list is still starting.
    }
    await delay(150);
  }
  throw new Error("Chrome page target did not become ready");
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Browser evaluation failed");
  }
  return response.result.value;
}

async function waitFor(cdp, expression, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

const preview = spawn(process.execPath, [
  join(project, "node_modules", "vite", "bin", "vite.js"),
  "preview",
  "--host",
  "127.0.0.1",
  "--port",
  String(previewPort),
], {
  cwd: project,
  stdio: "ignore",
  windowsHide: true,
});
const profile = mkdtempSync(join(tmpdir(), "color-engine-e2e-"));
let chrome;
let cdp;

try {
  await waitForServer();
  chrome = spawn(chromeExecutable(), [
    "--headless=new",
    "--no-first-run",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1440,1000",
    `http://127.0.0.1:${previewPort}/`,
  ], { stdio: "ignore", windowsHide: true });
  const port = await debuggerPort(profile);
  const target = await debuggerTarget(port);
  cdp = new Cdp(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    consoleErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "error") consoleErrors.push(entry.text);
  });
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Log.enable"),
  ]);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${previewPort}/` });
  await waitFor(
    cdp,
    "document.readyState === 'complete' && document.querySelector('.landing-login-button')",
  );
  await evaluate(cdp, "document.querySelector('.landing-login-button').click()");
  await waitFor(cdp, "document.querySelector('[data-testid=\"auth-register-tab\"]')");
  await evaluate(cdp, "document.querySelector('.legal-consent-row button').click()");
  await waitFor(cdp, "document.querySelector('.legal-dialog .legal-document')");
  const legalDialog = await evaluate(cdp, `(() => {
    const dialog = document.querySelector('.legal-dialog');
    return {
      title: dialog.querySelector('h2')?.textContent,
      sections: dialog.querySelectorAll('.legal-document > section').length,
      withinViewport: dialog.getBoundingClientRect().bottom <= innerHeight
        && dialog.getBoundingClientRect().top >= 0,
    };
  })()`);
  assert(legalDialog.title === "用户协议", "User agreement did not open from auth");
  assert(legalDialog.sections >= 7, "User agreement is incomplete");
  assert(legalDialog.withinViewport, "Legal dialog exceeds the desktop viewport");
  await evaluate(cdp, "document.querySelector('.legal-dialog > header > button').click()");
  await waitFor(cdp, "!document.querySelector('.legal-dialog')");
  await evaluate(cdp, "document.querySelector('[data-testid=\"auth-register-tab\"]').click()");
  await delay(120);
  await evaluate(cdp, `(() => {
    const setValue = (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(document.querySelector('input[autocomplete="username"]'), 'engine_qa');
    const passwords = document.querySelectorAll('input[autocomplete="new-password"]');
    setValue(passwords[0], 'EngineQA2026');
    setValue(passwords[1], 'EngineQA2026');
  })()`);
  await delay(80);
  await evaluate(cdp, "document.querySelector('[data-testid=\"legal-consent\"]').click()");
  await delay(80);
  await evaluate(cdp, "document.querySelector('[data-testid=\"auth-submit\"]').click()");
  await waitFor(cdp, "document.readyState === 'complete' && document.querySelector('.demo-button')");

  // Desktop pointer capture on the empty photo stage must not swallow the
  // central upload button's click before a target photo exists.
  const emptyUploadPoint = await evaluate(cdp, `(() => {
    const input = document.querySelector('[data-testid="target-photo-input"]');
    input.addEventListener('click', (event) => {
      event.preventDefault();
      window.__targetPhotoPickerOpened = (window.__targetPhotoPickerOpened || 0) + 1;
    }, { once: true });
    const rect = document.querySelector('[data-testid="empty-target-upload"] b').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: emptyUploadPoint.x,
    y: emptyUploadPoint.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: emptyUploadPoint.x,
    y: emptyUploadPoint.y,
    button: "left",
    clickCount: 1,
  });
  await waitFor(cdp, "window.__targetPhotoPickerOpened === 1");
  const emptyUploadState = await evaluate(cdp, `(() => ({
    pickerOpened: window.__targetPhotoPickerOpened,
    previewOpened: Boolean(document.querySelector('.stage-preview-modal')),
  }))()`);
  assert(emptyUploadState.pickerOpened === 1, "Desktop central upload button did not open the target picker");
  assert(!emptyUploadState.previewOpened, "Empty photo stage opened the detail viewer instead of the target picker");

  await evaluate(cdp, "document.querySelector('.demo-button').click()");
  await waitFor(
    cdp,
    "document.querySelectorAll('.reference-thumb').length >= 2 && document.querySelectorAll('.target-thumb').length >= 5 && document.querySelector('canvas.styled')?.width > 0",
  );
  await delay(1500);
  const selectedBefore = await evaluate(cdp, `(() => {
    const selectedBefore = document.querySelectorAll('.target-thumb.selected').length;
    document.querySelector('.target-selection-actions button:last-child').click();
    const selectors = document.querySelectorAll('.target-select');
    selectors[0].click();
    selectors[1].click();
    return selectedBefore;
  })()`);
  await waitFor(cdp, "document.querySelectorAll('.target-thumb.selected').length === 2");
  const batchWorkflow = await evaluate(cdp, `(() => ({
      selectedAfter: document.querySelectorAll('.target-thumb.selected').length,
      exportLabel: document.querySelector('.header-actions > .primary-button')?.textContent.trim()
  }))()`);
  assert(selectedBefore === 5, "Newly imported target photos are not selected for batch export");
  assert(batchWorkflow.selectedAfter === 2, "Target multi-selection did not retain two photos");
  assert(batchWorkflow.exportLabel.includes("2"), "Batch export count is not visible in the primary action");

  // Start several photo renders close together. A completed render from an
  // older photo must never overwrite either half of the current comparison.
  await evaluate(cdp, "document.querySelectorAll('.target-thumb')[1].click()");
  await delay(20);
  await evaluate(cdp, "document.querySelectorAll('.target-thumb')[0].click()");
  await waitFor(
    cdp,
    "document.querySelector('canvas.original')?.dataset.photoId === 'demo-a' && document.querySelector('canvas.styled')?.dataset.photoId === 'demo-a'",
  );
  await delay(1800);
  const switchedCanvasState = await evaluate(cdp, `(() => {
    const original = document.querySelector('canvas.original');
    const styled = document.querySelector('canvas.styled');
    return {
      activeName: document.querySelector('.target-thumb.active img')?.alt,
      originalId: original?.dataset.photoId,
      styledId: styled?.dataset.photoId,
      sameDimensions: original?.width === styled?.width && original?.height === styled?.height,
    };
  })()`);
  assert(switchedCanvasState.activeName === "海岸街道 01", "Rapid photo selection lost the active target");
  assert(switchedCanvasState.originalId === switchedCanvasState.styledId, "Before/after canvases belong to different photos");
  assert(switchedCanvasState.sameDimensions, "Before/after canvases kept different photo dimensions");
  console.log("Rapid photo switching verification passed", switchedCanvasState);
  await evaluate(cdp, "document.querySelector('.reference-thumb').click()");
  await waitFor(cdp, "document.querySelector('.reference-preview-modal img')");
  const referencePreview = await evaluate(cdp, `(() => {
    const modal = document.querySelector('.reference-preview-modal');
    return {
      visible: modal.getBoundingClientRect().height > 100,
      name: modal.querySelector('.reference-preview-meta strong')?.textContent
    };
  })()`);
  assert(referencePreview.visible && referencePreview.name, "Reference sample preview did not open");
  await evaluate(cdp, "document.querySelector('.reference-preview-modal .mini-button').click()");
  await waitFor(cdp, "!document.querySelector('.reference-preview-modal')");

  await evaluate(cdp, "document.querySelector('.stage-expand-button').click()");
  await waitFor(cdp, "document.querySelector('.stage-preview-modal')");
  const stagePreview = await evaluate(cdp, `(() => {
    const modal = document.querySelector('.stage-preview-modal');
    const stage = document.querySelector('.stage-preview-stage');
    return {
      modalVisible: modal.getBoundingClientRect().height > 400,
      stageVisible: stage.getBoundingClientRect().height > 300,
      withinViewport: modal.getBoundingClientRect().top >= 0
        && modal.getBoundingClientRect().bottom <= innerHeight,
      canvases: stage.querySelectorAll('canvas').length,
    };
  })()`);
  assert(stagePreview.modalVisible && stagePreview.stageVisible, "Stage detail preview is not visible");
  assert(stagePreview.withinViewport, "Stage detail preview exceeds the desktop viewport");
  assert(stagePreview.canvases === 2, "Stage detail preview is missing before/after canvases");
  await evaluate(cdp, `(() => {
    const zoomIn = document.querySelector('.stage-preview-zoom button:last-child');
    zoomIn.click();
    zoomIn.click();
  })()`);
  await waitFor(cdp, "document.querySelector('.stage-preview-zoom-value')?.textContent === '200%'");
  const zoomedTransform = await evaluate(
    cdp,
    "document.querySelector('.stage-preview-canvas.original').style.transform",
  );
  assert(zoomedTransform.includes("scale(2)"), "Stage detail preview did not apply real image zoom");
  const zoomStageRect = await evaluate(cdp, `(() => {
    const rect = document.querySelector('.stage-preview-stage').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
  const panStartX = zoomStageRect.x + zoomStageRect.width * 0.72;
  const panStartY = zoomStageRect.y + zoomStageRect.height * 0.62;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: panStartX,
    y: panStartY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: panStartX - 80,
    y: panStartY - 45,
    button: "left",
    buttons: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: panStartX - 80,
    y: panStartY - 45,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await delay(120);
  const pannedTransform = await evaluate(
    cdp,
    "document.querySelector('.stage-preview-canvas.original').style.transform",
  );
  assert(!pannedTransform.includes("translate3d(0px, 0px"), "Zoomed detail preview did not pan");
  const detailDesktopShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(
    join(project, "qa-private", "stage-detail-desktop.png"),
    Buffer.from(detailDesktopShot.data, "base64"),
  );
  await evaluate(cdp, "document.querySelector('.stage-preview-modal .mini-button').click()");
  await waitFor(cdp, "!document.querySelector('.stage-preview-modal')");

  await evaluate(cdp, "document.querySelector('.header-actions > .primary-button').click()");
  await waitFor(cdp, "document.querySelector('.export-destination')");
  const exportDialog = await evaluate(cdp, `(() => ({
    title: document.querySelector('.export-block-heading strong')?.textContent,
    destination: document.querySelector('.export-destination strong')?.textContent,
    button: document.querySelector('.export-modal .dialog-actions .primary-button')?.textContent.trim()
  }))()`);
  assert(exportDialog.title.includes("2"), "Export dialog does not describe the selected batch");
  assert(exportDialog.destination.includes("默认下载位置"), "Export destination fallback is missing");
  assert(exportDialog.button.includes("2"), "Batch export button does not include the selection count");
  await evaluate(cdp, "document.querySelector('.export-modal .modal-title .mini-button').click()");
  await waitFor(cdp, "!document.querySelector('.export-modal')");

  await evaluate(cdp, `(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['preview'], 'wechat-drag.jpg', { type: 'image/jpeg' }));
    document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
  })()`);
  await waitFor(cdp, "document.querySelector('.drag-import-overlay')");
  const dragChoices = await evaluate(
    cdp,
    "document.querySelectorAll('.drag-import-zone').length",
  );
  assert(dragChoices === 2, "Page-level drag import does not expose reference and target choices");
  await evaluate(cdp, `(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['preview'], 'wechat-drag.jpg', { type: 'image/jpeg' }));
    document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: transfer }));
  })()`);
  await waitFor(cdp, "!document.querySelector('.drag-import-overlay')");
  const desktopShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(
    join(project, "qa-private", "batch-workflow-desktop.png"),
    Buffer.from(desktopShot.data, "base64"),
  );

  const disclosures = await evaluate(
    cdp,
    "document.querySelectorAll('.right-panel .inspector-disclosure-toggle').length",
  );
  assert(disclosures >= 6, "Every inspector module must be collapsible");

  const checksumExpression = `(() => {
    const canvas = document.querySelector('canvas.styled');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    const stride = Math.max(4, Math.floor(data.length / 16000 / 4) * 4);
    for (let index = 0; index < data.length; index += stride) {
      sum = (sum + data[index] * 3 + data[index + 1] * 5 + data[index + 2] * 7) % 2147483647;
    }
    return sum;
  })()`;
  await evaluate(cdp, "document.querySelector('.color-plane-section .inspector-disclosure-toggle').click()");
  await waitFor(cdp, "document.querySelector('.color-plane-section .plane-node')");
  await evaluate(cdp, "document.querySelector('.color-plane-section').scrollIntoView({ block: 'center' })");
  await delay(180);
  const planeBefore = await evaluate(cdp, checksumExpression);
  const planeNode = await evaluate(cdp, `(() => {
    const rect = document.querySelector('.color-plane-section .plane-node').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: planeNode.x,
    y: planeNode.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: planeNode.x + 18,
    y: planeNode.y - 24,
    button: "left",
    buttons: 1,
  });
  await delay(180);
  const planeLive = await evaluate(cdp, checksumExpression);
  assert(planeBefore !== planeLive, "V5 A/B color-plane node did not update the live preview");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: planeNode.x + 18,
    y: planeNode.y - 24,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await delay(1200);
  const planeCommitted = await evaluate(cdp, checksumExpression);
  assert(planeBefore !== planeCommitted, "V5 A/B edit reverted after its full-quality render");
  await evaluate(cdp, "document.querySelector('.color-plane-section .reset-curve').click()");
  await delay(1200);
  const planeReset = await evaluate(cdp, checksumExpression);
  assert(planeReset === planeBefore, "V5 color-plane reset did not restore the image");
  const colorPlaneShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(
    join(project, "qa-private", "v5-color-plane-desktop.png"),
    Buffer.from(colorPlaneShot.data, "base64"),
  );

  async function verifyContinuousRange(label, finalValue, liveDelay = 180) {
    const encodedLabel = JSON.stringify(label);
    await waitFor(cdp, `document.querySelector('input[aria-label=' + ${encodedLabel} + ']')`);
    const before = await evaluate(cdp, checksumExpression);
    await evaluate(cdp, `(() => {
      const label = ${encodedLabel};
      const input = document.querySelector('input[aria-label="' + label + '"]');
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (let step = 1; step <= 20; step += 1) {
        setter.call(input, String((${Number(finalValue)} * step / 20).toFixed(4)));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await delay(liveDelay);
    const live = await evaluate(cdp, checksumExpression);
    assert(before !== live, `${label} did not update the canvas during continuous input`);
    await evaluate(cdp, `(() => {
      const label = ${encodedLabel};
      document.querySelector('input[aria-label="' + label + '"]')
        .dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 7 }));
    })()`);
    await delay(1000);
    const committed = await evaluate(cdp, checksumExpression);
    assert(before !== committed, `${label} reverted after the final render`);
  }
  const initialChecksum = await evaluate(cdp, checksumExpression);
  await waitFor(cdp, "document.querySelector('input[aria-label=\"曝光度\"]')");
  await evaluate(cdp, `(() => {
    const input = document.querySelector('input[aria-label="曝光度"]');
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (let step = 1; step <= 24; step += 1) {
      setter.call(input, String((0.75 * step / 24).toFixed(4)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await waitFor(
    cdp,
    "document.querySelector('input[aria-label=\"曝光度\"]').closest('.range-row').querySelector('output')?.textContent.includes('+0.75')",
  );
  await delay(160);
  const basicChecksum = await evaluate(cdp, checksumExpression);
  assert(initialChecksum !== basicChecksum, "Continuous basic adjustment did not update the live preview");
  await evaluate(cdp, `document.querySelector('input[aria-label="曝光度"]')
    .dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }))`);
  await delay(1200);
  const committedChecksum = await evaluate(cdp, checksumExpression);
  assert(initialChecksum !== committedChecksum, "Final basic adjustment render reverted to the unadjusted image");

  await evaluate(cdp, `(() => {
    const label = document.querySelector('[data-range-label="曝光度"] .range-label');
    label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  })()`);
  await waitFor(
    cdp,
    "document.querySelector('[data-range-label=\"曝光度\"] input[type=\"range\"]')?.value === '0'",
  );
  await delay(1200);
  const resetChecksum = await evaluate(cdp, checksumExpression);
  assert(resetChecksum === initialChecksum, "Double-clicking a Basic label did not reset its parameter");

  await verifyContinuousRange("色温", 32);
  await verifyContinuousRange("饱和度", -48);
  await verifyContinuousRange("参考光线", 76, 1400);

  await evaluate(cdp, "document.querySelector('.curve-section .inspector-disclosure-toggle').click()");
  await waitFor(cdp, "document.querySelector('.curve-canvas')");
  await evaluate(cdp, "document.querySelector('.curve-canvas').scrollIntoView({ block: 'center' })");
  await delay(300);
  const curveRect = await evaluate(cdp, `(() => {
    const rect = document.querySelector('.curve-canvas').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
  const centerX = curveRect.x + curveRect.width * 0.5;
  const centerY = curveRect.y + curveRect.height * 0.5;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: centerX,
    y: centerY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: centerX,
    y: centerY - 36,
    button: "left",
    buttons: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: centerX,
    y: centerY - 36,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await delay(1200);
  const curveChecksum = await evaluate(cdp, checksumExpression);
  assert(curveChecksum !== basicChecksum, "Curve adjustment did not change the preview");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, "document.readyState === 'complete' && document.querySelector('.workspace')");
  if (!await evaluate(cdp, "Boolean(document.querySelector('.stage-expand-button'))")) {
    await evaluate(cdp, "document.querySelector('.demo-button').click()");
    await waitFor(
      cdp,
      "document.querySelector('.stage-expand-button') && document.querySelector('canvas.styled')?.width > 0",
    );
    await delay(900);
  }
  const mobile = await evaluate(cdp, `({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  })`);
  assert(mobile.width === 390, `Unexpected mobile viewport width: ${mobile.width}`);
  assert(mobile.scrollWidth === mobile.width, "Mobile layout overflows horizontally");
  const mobileShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(
    join(project, "qa-private", "batch-workflow-mobile.png"),
    Buffer.from(mobileShot.data, "base64"),
  );

  await evaluate(cdp, "document.querySelector('.stage-expand-button').click()");
  await waitFor(cdp, "document.querySelector('.stage-preview-modal')");
  await evaluate(cdp, "document.querySelector('.stage-preview-zoom button:last-child').click()");
  await waitFor(cdp, "document.querySelector('.stage-preview-zoom-value')?.textContent === '150%'");
  const mobileDetail = await evaluate(cdp, `(() => {
    const modal = document.querySelector('.stage-preview-modal');
    return {
      right: modal.getBoundingClientRect().right,
      bottom: modal.getBoundingClientRect().bottom,
      width: innerWidth,
      height: innerHeight,
      transform: document.querySelector('.stage-preview-canvas.original').style.transform,
    };
  })()`);
  assert(mobileDetail.right <= mobileDetail.width, "Mobile detail preview overflows horizontally");
  assert(mobileDetail.bottom <= mobileDetail.height, "Mobile detail preview overflows vertically");
  assert(mobileDetail.transform.includes("scale(1.5)"), "Mobile detail zoom control did not enlarge the image");
  const detailMobileShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(
    join(project, "qa-private", "stage-detail-mobile.png"),
    Buffer.from(detailMobileShot.data, "base64"),
  );
  await evaluate(cdp, "document.querySelector('.stage-preview-modal .mini-button').click()");
  await waitFor(cdp, "!document.querySelector('.stage-preview-modal')");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 844,
    height: 390,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, "document.readyState === 'complete' && document.querySelector('.workspace')");
  const landscape = await evaluate(cdp, `({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    workspaceHeight: document.querySelector('.workspace').getBoundingClientRect().height
  })`);
  assert(landscape.scrollWidth === landscape.width, "Landscape layout overflows horizontally");
  assert(landscape.workspaceHeight > 0, "Landscape workspace is not visible");

  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reducedMotion = await evaluate(cdp, `(() => {
    const styles = getComputedStyle(document.querySelector('.editor-account'));
    return {
      animationDuration: styles.animationDuration,
      transitionDuration: styles.transitionDuration
    };
  })()`);
  assert(
    reducedMotion.animationDuration === "1e-05s"
      || reducedMotion.animationDuration === "0.00001s",
    `Reduced motion animation is still active: ${reducedMotion.animationDuration}`,
  );
  const expectedLocalApiErrors = consoleErrors.filter((item) =>
    item.includes("server responded with a status of 404"));
  const unexpectedConsoleErrors = consoleErrors.filter((item) =>
    !item.includes("server responded with a status of 404"));
  assert(
    expectedLocalApiErrors.length <= 2,
    `Unexpected number of local API fallbacks: ${expectedLocalApiErrors.length}`,
  );
  assert(
    !unexpectedConsoleErrors.length,
    `Browser console errors: ${unexpectedConsoleErrors.join(" | ")}`,
  );

  console.log("Browser end-to-end verification passed", {
    checksums: [initialChecksum, basicChecksum, resetChecksum, curveChecksum],
    mobile,
    landscape,
    reducedMotion,
    consoleErrors: unexpectedConsoleErrors.length,
  });
} finally {
  cdp?.close();
  chrome?.kill();
  preview.kill();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  } catch {
    // Chrome can retain a cache handle briefly on Windows; the OS temp folder is safe to retain.
  }
}
