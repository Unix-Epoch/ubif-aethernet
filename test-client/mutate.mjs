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
  ['retrace: shortNeed dropped from the sweep', '28-retrace-collect.js', ", shortNeed: baseline.frozen ? SHORT_ASK : 0, soNeed: SO_ASK }));", ', soNeed: SO_ASK }));'],
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
  ['retrace: a cut-short list sent as a full listing', '28-retrace-collect.js', "if (list.length < 200 || (count && page * 200 >= count)) { complete = true; break; }\n    }", "if (list.length < 200 || (count && page * 200 >= count)) { complete = true; break; }\n    }\n    complete = true;"],
  ['retrace: listing not sent', '28-retrace-collect.js', "if (got.complete && got.length <= got.total) acc.listed.push(", "if (false) acc.listed.push("],
  ['tracker: sold parts sends every line', '27-tracker.js', "salesLines: j.salesLines.filter(partLine).map(", "salesLines: j.salesLines.map("],
  ['tracker: sold parts takes any answer', '27-tracker.js', "if (!AE.shape.isObj(j) || !Array.isArray(j.salesLines)) throw", "if (!j) throw"],
  ['tracker: sold parts reports an outage as a failed read', '27-tracker.js', "else { out.stopped = 'Portal trouble: '", "else { results.push({ wo: String(x.wo), cart_id: x.cart_id, failed: 'x' }); out.stopped = 'Portal trouble: '"],
  ['tracker: sold parts backfill not capped', '27-tracker.js', "!seen.has(String(x.wo))).slice(0, SOLD_ASK));", "!seen.has(String(x.wo))));"],
  ['tracker: sold parts reads any WO', '27-tracker.js', "if (pw && Number(pw.statusId) === SOLD_STATUS && pw.csuCartId)", "if (pw && pw.csuCartId)"],
  ['retrace: history 404 marked none at once', '28-retrace-collect.js', 'if (n >= H404_MAX) {', 'if (n >= 1) {'],
  ['retrace: any history error counted as a 404', '28-retrace-collect.js', 'if (httpOf(e) === 404 && !e.worker) {', 'if (!e.worker) {'],
  ['retrace: history 404 count never cleared', '28-retrace-collect.js', "if (h404.has(label)) h404.delete(label); // Portal has it now", ''],
  ['retrace: soNeed dropped from the sweep', '28-retrace-collect.js', ", shortNeed: baseline.frozen ? SHORT_ASK : 0, soNeed: SO_ASK }));", ", shortNeed: baseline.frozen ? SHORT_ASK : 0 }));"],
  ['retrace: soNeed reads ignore the breaker', '28-retrace-collect.js', "if (trouble.on) { trouble.mark('sales order ' + x.sales_order); break; }", ''],
  ['retrace: soNeed budget removed', '28-retrace-collect.js', 'for (const x of soAsk.slice(0, SO_BUDGET)) {', 'for (const x of soAsk) {'],
  ['retrace: soNeed shape check dropped', '28-retrace-collect.js', "const sn = R.detailsSnapshot(d, x.label);", "const sn = R.labelSnapshot(Object.assign({}, d, { label: x.label }));"],
  ['retrace: RMA groups without Headers taken as empty', '28-retrace-collect.js', "if (!j.StatusList.every((g) => AE.shape.isObj(g) && Array.isArray(g.Headers))) throw", "if (false) throw"],
  ['retrace: soNeed malformed answer recorded as no WO', '28-retrace-collect.js', "note('sales order ' + x.sales_order, AE.shape.bad('label details ' + x.label, 'no usable label', d)); continue; }", "soNone.push(x.sales_order); continue; }"],
  ['retrace: soNeed ignores a moved-on sales order', '28-retrace-collect.js', 'if (sn.wo && sn.sales_order === x.sales_order) sos.add', 'if (sn.wo) sos.add'],
  ['retrace: bad shapes trip the pass breaker', '28-retrace-collect.js', 'catch (e) { if (portalDown(e)) downRun++; else if (httpOf(e)) downRun = 0; throw e; }', 'catch (e) { downRun++; throw e; }'],
  ['retrace: watcher clones the Request after the call', '28-retrace-collect.js', "      '    var p = of.apply(this, arguments);',\n      '    if (w) {',", "      '    var p = of.apply(this, arguments);',\n      '    if (w) { try { if (input && typeof input.clone === \"function\" && !(init && init.body != null)) w.bodyP = input.clone().text(); } catch (_) { return p; }',"], // the old order: clone after the call (throws, the write goes unseen),
  ['tactician-window: year inference dropped (Dec→Jan)', '62-tactician.js', "if (y + '-' + pad2(sm + 1) + '-' + pad2(sd) > today) y--;", ""],
  ['tactician-window: end year never rolls over', '62-tactician.js', "ey = em < sm || (em === sm && ed < sd) ? y + 1 : y;", "ey = y;"],
  ['tactician-window: span 7/14 unchecked in text', '62-tactician.js', "return span === 7 || span === 14 ? { start, end, span } : null;\n  }\n  // The page's own request", "return { start, end, span };\n  }\n  // The page's own request"],
  ['tactician-window: span 7/14 unchecked in request', '62-tactician.js', "return span === 7 || span === 14 ? { sunday: fromDate, span } : null;", "return { sunday: fromDate, span };"],
  ['tactician-window: pay period start day ignored', '62-tactician.js', "const start = addDays(sunday, d);", "const start = addDays(sunday, 1);"],
  ['tactician-window: card text no longer wins', '62-tactician.js', "if (t) return { start: t.start,", "if (t && false) return { start: t.start,"],
  ['tactician-window: browser zone instead of the store zone', '62-tactician.js', "{ timeZone: zone, year: 'numeric'", "{ year: 'numeric'"],
  ['tactician-window: bad zone throws', '62-tactician.js', "catch (_) { dayFmts.set(zone, null); }", "catch (e) { throw e; }"],
  ['tactician-window: punches outside the window counted', '62-tactician.js', "if (!(off >= 0 && off < span)) continue;", "if (!(off === off)) continue;"],
  ['tactician-window: breaks counted as hours', '62-tactician.js', "if (p.clockTypeId === 2) { if (here) { u.breaks += hrs; u.weeks[wk].breaks += hrs; } continue; }", "if (p.clockTypeId === 2) { if (here) { u.breaks += hrs; u.weeks[wk].breaks += hrs; } }"],
  ['tactician-window: open punch not counted to now', '62-tactician.js', "(p.timeOut ? Date.parse(p.timeOut) : now) - Date.parse(p.timeIn)", "(p.timeOut ? Date.parse(p.timeOut) : Date.parse(p.timeIn)) - Date.parse(p.timeIn)"],
  ['tactician-window: overtime only this store hours', '62-tactician.js', "u.all += hrs; u.weeks[wk].all += hrs;", "if (here) { u.all += hrs; u.weeks[wk].all += hrs; }"],
  ['tactician-window: overtime over the whole span, not per week', '62-tactician.js', ", wk = Math.floor(off / 7);", ", wk = 0;"],
  ['tactician-page: menu value ignored (always the signed-in store)', '62-tactician.js', "if (typeof value === 'string' && /^[1-9]\\d*$/.test(value)) return", "if (false) return"],
  ['tactician-page: "all" or junk menu value taken as a store id', '62-tactician.js', "/^[1-9]\\d*$/.test(value)", "/^\\w+$/.test(value)"],
  ['tactician-page: no signed-in store still picks one', '62-tactician.js', "return h > 0 ? { store: h, fromMenu: false } : null;", "return { store: h, fromMenu: false };"],
  ['tactician-page: period button read even with All stores', '62-tactician.js', "if (value !== 'all') { const l", "{ const l"],
  ['tactician-page: period button never read (no card, no window)', '62-tactician.js', "if (value !== 'all') { const l", "if (false) { const l"],
  ['tactician-page: card text no longer first', '62-tactician.js', "for (const t of Array.isArray(card) ? card : [card]) { const c = periodFromText(t, today); if (c) return Object.assign(c, { source: 'card' }); }", ""],
  ['tactician-page: Sunday pay-period start day (0) treated as missing', '62-tactician.js', "Number.isInteger(s.payPeriodStartDay) ? s.payPeriodStartDay : null", "s.payPeriodStartDay ? s.payPeriodStartDay : null"],
  ['tactician-page: store info from the wrong store', '62-tactician.js', "((j && j.stores) || []).find((x) => x.storeId === store) ||", "((j && j.stores) || [])[0] ||"],
  ['tactician-page: totals count only 7 day columns', '62-tactician.js', "const tot = { day: Array(span).fill(0),", "const tot = { day: Array(7).fill(0),"],
  ['tactician-page: totals miss the people over', '62-tactician.js', "if (u.ot > 0) tot.otPeople++;", ""],
  ['tactician-weeks: breaks all land in the first week', '62-tactician.js', "u.breaks += hrs; u.weeks[wk].breaks += hrs;", "u.breaks += hrs; u.weeks[0].breaks += hrs;"],
  ['tactician-weeks: floater note not per week', '62-tactician.js', "we.set(n, (we.get(n) || 0) + hrs); }", "we.set(n, (we.get(n) || 0) + u.elsewhere.get(n)); }"],
  ['tactician-weeks: people who did not work the week still listed', '62-tactician.js', "if (!w || !(w.here > 0 || day.some((x) => x > 0))) continue;", "if (!w) continue;"],
  ['tactician-weeks: week total ignores that week (uses both)', '62-tactician.js', "tot.here += w.here; tot.breaks += w.breaks;", "tot.here += u.here; tot.breaks += u.breaks;"],
  ['tactician-weeks: week overtime people not counted', '62-tactician.js', "if (w.ot > 0) tot.otPeople++;", ""],
  ['tactician-weeks: finished week test off by one day', '62-tactician.js', "return addDays(start, wk * 7 + 6) < today;", "return addDays(start, wk * 7 + 5) < today;"],
  ['tactician-weeks: second week taken from the first 7 days', '62-tactician.js', "day = u.day.slice(wk * 7, wk * 7 + 7);", "day = u.day.slice(0, 7);"],
  // ---- Spread (Board view)
  ['spread: unknown open status no longer goes to Waiting', '59-spread.js', 'return i < 0 ? WAITING : i; };', 'return i < 0 ? 0 : i; };'],
  ['spread: sorted newest first', '59-spread.js', 'const byAge = (a, b) => (a.since ? a.since.ms : Infinity) - (b.since ? b.since.ms : Infinity) || a.id - b.id;', 'const byAge = (a, b) => (b.since ? b.since.ms : Infinity) - (a.since ? a.since.ms : Infinity) || a.id - b.id;'],
  ['spread: cards with no time sort first', '59-spread.js', 'const byAge = (a, b) => (a.since ? a.since.ms : Infinity) - (b.since ? b.since.ms : Infinity)', 'const byAge = (a, b) => (a.since ? a.since.ms : -Infinity) - (b.since ? b.since.ms : -Infinity)'],
  ['spread: ties not broken by WO number', '59-spread.js', '(b.since ? b.since.ms : Infinity) || a.id - b.id;', '(b.since ? b.since.ms : Infinity) || 0;'],
  ['spread: RFP date used outside Ready for pickup', '59-spread.js', 'if (statusOf(r) === RFP_STATUS) { const t', 'if (true) { const t'],
  ['spread: updatedAt claimed as time in status', '59-spread.js', "return since.kind === 'status' ? a + ' in status' : 'Updated ' + a + ' ago'; };", "return a + ' in status'; };"],
  ['spread: RFP date ignored (Ready for pickup shows updatedAt)', '59-spread.js', 'if (t !== null) return { ms: clamp(t), kind: \'status\' }; }', 'if (false) return { ms: clamp(t), kind: \'status\' }; }'],
  ['spread: future time not clamped', '59-spread.js', 'const clamp = (t) => Math.min(t, now);', 'const clamp = (t) => t;'],
  ['spread: old only past the threshold, not at it', '59-spread.js', 'hoursOf(since, now) >= OLD_HOURS;', 'hoursOf(since, now) > OLD_HOURS;'],
  ['spread: RFP total on every column', '59-spread.js', 'rfp: col.rfp && cards.length && rfp && Number.isFinite(rfp.value)', 'rfp: cards.length && rfp && Number.isFinite(rfp.value)'],
  ['spread: RFP total shown without a real figure', '59-spread.js', 'col.rfp && cards.length && rfp && Number.isFinite(rfp.value) ?', 'col.rfp && cards.length && rfp ?'],
  ['spread: RFP total shown above an empty column', '59-spread.js', 'rfp: col.rfp && cards.length && rfp &&', 'rfp: col.rfp && rfp &&'],
  ['spread: RFP total rounded down', '59-spread.js', "'$' + Math.round(n).toLocaleString('en-US')", "'$' + Math.floor(n).toLocaleString('en-US')"],
  ['spread: attention marker for any non-empty state', '59-spread.js', "r.attentionState === 'warning' || r.attentionState === 'urgent' ? r.attentionState : null;", "r.attentionState ? r.attentionState : null;"],
  ['spread: attention reasons not checked as text', '59-spread.js', "r.attentionReasons.filter((x) => typeof x === 'string' && x.trim())", "r.attentionReasons"],
  ['spread: device has no nickname fallback', '59-spread.js', "txt(r.deviceCatalog && r.deviceCatalog.name) || txt(r.customerDevice && r.customerDevice.name),", "txt(r.deviceCatalog && r.deviceCatalog.name),"],
  ['spread: card carries the whole customer record', '59-spread.js', 'customer: AE.data.nameOf(r), issue:', 'customer: JSON.stringify(r.customer), issue:'],
  ['spread: card carries the device nickname record (IMEI)', '59-spread.js', "device: txt(r.deviceCatalog && r.deviceCatalog.name) || txt(r.customerDevice && r.customerDevice.name),", "device: JSON.stringify(r.customerDevice),"],
  ['spread: single-status column shows the status line too', '59-spread.js', 'showStatus: COLUMNS[ci].ids.length > 1 ||', 'showStatus: true ||'],
  ['spread: unknown status hides its real name', '59-spread.js', 'showStatus: COLUMNS[ci].ids.length > 1 || !COLUMNS[ci].ids.includes(status),', 'showStatus: false,'],
  ['spread: stagger not capped past row 6', '59-spread.js', 'ci * 40 + Math.min(ri, 6) * 30;', 'ci * 40 + ri * 30;'],
  ['spread: counts fade in with the cards, not after', '59-spread.js', 'const headDelay = (ci) => ci * 40 + 60;', 'const headDelay = (ci) => ci * 40;'],
  ['spread: refreshes while Portal is down', '59-spread.js', "if (!st.shown || st.busy || st.hidden || AE.health.down()) return false;", "if (!st.shown || st.busy || st.hidden) return false;"],
  ['spread: refreshes in a hidden tab', '59-spread.js', "if (!st.shown || st.busy || st.hidden || AE.health.down()) return false;", "if (!st.shown || st.busy || AE.health.down()) return false;"],
  ['spread: refreshes while the board is not shown', '59-spread.js', "if (!st.shown || st.busy || st.hidden || AE.health.down()) return false;", "if (st.busy || st.hidden || AE.health.down()) return false;"],
  ['spread: refreshes while a load is running', '59-spread.js', "if (!st.shown || st.busy || st.hidden || AE.health.down()) return false;", "if (!st.shown || st.hidden || AE.health.down()) return false;"],
  ['spread: refreshes before the list is stale', '59-spread.js', 'return now - st.last >= st.every;', 'return true;'],
  ['spread: rows without a WO number kept', '59-spread.js', "const rows = all.filter((r) => r && typeof r === 'object' && Number.isFinite(Number(r.workorderId)) && r.workorderId !== '' && r.workorderId !== null);", "const rows = all;"],
  ['spread: reads closed work orders too', '59-spread.js', 'await AE.data.workorders(Date.now(), 0);', 'await AE.data.workorders(Date.now(), 1);'],
  ['spread: list with no workOrders reads as empty (core)', '00-core.js', "const rows = shape.list(j, 'workOrders', 'work order list');", "const rows = (j && j.workOrders) || [];"],
  ['spread: list paging stops after one page (core)', '00-core.js', '(rows.count != null ? byId.size >= rows.count : rows.length < PAGE_SIZE)', 'true'],
  ['spread: open list asks for every status (core)', '00-core.js', "workOrderStatusIds: primaryFilter === 'Active' ? OPEN_STATUS_IDS : [],", "workOrderStatusIds: [],"],
  // ---- safety fixes (Nov 11 audit)
  ["safety: punches wrong shape cached as empty", "62-tactician.js", "AE.shape.list(j, 'rows', 'store time sheet')", "((j && j.rows) || [])"],
  ["safety: punches empty week kept as finished", "62-tactician.js", "done: done && rows.length > 0,", "done,"],
  ["safety: daily upload without Store time sheet access", "62-tactician.js", "if (!(await canManage()).ok) return;", ""],
  ["safety: access fast start before the store is known", "01-access.js", "    let p;\n    try { p = await AE.profile(); }", "    const last0 = GM_getValue(CACHE_KEY, null); if (last0 && last0.allowed) boot();\n    let p;\n    try { p = await AE.profile(); }"],
  ["safety: access cached answer of another store trusted", "01-access.js", "cached && cached.store === p.storeId ? cached : null", "cached"],
  ["safety: access denied after fast start does not halt", "01-access.js", "AE.halt('this store no longer has access');", ""],
  ["safety: access names back in the URL", "01-access.js", "/access', { headers", "/access?name=x', { headers"],
  ["safety: access user header not encoded", "01-access.js", "'x-aethernet-user': encodeURIComponent(p.name || '')", "'x-aethernet-user': p.name || ''"],
  ["safety: access store name header not encoded", "01-access.js", "'x-aethernet-store-name': encodeURIComponent(p.storeName || '')", "'x-aethernet-store-name': p.storeName || ''"],
  ["safety: halt: every timers keep running", "00-core.js", "(halted ? undefined :", "(false ? undefined :"],
  ["safety: halt: sameStore ignores it", "00-core.js", "if (storeChanged || halted) return false;", "if (storeChanged) return false;"],
  ["safety: admin key: old saved key kept", "06-feedback.js", "try { GM_deleteValue(ADMIN_KEY_GM); } catch (_) {}", ""],
  ["safety: admin key: saved again", "06-feedback.js", "adminKeyHeld = input.value.trim(); draw();", "adminKeyHeld = input.value.trim(); GM_setValue(ADMIN_KEY_GM, adminKeyHeld); draw();"],
  ["safety: report: bug link error unscrubbed", "06-feedback.js", "error: clean(opts.context.error || '', 600)", "error: String(opts.context.error || '').slice(0, 600)"],
  ["safety: report: bug link where unscrubbed", "06-feedback.js", "where: clean(opts.context.where || '', 120)", "where: String(opts.context.where || '').slice(0, 120)"],
  ["safety: report: Aethernet errors unscrubbed", "06-feedback.js", "errors: AE.recentErrors.slice(-5).map((e) => ({ ...e, where: clean(e.where, 160), message: clean(e.message, 300) })),", "errors: AE.recentErrors.slice(-5),"],
  ["safety: report: Portal page errors unscrubbed", "06-feedback.js", "pageErrors: AE.pageErrors.slice(-5).map((e) => ({ ...e, where: clean(e.where, 160), message: clean(e.message, 300) })),", "pageErrors: AE.pageErrors.slice(-5),"],
  ["safety: notice: unsafe characters allowed in selectors", "02-status.js", "if (BAD_CSS.test(x)) return dropped('selector', x);", ""],
  ["safety: notice: selectors not tried in the browser", "02-status.js", "try { document.querySelector(x); } catch (_) { return dropped('selector', x); }", ""],
  ["safety: notice: closers not validated", "02-status.js", "closers: strs(b.closers, 20).filter(okSelector)", "closers: strs(b.closers, 20)"],
  ["safety: notice: selectors not validated", "02-status.js", "selectors: strs(b.selectors, 20).filter(okSelector)", "selectors: strs(b.selectors, 20)"],
  ["safety: notice: nested quantifiers allowed in pages", "02-status.js", " || nestedQuantifier(x)) return dropped", " ) return dropped"],
  ["safety: notice: long page patterns allowed", "02-status.js", "if (x.length > 120 ||", "if ("],
  ["safety: notice: page patterns not compiled", "02-status.js", "try { new RegExp(x); } catch (_) { return dropped('page pattern', x); }", ""],
  ["safety: cache: tracker details not pruned on first read", "27-tracker.js", "if (!wodPruned.has(k)) {", "if (false) {"],
  ["safety: cache: assize details not pruned on first read", "65-assize.js", "if (!detailsPruned) {", "if (false) {"],
  ["safety: cache: assize keys not listed for wiping", "65-assize.js", "if (k === 'rows' || k === 'details') AE.localCache.note(n);", ""],
  ["safety: cache: not wiped on sign-out (401)", "00-core.js", "if (res.status === 401) signedOut(); ", ""],
  ["safety: cache: not wiped when the store changes", "00-core.js", "try { localCache.clear(); } catch (_) {} // the cached work order details belong", "// the cached work order details belong"],
  ["safety: cache: not wiped when Portal has no signed-in store", "01-access.js", "if (p) AE.signedOut();", ""],
  // ---- Return (paused while saved check-ins are off)
  ['return: saving switched back on', '22-checkin-drafts.js', 'const SAVING_OFF = true;', 'const SAVING_OFF = false;'],
  ['return: pause guard removed', '22-checkin-drafts.js', 'if (SAVING_OFF) return;', ''],
  ['return: Settings no longer says paused', '05-settings.js', "'Paused: saved check-ins are off while their storage is being made private. Return will save", "'Return will save"],
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
