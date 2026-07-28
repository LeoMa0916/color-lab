import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const previewPort = 4174;

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
  await evaluate(cdp, `(() => {
    const setValue = (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.querySelector('[data-testid="auth-register-tab"]').click();
    setValue(document.querySelector('input[autocomplete="username"]'), 'engine_qa');
    const passwords = document.querySelectorAll('input[autocomplete="new-password"]');
    setValue(passwords[0], 'EngineQA2026');
    setValue(passwords[1], 'EngineQA2026');
    document.querySelector('[data-testid="legal-consent"]').click();
    document.querySelector('[data-testid="auth-submit"]').click();
  })()`);
  await waitFor(cdp, "document.readyState === 'complete' && document.querySelector('.demo-button')");
  await evaluate(cdp, "document.querySelector('.demo-button').click()");
  await waitFor(
    cdp,
    "document.querySelectorAll('.reference-thumb').length >= 2 && document.querySelectorAll('.target-thumb').length >= 5 && document.querySelector('canvas.styled')?.width > 0",
  );
  await delay(1500);
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
  const initialChecksum = await evaluate(cdp, checksumExpression);
  await waitFor(cdp, "document.querySelector('input[aria-label=\"曝光度\"]')");
  await evaluate(cdp, `(() => {
    const input = document.querySelector('input[aria-label="曝光度"]');
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.75');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })()`);
  await waitFor(
    cdp,
    "document.querySelector('input[aria-label=\"曝光度\"]').closest('.range-row').querySelector('output')?.textContent.includes('+0.75')",
  );
  await delay(1200);
  const basicChecksum = await evaluate(cdp, checksumExpression);
  assert(initialChecksum !== basicChecksum, "Basic adjustment did not change the preview");

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
  const mobile = await evaluate(cdp, `({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  })`);
  assert(mobile.width === 390, `Unexpected mobile viewport width: ${mobile.width}`);
  assert(mobile.scrollWidth === mobile.width, "Mobile layout overflows horizontally");

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
    checksums: [initialChecksum, basicChecksum, curveChecksum],
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
