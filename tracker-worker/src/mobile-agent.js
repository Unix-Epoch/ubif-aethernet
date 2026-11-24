/*
  Linkpearl (the native Android app): the phone API on the tracker Worker. ONE place for dispatch.

    /v1/agents/m/home?store=<id>|all   Home's numbers (built; tracker-worker/src/mobile.js homeApi, same answer as the admin site's /api/m/home)
    /v1/agents/m/wo…                   work order lookup + unlock          → mobile-wo.js     woApi      (stub, 501)
    /v1/agents/m/alerts…               alerts, history                     → mobile-alerts.js alertsApi
    /v1/agents/m/push                  the phone's FCM token               → push.js          pushApi
    /v1/agents/m/retrace…              Retrace lookup: items, item, label, POs → mobile-retrace.js retraceApi (built)
    /v1/agents/m/prefs…                device details, rename, forget      → mobile-prefs.js  prefsApi
    /v1/agents/m/trends…               week / month / year series          → mobile-trends.js trendsApi
    /v1/agents/m/prices…               the store's price sheet             → mobile-prices.js pricesApi
    /v1/agents/m/update…               the latest app build and its APK    → mobile-update.js updateApi
    /v1/agents/m/waymark…              tag and follow-up writes            → mobile-waymark.js waymarkApi
    /v1/agents/m/linkshell…            pair with a PC, links, unlink       → linkshell.js     linkshellPhone

  How a request gets here (index.js agentApi, nothing to change there): the app key header (x-aethernet-key) is checked, then
  `Authorization: Bearer <id>.<token>` against the agents table, then the agent must be a phone (agent_kind row) and approved
  ('active'). A pending, unknown, removed or wrong-token device never reaches this file (401 / 403). `device` is:
    { id, name, kind: 'phone', stores: [approved store ids, numbers], active: true, publicJwk }
  `h` is the Worker's own helpers: { json(body, status, cors), fail(status, message), readJson(req, maxChars), int, clean(str, max), iso, now(), log(env, who, action, store, wo, detail), serverError }.
  A handler may throw: index.js turns anything but a deliberate 4xx (an Error with .status < 500) into a generic 500 with a short id, and logs the real error.
*/
import { homeApi } from './mobile.js';
import { woApi } from './mobile-wo.js';
import { alertsApi } from './mobile-alerts.js';
import { prefsApi } from './mobile-prefs.js';
import { retraceApi } from './mobile-retrace.js';
import { trendsApi } from './mobile-trends.js';
import { pricesApi } from './mobile-prices.js';
import { updateApi } from './mobile-update.js';
import { waymarkApi } from './mobile-waymark.js';
import { linkshellPhone } from './linkshell.js';
import { pushApi } from './push.js';

// The device as the `me` that homeApi expects: limited to its approved stores, never an owner.
export const meOf = (device) => ({ owner: false, scope: 'stores', stores: deviceStores(device), email: 'device:' + device.id });

/*
  The tenant boundary: a phone only ever reads or writes its approved stores. Every phone route asks here, so the rule is in one place.
  Function declarations (hoisted) because the route modules above import this file back. mobile.js must not: mobile-wo.js reads its
  LANES while loading, so Home gets the device's stores through meOf instead.
*/
const STORE_ID = /^\d{1,6}$/;
const err = (status, message) => Object.assign(new Error(message), { status });
// A stores list as store numbers. Anything that is not a positive whole number is dropped: it can never match an asked store.
export function storeIds(stores) {
  return (Array.isArray(stores) ? stores : []).map(Number).filter((s) => Number.isInteger(s) && s > 0);
}
export function deviceStores(device) { return storeIds(device && device.stores); }
// Is `store` (a number, or a string of digits) in the list / one of the device's approved stores?
export function inStores(stores, store) {
  const n = typeof store === 'number' ? store : (typeof store === 'string' && STORE_ID.test(store) ? Number(store) : NaN);
  return Number.isInteger(n) && storeIds(stores).includes(n);
}
export function isDeviceStore(device, store) { return inStores(device && device.stores, store); }
// The one store a request names. Throws 400 (missing or not a store number) / 403 (not this device's).
export function storeOf(device, v) {
  if (v == null || !STORE_ID.test(v)) throw err(400, 'store: a store number');
  if (!isDeviceStore(device, v)) throw err(403, 'not your store');
  return Number(v);
}
// The stores a request is about: ?store=<id> (must be an approved one), or all of the device's when it is missing, empty or "all". Throws 400 / 403.
export function storesOf(device, ask) {
  if (ask == null || ask === '' || ask === 'all') return deviceStores(device);
  if (!STORE_ID.test(ask)) throw err(400, 'store: all or a store number');
  if (!isDeviceStore(device, ask)) throw err(403, 'not your store');
  return [Number(ask)];
}

export async function mobileAgentApi(req, env, url, device, h) {
  const path = url.pathname.replace(/^\/v1\/agents\/m/, '') || '/';
  if (path === '/home') return homeApi(req, env, url, meOf(device), {});
  if (/^\/wo(\/|$)/.test(path)) return woApi(req, env, url, device, h);
  if (/^\/push(\/|$)/.test(path)) return pushApi(req, env, url, device, h);
  if (/^\/alerts(\/|$)/.test(path)) return alertsApi(req, env, url, device, h);
  if (/^\/prefs(\/|$)/.test(path)) return prefsApi(req, env, url, device, h);
  if (/^\/retrace(\/|$)/.test(path)) return retraceApi(req, env, url, device, h);
  if (/^\/trends(\/|$)/.test(path)) return trendsApi(req, env, url, device, h);
  if (/^\/prices(\/|$)/.test(path)) return pricesApi(req, env, url, device, h);
  if (/^\/update(\/|$)/.test(path)) return updateApi(req, env, url, device, h);
  if (/^\/waymark(\/|$)/.test(path)) return waymarkApi(req, env, url, device, h);
  if (/^\/linkshell(\/|$)/.test(path)) return linkshellPhone(req, env, url, device, h);
  return h.fail(404, 'not found');
}
