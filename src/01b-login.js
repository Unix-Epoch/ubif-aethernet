/*
  Glamour on the login page: your own picture in place of Portal's (the photo
  on the purple panel, or filling the whole panel), and the Aethernet mark
  under the ubreakifix logo. Settings: Glamour → Login page
  (settings.glamour.login = { image: data URL or '', fill, mark }).

  Runs before the store check (01-access.js): nobody is signed in on the
  login page, so there's no store to check. It applies only if this browser
  last loaded Portal at a store with access (the cached answer), and only
  while Glamour is on.

  Portal's login page (main-layout app, /login): a left column with the logo
  image and the SSO button, and a right panel (a purple gradient over a
  doodle pattern) holding a headline and a photo. Class names are generated,
  so the panel is found as the element with a gradient background that holds
  an image. React's nodes are hidden, never removed or changed; ours sit
  beside them and go away when the page leaves /login.
*/
AE.loginPage = (() => {
  if (!AE_ON_PORTAL) return null;
  const CSS = `
    .ae-login-hidden { display: none !important; }
    #ae-login-img { object-fit: contain !important; object-position: center bottom; max-width: 100%; } /* any shape shows whole, standing on the bottom like Portal's photo */
    .ae-login-fill { background: var(--ae-login-image) center / cover no-repeat !important; }
    .ae-login-fill > :not(#ae-login-img) { visibility: hidden; }
    #ae-login-mark { display: flex; align-items: center; gap: 6px; margin-top: 10px; color: #8223d2; opacity: .9; }
  `;
  const allowed = () => AE_DEMO || (GM_getValue('ae_access', null) || {}).allowed === true;
  const cfg = () => (AE.settings.crystals.glamour && AE.settings.glamour && AE.settings.glamour.login) || {};

  function findPanel() {
    for (const img of document.querySelectorAll('img')) {
      const p = img.parentElement;
      if (p && p.id !== 'ae-login-img' && /linear-gradient/.test(getComputedStyle(p).backgroundImage)) return { panel: p, photo: img };
    }
    return null;
  }

  let painted = false;
  function clear() {
    if (!painted) return;
    painted = false;
    document.getElementById('ae-login-img')?.remove();
    document.getElementById('ae-login-mark')?.remove();
    document.querySelectorAll('.ae-login-hidden').forEach((e) => e.classList.remove('ae-login-hidden'));
    document.querySelectorAll('.ae-login-fill').forEach((e) => { e.classList.remove('ae-login-fill'); e.style.removeProperty('--ae-login-image'); });
  }

  function paint() {
    if (location.pathname !== '/login' || !allowed()) return clear();
    const c = cfg();
    const found = findPanel();
    if (!found) return;
    if (!document.getElementById('ae-login-css')) document.head.append(AE.h('style', { id: 'ae-login-css' }, CSS));
    painted = true;
    const { panel, photo } = found;

    // The picture
    let mine = document.getElementById('ae-login-img');
    if (!c.image) {
      mine?.remove(); photo.classList.remove('ae-login-hidden');
      panel.classList.remove('ae-login-fill'); panel.style.removeProperty('--ae-login-image');
    } else if (c.fill) {
      mine?.remove(); photo.classList.remove('ae-login-hidden');
      panel.style.setProperty('--ae-login-image', 'url("' + c.image + '")');
      panel.classList.add('ae-login-fill');
    } else {
      panel.classList.remove('ae-login-fill'); panel.style.removeProperty('--ae-login-image');
      if (!mine) {
        mine = AE.h('img', { id: 'ae-login-img', alt: '', class: photo.className, style: photo.getAttribute('style') || '' }); // same size and place as Portal's
        photo.after(mine);
      }
      if (mine.getAttribute('src') !== c.image) mine.src = c.image;
      photo.classList.add('ae-login-hidden');
    }

    // The Aethernet mark, under the ubreakifix logo
    const mark = document.getElementById('ae-login-mark');
    if (!c.mark) { mark?.remove(); return; }
    if (mark) return;
    const logo = [...document.querySelectorAll('img')].find((i) => i !== photo && !panel.contains(i));
    if (!logo || !logo.parentElement) return;
    logo.parentElement.after(AE.h('div', { id: 'ae-login-mark', title: AE_NAME },
      AE.h('span', { style: 'line-height:0', html: AE.icon('aetheryte', 28) }),
      AE.h('span', { style: 'line-height:0', html: AE.wordmark(20) })));
  }

  // Portal is a single-page app: /login comes and goes without a page load.
  let timer = null;
  function watch() {
    if (timer) return;
    timer = setInterval(() => { try { paint(); } catch (e) { console.warn('[' + AE_NAME + '] login page:', e); } }, 500);
    paint();
  }
  watch();
  return { paint, findPanel };
})();
