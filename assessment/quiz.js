/* Client risk-assessment (part 2 of Fund Selector).
   20 questions, re-rolled in a fresh order every visit; the five answer
   options are always shown in the same fixed order (Strongly disagree
   first, Strongly agree last). 12 forward, 4 reversed (scored against the flow), 4
   distractors (weight 0). Three independent random-detection checks:
   reverse-consistency, same-button bias, and answer speed.
   Flow: quiz -> (one quiet retake if 2+ checks trip) -> consent + details
   -> result (band, personal ranked list, no sliders/weights) -> automatic
   record to the team sheet, with a manual share-code fallback.
*/
const $ = s => document.querySelector(s);

const stages = { landing: $("#landingStage"), quiz: $("#quizStage"),
                 details: $("#detailsStage"), result: $("#resultStage"),
                 review: $("#reviewStage") };
const qBox = $("#qBox");
let CFG = null, AGG = null, META = null;
let QUESTIONS = [], ANSWERS = {}, qIndex = 0, qStart = 0;
let attempt = 1, result = null, flagCount = 0;

const cb = () => "d=" + new Date().toISOString().slice(0, 10);
const shuffle = a => { a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]; }
  return a; };
async function init() {
  const [c, ag, fu] = await Promise.all([
    fetch("config.json?" + cb()).then(r => r.json()),
    fetch("../data/agg.json?" + cb()).then(r => r.json()),
    fetch("../data/funds.json?" + cb()).then(r => r.json()),
  ]);
  CFG = c; AGG = ag; META = fu;
  startQuiz();
}

/* ---------------- quiz flow ---------------- */
function startQuiz() {
  // A fresh random order on every visit (questions are re-rolled), but the
  // five options inside each question are ALWAYS shown in the same fixed
  // order (Strongly disagree -> Strongly agree), so the answer scale reads
  // like a normal rating scale and nobody has to re-learn it question by
  // question.
  QUESTIONS = shuffle(CFG.questions);
  ANSWERS = {};
  qIndex = 0;
  show("landing");
}

function beginQuiz() {
  // Landing page is already showing (questions are pre-shuffled); now run it.
  show("quiz");
  showQuestion(0);
}

function show(name) {
  Object.values(stages).forEach(s => s.hidden = true);
  stages[name].hidden = false;
  window.scrollTo(0, 0);
}

function showQuestion(i) {
  qIndex = i;
  const q = QUESTIONS[i];
  $("#qProgress .lbl").textContent = "Question " + (i + 1) + " of " + QUESTIONS.length;
  // The colored fill is the .bar::before pseudo-element; it reads its width
  // from the --p custom property set here, so the bar visibly grows question
  // by question.
  $("#qProgress .bar").style.setProperty("--p", ((i + 1) / QUESTIONS.length * 100) + "%");
  qBox.innerHTML = `<h2 class="qtext">${q.text}</h2>
    <div class="opts">${q.options.map(([label, points], k) =>
      `<button class="opt" data-k="${k}"><span class="letter">${"ABCDE"[k]}</span>${label}</button>`).join("")}</div>`;
  qBox.querySelectorAll(".opt").forEach(b => b.onclick = () => pick(q, +b.dataset.k));
  qStart = performance.now();
}

function pick(q, k) {
  const opt = q.options[k];
  ANSWERS[q.id] = { points: opt[1], w: q.w, type: q.type, pos: k,
                    ms: performance.now() - qStart };
  qIndex++;
  qIndex < QUESTIONS.length ? showQuestion(qIndex) : finishQuiz();
}

/* ---------------- scoring + random detection ----------------
   Every answer is reduced to one ruler: 0 very cautious … 3 very
   growth-oriented. Reversed questions carry that ruler pre-flipped, so the
   forward and reversed halves of the quiz now ask the same question. */
function checks() {
  const scored = Object.values(ANSWERS).filter(a => a.w > 0);
  const all = Object.values(ANSWERS);
  const mean = arr => arr.reduce((s, x) => s + x, 0) / arr.length;
  const flags = {};
  // 1 — reverse consistency: a real person's forward and reversed answers
  // cluster together; a guesser's scatter.
  const fwd = scored.filter(a => a.type === "f"),
        rev = scored.filter(a => a.type === "r");
  if (fwd.length && rev.length)
    flags.reverse = Math.abs(mean(fwd.map(a => a.points)) -
                             mean(rev.map(a => a.points))) > CFG.reverse_gap_flag;
  // 2 — same-button bias: no careful person clicks the same one position
  // (e.g. always "Agree") on most of the scoring questions.
  const counts = {};
  scored.forEach(a => counts[a.pos] = (counts[a.pos] || 0) + 1);
  flags.sameButton = scored.length &&
    Math.max(...Object.values(counts)) / scored.length > CFG.same_button_share;
  // 3 — speed: a question that needs reading takes more than a couple of
  // seconds to read; faster means scrolling.
  const fast = all.filter(a => a.ms < CFG.speed_ms).length;
  flags.speed = fast / all.length > CFG.speed_flag_share;
  return flags;
}

function riskScore() {
  // 1-5 ruler: 1 very cautious … 5 very bold (reversed items already carry
  // the flipped values in the config). Neutral = 3 sits at 50.
  const lo = CFG.scale_min, hi = CFG.scale_max;
  const scored = Object.values(ANSWERS).filter(a => a.w > 0);
  let num = 0, den = 0;
  scored.forEach(a => { num += a.points * a.w; den += a.w; });
  if (!den) return 0;
  const avg = num / den;
  return Math.round((avg - lo) / (hi - lo) * 1000) / 10;
}

function bandOf(score) {
  return CFG.bands.find(b => score >= b.min && score <= b.max) ||
         CFG.bands[CFG.bands.length - 1];
}

/* The parameter weights come from a formula, not a hand-picked table:
   weight = base + slope x G,  G = risk score / 100 (0 very cautious,
   1 very growth-oriented). Calmness falls exactly as growth rises
   (vol -50 vs cagr +30, sharpe steady), so a cautious client's list is
   built on calm, a growth client's on returns, and everyone between is
   on the straight line between. Weights are floored at 0, rounded to the
   slider step, and the remainder lands on the two load-bearing params
   (sharpe, then ir) so they always total 100. */
function formulaWeights(score) {
  const G = score / 100;
  const P = CFG.weight_formula ? CFG.weight_formula.params : null;
  if (!P) return bandOf(score).weights;   // fall back to the band table
  const step = CFG.weight_formula.round_to || 5;
  const w = {};
  let total = 0;
  for (const k of Object.keys(P)) {
    const raw = P[k].base + P[k].slope * G;
    w[k] = Math.max(0, Math.round(raw / step) * step);
    total += w[k];
  }
  let drift = 100 - total;
  for (const key of ["sharpe", "ir"]) {          // absorb rounding on the stable params
    if (drift === 0) break;
    const take = Math.min(drift, w[key] + step); // never push a param past a sensible max
    w[key] = Math.max(0, w[key] + take);
    drift -= take;
  }
  if (drift !== 0) w.sharpe += drift;            // last-resort sink
  return w;
}

function finishQuiz() {
  const flags = checks();
  flagCount = Object.values(flags).filter(Boolean).length;
  if (flagCount >= 2 && attempt === 1) {
    // One calm second look — the whole quiz, reshuffled, before we decide.
    show("review");
    $("#reviewNote").textContent = "A few of your answers don't quite add up with each other. " +
      "That's usually just a question worth a proper answer — let's look at the set again.";
    $("#tryAgain").hidden = false;
    $("#tryAgain").textContent = "Look at them again";
    $("#tryAgain").onclick = () => { attempt = 2; startQuiz(); beginQuiz(); };
    return;
  }
  const sc = riskScore();
  result = { score: sc, band: bandOf(sc), weights: formulaWeights(sc),
             confidence: flagCount === 0 ? "clean"
                       : flagCount === 1 ? "low" : "needs-review" };
  if (result.confidence === "needs-review") {
    show("review");
    $("#reviewNote").textContent = "These answers don't quite fit together, and re-reading " +
      "them didn't change that. Your team would rather walk through this with you personally " +
      "than hand you a list — that's how the record we keep stays useful to both of you.";
    $("#tryAgain").hidden = true;
    return;
  }
  show("details");
}

/* ---------------- record + result ---------------- */
function shareCode() {
  // The client-facing code encodes the client's personal weight profile,
  // computed by the formula from their risk score. It is the exact string
  // the main site's "?w=" reader expects, so opening main/?w=<code>
  // reproduces that client's personalised ranking — while the numbers are
  // never shown to the client. Provenance (band, score, time, name, number,
  // weights) is captured in the team record.
  return btoa(JSON.stringify(result.weights));
}

async function autoRecord(code, name, phone) {
  if (!CFG.record_endpoint) return false;
  const body = JSON.stringify({ ts: new Date().toISOString(), name, phone,
                                code, band: result.band.name, score: result.score,
                                weights: result.weights, confidence: result.confidence });
  for (let i = 0; i < CFG.auto_record_attempts; i++) {
    try {
      // Google Apps Script web app: POST the JSON as text/plain, no-cors.
      await fetch(CFG.record_endpoint, { method: "POST", body, mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" } });
      return true;   // no-cors: an unresolved reject is all we can see
    } catch (e) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  return false;
}

function buildClientFunds() {
  const MIN_AGE = 4.75;                    // the 5-year model only
  return META.funds.map(f => {
    const rec = AGG.funds[f.code];
    const s = rec && rec["5y"];
    if (!s) return null;
    return { code: f.code, name: f.name, amc: f.amc || "",
             cat: f.category || "Uncategorised",
             s: { ...s, ir: s.info, er: rec.er != null ? rec.er : null },
             age: rec.ageYrs != null ? rec.ageYrs : s.n / 250 };
  }).filter(f => f && f.age >= MIN_AGE);
}

function rankForClient(funds, weights) {
  // Same within-pool rank engine as the main site; directions come from the
  // shared factor_defs in data/funds.json, so a missing value takes the
  // pool's neutral average instead of skewing anyone.
  const defs = META.factor_defs || {};
  const key = k => defs[k] ? defs[k].dir : (k === "er" || k === "vol" ||
                                            k === "beta" || k === "tracking" ? "low" : "high");
  const active = Object.keys(weights).filter(k => weights[k] > 0);
  const qual = {};
  for (const k of active) {
    const vals = funds.map(f => (f.s[k] == null || !isFinite(f.s[k])) ? null : +f.s[k]);
    const m = vals.filter(v => v != null).length;
    const q = new Array(funds.length).fill(50);
    if (m) {
      const ord = [...funds.keys()].filter(i => vals[i] != null)
        .sort((a, b) => key(k) === "high" ? vals[b] - vals[a] : vals[a] - vals[b]);
      ord.forEach((idx, r) => q[idx] = Math.round((m - r) / m * 1000) / 10);
      const neutral = Math.round(ord.reduce((s, i) => s + q[i], 0) / m * 10) / 10;
      funds.forEach((f, i) => { if (vals[i] == null) q[i] = neutral; });
    }
    qual[k] = q;
  }
  const wsum = active.reduce((s, k) => s + weights[k], 0) || 1;
  funds.forEach((f, i) => {
    f.quality = {};
    for (const k of active) f.quality[k] = qual[k][i];
    f.score = Math.round(active.reduce((s, k) => s + weights[k] * qual[k][i], 0) / wsum * 100) / 100;
  });
  funds.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  funds.forEach((f, i) => f.rank = i + 1);
  return funds;
}

/* What the client sees: one plain line about *them*, then one winner from
   each of five fixed categories (the highest-scoring fund in that category
   under the client's personal weights), each with a short, kid-English "why
   we picked it". No scores, no weights, no risk numbers anywhere on this
   screen — those stay on the team's side. */
const CLIENT_CATEGORIES = ["Large cap", "Large & Mid cap", "Mid cap",
                          "Small cap", "Flexi/Multi cap"];
function showResult(code, recorded) {
  const list = rankForClient(buildClientFunds(), result.weights);
  // list is sorted by the client's personal score, so the first fund that
  // matches a category is that category's winner
  const picks = CLIENT_CATEGORIES
    .map(cat => list.find(f => f.cat === cat))
    .filter(Boolean);
  $("#bandName").textContent = "You're " + (result.band.client_label || result.band.name) + ".";
  $("#bandLine").textContent = result.band.client_style || "";
  $("#top5").innerHTML = pickCards(picks);
  $("#codeBox").hidden = recorded;
  if (!recorded) {
    $("#codeVal").textContent = code;
    $("#codeNote").textContent = "We couldn't write your record automatically just now. " +
      "Send this code to your team and your personalised list follows: " +
      codeLink(code);
    $("#copyBtn").onclick = () => {
      navigator.clipboard.writeText($("#codeVal").textContent + "\n" + codeLink(code))
        .then(() => $("#copyBtn").textContent = "Copied")
        .catch(() => prompt("Copy this:", code));
      setTimeout(() => $("#copyBtn").textContent = "Copy code & link", 1500);
    };
  }
  show("result");
}
function codeLink(code) {
  return new URL("../", location.href).href + "?w=" + code;
}
/* The "why we picked it" lines. Every reason is a real fact from this fund's
   own ranking numbers (beats ~X% of its class on ...), written so a ten-year-
   old follows it. A gentle "good to know" closes each card. */
const KID_STRENGTH = {
  cagr:   f => f.s.cagr != null ? `Grew about ${Math.round(f.s.cagr*100)}% every year for the last 5 years — faster than most others in its group.` : "",
  vol:    f => "It's calm — it doesn't swing up and down the way some funds do.",
  sharpe: f => "It gets ahead of the market without taking big swings to do it.",
  selnet: f => "The people who run it are good at picking the right stocks.",
  ir:     f => "Its managers make money ahead of the market, year after year.",
  beta:   f => "When the market shakes, this one barely moves.",
  er:     f => "It's one of the cheapest funds to keep around in its group.",
  tracking: f => "It keeps to a steady rhythm instead of jumping around.",
};
// Non-generic strength lines are used at most once across the five cards,
// so the list never reads like one sentence copy-pasted five times
// (the CAGR line carries its own number, so it may repeat).
const KID_CATEGORY = {
  "Small cap": "It invests in smaller companies, which move the most — so in a bad year it can dip more than the big ones.",
  "Mid cap": "It's a bit wilder than the big steady funds, so expect it to bounce around more.",
  "Large & Mid cap": "It mixes the big steady companies with some smaller, faster-growing ones — a bit of both worlds.",
  "Large cap": "It holds the biggest, most famous companies, so it moves less dramatically than the small ones.",
  "Multi asset": "It splits its money between stocks and safe debts, so it's steadier — but it won't jump as high in a great year.",
  "Flexi/Multi cap": "It spreads out over many companies, which helps, but it can't fully hide when the market falls.",
  "Balanced/Hybrid": "It mixes calm parts with growth parts, so it rarely goes to either extreme.",
  "ELSS (tax saver)": "Money stays in this fund for 3 years — you can't pull it out before that.",
};
function pickCards(list) {
  const usedLines = new Set();   // keep the five cards from repeating a sentence
  return `<div class="picks">` + list.map((f, i) => {
    // Reason 1: the fund's strongest own fact (its CAGR carries a real number).
    const cagrLine = KID_STRENGTH.cagr(f);
    // Reason 2: one of its data-backed strength lines, not yet used on card 1.
    const alt = Object.entries(f.quality || {})
      .filter(([k, q]) => k !== "cagr" && q >= 55 && KID_STRENGTH[k] &&
                          !usedLines.has(KID_STRENGTH[k](f)))
      .sort((a, b) => b[1] - a[1])[0];
    const r1 = cagrLine || KID_STRENGTH.vol(f);
    const r2 = alt ? KID_STRENGTH[alt[0]](f)
         : KID_STRENGTH[Object.keys(KID_STRENGTH).find(k => k !== "vol")](f);
    usedLines.add(r1); usedLines.add(r2);
    const extra = f.age >= 7
      ? `<p>A long, proven track record — ${Math.round(f.age)} years of history, through ups and downs.</p>` : "";
    const gtn = KID_CATEGORY[f.cat] || KID_CATEGORY["Large cap"];
    return `<div class="pickcard">
      <div class="pick-head"><span class="pick-num">${i+1}</span>
        <b>${f.name}</b><span class="pick-cat">${f.cat}</span></div>
      <div class="pick-why"><p>${r1}</p><p>${r2}</p>${extra}</div>
      <div class="pick-gtn"><b>Good to know:</b> ${gtn}</div>
    </div>`;
  }).join("") + `</div>`;
}

function wireDetails() {
  $("#startQuizBtn").onclick = beginQuiz;
  $("#backHome").onclick = startQuiz;      // fresh shuffle + back to the landing page
  $("#doAgain").onclick = startQuiz;       // retake = fresh shuffle + landing page
  $("#submitRec").onclick = async () => {
    const name = $("#inName").value.trim();
    const phone = $("#inMobile").value.replace(/\D/g, "");
    if (!$("#inConsent").checked)
      return alert("Please tick the consent box — your team keeps these records only privately.");
    if (name.length < 2) return alert("Please add your name.");
    if (phone.length !== 10)
      return alert("Please add your 10-digit number (without the country code).");
    const code = shareCode();
    $("#submitRec").disabled = true;
    $("#submitRec").textContent = "Saving…";
    const recorded = await autoRecord(code, name, phone);
    $("#submitRec").disabled = false;
    $("#submitRec").textContent = "Save & see my result";
    showResult(code, recorded);
  };
  $("#skipRec").onclick = () => showResult(shareCode(), false);
}

init().then(wireDetails).catch(e =>
  alert("Could not start the assessment: " + e.message));
