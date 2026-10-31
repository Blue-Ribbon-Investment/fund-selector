"""One-time seed: export the team's Excel workbook into the repo's data files.

Reads Large Cap Mutual Fund Analysis.xlsx and writes:
  data/nav/<slug>.json   per-fund daily NAV history
  data/nifty.json        Nifty 50 daily index
  data/funds.json        universe metadata
Run once locally. Nightly CI later replaces these with AMFI-sourced histories.
"""
import json, os, re, datetime
import openpyxl

EXCEL = r"C:\AJNIFM MBA FINANCE\4th Term\Mutual Funds\Large Cap Mutual Fund Analysis.xlsx"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# 5 Year NAV sheet: columns B..V = 21 funds, X = Nifty 50
COLS = dict(
    B="icici-prudential", C="hdfc", D="groww", E="franklin-templeton",
    F="edelweiss", G="dsp", H="canara-robeco", I="bandhan", J="axis",
    K="aditya-birla", L="union", M="taurus", N="tata", O="sbi", P="pgim-india",
    Q="nippon-india", R="mirae-asset", S="mahindra-manulife", T="lic",
    U="kotak-mahindra", V="jm-financial",
)
HIDDEN = dict(  # column -> hidden sheet carrying the scheme name
    B="ICICI", C="HDFC", D="Groww", E="Franklin Templeton", F="Edelweiss",
    G="DSP", H="Canara Robeco", I="Bandhan Bank", J="Axis",
    K="Aditya Birla", L="Union", M="Taurus", N="Tata", O="SBI", P="PGIM",
    Q="Nippon", R="Mirae", S="Mahindra Manulife", T="LIC", U="Kotak Mahindra", V="JM",
)

def to_days(v):
    return None if v is None else (v.date() if isinstance(v, datetime.datetime) else v)

wb = openpyxl.load_workbook(EXCEL, data_only=True)
nav = wb["5 Year NAV"]
dates, series, nifty = [], {}, []
for row in nav.iter_rows(min_row=4, max_row=nav.max_row, min_col=1, max_col=26):
    d = to_days(row[0].value)
    if d is None:
        continue
    ds = d.isoformat()
    dates.append(ds)
    nifty.append([ds, float(row[23].value)])
    for col, slug in COLS.items():
        v = row[ord(col) - 65].value
        if isinstance(v, (int, float)):
            series.setdefault(slug, []).append([ds, round(float(v), 4)])

meta = {}
for col, sheet in HIDDEN.items():
    h = wb[sheet]
    house, scheme, plan = h["A2"].value, h["A3"].value, h["A4"].value
    meta[COLS[col]] = dict(
        house=house, scheme=scheme, plan=plan,
        amc=re.sub(r"\s+Mutual Fund.*$", "", (house or "").strip()),
        display=str(plan or scheme or house),
    )

r5 = wb["5 Year Returns"]
inception, order = {}, list(COLS.values())
for i, slug in enumerate(order):
    v = to_days(r5.cell(row=1265, column=3 + i).value)
    inception[slug] = v.isoformat() if v else None
rf = float(r5["C1246"].value or 0.0584)

os.makedirs(os.path.join(DATA, "nav"), exist_ok=True)
funds = []
for slug in order:
    m = meta[slug]
    m.update(slug=slug, inception=inception[slug], amfi_code=None, aum=None,
             category="Large Cap", status="seeded")
    funds.append(m)
    with open(os.path.join(DATA, "nav", slug + ".json"), "w") as f:
        json.dump(dict(code=slug, name=m["display"], inception=inception[slug],
                       source="excel-seed", nav=series[slug]), f, separators=(",", ":"))

json.dump(dict(asOf=dates[-1], source="excel-seed", points=len(nifty), index=nifty),
          open(os.path.join(DATA, "nifty.json"), "w"), separators=(",", ":"))
json.dump(dict(asOf=dates[-1], rf=rf, funds=funds),
          open(os.path.join(DATA, "funds.json"), "w"), indent=1)
json.dump(dict(lastFetch=dates[-1], ok=True,
               note="seeded from team Excel workbook; AMFI pipeline pending"),
          open(os.path.join(DATA, "status.json"), "w"), indent=1)
print("exported", len(order), "funds,", len(dates), "days ->", dates[0], "..", dates[-1], "rf=", rf)
