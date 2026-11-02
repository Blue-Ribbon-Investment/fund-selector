"""The ranking engine — single source of truth for the site.

Ranks funds WITHIN a pool (a category, or the global list). Each factor is
turned into a "quality" 0-100 (100 = best on that factor), the visitor's
weights are applied, and the fund with the HIGHEST composite is #1 (best).

This is the team's Small Cap / Flexi Cap mechanism with the inversion fixed:
in the old sheet a fund that was best on everything ended up LAST, because
every factor was "rank 1 = best" and the total was ranked the wrong way. Here
we rank so that the best fund is always #1.

Full parameter set — the team's five factors carry the default weights; the
extras default to 0 (off) so they don't change the ranking until a visitor
turns one on. direction tells the engine whether a LOWER value is better
(low) or a HIGHER value is better (high):

  er        expense ratio      low   default 0
  sharpe    Sharpe ratio       high  default 20
  ir        information ratio  high  default 20
  vol       volatility         low   default 20
  cagr      annualised return  high  default 20
  beta      market sensitivity low   default 0   (0.9 calmer than 1.2)
  treynor   Treynor ratio      high  default 0
  alpha     Jensen's alpha     high  default 0
  selnet    net selectivity    high  default 20
  tracking  tracking error     low   default 0   (closer to index = calmer)

Team default (2026-11-06): ranking runs on exactly five parameters, each
weighted 20 — Sharpe, info ratio, volatility, 5y CAGR, net selectivity.
Anything else off.
"""

# key, direction ("low"/"high"), default weight
FACTORS = [
    ("er",       "low",   0),
    ("sharpe",   "high", 20),
    ("ir",       "high", 20),
    ("vol",      "low",  20),
    ("cagr",     "high", 20),
    ("beta",     "low",   0),
    ("treynor",  "high",  0),
    ("alpha",    "high",  0),
    ("selnet",   "high", 20),
    ("tracking", "low",   0),
]

# short labels the site shows on the sliders
LABELS = {
    "er": "Expense ratio", "sharpe": "Sharpe", "ir": "Info ratio",
    "vol": "Volatility", "cagr": "Return (CAGR)", "beta": "Beta",
    "treynor": "Treynor", "alpha": "Jensen's alpha",
    "selnet": "Selectivity", "tracking": "Tracking error",
}
DIR = {k: d for k, d, _ in FACTORS}


def default_weights():
    return {k: w for k, _, w in FACTORS}


def _rank_quality(fund_values, key, direction):
    """{index: quality 0-100} for one factor across a pool.

    - funds with a value are ranked: quality 100 for the best, scaled down.
    - funds missing the value get the average quality of those present (neutral),
      so a missing input neither flatters nor punishes.
    """
    m = sum(1 for f in fund_values if f.get(key) is not None)
    if not m:
        return {i: 50.0 for i in range(len(fund_values))}
    order = sorted(range(len(fund_values)),
                   key=lambda i: fund_values[i].get(key),
                   reverse=(direction == "high"))
    rank_of = {i: r for r, i in enumerate(order, 1)}
    q = {i: round((m - rank_of[i] + 1) / m * 100, 2)
         for i in order if fund_values[i].get(key) is not None}
    neutral = round(sum(q.values()) / m, 2)
    return {i: (q.get(i, neutral)) for i in range(len(fund_values))}


def rank_category(fund_factors, weights=None, min_years=1.0):
    """fund_factors: list of dicts, each with a 'factors' sub-dict of raw values
    (and optionally 'age'). Returns the list sorted best-first with each item's
    'score' and 'rank' set (rank 1 = best). Funds younger than min_years are
    kept in place but get rank=None (unranked / 'too new')."""
    weights = {**default_weights(), **(weights or {})}
    n = len(fund_factors)
    active = [f for f in fund_factors if (f.get("age") or 99) >= min_years]
    if not active:
        for f in fund_factors:
            f["rank"] = None
        return fund_factors

    quality = {}
    for key, direction, _ in FACTORS:
        qm = _rank_quality(active, key, direction)
        for i in range(len(active)):
            quality.setdefault(i, {})[key] = qm[i]
    wsum = sum(weights.get(k, 0) for k, _, _ in FACTORS) or 1
    for i, f in enumerate(active):
        f["quality"] = quality[i]
        f["score"] = round(sum(weights.get(k, 0) * quality[i][k]
                               for k, _, _ in FACTORS) / wsum, 2)
    active.sort(key=lambda f: (-f["score"], f.get("name", "")))
    for r, f in enumerate(active, 1):
        f["rank"] = r
    for f in fund_factors:
        f.setdefault("rank", None)
    return fund_factors


def split_new(fund_factors, min_years=1.0):
    """Return (ranked, too_new)."""
    ranked = [f for f in fund_factors if (f.get("age") or 99) >= min_years]
    too_new = [f for f in fund_factors if (f.get("age") or 99) < min_years]
    for f in too_new:
        f["rank"] = None
    return rank_category(ranked, min_years=min_years), too_new


if __name__ == "__main__":
    funds = [
        {"name": "cheap+calm+good", "age": 5,
         "factors": {"er": 0.4, "sharpe": 2.0, "ir": 1.5, "vol": 10,
                     "cagr": 25, "beta": 0.9, "treynor": 1.5,
                     "alpha": 3, "selnet": 2, "tracking": 4}},
        {"name": "pricy+jumpy+weak", "age": 5,
         "factors": {"er": 2.0, "sharpe": 0.2, "ir": 0.1, "vol": 25,
                     "cagr": 8, "beta": 1.3, "treynor": 0.2,
                     "alpha": -1, "selnet": -2, "tracking": 12}},
        {"name": "new", "age": 0.5,
         "factors": {"er": 1.0, "sharpe": 1.0, "ir": 0.8, "vol": 17,
                     "cagr": 15, "beta": 1.0, "treynor": 1.0,
                     "alpha": 1, "selnet": 1, "tracking": 6}},
    ]
    ranked = rank_category(funds)
    print("top:", ranked[0]["name"], ranked[0]["rank"], "| new-fund rank:",
          [f for f in ranked if f["name"] == "new"][0]["rank"])
    assert ranked[0]["name"] == "cheap+calm+good"
    assert [f for f in ranked if f["name"] == "new"][0]["rank"] is None
    print("OK")
