/*
  Linkpearl (the native Android app): the phone API on the tracker Worker. ONE place for dispatch.

    /v1/agents/m/home?store=<id>|all   Home's numbers (built; tracker-worker/src/mobile.js homeApi, same answer as the admin site's /api/m/home)
    /v1/agents/m/wo…                   work order lookup + unlock          → mobile-wo.js     woApi      (stub, 501)
    /v1/agents/m/alerts…, /push…       alerts, history, Web/FCM push setup → mobile-alerts.js alertsApi  (stub, 501)
    /v1/agents/m/retrace…              Retrace lookup: items, item, label, POs → mobile-retrace.js retraceApi (built)
    /v1/agents/m/prefs…                thresholds, quiet hours, per-store  → mobile-prefs.js  prefsApi   (stub, 501)

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

// The device as the `me` that homeApi expects: limited to its approved stores, never an owner.
export const meOf = (device) => ({ owner: false, scope: 'stores', stores: device.stores, email: 'device:' + device.id });

export async function mobileAgentApi(req, env, url, device, h) {
  const path = url.pathname.replace(/^\/v1\/agents\/m/, '') || '/';
  if (path === '/home') return homeApi(req, env, url, meOf(device), {});
  if (/^\/wo(\/|$)/.test(path)) return woApi(req, env, url, device, h);
  if (/^\/(alerts|push)(\/|$)/.test(path)) return alertsApi(req, env, url, device, h);
  if (/^\/prefs(\/|$)/.test(path)) return prefsApi(req, env, url, device, h);
  if (/^\/retrace(\/|$)/.test(path)) return retraceApi(req, env, url, device, h);
  return h.fail(404, 'not found');
}
