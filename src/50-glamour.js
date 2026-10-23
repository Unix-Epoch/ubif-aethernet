/*
  Glamour (page theming) — recolours the whole portal by overriding its own
  design tokens (--aui-*), so every portal screen and every shard follows.

  A theme is just three colours: background, text and accent. The rest of
  the palette (surfaces, outlines, soft text, the primary's soft/on shades)
  is derived from those, for light or dark depending on the background.
  Status colours (success/error/warning) and the brand accents are left
  alone so their meaning doesn't change.

  Presets are FFXIV-flavoured; users can also make their own. "Portal" means
  no override at all. The engine is set up at load (not in run()) so the
  Settings editor can preview live even while the shard is switched off.
*/
AE.glamour = (() => {
  const { h } = AE;
  const STYLE_ID = 'sg-glamour', EARLY_KEY = 'ae_glamour_css';

  const PRESETS = [
    { id: 'portal', name: 'Portal', note: 'Portal as it ships' },
    { id: 'limsa', name: 'Limsa Lominsa', bg: '#f2f6fa', fg: '#122232', accent: '#1f6aa8' },
    { id: 'gridania', name: 'Gridania', bg: '#f3f6ef', fg: '#1a2618', accent: '#2f7a3b' },
    { id: 'crystarium', name: 'Crystarium', bg: '#f4f5fb', fg: '#1b1e30', accent: '#5b4fd6' },
    { id: 'uldah', name: "Ul'dah", bg: '#19140d', fg: '#f4ead8', accent: '#e2b04c' },
    { id: 'ishgard', name: 'Ishgard', bg: '#0f141b', fg: '#e5edf6', accent: '#8cc2ff' },
    { id: 'void', name: 'The Void', bg: '#0e0a12', fg: '#eee4f2', accent: '#e0567a' },
  ];

  // --- colour maths (sRGB hex) ---
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const validHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');

  // Three colours -> Portal's surface/text/primary tokens.
  function tokens({ bg, fg, accent }) {
    const dark = lum(bg) < 0.18;
    const onAccent = contrast(accent, '#ffffff') >= contrast(accent, '#0c0e11') ? '#ffffff' : '#0c0e11';
    return {
      'sub-surface': dark ? mix(bg, '#000000', 0.45) : mix(bg, fg, 0.05),
      'surface': bg,
      'surface-variant': mix(bg, fg, dark ? 0.05 : 0.025),
      'on-surface': fg,
      'on-surface-soft': mix(fg, bg, 0.32),
      'outline': mix(fg, bg, 0.58),
      'outline-soft': mix(fg, bg, dark ? 0.78 : 0.88),
      'elevated-level-01': dark ? mix(bg, fg, 0.06) : bg,
      'elevated-level-02': dark ? mix(bg, fg, 0.09) : bg,
      'elevated-level-03': dark ? mix(bg, fg, 0.11) : bg,
      'elevated-dynamic-card': dark ? mix(bg, fg, 0.04) : bg,
      'primary': accent,
      'on-primary': onAccent,
      'primary-soft': mix(bg, accent, dark ? 0.28 : 0.12),
      'on-primary-soft': dark ? mix(accent, '#ffffff', 0.35) : mix(accent, '#000000', 0.35),
      'inverse-primary': mix(accent, dark ? '#000000' : '#ffffff', 0.35),
      'secondary': mix(bg, accent, dark ? 0.22 : 0.14),
      'on-secondary': fg,
      'neutral': fg,
      'on-neutral': bg,
      'neutral-soft': mix(bg, fg, dark ? 0.16 : 0.07),
      'on-neutral-soft': mix(fg, bg, 0.12),
      'inverse-surface': fg,
      'inverse-on-surface': bg,
    };
  }

  const find = (cfg, id) => PRESETS.find((p) => p.id === id) || (cfg.custom || []).find((c) => c.id === id);

  /*
    Portal's light/dark mode is a class on <body> (asurion-light/asurion-dark),
    and some of its styles hang off it rather than the tokens — e.g. the
    ubreakifix logo is one dark PNG that dark mode turns white with a CSS
    filter. So a dark theme also puts Portal in dark mode (and a light theme
    in light mode), held with an observer in case Portal flips it back.
    Portal's own choice is remembered and restored when Glamour lets go.
  */
  const MODES = ['asurion-dark', 'asurion-light'];
  let observer = null, portalMode = null, want = null;
  const modeOf = () => MODES.find((m) => document.body.classList.contains(m)) || null;
  const setMode = (m) => { document.body.classList.remove(...MODES); if (m) document.body.classList.add(m); };
  const watch = () => observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  function holdMode(next) {
    if (!document.body) return;
    if (!next) {
      observer?.disconnect(); observer = null;
      if (want) { want = null; setMode(portalMode); }
      return;
    }
    if (!want) portalMode = modeOf();
    want = next;
    if (modeOf() !== want) setMode(want);
    if (!observer) {
      observer = new MutationObserver(() => {
        const cur = modeOf();
        if (!want || cur === want) return;
        portalMode = cur; // Portal changed its mode (e.g. its own theme toggle):
        try { sessionStorage.setItem(SAVED_KEY, sessionStorage.getItem('theme') ?? NONE); } catch (_) {} // restore that one later
        observer.disconnect(); setMode(want); watch();
        portalTheme(want === 'asurion-dark' ? 'dark' : 'light');
      });
      watch();
    }
  }

  /*
    Portal's React theme. Some images are picked in code, not CSS, from
    Portal's theme state (useIsDarkThemeActive) — the Inventory icons and the
    Reports banner, for example. That state comes from sessionStorage.theme
    ('light' | 'dark' | 'system'), read when each part of the app mounts, and
    changes through the theme provider's setTheme. So Glamour:
      - sets sessionStorage.theme (anything mounted later picks it up), and
      - calls setTheme on the providers already on screen, from a small script
        run in the page (a userscript can't reach React's internals).
    Your own Portal theme is kept in ae_portal_theme and put back on release.
  */
  const SAVED_KEY = 'ae_portal_theme', NONE = '__none__';
  const PAGE_EVENT = 'aethernet:portal-theme';
  const pageHook = () => {
    if (document.getElementById('sg-glamour-hook')) return;
    // Runs in the page, so it's kept as a plain string: the minifier would
    // otherwise rewrite a function's source to lean on helpers that only
    // exist inside Aethernet. Finds every theme provider on screen by walking
    // up React's fiber tree from a node in each app, and calls its setTheme.
    const code = [
      '(function (evt) {',
      '  var fiberKey = function (n) { return Object.keys(n).find(function (k) { return k.indexOf("__reactFiber$") === 0; }); };',
      '  var providers = function () {',
      '    var found = [];',
      '    document.querySelectorAll("[id^=\\"single-spa-application\\"], .components-header, #root, body > div").forEach(function (box) {',
      '      var nodes = [box].concat(Array.prototype.slice.call(box.querySelectorAll("*"), 0, 80));',
      '      var el = nodes.find(function (n) { return fiberKey(n); });',
      '      if (!el) return;',
      '      for (var f = el[fiberKey(el)]; f; f = f.return) {',
      '        var v = f.memoizedProps && f.memoizedProps.value;',
      '        if (v && typeof v.setTheme === "function" && "selected" in v) { if (found.indexOf(v.setTheme) < 0) found.push(v.setTheme); break; }',
      '      }',
      '    });',
      '    return found;',
      '  };',
      '  document.addEventListener(evt, function (e) {',
      '    providers().forEach(function (set) { try { set(e.detail); } catch (_) {} });',
      '  });',
      '})(' + JSON.stringify(PAGE_EVENT) + ');',
    ].join('\n');
    const s = document.createElement('script');
    s.id = 'sg-glamour-hook';
    s.textContent = code;
    (document.head || document.documentElement).append(s);
  };
  function portalTheme(next) {
    try {
      const saved = sessionStorage.getItem(SAVED_KEY);
      let value;
      if (next) {
        if (saved === null) sessionStorage.setItem(SAVED_KEY, sessionStorage.getItem('theme') ?? NONE);
        value = next;
      } else {
        if (saved === null) return; // Glamour never changed it
        sessionStorage.removeItem(SAVED_KEY);
        value = saved === NONE ? 'light' : saved; // Portal's default is light
      }
      sessionStorage.setItem('theme', value);
      pageHook();
      document.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: value })); // runs setTheme synchronously
      if (!next && saved === NONE) sessionStorage.removeItem('theme'); // leave Portal as it was found
    } catch (e) { console.warn('[' + AE_NAME + '] Glamour: could not set Portal theme', e); }
  }

  // Apply a Glamour settings object ({ theme, custom }); unknown or 'portal' clears.
  function apply(cfg) {
    const t = cfg && find(cfg, cfg.theme);
    const el = document.getElementById(STYLE_ID);
    if (!t || !t.bg || ![t.bg, t.fg, t.accent].every(validHex)) { el?.remove(); GM_setValue(EARLY_KEY, ''); holdMode(null); portalTheme(null); return; }
    const dark = lum(t.bg) < 0.18;
    portalTheme(dark ? 'dark' : 'light');
    holdMode(dark ? 'asurion-dark' : 'asurion-light');
    const vars = Object.entries(tokens(t)).map(([k, v]) => '--aui-' + k + ':' + v + ' !important;').join('');
    // Portal sets its tokens on :root and on .asurion-light/.asurion-dark
    // (the <body> class), so override on all three.
    const css = ':root, .asurion-light, .asurion-dark, .partner-light, .partner-dark {' + vars + '}'
      + 'body { background:var(--aui-sub-surface) !important; color-scheme:' + (lum(t.bg) < 0.18 ? 'dark' : 'light') + '; }';
    const style = el || h('style', { id: STYLE_ID });
    style.textContent = css;
    GM_setValue(EARLY_KEY, css); // painted at page start next time (AE.loginPage.early, 01b-login.js)
    document.head.append(style); // (re)append so it stays after Portal's own sheets
  }

  // The Settings editor (nested under the shard). `s` is Settings' working copy.
  const EDITOR_CSS = `
  .sg-glam-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:8px; margin:10px 0 6px; }
  .sg-glam-card { position:relative; display:flex; flex-direction:column; gap:6px; height:66px; padding:8px 9px; border-radius:10px; cursor:pointer; text-align:left;
    border:1px solid var(--aui-outline, #c6c6ca); font:600 12px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; overflow:hidden; }
  .sg-glam-card .aa { font-size:18px; font-weight:700; line-height:1; }
  .sg-glam-card .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sg-glam-card .dot { position:absolute; right:8px; top:8px; width:12px; height:12px; border-radius:50%; }
  .sg-glam-card.on { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; }
  .sg-glam-card.portal { background:linear-gradient(135deg, #ffffff 50%, #130f17 50%); color:#1a1c1e; }
  .sg-glam-card.portal .nm { color:#1a1c1e; background:#ffffffcc; border-radius:4px; padding:0 3px; align-self:flex-start; }
  .sg-glam-card.add { align-items:center; justify-content:center; border-style:dashed; background:none; color:var(--aui-primary, #8223d2); }
  .sg-glam-edit { margin:8px 0 4px; padding:10px 12px; border-radius:10px; background:var(--aui-surface-variant, #faf9fc); border:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-glam-colors { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
  .sg-glam-colors label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-glam-colors input[type=color] { width:100%; height:36px; padding:2px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; background:var(--aui-surface, #fff); cursor:pointer; }
  .sg-glam-warn { margin-top:6px; font-size:12px; color:var(--aui-status-error, #b91a24); }
  .sg-glam-edit .sg-actions { margin-top:10px; justify-content:flex-start; }
  .sg-glam-edit .sg-actions .sg-btn { flex:none; }
  .sg-glam-login { margin-top:14px; padding-top:10px; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-glam-login .row { display:flex; gap:12px; align-items:center; margin-top:8px; }
  .sg-glam-login .thumb { flex:none; width:72px; height:90px; border-radius:8px; border:1px solid var(--aui-outline, #c6c6ca);
    background:linear-gradient(45deg, #8223d2, #ae4fd2) center / cover no-repeat; display:flex; align-items:flex-end; justify-content:center;
    color:#fff; font-size:10px; padding-bottom:4px; text-align:center; }
  .sg-glam-login .btns { display:flex; flex-wrap:wrap; gap:6px; }
  .sg-glam-login .btns .sg-btn { flex:none; height:30px; font-size:13px; }
  .sg-glam-login label.chk { display:flex; gap:8px; align-items:center; margin-top:8px; font-size:13px; cursor:pointer; }
  `;

  /*
    Login page picture: shrunk in the browser to at most 1400 px on the long
    side and saved inside your settings as a data URL (WebP keeps
    transparency, like Portal's cut-out photo; JPEG if WebP isn't available),
    kept under ~1.2 MB.
  */
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error('That file isn\'t an image.'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Couldn\'t read that image.')); };
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const webp = c.toDataURL('image/webp', 0.85).startsWith('data:image/webp');
        for (const q of [0.85, 0.7, 0.55, 0.4]) {
          const d = c.toDataURL(webp ? 'image/webp' : 'image/jpeg', q);
          if (d.length < 1.2e6) return resolve(d);
        }
        reject(new Error('That image is too detailed to store; try a smaller one.'));
      };
      img.src = url;
    });
  }

  function loginEditor(s, repaint) {
    s.glamour.login = Object.assign({ image: '', blank: false, fill: false, mark: true }, s.glamour.login);
    const L = s.glamour.login;
    const thumb = h('div', { class: 'thumb' });
    const status = h('div', { class: 'sg-soft', style: 'font-size:12px;margin-top:4px' });
    const file = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: async () => {
      const f = file.files[0]; file.value = '';
      if (!f) return;
      status.textContent = 'Preparing…';
      try { L.image = await shrinkImage(f); L.blank = false; status.textContent = 'Picked. Save to use it.'; } catch (e) { status.textContent = e.message; }
      paint(); repaint();
    } });
    const fill = h('input', { type: 'checkbox', checked: !!L.fill, onchange: (e) => { L.fill = e.target.checked; paint(); repaint(); } });
    const mark = h('input', { type: 'checkbox', checked: L.mark !== false, onchange: (e) => { L.mark = e.target.checked; repaint(); } });
    const reset = h('button', { type: 'button', class: 'sg-btn', onclick: () => { L.image = ''; L.blank = false; status.textContent = "Back to Portal's picture once you save."; paint(); repaint(); } }, "Portal's picture");
    // No picture: Portal's photo and headline are hidden too, leaving just the purple panel.
    const none = h('button', { type: 'button', class: 'sg-btn', onclick: () => { L.image = ''; L.blank = true; status.textContent = 'No picture once you save.'; paint(); repaint(); } }, 'No picture');
    // Recommended sizes: Portal's own photo is a 768 × 871 cut-out PNG; the panel
    // is the right 60% of the window, full height (about square: 1152 × 1080 on 1080p).
    const tip = h('div', { class: 'sg-soft', style: 'font-size:12px;margin-top:6px' });
    function paint() {
      tip.textContent = L.fill
        ? 'Best fit: about 1400 × 1300 px. The panel\'s shape changes with the window, so the edges may be trimmed; keep the subject in the middle.'
        : 'Best fit: 768 × 871 px (portrait), a PNG with a transparent background, like Portal\'s own photo. It stands at the bottom of the purple panel.';
      thumb.style.backgroundImage = L.image ? 'url("' + L.image + '")' + (L.fill ? '' : ', linear-gradient(45deg, #8223d2, #ae4fd2)') : '';
      thumb.style.backgroundSize = L.image && !L.fill ? 'contain, cover' : 'cover';
      thumb.style.backgroundPosition = L.image && !L.fill ? 'center bottom, center' : 'center';
      if (L.blank) { thumb.style.backgroundImage = 'linear-gradient(45deg, #8223d2, #ae4fd2)'; thumb.style.backgroundSize = 'cover'; }
      thumb.textContent = L.image ? '' : L.blank ? '' : "Portal's";
      reset.disabled = !L.image && !L.blank;
      none.disabled = !!L.blank;
      fill.disabled = !L.image;
    }
    paint();
    return h('div', { class: 'sg-glam-login' },
      h('b', null, 'Login page'),
      h('div', { class: 'sg-soft', style: 'font-size:12px' }, 'Shown on Portal\'s sign-in page in this browser.'),
      h('div', { class: 'row' }, thumb,
        h('div', null,
          h('div', { class: 'btns' }, h('button', { type: 'button', class: 'sg-btn', onclick: () => file.click() }, 'Choose picture…'), reset, none, file),
          status,
          h('label', { class: 'chk' }, fill, 'Fill the whole purple panel'),
          tip,
          h('label', { class: 'chk' }, mark, 'Aethernet mark in the bottom-left corner'))));
  }

  function editor(s, repaint) {
    if (!document.getElementById('sg-glamour-css')) document.head.append(h('style', { id: 'sg-glamour-css' }, EDITOR_CSS));
    // Own copy: AE.merge shares arrays, and Cancel must leave saved themes untouched.
    s.glamour.custom = JSON.parse(JSON.stringify(s.glamour.custom || []));
    const root = h('div');
    let editing = null; // id of the custom theme open in the editor

    const select = (id) => { s.glamour.theme = id; apply(s.glamour); render(); repaint(); };

    const card = (t) => {
      const on = s.glamour.theme === t.id;
      if (t.id === 'portal') {
        return h('button', { type: 'button', class: 'sg-glam-card portal' + (on ? ' on' : ''), title: t.note, onclick: () => { editing = null; select(t.id); } },
          h('span', { class: 'aa' }, 'Aa'), h('span', { class: 'nm' }, t.name));
      }
      return h('button', { type: 'button', class: 'sg-glam-card' + (on ? ' on' : ''), style: 'background:' + t.bg + ';color:' + t.fg + ';border-color:' + mix(t.fg, t.bg, 0.7),
        title: t.custom ? 'Your theme — click again to edit' : t.name,
        onclick: () => { editing = t.custom && on ? t.id : null; select(t.id); } },
        h('span', { class: 'dot', style: 'background:' + t.accent }),
        h('span', { class: 'aa' }, 'Aa'), h('span', { class: 'nm' }, t.name));
    };

    const edit = (t) => {
      const warn = h('div', { class: 'sg-glam-warn' });
      const check = () => {
        const c = contrast(t.bg, t.fg);
        warn.textContent = c < 4.5 ? 'Text may be hard to read on this background (contrast ' + c.toFixed(1) + ':1, aim for 4.5+).' : '';
      };
      const color = (label, key) => h('label', null, label,
        h('input', { type: 'color', value: t[key], oninput: (e) => { t[key] = e.target.value; apply(s.glamour); check(); root.querySelector('.sg-glam-card.on')?.replaceWith(card(t)); } }));
      check();
      return h('div', { class: 'sg-glam-edit' },
        h('label', { class: 'sg-field', style: 'margin-top:0' }, h('span', null, 'Theme name'),
          h('input', { type: 'text', value: t.name, maxlength: 24, oninput: (e) => { t.name = e.target.value || 'My theme'; repaint(); } })),
        h('div', { class: 'sg-glam-colors' }, color('Background', 'bg'), color('Text', 'fg'), color('Accent', 'accent')),
        warn,
        h('div', { class: 'sg-actions' },
          h('button', { type: 'button', class: 'sg-btn', onclick: () => { editing = null; render(); } }, 'Done'),
          h('button', { type: 'button', class: 'sg-btn', onclick: () => {
            s.glamour.custom = s.glamour.custom.filter((c) => c.id !== t.id);
            editing = null; select('portal');
          } }, 'Delete theme')));
    };

    function render() {
      const cur = find(s.glamour, s.glamour.theme);
      const add = h('button', { type: 'button', class: 'sg-glam-card add', onclick: () => {
        // Start from whatever is showing now, so tweaking a preset is easy.
        const base = cur && cur.bg ? cur : { bg: '#ffffff', fg: '#1a1c1e', accent: '#8223d2' };
        const t = { id: 'custom-' + Date.now().toString(36), name: 'My theme', bg: base.bg, fg: base.fg, accent: base.accent, custom: true };
        s.glamour.custom.push(t);
        editing = t.id; select(t.id);
      } }, '+ New theme');
      const editingTheme = editing && s.glamour.custom.find((c) => c.id === editing);
      root.replaceChildren(
        h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Pick a theme to preview it. Save keeps it; Cancel puts yours back.'),
        h('div', { class: 'sg-glam-grid' }, PRESETS.map(card), s.glamour.custom.map(card), add),
        ...(editingTheme ? [edit(editingTheme)] : []));
    }
    render();
    return h('div', null, root, loginEditor(s, repaint));
  }

  const summary = (cfg) => (find(cfg, cfg.theme) || PRESETS[0]).name;

  return { PRESETS, apply, editor, summary, tokens, contrast };
})();

AE.shard({
  id: 'glamour',
  name: 'Glamour',
  sites: ['portal.ubreakifix.net'],
  run() {
    AE.glamour.apply(AE.settings.glamour);
    if (AE.settings.glamour && AE.settings.glamour.theme && AE.settings.glamour.theme !== 'portal') AE.trackDaily('glamour:themed');
  },
});
