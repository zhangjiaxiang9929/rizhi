"use strict";

const { app, BrowserWindow, ipcMain, Menu, dialog } = require("electron");
const path = require("path");
const fs   = require("fs");

let win          = null;
let engine       = null;
let _tmpEngine   = null;
let aiDecisionLog = [];
let aiChatHistory = [];

const DATA_DIR  = path.join(__dirname, "..", "data");
const HIST_FILE = () => path.join(DATA_DIR, "trade_history_BTC_USDT.json");
const CFG_FILE  = path.join(DATA_DIR, "bot_config.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HIST_FILE(), "utf8")); }
  catch { return []; }
}
function saveHistory(arr) {
  ensureDataDir();
  fs.writeFileSync(HIST_FILE(), JSON.stringify(arr.slice(-500)), "utf8");
}
function getTmpEngine() {
  try {
    if (!_tmpEngine) {
      const { TradingEngine } = require(path.join(__dirname, "engine"));
      _tmpEngine = new TradingEngine({ dryRun: true, capital: 0, contract: "BTC_USDT", leverage: 5 }, () => {});
    }
    return _tmpEngine;
  } catch(e) {
    console.error("TmpEngine创建失败:", e.message);
    return null;
  }
}

app.whenReady().then(() => {

  win = new BrowserWindow({
    width: 1440, height: 860,
    minWidth: 1100, minHeight: 700,
    backgroundColor: "#0d1117",
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "index.html"));
  Menu.setApplicationMenu(null);

  // ── 配置 ──
  ipcMain.on("config:load", e => {
    ensureDataDir();
    try { e.reply("config:loaded", JSON.parse(fs.readFileSync(CFG_FILE, "utf8"))); }
    catch { e.reply("config:loaded", null); }
  });

  ipcMain.on("bot:updateConfig", (_, cfg) => {
    ensureDataDir();
    if (engine) engine.updateConfig(cfg);
    try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), "utf8"); } catch(e) {}
  });

  // ── 历史记录 ──
  ipcMain.on("history:load", e => {
    e.reply("history:updated", loadHistory().slice(-200));
  });

  ipcMain.on("history:clear", () => {
    saveHistory([]);
    if (!win || win.isDestroyed()) return;
    win.webContents.send("history:updated", []);
  });

  ipcMain.on("history:exportCSV", async () => {
    const records = loadHistory();
    const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
    const result = await dialog.showSaveDialog(win, {
      title: "导出交易记录",
      defaultPath: `btc_trades_${today}.csv`,
      filters: [{ name: "CSV文件", extensions: ["csv"] }]
    });
    if (result.canceled || !result.filePath) return;
    const BOM  = "\uFEFF";
    const hdr  = "时间,方向,原因,入场价,出场价,张数,盈亏%,盈亏U\n";
    const rows = records.map(r => {
      const dt = new Date(r.time + 8*3600000).toISOString().replace("T"," ").slice(0,19);
      return [dt, r.dir, r.reason||"", r.entry||"", r.exit||"", r.contracts||"", r.pPct||"", r.pnl||""].join(",");
    }).join("\n");
    fs.writeFileSync(result.filePath, BOM + hdr + rows, "utf8");
    if (!win || win.isDestroyed()) return;
    win.webContents.send("history:exported", result.filePath);
  });

  // ── 机器人启动 ──
  ipcMain.on("bot:start", async (_, cfg) => {
    if (engine) return;
    _tmpEngine = null;
    ensureDataDir();
    const { TradingEngine } = require(path.join(__dirname, "engine"));
    engine = new TradingEngine(cfg, (type, data) => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send("bot:event", { type, data });
      if (type === "log") {
        try {
          const today = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
          fs.appendFileSync(path.join(DATA_DIR, `bot_${today}.log`),
            `[${data.ts}] [${data.level.toUpperCase()}] ${data.msg}\n`, "utf8");
        } catch(e) {}
      }
      if (type === "aiDecision") {
        aiDecisionLog.push(data);
        if (aiDecisionLog.length > 30) aiDecisionLog.shift();
      }
      if (type === "trade" && data.result !== "open") {
        const h = loadHistory();
        h.push(data);
        saveHistory(h);
        if (!win || win.isDestroyed()) return;
        win.webContents.send("history:updated", loadHistory().slice(-200));
      }
    });
    await engine.start();
    if (!win || win.isDestroyed()) return;
    try {
      const simFile = path.join(DATA_DIR, "sim_state_BTC_USDT.json");
      if (fs.existsSync(simFile)) {
        const s = JSON.parse(fs.readFileSync(simFile, "utf8"));
        const simBal = s.simBalance || s.simAvail || cfg.capital;
        win.webContents.send("bot:event", { type:"simCapital", data:{ capital: simBal } });
      }
    } catch(e) {}
    win.webContents.send("bot:started");
  });

  // ── 机器人停止 ──
  ipcMain.on("bot:stop", () => {
    if (engine) { engine.stop(); engine = null; }
    if (!win || win.isDestroyed()) return;
    win.webContents.send("bot:stopped");
  });

  // ── 手动开仓 ──
  ipcMain.on("bot:manualOpen", async (_, { dir, contracts, price }) => {
    if (!engine) return;
    try {
      const curPrice = price || await engine.getPrice("BTC_USDT");
      const info     = engine.contractInfo || { mult: 0.0001 };
      const notional = +(contracts * curPrice * info.mult).toFixed(2);
      const slPct    = (engine.cfg.stopPct || 1.0) / 100;
      const tpPct    = (engine.cfg.takePct || 3.5) / 100;
      const sl = dir==="LONG" ? +(curPrice*(1-slPct)).toFixed(2) : +(curPrice*(1+slPct)).toFixed(2);
      const tp = dir==="LONG" ? +(curPrice*(1+tpPct)).toFixed(2) : +(curPrice*(1-tpPct)).toFixed(2);
      const margin = +(notional / (engine.cfg.leverage||3)).toFixed(2);
      if (engine.cfg.dryRun) {
        if (engine.simAvail < margin) { engine.log("warn","💰 资金不足，无法手动开仓"); return; }
        const feeOpen = +(notional*0.0005).toFixed(4);
        engine.simAvail  -= margin + feeOpen;
        engine.simMargin += margin;
        engine.simBalance -= feeOpen;
      } else {
        await engine.placeOrder(dir, contracts);
      }
      engine.pos = {
        dir, entry: curPrice, sl, tp, contracts, notional, margin,
        time: Date.now(), _movedToBreakeven: false, _tp1Hit: false, _tp2Hit: false,
        feeOpen: notional*0.0005, feeClose: notional*0.0005, source: "manual",
      };
      engine.emit("position", { ...engine.pos, price: curPrice, pPct: 0 });
      engine.emit("trade", { time:Date.now(), dir, entry:curPrice, exit:null, contracts, notional, pPct:null, pnl:null, reason:"手动开仓", result:"open" });
      engine.log("open", `🖐 手动开仓 ${dir} ${contracts}张 @ ${curPrice}`);
      if (engine.cfg.dryRun) engine.saveSimState();
    } catch(e) { console.error("手动开仓失败:", e.message); }
  });

  // ── 手动平仓 ──
  ipcMain.on("bot:manualClose", async (_, { pct }) => {
    if (!engine || !engine.pos) return;
    try { await engine.partialClose((pct||100)/100); }
    catch(e) { console.error("手动平仓失败:", e.message); }
  });

  // ── K线数据 ──
  ipcMain.on("bot:getKlines", async (_, { tf, contract }) => {
    try {
      const sym = contract || "BTC_USDT";
      let data = [];
      if (engine) {
        data = await engine.fetchKlines(tf, 200, sym);
      } else {
        const tmp = getTmpEngine();
        if (tmp) data = await tmp.fetchKlines(tf, 200, sym);
      }
      if (!win || win.isDestroyed()) return;
      win.webContents.send("bot:event", { type:"klines", data: data||[] });
    } catch(e) {
      console.error("K线获取失败:", e.message);
      if (!win || win.isDestroyed()) return;
      win.webContents.send("bot:event", { type:"klines", data:[] });
    }
  });

  // ── 实时价格 ──
  ipcMain.handle("price:get", async (_, params) => {
    try {
      const sym = (params && params.symbol) ? params.symbol : "BTC_USDT";
      const tmp = getTmpEngine();
      if (!tmp || typeof tmp.getPrice !== "function") return 0;
      return await tmp.getPrice(sym) || 0;
    } catch(e) { return 0; }
  });

  // ── 止损/止盈 ──
  ipcMain.on("trade:setTP", (_, v) => engine && engine.setTP(v));
  ipcMain.on("trade:setSL", (_, v) => engine && engine.setSL(v));

  // ── 清除模拟数据 ──
  ipcMain.on("sim:clear", () => {
    if (engine) { engine.clearSimState(); return; }
    ["BTC_USDT","ETH_USDT"].forEach(sym => {
      const f = path.join(DATA_DIR, "sim_state_"+sym+".json");
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
    });
  });

  // ── AI 对话 ──
  ipcMain.on("ai:chat", (_, { message }) => {
    const https = require("https");
    aiChatHistory.push({ role:"user", content: message });
    if (aiChatHistory.length > 20) aiChatHistory = aiChatHistory.slice(-20);
    let decisionSummary = "";
    if (aiDecisionLog.length > 0) {
      decisionSummary = "\n最近AI决策:\n" + aiDecisionLog.slice(-5).map(d => {
        const t = new Date(d.time+8*3600000).toISOString().slice(11,16);
        return `${t} ${d.sig} → ${d.action} 置信度${d.confidence}% | ${d.reason}`;
      }).join("\n");
    }
    const messages = [
      { role:"system",    content:"你是专业BTC合约交易分析顾问，只提供分析建议，不执行交易。中文回复，不超过300字。" },
      { role:"user",      content:"当前机器人状态: " + (engine ? "运行中" : "未运行") + decisionSummary },
      { role:"assistant", content:"好的，我已获取当前状态，请问有什么需要分析的？" },
      ...aiChatHistory,
    ];
    const body = JSON.stringify({ model:"qwen3-max-2026-01-23阿里云特价", messages, max_tokens:500, temperature:0.7 });
    let reqRef = null;
    const timer = setTimeout(() => {
      if (reqRef) reqRef.destroy();
      if (!win || win.isDestroyed()) return;
      win.webContents.send("ai:reply", "请求超时，请重试");
    }, 15000);
    const req = https.request({
      hostname: "api2.openclawcn.net", port: 443,
      path: "/v1/chat/completions", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer sk-c8ltKB9BbxxMteuEr0xja9N6O3uD68ykmTggXEcEPMsulvM2",
        "Content-Length": Buffer.byteLength(body),
      }
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(raw);
          const reply = json.choices?.[0]?.message?.content || "AI无响应";
          aiChatHistory.push({ role:"assistant", content: reply });
          if (!win || win.isDestroyed()) return;
          win.webContents.send("ai:reply", reply);
        } catch(e) {
          if (!win || win.isDestroyed()) return;
          win.webContents.send("ai:reply", "响应解析失败: " + e.message);
        }
      });
    });
    req.on("error", e => {
      clearTimeout(timer);
      if (!win || win.isDestroyed()) return;
      win.webContents.send("ai:reply", "网络错误: " + e.message);
    });
    reqRef = req;
    req.write(body);
    req.end();
  });

  // ── 窗口关闭 ──
  win.on("close", e => {
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type:"question", buttons:["确认关闭","取消"], defaultId:1, cancelId:1,
      title:"确认退出", message:"确定要关闭机器人吗？",
      detail: engine ? "⚠️ 机器人正在运行，关闭后持仓将不再被监控！" : "确认退出程序？"
    });
    if (choice === 0) {
      if (engine) { try { engine.saveSimState(); } catch(e) {} engine.stop(); engine = null; }
      win.destroy();
    }
  });

  app.on("window-all-closed", () => {
    if (engine) { try { engine.saveSimState(); } catch(e) {} engine.stop(); engine = null; }
    app.quit();
  });

}); // app.whenReady 结束
