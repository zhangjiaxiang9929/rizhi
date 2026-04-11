# Gate.io 10x 合约自动化交易策略

## 策略逻辑

**信号源：EMA 交叉 + RSI 过滤**

| 信号 | 条件 |
|------|------|
| 做多 | EMA9 上穿 EMA21 + RSI 在 40~65 |
| 做空 | EMA9 下穿 EMA21 + RSI 在 35~60 |
| 不操作 | RSI 超买/超卖区域（避免追高追低） |

---

## 风控设计

- **每笔最大亏损**：本金 × 2% = **10 USDT**
- **止损幅度**：开仓价 ±1%（10倍杠杆下约损失10%权益）
- **止盈幅度**：止损的 2 倍（盈亏比 1:2）
- **单次仓位**：不超过本金 25%
- **熔断保护**：余额低于本金 50%（250U）时自动停止

---

## 快速开始

### 1. 安装依赖

```bash
pip install requests pandas numpy
```

### 2. 配置 API Key

在 Gate.io 后台生成 API Key，勾选合约权限，填入 strategy.py：

```python
API_KEY = "你的APIKey"
API_SECRET = "你的APISecret"
```

### 3. 运行

```bash
python strategy.py
```

---

## ⚠️ 重要提示

1. **先用 Gate.io 模拟盘测试**，确认无误再上实盘
2. 10倍合约风险极高，本金可能**快速归零**
3. 任何策略都有回撤期，不存在"永不亏损"的策略
4. 建议设置**总亏损上限**（如本金的30%）手动止损离场

---

## 策略参数说明

| 参数 | 默认值 | 说明 |
|------|-------|------|
| SYMBOL | BTC_USDT | 交易对 |
| LEVERAGE | 10 | 杠杆倍数 |
| TOTAL_CAPITAL | 500 | 总本金 USDT |
| RISK_PER_TRADE | 2% | 每笔最大亏损 |
| REWARD_RATIO | 2 | 盈亏比（止盈=2×止损） |
| EMA_FAST | 9 | 快线周期 |
| EMA_SLOW | 21 | 慢线周期 |
| RSI_PERIOD | 14 | RSI 周期 |
