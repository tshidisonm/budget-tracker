# Budget Ledger PWA

A tiny installable web app for tracking a monthly budget. Data lives in a
real SQLite database running in your browser (via [sql.js](https://sql.js.org),
WebAssembly), persisted to IndexedDB so it survives reloads and works
offline. Every change is exported to a CSV built straight from the SQLite
tables and, if you connect it, mirrored automatically to a file in your own
Google Drive.

No server, no backend, no database to host — it's fully static, which is
why it can run on GitHub Pages.

## What's in this folder

```
index.html      – app shell / UI
styles.css      – styling
app.js          – UI logic
db.js           – SQLite (sql.js) + IndexedDB persistence + CSV export/import
drive.js        – Google Drive backup (OAuth + REST calls)
sw.js           – service worker (offline caching)
manifest.json   – PWA manifest
sql-wasm.js/.wasm – the SQLite WebAssembly engine (self-hosted, no CDN)
icons/          – app icons
```

## 1. Deploy to GitHub Pages

1. Create a new GitHub repo (public or private-with-Pages-enabled) and push
   everything in this folder to the repo root (or to a `/docs` folder — just
   keep all files together, the paths inside are all relative).
2. In the repo: **Settings → Pages → Source**, pick the branch and folder
   you pushed to, save.
3. Your app will be live at `https://<your-username>.github.io/<repo-name>/`.
4. Open it once on your phone and use "Add to Home Screen" (iOS Safari) or
   the install prompt (Android Chrome) to install it as an app.

That's it for the app itself — it already works fully offline at this
point, storing data locally. The Drive backup is optional and needs a
one-time setup below.

## 2. Set up Google Drive backup (optional, ~5 minutes)

The app never ships with a shared Google API key — you create your own,
free, tied to your own Google account, so only you control access to your
Drive.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (or reuse one).
2. **APIs & Services → Library** → search "Google Drive API" → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: External (unless you have a Google Workspace org, then Internal).
   - Fill in the app name, your email, etc. You can leave it in "Testing"
     mode — add your own Google account under **Test users** so you can sign in.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins: add your GitHub Pages origin, e.g.
     `https://<your-username>.github.io` (no trailing slash, no path).
   - Create → copy the **Client ID** (looks like
     `1234567890-abc.apps.googleusercontent.com`).
5. In the app, tap the ⚙ settings icon, paste the Client ID, **Save**, then
   **Connect Google Drive** and approve the consent screen.

From then on, every edit you make (income, planned/actual amounts, adding
or deleting a category) triggers an automatic backup ~1.5 seconds later: the
app regenerates `budget_backup.csv` from the SQLite tables and
overwrites the same file in your Drive (it finds it by name so it never
creates duplicates). You'll always see the status dot and last-synced time
at the bottom of the app.

**Scope used:** `drive.file` — the app can only see and edit files it
created itself. It cannot browse, read, or touch the rest of your Drive.

**Note on silent refresh:** OAuth access tokens expire after about an hour.
The app tries to renew silently in the background; if your browser blocks
third-party sign-in state (e.g. Safari's strict tracking prevention) you may
occasionally need to tap **Connect Google Drive** again — your data is
never lost either way, since it's always saved locally first.

## 3. CSV format

The backup CSV has one row per category per month:

```
year_month,income,category,planned,actual
2026-08,20000,Housing (rent / room-share),6000,0
2026-08,20000,Transport,2000,0
...
```

You can open this directly in Excel/Sheets, or re-import it with the
**Import CSV** button in the app (matching months are replaced, so re-importing
your own backup is safe).

## Local development

Because the app uses a service worker and WebAssembly, some browsers won't
run it correctly from a plain `file://` URL. Serve it locally instead:

```
python3 -m http.server 8080
```

then open `http://localhost:8080`.
