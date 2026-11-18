import { firebaseConfig } from "./firebase-config.js?v=26";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, collection, onSnapshot, setDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

const S = {
  races: [], config: { players: ["Tautvydas","Vitalija","Vitalis"], scoring: {
    individual: { exact: [6,5,4,3,3,3], adjacent: 2, inTop6: 1, podiumBonus: 2, top6Bonus: 2 },
    team: { exact: [4,3,3,2,2,2], adjacent: 1, inTop6: 0, podiumBonus: 1, top6Bonus: 1 },
    championshipMultiplier: 1.5 }, rulesNote: "" },
  user: null, myName: null, claims: {}, picks: {}, bonus: {}, questions: [], open: new Set(), unsub: []
};

// ---------- helpers ----------
const players = () => S.config.players;
const isLocked = r => Date.now() >= Date.parse(r.start);
const hasResult = r => Array.isArray(r.result) && r.result.length > 0;
const fmtTime = iso => {
  const d = new Date(iso);
  return d.toLocaleDateString("lt-LT", { weekday: "short", month: "short", day: "numeric" }) + " " +
         d.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" });
};
// pick doc for player name; returns {picks, late} or undefined
function pickOf(race, name) {
  const uid = S.claims[name]; if (!uid) return undefined;
  const p = S.picks[race.id + "__" + uid]; if (!p) return undefined;
  const ts = p.updatedAt && p.updatedAt.toMillis ? p.updatedAt.toMillis() : null;
  return { picks: p.picks || [], ltu: p.ltu || null, late: ts != null && ts >= Date.parse(race.start) };
}
// "Dale-Skjevdal" turi sutapti su "Johannes DALE-SKJEVDAL"
function same(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 4 && (l.endsWith(" " + s) || l.startsWith(s + " "));
}
const isChamp = r => r.championship === true || /čempionat/i.test(r.stage || "");
const raceMult = r => isChamp(r) ? (S.config.scoring.championshipMultiplier || 1) : 1;
const fmtPts = x => (Math.round(x * 10) / 10).toString().replace(".", ",");
// 🇱🇹 geriausio lietuvio vieta: kuo siauresnis intervalas – tuo daugiau taškų
const LTU_TIERS = {
  // top: 99 = „už top'o / nebaigs“
  individual: [{ top: 10, pts: 10 }, { top: 20, pts: 6 }, { top: 30, pts: 4 }, { top: 40, pts: 2 }, { top: 60, pts: 1 }, { top: 99, pts: 1, out: 60 }],
  team: [{ top: 10, pts: 8 }, { top: 15, pts: 4 }, { top: 18, pts: 2 }, { top: 20, pts: 1 }, { top: 99, pts: 2, out: 20 }],
};
const tierLabel = t => t.out ? `Už top ${t.out}` : `Top ${t.top}`;
const ltuTiers = r => r.team ? LTU_TIERS.team : LTU_TIERS.individual;
const hasLTU = r => (r.startlist || []).some(a => a.nat === "LTU" || /lietuv|lithuan/i.test(a.name));
function ltuPoints(race, pk) {
  if (!pk || pk.late || !pk.ltu || race.ltuPlace == null) return 0;
  const t = ltuTiers(race).find(x => x.top === pk.ltu.top); if (!t) return 0;
  const place = race.ltuPlace;
  if (t.out) return (typeof place !== "number" || place > t.out) ? t.pts : 0;  // „–“ = nė vienas nebaigė
  return typeof place === "number" && place <= t.top ? t.pts : 0;
}
// marks: exact | adj | top | ""
function score(race, pk) {
  const sc = race.team ? S.config.scoring.team : S.config.scoring.individual;
  const res = (race.result || []).slice(0, 6);
  if (!pk || pk.late || !res.length) return { pts: 0, marks: [], bonus: [] };
  let pts = 0; const marks = [], bonus = [];
  pk.picks.forEach((p, i) => {
    let m = "";
    const j = p ? res.findIndex(r => same(p, r)) : -1;
    if (j === i) { pts += sc.exact[i] || 0; m = "exact"; }
    else if (j >= 0 && Math.abs(j - i) === 1) { pts += sc.adjacent; m = "adj"; }
    else if (j >= 0) { pts += sc.inTop6; m = "top"; }
    marks.push(m);
  });
  if (res.length >= 3 && [0,1,2].every(i => marks[i] === "exact")) { pts += sc.podiumBonus; bonus.push(`podiumas +${sc.podiumBonus}`); }
  if (res.length >= 6 && marks.filter(Boolean).length === 6) { pts += sc.top6Bonus; bonus.push(`visas top-6 +${sc.top6Bonus}`); }
  const ltu = ltuPoints(race, pk);
  const mult = raceMult(race);
  return { pts: (pts + ltu) * mult, marks, bonus, mult, ltu: ltu * mult };
}
function showOnly(id) {
  ["auth", "claim"].forEach(x => $("#" + x).classList.toggle("hidden", x !== id));
  const inApp = id === "app";
  $("#app").classList.toggle("hidden", !inApp);
  $("#nav").classList.toggle("hidden", !inApp);
}
function status(text) { const s = $("#status"); s.textContent = text || ""; s.classList.toggle("hidden", !text); }

// ---------- data from repo ----------
async function loadJson(path) {
  const r = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(path);
  return r.json();
}
async function loadRaces() {
  try {
    const [races, cfg] = await Promise.all([loadJson("data/races.json"), loadJson("data/config.json").catch(() => null)]);
    S.races = races.races || [];
    S.questions = races.questions || [];
    if (cfg) S.config = { ...S.config, ...cfg };
    if (!S.open.size) {
      const next = [...S.races].filter(r => !isLocked(r)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
      if (next) S.open.add(next.id);
    }
    renderAll();
  } catch (e) { status("Nepavyko įkelti rungčių sąrašo."); }
}

// ---------- render ----------
const drafts = {};
function captureDrafts() {
  document.querySelectorAll("form[data-race]").forEach(f => {
    drafts[f.dataset.race] = [0,1,2,3,4,5].map(i => f.elements["p" + i].value);
  });
}

function renderMe() {
  $("#me").innerHTML = S.myName ? `🔒 Prisijungęs kaip <b>${esc(S.myName)}</b>` : "";
  $("#logout").classList.toggle("hidden", !S.user);
}

const stageKey = st => norm(st).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function stagesList() {
  const sorted = [...S.races].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const map = new Map();
  for (const r of sorted) {
    const k = stageKey(r.stage);
    if (!map.has(k)) map.set(k, { key: k, name: r.stage, races: [] });
    map.get(k).races.push(r);
  }
  return [...map.values()];
}
function parseRoute() {
  const m = location.hash.match(/^#s-([^~]+)(?:~(.+))?$/);
  return m ? { stage: m[1], race: m[2] ? decodeURIComponent(m[2]) : null } : null;
}

function renderRaces() {
  captureDrafts();
  const box = $("#tab-races");
  if (!S.races.length) { box.innerHTML = `<div class="card note">Rungčių dar nėra.</div>`; return; }
  const stages = stagesList();
  const route = parseRoute();
  const st = route && stages.find(x => x.key === route.stage);
  $("#nav").classList.toggle("hidden", !!st);
  if (st) {
    ["races", "table", "rules"].forEach(t => $("#tab-" + t).classList.toggle("hidden", t !== "races"));
    box.innerHTML = stageView(st, route.race);
    box.querySelectorAll(".q-opt").forEach(b => b.onclick = () => saveBonus(b));
    wireForms(box); tickCountdowns();
    return;
  }
  box.innerHTML = stages.map(stageCard).join("");
  tickCountdowns();
}

function fmtLeft(ms) {
  if (ms <= 0) return "užrakinta";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d} d. ${h % 24} val.`;
  if (h >= 1) return `${h} val. ${m % 60} min.`;
  const sec = Math.floor(ms / 1000) % 60;
  return `${m}:${String(sec).padStart(2, "0")} min.`;
}
const cd = (iso, prefix = "") => `<span class="cd" data-t="${esc(iso)}" data-p="${esc(prefix)}">${esc(prefix + fmtLeft(Date.parse(iso) - Date.now()))}</span>`;
function tickCountdowns() {
  document.querySelectorAll(".cd").forEach(el => {
    const left = Date.parse(el.dataset.t) - Date.now();
    el.textContent = el.dataset.p + fmtLeft(left);
    el.classList.toggle("urgent", left > 0 && left < 3 * 3600e3);
  });
}

function myState(r) {
  const pk = pickOf(r, S.myName);
  if (hasResult(r)) return { cls: "st-done", label: pk && !pk.late ? `Rezultatai · ${fmtPts(score(r, pk).pts)} t.` : "Rezultatai · nespėta" };
  if (isLocked(r)) return pk && !pk.late ? { cls: "st-picked", label: "🔒 Spėta" } : { cls: "st-locked", label: "🔒 Nespėta" };
  if (pk) return { cls: "st-picked", label: "✓ Spėta" };
  if (!(r.startlist || []).length) return { cls: "st-wait", label: "⏳ Laukiam sąrašo" };
  return { cls: "st-need", label: "✍️ Nespėta" };
}

function stageCard(st) {
  const first = st.races[0], last = st.races[st.races.length - 1];
  const d = iso => new Date(iso).toLocaleDateString("lt-LT", { month: "short", day: "numeric" });
  const allDone = st.races.every(hasResult), anyOpen = st.races.some(r => !isLocked(r));
  const mine = st.races.filter(r => pickOf(r, S.myName)).length;
  const toPick = st.races.filter(r => !isLocked(r) && (r.startlist || []).length && !pickOf(r, S.myName)).length;
  const badge = allDone ? `<span class="badge b-done">Baigtas</span>` : anyOpen ? `<span class="badge b-open">Vyksta / artėja</span>` : `<span class="badge b-live">Laukiam rezultatų</span>`;
  const pts = players().map(p => `<span class="chip">${esc(p)}: ${fmtPts(st.races.reduce((s, r) => s + score(r, pickOf(r, p)).pts, 0) + bonusPoints(questionFor(st), p))} t.</span>`).join("");
  return `<a class="card stage-card" href="#s-${st.key}">
    <div class="race-head"><div>
      <div class="race-title big">${esc(st.name)}</div>
      <div class="race-meta">${d(first.start)} – ${d(last.start)} · ${st.races.length} rungt. · tavo spėjimų ${mine}/${st.races.length}</div>
    </div>${badge}</div>
    <div class="mini-states">${st.races.map(r => { const m = myState(r); return `<span class="mini ${m.cls}" title="${esc(r.name)}">${esc(shortName(r.name))}<b>${esc(m.label)}</b></span>`; }).join("")}</div>
    ${(() => { const q = questionFor(st); if (!q) return ""; const m = bonusOf(q, S.myName); const closed = Date.now() >= Date.parse(qCloses(q));
      return `<div class="q-mini ${m ? "st-picked" : closed ? "st-locked" : "st-need"}">❓ Etapo klausimas: ${m ? "✓ atsakyta" : closed ? "užsidarė" : "✍️ neatsakyta"}</div>`; })()}
    <div class="chips" style="margin-top:10px">${pts}</div>
    ${(() => { const nx = st.races.find(r => !isLocked(r)); return nx ? `<div class="next-lock">⏰ Artimiausia rungtis (${esc(shortName(nx.name))}) užsirakins po ${cd(nx.start)}</div>` : ""; })()}
    ${toPick ? `<div class="to-pick">✍️ Dar nespėjai ${toPick} rungt.</div>` : ""}
  </a>`;
}

function shortName(n) { return n.replace(/\s*\(testas\)/, "").replace(/^Vyrų /, "V ").replace(/^Moterų /, "M "); }
function banner(r) {
  const pk = pickOf(r, S.myName), m = myState(r);
  const raw = S.picks[r.id + "__" + (S.user && S.user.uid)];
  const when = raw && raw.updatedAt && raw.updatedAt.toDate ? raw.updatedAt.toDate().toLocaleString("lt-LT", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  let text;
  if (m.cls === "st-need") text = "✍️ Tu dar nespėjai šios rungties";
  else if (m.cls === "st-wait") text = "⏳ Startų sąrašas dar nepaskelbtas – spėti dar negalima";
  else if (m.cls === "st-locked") text = "🔒 Rungtis prasidėjo – tu nespėjai";
  else if (m.cls === "st-picked") text = isLocked(r) ? "🔒 Tavo spėjimas užfiksuotas" : `✓ Tavo spėjimas pateiktas${when ? " (" + when + ")" : ""} – iki starto dar gali keisti`;
  else text = pk && !pk.late ? `🏁 Rezultatai: surinkai ${fmtPts(score(r, pk).pts)} t.` : "🏁 Rezultatai paskelbti – tu nespėjai";
  const left = !isLocked(r) ? `<div class="banner-cd">⏰ Spėjimą pateikti liko: ${cd(r.start)}</div>` : "";
  return `<div class="banner ${m.cls}">${esc(text)}${left}</div>`;
}

// ❓ etapo papildomas klausimas (+1 t.)
function qCloses(q) {
  const rs = S.races.filter(r => r.stage === q.stage);
  return rs.length ? new Date(Math.min(...rs.map(r => Date.parse(r.start)))).toISOString() : q.closes;
}
function questionFor(st) { return (S.questions || []).find(q => q.stage === st.name); }
function bonusOf(q, name) { const uid = S.claims[name]; return uid ? S.bonus[q.id + "__" + uid] : undefined; }
function bonusPoints(q, name) {
  if (!q || q.answer == null) return 0;
  const b = bonusOf(q, name); if (!b) return 0;
  const ts = b.updatedAt && b.updatedAt.toMillis ? b.updatedAt.toMillis() : null;
  if (ts != null && ts >= Date.parse(qCloses(q))) return 0;
  return b.answer === q.answer ? (q.points || 1) : 0;
}
function questionCard(q) {
  if (!q) return "";
  const closed = Date.now() >= Date.parse(qCloses(q));
  const mine = bonusOf(q, S.myName);
  let h = `<div class="card qcard"><div class="q-head">❓ Etapo klausimas <span class="q-pts">+${q.points || 1} t.</span></div>
    <div class="q-text">${esc(q.q)}</div>`;
  if (!closed) {
    h += `<div class="q-opts">${q.options.map(o => `<button type="button" class="q-opt${mine && mine.answer === o ? " on" : ""}" data-q="${esc(q.id)}" data-a="${esc(o)}">${esc(o)}</button>`).join("")}</div>
      <div class="q-foot">${mine ? `✓ Tavo atsakymas: <b>${esc(mine.answer)}</b> (gali keisti)` : "✍️ Dar neatsakei"} · ⏰ ${cd(qCloses(q), "užsidaro po ")}</div>`;
  } else {
    h += `<div class="q-answers">${players().map(p => { const b = bonusOf(q, p); const ok = q.answer != null && b && b.answer === q.answer;
      return `<div class="q-ans${ok ? " ok" : ""}"><b>${esc(p)}</b>: ${b ? esc(b.answer) : "–"}${ok ? " ✓ +" + (q.points || 1) : ""}</div>`; }).join("")}</div>
      <div class="q-foot">${q.answer != null ? `Teisingas atsakymas: <b>${esc(q.answer)}</b>` : "🔒 Užrakinta – atsakymas paaiškės po etapo"}</div>`;
  }
  return h + `<div class="msg q-msg"></div></div>`;
}
async function saveBonus(btn) {
  const q = S.questions.find(x => x.id === btn.dataset.q); if (!q) return;
  const msg = btn.closest(".qcard").querySelector(".q-msg");
  if (Date.now() >= Date.parse(qCloses(q))) { msg.textContent = "Klausimas jau užsidarė."; return; }
  msg.className = "msg q-msg"; msg.textContent = "Saugoma…";
  try {
    await setDoc(doc(db, "bonus", q.id + "__" + S.user.uid), { uid: S.user.uid, name: S.myName, qid: q.id, answer: btn.dataset.a, updatedAt: serverTimestamp() });
    msg.textContent = "✓ Išsaugota";
  } catch (e) { msg.className = "msg err q-msg"; msg.textContent = "Nepavyko išsaugoti."; }
}

function stageView(st, raceId) {
  let r = raceId && st.races.find(x => x.id === raceId);
  if (!r) r = st.races.find(x => !isLocked(x)) || st.races[st.races.length - 1];
  const tabs = st.races.map(x => {
    const m = myState(x);
    const t = new Date(x.start);
    return `<a class="rtab ${m.cls}${x === r ? " on" : ""}" href="#s-${st.key}~${encodeURIComponent(x.id)}">
      <span class="rtab-name">${esc(x.name)}</span>
      <span class="rtab-time">${t.toLocaleDateString("lt-LT", { weekday: "short", day: "numeric" })} ${t.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })}</span>
      <span class="rtab-state">${esc(m.label)}</span>${!isLocked(x) ? `<span class="rtab-cd">${cd(x.start, "⏰ ")}</span>` : ""}</a>`;
  }).join("");
  const locked = isLocked(r), done = hasResult(r);
  const badge = done ? `<span class="badge b-done">Rezultatai</span>`
    : locked ? `<span class="badge b-live">Užrakinta</span>` : `<span class="badge b-open">Atvira</span>`;
  const chips = players().map(p => {
    const pk = pickOf(r, p);
    if (done && pk) return `<span class="chip ok">${esc(p)}: ${fmtPts(score(r, pk).pts)} t.</span>`;
    return `<span class="chip ${pk && !pk.late ? "ok" : ""}">${esc(p)} ${pk && !pk.late ? "✓" : "–"}</span>`;
  }).join("");
  return `<a class="back" href="#">← Visi etapai</a>
    <div class="stage-title">${esc(st.name)}</div>
    ${questionCard(questionFor(st))}
    <div class="rtabs">${tabs}</div>
    <div class="card">
      <div class="race-head"><div>
        <div class="race-title big">${esc(r.name)}</div>
        <div class="race-meta">${fmtTime(r.start)} (LT laiku)</div></div>${badge}</div>
      ${banner(r)}
      <div class="chips">${chips}</div>
      <div class="body">${raceBody(r, locked, done)}</div>
    </div>`;
}

function flash(el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }

function wireForms(box) {
  box.querySelectorAll("form[data-race]").forEach(f => {
    f.onsubmit = savePicks;
    const race = S.races.find(x => x.id === f.dataset.race);
    const sync = () => {
      if (race && race.team) [0,1,2,3,4,5].forEach(i => {
        const sel = f.elements["p" + i], box = sel.parentElement.querySelector(".members");
        const a = (race.startlist || []).find(x => x.name === sel.value);
        if (box) box.textContent = a && a.members ? a.members.join(" · ") : "";
      });
      // pažymėti jau pasirinktus kitose vietose (rodo, kad pasirinkus jie bus sukeisti)
      const chosen = [0,1,2,3,4,5].map(i => f.elements["p" + i].value);
      [0,1,2,3,4,5].forEach(i => {
        [...f.elements["p" + i].options].forEach(o => {
          if (!o.dataset.base) o.dataset.base = o.textContent;
          const j = o.value ? chosen.indexOf(o.value) : -1;
          o.textContent = j >= 0 && j !== i ? `${o.dataset.base}  ⇄ ${j + 1} vieta` : o.dataset.base;
        });
        f.elements["p" + i].dataset.prev = f.elements["p" + i].value;
      });
      const lst = box.querySelector(`.startlist[data-race="${CSS.escape(f.dataset.race)}"]`);
      if (lst) lst.querySelectorAll(".sl-pick").forEach(row => {
        const j = chosen.indexOf(row.dataset.pick);
        row.classList.toggle("picked", j >= 0);
        row.querySelector(".sl-place").textContent = j >= 0 ? String(j + 1) : "";
      });
    };
    // pasirinkus jau kitoje vietoje esantį – sukeičiam vietomis
    f.addEventListener("change", e => {
      const sel = e.target; if (!sel.name || !sel.name.startsWith("p")) return;
      const i = Number(sel.name.slice(1)), v = sel.value, prev = sel.dataset.prev || "";
      if (v) for (let j = 0; j < 6; j++) {
        if (j !== i && f.elements["p" + j].value === v) { f.elements["p" + j].value = prev; flash(f.elements["p" + j]); }
      }
      sync();
    });
    const list = box.querySelector(`.startlist[data-race="${CSS.escape(f.dataset.race)}"]`);
    const msgEl = f.querySelector(".msg");
    if (list) list.querySelectorAll(".sl-pick").forEach(row => row.onclick = () => {
      const name = row.dataset.pick;
      const sels = [0,1,2,3,4,5].map(i => f.elements["p" + i]);
      const at = sels.findIndex(x => x.value === name);
      if (at >= 0) { sels[at].value = ""; flash(sels[at]); sync(); return; }
      const free = sels.find(x => !x.value);
      if (!free) { msgEl.className = "msg err"; msgEl.textContent = "Visos 6 vietos užimtos – pirma išimk ką nors (paspausk ant jo sąraše)."; return; }
      free.value = name; flash(free); sync();
      msgEl.className = "msg"; msgEl.textContent = "Nepamiršk paspausti „Pateikti spėjimą“.";
    });
    f.querySelectorAll(".mv").forEach(b => b.onclick = () => {
      const i = Number(b.dataset.i), j = i + Number(b.dataset.d);
      if (j < 0 || j > 5) return;
      const a = f.elements["p" + i], c = f.elements["p" + j];
      [a.value, c.value] = [c.value, a.value];
      flash(c); sync();
    });
    sync();
  });
}

function raceBody(r, locked, done) {
  let h = "";
  if (r.note) h += `<div class="note" style="margin-bottom:10px">${esc(r.note)}</div>`;
  if (!locked) {
    if (r.favorites && r.favorites.length) h += `<div class="note" style="margin-bottom:10px">⭐ Favoritai: ${r.favorites.map(esc).join(", ")}</div>`;
    const saved = (pickOf(r, S.myName) || {}).picks || [];
    const mine = drafts[r.id] || saved;
    const sl = [...(r.startlist || [])].sort((a, b) => (Number(a.bib) || 999) - (Number(b.bib) || 999));
    h += `<div class="detail-grid"><div class="col-form">`;
    if (!sl.length) {
      h += `<div class="note">⏳ Startų sąrašas dar nepaskelbtas. Spėti bus galima, kai IBU jį paskelbs (dažniausiai dieną prieš rungtį).</div>`;
    } else {
      const label = a => (a.bib ? "#" + a.bib + " " : "") + a.name + (a.nat && !r.team ? " (" + a.nat + ")" : "") + (a.behind ? " " + a.behind : "");
      h += `<form data-race="${esc(r.id)}"><div class="picks-form">`;
      const membersOf = n => { const a = sl.find(x => x.name === n); return a && a.members && a.members.length ? a.members.join(" · ") : ""; };
      for (let i = 0; i < 6; i++) {
        h += `<label>${i + 1}</label><div><div class="pick-row"><select name="p${i}"><option value="">— pasirink —</option>` +
          sl.map(a => `<option value="${esc(a.name)}"${a.name === mine[i] ? " selected" : ""}>${esc(label(a))}</option>`).join("") +
          `</select><button type="button" class="mv" data-i="${i}" data-d="-1" title="Aukštyn"${i === 0 ? " disabled" : ""}>↑</button>` +
          `<button type="button" class="mv" data-i="${i}" data-d="1" title="Žemyn"${i === 5 ? " disabled" : ""}>↓</button></div>` +
          `${r.team ? `<div class="members">${esc(membersOf(mine[i]))}</div>` : ""}</div>`;
      }
      h += `</div>`;
      if (hasLTU(r)) {
        const myLtu = (pickOf(r, S.myName) || {}).ltu || {};
        const lts = sl.filter(a => a.nat === "LTU" || /lietuv|lithuan/i.test(a.name));
        h += `<div class="ltu-box"><div class="ltu-title">🇱🇹 ${r.team ? "Kur pateks Lietuvos komanda?" : "Kur pateks geriausias lietuvis?"}</div>
          <div class="ltu-who">${lts.map(a => esc((a.bib ? "#" + a.bib + " " : "") + a.name)).join(" · ")}</div>
          <div class="ltu-opts">${ltuTiers(r).map(t => `<label class="ltu-opt"><input type="radio" name="ltuTop" value="${t.top}"${myLtu.top === t.top ? " checked" : ""}><span><b>${tierLabel(t)}</b><small>${t.pts} t.</small></span></label>`).join("")}</div>
          <div class="ltu-hint">Kuo aukštesnę vietą spėji – tuo daugiau taškų, bet didesnė rizika. Taškai, jei ${r.team ? "komanda" : "geriausias lietuvis"} finišuos tame top'e (arba už jo, jei rinkaisi „Už top …“).</div></div>`;
      }
      h += `<button class="btn">${saved.length ? "Atnaujinti spėjimą" : "Pateikti spėjimą"}</button>
        <div class="msg">Spėjimas užsirakina rungties starto metu. Kitų spėjimai matosi tik po starto.</div></form>`;
    }
    h += `</div><div class="col-sl">${startlistBlock(r, true)}</div></div>`;
  } else {
    const sc = players().map(p => ({ pk: pickOf(r, p), s: score(r, pickOf(r, p)) }));
    h += `<table><tr><th>#</th>${players().map(p => `<th>${esc(p)}</th>`).join("")}${done ? "<th>Rezultatas</th>" : ""}</tr>`;
    for (let k = 0; k < 6; k++) {
      h += `<tr><td>${k + 1}</td>` + sc.map(({ pk, s }) => {
        const v = pk ? pk.picks[k] || "" : "";
        const cls = pk && pk.late ? "late" : s.marks[k] === "exact" ? "hit-exact" : s.marks[k] === "adj" ? "hit-adj" : s.marks[k] === "top" ? "hit-top" : "";
        return `<td class="${cls}">${esc(v) || "–"}</td>`;
      }).join("") + (done ? `<td><b>${esc(r.result[k] || "")}</b></td>` : "") + `</tr>`;
    }
    if (sc.some(x => x.pk && x.pk.ltu) || typeof r.ltuPlace === "number") {
      h += `<tr class="ltu-tr"><td>🇱🇹</td>` + sc.map(({ pk, s }) => {
        const l = pk && pk.ltu; if (!l) return `<td>–</td>`;
        const t = ltuTiers(r).find(x => x.top === l.top);
        const ok = done && s.ltu > 0;
        return `<td class="${ok ? "hit-exact" : ""}">${t ? tierLabel(t) : "?"}${done ? ` (${fmtPts(s.ltu)})` : ` · ${t ? t.pts : "?"} t.`}</td>`;
      }).join("") + (done ? `<td><b>${typeof r.ltuPlace === "number" ? r.ltuPlace + " vt." : "–"}</b></td>` : "") + `</tr>`;
    }
    if (done) h += `<tr><td></td>${sc.map(x => `<td class="pts">${fmtPts(x.s.pts)} t.</td>`).join("")}<td></td></tr>`;
    h += `</table>`;
    if (done) {
      const bon = sc.map((x, i) => x.s.bonus.length ? `${esc(players()[i])}: ${x.s.bonus.join(", ")}` : "").filter(Boolean);
      if (bon.length) h += `<div class="msg">🎁 Bonusai – ${bon.join(" · ")}</div>`;
      h += `<div class="msg"><span class="hit-exact">Žalia</span> – tiksli vieta, <span class="hit-adj">mėlyna</span> – per vieną vietą, <span class="hit-top">auksinė</span> – pateko į top-6.${isChamp(r) ? " Taškai ×" + fmtPts(raceMult(r)) + " (čempionatas)." : ""}</div>`;
    }
    if (sc.some(x => x.pk && x.pk.late)) h += `<div class="msg"><span class="late">Perbraukta</span> – spėjimas pakeistas po starto, neskaičiuojamas.</div>`;
    h += startlistBlock(r, false);
  }
  return h;
}

function startlistBlock(r, open) {
  const sl = [...(r.startlist || [])].sort((a, b) => (Number(a.bib) || 999) - (Number(b.bib) || 999));
  if (!sl.length) return "";
  const pursuit = sl.some(a => a.behind);
  const rows = sl.map(a => {
    if (r.team) {
      const mem = (a.members || []).length
        ? `<ol class="sl-members">${a.members.map(m => `<li>${esc(m)}</li>`).join("")}</ol>`
        : `<div class="sl-sub">sudėtis dar neskelbta</div>`;
      return `<div class="sl-team sl-pick" data-pick="${esc(a.name)}"><div class="sl-row"><span class="sl-place"></span><span class="sl-bib">${esc(a.bib ?? "")}</span><span class="sl-name">${esc(a.name)}</span><span class="sl-nat">${esc(a.nat || "")}</span></div>${mem}</div>`;
    }
    return `<div class="sl-row sl-pick" data-pick="${esc(a.name)}"><span class="sl-place"></span><span class="sl-bib">${esc(a.bib ?? "")}</span><span class="sl-name">${esc(a.name)}</span><span class="sl-nat">${esc(a.nat || "")}</span>${pursuit ? `<span class="sl-behind">${esc(a.behind || "")}</span>` : ""}</div>`;
  }).join("");
  const title = r.team ? `Komandos ir sudėtys (${sl.length})` : `Startų sąrašas (${sl.length})${pursuit ? " · atsilikimas starte" : ""}`;
  const hint = open && !isLocked(r) ? `<div class="sl-hint">👆 Paspausk ant sportininko – jis įkeliamas į pirmą laisvą vietą. Paspaudus dar kartą – išimamas.</div>` : "";
  return `<details class="startlist" data-race="${esc(r.id)}"${open ? " open" : ""}><summary>${title}</summary>${hint}<div class="sl-box">${rows}</div></details>`;
}

function renderTable() {
  const ps = players();
  const tot = ps.map(p => ({ name: p, pts: 0, races: 0, exact: 0, adj: 0, top: 0, raceWins: 0, stageWins: 0 }));
  const doneRaces = S.races.filter(hasResult).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const r of doneRaces) {
    const sc = ps.map(p => score(r, pickOf(r, p)));
    const best = Math.max(...sc.map(s => s.pts));
    sc.forEach((s, i) => {
      const pk = pickOf(r, ps[i]); if (pk && !pk.late) tot[i].races++;
      tot[i].pts += s.pts;
      tot[i].exact += s.marks.filter(m => m === "exact").length;
      tot[i].adj += s.marks.filter(m => m === "adj").length;
      tot[i].top += s.marks.filter(m => m === "top").length;
      if (s.ltu > 0) tot[i].ltuHits = (tot[i].ltuHits || 0) + 1;
      if (best > 0 && s.pts === best) tot[i].raceWins++;
    });
  }
  // etapų statistika
  const allStages = stagesList();
  const stages = allStages.filter(st => st.races.some(hasResult));
  const stageRows = stages.map(st => {
    const q = questionFor(st);
    const pts = ps.map(p => st.races.reduce((a, r) => a + score(r, pickOf(r, p)).pts, 0) + bonusPoints(q, p));
    ps.forEach((p, i) => { const b = bonusPoints(q, p); tot[i].pts += b; if (b) tot[i].qHits = (tot[i].qHits || 0) + 1; });
    const complete = st.races.every(hasResult);
    const best = Math.max(...pts);
    const winners = complete && best > 0 ? ps.filter((p, i) => pts[i] === best) : [];
    winners.forEach(w => tot[ps.indexOf(w)].stageWins++);
    return { st, pts, complete, winners, done: st.races.filter(hasResult).length };
  });
  const ranked = [...tot].sort((a, b) => b.pts - a.pts || b.stageWins - a.stageWins || b.exact - a.exact);
  // pagrindinė lentelė: žaidėjai × etapai
  const short = n => (n.split("·").pop() || n).replace(/\s*\([A-Z]{3}\)\s*/, "").replace(/\s*\(bus ištrinta\)/i, "").trim();
  const byKey = new Map(stageRows.map(x => [x.st.key, x]));
  let h = `<div class="card"><h3 style="margin:0 0 8px">Taškai per etapus</h3><div class="mx-wrap"><table class="mx">
    <tr><th class="mx-name">#</th><th class="mx-name">Žaidėjas</th>${allStages.map(st => `<th title="${esc(st.name)}">${esc(short(st.name))}${isChamp(st.races[0]) ? " ×1,5" : ""}</th>`).join("")}<th class="mx-tot">Viso</th></tr>
    ${ranked.map((t, k) => { const i = ps.indexOf(t.name); return `<tr><td>${k + 1}</td><td class="mx-name"><b>${esc(t.name)}</b></td>${allStages.map(st => {
      const x = byKey.get(st.key);
      if (!x) return `<td class="mx-empty">–</td>`;
      const win = x.winners.includes(t.name);
      return `<td class="${win ? "mx-win" : ""}${x.complete ? "" : " mx-live"}">${win ? "🏆 " : ""}${fmtPts(x.pts[i])}</td>`;
    }).join("")}<td class="mx-tot">${fmtPts(t.pts)}</td></tr>`; }).join("")}
  </table></div><div class="note" style="margin-top:6px">🏆 – etapo nugalėtojas · pasvirai – etapas dar vyksta · „–“ – dar nėra rezultatų</div></div>`;
  h += `<div class="card">${ranked.map((t, k) => `<div class="lb-row"><div class="lb-pos">${k + 1}</div>
    <div class="lb-name">${esc(t.name)}<div class="lb-sub">🏆 etapų laimėta: <b>${t.stageWins}</b> · rungčių laimėta: ${t.raceWins} · ${t.races} rungt.<br>🎯 tikslūs: ${t.exact} · per vieną: ${t.adj} · top-6: ${t.top} · 🇱🇹 ${t.ltuHits || 0} · ❓ ${t.qHits || 0}</div></div>
    <div class="lb-pts">${fmtPts(t.pts)}</div></div>`).join("")}
    <div class="note" style="margin-top:6px">Lygių taškų atveju aukščiau – laimėjęs daugiau etapų, po to – daugiau tikslių pataikymų.</div></div>`;
  if (stageRows.length) {
    h += `<div class="card"><h3 style="margin:0 0 8px">Rungtys</h3><table><tr><th>Rungtis</th>${ps.map(p => `<th style="text-align:right">${esc(p)}</th>`).join("")}</tr>`;
    for (const r of [...doneRaces].reverse())
      h += `<tr><td>${esc(r.name)}<div class="race-meta">${esc(r.stage)}${isChamp(r) ? " · ×" + fmtPts(raceMult(r)) : ""}</div></td>${ps.map(p => `<td class="pts">${fmtPts(score(r, pickOf(r, p)).pts)}</td>`).join("")}</tr>`;
    h += `</table></div>`;
  } else h += `<div class="note" style="padding:4px">Rezultatų dar nėra – lentelė pildysis po pirmų rungčių.</div>`;
  $("#tab-table").innerHTML = h;
}

function renderRules() {
  const I = S.config.scoring.individual, T = S.config.scoring.team, M = S.config.scoring.championshipMultiplier;
  const col = (x, i) => x.exact[i];
  $("#tab-rules").innerHTML = `<div class="card">
    <h3 style="margin-top:0">Kaip žaidžiam</h3>
    <ul>
      <li>Kiekvienai rungčiai kiekvienas spėja <b>top-6</b> (1–6 vietos), renkantis iš startų sąrašo.</li>
      <li>Spėjimą galima keisti iki starto. Po starto pasimato visų spėjimai; po starto pakeistas spėjimas neskaičiuojamas.</li>
      <li>Estafetėse spėjamos šalys.</li>
      <li>Startų sąrašai ir rezultatai – iš IBU (biathlonworld.com).</li>
    </ul>
    <h3>Taškai</h3>
    <table class="rules-t">
      <tr><th>Spėjimas</th><th style="text-align:right">Individualios</th><th style="text-align:right">Estafetės</th></tr>
      <tr><td>Tiksli 1 vieta</td><td class="pts">${col(I,0)}</td><td class="pts">${col(T,0)}</td></tr>
      <tr><td>Tiksli 2 vieta</td><td class="pts">${col(I,1)}</td><td class="pts">${col(T,1)}</td></tr>
      <tr><td>Tiksli 3 vieta</td><td class="pts">${col(I,2)}</td><td class="pts">${col(T,2)}</td></tr>
      <tr><td>Tiksli 4–6 vieta</td><td class="pts">${col(I,3)}</td><td class="pts">${col(T,3)}</td></tr>
      <tr><td>Per vieną vietą (pvz. spėjai 2, baigė 1)</td><td class="pts">${I.adjacent}</td><td class="pts">${T.adjacent}</td></tr>
      <tr><td>Pateko į top-6, bet toliau</td><td class="pts">${I.inTop6}</td><td class="pts">${T.inTop6}</td></tr>
      <tr><td>🎁 Visas podiumas (1–3) tiksliai</td><td class="pts">+${I.podiumBonus}</td><td class="pts">+${T.podiumBonus}</td></tr>
      <tr><td>🎁 Visi 6 pateko į top-6</td><td class="pts">+${I.top6Bonus}</td><td class="pts">+${T.top6Bonus}</td></tr>
    </table>
    <ul>
      <li>Jei spėtas sportininkas baigė 7-as ar žemiau – 0 taškų.</li>
      <li>Pasaulio čempionato rungtims taškai dauginami iš <b>${fmtPts(M)}</b>.</li>
      <li>Lentelėje lygių taškų atveju aukščiau tas, kas <b>laimėjo daugiau etapų</b> (daugiausiai taškų etape), po to – daugiau tikslių pataikymų.</li>
    </ul>
    <h3>🇱🇹 Geriausias lietuvis</h3>
    <div class="note">Kiekvienoje rungtyje, kurioje startuoja lietuviai, pasirenki, į kurį top'ą pateks geriausias lietuvis (estafetėse – Lietuvos komanda). Kuo aukščiau – tuo daugiau taškų:</div>
    <table class="rules-t"><tr><th>Individualios</th><th class="pts">Taškai</th><th>Estafetės</th><th class="pts">Taškai</th></tr>
      ${LTU_TIERS.individual.map((t, i) => { const tt = LTU_TIERS.team[i]; return `<tr><td>${tierLabel(t)}</td><td class="pts">${t.pts}</td><td>${tt ? tierLabel(tt) : ""}</td><td class="pts">${tt ? tt.pts : ""}</td></tr>`; }).join("")}</table>
    <div class="note">Pvz. pasirinkai „Top 20“ (6 t.): jei geriausias lietuvis baigė 1–20 vietoje – 6 t., jei 21-as ar žemiau – 0. „Už top 60“ (estafetėse „Už top 20“) pataikai, jei geriausias lietuvis baigė žemiau arba nė vienas nebaigė. Čempionate ×${fmtPts(M)}.</div>
    <h3>❓ Etapo klausimas</h3>
    <div class="note">Kiekviename etape – vienas papildomas klausimas už +1 tašką. Atsakyti galima iki pirmos etapo rungties starto. Atsakymas paaiškėja po etapo.</div>
    <h3>Pavyzdys</h3>
    <div class="note">Spėjai: 1. A, 2. B, 3. C, 4. D, 5. E, 6. F. Rezultatas: 1. B, 2. A, 3. C, 4. G, 5. F, 6. D.<br>
    A per vieną (${I.adjacent}) + B per vieną (${I.adjacent}) + C tiksliai 3-ia (${col(I,2)}) + D top-6 (${I.inTop6}) + E – (0) + F per vieną (${I.adjacent}) = <b>${I.adjacent*3 + col(I,2) + I.inTop6} t.</b></div>
    ${S.config.rulesNote ? `<div class="note" style="margin-top:8px">${esc(S.config.rulesNote)}</div>` : ""}
  </div>`;
}

function renderClaim() {
  const free = players().filter(p => !S.claims[p]);
  const list = $("#claim-list");
  if (!free.length) { list.innerHTML = `<div class="note">Visi vardai jau užimti. Jei tai klaida – parašyk Tautvydui.</div>`; return; }
  list.innerHTML = free.map(p => `<button class="btn big" data-name="${esc(p)}">${esc(p)}</button>`).join("");
  list.querySelectorAll("button").forEach(b => b.onclick = () => claimName(b.dataset.name, b));
}

function renderAll() {
  renderMe();
  if (!S.user) return;
  if (!S.myName) { showOnly("claim"); renderClaim(); return; }
  showOnly("app");
  renderRaces(); renderTable(); renderRules();
}

// ---------- firebase ----------
if (!firebaseConfig.apiKey) {
  document.body.insertAdjacentHTML("beforeend", `<div class="card auth-card"><b>Firebase dar nesukonfigūruotas.</b><div class="note">Įrašyk projekto duomenis į firebase-config.js.</div></div>`);
  throw new Error("firebase-config.js empty");
}
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// auth form
let mode = "login";
document.querySelectorAll(".auth-tabs button").forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll(".auth-tabs button").forEach(x => x.classList.toggle("on", x === b));
  $("#auth-submit").textContent = mode === "login" ? "Prisijungti" : "Sukurti paskyrą";
  $("#auth-form").password.autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#auth-msg").textContent = "";
});
const authErr = e => ({
  "auth/invalid-credential": "Neteisingas el. paštas arba slaptažodis.",
  "auth/wrong-password": "Neteisingas slaptažodis.",
  "auth/user-not-found": "Tokios paskyros nėra – užsiregistruok.",
  "auth/email-already-in-use": "Šis el. paštas jau užregistruotas – prisijunk.",
  "auth/weak-password": "Slaptažodis per trumpas (min. 6 simboliai).",
  "auth/invalid-email": "Neteisingas el. pašto adresas.",
  "auth/too-many-requests": "Per daug bandymų, palauk kelias minutes."
}[e.code] || "Klaida: " + (e.code || e.message));
$("#auth-form").onsubmit = async e => {
  e.preventDefault();
  const f = e.target, msg = $("#auth-msg");
  msg.className = "msg"; msg.textContent = "…";
  try {
    if (mode === "login") await signInWithEmailAndPassword(auth, f.email.value.trim(), f.password.value);
    else await createUserWithEmailAndPassword(auth, f.email.value.trim(), f.password.value);
    msg.textContent = "";
  } catch (err) { msg.className = "msg err"; msg.textContent = authErr(err); }
};
$("#reset").onclick = async () => {
  const email = $("#auth-form").email.value.trim(), msg = $("#auth-msg");
  if (!email) { msg.className = "msg err"; msg.textContent = "Įrašyk el. paštą viršuje."; return; }
  try { await sendPasswordResetEmail(auth, email); msg.className = "msg"; msg.textContent = "Išsiųsta – patikrink paštą."; }
  catch (err) { msg.className = "msg err"; msg.textContent = authErr(err); }
};
$("#logout").onclick = () => signOut(auth);

async function claimName(name, btn) {
  const msg = $("#claim-msg");
  if (btn.dataset.confirm !== "1") {
    document.querySelectorAll("#claim-list button").forEach(b => { b.dataset.confirm = ""; b.textContent = b.dataset.name; });
    btn.dataset.confirm = "1"; btn.textContent = `Taip, aš esu ${name} ✓`;
    msg.className = "msg"; msg.textContent = "Paspausk dar kartą patvirtinti. Vėliau pakeisti negalėsi.";
    return;
  }
  btn.disabled = true; msg.textContent = "Saugoma…";
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "players", name), { uid: S.user.uid, claimedAt: serverTimestamp() });
    batch.set(doc(db, "claims", S.user.uid), { name });
    await batch.commit();
    msg.textContent = "";
  } catch (err) {
    btn.disabled = false; msg.className = "msg err";
    msg.textContent = "Nepavyko – galbūt šį vardą ką tik užėmė kitas.";
  }
}

async function savePicks(e) {
  e.preventDefault();
  const f = e.target, raceId = f.dataset.race, race = S.races.find(r => r.id === raceId);
  const msg = f.querySelector(".msg"), btn = f.querySelector("button");
  if (isLocked(race)) { msg.textContent = "Rungtis jau prasidėjo – spėjimas užrakintas."; renderRaces(); return; }
  const picks = [0,1,2,3,4,5].map(i => f.elements["p" + i].value.trim());
  const filled = picks.filter(Boolean);
  let ltu = null;
  const ltuSel = f.querySelector('input[name="ltuTop"]:checked');
  if (ltuSel) ltu = { top: parseInt(ltuSel.value, 10) };
  if (!filled.length && !ltu) { msg.className = "msg err"; msg.textContent = "Įrašyk bent vieną vardą."; return; }
  const allowed = new Set((race.startlist || []).map(a => a.name));
  if (filled.some(p => !allowed.has(p))) { msg.className = "msg err"; msg.textContent = "Rinktis galima tik iš startų sąrašo."; return; }
  if (new Set(filled.map(norm)).size !== filled.length) { msg.className = "msg err"; msg.textContent = "Tas pats vardas įrašytas kelis kartus."; return; }
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Saugoma…";
  try {
    await setDoc(doc(db, "picks", raceId + "__" + S.user.uid),
      ltu ? { uid: S.user.uid, name: S.myName, raceId, picks, ltu, updatedAt: serverTimestamp() }
          : { uid: S.user.uid, name: S.myName, raceId, picks, updatedAt: serverTimestamp() });
    delete drafts[raceId];
    msg.textContent = "✓ Išsaugota";
    btn.disabled = false;
  } catch (err) {
    btn.disabled = false; msg.className = "msg err"; msg.textContent = "Nepavyko išsaugoti, bandyk dar kartą.";
  }
}

function subscribe() {
  S.unsub.forEach(u => u()); S.unsub = [];
  const onErr = () => status("Ryšio su duomenų baze klaida.");
  S.unsub.push(onSnapshot(collection(db, "players"), snap => {
    S.claims = {}; snap.forEach(d => S.claims[d.id] = d.data().uid);
    S.myName = Object.keys(S.claims).find(n => S.claims[n] === S.user.uid) || null;
    renderAll();
  }, onErr));
  S.unsub.push(onSnapshot(collection(db, "bonus"), snap => {
    S.bonus = {}; snap.forEach(d => S.bonus[d.id] = d.data());
    if (S.myName) { renderRaces(); renderTable(); }
  }, onErr));
  S.unsub.push(onSnapshot(collection(db, "picks"), snap => {
    S.picks = {}; snap.forEach(d => S.picks[d.id] = d.data());
    if (S.myName) { renderRaces(); renderTable(); }
  }, onErr));
}

onAuthStateChanged(auth, user => {
  S.user = user; S.myName = null; S.claims = {}; S.picks = {};
  if (!user) { S.unsub.forEach(u => u()); S.unsub = []; showOnly("auth"); renderMe(); return; }
  $("#claim-list").innerHTML = `<div class="note">Kraunama…</div>`;
  showOnly("claim");
  subscribe();
});

// šoniniai paveikslai prasideda po antrašte (kad nebūtų uždengti veidai)
function sideTop() {
  const h = document.querySelector("header"), n = document.querySelector("nav");
  const bottom = Math.max(h.getBoundingClientRect().bottom, n && !n.classList.contains("hidden") ? n.getBoundingClientRect().bottom : 0, 0);
  document.documentElement.style.setProperty("--side-top", Math.round(bottom) + "px");
}
window.addEventListener("scroll", sideTop, { passive: true });
window.addEventListener("resize", sideTop);
setInterval(sideTop, 1000);

// dizaino tema
const THEME_COLORS = { blue: "#2f7fe0", dark: "#0b1220", pink: "#e0458f" };
function applyTheme(t) {
  if (!THEME_COLORS[t]) t = "blue";
  if (t === "blue") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  document.querySelectorAll(".themes button").forEach(b => b.classList.toggle("on", b.dataset.t === t));
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = THEME_COLORS[t];
  try { localStorage.setItem("biat_theme", t); } catch (e) {}
}
document.querySelectorAll(".themes button").forEach(b => b.onclick = () => applyTheme(b.dataset.t));
applyTheme(document.documentElement.dataset.theme || "blue");

// tabs
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
  ["races", "table", "rules"].forEach(t => $("#tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
});

window.addEventListener("hashchange", () => { if (S.myName) { renderRaces(); window.scrollTo(0, 0); } });
loadRaces();
setInterval(loadRaces, 5 * 60 * 1000);
let lockSig = "";
setInterval(() => {
  const s = S.races.map(r => isLocked(r) ? 1 : 0).join("");
  if (s !== lockSig) { lockSig = s; if (S.myName) renderRaces(); }
  tickCountdowns();
}, 1000);
