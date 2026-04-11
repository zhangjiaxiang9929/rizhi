/**
 * Gate.io 趋势跟踪策略 v5 — 顺势做空为主
 * 
 * 问题根因分析：
 * - 过去180天BTC整体下跌40%（115861→69527）
 * - 6个月连续下跌，EMA交叉多为假反弹信号
 * - 解决方案：
 *   1. 加入市场状态判断（牛市/熊市/震荡）
 *   2. 熊市只做空，牛市只做多，震荡不开仓
 *   3. 用多重时间框架确认（日线定方向+4h找入场）
 *   4. 跌破关键支撑位追空（动量策略）
 *   5. 止损收窄 + 止盈放大（1:4盈亏比）
 */

const https = require("https");
const fs = require("fs");

// ============================================================
// 配置
// ============================================================
const CFG = {
  LEVERAGE: 5,
  STOP_PCT: 0.012,       // 1.2% 止损
  REWARD_RATIO: 4,       // 1:4 盈亏比（止盈4.8%）
  POSITION_RATIO: 0.15,  // 每次15%仓位（更保守）
  EMA_FAST: 9, EMA_SLOW: 21, EMA_TREND: 50,
  EMA_DAY: 20,           // 日线20EMA判断趋势
  RSI_BEAR_SHORT: [40, 65],  // 熊市做空RSI范围
  RSI_BULL_LONG:  [35, 60],  // 牛市做多RSI范围
  ADX_MIN: 20,
  VOL_MULT: 1.0,         // 放宽量能要求
  INTERVAL_MAIN: "4h",
  INTERVAL_TREND: "1d",
  DAYS: 180,
};

const SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "DOGE_USDT", "XRP_USDT"];
const TOTAL_CAPITAL = 500;
const CAPITAL_PER = TOTAL_CAPITAL / SYMBOLS.length;
const TAKER_FEE = 0.0005, MAKER_FEE = 0.0002;

// ============================================================
// 工具
// ============================================================
const get = (url) => new Promise((r, j) => {
  https.get(url, (res) => {
    let d = ""; res.on("data", c => d += c);
    res.on("end", () => { try { r(JSON.parse(d)); } catch(e){ j(e); }});
  }).on("error", j);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = ts => new Date(ts * 1000).toISOString().slice(0, 16);

// ============================================================
// 获取K线
// ============================================================
async function fetchKlines(symbol, interval, days) {
  const secMap = {"15m":900,"1h":3600,"4h":14400,"1d":86400};
  const intervalSec = secMap[interval];
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;
  const batchSec = 1200 * intervalSec;
  let all = [], curEnd = endTime;
  while (curEnd > startTime) {
    const curStart = Math.max(curEnd - batchSec, startTime);
    const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}&from=${curStart}&to=${curEnd}&interval=${interval}`;
    try {
      const data = await get(url);
      if (!Array.isArray(data) || !data.length) break;
      all = all.concat(data); curEnd = curStart - 1;
    } catch(e) { break; }
    await sleep(300);
  }
  return all.map(c=>({time:+c.t,open:+c.o,high:+c.h,low:+c.l,close:+c.c,volume:+c.v}))
    .sort((a,b)=>a.time-b.time)
    .filter((c,i,arr)=>i===0||c.time!==arr[i-1].time);
}

// ============================================================
// 指标
// ============================================================
function calcEMA(arr, p) {
  const k=2/(p+1), r=Array(arr.length).fill(null); let s=0;
  for(let i=0;i<arr.length;i++){
    if(i<p-1){s+=arr[i];continue;}
    if(i===p-1){s+=arr[i];r[i]=s/p;continue;}
    r[i]=arr[i]*k+r[i-1]*(1-k);
  }
  return r;
}
function calcRSI(closes, p=14) {
  const r=Array(closes.length).fill(null); let ag=0,al=0;
  for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];d>0?ag+=d/p:al+=-d/p;}
  r[p]=al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?-d:0))/p;
    r[i]=al===0?100:100-100/(1+ag/al);
  }
  return r;
}
function calcATR(candles, p=14) {
  const tr=candles.map((c,i)=>i===0?c.high-c.low:Math.max(c.high-c.low,Math.abs(c.high-candles[i-1].close),Math.abs(c.low-candles[i-1].close)));
  const atr=Array(candles.length).fill(null);
  for(let i=p-1;i<candles.length;i++) atr[i]=tr.slice(i-p+1,i+1).reduce((s,v)=>s+v,0)/p;
  return atr;
}
function calcADX(candles, p=14) {
  const atr=calcATR(candles,p), adx=Array(candles.length).fill(null);
  for(let i=p*2;i<candles.length;i++){
    const range=Math.abs(candles[i].close-candles[i-p].close);
    adx[i]=atr[i]>0?(range/(atr[i]*p))*100:0;
  }
  return adx;
}

// ============================================================
// 核心：市场状态判断（日线级别）
// ============================================================
function buildDailyTrend(dailyCandles) {
  // 每根日线K线标记市场状态
  const closes = dailyCandles.map(c=>c.close);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const rsi14  = calcRSI(closes, 14);

  return dailyCandles.map((c,i) => {
    if(!ema20[i] || !ema50[i] || !rsi14[i]) return {...c, trend: "UNKNOWN"};
    
    const priceAboveEma20 = c.close > ema20[i];
    const priceAboveEma50 = c.close > ema50[i];
    const ema20AboveEma50 = ema20[i] > ema50[i];
    
    // 连续下跌判断（最近5根日线收盘价均在EMA20以下）
    let bearCount = 0, bullCount = 0;
    for(let j=Math.max(0,i-4);j<=i;j++){
      if(closes[j] < ema20[j||0]) bearCount++;
      else bullCount++;
    }
    
    let trend;
    if(!priceAboveEma50 && !priceAboveEma20 && bearCount>=4) trend="BEAR";       // 熊市
    else if(priceAboveEma50 && priceAboveEma20 && bullCount>=4) trend="BULL";    // 牛市
    else trend="RANGE";                                                            // 震荡
    
    return {...c, trend, ema20: ema20[i], ema50: ema50[i], rsi: rsi14[i]};
  });
}

// 根据时间戳找对应的日线状态
function getDailyTrend(dailyTrend, timestamp) {
  // 找到该时间戳对应的日线（当天开盘前的最近一根日线）
  let last = "UNKNOWN";
  for(const d of dailyTrend) {
    if(d.time <= timestamp) last = d.trend;
    else break;
  }
  return last;
}

// ============================================================
// 4小时指标计算
// ============================================================
function build4h(candles) {
  const closes=candles.map(c=>c.close), vols=candles.map(c=>c.volume);
  const ef=calcEMA(closes,CFG.EMA_FAST), es=calcEMA(closes,CFG.EMA_SLOW);
  const et=calcEMA(closes,CFG.EMA_TREND);
  const ri=calcRSI(closes,14), ad=calcADX(candles,14);
  const vm=calcEMA(vols,20);
  // 布林带（用于判断超卖超买）
  const bb20=calcEMA(closes,20);
  const bbStd=Array(closes.length).fill(null);
  for(let i=19;i<closes.length;i++){
    const slice=closes.slice(i-19,i+1);
    const mean=slice.reduce((s,v)=>s+v,0)/20;
    bbStd[i]=Math.sqrt(slice.map(v=>(v-mean)**2).reduce((s,v)=>s+v,0)/20);
  }
  const bbUpper=bb20.map((v,i)=>v&&bbStd[i]?v+2*bbStd[i]:null);
  const bbLower=bb20.map((v,i)=>v&&bbStd[i]?v-2*bbStd[i]:null);

  return candles.map((c,i)=>({
    ...c, emaFast:ef[i], emaSlow:es[i], emaTrend:et[i],
    rsi:ri[i], adx:ad[i], volMA:vm[i],
    bbUpper:bbUpper[i], bbLower:bbLower[i], bbMid:bb20[i],
  }));
}

// ============================================================
// 信号逻辑（趋势感知版）
// ============================================================
function getSignal(cur, prev, marketTrend) {
  if(!cur.emaFast||!cur.emaTrend||cur.rsi===null) return "HOLD";

  const crossUp   = prev.emaFast<prev.emaSlow && cur.emaFast>cur.emaSlow;
  const crossDown = prev.emaFast>prev.emaSlow && cur.emaFast<cur.emaSlow;

  // ADX过滤（趋势强度）
  if(cur.adx!==null && cur.adx<CFG.ADX_MIN) return "HOLD";
  // 量能过滤
  if(cur.volMA && cur.volume<cur.volMA*CFG.VOL_MULT) return "HOLD";

  const [rsiShortLow, rsiShortHigh] = CFG.RSI_BEAR_SHORT;
  const [rsiLongLow,  rsiLongHigh]  = CFG.RSI_BULL_LONG;

  if(marketTrend === "BEAR") {
    // 熊市：只做空
    // 条件：EMA交叉向下 + 价格在50EMA下方 + RSI未超卖
    if(crossDown && cur.close<cur.emaTrend && cur.rsi>rsiShortLow && cur.rsi<rsiShortHigh)
      return "SHORT";
    // 额外：价格触碰布林上轨后回落（反弹做空机会）
    if(!crossDown && cur.bbUpper && prev.high>=prev.bbUpper && cur.close<cur.bbMid
       && cur.close<cur.emaTrend && cur.rsi>rsiShortLow && cur.rsi<rsiShortHigh)
      return "SHORT";
  } else if(marketTrend === "BULL") {
    // 牛市：只做多
    if(crossUp && cur.close>cur.emaTrend && cur.rsi>rsiLongLow && cur.rsi<rsiLongHigh)
      return "LONG";
  }
  // 震荡市：不开仓
  return "HOLD";
}

// ============================================================
// 回测引擎
// ============================================================
function backtest(candles4h, dailyTrend, initCap, symbol) {
  let cap=initCap, pos=null, maxEq=initCap, maxDD=0;
  const trades=[], equity=[{time:candles4h[0].time,v:cap}];
  const trendLog={BEAR:0,BULL:0,RANGE:0,UNKNOWN:0};

  for(let i=1;i<candles4h.length;i++){
    const cur=candles4h[i], prev=candles4h[i-1];
    const mTrend=getDailyTrend(dailyTrend, cur.time);
    trendLog[mTrend]=(trendLog[mTrend]||0)+1;

    if(pos){
      const hitSL=pos.dir==="LONG"?cur.low<=pos.sl:cur.high>=pos.sl;
      const hitTP=pos.dir==="LONG"?cur.high>=pos.tp:cur.low<=pos.tp;
      if(hitSL||hitTP){
        const exit=hitSL?pos.sl:pos.tp;
        const pnlPct=pos.dir==="LONG"?(exit-pos.entry)/pos.entry:(pos.entry-exit)/pos.entry;
        const fee=pos.size*(TAKER_FEE+MAKER_FEE)*CFG.LEVERAGE;
        const pnl=pnlPct*pos.size*CFG.LEVERAGE-fee;
        cap=Math.max(cap+pnl,0);
        trades.push({
          sym:symbol, entryTime:fmt(pos.t), exitTime:fmt(cur.time),
          dir:pos.dir, entry:pos.entry, exit, size:pos.size,
          pnl:+pnl.toFixed(4), win:pnl>0,
          reason:hitTP?"止盈":"止损",
          marketTrend:mTrend,
          holdBars:i-pos.startIdx,
        });
        if(cap>maxEq) maxEq=cap;
        const dd=(maxEq-cap)/maxEq*100;
        if(dd>maxDD) maxDD=dd;
        pos=null;
        if(cap<initCap*0.3) break;
      }
    }

    if(!pos){
      const sig=getSignal(cur,prev,mTrend);
      if(sig!=="HOLD"){
        const size=+(cap*CFG.POSITION_RATIO).toFixed(2);
        const takePct=CFG.STOP_PCT*CFG.REWARD_RATIO;
        const sl=sig==="LONG"
          ?+(cur.close*(1-CFG.STOP_PCT)).toFixed(4)
          :+(cur.close*(1+CFG.STOP_PCT)).toFixed(4);
        const tp=sig==="LONG"
          ?+(cur.close*(1+takePct)).toFixed(4)
          :+(cur.close*(1-takePct)).toFixed(4);
        pos={dir:sig,entry:cur.close,sl,tp,size,t:cur.time,startIdx:i};
      }
    }
    equity.push({time:cur.time,v:+cap.toFixed(2)});
  }
  return {trades,equity,maxDD:+maxDD.toFixed(2),finalCap:+cap.toFixed(2),trendLog};
}

// ============================================================
// 统计
// ============================================================
function calcStats(trades,equity,maxDD,symbol,initCap,trendLog){
  const wins=trades.filter(t=>t.win), losses=trades.filter(t=>!t.win);
  const winPnl=wins.reduce((s,t)=>s+t.pnl,0);
  const lossPnl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const totalPnl=trades.reduce((s,t)=>s+t.pnl,0);
  const final=equity[equity.length-1].v;
  const roi=(final-initCap)/initCap*100;
  const pf=lossPnl>0?winPnl/lossPnl:winPnl>0?999:0;
  const pnls=trades.map(t=>t.pnl);
  const mean=pnls.length?pnls.reduce((s,v)=>s+v,0)/pnls.length:0;
  const std=pnls.length>1?Math.sqrt(pnls.map(v=>(v-mean)**2).reduce((s,v)=>s+v,0)/pnls.length):1;
  const sharpe=std>0?(mean/std)*Math.sqrt(365*6):0;
  return {
    symbol, total:trades.length, winCount:wins.length, lossCount:losses.length,
    winRate:trades.length?+(wins.length/trades.length*100).toFixed(1):0,
    avgWin:wins.length?+(winPnl/wins.length).toFixed(2):0,
    avgLoss:losses.length?+(lossPnl/losses.length).toFixed(2):0,
    profitFactor:+pf.toFixed(2), maxDD,
    sharpe:+sharpe.toFixed(2), finalCap:final,
    roi:+roi.toFixed(2), totalPnl:+totalPnl.toFixed(2),
    initCap, trendLog,
  };
}

// ============================================================
// 输出
// ============================================================
function printReport(allStats, allTrades) {
  const sep="═".repeat(82);
  console.log("\n"+sep);
  console.log("   📊 趋势感知策略 v5 — 回测报告（5币种 / 4h / 5x）");
  console.log(sep);
  console.log(
    "  币种        ".padEnd(14)+"收益率    ".padEnd(11)+"盈亏(U) ".padEnd(10)+
    "交易 ".padEnd(7)+"胜率   ".padEnd(9)+"盈亏比 ".padEnd(9)+"回撤   ".padEnd(9)+"夏普"
  );
  console.log("─".repeat(82));

  for(const r of allStats){
    const roi=(r.roi>=0?"+":"")+r.roi+"%";
    const pnl=(r.totalPnl>=0?"+":"")+r.totalPnl+"U";
    const pf=r.profitFactor===999?"∞":String(r.profitFactor);
    const bar="█".repeat(Math.min(18,Math.round(Math.max(0,r.roi)/2)));
    const emj=r.roi>=0?"🟢":"🔴";
    console.log(
      `  ${emj} ${r.symbol.replace("_USDT","").padEnd(8)}`.padEnd(16)+
      roi.padEnd(11)+pnl.padEnd(10)+
      String(r.total).padEnd(7)+(r.winRate+"%").padEnd(9)+
      pf.padEnd(9)+(r.maxDD+"%").padEnd(9)+r.sharpe
    );
  }
  console.log("─".repeat(82));

  const ti=allStats.reduce((s,r)=>s+r.initCap,0);
  const tf=allStats.reduce((s,r)=>s+r.finalCap,0);
  const tp=allStats.reduce((s,r)=>s+r.totalPnl,0);
  const troi=(tf-ti)/ti*100;
  const tt=allStats.reduce((s,r)=>s+r.total,0);
  const tw=allStats.reduce((s,r)=>s+r.winCount,0);
  const wr=tt?(tw/tt*100).toFixed(1):"0";
  const wdd=Math.max(...allStats.map(r=>r.maxDD));

  console.log(
    "  【合计】       ".padEnd(16)+
    ((troi>=0?"+":"")+troi.toFixed(2)+"%").padEnd(11)+
    ((tp>=0?"+":"")+tp.toFixed(2)+"U").padEnd(10)+
    String(tt).padEnd(7)+(wr+"%").padEnd(9)
  );
  console.log(sep);
  console.log(`  总资金: ${ti.toFixed(0)}U → ${tf.toFixed(2)}U  |  ROI: ${troi>=0?"+":""}${troi.toFixed(2)}%`);
  console.log(`  综合胜率: ${wr}%  |  最大单币回撤: ${wdd}%`);

  // 排行
  console.log("\n  🏆 收益排行：");
  [...allStats].sort((a,b)=>b.roi-a.roi).forEach((r,i)=>{
    const m=["🥇","🥈","🥉"][i]||(` ${i+1}.`);
    console.log(`  ${m} ${r.roi>=0?"🟢":"🔴"} ${r.symbol.replace("_USDT","").padEnd(6)} ${(r.roi>=0?"+":"")+r.roi}%  (${r.total}笔, 胜率${r.winRate}%)`);
  });

  // 市场状态占比（以BTC为代表）
  const btcStat = allStats.find(r=>r.symbol==="BTC_USDT");
  if(btcStat && btcStat.trendLog){
    const tl=btcStat.trendLog;
    const total=Object.values(tl).reduce((s,v)=>s+v,0)||1;
    console.log("\n  📅 BTC市场状态分布（4h K线）：");
    console.log(`    熊市(BEAR):  ${tl.BEAR||0}根 (${((tl.BEAR||0)/total*100).toFixed(1)}%)  → 只做空`);
    console.log(`    牛市(BULL):  ${tl.BULL||0}根 (${((tl.BULL||0)/total*100).toFixed(1)}%)  → 只做多`);
    console.log(`    震荡(RANGE): ${tl.RANGE||0}根 (${((tl.RANGE||0)/total*100).toFixed(1)}%) → 不开仓`);
  }

  console.log("\n  📋 详细交易记录：");
  for(const {sym,trades} of allTrades){
    if(!trades.length){console.log(`\n  ${sym}: 无触发信号`);continue;}
    console.log(`\n  ── ${sym} (${trades.length}笔) ──`);
    console.log("  入场时间         方向  入场价        出场价        盈亏(U)   市场状态  结果");
    console.log("  "+"─".repeat(78));
    for(const t of trades){
      const p=((t.pnl>=0?"+":"")+t.pnl).padEnd(10);
      console.log("  "+
        t.entryTime.padEnd(18)+t.dir.padEnd(6)+
        String(t.entry).padEnd(14)+String(t.exit).padEnd(14)+
        p+(t.marketTrend||"").padEnd(10)+
        (t.win?"✅":"❌")+` ${t.reason}`
      );
    }
  }
  console.log("\n"+sep);
}

// ============================================================
// 主函数
// ============================================================
async function main(){
  console.log("═".repeat(65));
  console.log("   Gate.io 趋势感知策略 v5");
  console.log("   策略升级：日线判断牛熊 + 4h找入场 + 顺势交易");
  console.log(`   止损1.2% | 盈亏比1:4 | 5x杠杆 | 15%仓位`);
  console.log("═".repeat(65));

  const allStats=[], allTrades=[];

  for(const sym of SYMBOLS){
    process.stdout.write(`\n  [${SYMBOLS.indexOf(sym)+1}/${SYMBOLS.length}] ${sym} ...`);

    // 获取日线（趋势判断）
    const daily=await fetchKlines(sym, CFG.INTERVAL_TREND, CFG.DAYS+30);
    const dailyTrend=buildDailyTrend(daily);
    process.stdout.write(" 日线✓");

    // 获取4小时线（信号）
    const raw4h=await fetchKlines(sym, CFG.INTERVAL_MAIN, CFG.DAYS);
    const candles=build4h(raw4h).filter(c=>c.emaFast&&c.emaTrend&&c.rsi!==null);
    process.stdout.write(` 4h✓(${candles.length}根)`);

    const {trades,equity,maxDD,trendLog}=backtest(candles,dailyTrend,CAPITAL_PER,sym);
    const st=calcStats(trades,equity,maxDD,sym,CAPITAL_PER,trendLog);
    console.log(` | ${trades.length}笔 ROI:${st.roi>=0?"+":""}${st.roi}%`);

    allStats.push(st); allTrades.push({sym,trades});
  }

  printReport(allStats, allTrades);

  // 保存
  const dir="/home/node/.openclaw/workspace/gate_strategy";
  const summary={version:"v5-trend-aware",strategy:CFG,symbols:SYMBOLS,
    results:allStats,generatedAt:new Date().toISOString()};
  fs.writeFileSync(`${dir}/backtest_v5_summary.json`,JSON.stringify(summary,null,2));
  for(const {sym,trades} of allTrades){
    if(!trades.length) continue;
    const csv="entryTime,exitTime,dir,entry,exit,size,pnl,win,reason,marketTrend,holdBars\n"+
      trades.map(t=>`${t.entryTime},${t.exitTime},${t.dir},${t.entry},${t.exit},${t.size},${t.pnl},${t.win},${t.reason},${t.marketTrend},${t.holdBars}`).join("\n");
    fs.writeFileSync(`${dir}/trades_v5_${sym}.csv`,csv);
  }
  console.log(`\n📁 已保存: ${dir}/backtest_v5_summary.json`);
}

main().catch(e=>{console.error("❌",e.message);process.exit(1);});
