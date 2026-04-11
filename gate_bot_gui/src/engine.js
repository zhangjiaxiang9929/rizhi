/**
 * 交易引擎（与 gate_bot.js 完全一致的策略逻辑）
 * [placeholder to force write]
 */
"use strict";
const https  = require("https");
const crypto = require("crypto");

class TradingEngine {
  constructor(config, emit) {
    this.cfg    = config;
    this.emit   = emit;   // (type, data) => void
    this.pos    = null;
    this.timer  = null;
    this.running = false;
    this.lastHour = 0;
    this.startBal = null;
    this.contractInfo = null;
  }

  // ── 启动 ──────────────────────────────
  async start() {
    this.running = true;
    this.log("info", `机器人启动 | ${this.cfg.dryRun ? "【模拟模式】" : "【真实交易】"}`);
    this.log("info", `止盈${this.cfg.takePct}% 止损${this.cfg.stopPct}% ${this.cfg.leverage}x 仓位${this.cfg.posRatio}%`);

    try {
      if (!this.cfg.dryRun) {
        await this.setLeverage();
        this.log("info", `杠杆已设置: ${this.cfg.leverage}x`);
      }
      this.contractInfo = await this.getContractInfo();
      this.log("info", `合约: BTC_USDT | 每张=${this.contractInfo.mult} BTC`);

      this.startBal = this.cfg.dryRun ? this.cfg.capital : await this.getBalance();
      this.emit("balance", { balance: this.startBal, start: this.startBal });
      this.log("info", `账户余额: ${this.startBal.toFixed(2)} USDT`);

      this.tick();
    } catch (e) {
      this.log("error", "启动失败: " + e.message);
    }
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.log("info", "机器人已停止");
  }

  // ── 主循环 ────────────────────────────
  async tick() {
    if (!this.running) return;
    try {
      await this.run();
    } catch (e) {
      this.log("error", e.message);
    }
    if (this.running) {
      this.timer = setTimeout(() => this.tick(), 60_000);
    }
  }

  async run() {
    const price   = this.cfg.dryRun ? 70000 : await this.getPrice();
    const balance = this.cfg.dryRun ? this.cfg.capital : await this.getBalance();
    const curHour = Math.floor(Date.now() / 3600000);

    this.emit("price",   { price });
    this.emit("balance", { balance, start: this.startBal });

    // 风控
    if (!this.cfg.dryRun && this.startBal) {
      const loss = (this.startBal - balance) / this.startBal;
      if (loss > this.cfg.maxLoss / 100) {
        this.log("error", `🚨 风控触发！亏损 ${(loss*100).toFixed(1)}% 超过上限，停止`);
        this.stop();
        this.emit("stopped", { reason: "风控熔断" });
        return;
      }
    }

    // 检查持仓 SL/TP
    const livePos = this.cfg.dryRun ? this.pos : await this.getPosition();

    if (livePos && this.pos) {
      const { sl, tp, dir } = this.pos;
      const hitSL = dir === "LONG" ? price <= sl : price >= sl;
      const hitTP = dir === "LONG" ? price >= tp : price <= tp;

      if (hitTP || hitSL) {
        const reason = hitTP ? "止盈" : "止损";
        const pPct   = dir === "LONG"
          ? (price - livePos.entry) / livePos.entry * 100
          : (livePos.entry - price) / livePos.entry * 100;
        this.log(hitTP ? "win" : "loss",
          `平仓${hitTP?"✅":"❌"} ${reason} | ${dir} | 入场:${livePos.entry.toFixed(2)} 现价:${price.toFixed(2)} ${pPct>=0?"+":""}${pPct.toFixed(2)}%`);
        if (!this.cfg.dryRun) await this.closePosition(livePos.size, dir);
        this.pos = null;
        this.emit("position", null);
        return;
      }

      const pPct = dir === "LONG"
        ? (price - livePos.entry) / livePos.entry * 100
        : (livePos.entry - price) / livePos.entry * 100;
      this.emit("position", { ...this.pos, price, pPct: +pPct.toFixed(2) });
      this.log("info", `持仓 ${dir} | 入场:${livePos.entry.toFixed(2)} 现价:${price.toFixed(2)} ${pPct>=0?"+":""}${pPct.toFixed(2)}%  SL:${sl} TP:${tp}`);
      return;
    }

    if (livePos && !this.pos) {
      this.log("warn", "检测到未记录的持仓，跳过");
      return;
    }

    // 无仓位时寻找信号（每小时一次）
    if (!this.pos && curHour !== this.lastHour) {
      this.lastHour = curHour;
      const raw = await this.fetchKlines();
      const cs  = this.buildIndicators(raw).filter(c => c.ef && c.rsi !== null && c.bbUp);
      if (cs.length < 3) { this.log("warn", "K线数量不足"); return; }

      const cur  = cs[cs.length - 2];
      const prev = cs[cs.length - 3];
      const sig  = this.getSignal(cur, prev);

      this.log("scan", `RSI:${cur.rsi.toFixed(1)} EMA9:${cur.ef.toFixed(0)}/21:${cur.es.toFixed(0)}/55:${cur.em.toFixed(0)} | 信号:${sig}`);
      this.emit("signal", { sig, price, rsi: cur.rsi, ef: cur.ef, es: cur.es, em: cur.em, bbUp: cur.bbUp, bbLo: cur.bbLo });

      if (sig !== "HOLD") {
        const info = this.contractInfo || { mult: 0.0001 };
        const contracts = Math.max(1,
          Math.floor(balance * (this.cfg.posRatio/100) * this.cfg.leverage / (price * info.mult)));
        const takePct = this.cfg.takePct / 100;
        const stopPct = this.cfg.stopPct / 100;
        const sl = +(price * (sig === "LONG" ? 1 - stopPct : 1 + stopPct)).toFixed(2);
        const tp = +(price * (sig === "LONG" ? 1 + takePct : 1 - takePct)).toFixed(2);
        const notional = +(contracts * price * info.mult * this.cfg.leverage).toFixed(2);

        this.log("open", `开仓 ${sig} ${contracts}张 (~${notional}U) | 入场:${price.toFixed(2)} SL:${sl} TP:${tp}`);

        if (!this.cfg.dryRun) await this.placeOrder(sig, contracts);

        this.pos = { dir: sig, entry: price, sl, tp, contracts, notional, time: Date.now() };
        this.emit("position", { ...this.pos, price, pPct: 0 });
      }
    }
  }

  // ── 指标计算 ──────────────────────────
  ema(arr, p) {
    const k = 2/(p+1), r = Array(arr.length).fill(null); let s = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i < p-1) { s += arr[i]; } else if (i === p-1) { s += arr[i]; r[i] = s/p; }
      else { r[i] = arr[i]*k + r[i-1]*(1-k); }
    }
    return r;
  }
  rsiCalc(cls, p) {
    const r = Array(cls.length).fill(null); let ag=0, al=0;
    for (let i=1; i<=p; i++) { const d=cls[i]-cls[i-1]; d>0?ag+=d/p:al+=-d/p; }
    r[p] = al===0?100:100-100/(1+ag/al);
    for (let i=p+1; i<cls.length; i++) {
      const d=cls[i]-cls[i-1]; ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?-d:0))/p;
      r[i]=al===0?100:100-100/(1+ag/al);
    }
    return r;
  }
  atrCalc(cs, p=14) {
    const tr=cs.map((c,i)=>i===0?c.high-c.low:Math.max(c.high-c.low,Math.abs(c.high-cs[i-1].close),Math.abs(c.low-cs[i-1].close)));
    return cs.map((_,i)=>i<p-1?null:tr.slice(i-p+1,i+1).reduce((s,v)=>s+v,0)/p);
  }
  bbCalc(cls, p=20, m=2) {
    const mid=this.ema(cls,p), up=Array(cls.length).fill(null), lo=Array(cls.length).fill(null);
    for (let i=p-1; i<cls.length; i++) {
      const sl=cls.slice(i-p+1,i+1), mn=sl.reduce((s,v)=>s+v,0)/p;
      const sd=Math.sqrt(sl.map(v=>(v-mn)**2).reduce((s,v)=>s+v,0)/p);
      up[i]=mid[i]+m*sd; lo[i]=mid[i]-m*sd;
    }
    return {mid,up,lo};
  }
  buildIndicators(cs) {
    const cls=cs.map(c=>c.close);
    const ef=this.ema(cls,9), es=this.ema(cls,21), em=this.ema(cls,55);
    const ri=this.rsiCalc(cls,14), at=this.atrCalc(cs,14), B=this.bbCalc(cls,20,2);
    return cs.map((c,i)=>({...c,ef:ef[i],es:es[i],em:em[i],rsi:ri[i],atr:at[i],bbUp:B.up[i],bbLo:B.lo[i]}));
  }
  isBullC(c) { const b=Math.abs(c.close-c.open); return c.close>c.open&&(Math.min(c.close,c.open)-c.low)>b*1.5; }
  isBearC(c) { const b=Math.abs(c.close-c.open); return c.close<c.open&&(c.high-Math.max(c.close,c.open))>b*1.5; }
  isBullE(c,p) { return c.close>c.open&&p.close<p.open&&c.close>p.open&&c.open<p.close; }
  isBearE(c,p) { return c.close<c.open&&p.close>p.open&&c.open>p.close&&c.close<p.open; }

  getSignal(cur, prev) {
    if (!cur.ef||cur.rsi===null||!cur.atr||!cur.bbUp) return "HOLD";
    if (cur.atr/cur.close < 0.002) return "HOLD";
    const xUp=prev.ef<prev.es&&cur.ef>cur.es, xDown=prev.ef>prev.es&&cur.ef<cur.es;
    const bbL=prev.close<=prev.bbLo&&cur.close>cur.bbLo, bbS=prev.close>=prev.bbUp&&cur.close<cur.bbUp;
    const emaL=prev.low<=prev.em*1.005&&cur.close>cur.em&&cur.close>prev.close;
    const emaS=prev.high>=prev.em*0.995&&cur.close<cur.em&&cur.close<prev.close;
    const rsiL=cur.rsi>30&&cur.rsi<58, rsiS=cur.rsi>42&&cur.rsi<72;
    const long =(bbL&&rsiL)||(xUp&&cur.close>cur.em&&rsiL)||(emaL&&rsiL&&(this.isBullC(cur)||this.isBullE(cur,prev)));
    const short=(bbS&&rsiS)||(xDown&&cur.close<cur.em&&rsiS)||(emaS&&rsiS&&(this.isBearC(cur)||this.isBearE(cur,prev)));
    return long?"LONG":short?"SHORT":"HOLD";
  }

  // ── API 请求 ──────────────────────────
  request(method, apiPath, query={}, body=null) {
    return new Promise((resolve, reject) => {
      const qs=Object.keys(query).length?Object.entries(query).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&"):"";
      const fullPath="/api/v4"+apiPath+(qs?"?"+qs:"");
      const bodyStr=body?JSON.stringify(body):"";
      const headers={"Content-Type":"application/json",Accept:"application/json"};
      if (this.cfg.apiKey) {
        const ts=Math.floor(Date.now()/1000).toString();
        const bh=crypto.createHash("sha256").update(bodyStr).digest("hex");
        const toSign=`${method}\n/api/v4${apiPath}\n${qs}\n${bh}\n${ts}`;
        const sig=crypto.createHmac("sha256",this.cfg.apiSecret).update(toSign).digest("hex");
        headers.KEY=this.cfg.apiKey; headers.Timestamp=ts; headers.SIGN=sig;
      }
      const req=https.request({hostname:"api.gateio.ws",path:fullPath,method,headers},res=>{
        let d=""; res.on("data",c=>d+=c);
        res.on("end",()=>{ try{resolve({status:res.statusCode,body:JSON.parse(d)});}catch(e){reject(e);} });
      });
      req.on("error",reject); if(bodyStr)req.write(bodyStr); req.end();
    });
  }

  async fetchKlines() {
    const to=Math.floor(Date.now()/1000), from=to-120*3600;
    const r=await this.request("GET","/futures/usdt/candlesticks",{contract:"BTC_USDT",from,to,interval:"1h"});
    return r.body.map(c=>({time:+c.t,open:+c.o,high:+c.h,low:+c.l,close:+c.c})).sort((a,b)=>a.time-b.time);
  }
  async getBalance() {
    const r=await this.request("GET","/futures/usdt/accounts");
    return parseFloat(r.body.available);
  }
  async getPrice() {
    const r=await this.request("GET","/futures/usdt/tickers",{contract:"BTC_USDT"});
    return parseFloat(r.body[0].last);
  }
  async getPosition() {
    const r=await this.request("GET","/futures/usdt/positions/BTC_USDT");
    const p=r.body; if(!p||p.size===0)return null;
    return {dir:p.size>0?"LONG":"SHORT",size:Math.abs(p.size),entry:parseFloat(p.entry_price),upnl:parseFloat(p.unrealised_pnl)};
  }
  async getContractInfo() {
    const r=await this.request("GET","/futures/usdt/contracts/BTC_USDT");
    return {mult:parseFloat(r.body.quanto_multiplier),minSize:parseInt(r.body.order_size_min)};
  }
  async setLeverage() {
    await this.request("POST","/futures/usdt/positions/BTC_USDT/leverage",{},{leverage:String(this.cfg.leverage),cross_leverage_limit:"0"});
  }
  async placeOrder(dir, contracts) {
    const r=await this.request("POST","/futures/usdt/orders",{},{contract:"BTC_USDT",size:dir==="LONG"?contracts:-contracts,price:"0",tif:"ioc",reduce_only:false});
    if(r.status!==201)throw new Error("下单失败: "+JSON.stringify(r.body));
  }
  async closePosition(size, dir) {
    const r=await this.request("POST","/futures/usdt/orders",{},{contract:"BTC_USDT",size:dir==="LONG"?-size:size,price:"0",tif:"ioc",reduce_only:true});
    if(r.status!==201)throw new Error("平仓失败: "+JSON.stringify(r.body));
  }

  // ── 日志 ──────────────────────────────
  log(level, msg) {
    const ts = new Date(Date.now()+8*3600*1000).toISOString().replace("T"," ").slice(0,19);
    this.emit("log", { level, msg, ts });
  }
}

module.exports = { TradingEngine };
