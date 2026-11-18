# 🎯 Biatlono totalizatorius 2026/27

Tautvydo, Vitalijos ir Vitalio spėjimų žaidimas: kiekvienai IBU pasaulio taurės rungčiai spėjamas top-6.

- `index.html`, `app.js`, `style.css` – puslapis (GitHub Pages)
- `data/races.json` – rungtys, startų sąrašai, favoritai ir rezultatai (atnaujina Claude)
- `data/config.json` – žaidėjai ir taškų taisyklės
- `firebase-config.js` – Firebase projekto duomenys (prisijungimai ir spėjimai)
- `firestore.rules` – Firestore saugumo taisyklės (įklijuoti Firebase konsolėje)

## Firebase paruošimas (vieną kartą)

1. https://console.firebase.google.com → **Add project** (Google Analytics nebūtinas).
2. **Build → Authentication → Get started → Email/Password → Enable**.
3. **Build → Authentication → Settings → Authorized domains → Add domain**: `tautd-eng.github.io`.
4. **Build → Firestore Database → Create database** (Production mode, regionas `eur3`).
5. **Firestore → Rules**: įklijuok `firestore.rules` turinį → **Publish**.
6. **Project settings (⚙️) → Your apps → Web (`</>`)** → užregistruok programėlę → nukopijuok `firebaseConfig` reikšmes į `firebase-config.js`.

## GitHub Pages

Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
Puslapis: https://tautd-eng.github.io/Biatlonas/
