// Mutation check for the client tests: each mutation below breaks one guard on purpose, in a scratch copy of src/ and test-client/,
// and the suite (run.mjs) must FAIL for it. A mutation the suite survives is a guard no test protects: fix the tests.
//
//   node test-client/mutate.mjs              (all)      node test-client/mutate.mjs lock shortNeed   (names containing either)
//
// Each mutation is a literal find → replace in one src file; the find must occur exactly once (else the list is stale: update it).
// The real tree is never touched. tracker-worker/ and sandbox/fixtures are linked read-only into the scratch copy.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const M = [
  // ---- core: AE.api / AE.health
  ['core: network failures not counted', '00-core.js', "else health.fail(e.timedOut ? 'timeout' : 'network', e, probe);", 'else void 0;'],
  ['core: offline check removed', '00-core.js', 'if (offline()) health.release(probe); else health.fail', 'if (false) health.release(probe); else health.fail'],
  ['core: timeout timer never cleared', '00-core.js', '} finally { clearTimeout(timer); }', '} finally { }'],
  ['core: down() claims the probe again', '00-core.js', 'const down = () => isDown() && (probeOut() || Date.now() < s.nextProbe);', 'const down = () => { if (!isDown()) return false; if (probeOut() || Date.now() < s.nextProbe) return true; s.probe = ++seq; s.probeAt = Date.now(); return false; };'],
  ['core: any call\'s answer moves the state while down', '00-core.js', 'if (isDown()) { if (mine(token)) { s.probe = 0; step(); } return; }', 'if (isDown()) { s.probe = 0; step(); return; }'],
  ['core: BadShape counts as an outage', '00-core.js', "if (kind === 'shape' || kind === 'notjson') { s.shapeFails++; s.lastShape = info; release(token); return; }", "if (kind === 'shape' || kind === 'notjson') { s.shapeFails++; s.lastShape = info; }"],
  ['core: one success ends an outage (no recovering)', '00-core.js', 'const health = (() => {\n    const STEPS = [60000, 120000, 300000, 600000], FAILS = 3, RECOVER_OK = 3,', 'const health = (() => {\n    const STEPS = [60000, 120000, 300000, 600000], FAILS = 3, RECOVER_OK = 1,'],
  ['core: a failure while recovering is ignored', '00-core.js', "if (s.mode === 'recovering') { s.mode = 'down'; s.oks = 0; s.retrips++; step(); return; }", "if (s.mode === 'recovering') { s.oks = 0; return; }"],
  ['core: outage toast not rate-limited', '00-core.js', 'if (AE_ON_PORTAL && !(Date.now() - s.toastAt < TOAST_GAP_MS)) {', 'if (AE_ON_PORTAL) {'],
  ['core: Worker errors untagged', '00-core.js', "sessionExpired: false, worker: true });", 'sessionExpired: false });'],
  // ---- background gates and breakers
  ['tracker: down() gate removed', '27-tracker.js', "AE.status.paused('tracker') || AE.health.down()) return null;", "AE.status.paused('tracker')) return null;"],
  ['tracker: tripped() break removed', '27-tracker.js', "if (AE.health.tripped()) { result.note = 'Portal is down: stopped, the rest next scan'; break; }", ''],
  ['tracker: partial cap removed', '27-tracker.js', 'const partialOk = partialCount(store, n.wo) >= PARTIAL_MAX;', 'const partialOk = false;'],
  ['tracker: daily 403 check ignores the tag', '27-tracker.js', 'if (e.worker && e.status === 403) return false;', 'if (e.status === 403 || e.status === 500) return false;'],
  ['waymark: down() gate removed', '55-waymark.js', "if (!opts.force && AE.health.down()) return null; // Portal is down", '// gate removed'],
  ['assize: down() gate removed', '65-assize.js', "if (!force && AE.health.down()) return; // Portal is down", '// gate removed'],
  ['retrace: down() gate removed', '28-retrace-collect.js', "if (!opts.force && AE.health.down()) return skipped('Portal is down (AE.health): waiting for its next probe');", ''],
  ['esuna: down() gate removed', '15-wo-cleanings.js', 'else if (stale && !AE.health.down()) {', 'else if (stale) {'],
  ['divination: down() gate removed', '10-cleaning-rate.js', 'const autoRefresh = () => { if (!AE.health.down()) refresh(); };', 'const autoRefresh = () => { refresh(); };'],
  ['tactician: down() gate removed', '62-tactician.js', 'Date.now() - loadedAt > STALE_MS && !AE.health.down()', 'Date.now() - loadedAt > STALE_MS'],
  // ---- readers: the old work-order fallback
  ['esuna: old work-order fallback', '15-wo-cleanings.js', "AE.shape.workorder(await AE.api('GET', '/api/workorder/' + woId), 'Esuna work order ' + woId)", "((j) => (j && j.workorder) || AE.unwrap(j))(await AE.api('GET', '/api/workorder/' + woId))"],
  ['swiftcast: old work-order fallback', '20-auto-close.js', "Object.assign({}, AE.shape.workorder(r, 'Swiftcast work order ' + woId))", 'Object.assign({}, (r && r.workorder) || unwrap(r))'],
  ['swiftcast: checkout GET not raw', '20-auto-close.js', "await api('GET', '/api/checkout/workorder/' + woId, undefined, { raw: true });", "await api('GET', '/api/checkout/workorder/' + woId);"],
  ['return: old work-order fallback', '22-checkin-drafts.js', "try { wo = AE.shape.workorder(await AE.api('GET', '/api/workorder/' + current.woId)); } catch (_) { return; }", "try { const j = await AE.api('GET', '/api/workorder/' + current.woId); wo = (j && j.workorder) || AE.unwrap(j) || {}; } catch (_) { return; }"],
  ['recitation: old work-order fallback', '17-text-notes.js', "AE.shape.workorder(woRes, 'Recitation work order ' + woId)", '(woRes && woRes.workorder) || AE.unwrap(woRes) || {}'],
  ['macrocosmos: no work-order check', '30-galaxy.js', "AE.shape.workorder(json, 'Macrocosmos work order ' + woId)", '((json && json.workorder) || {})'],
  ['decipher: old work-order fallback', '64-decipher.js', "fromWo(AE.shape.workorder(j, 'Decipher work order ' + woId))", 'fromWo((j && j.workorder) || AE.unwrap(j))'],
  ['provoke: shape-checks the failed read again', '24-provoke.js', "catch (_) { j = undefined; } // a failed call", "catch (_) { j = null; } // a failed call"],
  ['provoke: no backoff after a failed read', '24-provoke.js', "statusMiss.set(woId, { n: m.n + 1, next: Date.now() + Math.min(STATUS_RETRY_MS * 2 ** m.n, STATUS_RETRY_MAX) });", "statusMiss.set(woId, { n: m.n + 1, next: Date.now() });"],
  // ---- Retrace
  ['retrace: shortNeed dropped from the sweep', '28-retrace-collect.js', ", shortNeed: baseline.frozen ? SHORT_ASK : 0 }));", ' }));'],
  ['retrace: sweep forwards a fixed list again', '28-retrace-collect.js', "if (last) for (const [k, v] of Object.entries(body)) if (!(k in LIMIT) && k !== 'by' && v != null) part[k] = v;", "if (last) for (const k of ['need', 'poNeed', 'nameNeed', 'cursors', 'countNeed', 'poTotal']) if (body[k] != null) part[k] = body[k];"],
  ['retrace: request fields on every part', '28-retrace-collect.js', "if (last) for (const [k, v] of Object.entries(body))", 'for (const [k, v] of Object.entries(body))'],
  ['retrace: sweep timeout back to 30 s', '28-retrace-collect.js', "const j = await worker(store, 'POST', '/sweep', part, { timeoutMs: SWEEP_TIMEOUT_MS });", "const j = await worker(store, 'POST', '/sweep', part);"],
  ['retrace: {} serial history read as []', '28-retrace-collect.js', "AE.shape.obj(h, ['value'], 'serial history ' + label);\n          const rows = AE.shape.list(h, 'value', 'serial history ' + label);", 'const rows = R.rowsOf(h);'],
  ['retrace: PO sent with a failed receive', '28-retrace-collect.js', "catch (e) { if (fatal(e)) throw e; note('po receive ' + po, e); failedRec('po:' + po); trouble.mark('po receive ' + po); continue; }\n          if (!AE.shape.isObj(receive)) { note('po receive ' + po, AE.shape.bad('po receive ' + po, 'no receive details', receive)); failedRec('po:' + po); continue; }", "catch (e) { if (fatal(e)) throw e; note('po receive ' + po, e); receive = null; }"],
  ['retrace: lookup page shape unchecked', '28-retrace-collect.js', "const list = lookupPage(await portal(", 'const list = R.rowsOf(await portal('],
  ['retrace: lookup Success:false accepted', '28-retrace-collect.js', 'if (j.Success === false) throw', 'if (false) throw'],
  ['retrace: lookup page cap accepted', '28-retrace-collect.js', "if (!ended) throw new Error('the item lookup by '", "if (false) throw new Error('the item lookup by '"],
  ['retrace: the lock removed', '28-retrace-collect.js', "if (held) return skipped('another tab is running a pass", "if (false) return skipped('another tab is running a pass"],
  ['retrace: lock never checked mid-pass', '28-retrace-collect.js', "if (lockLive(l) && l.owner !== TAB) throw new LockLost('another tab took over the Retrace pass');", ''],
  ['retrace: no heartbeat timer', '28-retrace-collect.js', 'const beatTimer = setInterval(() => { try { if (running) beat(); } catch (_) { /* the next call stops the pass */ } }, BEAT_MS);', 'const beatTimer = 0;'],
  ['retrace: list queues overwritten, not merged', '28-retrace-collect.js', "const out = (GM_getValue(key, []) || []).map(String).filter((x) => !removed.has(x) && !added.has(x)).concat([...added]);", 'const out = [...cur];'],
  ['retrace: map queues overwritten, not merged', '28-retrace-collect.js', "        const out = read();\n        for (const k of dels) delete out[k];", "        const out = Object.assign({}, cur);\n        for (const k of dels) delete out[k];"],
  ['retrace: a single 504 trips the pass', '28-retrace-collect.js', 'const DOWN_RUN = 2;', 'const DOWN_RUN = 1;'],
  ['retrace: pass breaker ignores AE.health', '28-retrace-collect.js', 'get on() { return downRun >= DOWN_RUN || (!opts.force && AE.health.tripped()); },', 'get on() { return downRun >= DOWN_RUN; },'],
  ['retrace: counts never rest', '28-retrace-collect.js', "if (resting('count:' + item)) {", "if (false) {"],
  ['retrace: parked items never come back', '28-retrace-collect.js', 'if (nowMs - Number(park.get(i)) >= PARK_MS) {', 'if (false) {'],
  ['retrace: quantity-only never expires', '28-retrace-collect.js', 'const isQo = (i) => qtyOnly.has(String(i)) && qoKeep(String(i), qtyOnly.get(String(i)));', 'const isQo = (i) => qtyOnly.has(String(i));'],
  ['retrace: quantity-only kept after a count with labels', '28-retrace-collect.js', 'else if (qtyOnly.has(t.item)) qtyOnly.delete(t.item);', ''],
  ['retrace: sales order marked before the details are checked', '28-retrace-collect.js', "if (sn) { snaps.push(sn); sos.add(so); } else note(", "sos.add(so); if (sn) { snaps.push(sn); } else note("],
  ['retrace: RMA marked seen before its read', '28-retrace-collect.js', "if (read >= RMA_BUDGET || trouble.on) continue; // over budget: next pass (not marked seen)\n        read++;", "if (read >= RMA_BUDGET || trouble.on) continue; // over budget: next pass (not marked seen)\n        read++; next[d.id] = status;"],
  ['retrace: stray failure counts kept', '28-retrace-collect.js', 'fails.save((k) => todo.has(k));', 'fails.save();'],
  ['retrace: Worker 403 test ignores the tag', '28-retrace-collect.js', 'if (e.worker && e.status === 403) { result.note', 'if (e.status === 403) { result.note'],
  ['retrace: bad shapes trip the pass breaker', '28-retrace-collect.js', 'catch (e) { if (portalDown(e)) downRun++; else if (httpOf(e)) downRun = 0; throw e; }', 'catch (e) { downRun++; throw e; }'],
  ['retrace: watcher clones the Request after the call', '28-retrace-collect.js', "      '    var p = of.apply(this, arguments);',\n      '    if (w) {',", "      '    var p = of.apply(this, arguments);',\n      '    if (w) { try { if (input && typeof input.clone === \"function\" && !(init && init.body != null)) w.bodyP = input.clone().text(); } catch (_) { return p; }',"], // the old order: clone after the call (throws, the write goes unseen),
];

const only = process.argv.slice(2);
const list = only.length ? M.filter(([name]) => only.some((o) => name.toLowerCase().includes(o.toLowerCase()))) : M;
const scratch = mkdtempSync(path.join(tmpdir(), 'ae-mutate-'));
let survived = 0, stale = 0;
try {
  mkdirSync(path.join(scratch, 'sandbox'));
  symlinkSync(path.join(ROOT, 'tracker-worker'), path.join(scratch, 'tracker-worker'));
  symlinkSync(path.join(ROOT, 'sandbox', 'fixtures'), path.join(scratch, 'sandbox', 'fixtures'));
  cpSync(path.join(ROOT, 'test-client'), path.join(scratch, 'test-client'), { recursive: true });
  const clean = () => { rmSync(path.join(scratch, 'src'), { recursive: true, force: true }); cpSync(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true }); };
  clean();
  const base = spawnSync(process.execPath, ['test-client/run.mjs'], { cwd: scratch, encoding: 'utf8' });
  if (base.status !== 0) { console.log('the unmutated suite fails in the scratch copy: fix that first\n' + base.stdout.split('\n').filter((l) => /^FAIL|passed/.test(l)).join('\n')); process.exit(2); }
  for (const [name, file, find, repl] of list) {
    clean();
    const f = path.join(scratch, 'src', file), src = readFileSync(f, 'utf8'), n = src.split(find).length - 1;
    if (n !== 1) { console.log('STALE    ' + name + ' (' + file + ': found ' + n + ' times)'); stale++; continue; }
    writeFileSync(f, src.replace(find, () => repl));
    const r = spawnSync(process.execPath, ['test-client/run.mjs'], { cwd: scratch, encoding: 'utf8', timeout: 600000 });
    const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5));
    if (r.status === 0) { console.log('SURVIVED ' + name); survived++; }
    else console.log('killed   ' + name + ' (' + fails.length + ' failing: ' + fails.slice(0, 2).join(' | ').slice(0, 140) + ')');
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log('\n' + (list.length - survived - stale) + '/' + list.length + ' mutations killed' + (survived ? ', ' + survived + ' survived' : '') + (stale ? ', ' + stale + ' stale' : ''));
process.exit(survived || stale ? 1 : 0);
