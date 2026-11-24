// HTML escaping for every admin page that builds markup as text: one definition, safe in text and in quoted attributes
// (single or double). Served at /esc.js for the page's modules; m.js writes the same line into Linkpearl's plain script.
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
