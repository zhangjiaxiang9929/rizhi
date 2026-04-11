/**
 * Gate.io 熊市纯做空策略 v9
 * 止盈3% | 止损1% | 1h线 | 5x杠杆 | 只做空 | 复利
 * 
 * 做空信号条件（任一满足）：
 *  A. EMA死叉 + RSI高位(>50) + 价格在55EMA下方
 *  B. 布林上轨超买反转
 *  C. 反弹至压力EMA后回落（假反弹做空）
 * 
 * 额外过滤：
 *  - 日线趋势确认（价格在日线EMA20下方才允许做空）
 *  - ATR波动率过滤
 *  - RSI不能超卖（避免在底部做空）
 */

const https = require("https");
const fs    = require("fs");

const CFG = {
  LEVERAGE:       5,
  STOP_PCT:       0.010,   // 止损 1%
  TAKE_PCT:       0.030,   // 止盈 3%
  POSITION_RATIO: 0.30,

  EMA_FAST:  9,
  EMA_SLOW:  21,
  EMA_MID:   55,
  EMA_DAY:   20,           // 日线EMA（趋势确认）

  RSI_PERIOD:   14,
  RSI_MIN:      42,        // 做空时RSI最低值（避免超卖区）
  RSI_MAX:      75,        // 做空时RSI最高值

  ATR_MIN_PCT:  0.003,
  BB_PERIOD:    20,
  BB_STD:       2.0,

  INTERVAL:     "1h",
  INTERVAL_DAY: "1d",
  DAYS:         180,
  COMPOUND:     true,
};

const SYMBOLS       = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
const TOTAL_CAPITAL = 500;
const CAPITAL_PER   = TOTAL_CAPITAL / SYMBOLS.length;
const FEE           = 0.0007;

// ─────────────────────────────────────────────
const get = url => new Promise((r,j) => {
  https.get(url, res => {
    let d=""; res.on("data",c=>d+=c);
    res.on("end",()=>{try{r(JSON.parse(d));}catch(e){j(e);}});
  }).on("error",j);
});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const fmt   = ts => new Date(ts*1000).toISOString().slice(0,16);
const fmtM  = ts => new Date(ts*1000).toISOString().slice(0,7);

// ─────────────────────────────────────────────
// K线获取
// ─────────────────────────────────────────────
async function fetchKlines(symbol, interval, days) {
  const secMap={"1h":3600,"1d":86400};
  const iSec=secMap[interval];
  const end=Math.floor(Date.now()/1000);
  const start=end-days*86400;
  const batch=1200*iSec;
  let all=[], cur=end;
  while(cur>start){
    const s=Math.max(cur-batch,start);
    const url=`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}&from=${s}&to=${cur}&interval=${interval}`;
    try{const d=await get(url);if(!Array.isArray(d)||!d.length)break;all=all.concat(d);cur=s-1;}catch(e){break;}
    await sleep(280);
  }
  return all.map(c=>({time:+c.t,open:+c.o,high:+c.h,low:+c.l,close:+c.c,volume:+c.v}))
    .sort((a,b)=>a.time-b.time).filter((c,i,a)=>i===0||c.time!==a[i-1].time);
}

// ─────────────────────────────────────────────
// 指标
// ─────────────────────────────────────────────
function ema(arr,p){
  const k=2/(p+1),r=Array(arr.length).fill(null);let s=0;
  for(let i=0;i<arr.length;i++){
    if(i<p-1){s+=arr[i];continue;}
    if(i===p-1){s+=arr[i];r[i]=s/p;continue;}
    r[i]=arr[i]*k+r[i-1]*(1-k);
  }
  return r;
}
function calcRSI(cls,p){
  const r=Array(cls.length).fill(null);let ag=0,al=0;
  for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];d>0?ag+=d/p:al+=-d/p;}
  r[p]=al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<cls.length;i++){
    const d=cls[i]-cls[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;
    r[i]=al===0?100:100-100/(1+ag/al);
  }
  return r;
}
function calcATR(cs,p=14){
  const tr=cs.map((c,i)=>i===0?c.high-c.low:Math.max(c.high-c.low,Math.abs(c.high-cs[i-1].close),Math.abs(c.low-cs[i-1].close)));
  const res=Array(cs.length).fill(null);
  for(let i=p-1;i<cs.length;i++)res[i]=tr.slice(i-p+1,i+1).reduce((s,v)=>s+v,0)/p;
  return res;
}
function calcBB(cls,p=20,m=2){
  const mid=ema(cls,p),up=Array(cls.length).fill(null),lo=Array(cls.length).fill(null);
  for(let i=p-1;i<cls.length;i++){
    const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((s,v)=>s+v,0)/p;
    const sd=Math.sqrt(sl.map(v=>(v-mn)**2).reduce((s,v)=>s+v,0)/p);
    up[i]=mid[i]+m*sd;lo[i]=mid[i]-m*sd;
  }
  return{mid,up,lo};
}

function buildInd(cs){
  const cls=cs.map(c=>c.close);
  const ef=ema(cls,CFG.EMA_FAST),es=ema(cls,CFG.EMA_SLOW),em=ema(cls,CFG.EMA_MID);
  const ri=calcRSI(cls,CFG.RSI_PERIOD),at=calcATR(cs,14);
  const bb=calcBB(cls,CFG.BB_PERIOD,CFG.BB_STD);
  return cs.map((c,i)=>({...c,ef:ef[i],es:es[i],em:em[i],rsi:ri[i],atr:at[i],bbUp:bb.up[i],bbLo:bb.lo[i],bbMid:bb.mid[i]}));
}

// 日线EMA（判断宏观趋势）
function buildDayEMA(dayCls) {
  return ema(dayCls, CFG.EMA_DAY);
}

// 按时间戳找对应日线EMA值
function getDayEMA(dayCandles, dayEMAs, ts) {
  let val = null;
  for(let i=0;i<dayCandles.length;i++){
    if(dayCandles[i].time <= ts) val = dayEMAs[i];
    else break;
  }
  return val;
}

// ─────────────────────────────────────────────
// 纯做空信号
// ─────────────────────────────────────────────
function shortSignal(cur, prev, dayEMA) {
  if(!cur.ef||cur.rsi===null||!cur.atr||!cur.bbUp) return false;

  // 宏观趋势：价格在日线EMA20下方（熊市确认）
  if(dayEMA && cur.close > dayEMA * 1.02) return false; // 涨过日线EMA2%以上不做空

  // 波动率过滤
  if(cur.atr/cur.close < CFG.ATR_MIN_PCT) return false;

  // RSI范围：不能超卖（底部不追空）
  if(cur.rsi < CFG.RSI_MIN || cur.rsi > CFG.RSI_MAX) return false;

  const xDown = prev.ef>prev.es && cur.ef<cur.es;      // EMA死叉
  const bbS   = cur.close>=cur.bbUp;                    // 布林上轨
  const pullback = cur.close>cur.em*0.995               // 反弹至55EMA附近
    && cur.close<cur.em*1.015
    && prev.close>prev.em                               // 上根K线在EMA上方
    && cur.close<prev.close;                            // 当根开始回落

  // 信号A：死叉+在55EMA下方
  if(xDown && cur.close < cur.em) return true;
  // 信号B：布林上轨超买
  if(bbS) return true;
  // 信号C：反弹至压力位回落
  if(pullback) return true;

  return false;
}

// ─────────────────────────────────────────────
// 回测
// ─────────────────────────────────────────────
function backtest(cs, dayCandles, dayEMAs, initCap) {
  let cap=initCap,pos=null,maxEq=initCap,maxDD=0,totalFee=0;
  const trades=[],equity=[{time:cs[0].time,v:cap}];
  let longSkipped=0, lowRsiSkipped=0;

  for(let i=1;i<cs.length;i++){
    const cur=cs[i],prev=cs[i-1];
    const dEMA=getDayEMA(dayCandles,dayEMAs,cur.time);

    if(pos){
      const hitSL=cur.high>=pos.sl;
      const hitTP=cur.low<=pos.tp;
      if(hitSL||hitTP){
        const exit=hitSL?pos.sl:pos.tp;
        const pPct=(pos.entry-exit)/pos.entry;
        const fee=pos.size*FEE*CFG.LEVERAGE;
        const pnl=pPct*pos.size*CFG.LEVERAGE-fee;
        totalFee+=fee;cap=Math.max(cap+pnl,0);
        trades.push({
          entryTime:fmt(pos.t),exitTime:fmt(cur.time),
          dir:"SHORT",entry:pos.entry,exit,size:pos.size,
          pnl:+pnl.toFixed(4),win:pnl>0,
          reason:hitTP?"止盈":"止损",
          holdBars:i-pos.si,capAfter:+cap.toFixed(2),
          month:fmtM(cur.time),
          rsiAtEntry:pos.rsi,
        });
        if(cap>maxEq)maxEq=cap;
        const dd=(maxEq-cap)/maxEq*100;
        if(dd>maxDD)maxDD=dd;
        pos=null;
        if(cap<initCap*0.3){console.log("  ⛔ 熔断");break;}
      }
    }

    if(!pos){
      // 统计被过滤的信号
      if(cur.rsi!==null&&cur.rsi<CFG.RSI_MIN) lowRsiSkipped++;
      
      if(shortSignal(cur,prev,dEMA)){
        const size=+(cap*CFG.POSITION_RATIO).toFixed(2);
        const sl=+(cur.close*(1+CFG.STOP_PCT)).toFixed(4);
        const tp=+(cur.close*(1-CFG.TAKE_PCT)).toFixed(4);
        pos={entry:cur.close,sl,tp,size,t:cur.time,si:i,rsi:cur.rsi};
      }
    }
    equity.push({time:cur.time,v:+cap.toFixed(2)});
  }
  return{trades,equity,maxDD:+maxDD.toFixed(2),finalCap:+cap.toFixed(2),totalFee:+totalFee.toFixed(2),lowRsiSkipped};
}

// ─────────────────────────────────────────────
// 统计
// ─────────────────────────────────────────────
function calcStats(trades,equity,maxDD,sym,initCap,totalFee){
  const wins=trades.filter(t=>t.win),losses=trades.filter(t=>!t.win);
  const wPnl=wins.reduce((s,t)=>s+t.pnl,0),lPnl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const tPnl=trades.reduce((s,t)=>s+t.pnl,0);
  const final=equity[equity.length-1].v,roi=(final-initCap)/initCap*100;
  const pf=lPnl>0?wPnl/lPnl:wPnl>0?999:0;
  const monthly={};
  trades.forEach(t=>{
    if(!monthly[t.month])monthly[t.month]={pnl:0,win:0,loss:0};
    monthly[t.month].pnl+=t.pnl;t.win?monthly[t.month].win++:monthly[t.month].loss++;
  });
  let mxW=0,mxL=0,cw=0,cl=0;
  trades.forEach(t=>{t.win?(cw++,cl=0,mxW=Math.max(mxW,cw)):(cl++,cw=0,mxL=Math.max(mxL,cl));});
  const avgHold=trades.length?+(trades.reduce((s,t)=>s+t.holdBars,0)/trades.length).toFixed(1):0;
  const days=new Set(trades.map(t=>t.entryTime.slice(0,10))).size||1;
  const pnls=trades.map(t=>t.pnl);
  const mean=pnls.length?pnls.reduce((s,v)=>s+v,0)/pnls.length:0;
  const std=pnls.length>1?Math.sqrt(pnls.map(v=>(v-mean)**2).reduce((s,v)=>s+v,0)/pnls.length):1;
  const sharpe=std>0?(mean/std)*Math.sqrt(24*180):0;
  return{
    sym,total:trades.length,winCount:wins.length,lossCount:losses.length,
    winRate:trades.length?+(wins.length/trades.length*100).toFixed(1):0,
    avgWin:wins.length?+(wPnl/wins.length).toFixed(2):0,
    avgLoss:losses.length?+(lPnl/losses.length).toFixed(2):0,
    profitFactor:+pf.toFixed(2),maxDD,sharpe:+sharpe.toFixed(2),
    finalCap:final,roi:+roi.toFixed(2),tPnl:+tPnl.toFixed(2),
    initCap,totalFee,monthly,mxW,mxL,avgHold,
    avgPerDay:+(trades.length/days).toFixed(1),
  };
}

// ─────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────
function printReport(allSt,allTr){
  const S="═".repeat(72),D="─".repeat(72);

  // 数学验证
  const sz=CAPITAL_PER*CFG.POSITION_RATIO;
  const winU=+(sz*CFG.LEVERAGE*CFG.TAKE_PCT).toFixed(2);
  const lossU=+(sz*CFG.LEVERAGE*CFG.STOP_PCT).toFixed(2);
  const feeU=+(sz*CFG.LEVERAGE*FEE*2).toFixed(2);
  const minWR=+((lossU+feeU)/(winU+lossU)*100).toFixed(1);

  console.log("\n"+S);
  console.log("  📐 数学基础");
  console.log(D);
  console.log(`  止盈: +${winU}U  止损: -${lossU}U  手续费: ${feeU}U/笔`);
  console.log(`  最低盈利胜率: >${minWR}%`);
  console.log(S);

  console.log("\n"+S);
  console.log("  📊 熊市纯做空策略 v9 — 回测报告（1h / 5x / 止盈3% / 止损1%）");
  console.log(S);
  console.log("  币种      ROI         盈亏(U)   交易  胜率    盈亏比  回撤    频/天  夏普");
  console.log(D);

  for(const r of allSt){
    const e=r.roi>=0?"🟢":"🔴";
    console.log(
      `  ${e} ${r.sym.replace("_USDT","").padEnd(6)}`+
      ((r.roi>=0?"+":"")+r.roi+"%").padEnd(12)+
      ((r.tPnl>=0?"+":"")+r.tPnl+"U").padEnd(11)+
      String(r.total).padEnd(6)+(r.winRate+"%").padEnd(8)+
      String(r.profitFactor===999?"∞":r.profitFactor).padEnd(8)+
      (r.maxDD+"%").padEnd(8)+String(r.avgPerDay).padEnd(7)+r.sharpe
    );
  }
  console.log(D);

  const ti=allSt.reduce((s,r)=>s+r.initCap,0);
  const tf=allSt.reduce((s,r)=>s+r.finalCap,0);
  const tp=allSt.reduce((s,r)=>s+r.tPnl,0);
  const fee=allSt.reduce((s,r)=>s+r.totalFee,0);
  const troi=(tf-ti)/ti*100;
  const tt=allSt.reduce((s,r)=>s+r.total,0);
  const tw=allSt.reduce((s,r)=>s+r.winCount,0);
  const wr=tt?(tw/tt*100).toFixed(1):"0";
  const wdd=Math.max(...allSt.map(r=>r.maxDD));

  console.log(
    "  【合计】  "+((troi>=0?"+":"")+troi.toFixed(2)+"%").padEnd(12)+
    ((tp>=0?"+":"")+tp.toFixed(2)+"U").padEnd(11)+String(tt).padEnd(6)+(wr+"%")
  );
  console.log(S);
  console.log(`  初始: ${ti.toFixed(0)}U → 最终: ${tf.toFixed(2)}U`);
  console.log(`  综合ROI: ${troi>=0?"+":""}${troi.toFixed(2)}%  胜率: ${wr}%  最大回撤: ${wdd}%`);
  console.log(`  总手续费: ${fee.toFixed(2)}U`);

  // 全版本对比
  console.log("\n"+S);
  console.log("  📈 全版本对比（BTC+ETH+SOL 500U 180天）");
  console.log(D);
  console.log("  版本               方向    ROI        胜率    手续费  最大回撤");
  console.log(D);
  console.log("  v6 15m 止盈0.3%   双向    -69.6%     65.4%   317U    74.3%");
  console.log("  v7 15m 止盈1.5%   双向    -43.5%     34.6%   184U    63.1%");
  console.log("  v8 1h  止盈3.0%   双向    -55.8%     22.3%    97U    71.5%");
  console.log(`  v9 1h  止盈3.0%   纯做空  ${((troi>=0?"+":"")+troi.toFixed(1)+"%").padEnd(11)} ${wr.padEnd(7)} ${fee.toFixed(0).padEnd(7)}U  ${wdd}%  ← 本次`);
  console.log(S);

  // 月度明细
  console.log("\n  📅 月度盈亏：");
  for(const r of allSt){
    const months=Object.entries(r.monthly).sort();
    const maxA=Math.max(...months.map(([,v])=>Math.abs(v.pnl)),1);
    console.log(`\n  ${r.sym.replace("_USDT","")}  (连胜${r.mxW}次 连亏${r.mxL}次  均持仓${r.avgHold}根≈${r.avgHold}h)`);
    let totalWin=0,totalLoss=0;
    for(const [m,v] of months){
      const p=((v.pnl>=0?"+":"")+v.pnl.toFixed(2)).padStart(9);
      const len=Math.round(Math.abs(v.pnl)/maxA*26);
      const bar=v.pnl>=0?"█".repeat(len):"░".repeat(len);
      const mwr=v.win+v.loss?(v.win/(v.win+v.loss)*100).toFixed(0):"0";
      const flag=v.pnl>=0?"✅":"❌";
      console.log(`    ${m}  ${p}U  胜${mwr.padStart(3)}%  ${String(v.win).padStart(2)}盈${String(v.loss).padStart(2)}亏  ${flag}  ${bar}`);
      if(v.pnl>0)totalWin++;else totalLoss++;
    }
    console.log(`    盈利月份: ${totalWin}个  亏损月份: ${totalLoss}个`);
  }

  // 复利推算
  const monthROI=troi/6;
  console.log("\n"+S);
  if(monthROI>0){
    console.log(`  💰 复利推算（月均+${monthROI.toFixed(2)}%，500U起步）：`);
    console.log(D);
    console.log("  月数    资金        盈利        ROI");
    console.log(D);
    for(const m of [1,3,6,12,18,24,36]){
      const cap=500*Math.pow(1+monthROI/100,m);
      const profit=cap-500;
      const roi=(profit/500*100).toFixed(1);
      const bar="█".repeat(Math.min(20,Math.round(profit/500*10)));
      console.log(`   ${String(m).padEnd(6)}  ${cap.toFixed(2).padStart(10)}U  +${profit.toFixed(2).padStart(9)}U  +${roi}%  ${bar}`);
    }
  } else {
    console.log(`  ⚠️  月均亏损 ${monthROI.toFixed(2)}%`);
  }
  console.log(S);

  // 详细交易记录
  console.log("\n  📋 各币种完整交易记录：");
  for(const{sym,trades}of allTr){
    if(!trades.length){console.log(`\n  ${sym}: 无触发信号`);continue;}
    const st=allSt.find(r=>r.sym===sym);
    console.log(`\n  ── ${sym}  共${trades.length}笔  胜率${st.winRate}%  ROI${st.roi>=0?"+":""}${st.roi}% ──`);
    console.log("  入场时间         入场价        出场价        盈亏(U)    RSI   K线  余额       结果");
    console.log("  "+"─".repeat(80));
    for(const t of trades){
      console.log("  "+
        t.entryTime.padEnd(18)+
        String(t.entry).padEnd(14)+
        String(t.exit).padEnd(14)+
        ((t.pnl>=0?"+":"")+t.pnl).toString().padEnd(11)+
        String(t.rsiAtEntry||"-").padEnd(6)+
        String(t.holdBars).padEnd(5)+
        (t.capAfter+"U").padEnd(12)+
        (t.win?"✅ "+t.reason:"❌ "+t.reason)
      );
    }
  }
}

// ─────────────────────────────────────────────
// 主
// ─────────────────────────────────────────────
async function main(){
  console.log("═".repeat(65));
  console.log("   Gate.io 熊市纯做空策略 v9");
  console.log("   只做空 | 止盈3% | 止损1% | 1h线 | 5x杠杆 | 复利");
  console.log("   日线EMA趋势确认 + RSI超卖保护 + 布林带信号");
  console.log("═".repeat(65));

  const allSt=[],allTr=[];

  for(const sym of SYMBOLS){
    process.stdout.write(`\n  [${SYMBOLS.indexOf(sym)+1}/3] ${sym} ...`);

    const [raw1h, rawDay] = await Promise.all([
      fetchKlines(sym,"1h",CFG.DAYS),
      fetchKlines(sym,"1d",CFG.DAYS+30),
    ]);
    process.stdout.write(` 1h:${raw1h.length}根 日线:${rawDay.length}根`);

    const cs=buildInd(raw1h).filter(c=>c.ef&&c.rsi!==null&&c.bbUp);
    const dayCls=rawDay.map(c=>c.close);
    const dayEMAs=buildDayEMA(dayCls);

    const{trades,equity,maxDD,totalFee,lowRsiSkipped}=backtest(cs,rawDay,dayEMAs,CAPITAL_PER);
    const st=calcStats(trades,equity,maxDD,sym,CAPITAL_PER,totalFee);
    process.stdout.write(` → ${trades.length}笔  胜率${st.winRate}%  ROI${st.roi>=0?"+":""}${st.roi}%\n`);

    allSt.push(st);allTr.push({sym,trades});
  }

  printReport(allSt,allTr);

  const dir="/home/node/.openclaw/workspace/gate_strategy";
  fs.writeFileSync(`${dir}/backtest_v9_summary.json`,
    JSON.stringify({version:"v9-bear-short-only",cfg:CFG,results:allSt},null,2));
  for(const{sym,trades}of allTr){
    if(!trades.length)continue;
    const csv="entryTime,exitTime,entry,exit,size,pnl,win,reason,holdBars,capAfter,rsiAtEntry\n"+
      trades.map(t=>`${t.entryTime},${t.exitTime},${t.entry},${t.exit},${t.size},${t.pnl},${t.win},${t.reason},${t.holdBars},${t.capAfter},${t.rsiAtEntry||""}`).join("\n");
    fs.writeFileSync(`${dir}/trades_v9_${sym}.csv`,csv);
  }
  console.log(`\n📁 已保存: ${dir}/backtest_v9_summary.json`);
}

main().catch(e=>{console.error("❌",e.message,"\n",e.stack);process.exit(1);});
