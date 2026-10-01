/*
  Store access. Aethernet only runs for stores on the list kept in the admin
  panel (Stores tab). build.py puts every module after this one inside
  AE.boot(); AE.gate() calls it once the signed-in store is allowed.

  - Asks the Aethernet API (GET /v1/<store>/access, which also records the
    store as "seen", so it shows up in the admin panel's Waiting list).
  - The answer is remembered per store, so a store that has access keeps
    working if the API can't be reached; a store never verified waits.
  - Not allowed: one notice, and nothing else loads (no crystals, Settings,
    notices, feedback or Waymark). The Worker also refuses its services to
    stores without access.
  - The Sprinklr form (Macrocosmos' second half) isn't a Portal page; it
    only acts on a handoff made from Portal, so it isn't gated here.
*/
AE.gate = (() => {
  const API = '__WAYMARK_API__';
  const KEY = '__WAYMARK_KEY__';
  const CACHE_KEY = 'ae_access';
  const PREVIEW_KEY = 'ae_dev_preview_locked'; // dev tools: load as a store without access
  let booted = false;

  function boot() {
    if (booted) return;
    booted = true;
    try { AE.boot(); } catch (e) { console.error('[' + AE_NAME + '] failed to start', e); }
  }

  async function check(p) {
    const q = '?name=' + encodeURIComponent(p.storeName || '') + '&user=' + encodeURIComponent(p.name || '');
    const res = await fetch(API + '/v1/' + p.storeId + '/access' + q, { headers: { 'x-aethernet-key': KEY }, credentials: 'omit', cache: 'no-store' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    return !!j.allowed;
  }

  // The one thing a store without access sees (dismissable for this tab).
  function notice(p, kind, opts = {}) {
    const id = 'sg-access-notice', dismissKey = 'ae_access_dismissed_' + p.storeId + '_' + kind;
    document.getElementById(id)?.remove();
    try { if (!opts.force && sessionStorage.getItem(dismissKey)) return; } catch (_) {}
    AE.ensureCss();
    const { h, icon } = AE;
    const store = (p.storeName || 'This store') + (p.storeId ? ' (#' + p.storeId + ')' : '');
    const card = h('div', { id, class: 'sg sg-card', role: 'status', style:
      'position:fixed;z-index:2147483645;left:16px;bottom:16px;max-width:420px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.45;animation:sg-in .2s ease-out' },
      h('span', { style: 'color:var(--aui-primary,#8223d2);line-height:0;flex:none', html: icon('aetheryte', 26) }),
      h('div', { style: 'flex:1' },
        h('b', { style: 'display:block;margin-bottom:2px' }, kind === 'denied' ? AE_NAME + " isn't available for " + store + ' yet' : AE_NAME + " couldn't check this store's access"),
        h('span', { class: 'sg-soft', style: 'font-size:13px' }, kind === 'denied'
          ? AE_NAME + ' access is enabled on a store-by-store basis. Reach out to your manager or higher up and ask them to inquire.'
          : AE_NAME + " will continue checking. If this is a backend issue - we're on it.")),
      h('button', { type: 'button', class: 'sg-x', title: 'Dismiss', onclick: () => { try { if (!opts.force) sessionStorage.setItem(dismissKey, '1'); } catch (_) {} card.remove(); } }, '✕'));
    if (opts.preview) { // dev: the way back out of a locked-out preview
      card.lastChild.before(h('button', { type: 'button', class: 'sg-btn', style: 'flex:none;align-self:center;height:28px;font-size:12px;border-color:#e0761a;color:#e0761a',
        onclick: () => { GM_deleteValue(PREVIEW_KEY); location.reload(); } }, 'End preview'));
    }
    (document.body || document.documentElement).appendChild(card);
  }

  // Dev tools: show a notice on demand, or reload as a store without access.
  AE.hooks.accessNotice = async (kind) => notice(await AE.profile(), kind, { force: true });
  AE.hooks.previewLockedOut = () => { GM_setValue(PREVIEW_KEY, true); location.reload(); };

  return async function gate() {
    if (!AE_ON_PORTAL || AE_SANDBOX) return boot(); // the sandbox has no real store to check (and never calls the Worker)
    let p;
    try { p = await AE.profile(); } catch (_) { p = null; }
    if (!p || !p.storeId) { setTimeout(gate, 30000); return; } // signed out (login page): check again later
    if (AE_DEV && GM_getValue(PREVIEW_KEY, false)) { notice(p, 'denied', { force: true, preview: true }); return; } // dev preview: act locked out
    const cached = GM_getValue(CACHE_KEY, null);
    const known = cached && cached.store === p.storeId ? cached : null;
    if (known && known.allowed) boot(); // fast start; confirmed just below
    try {
      const ok = await check(p);
      GM_setValue(CACHE_KEY, { store: p.storeId, allowed: ok, at: Date.now() });
      if (ok) { document.getElementById('sg-access-notice')?.remove(); boot(); }
      else if (!booted) notice(p, 'denied');
      else console.warn('[' + AE_NAME + '] this store no longer has access; ' + AE_NAME + ' stops on the next page load');
    } catch (e) {
      console.warn('[' + AE_NAME + '] access check failed:', e.message || e);
      if (known && !known.allowed) notice(p, 'denied');
      else if (!known) { notice(p, 'unverified'); setTimeout(gate, 60000); }
    }
  };
})();
