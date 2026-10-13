import assert from 'node:assert/strict';
import * as C from '../src/crypto.js';

const t0 = Date.now();
// Master + one person's copy of it
const master = await C.newKeyPair();
const myCopy = await C.lockWithPhrase(master.privateKey instanceof CryptoKey ? await C.exportPrivate(master.privateKey) : master.privateKey, 'Harbor violet tundra pickle anchor ember', C.aad.person('Garrett@x.com', 'master', 0));
console.log('lock with passphrase:', Date.now() - t0, 'ms');
// Store key, created by any Aethernet install with only the master public key
const sk = await C.newStoreKey(914, master.publicJwk);
assert.ok(sk.wrappedPrivate.startsWith('v1.'));
// Lock a snapshot with the store public key
const snap = { workorder: { workorderId: 5001, customer: 'Jordan Reyes', phone: '757-555-0100' }, notes: Array.from({ length: 30 }, (_, i) => ({ noteText: 'note ' + i + ' lorem ipsum dolor sit amet' })) };
const sealed = await C.sealJson(snap, sk.publicJwk, C.aad.snapshot(914, 5001));
assert.ok(!sealed.includes('Jordan') && !sealed.includes('555'));
console.log('sealed size:', sealed.length, 'bytes vs plain', JSON.stringify(snap).length);
// Unlock: passphrase (spacing/case differ) → master → store key → snapshot
const m2 = await C.unlockWithPhrase(myCopy, '  harbor-violet  tundra pickle anchor EMBER ', C.aad.person('garrett@x.com', 'master', 0), true);
const storePriv = await C.openStoreKey(914, sk.wrappedPrivate, m2);
assert.deepEqual(await C.openJson(sealed, storePriv, C.aad.snapshot(914, 5001)), snap);
// Wrong passphrase, wrong WO binding, wrong store binding all fail
await assert.rejects(C.unlockWithPhrase(myCopy, 'harbor violet tundra pickle anchor embers', C.aad.person('garrett@x.com', 'master', 0)), /Wrong passphrase/);
await assert.rejects(C.openJson(sealed, storePriv, C.aad.snapshot(914, 5002)));
await assert.rejects(C.openStoreKey(326, sk.wrappedPrivate, m2));
// Tampered ciphertext fails
const bad = sealed.slice(0, -4) + (sealed.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
await assert.rejects(C.openJson(bad, storePriv, C.aad.snapshot(914, 5001)));
// A store-limited person: an invite copy of the 914 key only, redeemed into their own passphrase
const bytes914 = await C.openStoreKeyBytes(914, sk.wrappedPrivate, m2);
const invite = await C.lockWithPhrase(bytes914, 'otter maple crisp', C.aad.person('mgr@x.com', 'store', 914));
const k914 = await C.unlockWithPhrase(invite, 'otter maple crisp', C.aad.person('mgr@x.com', 'store', 914), true);
const theirs = await C.lockWithPhrase(await C.exportPrivate(k914), 'their own six word passphrase here', C.aad.person('mgr@x.com', 'store', 914));
const k914b = await C.unlockWithPhrase(theirs, 'their own six word passphrase here', C.aad.person('mgr@x.com', 'store', 914));
assert.equal((await C.openJson(sealed, k914b, C.aad.snapshot(914, 5001))).workorder.customer, 'Jordan Reyes');
// ...but that person can't open another store's data
const sk326 = await C.newStoreKey(326, master.publicJwk);
const s326 = await C.sealJson({ a: 1 }, sk326.publicJwk, C.aad.snapshot(326, 1));
await assert.rejects(C.openJson(s326, k914b, C.aad.snapshot(326, 1)));
// Speed: sealing 200 snapshots and opening 1,000 small cards
let t = Date.now(); for (let i = 0; i < 200; i++) await C.sealJson(snap, sk.publicJwk, C.aad.snapshot(914, i)); console.log('seal x200:', Date.now() - t, 'ms');
const cards = []; for (let i = 0; i < 1000; i++) cards.push(await C.sealJson({ name: 'Jordan ' + i, phone: '757555' + i }, sk.publicJwk, C.aad.card(914, i)));
t = Date.now(); for (let i = 0; i < 1000; i++) await C.openJson(cards[i], storePriv, C.aad.card(914, i)); console.log('open 1000 cards:', Date.now() - t, 'ms');
console.log('crypto: all passed');
