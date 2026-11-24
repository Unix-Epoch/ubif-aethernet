// Client suite, part of `node test-client/run.mjs` (which loads these files in order; see its top for how the tests work).
import assert from 'node:assert/strict';
import { load, runShard } from '../harness.mjs';
import { t, STORE, plain, USER, ok, router, ASSIZE_FILES, assize } from './common.mjs';

// ================================================================== safety fixes (Nov 11 audit)
// SYNTHETIC: the answer shapes below are the ones the code already reads (rows[] of punches, { allowed }, the /api/auth/user user + currentStore).
const dayAgo = (n) => { const d = new Date(Date.now() - n * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const PUNCH = (o = {}) => ({ userId: 7, username: 'Pat Tech', storeId: STORE, clockTypeId: 1, timeIn: new Date(Date.now() - 3 * 86400000 - 8 * 3600000).toISOString(), timeOut: new Date(Date.now() - 3 * 86400000).toISOString(), ...o });

await t('Tactician punches: a wrong-shaped answer throws (counted) and is not cached; an empty week is cached as not done; a week with rows as done', async () => {
  const day = dayAgo(20);
  const env = load(['00-core.js', '62-tactician.js'], { fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/store-time-sheet\?/, ok({ oops: [] })]]) });
  const e = await env.AE.tactician.punches(day, day).catch((x) => x);
  assert.ok(e instanceof env.AE.BadShape, String(e && e.message)); assert.equal(env.AE.health.state().shapeFails, 1);
  assert.equal(env.gm.get('ae_ts_weeks'), undefined, 'a bad answer is never kept');
  env.setFetch(router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/store-time-sheet\?/, ok({ rows: [] })]]));
  assert.deepEqual(plain(await env.AE.tactician.punches(day, day)), []);
  const weeks = env.gm.get('ae_ts_weeks')[STORE], k = Object.keys(weeks);
  assert.equal(k.length, 1); assert.equal(weeks[k[0]].done, false, 'an empty week is not finished');
  const env2 = load(['00-core.js', '62-tactician.js'], { fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/store-time-sheet\?/, ok({ rows: [PUNCH()] })]]) });
  assert.equal((await env2.AE.tactician.punches(day, day)).length, 1);
  const w2 = env2.gm.get('ae_ts_weeks')[STORE]; assert.equal(w2[Object.keys(w2)[0]].done, true);
});

await t('Tactician: the daily upload needs Store time sheet access; without it (or if the check fails) nothing is read or sent', async () => {
  const run = async (access) => {
    const sent = [];
    const env = load(['00-core.js', '62-tactician.js'], { fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/store-time-sheet\/access$/, access],
      ['GET', /^\/api\/store-time-sheet\?/, ok({ rows: [PUNCH({ timeIn: new Date(Date.now() - 3600000).toISOString(), timeOut: null })] })]]) });
    env.AE.tracker = { configured: () => false, daily: async (...a) => { sent.push(a); } };
    await env.AE.tactician.uploadDaily();
    return { sent, sheet: env.requests(/^\/api\/store-time-sheet\?/).length };
  };
  const yes = await run(ok({ allowed: true })); assert.equal(yes.sent.length, 1); assert.ok(yes.sent[0][2].labor_hours > 0.9);
  for (const a of [ok({ allowed: false }), { status: 500, body: { error: 'x' } }, { status: 403, body: '' }]) { const no = await run(a); assert.equal(no.sent.length, 0); assert.equal(no.sheet, 0, 'the time sheet is not even read'); }
});

// ---- Access gate
const gateEnv = (cache, allowed, storeUser = USER) => {
  const seen = { headers: null, url: null };
  const env = load(['00-core.js', '01-access.js'], { gm: cache ? { ae_access: cache } : {}, timers: 'fake', fetch: router([['GET', /^\/api\/auth\/user$/, ok(storeUser)],
    ['GET', /^\/v1\/\d+\/access/, (b, p, init) => { seen.headers = init.headers; seen.url = p; return ok({ allowed }); }]]) });
  env.booted = 0; env.AE.boot = () => { env.booted++; };
  return Object.assign(env, { seen });
};
await t('Access: a cached "allowed" for another store never starts Aethernet before the check; the denied store gets the notice', async () => {
  const env = gateEnv({ store: 5, allowed: true, at: 1 }, false);
  const g = env.AE.gate(); assert.equal(env.booted, 0, 'nothing starts before the profile is known'); await g; await env.settle();
  assert.equal(env.booted, 0); assert.equal(env.AE.halted(), false);
  assert.equal(env.gm.get('ae_access').allowed, false);
});
await t('Access: a cached "allowed" for this store starts after the profile read; when the check then says denied it stops the page', async () => {
  const env = gateEnv({ store: STORE, allowed: true, at: 1 }, false);
  const g = env.AE.gate(); assert.equal(env.booted, 0); await g; await env.settle();
  assert.equal(env.booted, 1); assert.equal(env.AE.halted(), true, 'halted after a denied answer');
  const ok2 = gateEnv({ store: STORE, allowed: true, at: 1 }, true); await ok2.AE.gate(); await ok2.settle();
  assert.equal(ok2.booted, 1); assert.equal(ok2.AE.halted(), false);
});
await t('Access: the request carries the store name and the person as encoded headers, not in the URL', async () => {
  const env = gateEnv(null, true); await env.AE.gate(); await env.settle();
  assert.equal(env.seen.url, '/v1/' + STORE + '/access');
  assert.equal(env.seen.headers['x-aethernet-store-name'], encodeURIComponent('Test store')); assert.equal(env.seen.headers['x-aethernet-user'], encodeURIComponent('Test Tech'));
  assert.equal(env.seen.headers['x-aethernet-key'], 'key');
});
await t('Access: Portal answering with no signed-in store (the login page) wipes the local work order caches', async () => {
  const env = gateEnv(null, true, { user: {}, currentStore: {} });
  env.gm.set('ae_wod_914', { 1: { at: Date.now(), d: {} } }); env.AE.localCache.note('ae_wod_914');
  await env.AE.gate(); await env.settle();
  assert.equal(env.gm.has('ae_wod_914'), false); assert.equal(env.booted, 0);
});
await t('Core halt: AE.every timers and the page checks stop, sameStore() says no', async () => {
  const env = load(['00-core.js'], { timers: 'fake', fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)]]) });
  let n = 0; env.AE.every(1000, () => { n++; });
  await env.advance(3500); const before = n; assert.ok(before >= 3);
  assert.equal(await env.AE.sameStore(), true);
  env.AE.halt('test'); await env.advance(5000);
  assert.equal(n, before, 'the timer no longer runs'); assert.equal(await env.AE.sameStore(), false);
  let m = 0; env.AE.every(1000, () => { m++; }); await env.advance(3000); assert.equal(m, 0, 'a timer registered after the halt never runs');
});

// ---- Admin key and bug reports (the panels are driven through a recording element factory)
const uiEl = (tag) => { const e = { tag, attrs: {}, kids: [], style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, value: '', setAttribute(k, v) { this.attrs[k] = v; }, append(...k) { this.kids.push(...k); }, replaceChildren(...k) { this.kids = k; }, remove() {}, focus() {}, addEventListener() {}, removeEventListener() {} };
  return new Proxy(e, { get: (t, k) => (k in t ? t[k] : k === 'then' || typeof k === 'symbol' ? undefined : () => null), set: (t, k, v) => { t[k] = v; return true; } }); };
const uiFind = (el, test) => { if (!el || typeof el !== 'object') return null; if (test(el)) return el; for (const k of el.kids || []) { const f = uiFind(k, test); if (f) return f; } return null; };
const uiRoots = (env) => { const roots = []; const mk = env.ctx.document.createElement; env.ctx.document.createElement = (tag) => { const e = uiEl(tag); roots.push(e); return e; }; env.ctx.document.body.appendChild = (e) => e; env.ctx.document.body.classList.contains = () => false; return roots; };
const uiText = (el) => (typeof el === 'string' ? el : (el.kids || []).map(uiText).join(''));
await t('Admin key: an older saved key is deleted on load, the panel asks for it, and a key typed in is never written to storage', async () => {
  const env = load(['00-core.js', '06-feedback.js'], { gm: { ae_admin_key: 'old-key' }, fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/v1\/admin\/ping$/, ok({})], ['GET', /^\/v1\/admin\/feedback/, ok({ counts: {}, items: [] })]]) });
  assert.equal(env.gm.has('ae_admin_key'), false, 'deleted on load');
  const roots = uiRoots(env);
  await env.AE.feedback.openAdmin(); await env.settle();
  assert.equal(env.requests(/^\/v1\/admin\//).length, 0, 'asks for the key instead of using a saved one');
  const input = roots.find((e) => e.tag === 'input' && e.attrs.type === 'password'), go = roots.find((e) => e.tag === 'button' && e.kids.includes('Unlock'));
  assert.ok(input && go); input.value = ' typed-key '; await go.onclick(); await env.settle();
  const ping = env.fetchLog.find((r) => /\/v1\/admin\/ping/.test(r.path)); assert.ok(ping);
  assert.deepEqual([...env.gm.keys()].filter((k) => /admin/.test(k)), [], 'nothing saved');
  assert.ok(env.requests(/^\/v1\/admin\/feedback/).length >= 1, 'the key is held for this page');
});
const dirty = 'call 804-555-0142 or pat@example.com about 353918051234567';
const reportEnv = async () => {
  const env = load(['00-core.js', '06-feedback.js'], { fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['POST', /\/feedback$/, ok({ ok: true })]]) });
  const roots = uiRoots(env); env.ctx.innerWidth = 1000; env.ctx.innerHeight = 800;
  env.AE.noteError('Tactician ' + dirty, new Error('failed for ' + dirty)); env.AE.pageErrors.push({ at: 'x', where: '/app.js?u=pat@example.com:1', message: 'Unhandled: ' + dirty });
  env.AE.feedback.openFeedback({ context: { where: 'Where ' + dirty, error: dirty } });
  const text = roots.find((e) => e.tag === 'textarea'), send = roots.filter((e) => e.tag === 'button').find((e) => e.kids.includes('Send'));
  text.value = 'it broke'; await send.onclick(); await env.settle();
  return env.requests(/\/feedback$/, 'POST');
};
await t('Bug report: the bug link error, Aethernet errors and Portal page errors are scrubbed of phones, emails and IMEI-like numbers', async () => {
  const [req] = await reportEnv(); assert.ok(req, 'sent');
  const json = JSON.stringify(req.body.diag);
  for (const bad of ['804-555-0142', 'pat@example.com', '353918051234567']) assert.ok(!json.includes(bad), bad + ' leaked: ' + json);
  assert.match(req.body.diag.context.error, /\[email\]/); assert.match(req.body.diag.context.error, /\[number\]/);
  assert.ok(req.body.diag.errors.length === 1 && req.body.diag.pageErrors.length === 1);
});

// ---- Notice file hardening
const statusEnv = async (b) => {
  const env = load(['00-core.js', '02-status.js'], { fetch: router([['GET', /^\/status\.json/, ok({ bulletins: b })]]) });
  env.ctx.document.querySelector = (s) => { if (/::bad|\(\(/.test(s)) throw new Error('bad selector'); return null; };
  await env.AE.status.refresh(true);
  return { env, b: plain(env.AE.status.get().bulletins) };
};
await t('Notice file: selectors and closers must be plain; anything that could break out of the style block is dropped, the rest kept', async () => {
  const bad = ['.a{}', 'a;b', '@media x', '.a\\b', '/* x */', '<b>', 'URL(x)', '.a{color:red}', '::bad', '.a}'];
  const good = ['.appcues-skip', '[data-step="skip"]', 'appcues-experience-container', 'div > .x'];
  const { env, b } = await statusEnv({ selectors: [...bad, ...good], closers: [...bad, ...good], pages: [], patterns: [] });
  assert.deepEqual(b.selectors, good); assert.deepEqual(b.closers, good);
  assert.ok(env.AE.recentErrors.length >= 1 && env.AE.recentErrors.every((e) => e.where === 'Notice file'));
  const n = env.AE.recentErrors.length; await env.AE.status.refresh(true); assert.equal(env.AE.recentErrors.length, n, 'each dropped entry is noted once');
});
await t('Notice file: page patterns must be short, compile, and not nest quantifiers; the two live patterns pass', async () => {
  const live = ['^/repair/workorder/\\d+', '^/check-in/arrivals(/|$)', '(a|b)+', '\\(a+\\)+', '^/x/[a-z+]+$'];
  const bad = ['(a+)+$', '(.*)*x', '((a+)b)*', '(\\d+)+', '(a*){2,}', '[', '(', 'a'.repeat(121)];
  const { b } = await statusEnv({ pages: [...bad, ...live] });
  assert.deepEqual(b.pages, live);
});

// ---- Local work order caches
await t('Tracker cache: entries past their keep time are dropped when first read; fresh ones stay', async () => {
  const now = Date.now(), d = { workorder: { workorder: { updatedAt: 'u' } }, notes: { notes: [] } };
  const env = load(['00-core.js', '27-tracker.js'], { gm: { ae_wod_914: { 1: { at: now - 3 * 3600000, u: 'u', d }, 2: { at: now - 60000, u: 'u', d } } } });
  const got = await env.AE.woDetail.get(914, 2);
  assert.ok(got && got.at); assert.deepEqual(Object.keys(env.gm.get('ae_wod_914')), ['2']);
});
const cachedEnv = (extra = {}) => {
  const d = { workorder: { workorder: { updatedAt: 'u' } }, notes: { notes: [{ text: 'secret note' }] } };
  let user = USER;
  const env = load(['00-core.js', '27-tracker.js'], { gm: { ae_wod_914: { 3: { at: Date.now() - 1000, u: 'u', d } }, ...extra }, fetch: (url, init) => router([['GET', /^\/api\/auth\/user$/, () => ok(user)], ['GET', /^\/api\/me$/, { status: 401, body: '' }]])(url, init) });
  return Object.assign(env, { setUser: (u) => { user = u; } });
};
await t('Tracker cache: wiped when Portal answers 401 (signed out)', async () => {
  const env = cachedEnv(); await env.AE.woDetail.get(914, 3);
  assert.ok(env.gm.has('ae_wod_914')); await env.AE.api('GET', '/api/me').catch(() => {});
  assert.equal(env.gm.has('ae_wod_914'), false);
});
await t('Tracker cache: wiped when Portal switched to another store; unaffected while the store is the same', async () => {
  const env = cachedEnv(); await env.AE.woDetail.get(914, 3);
  assert.equal(await env.AE.sameStore(true), true); assert.ok(env.gm.has('ae_wod_914'));
  env.setUser({ ...USER, currentStore: { storeId: 915, storeName: 'Other' } });
  assert.equal(await env.AE.sameStore(true), false); assert.equal(env.gm.has('ae_wod_914'), false);
});
await t('Assize cache: details older than 2 hours are dropped on first read, and its rows/details keys are listed for wiping', async () => {
  const now = Date.now();
  const env = load(ASSIZE_FILES, { fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)]]), gm: { ae_assize_details_914: { 1: { at: now - 3 * 3600000, d: {} }, 2: { at: now - 60000, d: {} } } } });
  const { readDetails } = await assize(env);
  assert.deepEqual(Object.keys(readDetails()), ['2']); assert.deepEqual(Object.keys(env.gm.get('ae_assize_details_914')), ['2']);
  env.AE.signedOut(); assert.equal(env.gm.has('ae_assize_details_914'), false);
});
// ---- Spread on dark themes: every colour in Spread's CSS comes from Portal's design tokens (Glamour sets them), with today's light value as the fallback.
// A hard-coded neutral (white, light grey, near-black) next to a theme-coloured text is what made the board a light island on a dark theme.
const SP_SHARD = runShard(load(['00-core.js', '59-spread.js']), 'spread'); // the stylesheet the shard really adds, and its card edge colour
const spCss = SP_SHARD.CSS.replace(/\/\*[\s\S]*?\*\//g, '');
// the text with every var(...) group (fallbacks included) cut out, parens balanced
const spNoVar = (str) => { let out = '', i = 0; while (i < str.length) { if (str.startsWith('var(', i)) { let d = 0; i += 3; do { if (str[i] === '(') d++; else if (str[i] === ')') d--; i++; } while (d > 0 && i < str.length); } else out += str[i++]; } return out; };
// The colours Spread keeps on purpose, by "selector | property": status amber and red (Attention, Urgent, the old-age text and dot) and their dark-theme variants; shadows are black.
const SP_FIXED = new Set([
  '.sp-att.warning | color', '.sp-att.warning | background', '.sp-att.urgent | color', '.sp-att.urgent | background',
  ':is(.asurion-dark, .partner-dark) .sp-att.warning | color', ':is(.asurion-dark, .partner-dark) .sp-att.warning | background',
  '.sp-age.old | color', '.sp-age.old::after | background', ':is(.asurion-dark, .partner-dark) .sp-age.old | color',
]);
const spLiterals = (decl) => spNoVar(decl).match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\b(?:white|black|gray|grey|silver|ivory|beige|whitesmoke|gainsboro)\b/g) || [];
await t('Spread: no neutral colour literal in the CSS outside var(--aui-…, fallback); only the listed semantic colours stay fixed', () => {
  const bad = [];
  for (const m of spCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':'); if (i < 0) continue;
      const prop = d.slice(0, i).trim(), val = d.slice(i + 1);
      for (const lit of spLiterals(val)) {
        if (/^rgba\(0,\s*0,\s*0,/.test(lit) && /^box-shadow$/.test(prop)) continue; // shadows are black on any theme
        if (!SP_FIXED.has(sel + ' | ' + prop)) bad.push(sel + ' { ' + prop + ': … ' + lit);
      }
    }
  }
  assert.deepEqual(bad, []);
});
await t('Spread: every design token in the CSS has today\'s light value as its fallback (stock Portal keeps its look)', () => {
  const toks = spCss.match(/var\(--aui-[a-z0-9-]+(?=[,)])[^)]*\)?/g) || [];
  assert.ok(toks.length > 25, 'tokens found: ' + toks.length);
  const bare = toks.filter((x) => !/^var\(--aui-[a-z0-9-]+,\s*[^)\s]/.test(x));
  assert.deepEqual(bare, []);
});
await t('Spread: the board, columns, cards, chips and tags take their colours from the theme tokens', () => {
  const rule = (sel) => { const m = spCss.match(new RegExp('(?:^|\\n)\\s*' + sel.replace(/[.#]/g, '\\$&') + ' \\{([^}]*)\\}')); assert.ok(m, sel); return m[1]; };
  assert.match(rule('#sp-board'), /color:var\(--aui-on-surface,/);
  assert.match(rule('.sp-col'), /background:var\(--aui-neutral-soft,/);
  assert.match(rule('.sp-card'), /background:var\(--aui-surface,/);
  assert.match(rule('.sp-card'), /border:1px solid var\(--aui-outline-soft,/);
  assert.match(rule('.sp-count'), /background:var\(--aui-surface,/);
  assert.match(rule('.sp-prog'), /background:var\(--aui-neutral-soft,/);
  assert.match(rule('.sp-bin'), /background:var\(--aui-surface,/);
  assert.match(rule('.sp-seg button.on'), /color:var\(--aui-on-primary,/);
});
await t('Spread: the amber age text, the Attention badge, the WO link and the card shadow have dark-theme variants; the edge falls back to a token', () => {
  for (const sel of ['.sp-age.old', '.sp-att.warning', '.sp-card:hover']) assert.ok(spCss.includes(':is(.asurion-dark, .partner-dark) ' + sel + ' {'), sel);
  assert.ok(spCss.includes(':is(.asurion-dark, .partner-dark) :is(.sp-wo,'));
  const edge = SP_SHARD.edgeOf('Ready for pickup'); // Rainbow Drip is not loaded here: the fallback
  assert.ok(edge && spLiterals(edge).length === 0, 'the edge colour used when Rainbow Drip is off is a token: ' + edge);
});
