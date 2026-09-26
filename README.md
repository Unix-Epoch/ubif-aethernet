# UBIF Portal tools

Small browser add-ons for `portal.ubreakifix.net` chores that the portal makes
tedious.

## print-all-labels — "Print all labels" for PO receiving

**Problem:** on a Purchase Order → Receive page, a line item with 100 units
expands to 100 individual serial rows, and printing the item label for each one
is a manual `⋮` → **Print Label** per row.

**What this does:** clicks that same `⋮` → **Print Label** for every serial row
on the page, one after another with a pause between each so a DYMO LabelWriter
keeps up. It does **not** receive stock or change anything on the server —
"Print Label" is print-only.

### How the portal prints a label (for reference)

The page loads DYMO Connect's JS SDK (`dymo-connect-framework.js`). Each
**Print Label** click hands that serial's label to the local DYMO Connect / DYMO
Web Service (`https://127.0.0.1:41951/DYMO/DLS/...`), which sends it to the
attached LabelWriter. So this only actually prints on a machine where **DYMO
Connect is installed and running** with a LabelWriter attached — the same
requirement as clicking the buttons by hand.

### Option A — userscript (adds a real button to the page)

Needs the Tampermonkey (or Violentmonkey) Chrome extension.

1. Tampermonkey → **Create a new script** → paste `print-all-labels.user.js` →
   save.
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

The script keys off two attributes in the portal's markup:
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
  shows the button only on `…/purchase-orders/<id>/receive`, since the portal
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
which a bare bookmarklet can't do). Install: Tampermonkey → **Create a new
script** → paste `galaxy-diagnostics-exception.user.js` → save.

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

- **Drag** it by the `⠿` grip; **double-click the grip** to reset it to the
  bottom-right corner. Its position is kept on-screen when the window
  shrinks.
- **Collapse/expand** with `«` / `»`; the state is remembered.
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

### What's fixed vs. what's pulled from the WO — edit `CONFIG` at the top to change any of the fixed ones

| Field | Source |
|---|---|
| GSPN Ticket Number, IMEI, Portal WO Number | pulled live from `/api/workorder/<id>` |
| Device Full SKU | the device's human-readable catalog name (e.g. "Samsung Galaxy Fold7 Blue Shadow") — Garrett confirmed that's what actually goes in this field, not a real Samsung SM-xxxx SKU |
| Your email, Technician Name, Tool Version, UBIF Location, Repair Location Type, Description | fixed constants in `CONFIG` |
| Store email address | left blank |
| Issue Type / Exception Type / Exception Reason | always `Exception Request` → `Galaxy Diagnostic Tool` → `Asurion Repair` |

### Verified live (2026-09-16)

Ran the actual fill sequence against a real WO (#500481571, Samsung Galaxy
Fold7, GSPN No. 4186540303) — every field landed correctly, cascade included,
confirmed by screenshot. Not submitted (by design).

### If it stops working

`fieldByLabel()` matches Sprinklr's form fields by their exact `<label>` text,
and dropdown options by exact rendered text — if Asurion relabels a field or
changes the option wording, update the matching string in `CONFIG` or the
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

Install: Tampermonkey → **Create a new script** → paste
`cleaning-wo-autoclose.user.js` → save.

**First run:** watch it on one real cleaning arrival. If it fails at check-in,
the skipped re-saves above are the first suspects.

## cleaning-rate — live cleaning percentage badge

**What it shows:** a badge in the portal header, e.g. `Cleanings 8/9 · 89%`
= cleanings linked to today's Asurion Mobility orders ÷ Asurion Mobility
orders created today (local time). Each cleaning counts on its own, so it can
go over 100%. Red below 75%, amber 75–99%, green at 100%+. Click it for each
order with its cleanings (or **No cleanings**) and any of today's cleanings
not linked to an order. Refreshes every 2 min (paused while the tab is hidden).
Raw percentage only: reason notes aren't considered.

**How:** two read-only list calls per refresh (`POST /api/workorders`, Active
and Closed), both scoped by the portal to the logged-in user's current store,
so it works at any store with no setup. Cleanings link to orders by device
IMEI, because AT&T cleanings are often under a different customer record.

**For other stores:** install Tampermonkey → **Create a new script** → paste
`cleaning-rate.user.js` → save → reload the portal. Program IDs are in
`CONFIG` at the top; they're believed company-wide but have only been
confirmed at store 914.
