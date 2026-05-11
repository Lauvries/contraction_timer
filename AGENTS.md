## Cursor Cloud specific instructions

### Overview

Baby Tracker PWA — a vanilla JS static web app (no build framework, no bundler). Two pages:
- `contractions.html` + `app.js` — Contraction timer
- `index.html` + `baby.js` + `feeds.js` — Breastfeeding tracker

### Running the dev server

```
python3 serve.py
```

Serves on port 8080. All files are static HTML/JS/CSS with ES modules loaded from CDN (`esm.sh`).

### Key gotchas

- **No `npm install` needed.** There are no runtime Node dependencies. The `package.json` only defines convenience scripts (`start`, `build`). Dependencies are loaded via `https://esm.sh/` CDN imports in the browser.
- **Supabase is required for full functionality.** Both the feeding tracker and contraction timer (when cloud mode is active) require a signed-in Supabase session. Without auth, the contraction timer's "Log contraction" / "Stop tracking" will show "Could not save contraction."
- **Cloud mode is auto-detected** from `supabase-config.js`. If the URL/key are populated (length > 8 / > 20), the app uses Supabase. To test in pure localStorage mode, clear those values.
- **No linter or test framework is configured** in this repo. There are no automated tests to run.
- **`npm run build`** only injects env vars into `supabase-config.js` — it is NOT a compilation step. Not needed for local dev.
