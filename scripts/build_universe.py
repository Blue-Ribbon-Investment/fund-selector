"""Build data/funds.json (the universe) from AMFI's NAVAll.txt + config.json.

Reads the AMFI daily-NAV feed (the same upstream every broker copies), keeps
one row per fund in the configured categories, and writes funds.json for the
site + the history fetcher. One-line edits to config.json drive the list.

Growth detection is tolerant: the feed labels the accumulating option several
ways ("GROWTH", "Growth", "GROWTH OPTION", "Direct Growth", ...). We accept
any option token containing GROWTH, and exclude discontinued/defunct/unclaimed
ones. One row per fund, Direct Plan preferred over Regular.
"""
import json, re, os, sys, datetime, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CFG = json.load(open(os.path.join(HERE, "config.json")))

GROWTH_BAN = ("DISCONTINUED", "DEFUNCT", "UNCLAIMED", "EXPIRED", "RETIRE", "MATURITY")

def norm_date(s):
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            return datetime.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None

def is_growth(opt):
    o = opt.upper()
    if any(b in o for b in GROWTH_BAN):
        return False
    return "GROWTH" in o

def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=timeout).read()

def section_match(header, include_categories):
    for display, frags in include_categories.items():
        for f in frags:
            if f in header:
                return display
    return None

def main():
    text = get(CFG["nav_source"]).decode("utf-8", "replace")
    current_cat = None
    raw_rows = []
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
        if not code.isdigit() or nav in ("", "-") or not date:
            continue
        # AMFI labels the accumulating option many ways ("GROWTH", "Growth Option",
        # "Direct Growth", ...) and some sections leave plan/option EMPTY. An empty
        # option on a live scheme is not evidence it's a dividend plan — keep it.
        # But an explicitly named non-growth option is dropped.
        if option and not is_growth(option):
            continue
        if "SEGREGATED" in name.upper() or "LIQUIDATED" in name.upper():
            continue
        raw_rows.append({
            "code": code, "name": name, "amc": "", "category": current_cat,
            "plan": (plan or ("Unspecified" if not option else "Direct Plan")),
            "nav": float(nav), "date": date, "aum": None, "_d": norm_date(date),
        })

    # Recency guard: use the feed's own most recent NAV date as "now", and drop
    # any scheme whose last NAV is older than 45 days (liquidated/discontinued
    # schemes linger in the feed). Schemes with unparseable dates are kept
    # (prefer a too-complete universe to a silent drop).
    known = [r["_d"] for r in raw_rows if r["_d"]]
    cutoff = (max(known) - datetime.timedelta(days=45)) if known else None
    all_rows = []
    for r in raw_rows:
        if cutoff is not None and r["_d"] is not None and r["_d"] < cutoff:
            continue
        r.pop("_d", None)
        all_rows.append(r)

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
        kept = {c: r for c, r in universe.items() if r["aum"] is None or r["aum"] >= af}
        universe = kept

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
    print(f"universe: {len(funds)} growth schemes across "
          f"{len(set(f['category'] for f in funds))} categories")
    return 0

if __name__ == "__main__":
    sys.exit(main())
