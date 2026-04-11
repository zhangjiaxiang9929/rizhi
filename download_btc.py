import requests
import pandas as pd
import time
from datetime import datetime

SYMBOL = "BTCUSDT"
INTERVAL = "1h"
START_DATE = "2017-08-17"
OUTPUT_FILE = "E:/btc_quant/BTC_1h_history.csv"
BASE_URL = "https://api.binance.com/api/v3/klines"

fmt = "%Y-%m-%d"

def date_to_ms(d):
    return int(datetime.strptime(d, fmt).timestamp() * 1000)

def download_klines():
    all_data = []
    start_ms = date_to_ms(START_DATE)
    end_ms = int(datetime.now().timestamp() * 1000)
    cur = start_ms
    batch = 0
    while cur < end_ms:
        p = {"symbol": SYMBOL, "interval": INTERVAL, "startTime": cur, "limit": 1000}
        try:
            r = requests.get(BASE_URL, params=p, timeout=30)
            data = r.json()
        except Exception as e:
            print("retry:", e)
            time.sleep(5)
            continue
        if not data or not isinstance(data, list):
            break
        all_data.extend(data)
        batch += 1
        last = data[-1][0]
        dt = datetime.fromtimestamp(last / 1000).strftime(fmt)
        print("batch", batch, ":", len(all_data), "rows, up to", dt)
        if last >= end_ms or len(data) < 1000:
            break
        cur = last + 1
        time.sleep(0.1)
    return all_data

def save(raw):
    cols = ["open_time", "open", "high", "low", "close", "volume",
            "close_time", "quote_volume", "trades",
            "taker_buy_base", "taker_buy_quote", "ignore"]
    df = pd.DataFrame(raw, columns=cols)
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
    for col in ["open", "high", "low", "close", "volume", "quote_volume"]:
        df[col] = pd.to_numeric(df[col])
    df = df[["open_time", "open", "high", "low", "close", "volume", "quote_volume", "trades"]]
    df.to_csv(OUTPUT_FILE, index=False, encoding="utf-8-sig")
    return df

if __name__ == "__main__":
    print("downloading BTC history...")
    raw = download_klines()
    if raw:
        df = save(raw)
        print("done!", len(df), "rows")
        print("saved:", OUTPUT_FILE)
        print(df.head())
    else:
        print("failed, check network")
