/*
  Linkpearl: work order lookup and unlock, under /v1/agents/m/wo… (stream: Work orders + Unlock). STUB: answers 501 until built.
  Reserved routes: /v1/agents/m/wo (list / search), /v1/agents/m/wo/<store>/<wo> (detail, history, sealed card).
Conventions (read before filling in):
  - Auth is already done (mobile-agent.js, index.js agentApi): the device is a registered, owner-approved phone. `device.stores` is the list of
    store ids it was approved for; EVERY query must be limited to them (reuse the pattern in mobile.js homeApi: a requested store outside the list is 403
    "not your store", never silently ignored; "all" means all of device.stores). `device.id` identifies the phone (key per-device rows by it).
  - Helpers come in `h`: h.json(body, status), h.fail(status, "message"), h.readJson(req, maxChars) (413 / 400 on bad bodies), h.int, h.clean, h.iso, h.now(),
    h.log(env, "device:" + device.name, "action", store, wo, detail) for the access_log (log reads of sealed data; do not log Home-like polling).
  - Errors: deliberate answers are h.fail(4xx, msg) or `throw Object.assign(new Error(msg), { status: 4xx })`. Anything else that throws becomes a generic
    500 with a short id (index.js serverError); never put a database message or a name in an error. The body shape is always { error: "…" }.
  - Writes: additive migrations only (a new file in tracker-worker/migrations, CREATE TABLE IF NOT EXISTS, also appended to schema.sql so tests get it);
    per-device rows are bounded (cap counts, trim old rows), and a write route is POST/PUT/DELETE with a JSON body. Per-store write budgets (budget.js)
    apply to work order uploads, not to these routes: keep your own writes small and bounded.
  - Privacy: no customer or staff names, phones, emails or IMEIs in a response unless the route is explicitly a sealed-data route (it returns the sealed
    blob; the phone opens it with the store key it holds, see MOBILE-API.md). No such details in logs or notification text either.
  - Size: responses stay small (a phone on mobile data): lists are paged or capped (default 25, max 100), fields are plain columns, JSON only.
  - Time: stored and returned as ISO UTC; "today" is the store day in env.STORE_TZ (default America/New_York), see metrics.js local().
  - Tests: your own test file (see the list in MOBILE-API.md) uses test/mobile-helpers.mjs.
*/
export async function woApi(req, env, url, device, h) {
  return h.fail(501, 'not built');
}
