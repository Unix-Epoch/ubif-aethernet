// Loads Aethernet's source files (src/*.js, the way build.py concatenates them) into a Node vm with stubbed
// browser globals, so the shared core, the tracker, Waymark and Retrace can be tested without a browser.
// Not a bundle build: only the files a test names are loaded, in file-name order, stamped like build.py does.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixture = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
export const retraceFx = (name) => fixture('tracker-worker/test/fixtures/retrace/' + name + '.json');

// The shared modules build.py inlines (tracker-worker/src/*.js without their `export`s).
function tracker(name) {
  const src = readFileSync(path.join(ROOT, 'tracker-worker/src', name), 'utf8');
  const names = [...src.matchAll(/^export (?:async )?(?:const|function) (\w+)/gm)].map((m) => m[1]);
  return src.replace(/^export /gm, '') + '\nreturn { ' + names.join(', ') + ' };\n';
}

// A tiny DOM: elements that accept anything and do nothing.
function fakeEl() {
  const el = new Proxy(function () {}, {
    get: (t, k) => {
      if (k === 'then') return undefined;
      if (k === 'style' || k === 'dataset' || k === 'classList') return k === 'classList' ? { add() {}, remove() {}, contains: () => false, toggle() {} } : {};
      if (k === 'children' || k === 'childNodes') return [];
      if (k === 'textContent' || k === 'innerHTML' || k === 'id' || k === 'className') return '';
      if (k === Symbol.toPrimitive) return () => '';
      return k in t ? t[k] : (...a) => (/^(querySelectorAll|getElementsBy)/.test(String(k)) ? [] : /^(querySelector|getElementById|closest)$/.test(String(k)) ? null : el);
    },
    set: () => true,
    apply: () => el,
  });
  return el;
}

/*
  load(files, opts) → { AE, ctx, gm, fetchLog, requests, toasts, scripts, clock, setFetch, advance, settle, pendingTimers, online }
    files    src file names (e.g. ['00-core.js', '27-tracker.js'])
    opts.fetch(url, init) → a Response-like { status, body } (object = JSON, string = text) or throws, or a promise of either.
             EVERY request is recorded in fetchLog as { url, path, method, body (parsed JSON, else the text), timeoutMs? } before the
             stub sees it: tests assert what was SENT (requests(re, method) filters it), not what a stub chose to answer.
    opts.gm  initial GM storage ({key: value})
    opts.timers
      'fast' (default)  real timers, pauses of 2 ms – 5 s shrink to 1 ms (the collector's 300 ms gaps); setInterval does nothing
      'fake'            a virtual clock: setTimeout / setInterval / Date run on it only when the test calls advance(ms) (timers due
                        on the way fire in order, promises settle between them). For loops, backoff, timeouts and timer leaks.
    opts.online  navigator.onLine (default true); env.online(false) changes it later
*/
export function load(files, opts = {}) {
  const gm = new Map(Object.entries(opts.gm || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const fetchLog = [], toasts = [], scripts = [];
  let fetchImpl = opts.fetch || (() => ({ status: 404, body: { error: 'no stub' } }));
  const real = { setTimeout, clearTimeout, setInterval, setImmediate };
  const mode = opts.timers || (opts.fast === false ? 'real' : 'fast');
  const fast = mode === 'fast';
  const listeners = new Map();
  const clock = { now: Date.now() };
  const nav = { userAgent: 'node-test', onLine: opts.online !== false };
  // ---- the virtual clock (timers: 'fake')
  const vt = new Map(); let vtId = 0;
  const vAdd = (fn, ms, args, every) => { const id = ++vtId; const d = Math.max(0, Number(ms) || 0); vt.set(id, { fn, at: clock.now + d, every: every ? Math.max(1, d) : 0, args }); return id; };
  const vClear = (id) => { vt.delete(id); };
  // Let promises (and real async work such as WebCrypto) finish: a few real turns of the event loop.
  async function settle(rounds = 6) { for (let i = 0; i < rounds; i++) await new Promise((r) => real.setImmediate(r)); await new Promise((r) => real.setTimeout(r, 0)); }
  async function advance(ms) {
    const end = clock.now + ms;
    await settle();
    for (let guard = 0; guard < 100000; guard++) {
      let next = null;
      for (const [id, t] of vt) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      clock.now = Math.max(clock.now, t.at);
      if (t.every) t.at += t.every; else vt.delete(id);
      try { t.fn(...(t.args || [])); } catch (_) {}
      await settle(2);
    }
    clock.now = end;
    await settle();
  }
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  // An element that remembers what was set on it (innerHTML, attributes) and ignores everything else.
  const rec = (tag) => {
    const e = { tag, nodeType: 1, innerHTML: '', attrs: {}, style: {}, dataset: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, children: [], childNodes: [], append() {}, appendChild() {}, remove() {}, addEventListener() {}, removeEventListener() {} };
    return new Proxy(e, { get: (t, k) => (k in t ? t[k] : k === 'then' || typeof k === 'symbol' ? undefined : /^(querySelectorAll)$/.test(k) ? () => [] : () => null), set: (t, k, v) => { t[k] = v; return true; } });
  };
  const body = { appendChild(el) { if (el && el.attrs && /sg-toast/.test(el.attrs.class || '')) toasts.push(el.innerHTML); return el; }, append() {}, addEventListener() {}, removeEventListener() {}, style: {}, classList: { add() {}, remove() {} }, textContent: '', querySelector: () => null, querySelectorAll: () => [] };
  const ctx = vm.createContext({
    console: { log() {}, debug() {}, info() {}, warn: opts.warn || (() => {}), error() {} },
    GM_getValue: (k, d) => (gm.has(k) ? JSON.parse(JSON.stringify(gm.get(k))) : d),
    GM_setValue: (k, v) => { gm.set(k, JSON.parse(JSON.stringify(v))); },
    GM_deleteValue: (k) => { gm.delete(k); },
    GM_addStyle() {}, GM_xmlhttpRequest() {}, GM_info: { script: { version: 'test' } },
    location: { hostname: opts.hostname || 'portal.ubreakifix.net', host: opts.hostname || 'portal.ubreakifix.net', pathname: opts.pathname || '/', href: 'https://portal.ubreakifix.net/', origin: 'https://portal.ubreakifix.net' },
    // head / documentElement record the scripts appended to them (Retrace's watcher, the bridge): env.scripts = [{ id, code }]
    document: new Proxy({ hidden: false, body, head: { append(el) { if (el && el.tag === 'script') scripts.push({ id: el.id, code: el.textContent }); }, appendChild(el) { this.append(el); return el; }, querySelector: () => null, querySelectorAll: () => [] },
      documentElement: new Proxy({ dataset: {}, append(el) { if (el && el.tag === 'script') scripts.push({ id: el.id, code: el.textContent }); } }, { get: (t, k) => (k in t ? t[k] : fakeEl()[k]) }),
      addEventListener: (n, fn) => { listeners.set(n, [...(listeners.get(n) || []), fn]); },
      dispatchEvent: (e) => { for (const fn of listeners.get(e.type) || []) fn(e); return true; },
      createElement: (tag) => rec(tag), createElementNS: (ns, tag) => rec(tag), createTextNode: () => fakeEl(), createDocumentFragment: () => fakeEl(),
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], readyState: 'complete', cookie: '' }, {
      get: (t, k) => (k in t ? t[k] : fakeEl()[k]), set: (t, k, v) => { t[k] = v; return true; } }),
    navigator: nav,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, Promise, JSON, Math, Date: FakeDate, Number, String, Object, Array, Set, Map, Error, RegExp, Symbol, Intl,
    crypto: globalThis.crypto, btoa, atob, CompressionStream, DecompressionStream, Blob, Response, ReadableStream, WritableStream, performance, structuredClone,
    MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    NodeFilter: { SHOW_TEXT: 4 }, Node: { ELEMENT_NODE: 1 }, HTMLElement: class {}, Event: class {},
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: (fn) => real.setTimeout(fn, 0), cancelAnimationFrame() {},
    getComputedStyle: () => ({}),
    // fast: the collector's pauses (300 ms and the like) shrink to 1 ms; long timers (the 45 s Retrace tick) never keep Node alive
    setTimeout: mode === 'fake' ? (fn, ms, ...a) => vAdd(fn, ms, a, false)
      : (fn, ms, ...a) => { const t = real.setTimeout(fn, fast && ms > 1 && ms <= 5000 ? 1 : ms, ...a); if (ms > 5000) t.unref(); return t; },
    clearTimeout: mode === 'fake' ? vClear : real.clearTimeout,
    setInterval: mode === 'fake' ? (fn, ms, ...a) => vAdd(fn, ms, a, true) : () => 0,
    clearInterval: mode === 'fake' ? vClear : () => {},
    fetch: async (url, init = {}) => {
      let body; if (init.body) { try { body = JSON.parse(init.body); } catch (_) { body = init.body; } }
      fetchLog.push({ url: String(url), path: String(url).replace(/^https?:\/\/[^/]+/, ''), method: init.method || 'GET', body, at: clock.now });
      const r = await new Promise((resolve, reject) => {
        if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
        Promise.resolve().then(() => fetchImpl(String(url), init)).then(resolve, reject);
      });
      const text = typeof r.body === 'string' ? r.body : r.body === undefined ? '' : JSON.stringify(r.body);
      return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => text, json: async () => JSON.parse(text) };
    },
    AE_DEMO: false,
  });
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  const stamps = { __VERSION__: '0.0.0-test', __DEV__: 'true', __BUILD_TIME__: 'now', __BUILD_COMMIT__: 'test', __INSTALL_URL__: 'https://example.invalid/aethernet.user.js',
    __WAYMARK_API__: 'https://waymark.test', __WAYMARK_KEY__: 'key', __TRACKER_API__: 'https://tracker.test', __ASSIZE_GRAPHS__: '{}', __ACTION_ICONS__: '{}', __PATCH_NOTES__: '[]',
    '/*__TRACKER_CRYPTO__*/': () => tracker('crypto.js'), '/*__TRACKER_SHAPE__*/': () => tracker('shape.js'), '/*__RETRACE__*/': () => tracker('retrace.js'),
    '/*__RULEGRAPH__*/': () => tracker('rulegraph.js'), '/*__ASSIZE_RULES__*/': () => tracker('assize-rules.js') };
  const hook = [];
  for (const f of [...files].sort()) {
    let text = readFileSync(path.join(ROOT, 'src', f), 'utf8');
    for (const [k, v] of Object.entries(stamps)) if (text.includes(k)) text = text.split(k).join(typeof v === 'function' ? v() : v);
    // the build wraps everything in one function; top-level consts stay visible to the next file this way
    hook.push(`\n// ===== ${f} =====\n` + text);
    if (f === '00-core.js') hook.push('\nthis.AE = AE;\n');
  }
  // Files that need AE.status (02-status.js) get a stand-in unless 02 is loaded.
  // A stand-in for AE.status (02-status.js: the notices and kill switch) unless that file is loaded: nothing is paused.
  if (!files.includes('02-status.js')) hook.splice(1, 0, "\nAE.status = { paused: () => false, blocked: () => false };\n");
  vm.runInContext(hook.join(''), ctx, { filename: 'aethernet-test-bundle.js' });
  const AE = ctx.AE;
  const requests = (re, method) => fetchLog.filter((r) => (!method || r.method === method) && re.test(r.path));
  return { AE, ctx, gm, fetchLog, requests, toasts, scripts, clock, setFetch: (fn) => { fetchImpl = fn; }, advance, settle, pendingTimers: () => vt.size, online: (v) => { nav.onLine = v; } };
}

// The source of one function in a src file, found by its header text (brace matching), so a test can run the real code
// of a function that lives inside a shard's closure. Throws if it is not there (the test then needs updating).
export function extractFn(file, header) {
  const src = readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const at = src.indexOf(header);
  if (at < 0) throw new Error(file + ': "' + header + '" not found');
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error('unbalanced');
}
