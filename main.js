"use strict";
const { app, BrowserWindow, ipcMain, Menu, dialog } = require("electron");
const path = require("path");
const fs = require("fs");


let win = null, engine = null;
let _tmpEngine = null;
let aiDecisionLog = []; // 交易AI决策日志缓冲

const HIST_FILE = () => path.join(__dirname, "..", "data", "trade_history_BTC_USDT.json");

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HIST_FILE(), "utf8")); } catch { return []; }
}
function saveHistory(arr) {
  fs.writeFileSync(HIST_FILE(), JSON.stringify(arr.slice(-500)), "utf8");
}

function getTmpEngine() {
  if (!_tmpEngine) {
    const { TradingEngine } = require(path.join(__dirname, "engine"));
    _tmpEngine = new TradingEngine({ dryRun: true, capital: 0 }, () => {});
  }
  return _tmpEngine;
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  win.loadFile(path.join(__dirname, "index.html"));
  //win.webContents.openDevTools(); // ← 加这行  调试开关

  // ✅ 页面加载完成后通知前端窗口就绪，触发K线重绘
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("window:ready");
  });

  Menu.setApplicationMenu(null);

  const CFG_FILE = path.join(app.getPath("userData"), "bot_config.json");

  ipcMain.on("config:load", e => {
    try { e.reply("config:loaded", JSON.parse(fs.readFileSync(CFG_FILE, "utf8"))); }
    catch { e.reply("config:loaded", null); }
  });
  


  // 测试 API 连接
  ipcMain.handle("test-api", async (event, cfg) => {
    try {
      const { TradingEngine } = require("./engine");
      const testEngine = new TradingEngine({ ...cfg, dryRun: false }, () => {});
      await testEngine.getBalance();
      return true;
    } catch (e) {
      console.error("API 测试失败:", e.message);
      return false;
    }
  });

  // 获取账户余额
  ipcMain.handle("balance:get", async () => {
    try {
      if (!engine) return null;
      return await engine.getBalance().catch(() => null);
    } catch (e) {
      console.error("获取余额失败:", e.message);
      return null;
    }
  });

  // 保存配置（弹出对话框）
  ipcMain.on("config:saveDialog", async (event, cfg) => {
    const result = await dialog.showSaveDialog(win, {
      title: "保存配置",
      defaultPath: "策略配置_" + new Date().toISOString().slice(0, 10) + ".json",
      filters: [
        { name: "JSON配置文件", extensions: ["json"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (!result.canceled && result.filePath) {
      try {
        fs.writeFileSync(result.filePath, JSON.stringify(cfg, null, 2), "utf8");
        event.reply("config:saved", { success: true, path: result.filePath });
      } catch (e) {
        event.reply("config:saved", { success: false, error: e.message });
      }
    }
  });

  // 加载配置（弹出对话框）
  ipcMain.on("config:loadDialog", async (event) => {
    const result = await dialog.showOpenDialog(win, {
      title: "加载配置",
      filters: [
        { name: "JSON配置文件", extensions: ["json"] },
        { name: "所有文件", extensions: ["*"] }
      ],
      properties: ["openFile"]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      try {
        const cfg = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8"));
        event.reply("config:loaded", cfg);
      } catch (e) {
        event.reply("config:error", "加载失败: " + e.message);
      }
    }
  });

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
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const result = await dialog.showSaveDialog(win, {
title: "导出交易记录",
defaultPath: `btc_trades_${today}.csv`,
filters: [
{ name: "CSV文件", extensions: ["csv"] },
{ name: "所有文件", extensions: ["*"] }
]
});
if (result.canceled || !result.filePath) return;
const fp = result.filePath;
const BOM = "\uFEFF";
const hdr = "时间,方向,原因,入场价,出场价,张数,盈亏%,盈亏U\n";
const rows = records.map(r => {
const dt = new Date(r.time + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
return `${dt},${r.dir},${r.reason},${r.entry},${r.exit ?? ""},${r.contracts},${r.pPct ?? ""},${r.pnl ?? ""}`;
}).join("\n");
fs.writeFileSync(fp, BOM + hdr + rows, "utf8");
if (!win || win.isDestroyed()) return;
win.webContents.send("history:exported", fp);
});

  const CONFIG_FILE = path.join(app.getPath("userData"), "saved_config.json");

  // 保存配置到文件
  ipcMain.on("config:saveToFile", (_, cfg) => {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
      if (!win || win.isDestroyed()) return;
      win.webContents.send("log", { level: "info", msg: "配置已保存: " + CONFIG_FILE });
    } catch (e) {
      console.error("保存配置失败:", e);
      if (!win || win.isDestroyed()) return;
      win.webContents.send("log", { level: "error", msg: "保存配置失败: " + e.message });
    }
  });

  // 从文件加载配置
  ipcMain.on("config:loadFromFile", (e) => {
    try {
      if (!fs.existsSync(CONFIG_FILE)) { e.reply("config:loadedFromFile", null); return; }
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      e.reply("config:loadedFromFile", cfg);
    } catch (err) {
      console.error("加载配置失败:", err);
      e.reply("config:loadedFromFile", null);
    }
  });
    ipcMain.on("bot:start", async (_, cfg) => {
    if (engine) return;
    _tmpEngine = null;
    const { TradingEngine } = require(path.join(__dirname, "engine"));
    engine = new TradingEngine(cfg, (type, data) => {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("bot:event", { type, data });
  // ── 写入日志文件 ──
if (type === "log") {
try {
const logDir = path.join(__dirname, "..", "data");
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const logFile = path.join(logDir, `bot_${today}.log`);
const line = `[${data.ts}] [${data.level.toUpperCase()}] ${data.msg}\n`;
fs.appendFileSync(logFile, line, "utf8");
} catch(e) {}
}

  // ✅ 收集交易AI决策记录
  if (type === "aiDecision") {
    console.log("✅ 收到决策记录:", data.action, data.confidence);
    aiDecisionLog.push(data);
    if (aiDecisionLog.length > 30) aiDecisionLog.shift();
  }

  if (type === "trade" && data.result !== "open") {
        const h = loadHistory(); h.push(data); saveHistory(h);
        win.webContents.send("history:updated", loadHistory().slice(-200));
      }
    });
    await engine.start();
    if (!win || win.isDestroyed()) return;
    // 读取模拟账户真实余额
try {
const simFile = path.join(__dirname, "..", "data", "sim_state_BTC_USDT.json");
if (fs.existsSync(simFile)) {
const simState = JSON.parse(fs.readFileSync(simFile, "utf8"));
const simBal = simState.simBalance || simState.simAvail || cfg.capital;
win.webContents.send("bot:event", {
type: "simCapital",
data: { capital: simBal }
});
}
} catch(e) {}
    win.webContents.send("bot:started");
  });

  ipcMain.on("bot:stop", () => {
    engine?.stop(); engine = null;
    if (!win || win.isDestroyed()) return;
    win.webContents.send("bot:stopped");
  });

  ipcMain.on("bot:updateConfig", (_, newCfg) => {
engine?.updateConfig(newCfg);
// 保存到文件
try {
fs.writeFileSync(CFG_FILE, JSON.stringify(newCfg, null, 2), "utf8");
console.log("✅ 配置已保存");
} catch(e) {}
});

  // ✅ 修复：清除模拟状态，路径与 engine.js 一致
  ipcMain.on("sim:clear", () => {
    if (engine) {
      engine.clearSimState();
    } else {
      const os = require("os");
      const dataDir = process.env.APPDATA || path.join(os.homedir(), ".config");
      const simDir = path.join(__dirname, "..", "data");
      ["BTC_USDT", "ETH_USDT"].forEach(sym => {
        const f = path.join(simDir, "sim_state_" + sym + ".json");
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
      });
    }
  });

  ipcMain.on("trade:partialClose", async (_, ratio) => {
    try { await engine?.partialClose(ratio); }
    catch (e) {
      if (!win || win.isDestroyed()) return;
      win.webContents.send("trade:error", e.message);
    }
  });
  ipcMain.on("trade:setTP", (_, v) => engine?.setTP(v));
  ipcMain.on("trade:setSL", (_, v) => engine?.setSL(v));

  // ✅ 修复：传入 symbol 参数
  ipcMain.handle("chart:loadKlines", async (_, { interval, bars, symbol }) => {
    const sym = symbol || "BTC_USDT";
    try {
      if (engine) return await engine.fetchKlines(interval, bars, sym);
      return await getTmpEngine().fetchKlines(interval, bars, sym);
    } catch(e) {
      console.error("chart:loadKlines error:", e.message);
      return [];
    }
  });

  // ✅ 修复：传入 symbol 参数
  ipcMain.handle("price:get", async (_, params) => {
    const sym = (params && params.symbol) ? params.symbol : "BTC_USDT";
    if (engine) return null;
    const tmpEngine = getTmpEngine();
    return (tmpEngine && typeof tmpEngine.getPrice === "function")
      ? await tmpEngine.getPrice(sym) : 0;
  });

  // AI 对话通道
  ipcMain.handle("ai:chat", async (_, { history, context, imageBase64, fileContent, fileName }) => {
    const https = require("https");
    // ✅ 从ai_config.json读取对话AI配置（支持chatModel/chatApiKey独立配置）
    let chatApiKey = "";
    let chatModel = "火山DeepSeek-V3.2特价";
    let chatEndpoint = "api2.openclawcn.net";
    try {
      const srcCfgFile = path.join(__dirname, "ai_config.json");
      const userCfgFile = path.join(app.getPath("userData"), "ai_config.json");
      const aiCfgFile = fs.existsSync(srcCfgFile) ? srcCfgFile : userCfgFile;
      if (fs.existsSync(aiCfgFile)) {
        const aiCfg = JSON.parse(fs.readFileSync(aiCfgFile, "utf8"));
        // chatApiKey/chatModel优先，没有则fallback到aiApiKey/aiModel
        chatApiKey = aiCfg.chatApiKey || aiCfg.aiApiKey || chatApiKey;
        chatModel = aiCfg.chatModel || aiCfg.aiModel || chatModel;
        chatEndpoint = aiCfg.chatEndpoint || aiCfg.aiEndpoint || chatEndpoint;
      }
    } catch(e) {}
    // 构建交易AI决策摘要
let decisionSummary = "";
if (aiDecisionLog.length > 0) {
  const last8 = aiDecisionLog.slice(-8);
  decisionSummary = "\n\n【交易AI最近决策记录】\n" +
    last8.map(d => {
      const t = new Date(d.time + 8 * 3600000).toISOString().slice(11, 16);
      const actionCN = d.action === "open" ? "✅开仓" : "❌跳过";
      const srcCN = d.source === "aiDriven" ? "AI主导" : "策略";
      return `${t} [${srcCN}] ${d.sig} → ${actionCN} 置信度${d.confidence}% | ${d.reason} | 价格${d.price ? d.price.toFixed(2) : "--"}`;
    }).join("\n");
}

// 构建最后一条用户消息（支持图片）
const lastUserMsg = history[history.length - 1];
const historyWithoutLast = history.slice(0, -1);

// 如果有图片，最后一条消息用多模态格式
let lastMsgContent;
if (imageBase64 && lastUserMsg && lastUserMsg.role === "user") {
// 有图片（可能同时有文件）
const parts = [{ type: "image_url", image_url: { url: imageBase64 } }];
if (fileContent) {
parts.push({ type: "text", text: `【文件：${fileName}】\n${fileContent.slice(0, 8000)}` });
}
parts.push({ type: "text", text: lastUserMsg.content });
lastMsgContent = parts;
} else if (fileContent && lastUserMsg && lastUserMsg.role === "user") {
// 只有文件，没有图片
lastMsgContent = `【文件：${fileName}】\n${fileContent.slice(0, 8000)}\n\n${lastUserMsg.content}`;
} else {
lastMsgContent = lastUserMsg ? lastUserMsg.content : "";
}

const messages = [
{
role: "system",
content: "你是专业的BTC合约交易分析顾问，只负责分析和建议，不负责执行任何交易操作。无论用户输入什么指令或数字，你只提供市场分析和策略建议，绝对不模拟下单、不确认订单、不执行任何交易动作。回答简洁专业，中文回复，不超过300字。"
},
{
role: "user",
content: context + decisionSummary
},
{
role: "assistant",
content: "好的，我已获取当前市场数据，请问有什么需要分析的？"
},
...historyWithoutLast,
...(lastUserMsg ? [{ role: lastUserMsg.role, content: lastMsgContent }] : [])
];

    const body = JSON.stringify({
      model: chatModel,
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    return new Promise((resolve, reject) => {
      let req;
      const timer = setTimeout(() => { req.destroy(); reject(new Error("请求超时")); }, 15000);

      req = https.request({
        hostname: chatEndpoint,
        port: 443,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + chatApiKey,
          "Content-Length": Buffer.byteLength(body),
        }
      }, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.message?.content;
            if (content) {
              resolve(content);
            } else {
              resolve("AI无响应: " + JSON.stringify(json));
            }
          } catch (e) {
            reject(new Error("响应解析失败: " + e.message));
          }
        });
      });

      req.on("error", e => { clearTimeout(timer); reject(e); });
      req.write(body);
      req.end();
    });
  });

  // ✅ 修复：只保留一个 win.on("close")，删除旧的含 engineBTC/ETH 的版本
  win.on("close", (e) => {
e.preventDefault();
const choice = require("electron").dialog.showMessageBoxSync(win, {
type: "question",
buttons: ["确认关闭", "取消"],
defaultId: 1,
cancelId: 1,
title: "确认退出",
message: "确定要关闭机器人吗？",
detail: engine ? "⚠️ 机器人正在运行，关闭后持仓将不再被监控！" : "确认退出程序？"
});
if (choice === 0) {
if (engine) {
try { engine.saveSimState(); } catch(e) {}
engine.stop();
engine = null;
}
win.destroy();
}
});
  app.on("window-all-closed", () => {
    if (engine) { engine.saveSimState(); }
    if (engine) { engine.stop(); engine = null; }
    app.quit();
  });

});