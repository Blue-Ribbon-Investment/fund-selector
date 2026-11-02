# Fund Selector

Team ranking tool for Indian equity mutual funds. ~194 active growth funds across
7 categories (large / large-mid / flexi-multi / mid / small / ELSS / balanced-hybrid),
each scored on 10 parameters: expense ratio, Sharpe, information ratio, volatility,
CAGR, beta, Treynor, Jensen's alpha, selectivity, tracking error.

## How the ranking works
Every parameter is ranked within the pool (category, or all funds), best = 100
points. The team-default weights (Sharpe 20, info ratio 20, volatility 20, 5-year
CAGR 20, net selectivity 20; everything else off) turn those into a composite
score. Highest score = rank #1.
Each visitor can move the weight sliders for their own view (saved in their browser,
shareable via link). Funds under 1 year old are shown but not ranked.

## Data (all free, no API keys)
- Universe + latest NAV: AMFI's daily NAVAll feed (by category)
- 5-year history: api.mfapi.in per scheme
- Nifty 50 benchmark: Yahoo Finance
- Expense ratio: best-effort (shows n/a until a source lands)

## Editing the fund list (one-line changes)
`scripts/config.json` is the single settings file:
- add/remove a whole category -> edit `include_categories`
- force one fund in -> add its AMFI scheme code to `include_codes`
- change the team-default weights -> edit `default_weights`

After any edit: `python scripts/build_universe.py && python scripts/recompute.py`,
then commit `data/`. The nightly GitHub Actions job (`daily.yml`) does the refresh
automatically and republishes the site.

## Local run
`python -m http.server 8000` in this folder, open http://localhost:8000
