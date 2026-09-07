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
const importReferenceFixture = process.env.COLORLAB_REFERENCE_TEST_IMAGE
  || join(project, "public", "demo", "coast-reference.png");
const importTargetFixture = process.env.COLORLAB_TARGET_TEST_IMAGE
  || join(project, "public", "demo", "coast-target.png");
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

async function canvasChecksum(cdp, selector = "canvas.styled") {
  return evaluate(cdp, `(() => {
    const canvas = document.querySelector(${JSON.stringify(selector)});
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    const stride = Math.max(4, Math.floor(data.length / 16000 / 4) * 4);
    for (let index = 0; index < data.length; index += stride) {
      sum = (sum + data[index] * 3 + data[index + 1] * 5 + data[index + 2] * 7) % 2147483647;
    }
    return sum;
  })()`);
}

async function waitFor(cdp, expression, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function setFileInputFiles(cdp, selector, files) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  assert(nodeId, `File input not found: ${selector}`);
  await cdp.send("DOM.setFileInputFiles", { nodeId, files });
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
    cdp.send("DOM.enable"),
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
  await evaluate(cdp, "document.querySelector('.app-download-trigger').click()");
  await waitFor(cdp, "document.querySelectorAll('.app-download-row a').length === 2");
  assert(await evaluate(cdp, "document.activeElement.classList.contains('app-download-close')"), "Download dialog did not receive focus");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(cdp, "!document.querySelector('.app-download-panel')");
  assert(await evaluate(cdp, "document.activeElement.classList.contains('app-download-trigger')"), "Download dialog did not restore focus");
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

  // Exercise the production import path instead of relying only on the demo
  // loader, then prove both automatic style transfer and inspector controls
  // paint new pixels to the target canvas.
  await setFileInputFiles(
    cdp,
    '[data-testid="reference-photo-input"]',
    [importReferenceFixture],
  );
  await waitFor(
    cdp,
    "document.querySelectorAll('.reference-thumb').length === 1 && !document.querySelector('.global-progress')",
    120000,
  );
  await setFileInputFiles(
    cdp,
    '[data-testid="target-photo-input"]',
    [importTargetFixture],
  );
  await waitFor(
    cdp,
    "document.querySelectorAll('.target-thumb').length === 1 && document.querySelector('canvas.styled')?.width > 0 && !document.querySelector('.global-progress') && !document.querySelector('.engine-status.active')",
    120000,
  );
  await delay(800);
  const importCanvasChecksums = {
    original: await canvasChecksum(cdp, "canvas.original"),
    styled: await canvasChecksum(cdp),
  };
  assert(
    importCanvasChecksums.original !== importCanvasChecksums.styled,
    "Real file import did not produce a styled target preview",
  );
  const importedStyledBefore = importCanvasChecksums.styled;
  await evaluate(cdp, `(() => {
    const input = document.querySelector('input[aria-label="曝光度"]');
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 19 }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.85');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(220);
  const importedStyledLive = await canvasChecksum(cdp);
  assert(importedStyledLive !== importedStyledBefore, "Inspector adjustment did not update a real imported photo");
  await evaluate(cdp, `document.querySelector('input[aria-label="曝光度"]')
    .dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 19 }))`);
  await delay(1200);
  const importedStyledCommitted = await canvasChecksum(cdp);
  assert(
    importedStyledCommitted !== importedStyledBefore,
    "Inspector adjustment reverted after rendering a real imported photo",
  );
  console.log("Real file import and inspector adjustment verification passed", {
    automaticStyle: importCanvasChecksums,
    inspector: { before: importedStyledBefore, live: importedStyledLive, committed: importedStyledCommitted },
  });

  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, "document.readyState === 'complete' && document.querySelector('.demo-button')");

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

  await evaluate(cdp, `(() => {
    const input = document.querySelector('input[aria-label="风格强度"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '31');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  })()`);
  await waitFor(cdp, "document.querySelector('input[aria-label=\"风格强度\"]').value === '68'");
  await delay(900);

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
  await evaluate(cdp, `(() => {
    const input = document.querySelector('input[aria-label="导出质量"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '61');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  })()`);
  await waitFor(cdp, "document.querySelector('input[aria-label=\"导出质量\"]').value === '92'");
  await evaluate(cdp, `(() => {
    window.__exportWrites = [];
    window.__directoryPermissionRequested = 0;
    let permission = 'prompt';
    window.showDirectoryPicker = async () => ({
      kind: 'directory',
      name: 'QA Export',
      queryPermission: async () => permission,
      requestPermission: async () => {
        window.__directoryPermissionRequested += 1;
        permission = 'granted';
        return permission;
      },
      getFileHandle: async (name) => ({
        createWritable: async () => ({
          write: async (blob) => window.__exportWrites.push({ name, size: blob.size }),
          close: async () => {},
        }),
      }),
    });
    document.querySelector('.export-destination .glass-button').click();
  })()`);
  await waitFor(cdp, "document.querySelector('.export-destination strong')?.textContent === 'QA Export'");
  const directoryGrant = await evaluate(cdp, "window.__directoryPermissionRequested");
  assert(directoryGrant === 1, "Export directory permission was not confirmed during selection");
  await evaluate(cdp, `(() => {
    const resolution = document.querySelectorAll('.export-grid select')[0];
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(resolution, '1080p');
    resolution.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.export-modal .dialog-actions .primary-button').click();
  })()`);
  await waitFor(
    cdp,
    "window.__exportWrites?.length === 2 && !document.querySelector('.global-progress')",
    180000,
  );
  const directoryWrites = await evaluate(cdp, "window.__exportWrites");
  assert(directoryWrites.every((file) => file.size > 1000), "Directory export wrote an empty image");
  assert(directoryWrites.every((file) => /\.(jpg|png|webp|bmp)$/i.test(file.name)), "Directory export used an invalid image filename");
  await waitFor(cdp, "!document.querySelector('.export-modal')");
  console.log("Desktop directory export verification passed", directoryWrites);

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

  await evaluate(cdp, `document.querySelector('[data-range-label="曝光度"] input[type="range"]')
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`);
  await waitFor(
    cdp,
    "document.querySelector('[data-range-label=\"曝光度\"] input[type=\"range\"]')?.value === '0'",
  );
  await delay(1200);
  const resetChecksum = await evaluate(cdp, checksumExpression);
  assert(resetChecksum === initialChecksum, "Double-clicking a slider thumb did not reset its parameter");

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

  const splitBeforeMask = await evaluate(cdp, "parseFloat(document.querySelector('.split-line').style.left)");
  await evaluate(cdp, "document.querySelector('.masking-section .inspector-disclosure-toggle').click()");
  await waitFor(cdp, "document.querySelector('.masking-section .mask-tool-grid')");
  await evaluate(cdp, "document.querySelectorAll('.masking-section .mask-tool-grid button')[2].click()");
  await waitFor(cdp, "document.querySelector('.masking-section .active-mask-editor')");
  const maskBefore = await evaluate(cdp, checksumExpression);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('.masking-section input[aria-label="曝光度"]');
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 19 }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1.25');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(180);
  const maskLive = await evaluate(cdp, `(() => ({
    checksum: ${checksumExpression},
    overlayWidth: document.querySelector('.photo-edit-overlay').width,
  }))()`);
  assert(maskBefore !== maskLive.checksum, "Local radial mask exposure did not update during slider input");
  assert(maskLive.overlayWidth === 1, "Red mask overlay should hide while local adjustments are being previewed");
  await evaluate(cdp, `document.querySelector('.masking-section input[aria-label="曝光度"]')
    .dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 19 }))`);
  await delay(1200);
  const maskAfter = await evaluate(cdp, checksumExpression);
  assert(maskBefore !== maskAfter, "Local radial mask exposure reverted after the final render");
  await waitFor(cdp, "document.querySelector('.photo-edit-overlay').width > 1");
  await waitFor(cdp, "document.querySelector('.photo-stage.editing-mask')");
  const maskStage = await evaluate(cdp, `(() => {
    const rect = document.querySelector('.photo-stage').getBoundingClientRect();
    return { x: rect.x + rect.width * .48, y: rect.y + rect.height * .52 };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: maskStage.x, y: maskStage.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: maskStage.x + 64, y: maskStage.y + 20, button: "left", buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: maskStage.x + 64, y: maskStage.y + 20, button: "left", buttons: 0, clickCount: 1 });
  await waitFor(cdp, "document.querySelector('.mask-layer-list > button.active small')?.textContent.includes('1')");
  const brushState = await evaluate(cdp, `(() => ({
    overlayWidth: document.querySelector('.photo-edit-overlay').width,
    sourceLabel: document.querySelector('.mask-layer-list > button.active small')?.textContent,
  }))()`);
  assert(brushState.overlayWidth > 1, "Mask overlay did not render on the photo stage");
  await evaluate(cdp, "document.querySelector('.stage-expand-button').click()");
  await waitFor(cdp, "!document.querySelector('.photo-stage.editing-mask')");
  const splitAfterMask = await evaluate(cdp, "parseFloat(document.querySelector('.split-line').style.left)");
  assert(Math.abs(splitAfterMask - splitBeforeMask) < 0.01, "Mask tool did not restore the comparison split");

  await evaluate(cdp, "document.querySelector('.geometry-section .inspector-disclosure-toggle').click()");
  await waitFor(cdp, "document.querySelector('.geometry-section .aspect-presets')");
  await evaluate(cdp, `(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const wide = document.querySelector('input[aria-label="自定义裁切宽度"]');
    const tall = document.querySelector('input[aria-label="自定义裁切高度"]');
    setter.call(wide, '2.39');
    wide.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(tall, '1');
    tall.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(cdp, "document.querySelector('input[aria-label=\"自定义裁切宽度\"]').value === '2.39'");
  await evaluate(cdp, "document.querySelector('.custom-aspect-editor button').click()");
  await waitFor(cdp, "localStorage.getItem('color-lab-custom-crop-ratios-v1')?.includes('2.39:1')");
  await waitFor(cdp, "Math.abs(document.querySelector('canvas.styled').width / document.querySelector('canvas.styled').height - 2.39) < 0.02");
  const customRatioState = await evaluate(cdp, `(() => {
    const canvas = document.querySelector('canvas.styled');
    return {
      ratio: canvas.width / canvas.height,
      saved: [...document.querySelectorAll('.saved-aspect-presets span')]
        .some((item) => item.textContent.includes('2.39:1')),
    };
  })()`);
  assert(Math.abs(customRatioState.ratio - 2.39) < 0.02, "Custom crop ratio did not change the rendered frame");
  assert(customRatioState.saved, "Custom crop ratio was not retained in the inspector");
  await evaluate(cdp, `(() => {
    [...document.querySelectorAll('.geometry-section .aspect-presets button')]
      .find((button) => button.textContent.trim() === '1:1').click();
  })()`);
  await waitFor(cdp, "document.querySelector('canvas.styled').width === document.querySelector('canvas.styled').height");
  const geometryState = await evaluate(cdp, `(() => {
    const canvas = document.querySelector('canvas.styled');
    return { width: canvas.width, height: canvas.height };
  })()`);
  assert(geometryState.width === geometryState.height, "1:1 crop did not change the rendered frame dimensions");
  await verifyContinuousRange("垂直", 34);
  await verifyContinuousRange("水平", -27);
  await verifyContinuousRange("旋转", 8.5);
  await verifyContinuousRange("长宽比", 36);
  await verifyContinuousRange("比例", 124);
  await evaluate(cdp, `(() => {
    [...document.querySelectorAll('.upright-presets button')]
      .find((button) => button.textContent.trim() === '水平').click();
  })()`);
  await waitFor(cdp, "[...document.querySelectorAll('.upright-presets button')].find((button) => button.textContent.trim() === '水平')?.classList.contains('active')");
  const constrainCropChecked = await evaluate(cdp, "document.querySelector('.constrain-crop-toggle input').checked");
  assert(constrainCropChecked, "Constrain crop should be enabled by default");
  await evaluate(cdp, "document.querySelector('.geometry-tool-heading button:first-child').click()");
  await waitFor(cdp, "document.querySelector('.photo-stage.editing-crop')");
  const cropStage = await evaluate(cdp, `(() => {
    const rect = document.querySelector('.photo-stage').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cropStage.x, y: cropStage.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cropStage.x + 24, y: cropStage.y, button: "left", buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cropStage.x + 24, y: cropStage.y, button: "left", buttons: 0, clickCount: 1 });
  await waitFor(cdp, "[...document.querySelectorAll('.geometry-section .aspect-presets button')].find((button) => button.textContent.trim() === '自由')?.classList.contains('active')");
  await evaluate(cdp, "document.querySelector('.geometry-section').scrollIntoView({ block: 'center' })");
  await delay(220);
  const maskGeometryShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(
    join(project, "qa-private", "mask-geometry-desktop.png"),
    Buffer.from(maskGeometryShot.data, "base64"),
  );
  await evaluate(cdp, "document.querySelector('.stage-expand-button').click()");
  await waitFor(cdp, "!document.querySelector('.photo-stage.editing-crop')");
  const splitAfterCrop = await evaluate(cdp, "parseFloat(document.querySelector('.split-line').style.left)");
  assert(Math.abs(splitAfterCrop - splitBeforeMask) < 0.01, "Crop tool did not restore the comparison split");
  await evaluate(cdp, "document.querySelector('.geometry-tool-heading button:last-child').click()");
  await delay(900);
  console.log("Mask and crop browser verification passed", {
    maskBefore,
    maskAfter,
    brushState,
    geometryState,
    customRatioState,
  });

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
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
  await evaluate(cdp, `(() => {
    document.querySelector('.target-selection-actions button:last-child')?.click();
    document.querySelector('.target-select')?.click();
    window.__mobileShares = [];
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: ({ files }) => Boolean(files?.length),
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files }) => {
        window.__mobileShares.push(files.map((file) => ({ name: file.name, size: file.size })));
      },
    });
    document.querySelector('.header-actions > .primary-button').click();
  })()`);
  await waitFor(cdp, "document.querySelector('.export-modal')");
  await evaluate(cdp, `(() => {
    const resolution = document.querySelectorAll('.export-grid select')[0];
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(resolution, '1080p');
    resolution.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.export-modal .dialog-actions .primary-button').click();
  })()`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"prepared-export\"]') && !document.querySelector('.global-progress')",
    180000,
  );
  assert(await evaluate(cdp, "window.__mobileShares.length === 0"), "Mobile export opened sharing without a fresh tap");
  await evaluate(cdp, "document.querySelector('[data-testid=\"prepared-export\"] .primary-button').click()");
  await waitFor(cdp, "window.__mobileShares.length === 1");
  const mobileShare = await evaluate(cdp, "window.__mobileShares[0][0]");
  assert(mobileShare.size > 1000, "Mobile share received an empty image");
  assert(/\.(jpg|png|webp|bmp)$/i.test(mobileShare.name), "Mobile share received an invalid filename");
  console.log("Mobile prepared export and share verification passed", mobileShare);
  await evaluate(cdp, "document.querySelector('.export-modal .dialog-actions .glass-button').click()");
  await waitFor(cdp, "!document.querySelector('.export-modal')");
  const mobileShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(
    join(project, "qa-private", "batch-workflow-mobile.png"),
    Buffer.from(mobileShot.data, "base64"),
  );

  for (let tool = 0; tool < 5; tool += 1) {
    await evaluate(cdp, `document.querySelectorAll('.mobile-tool-nav button')[${tool}].click()`);
    await delay(150);
    const layout = await evaluate(cdp, `(() => {
      const stage = document.querySelector('.photo-stage').getBoundingClientRect();
      const panel = document.querySelector('.app-shell').dataset.mobilePanel;
      const sheet = document.querySelector(panel === 'reference' ? '.left-panel' : '.right-panel');
      return { stageHeight: stage.height, sheetHeight: sheet.getBoundingClientRect().height, bottom: sheet.getBoundingClientRect().bottom, navTop: document.querySelector('.mobile-editor-controls').getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth, canvasWidthDelta: Math.abs(document.querySelector('.photo-canvas.original').getBoundingClientRect().width - document.querySelector('.photo-canvas.styled').getBoundingClientRect().width) };
    })()`);
    assert(layout.stageHeight >= 100 && layout.sheetHeight > 0, "Mobile tool hid the photo or its controls");
    console.log("Mobile tool layout", tool, layout);
    const toolShot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(project, "qa-private", `mobile-tool-${tool}.png`), Buffer.from(toolShot.data, "base64"));
    assert(layout.bottom <= layout.navTop + 2, "Mobile tool is covered by the bottom navigation");
    assert(!layout.overflow, "Mobile tool causes horizontal overflow");
    assert(layout.canvasWidthDelta < 1, "Before/after canvases are not registered at the same size");
    if (tool === 1) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(project, "qa-private", "mobile-adjustments.png"), Buffer.from(shot.data, "base64"));
    }
  }
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 1, mobile: true });
  await evaluate(cdp, "document.documentElement.style.fontSize = '24px'; document.querySelectorAll('.mobile-tool-nav button')[1].click()");
  await delay(150);
  const compact = await evaluate(cdp, `({overflow: document.documentElement.scrollWidth > innerWidth, stage: document.querySelector('.photo-stage').getBoundingClientRect().height, sheetBottom: document.querySelector('.right-panel').getBoundingClientRect().bottom, navTop: document.querySelector('.mobile-editor-controls').getBoundingClientRect().top})`);
  assert(!compact.overflow && compact.stage >= 100 && compact.sheetBottom <= compact.navTop + 2, "375px large-font layout is obstructed");
  console.log("375px large-font layout passed", compact);
  await evaluate(cdp, "document.documentElement.style.fontSize = ''; document.querySelector('.mobile-tool-heading button').click()");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

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
  assert(landscape.workspaceHeight <= 390, "Landscape editor became a scrolling desktop page");

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
