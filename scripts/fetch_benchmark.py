"""Fetch Nifty 50 daily closes (5y) from Yahoo into data/nifty.json."""
import json, os, sys, urllib.request, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = ("https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=5y&interval=1d"
       "&includePrePost=false&events=div%2Csplit")

def main():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    d = json.load(urllib.request.urlopen(req, timeout=45))
    r = d["chart"]["result"][0]
    ts = r["timestamp"]
    closes = r["indicators"]["quote"][0]["close"]
    pts = []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        iso = datetime.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d")
        pts.append([iso, round(c, 2)])
    json.dump({"index": pts, "asOf": pts[-1][0], "points": len(pts), "source": "yahoo"},
              open(os.path.join(ROOT, "data", "nifty.json"), "w"), separators=(",", ":"))
    print(f"nifty: {len(pts)} points -> {pts[-1]}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
