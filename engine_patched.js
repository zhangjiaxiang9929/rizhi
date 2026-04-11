"use strict";
const https = require("https");
const crypto = require("crypto");

class TradingEngine {
constructor(config, emit) {
this.cfg = config;
this.emit = emit;
this.pos = null;
this.timer = null;
this.running = false;
this.lastSlot = 0;
this.cooldownUntilSlot = 0;
this.startBal = null;
this.contractInfo = null;
this._connOk = true;

// 风控状态
this.dailyTrades = 0;           // 今日开仓次数
this.lastTradeDate = null;      // 上次开仓日期 (YYYY-MM-DD)
this.consecutiveLosses = 0;     // 连续亏损次数
}

async start() {
this.running = true;

// 检查是否需要重置每日计数
const today = new Date(Date.now()+8*3600*1000).toISOString().slice(0,10);
if (this.lastTradeDate !== today) {
this.dailyTrades = 0;
this.lastTradeDate = today;
}

this.log("info", `机器人启动 | ${this.cfg.dryRun ? "【模拟模式】" : "【真实交易】"}`);
this.log("info", `止盈${this.cfg.takePct}% 止损${this.cfg.stopPct}% ${this.cfg.leverage}x 仓位${this.cfg.posRatio}%`);
if (this.cfg.maxTradesPerDay) this.log("info", `每日限开仓 ${this.cfg.maxTradesPerDay} 次`);
if (this.cfg.reduceAfterLosses) this.log("info", `连亏${this.cfg.reduceAfterLosses}次后仓位减半`);
try {
if (!this.cfg.dryRun) { await this.setLeverage(); this.log("info", `杠杆已设置: ${this.cfg.leverage}x`); }
this.contractInfo = await this.getContractInfo();
this.log("info", `合约: BTC_USDT | 每张=${this.contractInfo.mult} BTC`);
this.startBal = this.cfg.dryRun ? this.cfg.capital : await this.getBalance();
this.emit("balance", { balance: this.startBal, start: this.startBal });
this.log("info", `账户余额: ${this.startBal.toFixed(2)} USDT`);
this._setConn(true);
this.tick();
this.startPriceTicker();
} catch(e) { this._setConn(false); this.log("error", "启动失败: " + e.message); }
}

updateConfig(newCfg) {
["takePct","stopPct","posRatio","maxLoss","leverage","trailPct","partialPct"]
.forEach(k => { if (newCfg[k] != null) this.cfg[k] = newCfg[k]; });
this.log("open", `⚙️ 参数热更新 | 止盈${this.cfg.takePct}% 止损${this.cfg.stopPct}%`);
this.emit("configUpdated", this.cfg);
}

stop() {
this.running = false;
if (this.timer) { clearTimeout(this.timer); this.timer = null; }
if (this.priceTimer) { clearInterval(this.priceTimer); this.priceTimer = null; }
this.log("info", "机器人已停止");
}

async tick() {
if (!this.running) return;
try { await this.run(); this._setConn(true); }
catch(e) { this._setConn(false); this.log("error", e.message); }
if (this.running) this.timer = setTimeout(() => this.tick(), 60_000);
}

startPriceTicker() {
this.priceTimer = setInterval(async () => {
if (!this.running) return;
try { this.emit("price", { price: await this.getPrice() }); this._setConn(true); }
catch(e) { this._setConn(false); }
}, 1000);
}

_setConn(ok) {
if (this._connOk === ok) return;
this._connOk = ok;
this.emit("conn", { ok });
this.log(ok ? "info" : "warn", ok ? "✅ API 连接已恢复" : "⚠️ API 连接异常");
}

scoreSignal(cur, prev, sig) {
if (sig === "HOLD") return 0;
let s = 50;
if (sig === "LONG") {
s += cur.rsi < 35 ? 15 : cur.rsi < 45 ? 10 : cur.rsi < 55 ? 5 : 0;
} else {
s += cur.rsi > 65 ? 15 : cur.rsi > 55 ? 10 : cur.rsi > 50 ? 3 : 0;
}
const ed = Math.abs(cur.ef - cur.es) / cur.close * 100;
s += ed > 0.3 ? 15 : ed > 0.15 ? 8 : ed > 0.05 ? 3 : 0;
const ap = cur.atr / cur.close * 100;
s += ap > 0.4 ? 10 : ap > 0.25 ? 5 : 0;
if (sig === "LONG" && (this.isBullC(cur) || this.isBullE(cur, prev))) s += 10;
if (sig === "SHORT" && (this.isBearC(cur) || this.isBearE(cur, prev))) s += 10;
return Math.min(100, s);
}

async run() {
const price = await this.getPrice();
const balance = this.cfg.dryRun ? this.cfg.capital : await this.getBalance();
if (!this.cfg.dryRun) this.emit("realBalance", { balance });

const curSlot = Math.floor(Date.now() / (15 * 60 * 1000));
this.emit("balance", { balance, start: this.startBal });

if (!this.cfg.dryRun && this.startBal) {
const loss = (this.startBal - balance) / this.startBal;
if (loss > this.cfg.maxLoss / 100) {
this.log("error", `🚨 风控触发！亏损 ${(loss*100).toFixed(1)}%`);
this.stop(); this.emit("stopped", { reason: "风控熔断" }); return;
}
}

const livePos = this.cfg.dryRun ? this.pos : await this.getPosition();

// ── 持仓管理 ──────────────────────────────────────────
if (livePos && this.pos) {
const { dir } = this.pos;
const entry = this.pos.entry;

if (!this.pos._movedToBreakeven) {
const profitPct = dir === "LONG"
? (price - entry) / entry * 100
: (entry - price) / entry * 100;
if (profitPct >= this.cfg.stopPct) {
this.pos._movedToBreakeven = true;
this.pos.sl = entry;
this.log("open", `🔒 止损移至保本: ${entry} (盈利已达${profitPct.toFixed(1)}%)`);
}
}

if (this.cfg.trailPct > 0) {
const tr = this.cfg.trailPct / 100;
const nsl = +(price * (dir === "LONG" ? 1 - tr : 1 + tr)).toFixed(2);
const better = dir === "LONG" ? nsl > this.pos.sl : nsl < this.pos.sl;
if (better) { this.pos.sl = nsl; this.log("scan", `📐 移动止损 → ${nsl}`); }
}

const hitSL = dir === "LONG" ? price <= this.pos.sl : price >= this.pos.sl;
const hitTP = dir === "LONG" ? price >= this.pos.tp : price <= this.pos.tp;

if (hitTP || hitSL) {
const reason = hitTP ? "止盈" : (this.pos._movedToBreakeven ? "保本出场" : "止损");
const pPct = dir === "LONG" ? (price-entry)/entry*100 : (entry-price)/entry*100;
const pnl = this.pos.notional * pPct / 100 / this.cfg.leverage;
this.log(pnl >= 0 ? "win" : "loss",
`平仓${hitTP?"✅":"🔒"} ${reason} | ${dir} | 入:${entry.toFixed(2)} 现:${price.toFixed(2)} ${pPct>=0?"+":""}${pPct.toFixed(2)}%`);
if (!this.cfg.dryRun) await this.closePosition(livePos.size, dir);

if (!hitTP) {
this.cooldownUntilSlot = curSlot + 2;
this.log("warn", `⏸ 冷却期启动，${30}分钟内不开新仓`);
}

// 更新连续亏损计数
if (pnl >= 0) {
this.consecutiveLosses = 0;
} else {
this.consecutiveLosses++;
this.log("warn", `连续亏损 ${this.consecutiveLosses} 次`);
}

this.emit("trade", {
time: Date.now(), dir, entry, exit: price,
contracts: this.pos.contracts, notional: this.pos.notional,
pPct: +pPct.toFixed(2), pnl: +pnl.toFixed(2), reason,
result: pnl >= 0 ? "win" : "loss", consecutiveLosses: this.consecutiveLosses
});
this.pos = null; this.emit("position", null); return;
}

const pPct = dir === "LONG" ? (price-entry)/entry*100 : (entry-price)/entry*100;
this.emit("position", { ...this.pos, price, pPct: +pPct.toFixed(2) });
this.log("info",
`持仓 ${dir} | 入:${entry.toFixed(2)} 现:${price.toFixed(2)} ${pPct>=0?"+":""}${pPct.toFixed(2)}% SL:${this.pos.sl} TP:${this.pos.tp}${this.pos._movedToBreakeven?" 🔒保本":""}`);
return;
}

if (livePos && !this.pos) { this.log("warn", "检测到未记录持仓，跳过"); return; }

// ── 开仓（15m信号 + 1h趋势过滤）──────────────────────
if (!this.pos && curSlot !== this.lastSlot) {
this.lastSlot = curSlot;

if (curSlot < this.cooldownUntilSlot) {
const remain = (this.cooldownUntilSlot - curSlot) * 15;
this.log("scan", `⏸ 冷却期 剩余约${remain}分钟，跳过本次扫描`);
return;
}

// 检查每日交易次数限制
if (this.cfg.maxTradesPerDay && this.dailyTrades >= this.cfg.maxTradesPerDay) {
this.log("warn", `⚠️ 今日已开仓 ${this.dailyTrades}/${this.cfg.maxTradesPerDay} 次，达到日限制`);
return;
}

const [raw15m, raw1h] = await Promise.all([
this.fetchKlines("15m", 200),
this.fetchKlines("1h", 60)
]);

const cs15m = this.buildIndicators(raw15m).filter(c => c.ef && c.rsi !== null && c.bbUp);
const cs1h = this.buildIndicators(raw1h ).filter(c => c.ef && c.rsi !== null);

if (cs15m.length < 3) { this.log("warn", "15m K线不足"); return; }

const cur15m = cs15m[cs15m.length - 2];
const prev15m = cs15m[cs15m.length - 3];
const sig = this.getSignal(cur15m, prev15m);

let trend1h = "HOLD";
if (cs1h.length >= 2) {
const c1h = cs1h[cs1h.length - 2];
trend1h = c1h.ef > c1h.es ? "LONG" : "SHORT";
}

const score = this.scoreSignal(cur15m, prev15m, sig);
const mtfOk = sig !== "HOLD" && sig === trend1h;
const sigCN = sig === "LONG" ? "做多📈" : sig === "SHORT" ? "做空📉" : "观望";
const mtfStr = sig === "HOLD" ? "" : (mtfOk ? ` ✅1h顺势(${trend1h})` : ` ⚠️1h逆势(${trend1h})`);

this.log("scan",
`[15m] 价格:${price} RSI:${cur15m.rsi.toFixed(1)} EMA9/21:${cur15m.ef.toFixed(0)}/${cur15m.es.toFixed(0)} | 【${sigCN}】${mtfStr} 评分:${score}`);
this.emit("signal", {
sig, price, rsi: cur15m.rsi, ef: cur15m.ef, es: cur15m.es,
em: cur15m.em, bbUp: cur15m.bbUp, bbLo: cur15m.bbLo,
score, mtfOk, trend1h
});

if (sig !== "HOLD" && mtfOk && score >= 65) {
const info = this.contractInfo || { mult: 0.0001 };

// 计算连续亏损后的仓位递减
let posRatio = this.cfg.posRatio;
let reductionMsg = "";
if (this.cfg.reduceAfterLosses && this.consecutiveLosses >= this.cfg.reduceAfterLosses) {
const reductionFactor = Math.pow(0.5, Math.floor(this.consecutiveLosses / this.cfg.reduceAfterLosses));
posRatio = posRatio * reductionFactor;
reductionMsg = ` (连亏${this.consecutiveLosses}次,仓位${(reductionFactor*100).toFixed(0)}%)`;
}

const contracts = Math.max(1, Math.floor(
balance * (posRatio/100) * this.cfg.leverage / (price * info.mult)
));
const sl = +(price * (sig==="LONG" ? 1-this.cfg.stopPct/100 : 1+this.cfg.stopPct/100)).toFixed(2);
const tp = +(price * (sig==="LONG" ? 1+this.cfg.takePct/100 : 1-this.cfg.takePct/100)).toFixed(2);
const notional = +(contracts * price * info.mult * this.cfg.leverage).toFixed(2);

// 更新每日交易计数
this.dailyTrades++;
const today = new Date(Date.now()+8*3600*1000).toISOString().slice(0,10);
this.lastTradeDate = today;

this.log("open",
`开仓 ${sig} ${contracts}张 (~${notional}U) 评分${score}${reductionMsg} | 今日${this.dailyTrades}${this.cfg.maxTradesPerDay?"/"+this.cfg.maxTradesPerDay:""}次 | 入:${price.toFixed(2)} SL:${sl} TP:${tp}`);
if (!this.cfg.dryRun) await this.placeOrder(sig, contracts);
this.emit("trade", {
time: Date.now(), dir: sig, entry: price, exit: null,
contracts, notional, pPct: null, pnl: null, reason: "开仓", result: "open",
dailyTrades: this.dailyTrades, maxTradesPerDay: this.cfg.maxTradesPerDay
});
this.pos = {
dir: sig, entry: price, sl, tp, contracts, notional,
time: Date.now(), _movedToBreakeven: false
};
this.emit("position", { ...this.pos, price, pPct: 0 });
}
}
}

// ── 指标计算 ──────────────────────────────────────────────
ema(arr, p) {
const k=2/(p+1), r=Array(arr.length).fill(null); let s=0;
for(let i=0;i<arr.length;i++){
if(i<p-1) s+=arr[i];
else if(i===p-1){s+=arr[i];r[i]=s/p;}
else r[i]=arr[i]*k+r[i-1]*(1-k);
}
return r;
}
rsiCalc(cls, p) {
const r=Array(cls.length).fill(null); let ag=0,al=0;
for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];d>0?ag+=d/p:al-=d/p;}
r[p]=al===0?100:100-100/(1+ag/al);
for(let i=p+1;i<cls.length;i++){
const d=cls[i]-cls[i-1];
ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?-d:0))/p;
r[i]=al===0?100:100-100/(1+ag/al);
}
return r;
}
atrCalc(cs, p=14) {
const tr=cs.map((c,i)=>i===0?c.high-c.low:
Math.max(c.high-c.low,Math.abs(c.high-cs[i-1].close),Math.abs(c.low-cs[i-1].close)));
return cs.map((_,i)=>i<p-1?null:tr.slice(i-p+1,i+1).reduce((a,v)=>a+v,0)/p);
}
bbCalc(cls, p=20, m=2) {
const mid=this.ema(cls,p),up=Array(cls.length).fill(null),lo=Array(cls.length).fill(null);
for(let i=p-1;i<cls.length;i++){
const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,v)=>a+v,0)/p;
const sd=Math.sqrt(sl.map(v=>(v-mn)**2).reduce((a,v)=>a+v,0)/p);
up[i]=mid[i]+m*sd; lo[i]=mid[i]-m*sd;
}
return{mid,up,lo};
}
buildIndicators(cs) {
const cls=cs.map(c=>c.close);
const ef=this.ema(cls,9),es=this.ema(cls,21),em=this.ema(cls,55);
const ri=this.rsiCalc(cls,14),at=this.atrCalc(cs,14),B=this.bbCalc(cls,20,2);
return cs.map((c,i)=>({...c,ef:ef[i],es:es[i],em:em[i],rsi:ri[i],atr:at[i],bbUp:B.up[i],bbLo:B.lo[i]}));
}
isBullC(c){const b=Math.abs(c.close-c.open);return c.close>c.open&&(Math.min(c.close,c.open)-c.low)>b*1.5;}
isBearC(c){const b=Math.abs(c.close-c.open);return c.close<c.open&&(c.high-Math.max(c.close,c.open))>b*1.5;}
isBullE(c,p){return c.close>c.open&&p.close<p.open&&c.close>p.open&&c.open<p.close;}
isBearE(c,p){return c.close<c.open&&p.close>p.open&&c.open>p.close&&c.close<p.open;}

getSignal(cur, prev) {
if(!cur.ef||cur.rsi===null||!cur.atr||!cur.bbUp) return "HOLD";
if(cur.atr/cur.close < 0.0015) return "HOLD";
const xUp = prev.ef<prev.es && cur.ef>cur.es;
const xDn = prev.ef>prev.es && cur.ef<cur.es;
const bbL = prev.close<=prev.bbLo && cur.close>cur.bbLo;
const bbS = prev.close>=prev.bbUp && cur.close<cur.bbUp;
const emaL = prev.low<=prev.em*1.003 && cur.close>cur.em && cur.close>prev.close;
const emaS = prev.high>=prev.em*0.997 && cur.close<cur.em && cur.close<prev.close;
const rsiL = cur.rsi>30 && cur.rsi<70;
const rsiS = cur.rsi>30 && cur.rsi<72;
const long = (bbL&&rsiL)||(xUp&&cur.close>cur.em&&rsiL)||(emaL&&rsiL&&(this.isBullC(cur)||this.isBullE(cur,prev)));
const short = (bbS&&rsiS)||(xDn&&cur.close<cur.em&&rsiS)||(emaS&&rsiS&&(this.isBearC(cur)||this.isBearE(cur,prev)));
return long?"LONG":short?"SHORT":"HOLD";
}

// ── API ──────────────────────────────────────────────────
request(method, apiPath, query={}, body=null) {
return new Promise((resolve,reject)=>{
const qs=Object.keys(query).length
?Object.entries(query).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&"):"";
const fullPath="/api/v4"+apiPath+(qs?"?"+qs:"");
const bodyStr=body?JSON.stringify(body):"";
const headers={"Content-Type":"application/json",Accept:"application/json"};
if(this.cfg.apiKey){
const ts=Math.floor(Date.now()/1000).toString();
const bh=crypto.createHash("sha256").update(bodyStr).digest("hex");
const sig=crypto.createHmac("sha256",this.cfg.apiSecret)
.update(`${method}\n/api/v4${apiPath}\n${qs}\n${bh}\n${ts}`).digest("hex");
headers.KEY=this.cfg.apiKey; headers.Timestamp=ts; headers.SIGN=sig;
}
const req=https.request({hostname:"api.gateio.ws",path:fullPath,method,headers},res=>{
let d=""; res.on("data",c=>d+=c);
res.on("end",()=>{try{resolve({status:res.statusCode,body:JSON.parse(d)});}catch(e){reject(e);}});
});
req.on("error",reject); if(bodyStr)req.write(bodyStr); req.end();
});
}

async fetchKlines(interval="1h", bars=120) {
const SECS={"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400};
const to=Math.floor(Date.now()/1000), from=to-(SECS[interval]||3600)*bars;
const r=await this.request("GET","/futures/usdt/candlesticks",
{contract:"BTC_USDT",from,to,interval});
return r.body.map(c=>({time:+c.t,open:+c.o,high:+c.h,low:+c.l,close:+c.c}))
.sort((a,b)=>a.time-b.time);
}
async getBalance() { const r=await this.request("GET","/futures/usdt/accounts"); return parseFloat(r.body.available); }
async getPrice() { const r=await this.request("GET","/futures/usdt/tickers",{contract:"BTC_USDT"}); return parseFloat(r.body[0].last); }
async getPosition() {
const r=await this.request("GET","/futures/usdt/positions/BTC_USDT"); const p=r.body;
if(!p||p.size===0) return null;
return{dir:p.size>0?"LONG":"SHORT",size:Math.abs(p.size),entry:parseFloat(p.entry_price),upnl:parseFloat(p.unrealised_pnl)};
}
async getContractInfo() {
const r=await this.request("GET","/futures/usdt/contracts/BTC_USDT");
return{mult:parseFloat(r.body.quanto_multiplier),minSize:parseInt(r.body.order_size_min)};
}
async setLeverage() {
await this.request("POST","/futures/usdt/positions/BTC_USDT/leverage",{},
{leverage:String(this.cfg.leverage),cross_leverage_limit:"0"});
}
async placeOrder(dir,contracts) {
const r=await this.request("POST","/futures/usdt/orders",{},{
contract:"BTC_USDT",size:dir==="LONG"?contracts:-contracts,price:"0",tif:"ioc",reduce_only:false});
if(r.status!==201) throw new Error("下单失败: "+JSON.stringify(r.body));
}
async closePosition(size,dir) {
const r=await this.request("POST","/futures/usdt/orders",{},{
contract:"BTC_USDT",size:dir==="LONG"?-size:size,price:"0",tif:"ioc",reduce_only:true});
if(r.status!==201) throw new Error("平仓失败: "+JSON.stringify(r.body));
}
log(level, msg) {
const ts=new Date(Date.now()+8*3600*1000).toISOString().replace("T"," ").slice(0,19);
this.emit("log",{level,msg,ts});
}

// ── 手动操作 ─────────────────────────────────────────────
async partialClose(ratio) {
const livePos=this.cfg.dryRun?this.pos:await this.getPosition();
if(!livePos){this.log("warn","无持仓");return;}
const totalSz=this.cfg.dryRun?this.pos.contracts:livePos.size;
const closeSize=Math.max(1,Math.floor(totalSz*ratio));
const dir=this.pos.dir, entry=this.pos.entry;
this.log("open",`手动平仓 ${(ratio*100).toFixed(0)}% | ${dir} 平 ${closeSize}张`);
if(!this.cfg.dryRun){
const r=await this.request("POST","/futures/usdt/orders",{},{
contract:"BTC_USDT",size:dir==="LONG"?-closeSize:closeSize,price:"0",tif:"ioc",reduce_only:true});
if(r.status!==201) throw new Error("平仓失败: "+JSON.stringify(r.body));
}
const price=await this.getPrice().catch(()=>entry);
const pPct=dir==="LONG"?(price-entry)/entry*100:(entry-price)/entry*100;
const pnl=this.pos.notional*ratio*pPct/100/this.cfg.leverage;
this.emit("trade",{time:Date.now(),dir,entry,exit:price,contracts:closeSize,
notional:+(this.pos.notional*ratio).toFixed(2),pPct:+pPct.toFixed(2),
pnl:+pnl.toFixed(2),reason:`手动平仓${(ratio*100).toFixed(0)}%`,result:pnl>=0?"win":"loss"});
this.pos.contracts-=closeSize;
if(this.pos.contracts<=0){this.pos=null;this.emit("position",null);this.log("info","持仓已全部平仓");}
else{this.emit("position",{...this.pos,price:entry,pPct:0});this.log("info",`剩余: ${this.pos.contracts}张`);}
}
setTP(v){if(!this.pos){this.log("warn","无持仓");return;}const o=this.pos.tp;this.pos.tp=parseFloat(v);this.log("open",`止盈: ${o}→${this.pos.tp}`);this.emit("position",{...this.pos,price:this.pos.entry,pPct:0});}
setSL(v){if(!this.pos){this.log("warn","无持仓");return;}const o=this.pos.sl;this.pos.sl=parseFloat(v);this.log("open",`止损: ${o}→${this.pos.sl}`);this.emit("position",{...this.pos,price:this.pos.entry,pPct:0});}
}

module.exports = { TradingEngine };
