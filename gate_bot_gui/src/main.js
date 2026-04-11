/**
 * Electron 主进程
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs   = require("fs");
const { TradingEngine } = require("./engine");

let mainWindow = null;
let engine     = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720,
    minWidth: 900, minHeight: 600,
    title: "Gate.io BTC 机器人 v10",
    backgroundColor: "#0f1117",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("closed", () => { if (engine) engine.stop(); mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

ipcMain.on("bot:start", (event, config) => {
  if (engine) engine.stop();
  engine = new TradingEngine(config, (type, data) => {
    if (mainWindow) mainWindow.webContents.send("bot:event", { type, data });
  });
  engine.start();
  event.reply("bot:started");
});

ipcMain.on("bot:stop", (event) => {
  if (engine) { engine.stop(); engine = null; }
  event.reply("bot:stopped");
});

ipcMain.on("config:load", (event) => {
  const p = path.join(app.getPath("userData"), "config.json");
  try { event.reply("config:loaded", JSON.parse(fs.readFileSync(p, "utf8"))); }
  catch { event.reply("config:loaded", null); }
});

ipcMain.on("config:save", (event, cfg) => {
  const p = path.join(app.getPath("userData"), "config.json");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  event.reply("config:saved");
});
