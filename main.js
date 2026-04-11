"use strict";
const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

let win = null, engine = null;
let _tmpEngine = null;

const HIST_FILE = () => path.join(app.getPath("userData"), "trade_history.json");

function loadHistory() {
try { return JSON.parse(fs.readFileSync(HIST_FILE(),"utf8")); } catch { return []; }
}
function saveHistory(arr) {
fs.writeFileSync(HIST_FILE(), JSON.stringify(arr.slice(-500)), "utf8");
}

function getTmpEngine() {
if (!_tmpEngine) {
const { TradingEngine } = require(path.join(__dirname, "engine"));
_tmpEngine = new TradingEngine({ dryRun:true, capital:0 }, ()=>{});
}
return _tmpEngine;
}

app.whenReady().then(() => {
win = new BrowserWindow({
width:1280, height:800, minWidth:900, minHeight:600,
webPreferences:{ nodeIntegration:true, contextIsolation:false }
});
win.loadFile(path.join(__dirname, "index.html"));
Menu.setApplicationMenu(null);

const CFG_FILE = path.join(app.getPath("userData"), "bot_config.json");

ipcMain.on("config:load", e => {
try { e.reply("config:loaded", JSON.parse(fs.readFileSync(CFG_FILE,"utf8"))); }
catch { e.reply("config:loaded", null); }
});
ipcMain.on("config:save", (_, cfg) => {
fs.writeFileSync(CFG_FILE, JSON.stringify(cfg), "utf8");
if (!win || win.isDestroyed()) return;
win.webContents.send("config:saved");
});

ipcMain.on("history:load", e => {
e.reply("history:updated", loadHistory().slice(-200));
});
ipcMain.on("history:clear", () => {
saveHistory([]);
if (!win || win.isDestroyed()) return;
win.webContents.send("history:updated", []);
});
ipcMain.on("history:exportCSV", () => {
const records = loadHistory();
const fp = path.join(app.getPath("downloads"), `btc_trades_${Date.now()}.csv`);
const BOM = "\uFEFF";
const hdr = "时间,方向,原因,入场价,出场价,张数,盈亏%,盈亏U\n";
const rows = records.map(r => {
const dt = new Date(r.time+8*3600*1000).toISOString().replace("T"," ").slice(0,19);
return `${dt},${r.dir},${r.reason},${r.entry},${r.exit??""},${r.contracts},${r.pPct??""},${r.pnl??""}`;
}).join("\n");
fs.writeFileSync(fp, BOM+hdr+rows, "utf8");
if (!win || win.isDestroyed()) return;
win.webContents.send("history:exported", fp);
});

ipcMain.on("bot:start", async (_, cfg) => {
if (engine) return;
_tmpEngine = null;
const { TradingEngine } = require(path.join(__dirname, "engine"));
engine = new TradingEngine(cfg, (type, data) => {
if (!win || win.isDestroyed()) return;
win.webContents.send("bot:event", { type, data });
if (type === "trade" && data.result !== "open") {
const h = loadHistory(); h.push(data); saveHistory(h);
win.webContents.send("history:updated", loadHistory().slice(-200));
}
});
await engine.start();
if (!win || win.isDestroyed()) return;
win.webContents.send("bot:started");
});

ipcMain.on("bot:stop", () => {
engine?.stop(); engine = null;
if (!win || win.isDestroyed()) return;
win.webContents.send("bot:stopped");
});
ipcMain.on("bot:updateConfig", (_, cfg) => engine?.updateConfig(cfg));

ipcMain.on("trade:partialClose", async (_, ratio) => {
try { await engine?.partialClose(ratio); }
catch(e) {
if (!win || win.isDestroyed()) return;
win.webContents.send("trade:error", e.message);
}
});
ipcMain.on("trade:setTP", (_, v) => engine?.setTP(v));
ipcMain.on("trade:setSL", (_, v) => engine?.setSL(v));

ipcMain.handle("chart:loadKlines", async (_, { interval, bars }) => {
if (engine) return await engine.fetchKlines(interval, bars);
return await getTmpEngine().fetchKlines(interval, bars);
});

ipcMain.handle("price:get", async () => {
if (engine) return null;
return await getTmpEngine().getPrice();
});
});

app.on("window-all-closed", () => {
if (engine) { engine.stop(); engine = null; }
app.quit();
});