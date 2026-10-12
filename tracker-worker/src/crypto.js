/*
  Work order tracker encryption (format v1). Shared by Aethernet (locks: needs only a
  store's public key), the admin site (unlocks with a person's passphrase) and the tests.
  Plain Web Crypto, so it runs the same in browsers, Workers and Node.

  Keys
    master      ECDH P-256. Full-access people (owners, district managers, the dev) hold it.
    store key   ECDH P-256, one per store. Its private half is stored locked to the master
                public key, so whoever holds the master can open every store; a person
                limited to some stores gets copies of just those store keys.
    person copy A master or store private key locked with a key stretched from that
                person's passphrase (PBKDF2-SHA256, 600,000 rounds) or a one-time invite code.

  Sealed data  "v1." + base64url( epk(65) | iv(12) | AES-256-GCM ciphertext )
    The AES key comes from ECDH(fresh key, recipient public key) → HKDF-SHA256. `aad` (the
    store/WO/kind it belongs to) is bound in, so a blob can't be moved to another WO or store.
    JSON is gzipped before sealing.
*/
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const INFO = te.encode('aethernet-tracker v1');
export const PBKDF2_ROUNDS = 600000;

export const b64u = (bytes) => {
  let s = ''; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function pipe(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export const gzip = (bytes) => pipe(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes) => pipe(bytes, new DecompressionStream('gzip'));

// ---------------------------------------------------------------- keys
export async function newKeyPair() {
  const kp = await subtle.generateKey(EC, true, ['deriveBits']);
  return { publicJwk: await exportPublic(kp.publicKey), privateKey: kp.privateKey };
}
async function exportPublic(key) {
  const { kty, crv, x, y } = await subtle.exportKey('jwk', key);
  return { kty, crv, x, y };
}
export const importPublic = (jwk) => subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, EC, true, []);
export const exportPrivate = async (key) => new Uint8Array(await subtle.exportKey('pkcs8', key));
export const importPrivate = (pkcs8) => subtle.importKey('pkcs8', pkcs8, EC, false, ['deriveBits']);

async function aesFromEcdh(privateKey, publicKey, salt) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---------------------------------------------------------------- sealing (public key) / opening (private key)
export async function sealBytes(bytes, recipientJwk, aad) {
  const recipient = typeof recipientJwk.algorithm === 'object' ? recipientJwk : await importPublic(recipientJwk);
  const eph = await subtle.generateKey(EC, true, ['deriveBits']);
  const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const key = await aesFromEcdh(eph.privateKey, recipient, epk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes));
  return 'v1.' + b64u(cat(epk, iv, ct));
}
export async function openBytes(sealed, privateKey, aad) {
  if (typeof sealed !== 'string' || !sealed.startsWith('v1.')) throw new Error('not a v1 sealed value');
  const raw = unb64u(sealed.slice(3));
  const epk = raw.subarray(0, 65), iv = raw.subarray(65, 77), ct = raw.subarray(77);
  const key = await aesFromEcdh(privateKey, await subtle.importKey('raw', epk, EC, false, []), epk);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, ct));
}
export const sealJson = async (value, recipientJwk, aad) => sealBytes(await gzip(te.encode(JSON.stringify(value))), recipientJwk, aad);
export const openJson = async (sealed, privateKey, aad) => JSON.parse(td.decode(await gunzip(await openBytes(sealed, privateKey, aad))));

// What each sealed value is bound to.
export const aad = {
  storeKey: (store) => 'store-key|' + store,
  snapshot: (store, wo) => 'snapshot|' + store + '|' + wo,
  card: (store, wo) => 'card|' + store + '|' + wo,
  person: (email, kind, store) => 'person|' + String(email).toLowerCase() + '|' + kind + '|' + (store || 0),
};

// A new store key: the private half leaves locked to the master public key and is then forgotten.
export async function newStoreKey(store, masterPublicJwk) {
  const kp = await newKeyPair();
  return { publicJwk: kp.publicJwk, wrappedPrivate: await sealBytes(await exportPrivate(kp.privateKey), masterPublicJwk, aad.storeKey(store)) };
}
// The raw private key bytes (to give a copy to a person) or a ready key (to open snapshots).
export const openStoreKeyBytes = (store, wrappedPrivate, masterPrivateKey) => openBytes(wrappedPrivate, masterPrivateKey, aad.storeKey(store));
export const openStoreKey = async (store, wrappedPrivate, masterPrivateKey) => importPrivate(await openBytes(wrappedPrivate, masterPrivateKey, aad.storeKey(store)));

// ---------------------------------------------------------------- passphrase / invite-code copies
export const normalizePhrase = (p) => String(p).normalize('NFKC').trim().toLowerCase().replace(/[\s\-_.,]+/g, ' ');
async function phraseKey(phrase, salt, rounds) {
  const base = await subtle.importKey('raw', te.encode(normalizePhrase(phrase)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// A private key locked with a passphrase: { salt, rounds, wrapped }.
export async function lockWithPhrase(privateKey, phrase, bindTo, rounds = PBKDF2_ROUNDS) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await phraseKey(phrase, salt, rounds);
  const pkcs8 = privateKey instanceof Uint8Array ? privateKey : await exportPrivate(privateKey);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(bindTo) }, key, pkcs8));
  return { salt: b64u(salt), rounds, wrapped: 'p1.' + b64u(cat(iv, ct)) };
}
export async function unlockWithPhrase(copy, phrase, bindTo, extractable = false) {
  const raw = unb64u(copy.wrapped.replace(/^p1\./, ''));
  const key = await phraseKey(phrase, unb64u(copy.salt), copy.rounds);
  let pkcs8;
  try { pkcs8 = await subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: te.encode(bindTo) }, key, raw.subarray(12)); }
  catch (_) { throw new Error('Wrong passphrase.'); }
  return subtle.importKey('pkcs8', pkcs8, EC, extractable, ['deriveBits']);
}

// Six random words from a list (passphrases and invite codes). 7776 words → ~77 bits.
export function randomWords(list, n = 6) {
  const out = [], r = crypto.getRandomValues(new Uint32Array(n));
  for (let i = 0; i < n; i++) out.push(list[r[i] % list.length]);
  return out.join(' ');
}

// Hash of a value's JSON (unchanged snapshots aren't stored twice).
export async function hashJson(value) {
  return b64u(await subtle.digest('SHA-256', te.encode(JSON.stringify(value))));
}
