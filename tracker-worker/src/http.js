/*
  The tracker Worker's shared request and response helpers: one definition for every route module.
  Imports nothing, so any module may import it.

  A route may throw httpError(status, message) with a status below 500: index.js (serverError) answers with that status and
  { error: message }. Anything else thrown becomes a generic 500 there.
*/
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, x-aethernet-key',
  'access-control-max-age': '86400',
};
// cors: true for the store and agent sides (the userscript calls from Portal's origin); false for the admin site's routes.
export const json = (body, status = 200, cors = true) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(cors ? CORS : {}) } });
export const fail = (status, error, cors = true) => json({ error }, status, cors);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const httpError = (status, message) => new HttpError(status, message);

export async function readJson(req, max) {
  const text = await req.text();
  if (text.length > max) throw httpError(413, 'too large');
  try { return text ? JSON.parse(text) : {}; } catch (_) { throw httpError(400, 'bad JSON'); }
}

export const now = () => new Date().toISOString();
export const int = (v) => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : null));
export const iso = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)?$/.test(v) ? v.slice(0, 40) : null);
// Stored JSON text → its value; null when empty or not JSON.
export const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };

// One line of text, at most `max` long: control characters out, runs of whitespace to one space, trimmed.
const tidy = (s, max) => s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
// clean: strings only (anything else is ''). cleanText: numbers too. cleanAny: whatever it is, as text (null and undefined are '').
export const clean = (v, max) => (typeof v === 'string' ? tidy(v, max) : '');
export const cleanText = (v, max) => (typeof v === 'string' || typeof v === 'number' ? tidy(String(v), max) : '');
export const cleanAny = (v, max) => tidy(String(v == null ? '' : v), max);
// A string with its inner spacing kept: control characters out and trimmed, nothing collapsed.
export const cleanKeep = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');

// All stores are on Eastern time for now; env.STORE_TZ overrides.
export const tzOf = (env) => env.STORE_TZ || 'America/New_York';
export const DAY_RE = /^\d{4}-\d\d-\d\d$/;
