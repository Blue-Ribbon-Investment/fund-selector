/* Fund Selector — real data, corrected weighted ranking across ALL parameters.
   Loads data/agg.json (precomputed factors per fund per window) and ranks
   WITHIN the active pool so the best fund is always #1. Visitors adjust
   weights in the side panel; weights persist in their browser and can be
   shared via ?w= URLs.

   Pools: the "All" tab ranks every fund in one global list; each category
   tab ranks funds within that category only.
*/
const $ = s => document.querySelector(s);

// Every parameter the system computes gets a slider. Your five core factors
// carry the default weights; the extras start at 0 (off) so they don't move
// the ranking until someone turns them on. The labels/directions/defaults are
// driven by factor_defs in funds.json when present (a config edit can add a
// parameter without touching the site); FALLBACK_DEFS mirrors that.
const FALLBACK_DEFS = [
  ["er", "Expense ratio", "lower", "cheaper funds score higher"],
  ["sharpe", "Sharpe", "higher", "higher Sharpe scores higher"],
  ["ir", "Info ratio", "higher", "alpha / tracking error"],
  ["vol", "Volatility", "lower", "calmer funds score higher"],
  ["cagr", "CAGR", "higher", "higher growth scores higher"],
  ["beta", "Beta", "lower", "less market-swayed (0.9 < 1.2)"],
  ["treynor", "Treynor", "higher", "reward per unit of market risk"],
  ["alpha", "Jensen's alpha", "higher", "skill beyond what beta predicts"],
  ["selnet", "Selectivity", "higher", "return from good stock-picking"],
  ["tracking", "Tracking error", "lower", "closer to the index = steadier"],
];
const FALLBACK_W = { er: 10, sharpe: 10, ir: 20, vol: 50, cagr: 10,
                     beta: 0, treynor: 0, alpha: 0, selnet: 0, tracking: 0 };
let FACTOR_DEFS = FALLBACK_DEFS.slice();
let DIR = { er: "low", vol: "low", beta: "low", tracking: "low",
            sharpe: "high", ir: "high", cagr: "high",
            treynor: "high", alpha: "high", selnet: "high" };
// agg.json stores info-ratio under "info"; map that to the "ir" slider key.
const S_KEY = { ir: "info" };

let AGG = null, META = null, NIFTY = [], DEF_W = {}, W = {}, FUNDS = [];
const state = { years: 5, cat: "All", q: "", sort: { key: "rank", dir: -1 }, chart: null };

/* ---------------- ranking engine (mirrors scripts/scoring.py) ---------------- */
function rankQuality(list, key) {
  const vals = list.map(f => {
    const v = f.s ? f.s[S_KEY[key] || key] : null;
    return (v == null || !isFinite(v)) ? null : +v;
  });
  const m = vals.filter(v => v != null).length;
  const q = new Array(list.length);
  if (!m) { q.fill(50); return q; }
  const order = [...list.keys()]
    .filter(i => vals[i] != null)
    .sort((a, b) => DIR[key] === "high" ? vals[b] - vals[a] : vals[a] - vals[b]);
  order.forEach((idx, r) => q[idx] = Math.round((m - r) / m * 1000) / 10);
  const neutral = Math.round(order.reduce((s, i) => s + q[i], 0) / m * 10) / 10;
  list.forEach((f, i) => { if (vals[i] == null) q[i] = neutral; });
  return q;
}

function scoreGroup(group, weights) {
  const quals = {};
  for (const [k] of FACTOR_DEFS) quals[k] = rankQuality(group, k);
  const wsum = FACTOR_DEFS.reduce((s, f) => s + (weights[f[0]] || 0), 0) || 1;
  group.forEach((f, i) => {
    f.quality = {};
    let total = 0;
    for (const [k] of FACTOR_DEFS) {
      f.quality[k] = quals[k][i];
      total += (weights[k] || 0) * quals[k][i];
    }
    f.score = Math.round(total / wsum * 100) / 100;
  });
  group.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  group.forEach((f, i) => f.rank = i + 1);
  return group;
}

/* ---------------- data ---------------- */
function buildFunds() {
  // Only surface a fund if it has enough history for the selected window.
  // A 5-year view hides funds with under ~5 years of data; 3-year hides <3y;
  // 1-year hides <~1y. (Small 0.25y tolerance so a "just under" fund isn't
  // unfairly dropped.) Everything downstream (ranking, table, tabs) uses this.
  const MIN_AGE = state.years - 0.25;
  FUNDS = (META.funds || []).map(f => {
    const rec = AGG.funds ? AGG.funds[f.code] : null;
    const s = rec ? rec["" + state.years + "y"] : null;
    if (!s) return null;                       // not enough history this window
    return {
      code: f.code, name: f.name, amc: f.amc || "", cat: f.category || "Uncategorised",
      aum: f.aum, rec,
      s: { ...s, ir: s.info, cagr: s.cagr, vol: s.vol, sharpe: s.sharpe, er: rec.er },
      age: rec.ageYrs != null ? rec.ageYrs : s.n / 250,
      // usable points in the requested window; a 3-year-old fund shows ~750 in 5y
      nPts: s.n,
    };
  }).filter(f => f && f.age >= MIN_AGE);
}

async function init() {
  try {
    const [ag, fu, ni, st] = await Promise.all([
      fetch("data/agg.json").then(r => r.json()),
      fetch("data/funds.json").then(r => r.json()),
      fetch("data/nifty.json").then(r => r.json()),
      fetch("data/status.json").then(r => r.json()).catch(() => ({ ok: true })),
    ]);
    AGG = ag; META = fu; NIFTY = ni.index;
    // let the config drive the full parameter set (labels + directions)
    if (fu.factor_defs) {
      const d = fu.factor_defs;
      const W0 = fu.default_weights || {};
      FACTOR_DEFS = Object.keys(d).map(k =>
        [k, d[k].label || k, d[k].dir || "high", d[k].better || ""]);
      DIR = {};
      FACTOR_DEFS.forEach(([k, , dir]) => DIR[k] = dir);
      const base = {};
      FACTOR_DEFS.forEach(([k]) => base[k] = 0);
      DEF_W = Object.assign(base, W0);
    } else {
      DIR = { er: "low", vol: "low", beta: "low", tracking: "low",
             sharpe: "high", ir: "high", cagr: "high",
             treynor: "high", alpha: "high", selnet: "high" };
      DEF_W = { er: 10, sharpe: 10, ir: 20, vol: 50, cagr: 10,
                beta: 0, treynor: 0, alpha: 0, selnet: 0, tracking: 0 };
    }
    W = Object.assign({}, DEF_W);
    buildFunds();
    showStatus(st);
    buildUI();
    restoreWeights();
    refreshAll();
  } catch (e) {
    banner("Could not load data: " + e.message + " — the last update may have failed.", true);
  }
}

function refreshAll() {
  const byCat = {};
  FUNDS.forEach(f => (byCat[f.cat] = byCat[f.cat] || []).push(f));
  Object.values(byCat).forEach(g =>
    scoreGroup(g.filter(f => f.age >= 1), W).forEach(f => {
      f.inCatRank = f.rank; f.inCatScore = f.score;
    }));
  const rankable = FUNDS.filter(f => f.age >= 1);
  scoreGroup(rankable, W).forEach(f => { f.allRank = f.rank; f.allScore = f.score; });
  render();
}

/* ---------------- UI ---------------- */
function buildUI() {
  const wr = $("#wr");
  wr.innerHTML = FACTOR_DEFS.map(([k, label, desc]) =>
    `<div class="wrow"><span>${label}<span class="desc">${desc}</span></span>
     <input type="range" min="0" max="100" step="5" value="${W[k]}" data-k="${k}">
     <span class="val" id="wv_${k}">${W[k]}</span></div>`).join("");
  wr.querySelectorAll("input").forEach(el => el.oninput = e => {
    W[el.dataset.k] = +e.target.value;
    document.getElementById("wv_" + el.dataset.k).textContent = e.target.value;
    updateTotal(); saveWeights(); refreshAll();
  });

  // weights are a 100% budget: show the running total and offer a one-click
  // rescale of every slider so they add up to exactly 100.
  $("#balanceW").onclick = () => {
    const total = FACTOR_DEFS.reduce((s, f) => s + (W[f[0]] || 0), 0);
    if (total === 0) return;               // nothing to rescale
    FACTOR_DEFS.forEach(([k]) => W[k] = Math.max(0, Math.round(W[k] * 100 / total)));
    const drift = 100 - FACTOR_DEFS.reduce((s, f) => s + W[f[0]], 0);
    const active = FACTOR_DEFS.map(f => f[0]).filter(k => W[k]);
    if (active.length) {
      active.sort((a, b) => W[b] - W[a]);
      W[active[0]] += drift;
    }
    refreshSliders(); saveWeights(); refreshAll();
  };

  $("#resetW").onclick = () => { W = Object.assign({}, DEF_W); refreshSliders(); saveWeights(); refreshAll(); };
  $("#randW").onclick = () => { FACTOR_DEFS.forEach(([k]) => W[k] = Math.floor(Math.random() * 5) * 5); refreshSliders(); saveWeights(); refreshAll(); };
  $("#shareW").onclick = shareView;
  $("#howBtn").onclick = () => { const h = $("#how"); h.hidden = !h.hidden; h.scrollIntoView({ behavior: "smooth" }); };

  updateTotal();

  const cats = ["All"].concat([...new Set(META.funds.map(f => f.category).filter(Boolean))].sort());
  const tabs = $("#tabs");
  tabs.innerHTML = cats.map((c, i) => `<button class="tab ${i === 0 ? "on" : ""}" data-c="${c}">${c}</button>`).join("");
  tabs.onclick = e => {
    if (!e.target.dataset.c) return;
    state.cat = e.target.dataset.c;
    tabs.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t === e.target));
    $("#detail").hidden = true;
    state.sort = { key: "rank", dir: -1 };
    render();
  };

  $("#years").onclick = e => {
    if (!e.target.dataset.y) return;
    state.years = +e.target.dataset.y;
    document.querySelectorAll("#years button").forEach(b => b.classList.toggle("on", b === e.target));
    buildFunds(); refreshAll();
  };

  $("#closeD").onclick = () => { $("#detail").hidden = true; };

  // --- search box: filters the table AND offers a quick-jump list -------------------
  // Type a fund name; the table below narrows to the matches, and a dropdown shows
  // the top matches with their live rank — click one to open that fund's dossier.
  const search = $("#search");
  const list = $("#searchList");
  let matchEl = null;
  const openFundFromSearch = c => {
    list.hidden = true; matchEl = null;
    state.q = ""; search.value = ""; $("#matchInfo").textContent = "";
    openDetail(c);
  };
  const updateMatches = () => {
    const q = state.q;
    if (!q) {
      list.hidden = true; matchEl = null;
      $("#matchInfo").textContent = "";
      return;
    }
    const m = FUNDS.filter(f =>
      (f.name + " " + f.amc).toLowerCase().includes(q));
    $("#matchInfo").textContent = m.length
      ? m.length + (m.length === 1 ? " match" : " matches")
      : "no match";
    list.innerHTML = m.slice(0, 8).map(f =>
      `<div data-c="${f.code}"><span>${f.name}<small class="mut">${f.amc} · ${f.cat}</small></span>` +
      `<span class="mut">in ${f.cat} #${f.inCatRank || "—"} · score ${((f.inCatScore ?? 0)).toFixed(0)}</span></div>`).join("");
    list.hidden = !m.length;
    list.querySelectorAll("div[data-c]").forEach(el =>
      el.onclick = () => openFundFromSearch(el.dataset.c));
    matchEl = list.hidden ? null : list.children[0];
  };
  search.oninput = e => { state.q = e.target.value.toLowerCase(); render(); updateMatches(); };
  search.onfocus = updateMatches;
  search.onblur = () => setTimeout(() => { list.hidden = true; matchEl = null; }, 120);
  search.onkeydown = e => {
    if (e.key !== "Enter") return;
    if (matchEl) { e.preventDefault(); matchEl.click(); }   // open the top match
  };

  const asOf = AGG.asOf || META.asOf;
  $("#dataAge").textContent = "Data as of " + asOf + " · " + META.funds.length + " funds · refreshes every night";
  const days = Math.round((Date.now() - new Date(asOf)) / 864e5);
  if (days > 2) document.querySelector(".dot").classList.add("bad");
}

function refreshSliders() {
  document.querySelectorAll("#wr input").forEach(el => {
    el.value = W[el.dataset.k];
    document.getElementById("wv_" + el.dataset.k).textContent = W[el.dataset.k];
  });
  updateTotal();
}
function updateTotal() {
  const el = document.getElementById("wTotal");
  if (!el) return;
  const total = FACTOR_DEFS.reduce((s, f) => s + (W[f[0]] || 0), 0);
  el.textContent = total;
  const row = el.closest(".wtotal");
  if (row) row.style.color = total === 100 ? "var(--good)" : "var(--amber)";
}

function activePool(f) {
  return state.cat === "All" ? { rank: f.allRank, score: f.allScore }
                            : { rank: f.inCatRank, score: f.inCatScore };
}

function rows() {
  let list = FUNDS.filter(f =>
    (state.cat === "All" || f.cat === state.cat) &&
    (!state.q || (f.name + " " + f.amc).toLowerCase().includes(state.q)));
  const K = state.sort.key, dir = state.sort.dir;
  const get = f => {
    const a = activePool(f);
    return ({
      rank: a.rank, name: f.name, age: f.age,
      er: f.s.er, sharpe: f.s.sharpe, ir: f.s.ir, vol: f.s.vol,
      cagr: f.s.cagr, beta: f.s.beta, treynor: f.s.treynor,
      alpha: f.s.alpha, tracking: f.s.tracking, selnet: f.s.selnet,
      score: a.score,
    })[K];
  };
  list = list.slice().sort((a, b) => {
    if (K === "rank") return (activePool(a).rank || 9999) - (activePool(b).rank || 9999);
    if (K === "name") return dir === 1 ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    const A = get(a), B = get(b);
    const av = A == null ? -Infinity : A, bv = B == null ? -Infinity : B;
    return dir * (av < bv ? -1 : av > bv ? 1 : 0);
  });
  return list;
}

const COLS = [
  ["rank", "#"], ["name", "Fund"], ["age", "Age"],
  ["er", "Exp. ratio"], ["sharpe", "Sharpe"], ["ir", "Info ratio"],
  ["vol", "Volatility"], ["cagr", "CAGR"],
  ["beta", "Beta"], ["treynor", "Treynor"], ["alpha", "Alpha"],
  ["tracking", "Track err"], ["selnet", "Select."],
  ["score", "Score"],
];

function render() {
  const th = $("#th");
  th.innerHTML = COLS.map(c => `<th class="${state.sort.key === c[0] ? "on" : ""}">${c[1]}</th>`).join("");
  [...th.children].forEach((t, i) => t.onclick = () => {
    const k = COLS[i][0];
    state.sort = { key: k, dir: k === "name" ? 1 : (state.sort.key === k ? -state.sort.dir : -1) };
    render();
  });

  const list = rows();
  const fmt = v => v == null ? "—" : v.toFixed(2);
  $("#tb").innerHTML = list.map(f => {
    const a = activePool(f);
    const s = f.s;
    const newB = f.age < 1 ? '<span class="new">NEW</span>' : "";
    const pct = v => (v == null || !isFinite(v)) ? "—" : (v * 100).toFixed(1) + "%";
    return `<tr class="${a.rank === 1 ? "top1" : ""}" data-c="${f.code}">
      <td class="rank">${a.rank === 1 ? "★" : (a.rank || "—")}</td>
      <td class="name">${f.name}${newB}<small>${f.amc}</small></td>
      <td class="mut">${f.age < 1 ? f.age.toFixed(1) + " y" : Math.floor(f.age) + " y"}</td>
      <td>${s.er != null ? s.er.toFixed(2) + "%" : '<span class="mut">n/a</span>'}</td>
      <td>${fmt(s.sharpe)}</td>
      <td>${fmt(s.ir)}</td>
      <td>${pct(s.vol)}</td>
      <td>${pct(s.cagr)}</td>
      <td>${fmt(s.beta)}</td>
      <td>${fmt(s.treynor)}</td>
      <td>${s.alpha != null ? (s.alpha >= 0 ? "+" : "") + (s.alpha * 100).toFixed(1) + "%" : "—"}</td>
      <td>${fmt(s.tracking)}</td>
      <td>${s.selnet != null ? (s.selnet >= 0 ? "+" : "") + (s.selnet * 100).toFixed(1) + "%" : "—"}</td>
      <td class="score">${a.score != null ? a.score.toFixed(1) : "—"}</td></tr>`;
  }).join("");
  [...$("#tb").children].forEach(tr => tr.onclick = () => openDetail(tr.dataset.c));
  const top = list.find(f => activePool(f).rank === 1);
  $("#topPick").textContent = top
    ? `${top.name} (${activePool(top).score.toFixed(1)})`
    : "—";
}

async function openDetail(code) {
  const f = FUNDS.find(x => x.code === code);
  if (!f) return;
  $("#detail").hidden = false;
  $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
  const s = f.s, a = activePool(f);
  $("#dName").textContent = f.name;
  $("#dRank").innerHTML = rankStrip(f);
  const pts = goodBadPoints(f);
  $("#dGood").innerHTML = `<h4>What's working in its favour</h4><ul>${pts.good.map(x => `<li>${x}</li>`).join("")}</ul>`;
  $("#dBad").innerHTML = `<h4>Watch-outs</h4><ul>${pts.bad.map(x => `<li>${x}</li>`).join("")}</ul>`;
  const sgn = v => v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
  $("#dFacts").innerHTML = [
    [f.cat || "—", "Category"],
    [f.age.toFixed(1) + " y of data", "Age"],
    [sgn(s.cagr), "CAGR (" + state.years + "y)"],
    [s.vol != null ? (s.vol * 100).toFixed(1) + "%" : "—", "Volatility"],
    [s.sharpe != null ? s.sharpe.toFixed(2) : "—", "Sharpe"],
    [s.er != null ? s.er.toFixed(2) + "%" : "—", "Expense ratio"],
    [s.ir != null ? s.ir.toFixed(2) : "—", "Info ratio"],
    [s.beta != null ? s.beta.toFixed(2) : "—", "Beta"],
    [s.treynor != null ? s.treynor.toFixed(2) : "—", "Treynor"],
    [sgn(s.alpha), "Jensen's alpha"],
    [sgn(s.selnet), "Selectivity"],
    [s.tracking != null ? s.tracking.toFixed(2) : "—", "Tracking error"],
  ].map(x => `<div class="fact"><b>${x[0]}</b><span>${x[1]}</span></div>`).join("");
  $("#dNote").textContent = "Score = weighted rank of this fund within its pool: every parameter shown here has a slider on the right (your five defaults are on, the rest start off). Best total is #1.";
  const rec = await fetch("data/nav/" + f.code + ".json").then(r => r.json()).catch(() => null);
  if (rec && rec.nav && rec.nav.length) drawChart(f, rec.nav, s);
}

/* ---------------- the fund's dossier: rank strip + good/bad ---------------- */
function poolCount(cat) {
  return FUNDS.filter(x => x.age >= 1 && (cat === "All" || x.cat === cat)).length;
}

// The fund's standing in its own category first (the team's primary list),
// with the all-funds rank kept only as a reference.
function rankStrip(f) {
  if (f.age < 1) return `<span class="rk head">too new to rank yet</span>`;
  let html = `<span class="rk head">in ${f.cat}: #${f.inCatRank} of ${poolCount(f.cat)}</span>`;
  if (f.inCatScore != null) html += `<span class="rk">category score <b>${f.inCatScore.toFixed(1)}</b></span>`;
  if (f.allRank) html += `<span class="rk">across all funds: #${f.allRank} of ${poolCount("All")}</span>`;
  return html;
}

// How this fund lines up against its own category's funds on each measured
// factor. quality 0-100, 100 = best of the category.
function poolQuality(f) {
  const pool = FUNDS.filter(x => x.age >= 1 && x.cat === f.cat);
  const i = pool.indexOf(f);
  if (i < 0) return null;
  const out = {};
  for (const [k] of FACTOR_DEFS) out[k] = rankQuality(pool, k)[i];
  return out;
}

// Auto-written strengths and watch-outs, relative to funds in the SAME
// category — a mid cap fund is judged against mid caps, not the universe.
function goodBadPoints(f) {
  const q = poolQuality(f);
  const poolName = f.cat + " funds";
  let good = [], bad = [];
  if (q) {
    const rows = FACTOR_DEFS.map(([k, label]) => ({ label, v: q[k] }))
                            .filter(x => x.v != null);
    good = rows.filter(x => x.v >= 75).sort((a, b) => b.v - a.v).slice(0, 4)
               .map(x => `Beats about ${Math.round(x.v)}% of ${poolName} on <b>${x.label}</b>.`);
    bad  = rows.filter(x => x.v <= 30).sort((a, b) => a.v - b.v).slice(0, 4)
               .map(x => `Weaker than about ${Math.round(100 - x.v)}% of ${poolName} on <b>${x.label}</b>.`);
  }
  if (f.age < 3) bad.push(`Only ${f.age.toFixed(1)} years of data — the track record is still thin.`);
  if (!good.length) good.push("No standout strength over its peers on these measures — a balanced, mid-pack fund.");
  if (!bad.length) bad.push("No clear weakness stands out over its peers on these measures.");
  return { good, bad };
}

function drawChart(f, nav, s) {
  if (state.chart) state.chart.destroy();
  const fund = nav; // full available history (~5y)
  const dates = fund.map(p => p[0]);
  const base = fund[0][1];
  const fdata = fund.map(p => +(p[1] / base * 100).toFixed(2));
  const i0 = Math.max(0, NIFTY.findIndex(p => p[0] >= dates[0]));
  const nift = NIFTY.slice(i0, i0 + dates.length).map(p => p[1]);
  const nbase = nift[0] || NIFTY[0][1];
  const ndata = nift.map(v => +(v / nbase * 100).toFixed(2));
  state.chart = new Chart($("#chart"), {
    type: "line",
    data: { labels: dates, datasets: [
      { label: f.name, data: fdata, borderColor: "#5b8cff", pointRadius: 0, borderWidth: 1.5 },
      { label: "Nifty 50", data: ndata, borderColor: "#8b91a7", borderDash: [4, 3], pointRadius: 0, borderWidth: 1 },
    ] },
    options: { animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#8b91a7", boxWidth: 12 } } },
      scales: { x: { ticks: { color: "#8b91a7", maxTicksLimit: 6 }, grid: { color: "#282d40" } },
                y: { ticks: { color: "#8b91a7" }, grid: { color: "#282d40" },
                     title: { display: true, text: "index = 100 at start", color: "#8b91a7" } } } },
  });
}

/* ---------------- per-visitor weights ---------------- */
function saveWeights() { try { localStorage.setItem("fs.weights", JSON.stringify(W)); } catch (e) {} }
function restoreWeights() {
  const q = new URLSearchParams(location.search).get("w");
  let src = q ? atob(q) : localStorage.getItem("fs.weights");
  if (!src) return;
  try {
    const w = JSON.parse(src);
    FACTOR_DEFS.forEach(([k]) => { if (k in w) W[k] = +w[k]; });
    refreshSliders();
  } catch (e) {}
}
function shareView() {
  saveWeights();
  const u = new URL(location.href);
  u.search = "?w=" + btoa(JSON.stringify(W));
  navigator.clipboard.writeText(u.toString())
    .then(() => alert("Link copied — anyone opening it gets your exact ranking."))
    .catch(() => prompt("Copy this link:", u.toString()));
}

function banner(msg, bad) {
  const b = $("#banner");
  b.textContent = msg;
  b.hidden = false;
  b.style.background = bad ? "#3a1414" : "#3a2f14";
  b.style.color = bad ? "var(--bad)" : "var(--amber)";
}
function showStatus(st) {
  if (st && st.ok === false) banner("Last data update failed — showing the previous good numbers." + (st.error ? " " + st.error : ""), true);
}

init();
