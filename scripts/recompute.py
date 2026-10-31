"""Compute per-fund factor values and write data/agg.json.

The site does the ranking itself (so each visitor's weights apply live), but
this script precomputes the raw factor numbers it needs:

  per fund, per window (5y/3y/1y):
    sharpe   reward per unit of total risk
    vol      annualised volatility
    info     information ratio = alpha / tracking error
    cagr     annualised return for the window
    er       expense ratio, if data/expense.json has it (else null)

Data: data/nav/<code>.json price histories + data/nifty.json benchmark.
The expense-ratio file is optional (produced by fetch_expense.py; may fail).
"""
import json, os, sys, math

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NAV_DIR = os.path.join(ROOT, "data", "nav")

def mean(a):
    return sum(a) / len(a)

def stdev(a):
    m = mean(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))

def slope(y, x):
    my, mx = mean(y), mean(x)
    num = sum((y[i] - my) * (x[i] - mx) for i in range(len(y)))
    den = sum((x[i] - mx) ** 2 for i in range(len(x)))
    return num / den if den else 0.0

def log_returns(series):
    out = []
    for i in range(1, len(series)):
        if series[i][1] > 0 and series[i - 1][1] > 0:
            out.append([series[i][0], math.log(series[i][1] / series[i - 1][1])])
    return out

def factors_for_window(seg, mrets_by_date, rf):
    """Factor numbers for one window. Returns None if too little data."""
    frets = log_returns(seg)
    if len(frets) < 60:
        return None
    fr = [v for d, v in frets]
    md = [d for d, _ in frets]
    mr = [mrets_by_date[d] for d in md if d in mrets_by_date]
    if len(mr) < max(40, int(0.6 * len(fr))):
        return None
    fr = fr[:len(mr)]
    ret = mean(fr) * 250
    vol = stdev(fr) * math.sqrt(250)
    beta = slope(fr, mr)
    mavg = mean(mr) * 250
    sharpe = (ret - rf) / vol if vol else None
    treynor = (ret - rf) / beta if beta else None
    alpha = ret - (rf + beta * (mavg - rf))
    mv = stdev(mr) * math.sqrt(250)
    # properly-diversified return -> net selectivity (the team's "Returns If
    # Properly Diversified" decomposition)
    div = rf + (mavg - rf) * (vol / mv) if mv else rf
    selnet = ret - div
    tracking = stdev([fr[i] - mr[i] for i in range(len(fr))]) * math.sqrt(250)
    info = alpha / tracking if tracking > 0 else None
    def r4(x):
        return None if x is None else round(x, 6)
    return {"cagr": r4(ret), "vol": r4(vol), "beta": r4(beta), "sharpe": r4(sharpe),
            "treynor": r4(treynor), "alpha": r4(alpha), "selnet": r4(selnet),
            "tracking": r4(tracking), "info": r4(info), "n": len(fr)}

def main():
    cfg = json.load(open(os.path.join(HERE, "config.json")))
    funds = json.load(open(os.path.join(ROOT, "data", "funds.json")))
    nifty = json.load(open(os.path.join(ROOT, "data", "nifty.json")))["index"]
    rf = cfg["risk_free_rate"]
    windows = cfg["windows_years"]
    mrets = {d: v for d, v in log_returns(nifty)}

    # optional expense-ratio source
    er_path = os.path.join(ROOT, "data", "expense.json")
    expense = json.load(open(er_path)) if os.path.exists(er_path) else {}

    out = {"asOf": nifty[-1][0], "rf": rf, "windows": windows, "funds": {}, "missing": []}
    for f in funds["funds"]:
        p = os.path.join(NAV_DIR, f["code"] + ".json")
        if not os.path.exists(p):
            out["missing"].append(f["code"])
            continue
        hist = json.load(open(p))["nav"]
        per = {}
        for w in windows:
            y0 = str(int(nifty[-1][0][:4]) - w)
            seg = [pt for pt in hist if pt[0] >= f"{y0}-01-01"]
            s = factors_for_window(seg, mrets, rf)
            if s:
                per[str(w) + "y"] = s
        per["ageYrs"] = round(len(hist) / 250.0, 2) if hist else 0
        per["er"] = expense.get(f["code"])
        per["name"] = f["name"]
        per["amc"] = f.get("amc") or ""
        per["category"] = f["category"]
        out["funds"][f["code"]] = per

    json.dump(out, open(os.path.join(ROOT, "data", "agg.json"), "w"), indent=1)
    import datetime
    json.dump({"ok": True, "lastFetch": out["asOf"], "funds": len(out["funds"]),
               "note": "recomputed " + datetime.datetime.now(datetime.timezone.utc).isoformat()},
              open(os.path.join(ROOT, "data", "status.json"), "w"), indent=1)
    print(f"agg: {len(out['funds'])} funds; missing history: {len(out['missing'])}; "
          f"expense ratios loaded: {len(expense)}; asOf={out['asOf']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
