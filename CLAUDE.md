# Aethernet (ubif-portal-tools)

Aethernet is a Tampermonkey userscript of "shards" (features named after FFXIV actions) for uBreakiFix's NextGen Portal, bundled from `src/*.js` by `build.py`. "Portal" is a proper noun: write "Portal", never "the portal". History and design decisions live in the vault: `~/Documents/Claude Vault/Work/Projects/` (index `Aethernet.md`, one note per shard in `Work/Projects/Aethernet/`). Read the relevant note before big changes.

## Map (src/, bundled in filename order)
- `00-core.js` shared core (see helpers below)
- `01-access.js` store access check (admin-panel Stores list); `01b-login.js` Glamour on the login page
- `02-status.js` live notices from status.json; `05-settings.js` Settings card + avatar-menu item; `06-feedback.js` feedback, usage, admin inbox
- `10-cleaning-rate.js` Divination (`cleaningRate`): live cleaning rate badge
- `15-wo-cleanings.js` Esuna (`woCleanings`): cleanings pill on a work order
- `17-text-notes.js` Recitation (`textNotes`): sent text becomes a WO note
- `20-auto-close.js` Swiftcast (`autoClose`): one-click cleaning auto-close
- `22-checkin-drafts.js` Return (`checkinDrafts`): save incomplete check-ins (dev-only)
- `23-price-sheet.js` Price sheet shared by Provoke/Reassemble (not a shard)
- `24-provoke.js` Provoke (`leadReplies`): lead replies
- `27-tracker.js` WO tracker collection (not a shard)
- `30-galaxy.js` Macrocosmos (`galaxy`): Galaxy Diagnostics exception
- `40-print-labels.js` Quick Synthesis (`printLabels`); `45-buybacks.js` Bountiful Yield (`buybacks`)
- `50-glamour.js` Glamour (`glamour`): appearance; `55-waymark.js` Waymark (`waymark`); `57-row-colors.js` Rainbow Drip (`rowColors`)
- `58-fixes.js` Master's Mend (`fixes`): Portal fixes, bulletins
- `60-count-check.js` Lay of the Land (`countCheck`); `62-tactician.js` Tactician (`timeSheet`); `63-reassemble.js` Reassemble (`reassemble`): price estimates; `64-decipher.js` Decipher (`decipher`): IMEI to model
- `src/dev/devtools.js` dev-channel tools tab
- `worker/` Aethernet API Worker (Cloudflare, D1; `--env dev` is the dev Worker); `tracker-worker/` WO tracker Worker (src, test, migrations); `admin-worker/` admin site (Stores, inbox, tracker UI)
- `sheets/` `sync_sheets.py` pushes the store's Price sheet to the Worker (launchd plist)
- `sandbox/` Portal's real app on fake data (`server.py`, `api.py`, `capture.py`, `shot.py`; see its README); `.cache/` is git-ignored
- `assets/icons/` one JPG per shard (`<id>.jpg`) plus settings/info/feedback; `assets/ui/` UI art
- `legacy/` the old standalone userscripts, kept for reference
- `build.py` bundler/publisher; `patch-notes.json` public patch notes; `status.json`, `status-dev.json`, `status-demo.json` live notices per channel (edit via `build.py --status ...`)

## Core helpers (`src/00-core.js`)
Find code with the grep patterns below; never rely on remembered line numbers.

Flags `AE_DEV` `grep -n 'const AE_DEV = __DEV__;' src/00-core.js`, `AE_DEMO` `grep -n '// AE_DEMO (used bare, never declared)' src/00-core.js` (bare, swapped by build.py), `AE_SANDBOX` `grep -n 'const AE_SANDBOX =' src/00-core.js`, `AE_ON_PORTAL` `grep -n 'const AE_ON_PORTAL =' src/00-core.js`. `settings` `grep -n 'const settings = merge(DEFAULTS, stored);' src/00-core.js` (persisted via GM storage; `AE.saveSettings`). `api(method, path, body, opts)` `grep -n 'async function api(method, path, body, opts' src/00-core.js` Portal fetch. `AE.portal(op, args)` `grep -n 'function portal(op, args)' src/00-core.js` reads Portal's React state. `AE.data` `grep -n 'const data = (() => {' src/00-core.js` work-order/arrival/device queries. `AE.track(feature)` `grep -n 'function track(feature)' src/00-core.js` usage counts. `AE.shard(def)` `grep -n 'function shard(def)' src/00-core.js` registers `{id, name, ...}`. `AE.onDom(fn)` `grep -n 'function onDom(fn)' src/00-core.js` re-run on DOM changes. Exported list `grep -n 'settings, saveSettings, DEFAULTS, merge' src/00-core.js`. `AE.bugLink`/`AE.bugLinkEl` are defined in `06-feedback.js` `grep -n 'AE.bugLink = (label, context)' src/06-feedback.js`.

## Commands
- `python3 build.py --dev` builds `dist-dev/` and publishes to the dev Gist. Plain `python3 build.py` builds `dist/` only.
- `--release` publishes the public build; `--status ...` posts/updates/clears the live banner and kill switch (`--status-update/-fixed/-clear/-show`, `--bulletin-*`); `--demo` publishes the cut-down demo from the `demo` branch. Usage text is at the top of `build.py`.
- Worker deploy (dev only): `cd worker && npx wrangler deploy --env dev`. The dev Worker shares the D1 database with the public one.
- Sandbox: `python3 sandbox/server.py` then http://localhost:8790 (dev build only).
- Screenshots/tests: `~/Scripts/ubif-daily-sales/.venv/bin/python sandbox/shot.py /arrivals out.png`, or import `sandbox/shot.py` (`portal_page`, `shot`, `open_menu`, `inject_html`). Needs the sandbox up and `dist-dev/` built. Output goes in `sandbox/shots/` (ignored). Use that venv python: it has Playwright, system python does not.
- Tests: `cd tracker-worker && npm test`.

## Rules
- New features go to `dev` plus `build.py --dev`. Never touch `main` or release branches, never deploy the public Worker, and never run `--release`, `--status` or `--demo` unless explicitly asked.
- D1 changes are additive only.
- Every "report a bug" link uses `AE.bugLink` / `AE.bugLinkEl`.
- Visible changes get a Portal-look mockup with fake data, approved before building.
- Patch notes are only written when asked.
- Never put real customer data in commits, logs or screenshots.
- Don't attribute decisions to Garrett or quote him in docs, comments or commits. State the decision plainly; his name only where needed (accounts, named lists, credit).
- Commits end with a `Co-Authored-By:` line for the model that made them.
- Token economy: grep and read line ranges, never whole large files, and never read `sandbox/.cache/`.
