/* Client risk-assessment (part 2 of Fund Selector).
   20 questions, re-rolled in a fresh order every visit, option order rotated
   per question. 12 forward, 4 reversed (scored against the flow), 4
   distractors (weight 0). Three independent random-detection checks:
   reverse-consistency, same-button bias, and answer speed.
   Flow: quiz -> (one quiet retake if 2+ checks trip) -> consent + details
   -> result (band, personal ranked list, no sliders/weights) -> automatic
   record to the team sheet, with a manual share-code fallback.
*/
const $ = s => document.querySelector(s);

const stages = { quiz: $("#quizStage"), details: $("#detailsStage"),
                 result: $("#resultStage"), review: $("#reviewStage") };
const qBox = $("#qBox");
let CFG = null, AGG = null, META = null;
let QUESTIONS = [], ANSWERS = {}, qIndex = 0, qStart = 0;
let attempt = 1, result = null, flagCount = 0;

const cb = () => "d=" + new Date().toISOString().slice(0, 10);
const shuffle = a => { a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]; }
  return a; };
const rotate = (a, n) => { n %= a.length; return a.slice(n).concat(a.slice(0, n)); };

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
  // A fresh random order on every visit; the four options inside each
  // question are also rotated, so "always click the top one" stops working
  // and no question looks like a "safe" one to game.
  QUESTIONS = shuffle(CFG.questions).map(q =>
    ({ ...q, options: rotate(q.options, Math.floor(Math.random() * 4)) }));
  ANSWERS = {};
  qIndex = 0;
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
  $("#qProgress .bar").style.width = ((i + 1) / QUESTIONS.length * 100) + "%";
  qBox.innerHTML = `<h2 class="qtext">${q.text}</h2>
    <div class="opts">${q.options.map(([label, points], k) =>
      `<button class="opt" data-k="${k}"><span class="letter">${"ABCD"[k]}</span>${label}</button>`).join("")}</div>`;
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
  // 2 — same-button bias: no careful person clicks one position on most
  // of the scoring questions (options are rotated, so "top of the screen").
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
  const scored = Object.values(ANSWERS).filter(a => a.w > 0);
  let num = 0, den = 0;
  scored.forEach(a => { num += a.points * a.w; den += 3 * a.w; });
  return den ? Math.round(num / den * 1000) / 10 : 0;
}

function bandOf(score) {
  return CFG.bands.find(b => score >= b.min && score <= b.max) ||
         CFG.bands[CFG.bands.length - 1];
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
    $("#tryAgain").onclick = () => { attempt = 2; startQuiz(); };
    return;
  }
  result = { score: riskScore(), band: bandOf(riskScore()),
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
  // The client-facing code encodes only the team's weight profile for this
  // band. It is the exact string the main site's "?w=" reader expects (its
  // factor keys at the top level), so opening main/?w=<code> reproduces the
  // client's personalised ranking — while the numbers themselves are never
  // shown to the client. Provenance (band, score, time, name, number) is
  // captured separately in the team record.
  return btoa(JSON.stringify(result.band.weights));
}

async function autoRecord(code, name, phone) {
  if (!CFG.record_endpoint) return false;
  const body = JSON.stringify({ ts: new Date().toISOString(), name, phone,
                                code, band: result.band.name, score: result.score,
                                confidence: result.confidence });
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
    f.score = Math.round(active.reduce((s, k) => s + weights[k] * qual[k][i], 0) / wsum * 100) / 100;
  });
  funds.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  funds.forEach((f, i) => f.rank = i + 1);
  return funds;
}

function showResult(code, recorded) {
  const list = rankForClient(buildClientFunds(), result.band.weights);
  $("#bandName").textContent = result.band.name + "  ·  " + result.score + " / 100";
  $("#bandLine").textContent = "Here's how the funds line up for people like you — their 5-year " +
    "record, re-checked every night. A lower number on the right is a steadier, calmer fund; " +
    "a higher one chases more growth.";
  $("#top5").innerHTML = fundTable(list.slice(0, 5));
  $("#fullList").innerHTML = fundTable(list);
  $("#fullBtn").onclick = () => { $("#fullList").hidden = !$("#fullList").hidden;
    $("#fullBtn").textContent = $("#fullList").hidden ? "View the full ranked list" : "Hide the full list"; };
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
function fundTable(list) {
  return `<table class="ftable"><tr><th class="l">#</th><th class="l">Fund</th><th class="l">Category</th><th>Score</th></tr>` +
    list.map(f => `<tr><td class="l">${f.rank === 1 ? "★ " : ""}${f.rank}</td>` +
      `<td class="l">${f.name}<small class="mut">${f.amc}</small></td>` +
      `<td class="l mut">${f.cat}</td><td>${f.score.toFixed(1)}</td></tr>`).join("") + "</table>";
}

function wireDetails() {
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
