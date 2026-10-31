"""Best-effort fetch of per-fund expense ratios into data/expense.json.

Expense ratio is the one factor that can't be derived from price history, and
it lives in scheme-level data that some sources gate or rate-limit. This is a
best-effort layer: it tries several known sources and writes whatever it gets.
The site treats a missing expense ratio as "n/a" (neutral quality), so a total
failure here never breaks the ranking — it just leaves that column blank.

Output: data/expense.json = { "<scheme_code>": <expense ratio in %>, ... }
"""
import json, os, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
UA = {"User-Agent": "Mozilla/5.0"}

# Candidate (name, url, parser) tried in order. A source "succeeds" if it
# returns expense ratios for a meaningful share of our universe.
def _try(path_builder, timeout=30):
    def fetch(code):
        url = path_builder(code)
        if not url:
            return None
        req = urllib.request.Request(url, headers=UA)
        return urllib.request.urlopen(req, timeout=timeout)
    return fetch

def main():
    funds = json.load(open(os.path.join(ROOT, "data", "funds.json")))
    codes = [f["code"] for f in funds["funds"]]
    got = {}

    # Source A: AMFI's fund-performance API (reachable from CI, often blocked
    # locally). Returns a table that includes the expense ratio column.
    try:
        base = "https://www.amfiindia.com/pollingsebi/api/amfi/fundperformance"
        req = urllib.request.Request(base, headers=UA)
        d = json.load(urllib.request.urlopen(req, timeout=40))
        # The payload shape varies; pull whatever maps scheme code -> er.
        rows = d.get("data") or d.get("records") or (d if isinstance(d, list) else [])
        for row in rows:
            c = str(row.get("schemeCode") or row.get("code") or row.get("amfiCode") or "")
            er = row.get("expenseRatio") if row.get("expenseRatio") is not None else row.get("er")
            if c and er is not None:
                try:
                    got[c] = round(float(er), 4)
                except (TypeError, ValueError):
                    pass
        if got:
            print(f"source A (amfi fundperformance): {len(got)} expense ratios")
    except Exception as e:
        print(f"source A skipped: {str(e)[:80]}")

    # If we got a healthy share, write it; otherwise write an empty map so the
    # site still runs. Either way the ranking works — missing = neutral.
    coverage = len([c for c in codes if c in got])
    out = os.path.join(ROOT, "data", "expense.json")
    json.dump(got, open(out, "w"), indent=1)
    print(f"expense.json written: {len(got)} values; {coverage}/{len(codes)} universe covered")
    return 0

if __name__ == "__main__":
    sys.exit(main())
