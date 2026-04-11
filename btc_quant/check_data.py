import pandas as pd
import os

data_dir = "E:/btc_quant/data"

files = {
    "日线": "Binance_BTCUSDT_d.csv",
    "1小时": "Binance_BTCUSDT_1h.csv",
    "1分钟": "Binance_BTCUSDT_minute.csv",
}

for name, filename in files.items():
    path = os.path.join(data_dir, filename)
    print("=" * 50)
    print("周期:", name)
    try:
        df = pd.read_csv(path, skiprows=1)
        df.columns = [c.strip() for c in df.columns]
        print("列名:", list(df.columns))
        print("总行数:", len(df))
        date_col = df.columns[0]
        print("时间范围:", df[date_col].iloc[-1], "→", df[date_col].iloc[0])
        close_col = None
        for col in df.columns:
            if "close" in col.lower():
                close_col = col
                break
        if close_col:
            df[close_col] = pd.to_numeric(df[close_col], errors="coerce")
            print("最高收盘价:", df[close_col].max())
            print("最低收盘价:", df[close_col].min())
        print("缺失值:", df.isnull().sum().sum())
        print("前2行预览:")
        print(df.head(2).to_string())
    except Exception as e:
        print("读取失败:", e)

print("=" * 50)
print("检查完成!")
