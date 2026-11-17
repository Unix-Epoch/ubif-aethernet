/*
  Elusive Jump — pullback scanning (the scan_serials.py tool, crystallized).

  Upload the PowerBI "Pullback Serials" export (Store, SKU, Description, Serial, Return Units, Return Value, Consignment Status;
  Monty Flag when present). The header row is found in the first 15 rows (the first one with a Serial column; headers like
  'Unique Serials'[Serial] match Serial), rows with no serial are dropped (the Total and "Applied filters" rows), HTML entities are
  decoded (&quot;), and only the rows for Portal's current store are kept (the "#914" in the Store text). Items are sorted by
  Description so a model's parts sit together. When the file has no rows for this store, a store list shows instead.

  Scanning: one item at a time. A scan that matches the expected serial (trimmed, case-insensitive) marks it in Portal right away:
    POST /api/boh/inventory/<scanned serial>/mark-defective-broken
      { serial: <scanned>, reasonCode: 'OEM Slow Moving Parts', reasonDetails: 'Pullback', brokenBy: '' } → { Success: true }
  An item already marked answers HTTP 500 (empty body); only then is the serial looked up in the store's quarantine warehouse
    GET /api/boh/store-products/<sku>/inventory?pageSize=20&page=1&searchTerm=<serial>&warehouseId=<store>Q → { value: [{ SerialNumber, SerialStatus }] }
  and SerialStatus NonDefectiveRMA counts as done ("skipped-already-marked"). Both calls, their bodies and the keys read are the
  ones scan_serials.py has used in production. The calls use fetch directly, not AE.api: a 500 here is an expected answer for an
  already-marked item and must not count toward AE.health's outage breaker.
  Mismatch → Accept anyway (marks with the scanned serial, Match OVERRIDE), Skip, Undo. A failed mark → Retry, Already marked
  (no call), Skip. Undo puts the previous item back to pending (Portal isn't changed).

  Results file: "<file> - <store> - Scan Results.xlsx", the input columns + Scanned Serial, Match, Status, Scanned At,
  Backend Status, Backend Message, Backend At, rows filled green (matched), red (mismatch), yellow (overridden, skipped, already
  marked); same layout as the script's. Uploading a results file (it has a Scanned Serial column) picks the run up again: scanned
  items not yet marked in Portal (Linkpearl's files, which can't reach Portal) are marked first, then scanning carries on.
  Progress is kept in this browser (ae_pullback_session), so a reload resumes.

  The .xlsx reader/writer is a small one of our own (no SheetJS): reading inflates with DecompressionStream('deflate-raw'),
  writing stores the parts uncompressed.
*/
AE.pullbacks = (() => {
  const RESULT_HEADERS = ['Scanned Serial', 'Match', 'Status', 'Scanned At', 'Backend Status', 'Backend Message', 'Backend At'];
  const FIELD = {
    Store: 'store', SKU: 'sku', Description: 'description', Serial: 'serial', 'Return Units': 'return_units', 'Return Value': 'return_value',
    'Consignment Status': 'consignment_status', 'Monty Flag': 'monty_flag', 'Scanned Serial': 'scanned_serial', Match: 'match', Status: 'status',
    'Scanned At': 'scanned_at', 'Backend Status': 'backend_status', 'Backend Message': 'backend_message', 'Backend At': 'backend_at',
  };
  const REASON_CODE = 'OEM Slow Moving Parts', REASON_DETAILS = 'Pullback', ALREADY = 'NonDefectiveRMA';

  // ------------------------------------------------------------ xml + zip
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const decodeEnt = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
  });
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const u8 = (s) => new TextEncoder().encode(s);
  const str = (b) => new TextDecoder().decode(b);
  // XML text with element prefixes dropped (PowerBI writes <x:row>, Excel writes <row>).
  const xml = (b) => str(b).replace(/^\uFEFF/, '').replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');

  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  // name → bytes for every file in a zip (central directory; stored or deflated entries).
  async function unzip(buf) {
    const b = new Uint8Array(buf), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This isn\'t an .xlsx file.');
    const n = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const files = {};
    for (let k = 0; k < n; k++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
      const name = str(b.subarray(p + 46, p + 46 + nlen));
      const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
      const data = b.subarray(start, start + csize);
      files[name] = method === 0 ? data : method === 8 ? data : null;
      if (method === 8) files[name] = await inflate(data);
      p += 46 + nlen + xlen + clen;
    }
    return files;
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(entries) { // [{ name, data: Uint8Array }] → Uint8Array, stored (no compression)
    const parts = [], central = [];
    let off = 0;
    for (const e of entries) {
      const name = u8(e.name), crc = crc32(e.data), len = e.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, len, true); lh.setUint32(22, len, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, len, true); ch.setUint32(24, len, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      parts.push(new Uint8Array(lh.buffer), name, e.data);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + len;
    }
    const csize = central.reduce((a, x) => a + x.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, off, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((a, x) => a + x.length, 0));
    let q = 0; for (const x of all) { out.set(x, q); q += x.length; }
    return out;
  }

  // ------------------------------------------------------------ xlsx read
  const colIndex = (ref) => { const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1; let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const textOf = (xml) => { let s = ''; xml.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g, (m, t) => { s += t ? decodeEnt(t) : ''; return m; }); return s; };
  // First sheet of an .xlsx → rows of cell values (strings, numbers, booleans, null).
  async function readXlsx(buf) {
    const f = await unzip(buf);
    const wb = f['xl/workbook.xml'] && xml(f['xl/workbook.xml']);
    if (!wb) throw new Error('This isn\'t an .xlsx file.');
    const rid = (/<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || /<sheet\b[^>]*\bid="([^"]+)"/.exec(wb) || [])[1];
    const rels = f['xl/_rels/workbook.xml.rels'] ? xml(f['xl/_rels/workbook.xml.rels']) : '';
    let target = null;
    rels.replace(/<Relationship\b([^>]*)\/?>/g, (m, a) => { if ((/\bId="([^"]+)"/.exec(a) || [])[1] === rid) target = (/\bTarget="([^"]+)"/.exec(a) || [])[1]; return m; });
    const path = target ? (target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')) : 'xl/worksheets/sheet1.xml';
    const sheet = f[path] || f['xl/worksheets/sheet1.xml'];
    if (!sheet) throw new Error('This file has no sheet.');
    const shared = [];
    if (f['xl/sharedStrings.xml']) xml(f['xl/sharedStrings.xml']).replace(/<si>([\s\S]*?)<\/si>|<si\/>/g, (m, x) => { shared.push(x ? textOf(x) : ''); return m; });
    const rows = [];
    xml(sheet).replace(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, (m, ra, body) => {
      const rn = Number((/\br="(\d+)"/.exec(ra) || [])[1]) || rows.length + 1;
      while (rows.length < rn - 1) rows.push([]);
      const row = [];
      (body || '').replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m2, ca, cb) => {
        const ci = colIndex((/\br="([A-Z]+\d+)"/.exec(ca) || [])[1]);
        const t = (/\bt="([^"]+)"/.exec(ca) || [])[1] || 'n';
        const vv = (/<v>([\s\S]*?)<\/v>/.exec(cb || '') || [])[1];
        let val = null;
        if (t === 's') val = vv != null ? shared[Number(vv)] : null;
        else if (t === 'inlineStr') val = textOf(cb || '');
        else if (t === 'str' || t === 'e') val = vv != null ? decodeEnt(vv) : null;
        else if (t === 'b') val = vv === '1';
        else if (vv != null && vv !== '') val = Number(vv);
        row[ci < 0 ? row.length : ci] = val;
        return m2;
      });
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
      rows.push(row);
      return m;
    });
    return rows;
  }
  // .csv → rows (a PowerBI export can be saved as CSV too).
  function readCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((v) => (v === '' ? null : /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v) ? Number(v) : v)));
  }

  // ------------------------------------------------------------ xlsx write
  const colName = (i) => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  // rows[0] is the header (bold); fills: array of 'ok' | 'bad' | 'warn' | null per data row.
  function writeXlsx(rows, fills, sheetName) {
    const STYLE = { head: 1, ok: 2, bad: 3, warn: 4 };
    const width = Math.max(...rows.map((r) => r.length));
    const widths = [];
    for (let c = 0; c < width; c++) widths.push(Math.min(Math.max(Math.max(...rows.map((r) => (r[c] == null ? 0 : String(r[c]).length))) + 2, 10), 50));
    const cell = (v, ref, s) => {
      const sa = s ? ' s="' + s + '"' : '';
      if (v == null || v === '') return s ? '<c r="' + ref + '"' + sa + '/>' : '';
      if (typeof v === 'number' && Number.isFinite(v)) return '<c r="' + ref + '"' + sa + '><v>' + v + '</v></c>';
      if (typeof v === 'boolean') return '<c r="' + ref + '"' + sa + ' t="b"><v>' + (v ? 1 : 0) + '</v></c>';
      return '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
    };
    const body = rows.map((r, i) => {
      const s = i === 0 ? STYLE.head : STYLE[fills[i - 1]] || 0;
      let x = '';
      for (let c = 0; c < width; c++) x += cell(r[c], colName(c) + (i + 1), s);
      return '<row r="' + (i + 1) + '">' + x + '</row>';
    }).join('');
    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>'
      + '<sheetData>' + body + '</sheetData></worksheet>';
    const fill = (rgb) => '<fill><patternFill patternType="solid"><fgColor rgb="FF' + rgb + '"/><bgColor rgb="FF' + rgb + '"/></patternFill></fill>';
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' + fill('C6EFCE') + fill('FFC7CE') + fill('FFEB9C') + '</fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      + '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>'
      + '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    return zip([
      { name: '[Content_Types].xml', data: u8(X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
      { name: '_rels/.rels', data: u8(X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: u8(X + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + xmlEsc(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: u8(X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
      { name: 'xl/styles.xml', data: u8(styles) },
      { name: 'xl/worksheets/sheet1.xml', data: u8(sheet) },
    ]);
  }

  // ------------------------------------------------------------ the list (scan_serials.py load_items / load_progress / save_progress)
  const normHeader = (h) => { h = String(h == null ? '' : h).trim(); const m = /\[([^\]]+)\]\s*$/.exec(h); if (m) h = m[1]; return h.trim().replace(/^['"]+|['"]+$/g, ''); };
  function findCol(headers, ...names) {
    const want = new Set(names.map((n) => n.toLowerCase()));
    for (let i = 0; i < headers.length; i++) {
      const hd = headers[i]; if (!hd) continue;
      if (want.has(String(hd).trim().toLowerCase()) || want.has(normHeader(hd).toLowerCase())) return i;
    }
    return null;
  }
  const unescapeHtml = (v) => (typeof v === 'string' ? decodeEnt(v) : v);
  const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
  const storeNum = (s) => (/#\s*(\d+)/.exec(String(s)) || /(\d+)\s*$/.exec(String(s)) || [])[1] || '';
  const stamp = (d = new Date()) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
  const blank = (it) => Object.assign(it, { scanned_serial: '', match: '', status: 'pending', scanned_at: '', backend_status: '', backend_message: '', backend_at: '' });
  const byDesc = (a, b) => { const x = String(a.description || '').trim().toLowerCase(), y = String(b.description || '').trim().toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };

  // rows → { kind: 'export' | 'results', headers, items } (items not yet filtered by store for an export)
  function parse(rows) {
    if (!rows.length) throw new Error('This file is empty.');
    let hi = 0;
    for (let i = 0; i < Math.min(rows.length, 15); i++) if (rows[i] && findCol(rows[i], 'Serial') !== null) { hi = i; break; }
    const headers = (rows[hi] || []).map((x) => (x == null ? '' : String(x).trim()));
    if (findCol(headers, 'Serial') === null) throw new Error('No Serial column in this file.');
    const data = rows.slice(hi + 1).filter((r) => r && r.some((v) => v != null && v !== ''));
    if (headers.includes('Scanned Serial')) {
      const idx = Object.fromEntries(Object.keys(FIELD).map((x) => [x, findCol(headers, x)]));
      const g = (r, n, d = '') => { const i = idx[n]; if (i == null || i >= r.length) return d; return r[i] == null ? d : r[i]; };
      const items = data.map((r) => {
        const it = {};
        for (const [hd, k] of Object.entries(FIELD)) it[k] = g(r, hd);
        it.serial = String(it.serial).trim();
        it.status = it.status || 'pending';
        return it;
      }).filter((it) => it.serial);
      return { kind: 'results', headers: headers.filter((x) => x && !RESULT_HEADERS.includes(x)), items };
    }
    const c = {
      store: findCol(headers, 'Store'), sku: findCol(headers, 'SKU'), desc: findCol(headers, 'Description'), serial: findCol(headers, 'Serial'),
      units: findCol(headers, 'Return Units'), value: findCol(headers, 'Return Value'), cons: findCol(headers, 'Consignment Status'), monty: findCol(headers, 'Monty Flag'),
    };
    const g = (r, i) => (i === null ? '' : r[i] == null ? '' : r[i]);
    const items = [];
    for (const r of data) {
      const serial = r[c.serial];
      if (serial == null || String(serial).trim() === '') continue;
      items.push(blank({
        store: unescapeHtml(g(r, c.store)), sku: g(r, c.sku), description: unescapeHtml(g(r, c.desc)), serial: String(serial).trim(),
        return_units: g(r, c.units), return_value: g(r, c.value), consignment_status: g(r, c.cons), monty_flag: g(r, c.monty),
      }));
    }
    return { kind: 'export', headers, items };
  }
  // [{ store, n }] for a store list, by store number.
  function stores(items) {
    const m = new Map();
    for (const it of items) { const s = String(it.store || ''); if (s) m.set(s, (m.get(s) || 0) + 1); }
    return [...m].map(([store, n]) => ({ store, n })).sort((a, b) => (Number(storeNum(a.store)) || 0) - (Number(storeNum(b.store)) || 0) || a.store.localeCompare(b.store));
  }
  const forStore = (items, store) => items.filter((it) => String(it.store) === store).sort(byDesc);
  const fillOf = (it) => (it.status === 'matched' && it.backend_status !== 'skipped-already-marked' ? 'ok'
    : it.status === 'mismatch' ? 'bad'
      : it.status === 'overridden' || it.status === 'skipped' || it.backend_status === 'skipped-already-marked' ? 'warn' : null);
  function results(headers, items) {
    const base = headers.filter(Boolean);
    const out = base.concat(RESULT_HEADERS.filter((x) => !base.includes(x)));
    const rows = [out].concat(items.map((it) => out.map((x) => { const v = it[FIELD[x] || FIELD[normHeader(x)]]; return v == null ? '' : v; })));
    return writeXlsx(rows, items.map(fillOf), 'Scan Results');
  }
  function fileName(source, store) {
    const base = String(source || 'Pullback Serials.xlsx').replace(/\.[^.]+$/, '').replace(/( - \d+)? - Scan Results$/, '');
    const n = storeNum(store);
    return base + (n ? ' - ' + n : '') + ' - Scan Results.xlsx';
  }
  // Scanned (matched/overridden) but not marked in Portal yet.
  const unmarked = (it) => (it.status === 'matched' || it.status === 'overridden') && it.backend_status !== 'success' && it.backend_status !== 'skipped-already-marked';
  const counts = (items) => {
    const c = { total: items.length, matched: 0, overridden: 0, skipped: 0, pending: 0, already: 0, failed: 0 };
    for (const it of items) {
      if (c[it.status] != null) c[it.status]++;
      if (it.backend_status === 'skipped-already-marked') c.already++;
      if (it.backend_status === 'failed') c.failed++;
    }
    return c;
  };

  // ------------------------------------------------------------ Portal
  async function call(method, path, body) {
    const init = { method, credentials: 'include', headers: { accept: 'application/json' } };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    let res, text;
    try { ({ res, text } = await AE.timedFetch(method, path, init, 20000)); }
    catch (e) { return { status: 0, error: (e && e.message) || 'network error' }; }
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
    if (res.status === 401) AE.signedOut();
    return { status: res.status, text, json, html: /^\s*<!doctype html/i.test(text) };
  }
  // → { ok, already, message }
  async function mark(sku, serial, storeId) {
    const r = await call('POST', '/api/boh/inventory/' + encodeURIComponent(serial) + '/mark-defective-broken',
      { serial, reasonCode: REASON_CODE, reasonDetails: REASON_DETAILS, brokenBy: '' });
    if (r.status === 200 && r.json && r.json.Success === true) return { ok: true, message: 'confirmed' };
    if (r.status === 500 && storeId != null) {
      const q = await call('GET', '/api/boh/store-products/' + encodeURIComponent(sku) + '/inventory?pageSize=20&page=1&searchTerm=' + encodeURIComponent(serial) + '&warehouseId=' + encodeURIComponent(storeId + 'Q'));
      const hit = q.status === 200 && q.json && Array.isArray(q.json.value) ? q.json.value.find((e) => e && norm(e.SerialNumber) === norm(serial)) : null;
      if (hit && hit.SerialStatus === ALREADY) return { ok: true, already: true, message: 'Mark call returned 500; status check confirmed SerialStatus=' + ALREADY + ' — already marked for pullback' };
    }
    if (r.status === 0) return { ok: false, message: 'network error: ' + r.error };
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'status ' + r.status + ' — Portal session expired, log in again' };
    if (r.status === 200 && r.html) return { ok: false, message: 'status 200 but got a page back, not data' };
    if (r.status === 200) return { ok: false, message: 'backend reported failure: ' + ((r.json && r.json.ErrorMessage) || String(r.text).slice(0, 200)) };
    return { ok: false, message: 'status ' + r.status + (r.text ? ': ' + String(r.text).slice(0, 200) : '') };
  }

  return { RESULT_HEADERS, readXlsx, readCsv, writeXlsx, unzip, parse, stores, forStore, results, fileName, unmarked, counts, mark, norm, storeNum, stamp, blank, fillOf };
})();

AE.shard({
  id: 'pullbacks',
  name: 'Elusive Jump',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE, P = AE.pullbacks;
    const DLG = 'ae-pullbacks', MENU = 'option-aethernet-pullbacks', TILE = 'ae-pullbacks-tile', KEY = 'ae_pullback_session';
    const icon = (size) => h('span', { html: AE.actionIcon('pullbacks', size), style: 'line-height:0;flex:none' });
    document.head.append(h('style', null, `
      #${DLG} .sg-about.pb { width:min(640px, 100%); padding:22px 26px 18px; max-height:calc(100vh - 32px); overflow:auto; }
      #${DLG} .hd { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
      #${DLG} .hd h2 { margin:0; font-size:22px; font-weight:700; }
      #${DLG} .hd .chip { height:24px; padding:0 10px; border-radius:12px; font-size:12px; font-weight:700; display:inline-flex; align-items:center;
        background:var(--aui-primary-soft, #faecff); color:var(--aui-primary, #8223d2); }
      #${DLG} .hd .chip[hidden] { display:none; }
      #${DLG} .hd .sg-x { margin-left:auto; }
      #${DLG} .box { border:1px solid var(--aui-outline, #d9d9de); border-radius:12px; padding:16px; margin-bottom:12px; }
      #${DLG} .drop { display:block; border:2px dashed var(--aui-outline, #c6c6ca); border-radius:12px; padding:30px 16px; text-align:center; cursor:pointer;
        font-weight:700; color:var(--aui-primary, #8223d2); }
      #${DLG} .drop.over { border-color:var(--aui-primary, #8223d2); background:var(--aui-primary-soft, #faecff); }
      #${DLG} .line { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      #${DLG} .line .g { flex:1; min-width:0; }
      #${DLG} .soft { color:var(--aui-on-surface-soft, #5d5e61); font-size:13px; }
      #${DLG} .stats { display:flex; gap:16px; font-weight:700; font-size:13px; margin-bottom:8px; }
      #${DLG} .stats .r { color:var(--aui-primary, #8223d2); } #${DLG} .stats .d { color:var(--aui-status-success, #136d31); }
      #${DLG} .stats .o { color:var(--aui-on-surface-soft, #5d5e61); margin-left:auto; }
      #${DLG} .bar { height:6px; border-radius:3px; background:var(--aui-neutral-soft, #e3e2e7); overflow:hidden; margin-bottom:14px; }
      #${DLG} .bar > b { display:block; height:100%; background:var(--aui-primary, #8223d2); transition:width .2s; }
      #${DLG} dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:0 0 10px; }
      #${DLG} dt { color:var(--aui-on-surface-soft, #5d5e61); } #${DLG} dd { margin:0; font-weight:700; overflow-wrap:anywhere; }
      #${DLG} .exp { font:700 22px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--aui-primary, #8223d2); margin-bottom:10px; overflow-wrap:anywhere; }
      #${DLG} input.scan { width:100%; height:44px; box-sizing:border-box; border:2px solid var(--aui-outline, #c6c6ca); border-radius:10px; padding:0 12px;
        font:600 16px ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); text-transform:uppercase; }
      #${DLG} input.scan:focus { outline:none; border-color:var(--aui-primary, #8223d2); }
      #${DLG} .msg { border-radius:10px; padding:10px 12px; margin-top:10px; font-weight:700; }
      #${DLG} .msg code { display:block; font:600 14px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap:anywhere; }
      #${DLG} .msg.bad { background:var(--aui-status-error-soft, #ffdad7); color:var(--aui-status-error, #b91a24); }
      #${DLG} .msg.ok { background:var(--aui-status-success-soft, #c5ffc8); color:var(--aui-status-success, #136d31); }
      #${DLG} .msg.warn { background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-warning, #3d2e00); }
      #${DLG} .acts { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
      #${DLG} .next { color:var(--aui-on-surface-soft, #5d5e61); font-size:13px; overflow-wrap:anywhere; }
      #${DLG} .next b { color:var(--aui-on-surface, #1a1c1e); }
      #${DLG} .sum { display:grid; grid-template-columns:1fr auto; gap:6px 12px; margin-bottom:6px; }
      #${DLG} .sum span:nth-child(even) { font-weight:700; text-align:right; }
      #${DLG} .stores { display:grid; gap:8px; }
      #${DLG} .stores .sg-btn { justify-content:space-between; height:40px; border-radius:10px; }
      #${DLG} .err { color:var(--aui-status-error, #b91a24); font-weight:700; margin-top:10px; }
    `));

    const load = () => { try { const s = GM_getValue(KEY, null); return s && Array.isArray(s.items) ? s : null; } catch (_) { return null; } };
    const save = (s) => { try { GM_setValue(KEY, s); } catch (_) {} };
    const drop = () => { try { GM_deleteValue(KEY); } catch (_) {} };

    let S = null;   // { file, store, storeId, headers, items, idx, history, last }
    let ui = null;  // { scrim, body, close }
    let run = 0;    // bumps when the dialog closes, stopping a batch mark

    function download() {
      const bytes = P.results(S.headers, S.items);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = h('a', { href: url, download: P.fileName(S.file, S.store) });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    const firstPending = () => { const i = S.items.findIndex((x) => x.status === 'pending'); return i < 0 ? null : i; };
    const nextPending = (from) => { const n = S.items.length; for (let o = 1; o <= n; o++) { const j = (from + o) % n; if (S.items[j].status === 'pending') return j; } return null; };
    const btn = (label, onclick, primary, disabled) => h('button', { type: 'button', class: 'sg-btn' + (primary ? ' sg-primary' : ''), onclick, disabled: !!disabled }, label);

    function open() {
      if (document.getElementById(DLG)) return;
      AE.track('pullbacks');
      AE.ensureModalCss(); // the dialog styles live with Settings' dialogs
      const body = h('div');
      const chip = h('span', { class: 'chip', hidden: true });
      const hd = h('div', { class: 'hd ae-head' }, icon(32), h('h2', null, 'Pullbacks'), chip, h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕'));
      const card = h('div', { class: 'sg sg-card sg-about pb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Pullbacks' }, hd, body);
      const scrim = h('div', { class: 'sg sg-about-scrim', id: DLG, onclick: (e) => { if (e.target === scrim && !busy) close(); } }, card);
      const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); close(); } };
      function close() { run++; scrim.remove(); document.removeEventListener('keydown', onKey, true); ui = null; }
      document.addEventListener('keydown', onKey, true);
      document.body.append(scrim);
      ui = { scrim, body, chip, close };
      S = load();
      if (S) { S.history = S.history || []; showStart(); } else showStart();
    }
    let busy = false, msg = null;
    const setChip = () => { if (!ui) return; const n = S && P.storeNum(S.store); ui.chip.hidden = !n; ui.chip.textContent = n ? '#' + n : ''; };
    const paint = (...kids) => { if (!ui) return; ui.body.replaceChildren(...kids); setChip(); };

    // ---------------------------------------------------------- upload
    function showStart(error) {
      const input = h('input', { type: 'file', accept: '.xlsx,.csv', hidden: true, onchange: () => { const f = input.files[0]; input.value = ''; if (f) take(f); } });
      const zone = h('label', { class: 'drop' }, 'Upload PowerBI export or Linkpearl results', input);
      zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
      zone.ondragleave = () => zone.classList.remove('over');
      zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) take(f); };
      const kids = [h('div', { class: 'box' }, zone, error ? h('div', { class: 'err' }, error) : null)];
      const saved = S || load();
      if (saved) {
        const c = P.counts(saved.items);
        kids.push(h('div', { class: 'box' }, h('div', { class: 'line' },
          h('div', { class: 'g' }, h('b', null, saved.file || 'Pullback Serials.xlsx'), h('div', { class: 'soft' }, '#' + (P.storeNum(saved.store) || saved.store) + ' · ' + (c.total - c.pending) + ' of ' + c.total)),
          btn('Resume', () => { S = saved; S.history = S.history || []; resume(); }, true),
          btn('Discard', () => { drop(); S = null; showStart(); }))));
      }
      S = null; paint(...kids);
    }
    async function take(f) {
      let parsed;
      try {
        const rows = /\.csv$/i.test(f.name) ? P.readCsv(await f.text()) : await P.readXlsx(await f.arrayBuffer());
        parsed = P.parse(rows);
      } catch (e) { return showStart((e && e.message) || 'Couldn\'t read this file.'); }
      let me = null;
      try { me = await AE.profile(); } catch (_) {}
      const storeId = me && me.storeId != null ? String(me.storeId) : '';
      if (parsed.kind === 'results') {
        const theirs = P.stores(parsed.items).map((x) => x.store);
        const store = theirs[0] || '';
        if (storeId && theirs.some((s) => P.storeNum(s) && P.storeNum(s) !== storeId)) return showStart('This file is for #' + theirs.map(P.storeNum).filter((n) => n !== storeId).join(', #') + '. Portal is on #' + storeId + '.');
        S = { file: f.name, store, storeId, headers: parsed.headers, items: parsed.items, idx: 0, history: [], last: null };
        save(S); return resume();
      }
      const all = parsed.items, list = P.stores(all);
      const mine = list.find((x) => P.storeNum(x.store) === storeId);
      const begin = (store) => {
        S = { file: f.name, store, storeId: storeId || P.storeNum(store), headers: parsed.headers, items: P.forStore(all, store), idx: 0, history: [], last: null };
        save(S); resume();
      };
      if (!list.length) { S = { file: f.name, store: '', storeId, headers: parsed.headers, items: all, idx: 0, history: [], last: null }; save(S); return resume(); }
      if (mine) return begin(mine.store);
      paint(h('div', { class: 'box' }, h('div', { class: 'stores' },
        list.map((x) => h('button', { type: 'button', class: 'sg-btn', onclick: () => begin(x.store) }, h('span', null, x.store), h('span', { class: 'soft' }, String(x.n)))))));
    }

    // ---------------------------------------------------------- resume: mark what's scanned, then scan the rest
    async function resume() {
      msg = null;
      if (S.items.some(P.unmarked)) return batch();
      S.idx = firstPending();
      return S.idx == null ? showDone() : showScan();
    }
    async function batch() {
      const me = ++run;
      let paused = false;
      const todo = S.items.filter(P.unmarked);
      const stats = h('div', { class: 'stats' }), bar = h('b', { style: 'width:0' });
      const pause = btn('Pause', () => { paused = true; pause.disabled = true; });
      paint(h('div', { class: 'box' }, h('b', null, S.file), h('div', { class: 'bar', style: 'margin-top:10px' }, bar), stats, h('div', { class: 'acts' }, pause)));
      let done = 0;
      const draw = () => { stats.replaceChildren(h('span', { class: 'r' }, (todo.length - done) + ' to mark'), h('span', { class: 'd' }, done + ' marked'), h('span', { class: 'o' }, String(todo.length))); bar.style.width = (done / todo.length * 100) + '%'; };
      draw();
      busy = true;
      try {
        for (const it of todo) {
          if (me !== run) return;
          if (paused) break;
          const r = await P.mark(it.sku, it.scanned_serial || it.serial, S.storeId);
          Object.assign(it, r.ok ? { backend_status: r.already ? 'skipped-already-marked' : 'success', backend_message: r.message, backend_at: P.stamp() }
            : { backend_status: 'failed', backend_message: r.message });
          done++; save(S); draw();
          if (/session expired/.test(r.message)) break;
        }
      } finally { busy = false; }
      if (me !== run) return;
      S.idx = firstPending();
      if (paused || S.idx == null) return showDone();
      showScan();
    }

    // ---------------------------------------------------------- scanning
    function showScan() {
      const it = S.items[S.idx], c = P.counts(S.items);
      const done = c.matched + c.overridden;
      const input = h('input', { class: 'scan', placeholder: 'Scan serial', autocomplete: 'off', spellcheck: 'false', disabled: busy });
      const form = h('form', { onsubmit: (e) => { e.preventDefault(); onScan(input.value); } }, input);
      const acts = [];
      if (msg && msg.kind === 'mismatch') acts.push(btn('Accept anyway', () => accept(S.last, true), false, busy));
      if (msg && msg.kind === 'fail') acts.push(btn('Retry', () => accept(S.last, P.norm(S.last) !== P.norm(it.serial)), true, busy), btn('Already marked', () => already(), false, busy));
      acts.push(btn('Skip', () => skip(), false, busy), btn('Undo', () => undo(), false, busy || !S.history.length));
      const nj = nextPending(S.idx), nx = nj != null && nj !== S.idx ? S.items[nj] : null;
      paint(
        h('div', { class: 'box' },
          h('div', { class: 'stats' }, h('span', { class: 'r' }, c.pending + ' remaining'), h('span', { class: 'd' }, done + ' done'), h('span', { class: 'o' }, (S.idx + 1) + ' / ' + c.total)),
          h('div', { class: 'bar' }, h('b', { style: 'width:' + ((c.total - c.pending) / c.total * 100) + '%' })),
          h('dl', null, h('dt', null, 'SKU'), h('dd', null, String(it.sku)), h('dt', null, 'Description'), h('dd', null, String(it.description))),
          h('div', { class: 'exp' }, it.serial),
          form,
          busy ? h('div', { class: 'msg warn' }, 'Marking…')
            : msg ? h('div', { class: 'msg ' + (msg.kind === 'ok' ? 'ok' : msg.kind === 'warn' ? 'warn' : 'bad') }, msg.title, msg.code ? h('code', null, msg.code) : null) : null,
          h('div', { class: 'acts' }, acts)),
        h('div', { class: 'line' },
          h('div', { class: 'next g' }, nx ? ['Next ', h('b', null, String(nx.sku)), ' · ' + nx.description + ' · …' + String(nx.serial).slice(-6)] : 'Last item'),
          btn('Download results', download)));
      if (!busy) setTimeout(() => input.focus(), 0);
    }
    function showDone() {
      const c = P.counts(S.items);
      const rows = [['Total items', c.total], ['Matched', c.matched], ['Overridden', c.overridden]];
      if (c.already) rows.push(['Already marked', c.already]);
      rows.push(['Skipped', c.skipped]);
      if (c.pending) rows.push(['Not scanned', c.pending]);
      const failed = S.items.filter((x) => x.backend_status === 'failed' && (x.status === 'matched' || x.status === 'overridden')).length;
      if (failed) rows.push(['Not marked', failed]);
      paint(h('div', { class: 'box' },
        h('h2', { style: 'font-size:16px;margin:0 0 10px' }, c.pending ? 'Paused' : 'Scan complete'),
        h('div', { class: 'sum' }, rows.map(([k, v]) => [h('span', null, k), h('span', null, String(v))])),
        h('div', { class: 'acts' },
          btn('Download results', download, true),
          failed ? btn('Retry marking', () => batch()) : null,
          c.pending ? btn('Resume', () => resume()) : null,
          c.skipped ? btn('Scan skipped', () => { S.items.forEach((x) => { if (x.status === 'skipped') x.status = 'pending'; }); S.history = []; save(S); resume(); }) : null)),
      h('div', { class: 'line' }, h('div', { class: 'g' }), btn('New file', () => { drop(); S = null; showStart(); })));
    }

    function advance() {
      S.history.push(S.idx); S.last = null;
      const nj = nextPending(S.idx);
      save(S);
      if (nj == null) return showDone();
      S.idx = nj; showScan();
    }
    function onScan(raw) {
      if (busy) return;
      const v = String(raw || '').trim();
      if (!v) { msg = { kind: 'warn', title: 'Empty scan' }; return showScan(); }
      S.last = v;
      if (P.norm(v) === P.norm(S.items[S.idx].serial)) return accept(v, false);
      msg = { kind: 'mismatch', title: 'Mismatch', code: v };
      save(S); showScan();
    }
    async function accept(scanned, override) {
      if (busy || !scanned) return;
      const it = S.items[S.idx], me = run;
      busy = true; showScan();
      let r;
      try { r = await P.mark(it.sku, scanned, S.storeId); } finally { busy = false; }
      if (me !== run) return;
      if (!r.ok) {
        Object.assign(it, { backend_status: 'failed', backend_message: r.message });
        msg = { kind: 'fail', title: 'Couldn\'t mark in Portal', code: r.message };
        save(S); return showScan();
      }
      Object.assign(it, { status: override ? 'overridden' : 'matched', scanned_serial: scanned, match: override ? 'OVERRIDE' : 'YES', scanned_at: P.stamp(),
        backend_status: r.already ? 'skipped-already-marked' : 'success', backend_message: r.message, backend_at: P.stamp() });
      msg = { kind: 'ok', title: r.already ? 'Already marked' : 'Marked' };
      advance();
    }
    function already() {
      const it = S.items[S.idx], v = S.last;
      if (!v) return;
      const match = P.norm(v) === P.norm(it.serial), prior = it.backend_message;
      Object.assign(it, { status: match ? 'matched' : 'overridden', scanned_serial: v, match: match ? 'YES' : 'OVERRIDE', scanned_at: P.stamp(), backend_status: 'skipped-already-marked',
        backend_message: prior ? 'Operator confirmed already marked (backend call skipped). Prior attempt: ' + prior : 'Operator confirmed already marked — backend call skipped', backend_at: P.stamp() });
      msg = { kind: 'ok', title: 'Already marked' };
      advance();
    }
    function skip() { P.blank(S.items[S.idx]).status = 'skipped'; msg = null; advance(); }
    function undo() {
      if (!S.history.length) return;
      const j = S.history.pop();
      P.blank(S.items[j]); S.idx = j; S.last = null;
      msg = { kind: 'warn', title: 'Reverted' };
      save(S); showScan();
    }

    // ---------------------------------------------------------- entry points
    const menuItem = () => AE.avatarItem({ testid: MENU, label: 'Pullbacks', order: 35, icon: (s) => AE.actionIcon('pullbacks', s), onClick: () => open() });
    // A Pullbacks tile on the Inventory hub: a copy of Portal's Inventory Count tile (<a class="cards-link"> around a simple-card),
    // its text swapped, its link dropped, added after the hub's last tile.
    function placeTile() {
      if (location.pathname.replace(/\/+$/, '') !== '/boh/inventory' || document.getElementById(TILE)) return;
      const label = [...document.querySelectorAll('main [data-aui="text"], main span, main p, main h3, main h4')]
        .find((el) => el.children.length === 0 && /^inventory count$/i.test(el.textContent.trim()));
      if (!label) return;
      let tile = label.closest('a.cards-link, a[href]');
      if (!tile) { tile = label; while (tile.parentElement && tile.parentElement.children.length < 3 && tile.parentElement !== document.body) tile = tile.parentElement; }
      if (!tile.parentElement || tile.parentElement === document.body) return;
      const copy = tile.cloneNode(true);
      copy.id = TILE;
      copy.removeAttribute('href');
      copy.querySelectorAll('[href]').forEach((a) => a.removeAttribute('href'));
      copy.setAttribute('role', 'button');
      copy.tabIndex = 0;
      const text = [...copy.querySelectorAll('*')].concat(copy).find((el) => el.children.length === 0 && /^inventory count$/i.test(el.textContent.trim()));
      if (text) text.textContent = 'Pullbacks';
      // Portal's barcode icon stays until the shard has its own.
      const art = AE.actionIcon('pullbacks', 28);
      const own = copy.querySelector('[data-aui="icon"].icon, svg');
      if (art && own) own.replaceWith(icon(28));
      copy.style.cursor = 'pointer';
      const go = (e) => { e.preventDefault(); e.stopPropagation(); open(); };
      copy.addEventListener('click', go, true);
      copy.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
      tile.parentElement.append(copy);
    }
    AE.onDom(() => { menuItem(); placeTile(); });
    AE.every(1500, () => { menuItem(); placeTile(); });
  },
});
