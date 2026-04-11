#!/bin/bash
# Git提交脚本 - BTC交易机器人修复版本

echo "🚀 准备提交修复版本到Git"

# 1. 查看Git状态
git status

# 2. 备份原版本
echo "📂 备份原版本..."
cp engine.js engine_backup_v14.js

# 3. 使用修复版本
echo "🔄 替换为修复版本..."
cp engine_fixed.js engine.js

# 4. 添加文件到Git
echo "📦 添加文件到Git..."
git add .
git add engine_fixed.js
git add README_修复版本.md
git add btc-bot-v2-package.js

# 5. 创建提交
echo "📝 创建Git提交..."
git commit -m "BTC交易机器人修复版本 v2.1

修复的关键问题：
1. 盈亏计算错误修复（添加手续费计算）
2. AI顾问集成启用（置信度阈值60%）
3. 趋势判断改进（多K线确认）
4. 市场状态识别（震荡/趋势市场检测）
5. 连亏减仓优化（线性递减而非指数级）
6. 冷却期优化（根据亏损幅度动态调整）
7. 盈亏比验证（要求至少1.5:1）
8. 保证金检查（添加手续费预留）
9. 每日盈亏限制（盈利5%/亏损3%停止）

优化策略：
- 多维度过滤：技术指标+趋势+市场状态+AI分析
- 风险管理：连亏减仓、每日限制、熔断机制
- 盈利优化：盈亏比验证、市场状态适应"

# 6. 推送到远程仓库
echo "🌐 推送到远程仓库..."
git push origin main

echo "✅ 修复版本已提交到Git"