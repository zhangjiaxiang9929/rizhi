/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   Gate.io BTC 自动交易机器人 v10                                ║
 * ║   策略: 布林带 + EMA 双向 | 止盈3% 止损2% | 5x 杠杆 | 1h线    ║
 * ║   回测: BTC 180天 ROI +22.98% 胜率 46.1%                       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * 使用:
 *   node gate_bot.js          ← 真实交易
 *   node gate_bot.js --dry    ← 模拟模式（不下单，仅看信号）
 *
 * Gate.io API Key 权限: 只开「期货交易」，不要开提现
 */

"use strict";
const https  = require("https");
const crypto = require("crypto");
const fs     = require("fs");

// ┌─────────────────────────────────────┐
// │  ★ 填这里，其余不用动               │
// └─────────────────────────────────────┘
const API_KEY    = "YOUR_API_KEY_HERE";     // ← 替换
const API_SECRET = "YOUR_API_SECRET_HERE";  // ← 替换

// ┌─────────────────────────────────────┐
// │  参数（与回测完全一致）              │
// └─────────────────────────────────────┘
const SYMBOL       = "BTC_USDT";
const LEVERAGE     = 5;          // 杠杆倍数
const CAPITAL      = 500;        // 账户总资金 (USDT)，用来计算每笔仓位
const POS_RATIO    = 0.20;       // 每笔仓位占总资金 20% → 100U
const TAKE_PCT     = 0.030;      // 止盈 3%
const STOP_PCT     = 0.020;      // 止损 2%
const MAX_LOSS_PCT = 0.20;       // 全局风控：累计亏损超 20% 自动停止

// ┌─────────────────────────────────────┐
// │  运行时状态                          │
// └─────────────────────────────────────┘
const DRY  = process.argv.includes("--dry");
const LOG  = "gate_bot.log";
const STAT = "gate_bot_state.json";

// ══════════════════════════════════════
//  工具
// ══════════════════════════════════════
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const now    = ()  => new Date().toISOString().replace("T"," ").slice(0,19);
const fmtPct = n   => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
}

// ══════════════════════════════════════
//  Gate.io HTTP（公共 + 私有）
// ══════════════════════════════════════
function gateRequest(method, apiPath, query = {}, body = null) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(query).length
      ? Object.entries(query).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join("&")
      : "";
    const fullPath = "/api/v4" + apiPath + (qs ? "?" + qs : "");
    const bodyStr  = body ? JSON.stringify(body) : "";

    const headers = { "Content-Type": "application/json", Accept: "application/json" };

    if (API_KEY !== "YOUR_API_KEY_HERE") {
      const ts       = Math.floor(Date.now() / 1000).toString();
      const bodyHash = crypto.createHash("sha256").update(bodyStr).digest("hex");
      const toSign   = `${method}\n/api/v4${apiPath}\n${qs}\n${bodyHash}\n${ts}`;
      const sig      = crypto.createHmac("sha256", API_SECRET).update(toSign).digest("hex");
      headers.KEY       = API_KEY;
      headers.Timestamp = ts;
      headers.SIGN      = sig;
    }

    const req = https.request(
      { hostname: "api.gateio.ws", path: fullPath, method, headers },
      res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch(e) { reject(new Error("解析失败: " + d.slice(0, 200))); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ══════════════════════════════════════
//  交易所操作
// ══════════════════════════════════════

async function getBalance() {
  if (DRY) return CAPITAL;
  const r = await gateRequest("GET", "/futures/usdt/accounts");
  if (r.status !== 200) throw new Error("余额查询失败: " + JSON.stringify(r.body));
  return parseFloat(r.body.available);
}

async function getPrice() {
  if (DRY) return 70000;
  const r = await gateRequest("GET", "/futures/usdt/tickers", { contract: SYMBOL });
  if (r.status !== 200) throw new Error("价格获取失败");
  return parseFloat(r.body[0].last);
}

async function getPosition() {
  if (DRY) return null;
  const r = await gateRequest("GET", `/futures/usdt/positions/${SYMBOL}`);
  if (r.status !== 200) throw new Error("持仓查询失败: " + JSON.stringify(r.body));
  const p = r.body;
  if (!p || p.size === 0) return null;
  return {
    dir:   p.size > 0 ? "LONG" : "SHORT",
    size:  Math.abs(p.size),
    entry: parseFloat(p.entry_price),
    upnl:  parseFloat(p.unrealised_pnl),
  };
}

async function getContractInfo() {
  if (DRY) return { mult: 0.0001, minSize: 1 };
  const r = await gateRequest("GET", `/futures/usdt/contracts/${SYMBOL}`);
  if (r.status !== 200) throw new Error("合约信息失败");
  return {
    mult:    parseFloat(r.body.quanto_multiplier),  // 每张 = 0.0001 BTC
    minSize: parseInt(r.body.order_size_min),
  };
}

async function setLeverage() {
  if (DRY) return;
  await gateRequest("POST", `/futures/usdt/positions/${SYMBOL}/leverage`, {},
    { leverage: String(LEVERAGE), cross_leverage_limit: "0" });
}

async function placeOrder(dir, contracts) {
  const size = dir === "LONG" ? contracts : -contracts;
  if (DRY) { log(`  [模拟下单] ${dir} ${contracts}张`); return { id: "DRY_" + Date.now() }; }
  const r = await gateRequest("POST", "/futures/usdt/orders", {}, {
    contract: SYMBOL, size, price: "0", tif: "ioc",
    reduce_only: false, text: "t-gate_bot_v10",
  });
  if (r.status !== 201) throw new Error("开仓失败: " + JSON.stringify(r.body));
  return r.body;
}

async function closePosition(size, dir) {
  const s = dir === "LONG" ? -size : size;
  if (DRY) { log(`  [模拟平仓] ${dir} ${size}张`); return; }
  const r = await gateRequest("POST", "/futures/usdt/orders", {}, {
    contract: SYMBOL, size: s, price: "0", tif: "ioc",
    reduce_only: true, text: "t-gate_bot_v10_close",
  });
  if (r.status !== 201) throw new Error("平仓失败: " + JSON.stringify(r.body));
}

// ══════════════════════════════════════
//  指标（与回测完全一致）
// ══════════════════════════════════════
function ema(arr, p) {
  const k = 2 / (p + 1), r = Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    if      (i < p - 1) { s += arr[i]; }
    else if (i === p - 1) { s += arr[i]; r[i] = s / p; }
    else    { r[i] = arr[i] * k + r[i-1] * (1 - k); }
  }
  return r;
}

function rsi(cls, p) {
  const r = Array(cls.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = cls[i]-cls[i-1]; d>0 ? ag+=d/p : al+=-d/p; }
  r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p+1; i < cls.length; i++) {
    const d = cls[i] - cls[i-1];
    ag = (ag*(p-1) + (d>0?d:0)) / p;
    al = (al*(p-1) + (d<0?-d:0)) / p;
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

function bb(cls, p = 20, m = 2) {
  const mid = ema(cls, p), up = Array(cls.length).fill(null), lo = Array(cls.length).fill(null);
  for (let i = p-1; i < cls.length; i++) {
    const sl = cls.slice(i-p+1, i+1), mn = sl.reduce((s,v)=>s+v,0)/p;
    const sd = Math.sqrt(sl.map(v=>(v-mn)**2).reduce((s,v)=>s+v,0)/p);
    up[i] = mid[i] + m*sd; lo[i] = mid[i] - m*sd;
  }
  return { mid, up, lo };
}

function atr(cs, p = 14) {
  const tr = cs.map((c,i) => i===0 ? c.high-c.low :
    Math.max(c.high-c.low, Math.abs(c.high-cs[i-1].close), Math.abs(c.low-cs[i-1].close)));
  return cs.map((_, i) => i < p-1 ? null : tr.slice(i-p+1,i+1).reduce((s,v)=>s+v,0)/p);
}

function indicators(cs) {
  const cls = cs.map(c => c.close);
  const ef = ema(cls, 9), es = ema(cls, 21), em = ema(cls, 55);
  const ri = rsi(cls, 14), at = atr(cs, 14), B = bb(cls, 20, 2);
  return cs.map((c,i) => ({ ...c, ef:ef[i], es:es[i], em:em[i], rsi:ri[i], atr:at[i], bbUp:B.up[i], bbLo:B.lo[i] }));
}

// K 线形态
const isBullC  = c => c.close>c.open && (Math.min(c.close,c.open)-c.low) > Math.abs(c.close-c.open)*1.5;
const isBearC  = c => c.close<c.open && (c.high-Math.max(c.close,c.open)) > Math.abs(c.close-c.open)*1.5;
const isBullE  = (c,p) => c.close>c.open && p.close<p.open && c.close>p.open && c.open<p.close;
const isBearE  = (c,p) => c.close<c.open && p.close>p.open && c.open>p.close && c.close<p.open;

// 信号
function signal(cur, prev) {
  if (!cur.ef || cur.rsi===null || !cur.atr || !cur.bbUp) return "HOLD";
  if (cur.atr / cur.close < 0.002) return "HOLD";

  const xUp    = prev.ef < prev.es && cur.ef > cur.es;
  const xDown  = prev.ef > prev.es && cur.ef < cur.es;
  const bbL    = prev.close <= prev.bbLo && cur.close > cur.bbLo;
  const bbS    = prev.close >= prev.bbUp && cur.close < cur.bbUp;
  const emaL   = prev.low  <= prev.em*1.005 && cur.close > cur.em && cur.close > prev.close;
  const emaS   = prev.high >= prev.em*0.995 && cur.close < cur.em && cur.close < prev.close;
  const rsiL   = cur.rsi > 30 && cur.rsi < 58;
  const rsiS   = cur.rsi > 42 && cur.rsi < 72;

  const long  = (bbL && rsiL) || (xUp && cur.close>cur.em && rsiL) || (emaL && rsiL && (isBullC(cur)||isBullE(cur,prev)));
  const short = (bbS && rsiS) || (xDown && cur.close<cur.em && rsiS) || (emaS && rsiS && (isBearC(cur)||isBearE(cur,prev)));

  return long ? "LONG" : short ? "SHORT" : "HOLD";
}

// ══════════════════════════════════════
//  K 线获取（近 120 根 1h）
// ══════════════════════════════════════
async function fetchKlines() {
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 120 * 3600;
  const r = await gateRequest("GET", "/futures/usdt/candlesticks",
    { contract: SYMBOL, from, to, interval: "1h" });
  if (r.status !== 200) throw new Error("K线失败: " + JSON.stringify(r.body));
  return r.body
    .map(c => ({ time:+c.t, open:+c.o, high:+c.h, low:+c.l, close:+c.c }))
    .sort((a,b) => a.time - b.time);
}

// ══════════════════════════════════════
//  状态持久化
// ══════════════════════════════════════
function loadState()  { try { return JSON.parse(fs.readFileSync(STAT,"utf8")); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STAT, JSON.stringify(s, null, 2)); }

// ══════════════════════════════════════
//  主循环
// ══════════════════════════════════════
async function main() {
  // 启动检查
  if (!DRY && API_KEY === "YOUR_API_KEY_HERE") {
    console.error("❌ 请先填写 API_KEY 和 API_SECRET！");
    process.exit(1);
  }

  log("═".repeat(60));
  log(`  Gate.io BTC 机器人 v10  ${DRY ? "【模拟模式】" : "【真实交易】"}`);
  log(`  止盈${TAKE_PCT*100}% | 止损${STOP_PCT*100}% | ${LEVERAGE}x | 仓位${POS_RATIO*100}%/笔`);
  log("═".repeat(60));

  let state = loadState();
  if (!DRY) await setLeverage();

  const info = await getContractInfo();
  log(`合约: ${SYMBOL} | 每张=${info.mult} BTC | 最小${info.minSize}张`);

  const startBal = DRY ? CAPITAL : await getBalance();
  if (!state.startBal) { state.startBal = startBal; saveState(state); }
  log(`账户余额: ${startBal.toFixed(2)} USDT | 起始: ${state.startBal.toFixed(2)} USDT`);
  log(`每笔名义: ${(CAPITAL * POS_RATIO * LEVERAGE).toFixed(0)} USDT | 约 ${Math.floor(CAPITAL*POS_RATIO*LEVERAGE / (startBal * info.mult + 0.001))} 张`);
  log("");
  log("⏳ 每 60 秒扫描一次 1h K线...");

  let lastHour = 0;  // 同一小时只触发一次信号

  while (true) {
    try {
      const price   = await getPrice();
      const balance = await getBalance();
      const curHour = Math.floor(Date.now() / 3600000);  // 当前小时数（整数）

      // ── 全局风控 ──────────────────────
      const loss = (state.startBal - balance) / state.startBal;
      if (!DRY && loss > MAX_LOSS_PCT) {
        log(`🚨 风控: 累计亏损 ${fmtPct(loss*100)} 超限，停止运行`);
        break;
      }

      // ── 检查当前持仓 SL/TP ────────────
      const livePos = await getPosition();

      if (livePos && state.pos) {
        const { sl, tp, dir } = state.pos;
        const hitSL = dir === "LONG" ? price <= sl : price >= sl;
        const hitTP = dir === "LONG" ? price >= tp : price <= tp;

        if (hitTP || hitSL) {
          const reason = hitTP ? "止盈✅" : "止损❌";
          const pPct   = dir === "LONG" ? (price-livePos.entry)/livePos.entry*100
                                        : (livePos.entry-price)/livePos.entry*100;
          log(`平仓 ${reason} | ${dir} | 入场:${livePos.entry.toFixed(2)} 现价:${price.toFixed(2)} ${fmtPct(pPct)} | 浮盈:${livePos.upnl.toFixed(2)}U`);
          await closePosition(livePos.size, dir);
          state.pos = null;
          saveState(state);
          await sleep(2000);
          continue;
        }

        // 持仓中 → 打印状态
        const pPct = livePos.dir === "LONG" ? (price-livePos.entry)/livePos.entry*100
                                             : (livePos.entry-price)/livePos.entry*100;
        log(`持仓 ${livePos.dir} | 入场:${livePos.entry.toFixed(2)} 现价:${price.toFixed(2)} ${fmtPct(pPct)} (${livePos.upnl.toFixed(2)}U) | SL:${sl} TP:${tp}`);

      } else if (!livePos && state.pos) {
        // 仓位不见了（爆仓/手动平仓）
        log("⚠️  本地记录有仓位但交易所无持仓，已同步清除");
        state.pos = null;
        saveState(state);
      }

      // ── 无仓位时寻找入场信号 ──────────
      if (!livePos && curHour !== lastHour) {
        lastHour = curHour;

        const raw = await fetchKlines();
        const cs  = indicators(raw).filter(c => c.ef && c.rsi !== null && c.bbUp);
        if (cs.length < 3) { log("K线数量不足，跳过"); continue; }

        const cur  = cs[cs.length - 2];  // 最近已收盘 K 线
        const prev = cs[cs.length - 3];
        const sig  = signal(cur, prev);

        log(`扫描 | ${price.toFixed(2)} USDT | RSI:${cur.rsi.toFixed(1)} EMA9:${cur.ef.toFixed(0)}/21:${cur.es.toFixed(0)}/55:${cur.em.toFixed(0)} | BB上:${cur.bbUp.toFixed(0)} 下:${cur.bbLo.toFixed(0)} | 信号:【${sig}】`);

        if (sig !== "HOLD") {
          const contracts = Math.max(1,
            Math.floor(balance * POS_RATIO * LEVERAGE / (price * info.mult)));
          const sl = +(price * (sig === "LONG" ? 1 - STOP_PCT : 1 + STOP_PCT)).toFixed(2);
          const tp = +(price * (sig === "LONG" ? 1 + TAKE_PCT : 1 - TAKE_PCT)).toFixed(2);
          const notional = +(contracts * price * info.mult * LEVERAGE).toFixed(2);

          log(`开仓 → ${sig} ${contracts}张 (~${notional}U名义) | 入场:${price.toFixed(2)} SL:${sl} TP:${tp}`);
          const order = await placeOrder(sig, contracts);
          log(`下单成功 | 订单ID: ${DRY ? order.id : order.id}`);

          state.pos = { dir: sig, entry: price, sl, tp, contracts, time: Date.now() };
          saveState(state);
        }
      }

    } catch (err) {
      log(`⚠️  错误: ${err.message}`);
    }

    await sleep(60_000);  // 60 秒后再检查
  }

  log("🔴 机器人已停止");
}

main().catch(e => { log("💥 " + e.message); process.exit(1); });
