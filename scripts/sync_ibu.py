#!/usr/bin/env python3
"""Sinchronizuoja data/races.json su oficialiu IBU šaltiniu (biathlonworld.com).

biathlonworld.com/startlist/<RaceId> puslapio HTML viduje (__NEXT_DATA__) yra visa
informacija: rungties laikas, etapas, pilnas startų sąrašas (su atsilikimais
persekiojime, estafečių sudėtimis), o po rungties – rezultatai.

Paleidimas:  python scripts/sync_ibu.py            (atnaujina artimas / nebaigtas rungtis)
             python scripts/sync_ibu.py --calendar (dar ir suranda naujas sezono rungtis)
"""
import json, re, sys, time, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

SEASON = "2627"
ROOT = Path(__file__).resolve().parent.parent
RACES = ROOT / "data" / "races.json"
BASE = "https://www.biathlonworld.com/startlist/"
UA = "Mozilla/5.0 (biatlono-totalizatorius; +https://tautd-eng.github.io/Biatlonas/)"

EVENTS = ["CP01", "CP02", "CP03", "CP04", "CP05", "CP06", "CP07", "CH__", "CP08", "CP09", "CP10"]
DISCIPLINES = ["SMIN", "SWIN", "SMSI", "SWSI", "SMSP", "SWSP", "SMPU", "SWPU",
               "SMMS", "SWMS", "SMRL", "SWRL", "MXRL", "MXSR"]
DISC_LT = {"IN": "individuali", "SI": "trumpoji individuali", "SP": "sprintas",
           "PU": "persekiojimas", "MS": "masinis startas", "RL": "estafetė"}
NAT_LT = {"FIN": "FIN", "AUT": "AUT", "FRA": "FRA", "SLO": "SLO", "GER": "GER", "ITA": "ITA",
          "CZE": "CZE", "EST": "EST", "SWE": "SWE", "NOR": "NOR"}


def now():
    return datetime.now(timezone.utc)


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def fetch(race_id):
    req = urllib.request.Request(BASE + race_id, headers={"User-Agent": UA, "Accept-Language": "en"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                html = r.read().decode("utf-8", "replace")
            m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
            if not m:
                return None
            st = json.loads(m.group(1))["props"]["pageProps"].get("startlistInitialState") or {}
            return st if st.get("Competition") else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 + attempt * 3)
        except Exception:
            time.sleep(2 + attempt * 3)
    return None


def person(r):
    g, f = (r.get("GivenName") or "").strip(), (r.get("FamilyName") or "").strip()
    return f"{g} {f}".strip() or (r.get("Name") or "").strip()


def team_name(r):
    n = (r.get("Name") or r.get("Nat") or "").strip()
    return n.title() if n.isupper() else n


def is_team_race(comp):
    return comp.get("DisciplineId") == "RL" or (comp.get("NrLegs") or 0) > 0


def fmt_behind(r):
    # persekiojime StartInfo = atsilikimas starte, pvz. "0:11" (lyderiui "0:00")
    v = (r.get("StartInfo") or "").strip()
    if not v or v in ("0:00", "0", "0.0") or not re.match(r"^[+]?\d{1,2}:\d{2}(\.\d)?$", v):
        return ""
    return v if v.startswith("+") else "+" + v


def build_startlist(st, comp):
    rows = st.get("Results") or []
    if not rows:
        return []
    if is_team_race(comp):
        teams = [r for r in rows if r.get("IsTeam")]
        out = []
        for t in sorted(teams, key=lambda r: int(r.get("Bib") or 999) if str(r.get("Bib") or "").isdigit() else 999):
            legs = [r for r in rows if not r.get("IsTeam") and (
                (t.get("TeamId") and r.get("TeamId") == t.get("TeamId")) or
                (str(r.get("Bib") or "").split("-")[0] == str(t.get("Bib"))))]
            legs.sort(key=lambda r: int(r.get("Leg") or 0))
            out.append({"name": team_name(t), "nat": t.get("Nat") or "", "bib": int(t["Bib"]) if str(t.get("Bib") or "").isdigit() else t.get("Bib"),
                        "members": [person(l) for l in legs]})
        return out
    pursuit = comp.get("DisciplineId") == "PU"
    out = []
    for r in sorted(rows, key=lambda r: r.get("StartOrder") or 999):
        if r.get("IsTeam"):
            continue
        e = {"name": person(r), "nat": r.get("Nat") or "", "bib": int(r["Bib"]) if str(r.get("Bib") or "").isdigit() else r.get("Bib")}
        if pursuit:
            e["behind"] = fmt_behind(r)
        out.append(e)
    return out


def build_result(st, comp):
    if not st.get("IsResult"):
        return []
    rows = [r for r in (st.get("Results") or []) if r.get("ResultOrder") and not r.get("IRM")]
    if is_team_race(comp):
        rows = [r for r in rows if r.get("IsTeam")]
        name = team_name
    else:
        rows = [r for r in rows if not r.get("IsTeam")]
        name = person
    rows.sort(key=lambda r: r["ResultOrder"])
    return [name(r) for r in rows[:6]]


def ltu_place(st, comp):
    """Geriausio lietuvio (estafetėje – Lietuvos komandos) vieta. None – nėra/nebaigė."""
    if not st.get("IsResult"):
        return None
    team = is_team_race(comp)
    best = None
    for r in st.get("Results") or []:
        if r.get("Nat") != "LTU" or bool(r.get("IsTeam")) != team or r.get("IRM"):
            continue
        rk = str(r.get("Rank") or r.get("ResultOrder") or "")
        if rk.isdigit():
            best = int(rk) if best is None else min(best, int(rk))
    return best


def lt_name(comp):
    disc, cat = comp.get("DisciplineId"), comp.get("catId")
    km = (comp.get("km") or "").replace(".", ",")
    if cat == "MX":
        return "Single mišri estafetė" if disc == "SR" else "Mišri estafetė"
    who = "Vyrų" if cat == "SM" else "Moterų"
    if disc == "RL":
        legs = {"SM": "4×7,5 km", "SW": "4×6 km"}.get(cat, "")
        return f"{who} estafetė {legs}".strip()
    return f"{who} {km + ' km ' if km else ''}{DISC_LT.get(disc, disc)}"


def stage_name(evt, event_code):
    org = (evt.get("Organizer") or evt.get("ShortDescription") or "").strip()
    nat = (evt.get("Nat") or "").strip()
    if event_code == "CH__":
        return f"Pasaulio čempionatas · {org} ({nat})"
    nr = [e for e in EVENTS if e != "CH__"].index(event_code) + 1
    return f"{nr} etapas · {org} ({nat})"


def main():
    calendar = "--calendar" in sys.argv
    data = json.loads(RACES.read_text(encoding="utf-8"))
    races = data["races"]
    by_ibu = {r["ibu"]: r for r in races if r.get("ibu")}
    changed = []

    # 1) kalendorius – surandam trūkstamas rungtis
    if calendar:
        for ev in EVENTS:
            for d in DISCIPLINES:
                rid = f"BT{SEASON}SWRL{ev}{d}"
                if rid in by_ibu:
                    continue
                st = fetch(rid)
                time.sleep(0.4)
                if not st:
                    continue
                comp, evt = st["Competition"], st.get("SportEvt") or {}
                r = {"id": f"{SEASON}-{ev.replace('_', '')}-{d}", "ibu": rid, "stage": stage_name(evt, ev),
                     "name": lt_name(comp), "start": comp["StartTime"], "team": is_team_race(comp),
                     "startlist": [], "favorites": [], "result": []}
                if ev == "CH__":
                    r["championship"] = True
                races.append(r)
                by_ibu[rid] = r
                changed.append(f"nauja rungtis {r['stage']} – {r['name']}")

    # 2) atnaujinam artimas ir nebaigtas rungtis
    t = now()
    for r in races:
        rid = r.get("ibu")
        if not rid:
            continue
        start = parse_ts(r["start"])
        done = bool(r.get("result"))
        if done or start > t + timedelta(days=4) or start < t - timedelta(days=5):
            continue
        st = fetch(rid)
        time.sleep(0.4)
        if not st:
            continue
        comp = st["Competition"]
        if comp.get("StartTime") and comp["StartTime"] != r["start"]:
            r["start"] = comp["StartTime"]
            changed.append(f"{r['name']}: starto laikas {r['start']}")
        if comp.get("StatusText") and "cancel" in comp["StatusText"].lower():
            if r.get("note") != "Rungtis atšaukta":
                r["note"] = "Rungtis atšaukta"; changed.append(f"{r['name']}: atšaukta")
        res = build_result(st, comp)
        if res and res != r.get("result"):
            r["result"] = res
            lp = ltu_place(st, comp)
            r["ltuPlace"] = lp if lp is not None else "–"
            changed.append(f"{r['name']}: rezultatai")
        if not res:
            sl = build_startlist(st, comp)
            if sl:
                old = {e["name"] for e in r.get("startlist") or []}
                # esamų vardų nekeičiam (prie jų pririšti spėjimai) – tik papildom/atnaujinam
                if sl != r.get("startlist"):
                    if old and not old.issubset({e["name"] for e in sl}):
                        keep = [e for e in r["startlist"] if e["name"] not in {x["name"] for x in sl}]
                        sl = sl + keep
                    r["startlist"] = sl
                    changed.append(f"{r['name']}: startų sąrašas ({len(sl)})")

    if changed:
        data["updated"] = t.strftime("%Y-%m-%dT%H:%M:%SZ")
        RACES.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("\n".join(changed) if changed else "be pakeitimų")


if __name__ == "__main__":
    main()
