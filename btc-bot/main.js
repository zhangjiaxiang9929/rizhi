"use strict";
const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const fs   = require("fs");
const https = require("https");

let win = null, engine = null;
let _tmpEngine = null;

// ★ 增强：Telegram 通知
let telegramConfig = null;

const HIST_FILE = () => path.join(app.getPath("userData"), "trade_history.json");
const CONFIG_FILE = () => path.join(app.getPath("userData"), "bot_config.json");
const TELEGRAM_FILE = () => path.join(app.getPath("userData"), "telegram_config.json");

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HIST_FILE(),"utf8")); } catch { return []; }
}
function saveHistory(arr) {
  fs.writeFileSync(HIST_FILE(), JSON.stringify(arr.slice(-500)), "utf8");
}

function loadTelegramConfig() {
  try { 
    telegramConfig = JSON.parse(fs.readFileSync(TELEGRAM_FILE(), "utf8")); 
  } catch { 
    telegramConfig = null; 
  }
}

// ★ Telegram 通知发送
async function sendTelegramNotification(message) {
  if (!telegramConfig || !telegramConfig.botToken || !telegramConfig.chatId) return;
  
  return new Promise((resolve) => {
    const text = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage?chat_id=${telegramConfig.chatId}&text=${text}&parse_mode=HTML`;
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(null));
  });
}

function getTmpEngine() {
  if (!_tmpEngine) {
    const { TradingEngine } = require(path.join(__dirname, "engine"));
    _tmpEngine = new TradingEngine({ dryRun:true, capital:0, symbols:[{symbol:"BTC_USDT",weight:1}] }, ()=>{});
  }
  return _tmpEngine;
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width:1400, height:900, minWidth:1000, minHeight:700,
    webPreferences:{ nodeIntegration:true, contextIsolation:false }
  });
  win.loadFile(path.join(__dirname, "index.html"));
  Menu.setApplicationMenu(null);
  
  loadTelegramConfig();

  // 配置加载/保存
  ipcMain.on("config:load", e => {
    try { e.reply("config:loaded", JSON.parse(fs.readFileSync(CONFIG_FILE(),"utf8"))); }
    catch { e.reply("config:loaded", null); }
  });
  ipcMain.on("config:save", (_, cfg) => {
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg), "utf8");
    win.webContents.send("config:saved");
  });

  // Telegram 配置
  ipcMain.on("telegram:load", e => {
    e.reply("telegram:loaded", telegramConfig);
  });
  ipcMain.on("telegram:save", (_, cfg) => {
    telegramConfig = cfg;
    fs.writeFileSync(TELEGRAM_FILE(), JSON.stringify(cfg), "utf8");
    e.reply("telegram:saved");
  });
  ipcMain.on("telegram:test", async (_, cfg) => {
    const testConfig = { ...telegramConfig, ...cfg };
    if (testConfig.botToken && testConfig.chatId) {
      await sendTelegramNotification("🤖 <b>BTC Bot</b>\n✅ Telegram 通知测试成功！");
    }
  });

  // 历史记录
  ipcMain.on("history:load", e => {
    e.reply("history:updated", loadHistory().slice(-200));
  });
  ipcMain.on("history:clear", () => {
    saveHistory([]);
    win.webContents.send("history:updated", []);
  });
  ipcMain.on("history:exportCSV", () => {
    const records = loadHistory();
    const fp  = path.join(app.getPath("downloads"), `btc_trades_${Date.now()}.csv`);
    const BOM = "\uFEFF";
    const hdr = "时间,交易对,方向,原因,入场价,出场价,张数,盈亏%,盈亏U\n";
    const rows = records.map(r => {
      const dt = new Date(r.time+8*3600*1000).toISOString().replace("T"," ").slice(0,19);
      return `${dt},${r.symbol||'BTC_USDT'},${r.dir},${r.reason},${r.entry},${r.exit??""},${r.contracts},${r.pPct??""},${r.pnl??""}`;
    }).join("\n");
    fs.writeFileSync(fp, BOM+hdr+rows, "utf8");
    win.webContents.send("history:exported", fp);
  });

  // ★ 启动机器人
  ipcMain.on("bot:start", async (_, cfg) => {
    if (engine) return;
    _tmpEngine = null;
    
    const { TradingEngine } = require(path.join(__dirname, "engine"));
    
    // 确保symbols配置
    if (!cfg.symbols) {
      cfg.symbols = [{ symbol: cfg.symbol || "BTC_USDT", weight: 1 }];
    }
    
    engine = new TradingEngine(cfg, (type, data) => {
      win?.webContents.send("bot:event", { type, data });
      
      // ★ Telegram 交易通知
      if (type === "trade" && data.result !== "open" && telegramConfig) {
        const emoji = data.result === "win" ? "🟢" : "🔴";
        const msg = `${emoji} <b>交易${data.result === 'win' ? '盈利' : '亏损'}</b>\n` +
          `📊 ${data.symbol || 'BTC_USDT'} ${data.dir}\n` +
          `💰 ${data.pnl >= 0 ? '+' : ''}${data.pnl?.toFixed(2) || 0} USDT (${data.pPct >= 0 ? '+' : ''}${data.pPct?.toFixed(2) || 0}%)\n` +
          `📈 入:${data.entry?.toFixed(2)} 出:${data.exit?.toFixed(2)}\n` +
          `📝 ${data.reason}`;
        sendTelegramNotification(msg);
      }
      
      // ★ Telegram 风控熔断通知
      if (type === "stopped" && data.reason && telegramConfig) {
        sendTelegramNotification(`🚨 <b>机器人停止</b>\n⚠️ 原因: ${data.reason}`);
      }
      
      if (type === "trade" && data.result !== "open") {
        const h = loadHistory(); 
        h.push(data); 
        saveHistory(h);
        win?.webContents.send("history:updated", loadHistory().slice(-200));
      }
    });
    
    await engine.start();
    win.webContents.send("bot:started");
    
    // 启动通知
    if (telegramConfig) {
      sendTelegramNotification(`🚀 <b>BTC Bot 已启动</b>\n${cfg.dryRun ? '🔷 模拟模式' : '🔴 真实交易'}\n📊 杠杆: ${cfg.leverage}x`);
    }
  });

  ipcMain.on("bot:stop", () => {
    engine?.stop(); 
    engine = null;
    win.webContents.send("bot:stopped");
    if (telegramConfig) {
      sendTelegramNotification("🛑 <b>BTC Bot 已停止</b>");
    }
  });
  
  ipcMain.on("bot:updateConfig", (_, cfg) => engine?.updateConfig(cfg));

  // 交易操作
  ipcMain.on("trade:partialClose", async (_, ratio) => {
    try { await engine?.partialClose(ratio); }
    catch(e) { win.webContents.send("trade:error", e.message); }
  });
  ipcMain.on("trade:setTP", (_, v) => engine?.setTP(v));
  ipcMain.on("trade:setSL", (_, v) => engine?.setSL(v));

  // K线和价格
  ipcMain.handle("chart:loadKlines", async (_, { interval, bars, symbol }) => {
    const sym = symbol || "BTC_USDT";
    if (engine) return await engine.fetchKlines(interval, bars, sym);
    return await getTmpEngine().fetchKlines(interval, bars, sym);
  });

  ipcMain.handle("price:get", async (_, symbol) => {
    const sym = symbol || "BTC_USDT";
    if (engine) return null;
    return await getTmpEngine().getPrice(sym);
  });
  
  // ★ 获取市场状态
  ipcMain.handle("market:getRegime", async () => {
    if (engine) {
      return {
        regime: engine.marketRegime,
        volatility: engine.volatilityRegime,
        dailyStats: engine.dailyStats,
        weeklyStats: engine.weeklyStats,
        consecutiveLosses: engine.consecutiveLosses,
        maxDrawdown: engine.maxDrawdown
      };
    }
    return null;
  });
});

app.on("window-all-closed", () => { engine?.stop(); app.quit(); });
