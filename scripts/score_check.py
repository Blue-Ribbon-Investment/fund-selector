"""Verify the corrected scoring on the team's own Small Cap / Flexi Cap files.

Same factors + weights as the sheets (ER 10, Sharpe 10, IR 20, Vol 50, CAGR 10),
ranks within the category, but MIRRORED so the best fund scores highest and is #1.
Compares the corrected top-5 against what the sheet's raw formula called "#1".
"""
import json, os, sys
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DESK = r"C:\Users\lenovo\Desktop"
W = {"er": 0.10, "sharpe": 0.10, "ir": 0.20, "vol": 0.50, "cagr": 0.10}

def load_rows(fn):
    ws = openpyxl.load_workbook(fn, data_only=True)["Sheet1"]
    rows = []
    for r in range(3, ws.max_row + 1):
        name = ws[f"B{r}"].value
        if not name:
            continue
        F, G, H, I, J, K = (ws[f"{c}{r}"].value for c in "FGHIJK")
        rows.append(dict(
            name=name, cat=ws[f"C{r}"].value,
            er=abs(F) if F is not None else None,          # cost: lower better
            sharpe=G, te=H, alpha=I,
            vol=abs(J) if J is not None else None,         # risk: lower better
            cagr=(K or 0),
        ))
    return rows

def rank_best(vals, reverse):
    """1 = best. reverse=False -> lower is best (cost/vol); True -> higher best."""
    order = sorted(range(len(vals)), key=lambda i: vals[i], reverse=reverse)
    out = [0] * len(vals)
    for rk, i in enumerate(order, 1):
        out[i] = rk
    return out

def score_group(rows):
    n = len(rows)
    er = rank_best([r["er"] for r in rows], reverse=False)      # cheapest=1
    sh = rank_best([r["sharpe"] for r in rows], reverse=True)   # highest=1
    ir_vals = [(r["alpha"] / r["te"]) if (r.get("te") and r.get("alpha") is not None) else -1e9 for r in rows]
    ir = rank_best(ir_vals, reverse=True)                       # highest=1
    vol = rank_best([r["vol"] for r in rows], reverse=False)    # calmest=1
    cg = rank_best([r["cagr"] for r in rows], reverse=True)    # highest=1
    for i, r in enumerate(rows):
        # mirror: quality 100 at rank 1, 0 at rank n -> higher = better
        q = {"er": er[i], "sharpe": sh[i], "ir": ir[i], "vol": vol[i], "cagr": cg[i]}
        r["score"] = round(sum(W[k] * ((n - q[k]) / n * 100) for k in W), 1)
        r["q"] = q
    return rows

def main():
    for fn, tag in [("Small Cap Fund.xlsx", "SMALL CAP"), ("Small Cap.xlsx", "FLEXI CAP")]:
        rows = score_group(load_rows(os.path.join(DESK, fn)))
        rows_sorted = sorted(rows, key=lambda r: -r["score"])
        print(f"\n===== {tag}  ({len(rows)} funds, corrected: #1 = best) =====")
        for i, r in enumerate(rows_sorted[:5], 1):
            q = r["q"]
            print(f"  #{i}  {r['name'][:34]:34}  score {r['score']:5}   "
                  f"(ER {q['er']}/{len(rows)}, Sh {q['sharpe']}, IR {q['ir']}, Vol {q['vol']}, CAGR {q['cagr']})")
        # what the sheet's raw formula would have called "#1" (highest raw sum)
        raw = sorted(rows, key=lambda r: sum(W[k] * r["q"][k] for k in W))
        print(f"  [sheet's old '#1' was] {raw[0]['name'][:34]:34}  (rank {rows_sorted.index(raw[0])+1} after fix)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
