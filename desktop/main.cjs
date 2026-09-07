const { app, BrowserWindow, shell, dialog, Menu } = require("electron");
const path = require("node:path");
const SITE = "https://colorslab.top";
function isSite(url) { try { return new URL(url).origin === SITE; } catch { return false; } }
function external(url) { try { if (new URL(url).protocol === "https:") shell.openExternal(url); } catch {} }
function openEditor() {
  const win = new BrowserWindow({
    width: 1440, height: 960, minWidth: 390, minHeight: 640,
    title: "调色室 · Color Lab", backgroundColor: "#111722",
    show: process.env.COLORLAB_SMOKE_TEST !== "1",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (event, url) => { if (!isSite(url)) { event.preventDefault(); external(url); } });
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(isSite(contents.getURL()) && permission === "clipboard-sanitized-write");
  });
  win.webContents.on("did-fail-load", async (_event, code, _description, _url, mainFrame) => {
    if (!mainFrame || code === -3 || win.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(win, { type: "warning", message: "暂时无法连接调色室", detail: "请检查网络连接后重试。", buttons: ["重试", "关闭"], defaultId: 0 });
    if (!win.isDestroyed()) { if (response === 0) win.loadURL(SITE); else win.close(); }
  });
  win.loadURL(SITE);
}
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "调色室", submenu: [{ label: "重新加载", role: "reload" }, { role: "quit", label: "退出" }] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
  ]));
  openEditor();
});
app.on("window-all-closed", () => app.quit());
