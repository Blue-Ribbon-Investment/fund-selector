"""Build data/funds.json (the universe) from AMFI's NAVAll.txt + config.json.

Reads the AMFI daily-NAV feed, keeps only schemes in the configured categories
(growth option, preferred plan), and writes funds.json for the site + the
history fetcher. One-line edits to config.json drive this.
"""
import json, re, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CFG = json.load(open(os.path.join(HERE, "config.json")))

def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=timeout).read()

# section header -> keep? based on config include_categories (display: [fragments])
def section_match(header, include_categories):
    for display, frags in include_categories.items():
        for f in frags:
            # AMFI sections look like "Open Ended Schemes(Equity Scheme - Large Cap Fund)"
            if f in header:
                return display
    return None

def main():
    text = get(CFG["nav_source"]).decode("utf-8", "replace")
    current_cat = None
    all_rows = []
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r"Open Ended Schemes\((.+)\)$", line)
        if m:
            current_cat = section_match(m.group(1), CFG["include_categories"])
            continue
        if not line or line == " " or current_cat is None:
            continue
        fields = line.split(";")
        if len(fields) < 8:
            continue
        code, isin_g, isin_r, name, plan, option, nav, date = [x.strip() for x in fields[:8]]
        option = option.upper()
        plan = plan
        if option != "GROWTH":
            continue
        if nav in ("", "-"):
            continue
        all_rows.append({
            "code": code, "name": name, "amc": "", "category": current_cat,
            "plan": plan, "nav": float(nav), "date": date, "aum": None,
        })

    # dedup: one row per fund (same scheme name). Prefer preferred plan, then any.
    pref, fb = CFG.get("preferred_plan", "Direct Plan"), CFG.get("plan_fallback", "Regular Plan")
    def key(r):
        r = r["name"].upper().replace("-", " ").strip()
        return re.sub(r"\s+", " ", r)
    picked = {}
    for row in all_rows:
        k = key(row)
        rank = 0 if row["plan"] == pref else (1 if row["plan"] == fb else 2)
        cur = picked.get(k)
        if cur is None or rank < cur[0]:
            picked[k] = (rank, row)
    universe = {row["code"]: row for (rank, row) in picked.values()}
    # force-include specific codes even if their category is excluded
    forced = set(CFG.get("include_codes", []))
    for row in all_rows:
        if row["code"] in forced:
            universe[row["code"]] = row

    # optional AUM hard filter
    af = CFG.get("aum_filter_crores") or 0
    if af:
        kept = {}
        for c, rec in universe.items():
            kept[c] = rec if rec["aum"] is None or rec["aum"] >= af else None
        universe = {c: r for c, r in kept.items() if r}

    funds = sorted(universe.values(), key=lambda r: (r["category"] or "", r["amc"], r["name"]))
    out = {
        "source": "amfi-navall",
        "count": len(funds),
        "rf": CFG["risk_free_rate"],
        "default_weights": CFG["default_weights"],
        "factor_defs": CFG.get("factor_defs", {}),
        "funds": funds,
    }
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "funds.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(f"universe: {len(funds)} growth schemes across {len(set(f['category'] for f in funds))} categories")
    return 0

if __name__ == "__main__":
    sys.exit(main())
