"""Fetch per-fund NAV history from api.mfapi.in into data/nav/<code>.json.

Resumable: skips funds that already have a file, so a slow first run can be
resumed safely. Also backfills each fund's amc (fund house) into funds.json.
"""
import json, os, sys, time, urllib.request, datetime

def ddmmyyyy_to_iso(d):
    """'30-10-2026' -> '2026-10-30'"""
    p = d.split("-")
    return f"{p[2]}-{p[1]}-{p[0]}"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NAV_DIR = os.path.join(ROOT, "data", "nav")

REFRESH = "--refresh" in sys.argv

def main():
    funds = json.load(open(os.path.join(ROOT, "data", "funds.json")))
    os.makedirs(NAV_DIR, exist_ok=True)
    todo = []
    for f in funds["funds"]:
        p = os.path.join(NAV_DIR, f["code"] + ".json")
        if not os.path.exists(p) or REFRESH:
            todo.append(f["code"])
    print(f"to fetch: {len(todo)} of {len(funds['funds'])}" + (" (refresh)" if REFRESH else ""))

    errors = []
    for i, code in enumerate(todo, 1):
        url = "https://api.mfapi.in/mf/" + code
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            d = json.load(urllib.request.urlopen(req, timeout=45))
            if d.get("status") != "SUCCESS" or not d.get("data"):
                raise ValueError("no history")
            meta, hist = d["meta"], d["data"]
            # history is newest-first; keep last 5 years + buffer, store ISO dates oldest-first
            cutoff = (datetime.date.today() - datetime.timedelta(days=365 * 5 + 45)).isoformat()
            pts = []
            for h in reversed(hist):  # oldest -> newest
                iso = ddmmyyyy_to_iso(h["date"])
                if iso >= cutoff:
                    pts.append([iso, round(float(h["nav"]), 4)])
            if not pts:
                raise ValueError("no recent history (fund too new?)")
            rec = {"code": code, "name": meta.get("scheme_name"),
                   "amc": meta.get("fund_house"), "category": meta.get("scheme_category"),
                   "nav": pts, "source": "mfapi.in"}
            target = os.path.join(NAV_DIR, code + ".json")
            blob = json.dumps(rec, separators=(",", ":"))
            existing = open(target).read() if os.path.exists(target) else None
            if existing != blob:
                with open(target, "w") as fh:
                    fh.write(blob)
            if i % 25 == 0:
                print(f"  {i}/{len(todo)} ok")
            time.sleep(0.15)
        except Exception as e:
            errors.append({"code": code, "err": str(e)[:120]})
            time.sleep(0.5)

    # backfill amc into funds.json from what we fetched
    funds_path = os.path.join(ROOT, "data", "funds.json")
    fdata = json.load(open(funds_path))
    filled = 0
    for f in fdata["funds"]:
        p = os.path.join(NAV_DIR, f["code"] + ".json")
        if f.get("amc") in ("", None) and os.path.exists(p):
            f["amc"] = json.load(open(p)).get("amc") or ""
            filled += 1
    json.dump(fdata, open(funds_path, "w"), indent=1)
    print(f"done; errors={len(errors)}; amc backfilled={filled}")
    if errors:
        json.dump(errors, open(os.path.join(ROOT, "data", "fetch_errors.json"), "w"), indent=1)
        print("first errors:", errors[:5])
    return 0

if __name__ == "__main__":
    sys.exit(main())
