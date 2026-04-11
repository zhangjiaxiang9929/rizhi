/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         Gate.io BTC 实盘交易机器人 v10                      ║
 * ║  策略: 布林带+EMA双向 | 止盈3% | 止损2% | 5x | 1h          ║
 * ║  回测验证: BTC 180天 ROI +22.98% 胜率46.1%                  ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * 使用方法：
 *   1. 填写下方 API_KEY / API_SECRET
 *   2. node live_trader.js          → 正式运行
 *   3. node live_trader.js --dry    → 模拟模式（不真实下单，用于验证）
 *
 * 安全注意：
 *   - Gate.io API 权限只开 "期货交易"，不要开提现
 *   - 建议 IP 白名单
 *   - 不要把这个文件上传到 GitHub
 */

const https  = require("https");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// ═══════════════════════════════════════
//  ⚙️  配置区（必填）
// ═══════════════════════════════════════
const CONFIG = {
  API_KEY:    "YOUR_API_KEY_HERE",       // ← 替换
  API_SECRET: "YOUR_API_SECRET_HERE",    // ← 替换

  SYMBOL:          "BTC_USDT",
  LEVERAGE:        5,
  CAPITAL:         500,          // 总资金 (USDT)
  POSITION_RATIO:  0.20,         // 每笔仓位占总资金比例
  TAKE_PCT:        0.030,        // 止盈 3%
  STOP_PCT:        0.020,        // 止损 2%

  // 指标参数（勿改，与回测一致）
  EMA_FAST:    9,
  EMA_SLOW:    21,
  EMA_MID:     55,
  RSI_PERIOD:  14,
  BB_PERIOD:   20,
  BB_STD:      2.0,
  ATR_MIN_PCT: 0.002,

  CHECK_INTERVAL_MS: 60 * 1000,   // 每 60 秒检查一次（1h线不需要太频繁）
  LOG_FILE: path.join(__dirname, "live_trader.log"),

  // 风控：总亏损超过以下值自动停止
  MAX_LOSS_PCT: 0.20,   // 亏损超过总资金20%停止（100U）
};

const DRY_RUN = process.argv.includes("--dry");

// ═══════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════
function log(msg) {
  const ts = new Date().toISOString().replace("T"," ").slice(0,19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(CONFIG.LOG_FILE, line + "\n");
}

function logSep(char="─", len=60) {
  log(char.repeat(len));
}

// Gate.io API 签名
function sign(method, path, queryStr, body, secret) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const bodySHA256 = crypto.createHash("sha256").update(body || "").digest("hex");
  const signStr = `${method}\n${path}\n${queryStr}\n${bodySHA256}\n${ts}`;
  const sig = crypto.createHmac("sha256", secret).update(signStr).digest("hex");
  return { ts, sig };
}

// HTTP 请求（公共 + 私有）
function request(method, apiPath, query={}, bodyObj=null) {
  return new Promise((resolve, reject) => {
    const queryStr = Object.keys(query).length
      ? Object.entries(query).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&")
      : "";
    const fullPath = "/api/v4" + apiPath + (queryStr ? "?" + queryStr : "");
    const body = bodyObj ? JSON.stringify(bodyObj) : "";

    const headers = { "Content-Type": "application/json", "Accept": "application/json" };

    // 私有接口加签名
    if (CONFIG.API_KEY && CONFIG.API_KEY !== "YOUR_API_KEY_HERE") {
      const { ts, sig } = sign(method, "/api/v4" + apiPath, queryStr, body, CONFIG.API_SECRET);
      headers["KEY"]       = CONFIG.API_KEY;
      headers["Timestamp"] = ts;
      headers["SIGN"]      = sig;
    }

    const options = {
      hostname: "api.gateio.ws",
      path:     fullPath,
      method,
      headers,
    };

    const req = https.request(options, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error(`JSON解析失败: ${data.slice(0,200)}`)); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════
//  指标计算（与回测完全一致）
// ═══════════════════════════════════════
function ema(arr, p) {
  const k = 2/(p+1), r = Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    if (i < p-1) { s += arr[i]; continue; }
    if (i === p-1) { s += arr[i]; r[i] = s/p; continue; }
    r[i] = arr[i]*k + r[i-1]*(1-k);
  }
  return r;
}

function calcRSI(cls, p) {
  const r = Array(cls.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = cls[i] - cls[i-1];
    d > 0 ? ag += d/p : al += -d/p;
  }
  r[p] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  for (let i = p+1; i < cls.length; i++) {
    const d = cls[i] - cls[i-1];
    ag = (ag*(p-1) + (d>0?d:0)) / p;
    al = (al*(p-1) + (d<0?-d:0)) / p;
    r[i] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  }
  return r;
}

function calcATR(cs, p=14) {
  const tr = cs.map((c,i) => i === 0 ? c.high-c.low :
    Math.max(c.high-c.low, Math.abs(c.high-cs[i-1].close), Math.abs(c.low-cs[i-1].close)));
  const res = Array(cs.length).fill(null);
  for (let i = p-1; i < cs.length; i++)
    res[i] = tr.slice(i-p+1, i+1).reduce((s,v) => s+v, 0) / p;
  return res;
}

function calcBB(cls, p=20, m=2) {
  const mid = ema(cls, p);
  const up  = Array(cls.length).fill(null);
  const lo  = Array(cls.length).fill(null);
  for (let i = p-1; i < cls.length; i++) {
    const sl = cls.slice(i-p+1, i+1);
    const mn = sl.reduce((s,v) => s+v, 0) / p;
    const sd = Math.sqrt(sl.map(v => (v-mn)**2).reduce((s,v) => s+v, 0) / p);
    up[i] = mid[i] + m*sd;
    lo[i] = mid[i] - m*sd;
  }
  return { mid, up, lo };
}

function buildIndicators(cs) {
  const cls = cs.map(c => c.close);
  const ef  = ema(cls, CONFIG.EMA_FAST);
  const es  = ema(cls, CONFIG.EMA_SLOW);
  const em  = ema(cls, CONFIG.EMA_MID);
  const ri  = calcRSI(cls, CONFIG.RSI_PERIOD);
  const at  = calcATR(cs, 14);
  const bb  = calcBB(cls, CONFIG.BB_PERIOD, CONFIG.BB_STD);
  return cs.map((c, i) => ({
    ...c, ef: ef[i], es: es[i], em: em[i], rsi: ri[i],
    atr: at[i], bbUp: bb.up[i], bbLo: bb.lo[i], bbMid: bb.mid[i],
  }));
}

function isBullishCandle(c) {
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.close, c.open) - c.low;
  return c.close > c.open && lowerWick > body * 1.5;
}
function isBearishCandle(c) {
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.close, c.open);
  return c.close < c.open && upperWick > body * 1.5;
}
function isBullEngulf(cur, prev) {
  return cur.close > cur.open && prev.close < prev.open &&
         cur.close > prev.open && cur.open < prev.close;
}
function isBearEngulf(cur, prev) {
  return cur.close < cur.open && prev.close > prev.open &&
         cur.open > prev.close && cur.close < prev.open;
}

function getSignal(cur, prev) {
  if (!cur.ef || cur.rsi === null || !cur.atr || !cur.bbUp) return "HOLD";
  if (cur.atr / cur.close < CONFIG.ATR_MIN_PCT) return "HOLD";

  const xUp   = prev.ef < prev.es && cur.ef > cur.es;
  const xDown = prev.ef > prev.es && cur.ef < cur.es;

  const bbLong  = prev.close <= prev.bbLo && cur.close > cur.bbLo;
  const bbShort = prev.close >= prev.bbUp && cur.close < cur.bbUp;

  const emaBounceUp   = prev.low  <= prev.em*1.005 && cur.close > cur.em && cur.close > prev.close;
  const emaBounceDown = prev.high >= prev.em*0.995 && cur.close < cur.em && cur.close < prev.close;

  const rsiOK_Long  = cur.rsi > 30 && cur.rsi < 58;
  const rsiOK_Short = cur.rsi > 42 && cur.rsi < 72;

  const longCond =
    (bbLong  && rsiOK_Long) ||
    (xUp     && cur.close > cur.em && rsiOK_Long) ||
    (emaBounceUp && rsiOK_Long && (isBullishCandle(cur) || isBullEngulf(cur, prev)));

  const shortCond =
    (bbShort && rsiOK_Short) ||
    (xDown   && cur.close < cur.em && rsiOK_Short) ||
    (emaBounceDown && rsiOK_Short && (isBearishCandle(cur) || isBearEngulf(cur, prev)));

  if (longCond)  return "LONG";
  if (shortCond) return "SHORT";
  return "HOLD";
}

// ═══════════════════════════════════════
//  Gate.io 期货 API 封装
// ═══════════════════════════════════════

// 获取账户余额
async function getBalance() {
  const r = await request("GET", "/futures/usdt/accounts");
  if (r.status !== 200) throw new Error(`账户查询失败: ${JSON.stringify(r.body)}`);
  return parseFloat(r.body.available);
}

// 获取当前持仓
async function getPosition() {
  const r = await request("GET", `/futures/usdt/positions/${CONFIG.SYMBOL}`);
  if (r.status !== 200) throw new Error(`持仓查询失败: ${JSON.stringify(r.body)}`);
  const p = r.body;
  if (!p || p.size === 0) return null;
  return {
    dir:    p.size > 0 ? "LONG" : "SHORT",
    size:   Math.abs(p.size),             // 张数
    entry:  parseFloat(p.entry_price),
    pnl:    parseFloat(p.unrealised_pnl),
    liqPx:  parseFloat(p.liq_price),
  };
}

// 设置杠杆
async function setLeverage() {
  const r = await request("POST", `/futures/usdt/positions/${CONFIG.SYMBOL}/leverage`, {}, {
    leverage: String(CONFIG.LEVERAGE),
    cross_leverage_limit: "0",
  });
  if (r.status !== 200 && r.status !== 400) {
    log(`⚠️ 杠杆设置: ${JSON.stringify(r.body)}`);
  }
}

// 获取最新价格
async function getPrice() {
  const r = await request("GET", `/futures/usdt/tickers`, { contract: CONFIG.SYMBOL });
  if (r.status !== 200 || !r.body[0]) throw new Error("价格获取失败");
  return parseFloat(r.body[0].last);
}

// 获取合约信息（最小下单量、张数换算）
async function getContractInfo() {
  const r = await request("GET", `/futures/usdt/contracts/${CONFIG.SYMBOL}`);
  if (r.status !== 200) throw new Error("合约信息获取失败");
  return {
    quantoMultiplier: parseFloat(r.body.quanto_multiplier), // 每张对应多少BTC
    orderSizeMin:     parseInt(r.body.order_size_min),       // 最小下单张数
  };
}

// 计算下单张数
// size_usdt = 资金 × 仓位比 × 杠杆
// 张数 = size_usdt / (价格 × 每张BTC数)
function calcContracts(capital, price, quantoMultiplier) {
  const sizeUsdt  = capital * CONFIG.POSITION_RATIO * CONFIG.LEVERAGE;
  const contracts = Math.floor(sizeUsdt / (price * quantoMultiplier));
  return Math.max(contracts, 1);
}

// 市价下单
async function placeOrder(dir, contracts) {
  const side = dir === "LONG" ? contracts : -contracts;  // 正=买多，负=卖空
  const body = {
    contract:    CONFIG.SYMBOL,
    size:        side,
    price:       "0",   // 市价单
    tif:         "ioc",
    reduce_only: false,
    text:        "t-live_bot_v10",
  };

  if (DRY_RUN) {
    log(`  [模拟] 下单 ${dir} ${contracts}张`);
    return { id: "DRY_RUN_" + Date.now() };
  }

  const r = await request("POST", "/futures/usdt/orders", {}, body);
  if (r.status !== 201) throw new Error(`下单失败: ${JSON.stringify(r.body)}`);
  return r.body;
}

// 平仓（市价全平）
async function closePosition(pos) {
  const closeSide = pos.dir === "LONG" ? -pos.size : pos.size;
  const body = {
    contract:    CONFIG.SYMBOL,
    size:        closeSide,
    price:       "0",
    tif:         "ioc",
    reduce_only: true,
    text:        "t-live_bot_v10_close",
  };

  if (DRY_RUN) {
    log(`  [模拟] 平仓 ${pos.dir} ${pos.size}张`);
    return;
  }

  const r = await request("POST", "/futures/usdt/orders", {}, body);
  if (r.status !== 201) throw new Error(`平仓失败: ${JSON.stringify(r.body)}`);
}

// ═══════════════════════════════════════
//  获取并处理 K 线数据（近100根1h）
// ═══════════════════════════════════════
async function fetchRecentKlines() {
  const end   = Math.floor(Date.now() / 1000);
  const start = end - 120 * 3600; // 近120小时（够指标计算）
  const url   = `/futures/usdt/candlesticks`;
  const r = await request("GET", url, {
    contract: CONFIG.SYMBOL,
    from:     start,
    to:       end,
    interval: "1h",
  });
  if (r.status !== 200) throw new Error(`K线获取失败: ${JSON.stringify(r.body)}`);
  return r.body
    .map(c => ({ time: +c.t, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v }))
    .sort((a, b) => a.time - b.time);
}

// ═══════════════════════════════════════
//  状态文件（持久化 entryPrice/SL/TP）
// ═══════════════════════════════════════
const STATE_FILE = path.join(__dirname, "live_trader_state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { pos: null, startCap: null, peakCap: null };
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ═══════════════════════════════════════
//  主循环
// ═══════════════════════════════════════
async function main() {
  log("═".repeat(62));
  log(`  Gate.io BTC 实盘机器人 v10  ${DRY_RUN ? "[模拟模式]" : "[真实交易]"}`);
  log(`  止盈${CONFIG.TAKE_PCT*100}% | 止损${CONFIG.STOP_PCT*100}% | ${CONFIG.LEVERAGE}x | 仓位${CONFIG.POSITION_RATIO*100}%`);
  log("═".repeat(62));

  if (CONFIG.API_KEY === "YOUR_API_KEY_HERE" && !DRY_RUN) {
    log("❌ 错误：请先填写 API_KEY 和 API_SECRET！");
    process.exit(1);
  }

  // 初始化状态
  let state = loadState();

  // 设置杠杆
  if (!DRY_RUN) {
    await setLeverage();
    log(`✅ 杠杆已设置: ${CONFIG.LEVERAGE}x`);
  }

  // 获取起始资金
  let balance = DRY_RUN ? CONFIG.CAPITAL : await getBalance();
  if (!state.startCap) {
    state.startCap = balance;
    state.peakCap  = balance;
    saveState(state);
  }
  log(`💰 账户余额: ${balance.toFixed(2)}U | 起始: ${state.startCap.toFixed(2)}U`);

  // 获取合约信息
  const contractInfo = DRY_RUN
    ? { quantoMultiplier: 0.0001, orderSizeMin: 1 }
    : await getContractInfo();
  log(`📋 合约: ${CONFIG.SYMBOL} | 每张=${contractInfo.quantoMultiplier}BTC`);

  log("\n⏳ 开始监控循环（每 60 秒检查一次 1h K线）...\n");

  let lastSignalTime = 0; // 防止同一根K线重复触发

  while (true) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const currentHour = Math.floor(now / 3600) * 3600; // 当前小时整点

      // ── 获取账户数据 ──
      balance = DRY_RUN ? state.startCap : await getBalance();
      const price = DRY_RUN ? 70000 : await getPrice();

      // ── 风控检查 ──
      const totalLoss = (state.startCap - balance) / state.startCap;
      if (totalLoss > CONFIG.MAX_LOSS_PCT && !DRY_RUN) {
        log(`🚨 风控触发！亏损 ${(totalLoss*100).toFixed(1)}% 超过上限 ${CONFIG.MAX_LOSS_PCT*100}%，停止运行`);
        break;
      }

      // ── 检查现有持仓的止盈/止损 ──
      const livePos = DRY_RUN ? null : await getPosition();
      if (livePos && state.pos) {
        const sl = state.pos.sl;
        const tp = state.pos.tp;
        const hitSL = livePos.dir === "LONG" ? price <= sl : price >= sl;
        const hitTP = livePos.dir === "LONG" ? price >= tp : price <= tp;

        if (hitTP || hitSL) {
          const reason = hitTP ? "止盈" : "止损";
          const pnlPct = livePos.dir === "LONG"
            ? (price - livePos.entry) / livePos.entry * 100
            : (livePos.entry - price) / livePos.entry * 100;
          log(`📤 ${reason}平仓 | ${livePos.dir} | 入场:${livePos.entry} | 现价:${price.toFixed(2)} | 盈亏:${pnlPct.toFixed(2)}%`);
          await closePosition(livePos);
          state.pos = null;
          saveState(state);
          await sleep(2000);
          continue;
        }

        // 持仓中，输出状态
        const pnlPct = livePos.dir === "LONG"
          ? (price - livePos.entry) / livePos.entry * 100
          : (livePos.entry - price) / livePos.entry * 100;
        const pnlU = livePos.pnl.toFixed(2);
        log(`📊 持仓中 ${livePos.dir} | 入场:${livePos.entry.toFixed(2)} | 现价:${price.toFixed(2)} | 浮盈:${pnlPct>=0?"+":""}${pnlPct.toFixed(2)}% (${pnlU}U) | SL:${sl} TP:${tp}`);

      } else if (!livePos && state.pos) {
        // 持仓已不存在（可能被爆仓或手动平仓）
        log(`⚠️ 本地记录有持仓但交易所无仓位，清除本地状态`);
        state.pos = null;
        saveState(state);
      }

      // ── 无仓位时寻找入场信号 ──
      if (!livePos) {
        if (currentHour <= lastSignalTime) {
          // 本小时已检查过，跳过
        } else {
          lastSignalTime = currentHour;

          // 获取K线并计算指标
          const rawKlines = await fetchRecentKlines();
          const cs = buildIndicators(rawKlines).filter(c => c.ef && c.rsi !== null && c.bbUp);

          if (cs.length >= 3) {
            const cur  = cs[cs.length - 2]; // 上一根已收盘K线（避免使用未收盘K线）
            const prev = cs[cs.length - 3];
            const sig  = getSignal(cur, prev);

            log(`🔍 信号检测 | 价格:${price.toFixed(2)} | RSI:${cur.rsi.toFixed(1)} | EMA快:${cur.ef.toFixed(0)}/慢:${cur.es.toFixed(0)} | BB上:${cur.bbUp.toFixed(0)}/下:${cur.bbLo.toFixed(0)} | 信号:${sig}`);

            if (sig !== "HOLD") {
              const contracts = calcContracts(balance, price, contractInfo.quantoMultiplier);
              const sl = sig === "LONG"
                ? +(price * (1 - CONFIG.STOP_PCT)).toFixed(2)
                : +(price * (1 + CONFIG.STOP_PCT)).toFixed(2);
              const tp = sig === "LONG"
                ? +(price * (1 + CONFIG.TAKE_PCT)).toFixed(2)
                : +(price * (1 - CONFIG.TAKE_PCT)).toFixed(2);

              log(`🎯 开仓信号: ${sig} | 入场:${price.toFixed(2)} | SL:${sl} | TP:${tp} | ${contracts}张`);

              const order = await placeOrder(sig, contracts);
              log(`✅ 下单成功 | 订单ID: ${order.id}`);

              state.pos = { dir: sig, entry: price, sl, tp, contracts, openTime: now };
              saveState(state);
            }
          }
        }
      }

    } catch (err) {
      log(`❌ 运行错误: ${err.message}`);
    }

    // 等待下次检查
    await sleep(CONFIG.CHECK_INTERVAL_MS);
  }

  log("🔴 交易机器人已停止");
}

// ═══════════════════════════════════════
//  启动
// ═══════════════════════════════════════
main().catch(err => {
  log(`💥 致命错误: ${err.message}`);
  process.exit(1);
});
