# Portal sandbox

Portal's real web app running on **fake data**, for trying Aethernet's shards
(Swiftcast, Dualcast, Esuna, Divination, Recitation…) without touching a single
real work order, arrival or customer.

```
python3 sandbox/server.py          # then open http://localhost:8790/sandbox
```

The sandbox is store 999999 (no Aethernet access) on purpose: never point it, or a patched Aethernet build running in it, at the real Workers.

- **The app** is Portal's own (index page + `/assets`, fetched read-only from
  portal.ubreakifix.net and cached in `.cache/`), with FullStory/Appcues removed
  and its API address rewritten to the sandbox.
- **Every `/api` call is answered here** (`api.py`) from `state.json`: fake
  customers, devices, work orders, arrivals, carts and notes. A
  Content-Security-Policy header stops the page from contacting anything else
  (only Portal's icon/font host and its interface-text service are allowed), so
  nothing can reach real Portal even by accident.
- **`/sandbox`** (control page): create a device with an Asurion Mobility WO and
  cleaning arrivals, mark them Contacted, set the store open/closed, set the
  price of refresh labor 10156, reset, and see Portal's calls — including the ones
  the sandbox doesn't answer yet.
- **Aethernet**: the **dev** build matches `http://localhost:8790` and knows it's
  in the sandbox (`AE_SANDBOX`): no store check, no Waymark/feedback/usage calls
  to the Worker, and Divination's history is kept under its own key. The dev
  tools tab reads **SANDBOX**. Turn the public Aethernet off while testing.
- **`capture.py`** refreshes `fixtures/` (git-ignored): Portal's configuration
  responses (permissions, features, store options, program settings) and one WO
  template, copied read-only through the ubif-workorders tracker session with
  every personal/device value blanked. Re-run it if Portal changes shape.

- **`shot.py`** is the Playwright harness for screenshots and tests: `async with portal_page('/repair/workorders') as pg:` loads the sandbox with a Tampermonkey stand-in and `dist-dev/aethernet.user.js`; helpers `shot`, `open_menu`, `inject_html`. CLI: `sandbox/shot.py /arrivals out.png`. Run it with `~/Scripts/ubif-daily-sales/.venv/bin/python` (Playwright lives there). Output goes in `sandbox/shots/` (git-ignored).
