# Aethernet — crystals for NextGen Portal

One Tampermonkey userscript, **`dist/aethernet.user.js`**, that bundles every
portal crystal in this folder.

**Terminology:** each tool in Aethernet is a **crystal**, and adding a new one
(or rolling an old standalone script in) is **crystallizing** it. Crystals are
named after FFXIV actions, with what they do in brackets, and show that
action's icon (`assets/icons/<crystalId>.jpg`, embedded by `build.py`; icons
© SQUARE ENIX, from XIVAPI). Quick Synthesis has no in-game icon, so it uses
Rapid Synthesis's.

| Crystal | Where it shows up |
|---|---|
| **Divination** (live cleaning rate) | Header badge left of "UBIF support" (just the % when the header is tight) |
| **Swiftcast** (cleaning auto-close) | Round purple ⚡ in a cleaning arrival's "Customer arrival" drawer |
| **Recitation** (text → WO note) | Automatic: texting a customer from a WO adds a note "<you> sent a text message to <customer>." + the message |
| **Esuna** (WO cleanings pill) | After the customer's name on a WO: **Cleanings available (n)** / **Cleanings done (n)** / **No cleanings**; click for the list, with **Create** on available ones |
| **Macrocosmos** (Galaxy Diagnostics exception) | The Macrocosmos icon, bottom-right on a Samsung WO once it has a GSPN ticket; click to file, drag to move |
| **Quick Synthesis** (print all labels) | Purple button next to "Generate Labels" on a PO Receive page |
| **Bountiful Yield** (buyback add-all) | **Add all Apple devices (TLC)** / **Add all Samsung/Google parts (UROC)** in a buyback order's Add Buyback parts popout (Buybacks tab) |
| **Glamour** (page theming) | Settings → Glamour: preset themes (Limsa Lominsa, Gridania, Crystarium, Ul'dah, Ishgard, The Void) or your own from a background, text and accent colour; recolours the whole portal |
| **Waymark** (work-order tags) | **+ Tag** after the customer's name on a WO; the Waymarks button in the header opens a board of open WOs grouped by tag; Settings → Waymark holds the store's tag list |

**Settings:** avatar menu (top right) → **Aethernet settings**, or the
Tampermonkey menu. Turn crystals on/off; a crystal's own settings (cleaning
target %, Galaxy form overrides, label delay) open from **Settings** under it.
Saving reloads the page.

**Updates:** the first page load after an update shows an **Aethernet has
updated!** pill at the bottom of the screen, once; click it for the patch notes.
Crystals added in an update carry a yellow sheen and a **New** tag until
Settings has been closed once.

**Patch notes:** Settings → **Patch notes** (bottom), or click the update pill.
They live in `patch-notes.json` (newest first). Every release needs an entry
there first: `build.py --release` refuses without one, and stamps the entry
with the publish time.

**Build output:** `build.py` writes three files to `dist/` and `--release`
publishes all three to the Gist:
- `aethernet.user.js`: what installs run, minified with esbuild (pinned,
  via `npx`; `--keep-names` so errors still name the function) with CSS
  squashed. About 143 KB, down from 218 KB.
- `aethernet.meta.js`: just the header (~1 KB). `@updateURL` points here,
  so Tampermonkey's update checks don't download the whole script.
- `aethernet.readable.js`: the same build, unminified, linked from About
  for anyone who wants to read what it does.

Anything injected into the page as a script must be a plain string, not a
function's `.toString()`: minified functions lean on esbuild helpers that
only exist inside the bundle.

**Check for updates:** Settings → **Check for updates** (bottom). Every release
also updates `status.json` on the Gist; running installs see an **update
available** pill within ~15 minutes. Updating is one click: it opens the
install link, and Tampermonkey shows its own Update page. (Aethernet never
downloads and runs code itself; updates always go through Tampermonkey.)

**Notices:** a banner under Portal's header for a known issue, read live from
`status.json` (no release needed; everyone sees it within ~15 minutes):

    python3 build.py --status warning "Title" "Message" --crystal cleaningRate [--pause autoClose]
    python3 build.py --status-update "New message"
    python3 build.py --status-fixed 2.11.1      # hidden for installs at/after 2.11.1
    python3 build.py --status-clear

`--pause` is a kill switch: those crystals stop acting everywhere until the
notice is cleared (or the install reaches `fixedIn`). The file is treated as
untrusted data: plain text only, capped, ids checked; it can show a message
or pause crystals, never run code or turn anything on.

**Nothing personal is hardcoded.** Name, email and store come from the
logged-in user (`/api/auth/user`), so the same file works for anyone at any
store. The Galaxy fields can still be overridden in settings.

**Look:** everything uses Portal's own design tokens (`--aui-*`) and font,
so it follows Portal's light/dark theme. The settings menu item is a clone
of Portal's own "View my account" item.

### Install (auto-updates)

**Install link:**
https://gist.githubusercontent.com/Unix-Epoch/0cf4560c4f26d8ff9091a10068fd3464/raw/aethernet.user.js

1. Install **Tampermonkey** for your browser. Violentmonkey also works;
   **Greasemonkey does not** (its storage API breaks settings and the Galaxy
   handoff).
   - Chrome, Brave, Vivaldi, Opera, Arc: Chrome Web Store
   - Edge: Microsoft Edge Add-ons
   - Firefox and forks (Zen, LibreWolf, Waterfox, Floorp): addons.mozilla.org
2. **Chrome / Edge only:** right-click the Tampermonkey icon → **Manage
   extension** → turn on **Allow User Scripts** (older versions: **Developer
   mode**). Without this the install succeeds but nothing appears.
3. **Remove the old standalone scripts** if you had them (Galaxy, Print all
   labels, Cleaning auto-close, Cleaning rate, Select All - Buybacks, or a
   pasted-in Aethernet).
   Otherwise every button shows twice.
4. Open the install link above → Tampermonkey's install page opens → **Install**
   → reload Portal.

Updates arrive automatically: Tampermonkey checks the link daily, or
immediately via **Tampermonkey → Utilities → Check for userscript updates**.

Tested in Chrome. Edge (same engine) should behave the same. Firefox is
likely fine but untested; the two things to check there are that the cleaning
badge loads, and that the Galaxy form fills on a GSPN WO.

The Gist is **secret**: it isn't listed or searchable, but anyone with the link
can read the code (true of any userscript). Nothing secret is in it; it uses
each person's own portal login.

### Editing

Crystals live in `src/`, one file each, loaded in filename order:
`00-core.js` (settings storage, profile, API helper, shared styles and progress
panel), `05-settings.js`, then the crystals. Each crystal registers with
`AE.crystal({...})` and runs in its own try/catch, so one breaking can't take the
others down. To ship a change: bump `VERSION` in `build.py`, then
`python3 build.py --release`. It builds, refuses to publish unless `VERSION` is
higher than the published one (read via the GitHub API, since the raw URL can
be cached), and uploads to the Gist with `gh` (signed in as Unix-Epoch).
`python3 build.py` alone just builds `dist/` for local testing.

The print-labels **bookmarklet** (no Tampermonkey needed) stays separate:
`print-all-labels.bookmarklet.*`.

_Not affiliated with or supported by Asurion/uBreakiFix._

## print-all-labels — "Print all labels" for PO receiving

**Problem:** on a Purchase Order → Receive page, a line item with 100 units
expands to 100 individual serial rows, and printing the item label for each one
is a manual `⋮` → **Print Label** per row.

**What this does:** clicks that same `⋮` → **Print Label** for every serial row
on the page, one after another with a pause between each so a DYMO LabelWriter
keeps up. It does **not** receive stock or change anything on the server —
"Print Label" is print-only.

### How Portal prints a label (for reference)

The page loads DYMO Connect's JS SDK (`dymo-connect-framework.js`). Each
**Print Label** click hands that serial's label to the local DYMO Connect / DYMO
Web Service (`https://127.0.0.1:41951/DYMO/DLS/...`), which sends it to the
attached LabelWriter. So this only actually prints on a machine where **DYMO
Connect is installed and running** with a LabelWriter attached — the same
requirement as clicking the buttons by hand.

### Option A — Aethernet (adds a real button to the page)

1. Install Aethernet (see the top of this file).
2. Open any PO → Receive page. A purple **"⎙ Print all labels"** button appears
   next to *Generate Labels*.
3. Click it → panel shows the count → **Print N** → walk away. **Stop** halts it;
   **Retry missed** re-runs only rows that didn't fire.

### Option B — bookmarklet (no extension)

1. Bookmarks bar → right-click → **Add page…**
2. Name: `Print all labels`
3. URL: the single line from `print-all-labels.bookmarklet.txt` (starts with
   `javascript:`).
4. On a PO → Receive page, click the bookmark. Same panel/flow as above.

### Tuning

- **`DELAY_MS`** (top of either file, default `900`) — milliseconds between
  labels. If labels come out missing or the printer chokes, raise it. To go
  faster, lower it. After editing the bookmarklet source, regenerate the
  one-liner:

  ```
  python3 -c "import re;s=open('print-all-labels.bookmarklet.js').read();s=s.split('*/',1)[1];s='\n'.join(l for l in s.splitlines() if not l.strip().startswith('//'));open('print-all-labels.bookmarklet.txt','w').write('javascript:'+re.sub(r'\s+',' ',s).strip()+'\n')"
  ```

### First run — sanity check

Because printing depends on the DYMO service, do a small test first: start it,
hit **Stop** after ~3, and confirm 3 labels actually came out before letting it
run the full batch.

### If it stops working

The script keys off two attributes in Portal's markup:
`button[data-aui="action"]` (the row's `⋮`) and
`button[data-testid="option-printLabel"]` (the menu item). If a portal update
renames either, update the selector constants at the top of the file —
`SEL_MENU_BTN` / `SEL_PRINT_OPT` in the userscript, `SEL_MENU` / `SEL_OPT` in
the bookmarklet.

### Safety behavior (v1.1, 2026-09-23)

- **One panel, one run.** Clicking the button (or bookmark) again while a
  panel is open just flashes that panel; **Print N** disables itself once
  pressed — so labels can't be printed twice by a double start.
- **Stale menus are closed first.** Before each row, any still-open
  "Print Label" menu is dismissed (Escape / click-away). If one won't close,
  that row counts as *missed* rather than printing the previous row's label
  a second time.
- **Appears without a refresh.** The userscript matches the whole portal and
  shows the button only on `…/purchase-orders/<id>/receive`, since Portal
  changes pages without a full reload.

---

## galaxy-diagnostics-exception — "File Galaxy Diagnostics Exception" button

**Problem:** filing a Galaxy Diagnostics exception for a Samsung Asurion repair
means leaving the WO page, opening Asurion's Sprinklr request form
(`forms-prod.sprinklr.com`), and hand-typing the GSPN ticket number, IMEI, and
device name — plus picking the right three-level cascade (Issue Type →
Exception Type → Reason) and a handful of fixed fields every single time.

**What this does:** a button appears on the work order page **once a GSPN
ticket exists** (it watches for the "GSPN No. ######" badge). Click it and it
opens the Sprinklr form in a new tab, pre-filled end to end — every dropdown
in the cascade, GSPN ticket number, IMEI, device name, WO number, and all the
fixed fields (technician, tool version, location, "ER" description). **It does
not click Submit** — that's still on you, since it's a real support ticket.

Needs Tampermonkey (this one only comes as a userscript — the two halves live
on different sites and have to share data through Tampermonkey's storage,
which a bare bookmarklet can't do). Part of Aethernet.

### How the two halves talk to each other

One script file, two `@match` blocks — one for the WO page, one for the exact
Sprinklr form URL. Tampermonkey's `GM_setValue`/`GM_getValue` storage is
scoped **per script**, not per domain, so the WO-page half can stash the data
under a key and the Sprinklr-page half can read it back even though they're
different origins with no login connecting them (the Sprinklr form is public —
no auth to worry about). A stale value (>10 min old, i.e. you opened the form
some other way) is ignored rather than auto-filled. Handoffs are stored per
WO, and each form tab takes the oldest waiting one — so filing two WOs back
to back fills each tab with its own WO.

### Using the button (v1.2)

- **Drag** it by the dotted grip; **double-click the grip** to reset it to the
  bottom-right corner. Its position is kept on-screen when the window
  shrinks.
- **Collapse/expand** with `‹` / `›` (collapsed = just the clipboard icon); the state is remembered.
- It appears when you navigate into a WO from the list — no refresh needed
  (the script matches the whole portal and checks the path itself).
- The form tab opens **immediately** on click and is pointed at the form
  once the WO data arrives, so Chrome's popup blocker doesn't eat it on a
  slow API response.
- If your portal session has expired, you get a "log in again" message
  instead of a JSON error.
- On the form, if **any** field couldn't be filled (e.g. a renamed store or
  dropdown option), the banner turns **red and lists the missing fields**;
  green means every field was filled.

### Where each field comes from

| Field | Source |
|---|---|
| GSPN Ticket Number, IMEI, Portal WO Number | pulled live from `/api/workorder/<id>` |
| Device Full SKU | the device's human-readable catalog name (e.g. "Samsung Galaxy Fold7 Blue Shadow") — Garrett confirmed that's what goes in this field, not a real Samsung SM-xxxx SKU |
| Your email, Technician Name | the logged-in user (overridable in Aethernet settings) |
| UBIF Location | `{storeId} {storeName}` of the current store, e.g. "914 Newport News" (overridable) |
| Tool Version, Description | settings (default "Latest", "ER") |
| Store email address | settings (blank by default) |
| Repair Location Type / Issue Type / Exception Type / Exception Reason | always `Store`, `Exception Request` → `Galaxy Diagnostic Tool` → `Asurion Repair` |

### Verified live (2026-09-16)

Ran the actual fill sequence against a real WO (#500481571, Samsung Galaxy
Fold7, GSPN No. 4186540303) — every field landed correctly, cascade included,
confirmed by screenshot. Not submitted (by design).

### If it stops working

`fieldByLabel()` matches Sprinklr's form fields by their exact `<label>` text,
and dropdown options by exact rendered text — if Asurion relabels a field or
changes the option wording, update the matching string in `src/30-galaxy.js` (`FIXED`) or the
`fillText`/`selectOption` calls in Part B. If the GSPN badge text ever stops
reading "GSPN No. ######", update the regex in `gspnTicketOnPage()` (Part A).

_Built 2026-09-16. Not affiliated with or supported by Asurion/uBreakiFix._

## cleaning-wo-autoclose — one-click close for cleaning arrivals

**Problem:** cleaning-program WOs (Verizon Device Refresh / Sanitization, AT&T
Enhanced Device Cleaning / Device Diagnostic / Performance Check) aren't
physical repairs, but still take ~3 min of clicking: check-in, five status
steps, and a $0 checkout.

**What this does:** open a cleaning arrival (Arrivals → click the customer).
A round purple ⚡ button appears at the far left of the drawer footer. One click
checks it in, walks the WO to Ready for pickup (posting the same auto-notes
the UI does), and completes the $0 sale. A panel shows each step, and **■ Stop**
halts it before the next call; the panel links the WO wherever it stopped.

- Refuses anything not in `CLEANING_PROGRAM_IDS`.
- Stops before checkout if the cart isn't exactly $0.
- IMEI comes from the arrival (all 15 digits); if validation fails it tries
  the other last digits 0–9.
- Skips the UI's customer-record and device re-saves (would blank the shared
  device's nickname/passcode on the parent WO).

Part of Aethernet.

**First run:** watch it on one real cleaning arrival. If it fails at check-in,
the skipped re-saves above are the first suspects.

## cleaning-rate — live cleaning percentage badge

**What it shows:** a badge in Portal header, e.g. `Cleanings 8/9 · 89%`
= cleanings linked to today's Asurion Mobility orders ÷ Asurion Mobility
orders created today (local time). Each cleaning counts on its own, so it can
go over 100%. Red below 75%, amber 75–99%, green at 100%+. Click it for each
order (customer name, WO, time) with its cleanings (or **No cleanings**), and
any of today's cleanings not linked to an order.

**Create from the list** (v2.2): with auto-close on, each pending chip has a ⚡
that runs the auto-close for that arrival. It (and the WO pill's **Create**)
always asks first: "Are you sure you'd like to create this cleaning? Only use
this if you are the one who repaired this device!" The drawer ⚡ doesn't ask,
since you're looking at the arrival itself.

**Pending cleanings count** (v2.1): a cleaning arrival created today that
hasn't been checked in yet shows as a dashed "· pending" chip linking to the
arrival, and counts toward the rate. Once checked in it's counted as the WO
instead (matched on IMEI + program), never twice. Refreshes every 2 min (paused while the tab is hidden).
Raw percentage only: reason notes aren't considered.

**How:** read-only list calls per refresh (`POST /api/workorders` Active and
Closed, plus `GET /api/arrivals/upcoming-arrivals?pageSize=100`), both scoped by Portal to the logged-in user's current store,
so it works at any store with no setup. Cleanings link to orders by device
IMEI, because AT&T cleanings are often under a different customer record.

**For other stores:** install Aethernet. Program IDs are in `src/00-core.js`
(`CLEANING_PROGRAMS`); they're believed company-wide but have only been
confirmed at store 914.

## text-notes — texts logged as WO notes (v2.3)

When you text a customer from a work order, Aethernet adds a WO note:

> Garrett Green sent a text message to Grace Beech.
>
> <the message>

It watches the browser's own network log (`PerformanceObserver`) for the
portal's `POST …/messages/v1/send`. When one happens on a WO page, it reads that
customer's message history and logs each of *your* outbound messages from the
last few minutes that isn't logged yet (message IDs are remembered, so nothing
is logged twice). Finding the message in the history also confirms it went out.
It never sends texts itself. (v2.3.2: wrapping `fetch` didn't work because the
portal's messaging code keeps its own copy of `fetch` from load time.) The
note is a regular note (`noteType: 2`) tagged with the WO's current status via the
portal's own status → tag map. The Notes tab may need a refresh to show it.

## buybacks — bulk add on buyback orders (v2.5)

Crystallized from the standalone **Select All - Buybacks** v1.1.1 (it lived only
in Tampermonkey on Zen; source preserved in `legacy/select-all-buybacks.user.js`).
On a buyback order's **Add Buyback parts** popout, Buybacks tab, adds **Add all
Apple devices (TLC)** (destination "Asurion Reverse Logistics") and **Add all
Samsung/Google parts (UROC)**, each with a live count, plus **Stop** while running.
It clicks each row's own add button by serial number, waits for the row to
leave and the list to refill, and stops itself on stalls, a 500-click cap or 10
minutes.

**Fixed in the crystal:** the old script's buttons often didn't appear, because
its `@match` was only `/boh/inventory/buyback-order/*` and Tampermonkey injects
only on a real page load. Arriving from any other portal page meant it never
ran, which is why removing and re-adding it "fixed" it. The crystal runs
portal-wide and checks the path itself. Verified live: the toolbar appeared on
two buyback orders in a row, reached by in-portal navigation.

## Waymark — shared work-order tags

Tags are shared by everyone at a store and live outside Portal (no Portal
notes), in a Cloudflare Worker + D1 database: `worker/` in this repo,
deployed at https://aethernet-waymark.ubifaethernet.workers.dev (account:
the Cloudflare login used with `npx wrangler login`).

- Data per Portal store ID: the managed tag list (name, colour, order), tags
  on WOs (managed or one-off), and our own history log (who added/removed
  what, when; list edits too).
- Aethernet reports tagged WOs that have left Portal's Active list; a daily
  cron (09:00 UTC) deletes their tags and history 7 days later. List-edit
  history is kept 90 days.
- Editing the list is limited to Portal's Store Manager (Corp/Franchisee),
  District Manager (and - Franchisee) and Store Owner - Franchisee roles for
  the signed-in store (`GET /api/auth/user/stores`). Everyone can tag and add
  one-offs.
- **Trust model:** the Worker can't see Portal logins, so the role check and
  "who did it" are asserted by Aethernet, not verified. The app key in
  `worker/wrangler.toml` ships inside Aethernet; it only keeps random
  traffic out (plus a 120 requests/minute per-IP limit). Fine for tags; don't
  store anything sensitive this way. Tag text is plain text everywhere.
- Deploy changes: `cd worker && npx wrangler deploy`. Schema: `schema.sql`
  (`npx wrangler d1 execute aethernet-waymark --remote --file=schema.sql`).
- Test a build against a local Worker: `npx wrangler dev --local` in
  `worker/`, then `WAYMARK_API=http://localhost:8787 python3 build.py`.


## Feedback, usage and admin

- **Send feedback** (avatar menu → Send Aethernet feedback, Settings footer,
  Tampermonkey menu): a bug report or suggestion, stored by the Worker
  (`feedback` table) with name, store, version, browser and page path; bug
  reports can add diagnostics (enabled crystals, last Aethernet errors).
  Submit-and-done. When a suggestion ships, credit the person in that
  release's `patch-notes.json` entry: `"credits": ["Name (Store)"]`.
- **Usage**: `AE.track('crystal:action')` / `AE.trackDaily(...)` count per
  person, store, feature and day (`usage` table, kept 180 days), uploaded
  every 5 minutes. Disclosed in Settings and About. No page contents or
  customer data.
- **Admin** (inbox + usage charts): ten quick clicks on the crystal in the
  Settings header. Needs the `ADMIN_KEY` Worker secret, kept in
  `worker/.admin-key` (git-ignored) and entered once per browser; it never
  ships in the script. Set/rotate: `cat worker/.admin-key | npx wrangler secret put ADMIN_KEY`.
- **Patch notes never mention the admin panel or usage analytics.**

## Dev channel

Two channels, two installs:

| | Public | Dev |
|---|---|---|
| Git branch | `main` | `dev` |
| Tampermonkey script | Aethernet — crystals for NextGen Portal (`garrett.ubif`) | Aethernet (dev) (`garrett.ubif.dev`), own storage |
| Gist | `0cf4560c…` | `9ac1e1db…` (secret) |
| Worker | aethernet-waymark | aethernet-waymark-dev (`wrangler deploy --env dev`), same D1 database, no cron |
| Version | `VERSION` (2.15.0) | `DEV_BASE.N` (2.16.0.1, 2.16.0.2 …; `dev-build.txt`) |
| Build | `build.py` / `--release` | `build.py --dev-build` / `--dev` (publish) |

**Workflow (Garrett, Sep 30, 2026):** every feature is committed to `dev` and
published with `build.py --dev` straight away. When Garrett asks to bundle the
session: merge `dev` into `main`, set `VERSION = DEV_BASE` (and bump
`DEV_BASE`), write one combined patch-notes entry, `build.py --release`.

**Dev install:** https://gist.githubusercontent.com/Unix-Epoch/9ac1e1dbc80caa3dff04afb5b89e90c3/raw/aethernet.user.js
Turn the public Aethernet off in Tampermonkey while the dev one is on (the dev
build warns if both run). The dev build is fully working: it acts on real
Portal data like the public one.

**Dev tools** (`src/dev/`, dev builds only; the orange DEV tab on the left, or
the Tampermonkey menu): every popup and automatic feature on demand —
update pills and Check for updates states, notices (info/warning/error, paused,
fixed-in), the New sheen, the Macrocosmos button + explainer on any WO,
Waymark's due badge and manager bubble, the real morning check, an
Auto-Waymark **dry run** (what the scan would mark/rename, nothing written),
a shifted clock for the 7 PM and morning rules, the scan for real (asks
first), the Swiftcast progress panel (fake), toasts, the confirm dialog and
recent errors. Modules expose what the dev tools need through `AE.hooks`.
