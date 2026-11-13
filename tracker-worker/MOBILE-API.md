# Linkpearl phone API (native Android app)

The app talks to the **tracker Worker**, not the admin site. Each phone is a registered *device* (the tracker's "agents" mechanism, marked `kind: "phone"`), approved once by the owner on the admin site. There is no Cloudflare Access cookie and no password on the phone.

- Base URL: `https://aethernet-tracker.ubifaethernet.workers.dev` (name from `wrangler.toml`; `workers.dev` subdomain as deployed).
- Every request: header `x-aethernet-key: <public app key>` (the `APP_KEY` var in `wrangler.toml`; it ships inside the userscript, so it is a gate against strangers, not a secret). Missing or wrong: `403 {"error":"app key required"}`.
- Authenticated requests also send `authorization: Bearer <id>.<token>` (below). JSON bodies use `content-type: application/json`. All answers are JSON with `cache-control: no-store` (Home adds `private, max-age=60`).
- Errors: `{ "error": "message" }` with the HTTP status. Unexpected failures are `500 {"error":"server error (id 1a2b3c4d)"}`; quote the id, the real error is in the Worker log. `429 {"error":"slow down"}` from a per-IP limit (240 requests per minute); back off.

## Registration, step by step

1. **Generate on the phone** (once, keep them): an EC key pair on **P-256**; a device `id` = 32 lowercase hex chars (16 random bytes); a `token` = 64 lowercase hex chars (32 random bytes, from a secure RNG). Store the token in encrypted storage (e.g. EncryptedSharedPreferences). The server keeps only `sha256(token as the 64-char ASCII hex string)`.
2. **Register** (app key header only, no Bearer):

   ```
   POST /v1/agents/register
   {"id":"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","name":"Pixel Fold","kind":"phone",
    "publicJwk":{"kty":"EC","crv":"P-256","x":"<43 chars>","y":"<43 chars>"},
    "token":"b2b2…b2 (64 hex)"}
   → 200 {"id":"a1a1…","fingerprint":"3F2A-91C0-7B44-0DDE","status":"pending","kind":"phone"}
   ```
   - `name`: the device's display name (shown on the admin approval page next to a "Phone" tag; control characters stripped, 60 chars max). `kind` must be `"phone"` (anything else: 400).
   - `publicJwk`: exactly `kty:"EC"`, `crv:"P-256"`, `x` and `y` as **unpadded base64url of 32 bytes (43 chars each)**; left-pad each coordinate to 32 bytes (Android's `ECPoint` BigIntegers drop leading zeros). A `d` member is refused (400): never send the private key.
   - Errors: `400 {"error":"id, name, publicJwk and token required"}`, `409 already registered` (id taken), `429 too many phones waiting for approval` (3 pending phones at most; pending registrations older than 7 days are purged at the next registration, after which their token stops working), `429 too many phones` (10 phones in all), `429 too many programs waiting for approval` (5 pending agents of any kind).
   - `fingerprint`: first 16 hex chars of `sha256(JSON.stringify({crv,kty,x,y}))` in that key order, upper-case, in groups of 4. Show it on the phone so the owner can compare it with the admin page when approving.
3. **Poll for approval** (no extra endpoint; same token): `GET /v1/agents/me` with the Bearer header, every 10–30 s while the "waiting" screen is open.
   ```
   → 200 {"id":"a1a1…","name":"Pixel Fold","kind":"phone","status":"pending","stores":[],"fingerprint":"3F2A-…","keys":[],
          "settings":{…audit defaults, ignore…},"runNow":false,"lastRun":null}
   ```
   `401 unknown program or wrong token` means the registration was removed (revoked, or expired after 7 days pending): register again with a new id and token.
4. **After the owner approves** (admin site, Work orders page unlocked, "Connected programs", Approve…): the same call returns `"status":"active"`, `"stores":[914,326]` (the approved store ids) and one wrapped store key per store:
   ```
   "keys":[{"store":914,"publicJwk":{"kty":"EC","crv":"P-256","x":"…","y":"…"},"wrapped":"v1.<base64url>"}, …]
   ```
   Keep `stores` and `keys` (refresh them on each launch: the owner may change the stores later, which replaces the grant and the wrapped keys). Home needs no keys; keys are only for sealed data (below).
5. **Revoke**: the owner removes the device on the admin page; the next request answers `401 unknown program or wrong token`. The app should then show the registration screen. A phone that is not approved gets `403 not approved yet` on `/v1/agents/m/…`.

## Token format

`Authorization: Bearer <id>.<token>`: the 32-hex id, a dot, the 64-hex token (regex `^Bearer ([0-9a-f]{32})\.([0-9a-f]{64})$`). Wrong/unknown/missing: `401 {"error":"unknown program or wrong token"}`. There is no expiry on an approved device; revocation is the owner's removal.

## Routes

| Route | Status | Answer |
|---|---|---|
| `POST /v1/agents/register` | built | above (app key only) |
| `GET /v1/agents/me` | built | above; also the approval poll |
| `GET /v1/agents/m/home?store=<id>\|all[&fresh=1]` | built | Home's numbers, below |
| `/v1/agents/m/wo…` | reserved, `501 {"error":"not built"}` | work order lookup/unlock (`src/mobile-wo.js`) |
| `/v1/agents/m/alerts…`, `/v1/agents/m/push…` | reserved, 501 | alerts and push (`src/mobile-alerts.js`) |
| `/v1/agents/m/prefs…` | reserved, 501 | settings (`src/mobile-prefs.js`) |
| `GET /v1/agents/wos?store=<id>&closedDays=<0-14>` | existing (the Mac audit's route; a phone may use it) | open work orders plus ones closed within `closedDays` (default 3, max 14), each with its plain columns, `plain` JSON and latest sealed snapshot; `403 not approved for this store` otherwise |

Other `/v1/agents/m/…` paths are `404`. A Mac agent (not a phone) calling `/m/…` gets `403 not a phone`.

### Home: `GET /v1/agents/m/home`

Identical to the admin site's `/api/m/home` (same code, `src/mobile.js`), limited to the device's approved stores. `store=all` (default) totals only the approved stores; a store that is not approved is `403 {"error":"not your store"}`; a malformed one `400`. Cached 60 s server-side; `fresh=1` skips the read. About 1–2.5 KB. No customer or staff names.

```
{ v: 1, now: ISO UTC, tz: "America/New_York", today: "YYYY-MM-DD" (the store day),
  scope: <store id> | "all", stores: [{ id, name|null }]   (approved stores only),
  days: [7 store-day strings "YYYY-MM-DD", oldest first, last = today],
  sales: { today, yesterday: dollars|null, week: [7 × dollars|null] },
  splh:  { today: dollars per labor hour|null, hours: labor hours today|null, week: [7 × number|null], target: [160, 180] },
  rfp:   { total: dollars, count: devices Ready for pickup, oldestDays: integer|null, ages: [{ label, n }] },
  lanes: { order, start, work, wait, rfp, total }   (open work order counts; order = Need to order, start = Ready to start, work = Work started, wait = Waiting, rfp = Ready for pickup),
  cleaning: { cln: linked cleanings|null, am: Asurion Mobility orders|null, rate: 0..1+ |null, week: [7 × rate|null] },
  asOf: ISO UTC of the last store scan (the oldest across the stores)|null,
  stale: boolean (no scan for more than 45 minutes during store hours),
  behind: { id, name }|null   (the stalest store, when scope is "all"),
  byStore?: [{ id, name, asOf, stale, sales, splh }]   (only when scope is "all" and more than one store) }
```
- `null` means "no data": show a dash, never 0. `splh.today` is null until today's labor hours are uploaded. `cleaning.rate` can exceed 1.
- Money is dollars (numbers, 2 decimals). Times are ISO-8601 UTC strings. "Today" and every `days` entry are **store days** in `tz` (not the phone's zone and not UTC; the day changes at local midnight, 25 h on the DST day). Format "As of 4:12 PM" in `tz`.
- No stores approved: `200 {"v":1,"stores":[],"empty":true}`.

## Sealed data and wrapped store keys (exact crypto, from `src/crypto.js`)

Everything customer-related is sealed on the server side of the wire: the server never holds a readable copy. A phone opens it in two hops.

All keys are **ECDH P-256**. Sealed value format `"v1." + base64url(epk | iv | ct)` (base64url without padding), where `epk` = 65 bytes (uncompressed point `04‖X‖Y`, the sender's ephemeral public key), `iv` = 12 bytes, `ct` = AES-256-GCM ciphertext with the 16-byte tag appended (the JCA/WebCrypto layout).

To open a sealed value with private key `d` and a string `aad`:
1. `shared` = ECDH(`d`, `epk`), the 32-byte x-coordinate (WebCrypto `deriveBits(256)`; Android `KeyAgreement.getInstance("ECDH")`).
2. AES key = HKDF-SHA256(IKM = `shared`, **salt = the 65 `epk` bytes**, **info = ASCII `aethernet-tracker v1`**), 32 bytes.
3. AES-256-GCM decrypt with `iv`, additional authenticated data = ASCII `aad`, 128-bit tag. A wrong `aad` fails, so a blob cannot be moved to another store or work order.

Hop 1, the store key: each `keys[].wrapped` from `/me` is the store's **PKCS#8 private key** (P-256), sealed to the phone's public key with `aad = "agentkey|<deviceId>|<store>"` (e.g. `agentkey|a1a1…a1|914`). Open it with the phone's private key; import the result as the store private key (hold it in memory or app-private encrypted storage; it is the secret that opens that store's data).

Hop 2, data: with the store private key, open `sealed` (work order snapshot, from `/v1/agents/wos`; `aad = "snapshot|<store>|<wo>"`) or `card` (search card; `aad = "card|<store>|<wo>"`) or `sale` (`aad = "sale|<store>|<saleId>"`). The plaintext of `sealed`/`card`/`sale` is **gzip-compressed UTF-8 JSON** (`openJson`: AES-GCM open, then gunzip, then parse).

**Android Keystore:** the phone's private key does **not** need to be exportable. Generate it in the Keystore as an EC `secp256r1` key with `PURPOSE_AGREE_KEY` (API 31+; Android 12 or later) and run `KeyAgreement` ECDH with the Keystore key for hop 1; do HKDF and AES-GCM in app code with the shared secret. Read the public key from the certificate/`PublicKey`, split it into 32-byte `x`/`y` and base64url them. The PKCS#8 store key from hop 1 is a normal software key (import as `ECPrivateKey` for `KeyAgreement`). If you need to support below API 31, generate the key in software and keep it in encrypted storage instead. The server only ever sees the public JWK.

Note: approving a phone requires the owner's browser to be unlocked, because the admin page wraps every approved store's key to the phone's key at that moment (a key is required for every approved store). A phone that only shows Home never uses the keys.

## Time, budgets, limits

- Times are ISO UTC. "Today" is the store day (`tz` in Home). The Worker clock is authoritative; compare `now` in Home with the phone's clock only for display.
- Per-IP limit 240 requests/minute across the whole Worker. Every authenticated call updates the device's `last_seen_at` (shown on the admin page). Home is cached 60 s; poll it no faster than once a minute and use `fresh=1` only for a manual refresh.
- Per-store write budgets (`src/budget.js`) concern the browsers that upload work orders, not phones. The phone API has no writes yet; new write routes must keep their own bounds (see the stub headers).

## File ownership for the parallel server streams

| Stream | Owns |
|---|---|
| Work orders + unlock | `src/mobile-wo.js`, `test/mobile-wo.test.mjs` |
| Alerts + push | `src/mobile-alerts.js` (including `alertsTick`, called every 10 minutes), `test/mobile-alerts.test.mjs`, its migration `migrations/2026-11-13-alerts.sql` (and the same statements appended to `schema.sql`) |
| Settings / prefs | `src/mobile-prefs.js`, `test/mobile-prefs.test.mjs` (and a migration `migrations/2026-11-13-prefs.sql` if it needs storage) |

Nobody else edits `src/index.js`, `src/mobile-agent.js`, `src/access.js`, `package.json`, `wrangler.toml`, `test/mobile-helpers.mjs`, `src/crypto.js` or the admin site. If a stream needs a shared change, it lists it in its report. Test helpers: `test/mobile-helpers.mjs` (`setup`, `registerPhone`, `approve`, `authed`, `scheduled`), used as in `test/mobile-agent.test.mjs`. `cd tracker-worker && npm test` runs everything.

Dispatch lives in `src/mobile-agent.js`: `woApi / alertsApi / prefsApi (req, env, url, device, h)` with `device = { id, name, kind:'phone', stores:[approved ids], active:true, publicJwk }` and `h = { json, fail, readJson, int, clean, iso, now, log, serverError }` (conventions in each stub's header comment).

## Deploy order (not done)

1. Apply the migration: `cd tracker-worker && npx wrangler d1 execute aethernet-tracker --remote --file=migrations/2026-11-13-mobile-devices.sql` (idempotent, additive).
2. Deploy the tracker Worker (this also registers the new 10-minute cron from `wrangler.toml`).
Before step 1 the Mac agent is unaffected (every agent reads as kind `agent`), and phone registration fails with a generic 500.
