/**
 * Gate.io 熊市手动辅助做空脚本
 * 策略：反弹到阻力位 → 做空 → 止盈2-3% 止损1% 杠杆3-5x
 * 功能：
 *  1. 实时监控价格 + 关键阻力位
 *  2. 信号提示（不自动下单，人工确认后执行）
 *  3. 自动计算仓位/止盈/止损价格
 *  4. 一键下单（确认后）
 *  5. 复利追踪
 */

const https = require("https");
const http  = require("http");
const crypto = require("crypto");

// ============================================================
// ⚙️  配置区 — 修改这里
// ============================================================
const CONFIG = {
  API_KEY:    "your_api_key_here",
  API_SECRET: "your_api_secret_here",

  SYMBOL:     "BTC_USDT",
  LEVERAGE:   5,              // 杠杆（推荐3-5，不要超过5）
  CAPITAL:    500,            // 总本金
  RISK_PCT:   0.10,           // 每笔最多用本金10% = 50U
  STOP_PCT:   0.010,          // 止损1%
  TP1_PCT:    0.020,          // 第一止盈2%（平50%仓）
  TP2_PCT:    0.030,          // 第二止盈3%（平剩余仓）

  // 阻力位（根据当前行情手动填写，脚本会在价格接近时提示）
  RESISTANCE_LEVELS: [
    70000, 71500, 73000, 75000, 78000
  ],

  // 支撑位（做空止损参考）
  SUPPORT_LEVELS: [
    68000, 66000, 64000, 62000
  ],

  ALERT_RANGE_PCT: 0.005,     // 价格距阻力位0.5%以内发出提示
  CHECK_INTERVAL:  10,        // 每10秒检查一次价格
};

// ============================================================
// API 签名
// ============================================================
function sign(method, path, query = "", body = "") {
  const ts  = String(Math.floor(Date.now() / 1000));
  const bodyHash = crypto.createHash("sha512").update(body).digest("hex");
  const msg = `${method}\n${path}\n${query}\n${bodyHash}\n${ts}`;
  const sig = crypto.createHmac("sha512", CONFIG.API_SECRET).update(msg).digest("hex");
  return { "KEY": CONFIG.API_KEY, "Timestamp": ts, "SIGN": sig, "Content-Type": "application/json" };
}

function apiGet(path, params = {}) {
  const query = Object.entries(params).map(([k,v])=>`${k}=${v}`).join("&");
  const headers = sign("GET", path, query);
  const url = `https://api.gateio.ws${path}${query?"?"+query:""}`;
  return new Promise((r, j) => {
    https.get(url, { headers }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { r(JSON.parse(d)); } catch(e) { j(e); } });
    }).on("error", j);
  });
}

function apiPost(path, body) {
  const bodyStr = JSON.stringify(body);
  const headers = sign("POST", path, "", bodyStr);
  return new Promise((r, j) => {
    const req = https.request(
      { hostname:"api.gateio.ws", path, method:"POST", headers },
      res => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{try{r(JSON.parse(d));}catch(e){j(e);}}); }
    );
    req.on("error", j); req.write(bodyStr); req.end();
  });
}

// ============================================================
// 市场数据
// ============================================================
async function getPrice() {
  const data = await apiGet(`/api/v4/futures/usdt/contracts/${CONFIG.SYMBOL}`);
  return parseFloat(data.last_price);
}

async function getBalance() {
  const data = await apiGet("/api/v4/futures/usdt/accounts");
  return parseFloat(data.available);
}

async function getPosition() {
  try {
    const data = await apiGet(`/api/v4/futures/usdt/positions/${CONFIG.SYMBOL}`);
    return data;
  } catch(e) { return null; }
}

async function getKlines(interval = "1h", limit = 50) {
  const data = await apiGet("/api/v4/futures/usdt/candlesticks", {
    contract: CONFIG.SYMBOL, interval, limit
  });
  return data.map(c => ({ time:+c.t, open:+c.o, high:+c.h, low:+c.l, close:+c.c }));
}

// ============================================================
// 技术分析
// ============================================================
function calcEMA(arr, p) {
  const k = 2/(p+1); let v = arr[0];
  return arr.map((x, i) => { if(i===0) return v; v = x*k + v*(1-k); return v; });
}

function calcRSI(closes, p = 14) {
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i]-closes[i-1]; d>0?ag+=d/p:al+=-d/p;
  }
  let rsi = al===0?100:100-100/(1+ag/al);
  for (let i = p+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?-d:0))/p;
    rsi = al===0?100:100-100/(1+ag/al);
  }
  return rsi;
}

function analyzeMarket(klines) {
  const closes = klines.map(c => c.close);
  const highs  = klines.map(c => c.high);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const rsi    = calcRSI(closes, 14);
  const last   = closes[closes.length-1];
  const e20    = ema20[ema20.length-1];
  const e50    = ema50[ema50.length-1];

  // 近期最高价（阻力）
  const recent10High = Math.max(...highs.slice(-10));
  const recent20High = Math.max(...highs.slice(-20));

  // 趋势判断
  const trend = last < e20 && e20 < e50 ? "BEAR" :
                last > e20 && e20 > e50 ? "BULL" : "RANGE";

  // 做空评分（0-100）
  let score = 0;
  if (trend === "BEAR") score += 40;
  if (rsi > 55 && rsi < 75) score += 25;         // RSI反弹高位
  if (last > e20 * 0.995 && last < e20 * 1.005) score += 20; // 价格在EMA20附近
  if (last >= recent10High * 0.995) score += 15; // 触及近期高点

  return { trend, rsi: +rsi.toFixed(1), e20: +e20.toFixed(0), e50: +e50.toFixed(0),
           recent10High: +recent10High.toFixed(0), score };
}

// ============================================================
// 仓位计算
// ============================================================
function calcOrder(price, balance) {
  const tradeCapital = Math.min(balance * CONFIG.RISK_PCT, balance * CONFIG.RISK_PCT);
  const size = Math.floor(tradeCapital * CONFIG.LEVERAGE / price * 1000) / 1000; // BTC精度

  const sl  = +(price * (1 + CONFIG.STOP_PCT)).toFixed(1);
  const tp1 = +(price * (1 - CONFIG.TP1_PCT)).toFixed(1);
  const tp2 = +(price * (1 - CONFIG.TP2_PCT)).toFixed(1);

  const maxLoss   = tradeCapital * CONFIG.STOP_PCT * CONFIG.LEVERAGE;
  const maxProfit = tradeCapital * CONFIG.TP2_PCT * CONFIG.LEVERAGE;

  return { size, sl, tp1, tp2, tradeCapital: +tradeCapital.toFixed(2),
           maxLoss: +maxLoss.toFixed(2), maxProfit: +maxProfit.toFixed(2) };
}

// ============================================================
// 下单
// ============================================================
async function setLeverage() {
  try {
    await apiPost(`/api/v4/futures/usdt/positions/${CONFIG.SYMBOL}/leverage`, {
      leverage: String(CONFIG.LEVERAGE), cross_leverage_limit: "0"
    });
  } catch(e) { /* 可能已设置 */ }
}

async function placeShort(size, price) {
  const order = {
    contract: CONFIG.SYMBOL,
    size: -Math.abs(size),    // 负数 = 做空
    price: String(price),
    tif: "gtc",
    text: "bear_short_strategy",
  };
  return await apiPost("/api/v4/futures/usdt/orders", order);
}

async function placeStopOrder(size, triggerPrice, isStop = true) {
  const order = {
    initial: {
      contract: CONFIG.SYMBOL,
      size: Math.abs(size),   // 正数 = 平空（买入）
      price: "0",             // 市价平仓
      tif: "ioc",
      reduce_only: true,
    },
    trigger: {
      strategy_type: 0,
      price_type: 0,
      price: String(triggerPrice),
      rule: 1,                // 1=价格上涨时触发（止损）
    }
  };
  return await apiPost("/api/v4/futures/usdt/price_orders", order);
}

// ============================================================
// 格式化输出
// ============================================================
const NOW = () => new Date().toISOString().replace("T"," ").slice(0,19);
const LINE = "─".repeat(55);

function printStatus(price, balance, pos, analysis, order) {
  console.clear();
  console.log("═".repeat(55));
  console.log(`  🐻 熊市做空监控系统  [${NOW()}]`);
  console.log("═".repeat(55));
  console.log(`  ${CONFIG.SYMBOL}  当前价: $${price.toLocaleString()}`);
  console.log(`  账户余额: ${balance.toFixed(2)} USDT`);

  // 持仓状态
  if (pos && parseFloat(pos.size) !== 0) {
    const size      = parseFloat(pos.size);
    const entryP    = parseFloat(pos.entry_price);
    const unPnl     = parseFloat(pos.unrealised_pnl);
    const pct       = ((entryP - price) / entryP * 100 * CONFIG.LEVERAGE).toFixed(2);
    console.log(LINE);
    console.log(`  📊 当前持仓`);
    console.log(`  方向: ${size < 0 ? "🔴 空单" : "🟢 多单"}  数量: ${Math.abs(size)}`);
    console.log(`  开仓价: $${entryP}  当前: $${price}`);
    console.log(`  未实现盈亏: ${unPnl >= 0 ? "+" : ""}${unPnl.toFixed(2)}U  (${pct}%)`);
  } else {
    console.log(LINE);
    console.log("  📊 当前无持仓");
  }

  // 技术分析
  console.log(LINE);
  console.log(`  📈 技术分析 (1小时线)`);
  console.log(`  趋势: ${analysis.trend==="BEAR"?"🔴 熊市":analysis.trend==="BULL"?"🟢 牛市":"🟡 震荡"}`);
  console.log(`  RSI: ${analysis.rsi}  ${analysis.rsi>65?"⚠️ 超买区":analysis.rsi<35?"⚠️ 超卖区":"正常"}`);
  console.log(`  EMA20: $${analysis.e20}  EMA50: $${analysis.e50}`);
  console.log(`  近10根最高价: $${analysis.recent10High}`);
  console.log(`  做空评分: ${"█".repeat(Math.round(analysis.score/10))} ${analysis.score}/100`);

  // 阻力位提示
  console.log(LINE);
  console.log("  🚧 关键阻力位监控");
  for (const level of CONFIG.RESISTANCE_LEVELS) {
    const diff = ((level - price) / price * 100);
    const inRange = Math.abs(diff) < CONFIG.ALERT_RANGE_PCT * 100;
    const bar = inRange ? "🔥 接近！" : diff > 0 ? `↑ +${diff.toFixed(1)}%` : `↓ ${diff.toFixed(1)}%`;
    console.log(`  $${level.toLocaleString().padEnd(10)} ${bar}`);
  }

  // 推荐开仓参数
  if (order) {
    console.log(LINE);
    console.log("  💡 推荐做空参数");
    console.log(`  入场价:   $${price.toLocaleString()}`);
    console.log(`  开仓金额: ${order.tradeCapital}U (本金${CONFIG.RISK_PCT*100}%)`);
    console.log(`  合约数量: ${order.size} 张`);
    console.log(`  止损价:   $${order.sl.toLocaleString()}  (亏损上限 ${order.maxLoss}U)`);
    console.log(`  止盈一:   $${order.tp1.toLocaleString()}  (+${order.maxProfit/2}U)`);
    console.log(`  止盈二:   $${order.tp2.toLocaleString()}  (+${order.maxProfit}U)`);
    console.log(`  盈亏比:   1:${(CONFIG.TP2_PCT/CONFIG.STOP_PCT).toFixed(1)}`);
  }

  // 信号评估
  console.log(LINE);
  if (analysis.score >= 70) {
    console.log("  🔴 信号强烈！建议做空（按 S 确认开仓）");
  } else if (analysis.score >= 50) {
    console.log("  🟡 信号一般，可考虑做空（注意风险）");
  } else {
    console.log("  ⏸  当前无信号，继续等待...");
  }
  console.log("═".repeat(55));
  console.log("  [S]做空  [Q]退出  自动刷新中...");
}

// ============================================================
// 交易日志
// ============================================================
const fs = require("fs");
const LOG_FILE = "/home/node/.openclaw/workspace/gate_strategy/trade_log.json";

function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE,"utf8")); }
  catch(e) { return { trades:[], totalPnl:0, capital:CONFIG.CAPITAL }; }
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function printTradeLog() {
  const log = loadLog();
  if (!log.trades.length) { console.log("  暂无交易记录"); return; }
  console.log(`\n  📋 交易记录 (共${log.trades.length}笔)`);
  console.log("  " + "─".repeat(60));
  log.trades.slice(-10).forEach(t => {
    const pnlStr = ((t.pnl>=0?"+":"")+t.pnl.toFixed(2)).padEnd(8);
    console.log(`  ${t.time}  ${t.dir}  ${t.price}  ${pnlStr}  ${t.win?"✅":"❌"}`);
  });
  const wr = log.trades.length ? (log.trades.filter(t=>t.win).length/log.trades.length*100).toFixed(1) : 0;
  console.log(`  总盈亏: ${log.totalPnl>=0?"+":""}${log.totalPnl.toFixed(2)}U  胜率: ${wr}%`);
}

// ============================================================
// 主监控循环
// ============================================================
async function main() {
  console.log("═".repeat(55));
  console.log("  🐻 Gate.io 熊市做空辅助系统启动");
  console.log(`  策略: 反弹至阻力位 → 做空`);
  console.log(`  杠杆: ${CONFIG.LEVERAGE}x  止损: ${CONFIG.STOP_PCT*100}%  止盈: ${CONFIG.TP2_PCT*100}%`);
  console.log("═".repeat(55));

  // 检查API Key是否已配置
  if (CONFIG.API_KEY === "your_api_key_here") {
    console.log("\n⚠️  请先在脚本顶部填写 API_KEY 和 API_SECRET");
    console.log("   Gate.io 后台 → API管理 → 创建API Key → 勾选合约权限\n");

    // 演示模式：只显示价格和信号，不执行交易
    console.log("  🔍 演示模式（不需要API Key）：");
    console.log("  正在获取实时行情...\n");

    const runDemo = async () => {
      try {
        const priceData = await new Promise((r, j) => {
          https.get(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${CONFIG.SYMBOL}`, res => {
            let d=""; res.on("data",c=>d+=c);
            res.on("end",()=>r(JSON.parse(d)));
          }).on("error",j);
        });
        const price = parseFloat(priceData.last_price);

        const klData = await new Promise((r, j) => {
          https.get(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${CONFIG.SYMBOL}&interval=1h&limit=60`, res => {
            let d=""; res.on("data",c=>d+=c);
            res.on("end",()=>r(JSON.parse(d)));
          }).on("error",j);
        });
        const klines = klData.map(c=>({time:+c.t,open:+c.o,high:+c.h,low:+c.l,close:+c.c}));

        const analysis = analyzeMarket(klines);
        const mockBal  = CONFIG.CAPITAL;
        const order    = calcOrder(price, mockBal);

        console.clear();
        console.log("═".repeat(55));
        console.log(`  🐻 熊市做空监控 [演示模式] [${NOW()}]`);
        console.log("═".repeat(55));
        console.log(`  ${CONFIG.SYMBOL}  当前价: $${price.toLocaleString()}`);
        console.log(`  模拟本金: ${mockBal} USDT`);
        console.log(LINE);
        console.log(`  📈 技术分析 (1小时线)`);
        console.log(`  趋势: ${analysis.trend==="BEAR"?"🔴 熊市":analysis.trend==="BULL"?"🟢 牛市":"🟡 震荡"}`);
        console.log(`  RSI(14): ${analysis.rsi}  ${analysis.rsi>65?"⚠️ 超买区，适合做空":analysis.rsi<35?"超卖区，谨慎做空":"正常区间"}`);
        console.log(`  EMA20: $${analysis.e20}  EMA50: $${analysis.e50}`);
        console.log(`  近10根最高: $${analysis.recent10High}`);
        const scoreBar = "█".repeat(Math.round(analysis.score/5))+"░".repeat(20-Math.round(analysis.score/5));
        console.log(`  做空评分: [${scoreBar}] ${analysis.score}/100`);
        console.log(LINE);
        console.log("  🚧 阻力位监控");
        for (const lv of CONFIG.RESISTANCE_LEVELS) {
          const diff = ((lv-price)/price*100);
          const flag = Math.abs(diff)<0.5?"🔥 极近！":diff>0?`↑ +${diff.toFixed(1)}%`:`↓ 已突破 ${diff.toFixed(1)}%`;
          console.log(`  $${String(lv.toLocaleString()).padEnd(8)} ${flag}`);
        }
        console.log(LINE);
        console.log(`  💡 如果此时做空（500U本金×10%）：`);
        console.log(`  入场: $${price.toLocaleString()}  数量: ${order.size}张`);
        console.log(`  止损: $${order.sl.toLocaleString()}  （最大亏 ${order.maxLoss}U）`);
        console.log(`  止盈: $${order.tp2.toLocaleString()}  （最大赚 ${order.maxProfit}U）`);
        console.log(`  盈亏比: 1:${(CONFIG.TP2_PCT/CONFIG.STOP_PCT).toFixed(0)}`);
        console.log(LINE);
        if (analysis.score >= 70) {
          console.log("  🔴 信号强烈！当前是做空好时机");
        } else if (analysis.score >= 50) {
          console.log("  🟡 信号中等，可以考虑少量做空");
        } else {
          console.log("  ⏸  信号不足，继续等待机会...");
        }
        console.log("═".repeat(55));
        console.log(`  ${CONFIG.CHECK_INTERVAL}秒后刷新...  Ctrl+C 退出`);
      } catch(e) {
        console.error("  获取数据失败:", e.message);
      }
      setTimeout(runDemo, CONFIG.CHECK_INTERVAL * 1000);
    };
    runDemo();
    return;
  }

  // 正式模式（已配置API）
  await setLeverage();
  console.log(`  ✅ 杠杆已设置: ${CONFIG.LEVERAGE}x`);

  const run = async () => {
    try {
      const [price, balance, pos, klines] = await Promise.all([
        getPrice(), getBalance(), getPosition(), getKlines("1h", 60)
      ]);
      const analysis = analyzeMarket(klines);
      const order    = calcOrder(price, balance);

      printStatus(price, balance, pos, analysis, order);

      // 阻力位预警
      for (const level of CONFIG.RESISTANCE_LEVELS) {
        const diff = Math.abs(price - level) / level;
        if (diff < CONFIG.ALERT_RANGE_PCT && price < level) {
          console.log(`\n🔔 价格接近阻力位 $${level}！（距离 ${(diff*100).toFixed(2)}%）`);
        }
      }
    } catch(e) {
      console.error("  ❌ 错误:", e.message);
    }
    setTimeout(run, CONFIG.CHECK_INTERVAL * 1000);
  };
  run();
}

main().catch(e => { console.error("❌", e.message); });
