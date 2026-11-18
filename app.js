import { firebaseConfig } from "./firebase-config.js?v=4";
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
  races: [], config: { players: ["Tautvydas","Vitalija","Vitalis"], scoring: { exact: 3, inTop6: 1, winnerBonus: 0 }, rulesNote: "" },
  user: null, myName: null, claims: {}, picks: {}, open: new Set(), unsub: []
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
  return { picks: p.picks || [], late: ts != null && ts >= Date.parse(race.start) };
}
// "Dale-Skjevdal" turi sutapti su "Johannes DALE-SKJEVDAL"
function same(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 4 && (l.endsWith(" " + s) || l.startsWith(s + " "));
}
function score(race, pk) {
  const sc = S.config.scoring;
  const res = (race.result || []).slice(0, 6);
  let pts = 0; const marks = [];
  if (!pk || pk.late) return { pts: 0, marks: [] };
  pk.picks.forEach((p, i) => {
    let m = "";
    if (p && res[i] && same(p, res[i])) { pts += sc.exact; m = "exact"; if (i === 0 && sc.winnerBonus) pts += sc.winnerBonus; }
    else if (p && res.some(r => same(p, r))) { pts += sc.inTop6; m = "top"; }
    marks.push(m);
  });
  return { pts, marks };
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

function renderRaces() {
  captureDrafts();
  const box = $("#tab-races");
  if (!S.races.length) { box.innerHTML = `<div class="card note">Rungčių dar nėra.</div>`; return; }
  const sorted = [...S.races].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  let html = "", stage = null;
  for (const r of sorted) {
    if (r.stage !== stage) { stage = r.stage; html += `<div class="stage">${esc(stage)}</div>`; }
    html += raceCard(r);
  }
  box.innerHTML = html;
  box.querySelectorAll(".race-head").forEach(h => h.onclick = () => {
    const id = h.dataset.id; S.open.has(id) ? S.open.delete(id) : S.open.add(id); renderRaces();
  });
  box.querySelectorAll("form[data-race]").forEach(f => {
    f.onsubmit = savePicks;
    const race = S.races.find(x => x.id === f.dataset.race);
    const sync = () => {
      if (race && race.team) [0,1,2,3,4,5].forEach(i => {
        const sel = f.elements["p" + i], box = sel.parentElement.querySelector(".members");
        const a = (race.startlist || []).find(x => x.name === sel.value);
        if (box) box.textContent = a && a.members ? a.members.join(" · ") : "";
      });
      const chosen = [0,1,2,3,4,5].map(i => f.elements["p" + i].value);
      [0,1,2,3,4,5].forEach(i => {
        [...f.elements["p" + i].options].forEach(o => {
          o.disabled = !!o.value && chosen.includes(o.value) && f.elements["p" + i].value !== o.value;
        });
      });
    };
    f.addEventListener("change", sync); sync();
  });
}

function raceCard(r) {
  const locked = isLocked(r), done = hasResult(r);
  const badge = done ? `<span class="badge b-done">Rezultatai</span>`
    : locked ? `<span class="badge b-live">Užrakinta</span>` : `<span class="badge b-open">Atvira</span>`;
  const chips = players().map(p => {
    const pk = pickOf(r, p);
    if (done && pk) return `<span class="chip ok">${esc(p)}: ${score(r, pk).pts} t.</span>`;
    return `<span class="chip ${pk && !pk.late ? "ok" : ""}">${esc(p)} ${pk && !pk.late ? "✓" : "–"}</span>`;
  }).join("");
  return `<div class="card">
    <div class="race-head" data-id="${esc(r.id)}">
      <div><div class="race-title">${esc(r.name)}</div>
      <div class="race-meta">${fmtTime(r.start)} (LT laiku)${r.startlist && r.startlist.length ? ` · ${r.startlist.length} startuoja` : ""}</div></div>
      ${badge}
    </div>
    <div class="chips">${chips}</div>
    ${S.open.has(r.id) ? `<div class="body">${raceBody(r, locked, done)}</div>` : ""}
  </div>`;
}

function raceBody(r, locked, done) {
  let h = "";
  if (r.note) h += `<div class="note" style="margin-bottom:10px">${esc(r.note)}</div>`;
  if (!locked) {
    if (r.favorites && r.favorites.length) h += `<div class="note" style="margin-bottom:10px">⭐ Favoritai: ${r.favorites.map(esc).join(", ")}</div>`;
    const saved = (pickOf(r, S.myName) || {}).picks || [];
    const mine = drafts[r.id] || saved;
    const sl = [...(r.startlist || [])].sort((a, b) => (Number(a.bib) || 999) - (Number(b.bib) || 999));
    if (!sl.length) {
      h += `<div class="note">⏳ Startų sąrašas dar nepaskelbtas. Spėti bus galima, kai IBU jį paskelbs (dažniausiai dieną prieš rungtį).</div>`;
    } else {
      const label = a => (a.bib ? "#" + a.bib + " " : "") + a.name + (a.nat && !r.team ? " (" + a.nat + ")" : "");
      h += `<form data-race="${esc(r.id)}"><div class="picks-form">`;
      const membersOf = n => { const a = sl.find(x => x.name === n); return a && a.members && a.members.length ? a.members.join(" · ") : ""; };
      for (let i = 0; i < 6; i++) {
        h += `<label>${i + 1}</label><div><select name="p${i}"><option value="">— pasirink —</option>` +
          sl.map(a => `<option value="${esc(a.name)}"${a.name === mine[i] ? " selected" : ""}>${esc(label(a))}</option>`).join("") +
          `</select>${r.team ? `<div class="members">${esc(membersOf(mine[i]))}</div>` : ""}</div>`;
      }
      h += `</div>`;
      if (r.team && sl.some(a => a.members && a.members.length)) {
        h += `<details class="teams"><summary>Komandų sudėtys</summary>` +
          sl.map(a => `<div class="team-row"><b>${a.bib ? "#" + esc(a.bib) + " " : ""}${esc(a.name)}</b><span>${esc((a.members || []).join(" · ") || "sudėtis dar neskelbta")}</span></div>`).join("") +
          `</details>`;
      }
      h += `<button class="btn">${saved.length ? "Atnaujinti spėjimą" : "Pateikti spėjimą"}</button>
        <div class="msg">Spėjimas užsirakina rungties starto metu. Kitų spėjimai matosi tik po starto.</div></form>`;
    }
  } else {
    const sc = players().map(p => ({ pk: pickOf(r, p), s: score(r, pickOf(r, p)) }));
    h += `<table><tr><th>#</th>${players().map(p => `<th>${esc(p)}</th>`).join("")}${done ? "<th>Rezultatas</th>" : ""}</tr>`;
    for (let k = 0; k < 6; k++) {
      h += `<tr><td>${k + 1}</td>` + sc.map(({ pk, s }) => {
        const v = pk ? pk.picks[k] || "" : "";
        const cls = pk && pk.late ? "late" : s.marks[k] === "exact" ? "hit-exact" : s.marks[k] === "top" ? "hit-top" : "";
        return `<td class="${cls}">${esc(v) || "–"}</td>`;
      }).join("") + (done ? `<td><b>${esc(r.result[k] || "")}</b></td>` : "") + `</tr>`;
    }
    if (done) h += `<tr><td></td>${sc.map(x => `<td class="pts">${x.s.pts} t.</td>`).join("")}<td></td></tr>`;
    h += `</table>`;
    if (done) h += `<div class="msg"><span class="hit-exact">Žalia</span> – tiksli vieta, <span class="hit-top">auksinė</span> – pateko į top-6.</div>`;
    if (sc.some(x => x.pk && x.pk.late)) h += `<div class="msg"><span class="late">Perbraukta</span> – spėjimas pakeistas po starto, neskaičiuojamas.</div>`;
  }
  return h;
}

function renderTable() {
  const ps = players();
  const tot = ps.map(p => ({ name: p, pts: 0, races: 0, exact: 0, top: 0, wins: 0 }));
  const doneRaces = S.races.filter(hasResult).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const r of doneRaces) {
    const sc = ps.map(p => score(r, pickOf(r, p)));
    const best = Math.max(...sc.map(s => s.pts));
    sc.forEach((s, i) => {
      const pk = pickOf(r, ps[i]); if (pk && !pk.late) tot[i].races++;
      tot[i].pts += s.pts;
      tot[i].exact += s.marks.filter(m => m === "exact").length;
      tot[i].top += s.marks.filter(m => m === "top").length;
      if (best > 0 && s.pts === best) tot[i].wins++;
    });
  }
  const ranked = [...tot].sort((a, b) => b.pts - a.pts);
  let h = `<div class="card">${ranked.map((t, k) => `<div class="lb-row"><div class="lb-pos">${k + 1}</div>
    <div class="lb-name">${esc(t.name)}<div class="lb-sub">${t.races} rungt. · ${t.exact} tikslūs · ${t.top} top-6 · laimėta ${t.wins} rungt.</div></div>
    <div class="lb-pts">${t.pts}</div></div>`).join("")}</div>`;
  if (doneRaces.length) {
    h += `<div class="card"><table><tr><th>Rungtis</th>${ps.map(p => `<th style="text-align:right">${esc(p)}</th>`).join("")}</tr>`;
    for (const r of [...doneRaces].reverse())
      h += `<tr><td>${esc(r.name)}<div class="race-meta">${esc(r.stage)}</div></td>${ps.map(p => `<td class="pts">${score(r, pickOf(r, p)).pts}</td>`).join("")}</tr>`;
    h += `</table></div>`;
  } else h += `<div class="note" style="padding:4px">Rezultatų dar nėra – lentelė pildysis po pirmų rungčių.</div>`;
  $("#tab-table").innerHTML = h;
}

function renderRules() {
  const sc = S.config.scoring;
  $("#tab-rules").innerHTML = `<div class="card">
    <h3 style="margin-top:0">Kaip žaidžiam</h3>
    <ul>
      <li>Kiekvienai rungčiai kiekvienas spėja <b>top-6</b> (1–6 vietos).</li>
      <li>Spėjimą galima keisti iki starto. Po starto pasimato visų spėjimai; po starto pakeistas spėjimas neskaičiuojamas.</li>
      <li>Estafetėse spėjamos šalys.</li>
      <li>Startų sąrašai ir rezultatai – iš IBU (biathlonworld.com).</li>
    </ul>
    <h3>Taškai</h3>
    <ul>
      <li>Tiksli vieta: <b>${sc.exact}</b> t.</li>
      <li>Pateko į top-6, bet kita vieta: <b>${sc.inTop6}</b> t.</li>
      ${sc.winnerBonus ? `<li>Bonusas už tiksliai atspėtą nugalėtoją: <b>${sc.winnerBonus}</b> t.</li>` : ""}
    </ul>
    <div class="note">${esc(S.config.rulesNote || "")}</div>
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
  if (!filled.length) { msg.className = "msg err"; msg.textContent = "Įrašyk bent vieną vardą."; return; }
  const allowed = new Set((race.startlist || []).map(a => a.name));
  if (filled.some(p => !allowed.has(p))) { msg.className = "msg err"; msg.textContent = "Rinktis galima tik iš startų sąrašo."; return; }
  if (new Set(filled.map(norm)).size !== filled.length) { msg.className = "msg err"; msg.textContent = "Tas pats vardas įrašytas kelis kartus."; return; }
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Saugoma…";
  try {
    await setDoc(doc(db, "picks", raceId + "__" + S.user.uid),
      { uid: S.user.uid, name: S.myName, raceId, picks, updatedAt: serverTimestamp() });
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

// tabs
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
  ["races", "table", "rules"].forEach(t => $("#tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
});

loadRaces();
setInterval(loadRaces, 5 * 60 * 1000);
let lockSig = "";
setInterval(() => {
  const s = S.races.map(r => isLocked(r) ? 1 : 0).join("");
  if (s !== lockSig) { lockSig = s; if (S.myName) renderRaces(); }
}, 30000);
