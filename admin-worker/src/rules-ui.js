// Admin site: the Assize rules editor (page 'rules'). Served at /rules-ui.js and loaded by page.js when the tab opens.
// Rules as node graphs, Blueprint style: a rule list, a hand-rolled canvas (HTML nodes, SVG wires; no library, the
// page's CSP stays tight) and an inspector. Graphs run here, in the browser, with the same interpreter (rulegraph.js)
// and rules engine (assize-rules.js) Assize runs, on the store's open orders from the tracker. Notes come from the
// sealed snapshots, opened with the person's own key copy (tracker-ui.js: one unlock opens both pages).
// The server checks every save, publish and scope (tracker-worker/src/assize.js); this page only keeps the buttons honest.
import * as RG from '/rulegraph.js';
import { makeRules, fromSnapshot } from '/assize-rules.js';
import * as TK from '/tracker-ui.js';

const R = makeRules({ RG });
const CHECK_NAME = Object.fromEntries(R.CHECKS);

const STYLE = `
.rx{--muted:#7c7b80;--grid:#dedce4;--canvas:#f1f0f4;--exec:#3a3940;--run:#8223d2;--errs:#fde8eb;--yes:#0b7f2a;--yess:#dff7e3;--no:#6c6b71;--nos:#efeef2;
  --c-fact:#2a78d6;--c-check:#6250d6;--c-logic:#6c6b71;--c-assize:#8223d2;--c-text:#b8336f;--c-num:#0b7f57;--c-out:#b97700;
  --t-bool:#d03b3b;--t-num:#14a06d;--t-text:#d9549a;--t-lines:#2a78d6;--t-notes:#0f8fa3;--t-textList:#6a5bd6;--t-person:#c77700;--t-any:#8b8a90;
  --shadow:0 1px 2px rgba(20,10,40,.06),0 4px 14px rgba(20,10,40,.07)}
@media (prefers-color-scheme:dark){.rx{--muted:#8b8a90;--grid:#2a292f;--canvas:#17161a;--exec:#e6e6ea;--run:#b88af2;--errs:#3a1a20;--yes:#5fd27a;--yess:#16361d;--no:#9a99a0;--nos:#26252a;--err:#ef6b7e;
  --c-fact:#4b93ea;--c-check:#8d80ee;--c-logic:#8b8a90;--c-assize:#a66cf0;--c-text:#e0679e;--c-num:#2fbf88;--c-out:#e0a020;
  --t-bool:#ef6b6b;--t-num:#2fbf88;--t-text:#ec7ab5;--t-lines:#4b93ea;--t-notes:#34b7c9;--t-textList:#9a8ff0;--t-person:#e8a33a;--t-any:#8b8a90;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 6px 18px rgba(0,0,0,.35)}}
.rx [hidden]{display:none!important}
.rx-app{display:grid;grid-template-columns:250px minmax(0,1fr) 340px;gap:12px;align-items:start}
.rx-panel{background:var(--card);border:1px solid var(--line);border-radius:12px;min-width:0}
.rx-phd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--hd);border-radius:12px 12px 0 0}
.rx-phd h3{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);font-weight:700}
.rx .sm{font-size:12px} .rx .mut{color:var(--soft)}
.rx .btn{height:32px;font-size:13px;border-color:var(--line);white-space:nowrap} .rx .btn:hover:not(:disabled){border-color:var(--soft)} .rx .btn.p:hover:not(:disabled){filter:brightness(1.08)}
.rx .btn.sm{height:28px;padding:0 11px;font-size:12px} .rx .btn.dg{color:var(--err)}
.rx .pill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;background:var(--nos);color:var(--soft)}
.rx .pill.graph{background:var(--ps);color:var(--pt)} .rx .pill.draft{background:var(--warn);color:var(--warnf)} .rx .pill.off{background:var(--errs);color:var(--err)} .rx .pill.built{background:#e6f0fb;color:#1d4f8f}
.rx .pill.fail{background:var(--errs);color:var(--err)} .rx .pill.flag{background:var(--warn);color:var(--warnf)} .rx .pill.note{background:var(--ps);color:var(--pt)} .rx .pill.remind{background:#e6f0fb;color:#1d4f8f}
.rx .pill.st{height:18px;padding:0 6px;font-size:10.5px;border:1px solid var(--line);background:var(--card)} .rx .pill.st.dr{border-color:#d3b64d}
@media (prefers-color-scheme:dark){.rx .pill.built,.rx .pill.remind{background:#13294a;color:#b7d3f6}}
.rx input[type=text],.rx input[type=number],.rx select{height:32px;padding:0 9px;font-size:13px;max-width:100%}
/* rule list */
.rx-srch{padding:10px 12px 4px;display:flex;gap:6px} .rx-srch input{flex:1;min-width:0}
.rx-rules{max-height:calc(100vh - 210px);overflow:auto;padding-bottom:8px}
.rx-grp{padding:8px 0 2px} .rx-grp>b{display:block;padding:4px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.rx-rule{display:flex;align-items:center;gap:6px;width:100%;border:0;background:none;color:var(--fg);text-align:left;padding:6px 12px 6px 14px;cursor:pointer;font:inherit;font-size:13px}
.rx-rule:hover{background:var(--hd)} .rx-rule.on{background:var(--ps);color:var(--pt);font-weight:700} .rx-rule>span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rx-new{display:grid;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--hd)} .rx-new .row{display:flex;gap:6px}
/* editor */
.rx-ehd{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 14px;border-bottom:1px solid var(--line)}
.rx-crumb{font-size:12px;color:var(--soft)} .rx-ehd h2{margin:0;font-size:18px;text-wrap:balance}
.rx-acts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.rx-scope{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--line);font-size:13px}
.rx-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;flex-wrap:wrap} .rx-seg button{border:0;border-right:1px solid var(--line);background:var(--card);color:var(--fg);padding:5px 11px;font:inherit;font-size:12.5px;cursor:pointer} .rx-seg button:last-child{border-right:0} .rx-seg button.on{background:var(--ps);color:var(--pt);font-weight:700} .rx-seg button:disabled{opacity:.5;cursor:not-allowed}
.rx-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--warn);color:var(--warnf);font-size:13px} .rx-bar>span{flex:1 1 260px} .rx-bar input{flex:1 1 200px} .rx-bar.info{background:var(--ps);color:var(--fg)} .rx-bar.bad{background:var(--errs);color:var(--fg)}
.rx-dbg{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--hd)}
.rx-dbg label.l{font-size:12.5px;color:var(--soft)} .rx-dbg select{max-width:100%} .rx-dbg .ord{flex:1 1 220px;min-width:0}
.rx-tg{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;user-select:none} .rx-tg input{position:absolute;opacity:0;width:1px;height:1px}
.rx-tg i{width:30px;height:18px;border-radius:9px;background:var(--line);position:relative;transition:background .15s;flex:none} .rx-tg i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}
.rx-tg input:checked+i{background:var(--p)} .rx-tg input:checked+i::after{left:14px} .rx-tg input:focus-visible+i{outline:2px solid var(--p);outline-offset:2px}
.rx-play{display:inline-flex;gap:4px} .rx-play button{height:30px;min-width:32px;padding:0 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);cursor:pointer;font-size:13px} .rx-play button:disabled{opacity:.4;cursor:not-allowed}
.rx-out{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 14px;border-bottom:1px solid var(--line);font-size:13px} .rx-out .t{font-weight:700} .rx-out .ev{min-width:0;overflow-wrap:anywhere}
.rx-steps{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 14px 8px;border-bottom:1px solid var(--line);font-size:12px}
.rx-steps button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:2px 9px;font:inherit;font-size:12px;cursor:pointer} .rx-steps button.on{background:var(--run);border-color:var(--run);color:#fff} .rx-steps button.past{border-color:var(--run);color:var(--run)} .rx-steps i{font-style:normal;color:var(--muted)}
.rx-note{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--line);font-size:12.5px;background:var(--warn);color:var(--warnf)} .rx-note.info{background:var(--ps);color:var(--fg)}
.rx-stage{position:relative;height:max(480px,calc(100vh - 330px));overflow:hidden;background:var(--canvas);background-image:radial-gradient(var(--grid) 1.2px,transparent 1.3px);background-size:22px 22px;border-radius:0 0 12px 12px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
.rx-stage.pan{cursor:grabbing} .rx-stage.boxing{cursor:crosshair}
.rx-world{position:absolute;left:0;top:0;transform-origin:0 0}
.rx-wires{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.rx-wires .hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
.rx-wires .w{fill:none;transition:stroke-opacity .2s} .rx-wires .w.x{stroke:var(--exec)} .rx-wires .w.dim{stroke-opacity:.22} .rx-wires .w.run{stroke:var(--run)} .rx-wires .w.sel{filter:drop-shadow(0 0 3px var(--p))} .rx-wires .w.bad{stroke:var(--err);stroke-dasharray:6 5}
.rx-wires .wl rect{fill:var(--card);stroke:var(--line)} .rx-wires .wl text{font:10.5px ui-monospace,Menlo,monospace;fill:var(--fg)} .rx-wires .wl.t text{fill:var(--yes);font-weight:700} .rx-wires .wl.f text{fill:var(--no);font-weight:700} .rx-wires .wl.dim{opacity:.45}
.rx-wires .no circle{fill:var(--run)} .rx-wires .no text{font:700 10.5px Apercu,Helvetica,Arial,sans-serif;fill:#fff}
.rx-wires .tmp{fill:none;stroke-width:2.4;stroke-dasharray:6 4}
.rx-box{position:absolute;border:1px dashed var(--p);background:color-mix(in srgb,var(--p) 10%,transparent);pointer-events:none;z-index:4}
.rx-tools{position:absolute;right:10px;top:10px;display:flex;gap:6px;z-index:5;flex-wrap:wrap;justify-content:flex-end;max-width:calc(100% - 20px)}
.rx-tools button{height:30px;min-width:30px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);cursor:pointer;font-size:13px;font-weight:700;box-shadow:var(--shadow)} .rx-tools button.on{background:var(--ps);color:var(--pt);border-color:var(--p)} .rx-tools button:disabled{opacity:.45;cursor:not-allowed}
.rx-crumbs{position:absolute;left:10px;top:10px;z-index:5;display:flex;align-items:center;gap:6px;padding:4px 10px;background:var(--card);border:1px solid var(--line);border-radius:8px;font-size:12.5px;box-shadow:var(--shadow);max-width:calc(100% - 20px);flex-wrap:wrap}
.rx-crumbs button{border:0;background:none;color:var(--p);font:inherit;font-weight:700;cursor:pointer;padding:2px 0}
.rx-legend{position:absolute;left:10px;bottom:10px;z-index:5;display:flex;flex-wrap:wrap;gap:4px 12px;padding:6px 10px;background:var(--card);border:1px solid var(--line);border-radius:8px;font-size:11.5px;color:var(--soft);max-width:calc(100% - 20px)}
.rx-legend span{display:inline-flex;align-items:center;gap:5px} .rx-legend i{width:9px;height:9px;border-radius:50%} .rx-legend i.x{width:12px;height:4px;border-radius:2px;background:var(--exec)}
.rx-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:3} .rx-hint>div{pointer-events:auto;max-width:360px;text-align:center;background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:16px 18px;font-size:13px;color:var(--soft)} .rx-hint b{display:block;color:var(--fg);font-size:14px;margin-bottom:4px}
.rx-pal{position:absolute;z-index:7;width:270px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:6px;max-height:min(460px,calc(100% - 20px));display:flex;flex-direction:column}
.rx-pal input{width:100%;margin-bottom:4px} .rx-pal .ls{overflow:auto;min-height:0}
.rx-pal b{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:8px 8px 2px}
.rx-pal button{display:flex;align-items:flex-start;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:none;color:var(--fg);font:inherit;font-size:13px;text-align:left;cursor:pointer} .rx-pal button:hover,.rx-pal button:focus-visible{background:var(--hd)} .rx-pal button i{width:8px;height:8px;border-radius:2px;flex:none;margin-top:5px} .rx-pal button small{display:block;font-size:11px;color:var(--soft);line-height:1.3}
/* nodes */
.rx-node{position:absolute;width:224px;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);font-size:12px;cursor:default;transition:opacity .2s}
.rx-node.wide{width:264px}
.rx-node.sel{z-index:3;border-color:var(--p);box-shadow:0 0 0 2px var(--p),var(--shadow)}
.rx-node.s-ran{border-color:var(--run);box-shadow:0 0 0 1.5px var(--run),var(--shadow)} .rx-node.s-ran.sel{box-shadow:0 0 0 2.5px var(--p),var(--shadow)}
.rx-node.s-idle{opacity:.5} .rx-node.s-notReached{opacity:.5;border-style:dashed;border-color:var(--muted)} .rx-node.s-pending{opacity:.45}
.rx-node.s-error{border-color:var(--err);box-shadow:0 0 0 2px var(--err),var(--shadow)} .rx-node.bad .nh{background:var(--errs)}
.rx-node.cur{animation:rxpulse 1s ease-in-out infinite}
@keyframes rxpulse{0%,100%{box-shadow:0 0 0 2px var(--run),var(--shadow)}50%{box-shadow:0 0 0 7px color-mix(in srgb,var(--run) 30%,transparent),var(--shadow)}}
.rx-node .nh{display:flex;align-items:center;gap:7px;padding:6px 9px 6px 10px;border-radius:9px 9px 0 0;border-bottom:1px solid var(--line);cursor:move;background:var(--hd);position:relative}
.rx-node .nh i.c{width:4px;align-self:stretch;border-radius:3px;flex:none;margin:-2px 0}
.rx-node .nh b{font-size:12.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .rx-node .nh small{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
.rx-node .nh input{flex:1;min-width:0;height:22px;font-size:12.5px;font-weight:700;padding:0 4px}
.rx-node .nb{padding:4px 0 6px}
.rx-node .rw{position:relative;display:flex;align-items:center;gap:6px;min-height:22px;padding:0 12px}
.rx-node .rw.o{justify-content:flex-end;text-align:right}
.rx-node .rw.xr{min-height:24px}
.rx-node .lab{color:var(--soft);white-space:nowrap}
.rx-node .pin{position:absolute;width:12px;height:12px;border-radius:50%;border:2px solid var(--pc);background:var(--card);top:50%;margin-top:-6px;cursor:crosshair;z-index:2}
.rx-node .pin.on{background:var(--pc)} .rx-node .rw.i>.pin{left:-7px} .rx-node .rw.o>.pin{right:-7px}
.rx-node .pin::after{content:"";position:absolute;inset:-7px}
.rx-node .pin.x{border:0;border-radius:0;background:none;width:13px;height:14px;margin-top:-7px} .rx-node .pin.x svg{display:block;fill:none;stroke:var(--exec);stroke-width:1.6} .rx-node .pin.x.on svg{fill:var(--exec)}
.rx-node .pin.x.run svg{fill:var(--run);stroke:var(--run)} .rx-node .pin.x.xl{left:-7px} .rx-node .pin.x.xo{right:-7px}
.rx .pill.wrap{white-space:normal;height:auto;min-height:20px;padding:2px 8px}
.rx-stage.wiring .pin.nofit{opacity:.18} .rx-stage.wiring .pin.fit{transform:scale(1.35)}
.rx-node .val{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;padding:0 5px;border-radius:5px;background:var(--hd);border:1px solid var(--line);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:16px}
.rx-node .val.t{background:var(--yess);color:var(--yes);border-color:transparent;font-weight:700} .rx-node .val.f{background:var(--nos);color:var(--no);border-color:transparent;font-weight:700}
.rx-node .set{margin:4px 9px;padding:5px 7px;border-radius:7px;background:var(--hd);border:1px dashed var(--line);font-size:11.5px;line-height:1.4;overflow-wrap:anywhere}
.rx-node .set .ch{display:flex;flex-wrap:wrap;gap:3px;margin-top:2px} .rx-node .set .ch span{padding:0 5px;border-radius:5px;background:var(--card);border:1px solid var(--line);font-size:10.5px}
.rx-node .more{display:block;margin:2px 12px;border:0;background:none;color:var(--p);font:inherit;font-size:11px;font-weight:700;cursor:pointer;padding:0}
.rx-node .exp{margin:4px 9px 2px;width:calc(100% - 18px);height:26px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--p);font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.rx-node .res{margin:6px 9px 2px;padding:6px 8px;border-radius:7px;font-size:11.5px;line-height:1.4;overflow-wrap:anywhere}
.rx-node .res.on{background:var(--errs);color:var(--fg)} .rx-node .res.on b{color:var(--err)} .rx-node .res.off{background:var(--nos);color:var(--soft)} .rx-node .res.would{background:var(--warn);color:var(--warnf)}
.rx-node .nn{display:inline-block;margin:2px 9px 0;font-size:10.5px;font-weight:700;color:var(--warnf);background:var(--warn);padding:0 6px;border-radius:5px}
.rx-node .er{margin:4px 9px 0;font-size:11px;color:var(--err);font-weight:700;overflow-wrap:anywhere}
.rx-probs{border-top:1px solid var(--line);padding:8px 14px;font-size:12.5px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rx-probs b{color:var(--err)} .rx-probs button{border:1px solid var(--line);background:var(--errs);color:var(--fg);border-radius:7px;padding:2px 8px;font:inherit;font-size:12px;cursor:pointer;text-align:left;max-width:100%;overflow-wrap:anywhere}
.rx-probs.ok b{color:var(--yes)}
/* side */
.rx-tabs{display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--hd);border-radius:12px 12px 0 0}
.rx-tabs button{border:0;background:none;padding:5px 12px;border-radius:999px;color:var(--soft);font:inherit;font-size:13px;cursor:pointer} .rx-tabs button.on{background:var(--ps);color:var(--pt);font-weight:700}
.rx-ins{padding:12px 14px;display:grid;gap:12px}
.rx-ins h4{margin:0;font-size:15px} .rx-ins p{margin:0;color:var(--soft);font-size:12.5px}
.rx-fld{display:grid;gap:5px} .rx-fld>span{font-size:11.5px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.05em}
.rx-fld input[type=text],.rx-fld input[type=number],.rx-fld select{width:100%}
.rx-chips{display:flex;flex-wrap:wrap;gap:5px;padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.rx-chips span{display:inline-flex;align-items:center;gap:3px;height:24px;padding:0 4px 0 8px;border-radius:6px;background:var(--ps);color:var(--pt);font-size:12px;font-weight:700}
.rx-chips span button{border:0;background:none;color:inherit;cursor:pointer;width:18px;height:18px;border-radius:4px;padding:0;line-height:1;font-size:14px}
.rx-chips input{flex:1;min-width:110px;border:0!important;height:24px!important;background:none;outline:none;font-size:12.5px;padding:0 2px!important}
.rx-opts{display:flex;flex-wrap:wrap;gap:5px} .rx-opts button{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:12px;cursor:pointer} .rx-opts button.on{background:var(--ps);border-color:var(--p);color:var(--pt);font-weight:700}
.rx-ck{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer} .rx-ck input{accent-color:var(--p);width:15px;height:15px;margin:0}
.rx-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12.5px} .rx-kv dt{color:var(--soft)} .rx-kv dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
.rx-pre{margin:0;font:11.5px ui-monospace,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--hd);border:1px solid var(--line);border-radius:8px;padding:8px;max-height:220px;overflow:auto}
.rx-hr{height:1px;background:var(--line)}
.rx-cmp table{width:100%;border-collapse:collapse;font-size:12px} .rx-cmp th{text-align:left;color:var(--muted);font-weight:400;font-size:11px;padding:4px;border-bottom:1px solid var(--line)}
.rx-cmp td{padding:5px 4px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere} .rx-cmp tr.diff td{background:var(--warn);color:var(--warnf)}
.rx-cmp tbody tr{cursor:pointer} .rx-cmp tbody tr:hover td{background:var(--hd)} .rx-cmp tr.cur td:first-child{box-shadow:inset 3px 0 0 var(--p)}
.rx-cmp .wo{font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
.rx-match{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;font-size:12.5px;font-weight:700} .rx-match.ok{background:var(--yess);color:var(--yes)} .rx-match.bad{background:var(--warn);color:var(--warnf)} .rx-match.na{background:var(--hd);color:var(--soft);font-weight:400}
.rx-hist{display:grid;gap:6px} .rx-hist>div{border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12.5px} .rx-hist>div.on{border-color:var(--p);background:var(--ps)} .rx-hist .a{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.rx-modal{position:fixed;inset:0;z-index:40;background:rgba(10,8,16,.45);display:flex;align-items:flex-start;justify-content:center;padding:60px 16px;overflow:auto} .rx-modal .card{width:100%;max-width:480px;position:relative} .rx-modal .x{position:absolute;right:10px;top:8px;border:0;background:none;font-size:20px;cursor:pointer;color:var(--soft)}
.rx-lone{padding:30px 20px;text-align:center;color:var(--soft);font-size:13px} .rx-lone b{display:block;color:var(--fg);font-size:15px;margin-bottom:6px}
@media (prefers-reduced-motion:reduce){.rx *{transition:none!important;animation:none!important}}
@media (max-width:1280px){.rx-app{grid-template-columns:220px minmax(0,1fr)} .rx-side{grid-column:1 / -1}}
@media (max-width:760px){.rx-app{grid-template-columns:minmax(0,1fr)} .rx-rules{max-height:240px} .rx-stage{height:520px} .rx-acts{margin-left:0} .rx-dbg .ord{flex-basis:100%}}
`;

// ------------------------------------------------------------------ words
const CAT = { fact: ['Facts', 'Fact'], check: ['Checks', 'Check'], logic: ['Logic', 'Logic'], num: ['Numbers', 'Number'], text: ['Text', 'Text'], assize: ['Assize', 'Assize'], out: ['Flow and output', 'Flow'] };
const CAT_ORDER = ['fact', 'check', 'text', 'num', 'logic', 'assize', 'out'];
const TYPE_NAME = { bool: 'Yes / no', num: 'Number', text: 'Text', lines: 'Cart lines', notes: 'Notes', textList: 'Text list', person: 'Person', any: 'Anything' };
const PIN_LABEL = { id: 'WO number', programKey: 'Program key', statusId: 'Status id', isRfp: 'Ready for pickup', isActive: 'Active', hasCart: 'Has a cart', manualNotes: 'Manual notes', noteText: 'Note text',
  hasNotes: 'Notes loaded', cond: 'Condition', who: 'Blame', sig1: 'Signature 1', sig2: 'Signature 2', sig3: 'Signature 3', if1: 'If 1', if2: 'If 2', if3: 'If 3', then1: 'Then 1', then2: 'Then 2', then3: 'Then 3',
  ownLines: 'Own lines', yes: 'Yes', no: 'No', out: 'Out', in: 'In', sum: 'Sum', sig: 'Signature', found: 'Found', word: 'Word', match: 'Match', exists: 'Exists', lines: 'Lines', key: 'Program key' };
const pinLabel = (k) => PIN_LABEL[k] || (k.length === 1 ? k.toUpperCase() : (k[0].toUpperCase() + k.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase()));
const PROGRAMS = [['oop', 'Out of pocket'], ['cci', 'Consumer Cellular'], ['asurion', 'Asurion'], ['servify', 'Servify / Samsung Care+'], ['samsungIW', 'Samsung in-warranty'], ['google', 'Google'], ['amazon', 'Amazon Buyout'], ['vzew', 'Verizon Ext. Warranty'], ['element', 'Element'], ['cleaning', 'Cleaning'], ['unknown', 'Unknown partner']];
const STATUSES = ['Initial check-in', 'Need to order', 'Awaiting item', 'Awaiting device', 'Awaiting diagnostics', 'Awaiting partner approval', 'Awaiting callback', 'Ready for work', 'Diagnostics', 'Work in progress', 'Quality check', 'Repair summary', 'Ready for pickup', 'Sale complete', 'Cancelled'];
const OUTCOMES = ['Completed', 'Incomplete', 'Declined', 'No issue found'];
const PATTERNS = { DOLLAR_RE: 'A price ($150, 150.00, 150 dollars, "quoted 150")', EXPLAIN_RE: 'Explains a $0 cart (deposit, GSPN, waived, refund, ATC, no charge)', LIQUID_RE: 'Liquid (water, wet, corrosion)',
  DATA_RE: 'Data risk (reset, wipe, reflash, board)', AGREE_RE: 'Customer agreed (aware, agreed, signed, understands)', CONTACT_RE: 'Contacted (called, texted, voicemail)', OVERRIDE_RE: 'Price override ("- per GG")' };
const KIND_NAME = { fail: 'Fail', flag: 'Flag', note: 'Note', remind: 'Remind' };
const ACTION = { publish: 'Published', revert: 'Draft from an old version', create: 'Created', enable: 'Turned on', disable: 'Turned off', inherit: 'Follows all stores', delete: 'Override deleted' };
const MISSING = { notes: 'notes', nickname: 'the device nickname', deviceType: 'the device type (decided from its name)', issues: 'the repair issues', lineTypes: 'what kind each cart line is' };

// replaceChildren without the null / false children (h() drops them; replaceChildren would print "null").
const put = (node, ...kids) => node.replaceChildren(...kids.flat(9).filter((k) => k != null && k !== false && k !== ''));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (x) => JSON.parse(JSON.stringify(x));
const who = (email) => String(email || '').split('@')[0] || 'someone';
const plural = (n, w, ws) => n + ' ' + (n === 1 ? w : ws || w + 's');
const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fits = (a, b) => a === b || a === 'any' || b === 'any';
const split = (ref) => { const s = String(ref || ''), i = s.indexOf('.'); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, '']; };

// A value as a short pill ({ t, c }), and in full for the inspector.
function show(v, type) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return { t: v ? 'yes' : 'no', c: v ? 't' : 'f' };
  if (typeof v === 'number') return { t: Number.isFinite(v) ? String(Math.round(v * 100) / 100) : String(v) };
  if (v === null) return { t: type === 'notes' || type === 'any' ? 'not loaded' : 'none' };
  if (Array.isArray(v)) return { t: type === 'lines' ? plural(v.length, 'line') : type === 'notes' ? plural(v.length, 'note') : plural(v.length, 'item') };
  if (typeof v === 'object') return { t: v.name || v.label || '…' };
  const s = String(v);
  return { t: s === '' ? '(blank)' : s.length > 22 ? s.slice(0, 21) + '…' : s };
}
function full(v) {
  if (v === undefined) return 'not computed';
  if (v === null) return 'none (not loaded)';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === 'object' ? (x.noteText != null ? '• ' + String(x.noteText).slice(0, 200) : '• ' + [x.name, x.sku, x.price != null ? '$' + x.price : ''].filter(Boolean).join(' · ')) : '• ' + x)).join('\n') : '(empty list)';
  if (typeof v === 'object') return v.name ? v.name + (v.key ? ' (' + v.key + ')' : '') : JSON.stringify(v);
  return String(v) === '' ? '(blank)' : String(v);
}

// ------------------------------------------------------------------ state (kept across redraws of the tab)
let ui = null, S = null;
const fresh = () => ({
  list: null, stores: [], q: '', newRule: false, ruleId: null, rule: null, scope: 'all', loadErr: null,
  graph: null, source: 'empty', saved: null, hasDraft: false, draftAt: null, saving: null, saveTimer: 0, conflict: false,
  undo: [], redo: [], path: [], sel: new Set(), wire: null, view: { x: 20, y: 20, z: 0.8 }, fitted: '', morePins: new Set(),
  selectMode: false, pal: null, confirm: null, side: 'node', hist: null, renaming: null,
  test: { store: null, wo: null, orders: [], details: false, keys: null, loading: false, err: null, lastScan: null },
  dbg: null, step: null, playing: 0, showVals: true, errors: [], cmp: null, cmpTimer: 0, refocus: null,
});
let el = {};
const clip = { nodes: null };

// ------------------------------------------------------------------ entry
export async function draw(m, helpers) {
  ui = helpers;
  if (!document.getElementById('rx-css')) document.head.append(ui.h('style', { id: 'rx-css' }, STYLE));
  if (!S) S = fresh();
  S.access = helpers.access || { owner: false, scope: 'stores', stores: [] };
  const h = ui.h;
  el = {};
  el.root = h('div', { class: 'rx' }, h('div', { class: 'rx-app' },
    el.listPanel = h('aside', { class: 'rx-panel', 'aria-label': 'Rules' }),
    el.ed = h('section', { class: 'rx-panel', 'aria-label': 'Rule editor' }),
    el.side = h('aside', { class: 'rx-panel rx-side', 'aria-label': 'Inspector' })));
  put(m, el.root);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const [list, stores, keys] = await Promise.all([ui.api('GET', '/tracker/assize/rules'), ui.api('GET', '/tracker/assize/stores').catch(() => ({ stores: [] })), TK.keyState(helpers).catch(() => ({ details: false, unlocked: false }))]);
  S.list = list; S.stores = stores.stores || []; S.test.keys = keys;
  if (!S.test.store) S.test.store = Number(params.get('store')) || (S.stores.slice().sort((a, b) => b.open - a.open)[0] || {}).store || null;
  renderList();
  const want = S.ruleId || params.get('rule') || 'oop-zero-cart';
  if (params.get('scope')) S.scope = params.get('scope');
  await openRule(S.list.rules.some((r) => r.rule === want) ? want : (S.list.rules[0] || {}).rule, S.ruleId === want);
  if (S.test.store && !S.test.orders.length) loadOrders();
  if (!draw.hashBound) {
    draw.hashBound = true;
    // A link to another rule (#rules?rule=…) while the tab is open: page.js only redraws on a tab change.
    addEventListener('hashchange', () => { const r = new URLSearchParams(location.hash.split('?')[1] || '').get('rule'); if (live() && r && r !== S.ruleId) openRule(r); });
  }
}

const canEdit = (scope) => S.access.owner || (scope === 'all' ? S.access.scope === 'all' : S.access.scope === 'all' || (S.access.stores || []).includes(Number(scope)));
const scopeRow = (scope) => (S.rule && S.rule.scopes.find((x) => x.scope === String(scope))) || null;
const live = () => !!(el.root && el.root.isConnected);
function setHash() {
  const q = new URLSearchParams({ rule: S.ruleId || '' });
  if (S.scope !== 'all') q.set('scope', S.scope);
  if (S.test.store) q.set('store', S.test.store);
  history.replaceState(null, '', '#rules?' + q.toString());
}

// ------------------------------------------------------------------ rule list
function chipOf(r) {
  const all = r.scopes.find((x) => x.scope === 'all');
  if (!r.perOrder) return all && all.enabled === 0 ? ['off', 'Off'] : ['', 'On / off'];
  if (all && all.enabled === 0) return ['off', 'Off'];
  if (all && all.draft) return ['draft', 'Draft'];
  if (all && all.published) return ['graph', 'Graph'];
  if (r.builtInGraph) return ['built', 'Built in'];
  return ['', r.code ? 'Code only' : 'Empty'];
}
function renderList() {
  const h = ui.h, q = S.q.trim().toLowerCase();
  const groups = R.CHECKS.map(([k, name]) => [name, S.list.rules.filter((r) => r.check === k && (!q || (r.title + ' ' + r.rule).toLowerCase().includes(q)))]);
  const other = S.list.rules.filter((r) => !CHECK_NAME[r.check] && (!q || (r.title + ' ' + r.rule).toLowerCase().includes(q)));
  if (other.length) groups.push(['Other', other]);
  const search = h('input', { type: 'text', placeholder: 'Find a rule', 'aria-label': 'Find a rule', value: S.q, oninput: (e) => { S.q = e.target.value; renderRuleItems(); } });
  const canNew = canEdit('all');
  put(el.listPanel, 
    h('div', { class: 'rx-phd' }, h('h3', null, 'Rules'), h('span', { class: 'mut sm', style: 'margin-left:auto' }, String(S.list.rules.length))),
    h('div', { class: 'rx-srch' }, search, h('button', { class: 'btn sm', disabled: !canNew, title: canNew ? 'A new rule for every store' : 'A new rule is for every store: it needs all-stores access', onclick: () => { S.newRule = !S.newRule; renderList(); } }, '+ New rule')),
    S.newRule ? newRuleForm() : null,
    el.ruleItems = h('div', { class: 'rx-rules' }));
  renderRuleItems(groups);
  function renderRuleItems(gs) {
    const qq = S.q.trim().toLowerCase();
    gs = gs || R.CHECKS.map(([k, name]) => [name, S.list.rules.filter((r) => r.check === k)]).concat([['Other', S.list.rules.filter((r) => !CHECK_NAME[r.check])]]);
    gs = gs.map(([n, rs]) => [n, rs.filter((r) => !qq || (r.title + ' ' + r.rule).toLowerCase().includes(qq))]).filter(([, rs]) => rs.length);
    put(el.ruleItems, ...(gs.length ? gs.map(([name, rs]) => h('div', { class: 'rx-grp' }, h('b', null, name), rs.map((r) => {
      const [c, t] = chipOf(r), stores = r.scopes.filter((x) => x.scope !== 'all');
      return h('button', { class: 'rx-rule' + (r.rule === S.ruleId ? ' on' : ''), title: r.rule, onclick: () => openRule(r.rule) }, h('span', null, r.title),
        stores.map((x) => h('span', { class: 'pill st' + (x.draft ? ' dr' : ''), title: 'Store ' + x.scope + ' has its own ' + (x.published ? 'graph' : x.draft ? 'draft' : x.enabled === 0 ? 'off switch' : 'setting') }, x.scope)),
        h('span', { class: 'pill ' + c }, t));
    }))) : [h('p', { class: 'mut sm', style: 'padding:8px 14px' }, 'No rule matches.')]));
  }
}
function newRuleForm() {
  const h = ui.h;
  const id = h('input', { type: 'text', placeholder: 'Rule id, e.g. missing-imei', 'aria-label': 'Rule id' });
  const title = h('input', { type: 'text', placeholder: 'Title staff see, e.g. No IMEI', 'aria-label': 'Title', maxlength: 80 });
  const check = h('select', { 'aria-label': 'Section' }, R.CHECKS.map(([k, n]) => h('option', { value: k }, n)));
  const go = h('button', { class: 'btn p sm', onclick: async () => {
    if (!R.ruleId(id.value.trim())) return ui.toast('Rule id: lowercase letters, digits and dashes.');
    if (!title.value.trim()) return ui.toast('Give it a title.');
    go.disabled = true;
    try {
      const r = await ui.api('POST', '/tracker/assize/rules', { rule: id.value.trim(), title: title.value.trim(), check: check.value });
      S.newRule = false; S.list = await ui.api('GET', '/tracker/assize/rules'); renderList(); await openRule(r.rule);
    } catch (e) { go.disabled = false; ui.toast("Couldn't create it: " + e.message); }
  } }, 'Create');
  return h('div', { class: 'rx-new' }, id, title, h('div', { class: 'row' }, check, go, h('button', { class: 'btn sm', onclick: () => { S.newRule = false; renderList(); } }, 'Cancel')));
}

// ------------------------------------------------------------------ opening a rule, scopes
async function openRule(ruleId, keep) {
  if (!ruleId) return;
  await flushSave();
  try { S.rule = await ui.api('GET', '/tracker/assize/rules/' + ruleId); S.loadErr = null; }
  catch (e) { S.loadErr = e.message; S.rule = null; }
  if (S.ruleId !== ruleId) { S.scope = S.scope !== 'all' && canEdit(S.scope) ? S.scope : 'all'; S.fitted = ''; }
  S.ruleId = ruleId; S.hist = null; S.confirm = null; S.conflict = false;
  if (!keep || !S.graph || S.graph.rule !== ruleId) loadScope(); else { S.hasDraft = !!(scopeRow(S.scope) && scopeRow(S.scope).draft); }
  setHash(); renderList(); renderAll();
}
const emptyGraph = () => ({ v: 1, rule: S.ruleId, check: S.rule.check || 'intake', title: S.rule.title || S.ruleId, nodes: [], wires: [], flow: [] });
function inherited() { const all = scopeRow('all'); return (all && (all.published || all.draft)) || S.rule.builtInGraph || emptyGraph(); }
function loadScope() {
  const row = scopeRow(S.scope);
  S.path = []; S.sel = new Set(); S.wire = null; S.undo = []; S.redo = []; S.step = null; stopPlay();
  if (!S.rule) { S.graph = null; return; }
  if (S.scope !== 'all' && !(row && (row.draft || row.published))) { S.graph = clone(inherited()); S.source = 'inherit'; }
  else if (row && row.draft) S.source = 'draft', S.graph = clone(row.draft);
  else if (row && row.published) S.source = 'published', S.graph = clone(row.published);
  else if (S.rule.builtInGraph) S.source = 'builtIn', S.graph = clone(S.rule.builtInGraph);
  else S.source = 'empty', S.graph = emptyGraph();
  S.graph.flow = S.graph.flow || []; S.graph.wires = S.graph.wires || []; S.graph.nodes = S.graph.nodes || [];
  S.hasDraft = !!(row && row.draft); S.draftAt = (row && row.draftAt) || null;
  S.saved = row && row.draft ? JSON.stringify(row.draft) : null;
}
const editable = () => !!(S.rule && S.rule.perOrder && S.graph && !S.hist && S.source !== 'inherit' && canEdit(S.scope));
function readOnlyWhy() {
  if (!S.rule) return '';
  if (S.hist) return 'Viewing an old version';
  if (!canEdit(S.scope)) return S.scope === 'all' ? 'Changing a rule for every store needs all-stores access' : 'No access to store ' + S.scope;
  if (S.source === 'inherit') return 'Store ' + S.scope + ' follows all stores. Make an override to change it here.';
  return '';
}
async function reloadRule(msg) {
  S.rule = await ui.api('GET', '/tracker/assize/rules/' + S.ruleId);
  S.list = await ui.api('GET', '/tracker/assize/rules');
  loadScope(); renderList(); renderAll();
  if (msg) ui.toast(msg);
}
async function post(action, body, msg) {
  try { await ui.api(action === 'draft' ? 'PUT' : 'POST', '/tracker/assize/rules/' + S.ruleId + '/' + action, Object.assign({ scope: S.scope }, body)); await reloadRule(msg); return true; }
  catch (e) { ui.toast("Couldn't do that: " + e.message); return false; }
}

// ------------------------------------------------------------------ saving
function scheduleSave() {
  if (!editable()) return;
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => save(), 1200);
  renderHeader();
}
async function flushSave() { if (S && S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = 0; await save(); } else if (S && S.saving) await S.saving; }
async function save(force) {
  S.saveTimer = 0;
  if (!S.graph || !editable() || S.conflict && !force) return;
  const text = JSON.stringify(S.graph);
  if (text === S.saved) return;
  const body = { scope: S.scope, graph: S.graph };
  if (!force) body.ifDraftAt = S.draftAt;
  const p = (async () => {
    try {
      const r = await ui.api('PUT', '/tracker/assize/rules/' + S.ruleId + '/draft', body);
      S.saved = text; S.draftAt = r.draftAt; S.hasDraft = true; S.conflict = false;
      const lr = S.list.rules.find((x) => x.rule === S.ruleId);
      if (lr) { let sc = lr.scopes.find((x) => x.scope === S.scope); if (!sc) lr.scopes.push(sc = { scope: S.scope }); sc.draft = true; }
      if (S.source !== 'draft') S.source = 'draft';
    } catch (e) {
      if (/someone saved/i.test(e.message)) S.conflict = true; else ui.toast("Couldn't save the draft: " + e.message);
    }
  })();
  S.saving = p; await p; S.saving = null;
  if (live()) { renderHeader(); renderList(); }
}

// ------------------------------------------------------------------ editing
function lib() { return { nodes: RG.NODE_TYPES, macros: Object.assign({}, RG.MACROS, (S.graph && S.graph.macros) || {}) }; }
const shown = () => (S.hist ? S.hist.graph : S.graph);
// The level the canvas shows: the graph, or a macro inside it ({ g, inside, prefix, own, name }).
function level() {
  const top = shown();
  let g = top, inside = null, prefix = '', own = true, name = null;
  for (const p of S.path) {
    const mine = own && top && top.macros && top.macros[p.macro];
    g = mine || RG.MACROS[p.macro]; own = !!mine; inside = g; prefix += p.node + '/'; name = p.macro;
  }
  return { g, inside, prefix, own, name, edit: editable() && own };
}
function commit(fn, opts = {}) {
  if (!level().edit) return;
  S.undo.push(JSON.stringify(S.graph)); if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
  fn(level().g);
  changed(opts);
}
function changed(opts = {}) {
  S.step = null; stopPlay();
  validate(); runDebug();
  renderCanvas(); renderDebug(); if (!opts.keepInspector) renderSide(); else renderCompareSoon();
  scheduleSave(); renderCompareSoon();
}
function undo(back) {
  const from = back ? S.undo : S.redo, to = back ? S.redo : S.undo;
  if (!from.length || !editable()) return;
  to.push(JSON.stringify(S.graph));
  S.graph = JSON.parse(from.pop());
  const lv = level();
  if (!lv.g) S.path = [];
  S.sel = new Set([...S.sel].filter((id) => level().g.nodes.some((n) => n.id === id))); S.wire = null;
  changed();
}
const nodeById = (g, id) => g.nodes.find((n) => n.id === id);
function newId(g, type) { let i = 1; const base = type.replace(/[^a-zA-Z]/g, '') || 'n'; while (g.nodes.some((n) => n.id === base + i)) i++; return base + i; }
function defaults(type) {
  const def = RG.NODE_TYPES[type], s = {};
  for (const f of def.settings || []) {
    if (f.def !== undefined) s[f.name] = clone(f.def);
    else if (f.req && f.options) s[f.name] = f.options[0];
  }
  if ((type === 'finding') && S.graph.kind) s.kind = S.graph.kind;
  return s;
}
function addNode(type, x, y, extra) {
  let id = null;
  commit((g) => {
    id = newId(g, type);
    const n = { id, type, x: Math.round(x), y: Math.round(y) };
    const s = Object.assign(defaults(type), extra || {});
    if (Object.keys(s).length) n.settings = s;
    g.nodes.push(n);
  });
  if (id) { S.sel = new Set([id]); S.wire = null; renderCanvas(); renderSide(); }
}
function removeSelected() {
  if (S.wire) { const w = S.wire; S.wire = null; return commit((g) => { (w.kind === 'x' ? g.flow : g.wires).splice(w.i, 1); }); }
  if (!S.sel.size) return;
  const ids = new Set(S.sel);
  commit((g) => {
    g.nodes = g.nodes.filter((n) => !ids.has(n.id) || n.type === 'macroIn' || n.type === 'macroOut');
    const gone = (ref) => ids.has(split(ref)[0]) && !g.nodes.some((n) => n.id === split(ref)[0]);
    g.wires = (g.wires || []).filter((w) => !gone(w.from) && !gone(w.to));
    if (g.flow) g.flow = g.flow.filter((w) => !gone(w.from) && !gone(w.to));
  });
  S.sel = new Set();
  renderSide();
}
function copySel() {
  const g = level().g, ids = new Set(S.sel);
  if (!ids.size) return false;
  const inner = (ref) => ids.has(split(ref)[0]);
  clip.nodes = { nodes: clone(g.nodes.filter((n) => ids.has(n.id) && n.type !== 'macroIn' && n.type !== 'macroOut')), wires: clone((g.wires || []).filter((w) => inner(w.from) && inner(w.to))), flow: clone((g.flow || []).filter((w) => inner(w.from) && inner(w.to))) };
  return true;
}
function paste() {
  if (!clip.nodes || !clip.nodes.nodes.length) return;
  const lv = level(), c = clip.nodes, fresh = [];
  commit((g) => {
    const map = {};
    for (const n of c.nodes) {
      if (lv.inside && RG.NODE_TYPES[n.type] && RG.NODE_TYPES[n.type].exec) continue;
      if (n.type === 'start' && g.nodes.some((x) => x.type === 'start')) continue;
      const id = newId(g, n.type); map[n.id] = id;
      g.nodes.push(Object.assign(clone(n), { id, x: n.x + 40, y: n.y + 40 })); fresh.push(id);
    }
    const re = (ref) => { const [a, p] = split(ref); return map[a] ? map[a] + '.' + p : null; };
    for (const w of c.wires) { const f = re(w.from), t = re(w.to); if (f && t) g.wires.push({ from: f, to: t }); }
    if (!lv.inside) for (const w of c.flow) { const f = re(w.from), t = re(w.to); if (f && t) (g.flow = g.flow || []).push({ from: f, to: t }); }
  });
  for (const n of c.nodes) { n.x += 40; n.y += 40; }
  S.sel = new Set(fresh); renderCanvas(); renderSide();
}
// Collapse the selected pure nodes into a macro of the graph's own (graph.macros), wired the same way.
function collapse() {
  const lv = level();
  if (lv.inside || !lv.edit) return ui.toast('Collapse works on the top level of the graph.');
  const g = lv.g, ids = new Set(S.sel), sel = g.nodes.filter((n) => ids.has(n.id));
  if (!sel.length) return;
  if (sel.some((n) => !RG.NODE_TYPES[n.type] || RG.NODE_TYPES[n.type].exec)) return ui.toast("Flow nodes (Start, Branch, Stop, Finding) can't go in a macro: macros only work things out.");
  const L = lib(), inSel = (ref) => ids.has(split(ref)[0]);
  const outType = (ref) => { const [a, p] = split(ref), n = nodeById(g, a), pn = n && RG.pinsOf(n, L); const o = pn && pn.outputs.find((x) => x.name === p); return o ? o.type : 'any'; };
  const inType = (ref) => { const [a, p] = split(ref), n = nodeById(g, a), pn = n && RG.pinsOf(n, L); const o = pn && pn.inputs.find((x) => x.name === p); return o ? o.type : 'any'; };
  const uniq = (used, name) => { let k = name.replace(/[^A-Za-z0-9_]/g, '') || 'x', i = 2; const b = k; while (used.has(k)) k = b + i++; used.add(k); return k; };
  const inputs = [], outputs = [], inNames = new Set(), outNames = new Set(), byFrom = new Map(), byOut = new Map();
  for (const w of g.wires) if (!inSel(w.from) && inSel(w.to)) { if (!byFrom.has(w.from)) { const t = outType(w.from), name = uniq(inNames, split(w.to)[1]); byFrom.set(w.from, name); inputs.push({ name, type: t === 'any' ? inType(w.to) : t }); } }
  for (const w of g.wires) if (inSel(w.from) && !inSel(w.to)) { if (!byOut.has(w.from)) { const name = uniq(outNames, split(w.from)[1]); byOut.set(w.from, name); outputs.push({ name, type: outType(w.from) }); } }
  let mname = 'macro1', i = 1; while ((g.macros && g.macros[mname]) || RG.MACROS[mname]) mname = 'macro' + ++i;
  const minX = Math.min(...sel.map((n) => n.x)), minY = Math.min(...sel.map((n) => n.y)), maxX = Math.max(...sel.map((n) => n.x));
  const def = { title: 'Collapsed nodes', inputs, outputs,
    nodes: [...(inputs.length ? [{ id: 'in', type: 'macroIn', x: 30, y: 40 }] : []), ...clone(sel).map((n) => Object.assign(n, { x: n.x - minX + 310, y: n.y - minY + 40 })), { id: 'out', type: 'macroOut', x: maxX - minX + 600, y: 40 }],
    wires: [] };
  // inner ids must not clash with in / out
  const ren = {}; for (const n of def.nodes) if ((n.id === 'in' && n.type !== 'macroIn') || (n.id === 'out' && n.type !== 'macroOut')) { ren[n.id] = n.id + '_'; n.id += '_'; }
  const r = (ref) => { const [a, p] = split(ref); return (ren[a] || a) + '.' + p; };
  for (const w of g.wires) {
    if (inSel(w.from) && inSel(w.to)) def.wires.push({ from: r(w.from), to: r(w.to) });
    else if (!inSel(w.from) && inSel(w.to)) def.wires.push({ from: 'in.' + byFrom.get(w.from), to: r(w.to) });
  }
  for (const [from, name] of byOut) def.wires.push({ from: r(from), to: 'out.' + name });
  let mid = null;
  commit((gg) => {
    mid = newId(gg, 'macro');
    gg.macros = Object.assign({}, gg.macros, { [mname]: def });
    const keep = [];
    for (const w of gg.wires) {
      if (inSel(w.from) && inSel(w.to)) continue;
      if (!inSel(w.from) && inSel(w.to)) continue;
      if (inSel(w.from)) keep.push({ from: mid + '.' + byOut.get(w.from), to: w.to }); else keep.push(w);
    }
    for (const [from, name] of byFrom) keep.push({ from, to: mid + '.' + name });
    gg.wires = keep;
    gg.nodes = gg.nodes.filter((n) => !ids.has(n.id));
    gg.nodes.push({ id: mid, type: 'macro', x: Math.round(minX), y: Math.round(minY), settings: { macro: mname } });
  });
  S.sel = new Set([mid]); renderCanvas(); renderSide();
  ui.toast('Collapsed into a macro. Rename it in the inspector; Expand opens it.');
}

// ------------------------------------------------------------------ validation and the debug run
function validate() {
  const g = shown();
  S.errors = g ? R.checkGraph(g, S.ruleId) : [];
}
// Errors for the level on screen: node ids and wire refs they name.
function levelErrors() {
  const lv = level(), pre = lv.name ? 'Macro ' + lv.name + ': ' : '';
  const nodes = new Map(), wires = new Set();
  for (const e of S.errors) {
    let t = e;
    if (pre) { if (!t.startsWith(pre)) continue; t = t.slice(pre.length); } else if (/^Macro \S+: /.test(t)) continue;
    let m = t.match(/^(?:Exec )?[Ww]ire (\S+) → (\S+?):/);
    if (m) { wires.add(m[1] + '>' + m[2]); continue; }
    m = t.match(/^Input (\S+) has more than one wire/) || t.match(/^Exec output (\S+) has/);
    if (m) { const id = split(m[1])[0]; nodes.set(id, t); continue; }
    m = t.match(/^([A-Za-z0-9_-]+)(?: \(|:)/);
    if (m && lv.g && lv.g.nodes.some((n) => n.id === m[1])) nodes.set(m[1], t);
  }
  return { nodes, wires };
}
function inputsOf(o) { return o && o.inp; }
const curOrder = () => S.test.orders.find((o) => o.wo === S.test.wo) || null;
const optsFor = (store, now) => ({ now: now || Date.now(), hours: R.hoursFor(store), priceFor: null });
const ctxFor = (inp, opts) => Object.assign(Object.create(R.GH), { f: R.facts(inp.row, inp.detail), opts });
function runDebug() {
  const o = curOrder(), inp = inputsOf(o), g = shown();
  if (!inp || !g || !S.rule || !S.rule.perOrder) { S.dbg = null; return; }
  try { S.dbg = RG.run(RG.compile(g), ctxFor(inp, optsFor(S.test.store)), { debug: true }); }
  catch (e) { S.dbg = { errors: [e.message], outcome: { ended: 'error', text: 'The run failed: ' + e.message, raised: 0 }, nodes: {}, steps: [], execWires: [], results: {}, trace: {}, findings: [] }; }
}

// ------------------------------------------------------------------ render: everything
function renderAll() {
  if (!live()) return;
  validate(); runDebug();
  renderHeader(); renderDebug(); renderCanvas(); renderSide(); renderCompareSoon();
}

// ------------------------------------------------------------------ render: header, scope, bars
function renderHeader() {
  if (!live()) return;
  const h = ui.h, r = S.rule;
  if (!r) { put(el.ed, h('div', { class: 'rx-lone' }, h('b', null, S.loadErr ? "Couldn't load this rule" : 'Pick a rule'), S.loadErr || 'Choose a rule on the left.')); return; }
  if (!el.head || !el.ed.contains(el.head)) buildEditor();
  const [chipC, chipT] = chipOf(S.list.rules.find((x) => x.rule === r.rule) || { scopes: [], perOrder: r.perOrder, code: r.code, builtInGraph: !!r.builtInGraph });
  const row = scopeRow(S.scope), errs = S.errors.length, edit = editable();
  const scopeName = S.scope === 'all' ? 'all stores' : 'store ' + S.scope;
  const something = S.hasDraft || !!S.saveTimer || S.source === 'builtIn' || (S.source === 'empty' && S.graph.nodes.length > 0);
  const pubBtn = h('button', { class: 'btn p', disabled: !edit || !something,
    title: !edit ? readOnlyWhy() : !something ? 'No changes to publish' : errs ? 'Fix the problems below first' : '', onclick: () => { if (errs) return ui.toast('Publishing needs a graph without problems: ' + errs + ' to fix.'); S.confirm = 'publish'; renderHeader(); } }, 'Publish to ' + scopeName);
  const pending = S.saveTimer || S.saving;
  put(el.head, 
    h('div', { style: 'min-width:0' }, h('div', { class: 'rx-crumb' }, (CHECK_NAME[r.check] || r.check || 'No section') + ' · ', h('span', null, r.rule)), h('h2', null, r.title)),
    S.source === 'builtIn' && !S.hist ? null : h('span', { class: 'pill ' + chipC }, chipT),
    S.hasDraft || pending ? h('span', { class: 'pill draft' }, pending ? 'Saving…' : 'Unpublished changes') : null,
    S.source === 'builtIn' && !S.hist ? h('span', { class: 'pill built wrap', title: 'The graph built into Aethernet, from the code rule. Assize runs the code until a graph is published.' }, 'Built in — publish to take over from the code rule') : null,
    h('div', { class: 'rx-acts' },
      S.hasDraft && edit ? h('button', { class: 'btn', onclick: () => { S.confirm = 'discard'; renderHeader(); } }, 'Discard changes') : null,
      r.perOrder ? pubBtn : null));
  // scope row
  const stores = S.stores.map((s) => s.store);
  if (S.scope !== 'all' && !stores.includes(Number(S.scope))) stores.push(Number(S.scope));
  const sc = h('select', { 'aria-label': 'Scope', onchange: async (e) => { await flushSave(); S.scope = e.target.value; S.hist = null; S.confirm = null; S.conflict = false; S.fitted = ''; loadScope(); if (S.scope !== 'all') { S.test.store = Number(S.scope); loadOrders(); } setHash(); renderAll(); } },
    h('option', { value: 'all' }, 'All stores'), stores.map((s) => h('option', { value: String(s) }, 'Store ' + s + ((S.stores.find((x) => x.store === s) || {}).name ? ' · ' + S.stores.find((x) => x.store === s).name : ''))));
  sc.value = S.scope;
  const on = row && row.enabled != null ? row.enabled : null, allRow = scopeRow('all'), allOn = !(allRow && allRow.enabled === 0);
  const canScope = canEdit(S.scope);
  const sw = S.scope === 'all'
    ? h('div', { class: 'rx-seg', role: 'group', 'aria-label': 'On or off for all stores' }, [[true, 'On'], [false, 'Off']].map(([v, l]) => h('button', { class: allOn === v ? 'on' : null, disabled: !canScope, onclick: () => allOn !== v && post('enabled', { enabled: v }, v ? 'On for all stores' : 'Off for all stores') }, l)))
    : h('div', { class: 'rx-seg', role: 'group', 'aria-label': 'On or off at this store' }, [[null, 'Follow all stores (' + (allOn ? 'on' : 'off') + ')'], [1, 'On'], [0, 'Off']].map(([v, l]) => h('button', { class: on === v ? 'on' : null, disabled: !canScope, onclick: () => on !== v && post('enabled', { enabled: v === null ? null : !!v }, 'Saved') }, l)));
  const ov = [];
  if (S.scope !== 'all' && r.perOrder) {
    const has = row && (row.draft || row.published);
    if (!has) ov.push(h('span', { class: 'mut sm' }, 'Follows all stores.'), h('button', { class: 'btn sm', disabled: !canScope, title: canScope ? '' : 'No access to store ' + S.scope, onclick: makeOverride }, 'Make an override for ' + S.scope));
    else ov.push(h('span', { class: 'mut sm' }, 'Has its own graph.'));
    if (row) ov.push(h('button', { class: 'btn sm dg', disabled: !canScope, onclick: () => { S.confirm = 'delete'; renderHeader(); } }, 'Delete override'));
  }
  put(el.scope, h('label', { class: 'mut sm' }, 'Scope'), sc, sw, ...ov,
    readOnlyWhy() && !S.hist && S.source !== 'inherit' ? h('span', { class: 'mut sm' }, '· ' + readOnlyWhy()) : null);
  // bars: conflict, confirm, history view, per-order note
  const bars = [];
  if (S.conflict) bars.push(h('div', { class: 'rx-bar bad' }, h('span', null, 'Someone else changed this draft since you opened it. Your changes aren’t saved.'),
    h('button', { class: 'btn sm', onclick: () => { S.conflict = false; reloadRule('Loaded their version'); } }, 'Load their version'),
    h('button', { class: 'btn sm p', onclick: async () => { await save(true); if (!S.conflict) ui.toast('Saved yours over theirs'); } }, 'Keep mine (overwrite)')));
  if (S.confirm === 'publish') {
    const c = S.cmp, note = h('input', { type: 'text', placeholder: 'What changed (optional)', maxlength: 300, 'aria-label': 'Note' });
    const diff = c && c.ok ? (c.changed ? c.changed + ' of ' + c.n + ' open orders at store ' + c.store + ' would change.' : 'No change on the ' + c.n + ' open orders at store ' + c.store + '.') : '';
    bars.push(h('div', { class: 'rx-bar' }, h('span', null, 'Publish to ' + scopeName + '? Assize ' + (S.scope === 'all' ? 'at every store' : 'at store ' + S.scope) + ' picks it up on its next check. ' + diff), note,
      h('button', { class: 'btn sm', onclick: () => { S.confirm = null; renderHeader(); } }, 'Cancel'),
      h('button', { class: 'btn sm p', onclick: (e) => publish(note.value, e.target) }, 'Publish')));
  }
  if (S.confirm === 'discard') bars.push(h('div', { class: 'rx-bar' }, h('span', null, 'Discard the unpublished changes? The canvas goes back to ' + (row && row.published ? 'the published graph' : S.rule.builtInGraph && S.scope === 'all' ? 'the built-in graph' : 'what was there before') + '.'),
    h('button', { class: 'btn sm', onclick: () => { S.confirm = null; renderHeader(); } }, 'Cancel'),
    h('button', { class: 'btn sm p', onclick: async () => { S.confirm = null; clearTimeout(S.saveTimer); S.saveTimer = 0; await post('discard', {}, 'Changes discarded'); } }, 'Discard')));
  if (S.confirm === 'delete') bars.push(h('div', { class: 'rx-bar' }, h('span', null, 'Delete store ' + S.scope + '’s override? It goes back to following all stores (graph and on / off).'),
    h('button', { class: 'btn sm', onclick: () => { S.confirm = null; renderHeader(); } }, 'Cancel'),
    h('button', { class: 'btn sm p', onclick: async () => { S.confirm = null; clearTimeout(S.saveTimer); S.saveTimer = 0; await post('delete', {}, 'Override deleted'); } }, 'Delete override')));
  if (S.hist) {
    const x = S.hist;
    bars.push(h('div', { class: 'rx-bar info' }, h('span', null, 'Viewing version ' + (x.version || '?') + ' (' + (x.scope === 'all' ? 'all stores' : 'store ' + x.scope) + ') · ' + (ACTION[x.action] || x.action).toLowerCase() + ' by ' + who(x.by) + ' ' + ui.fmt(x.at) + (x.note ? ' · “' + x.note + '”' : '') + '. Read only.'),
      x.action === 'publish' && canEdit(S.scope) && r.perOrder ? h('button', { class: 'btn sm p', onclick: () => restore(x) }, 'Restore as draft') : null,
      h('button', { class: 'btn sm', onclick: () => { S.hist = null; S.fitted = ''; renderAll(); } }, 'Back to editing')));
  }
  if (!r.perOrder) bars.push(h('div', { class: 'rx-bar info' }, h('span', null, 'This rule looks across orders (an open cleaning and its closed parent), and graphs check one order at a time, so it can only be turned on or off.')));
  else if (r.code && S.source === 'empty' && !S.hist) bars.push(h('div', { class: 'rx-bar info' }, h('span', null, 'This rule is still in Aethernet’s code, with no graph yet. Draw one and publish it to take over from the code rule.')));
  put(el.bars, ...bars);
}
async function makeOverride() {
  const g = clone(inherited());
  try { await ui.api('PUT', '/tracker/assize/rules/' + S.ruleId + '/draft', { scope: S.scope, graph: g, ifDraftAt: null }); await reloadRule('Override for store ' + S.scope + ': a draft copy of the all-stores graph'); }
  catch (e) { ui.toast("Couldn't make the override: " + e.message); }
}
async function publish(note, btn) {
  btn.disabled = true;
  await flushSave();
  if (S.conflict) { btn.disabled = false; return ui.toast('Sort out the draft conflict first.'); }
  if (!S.hasDraft) { await save(true); }
  try {
    const r = await ui.api('POST', '/tracker/assize/rules/' + S.ruleId + '/publish', { scope: S.scope, note: note || undefined, ifDraftAt: S.draftAt });
    S.confirm = null; await reloadRule('Published version ' + r.version + ' to ' + (S.scope === 'all' ? 'all stores' : 'store ' + S.scope));
  } catch (e) { btn.disabled = false; ui.toast("Couldn't publish: " + e.message); }
}
async function restore(x) {
  await flushSave();
  try { await ui.api('POST', '/tracker/assize/rules/' + S.ruleId + '/revert', { scope: S.scope, id: x.id }); S.hist = null; await reloadRule('Version ' + x.version + ' is the draft now. Test it, then publish.'); }
  catch (e) { ui.toast("Couldn't restore: " + e.message); }
}

// ------------------------------------------------------------------ the editor's frame
function buildEditor() {
  const h = ui.h;
  el.head = h('div', { class: 'rx-ehd' });
  el.scope = h('div', { class: 'rx-scope' });
  el.bars = h('div');
  el.dbg = h('div', { class: 'rx-dbg' });
  el.out = h('div', { class: 'rx-out', 'aria-live': 'polite' });
  el.steps = h('div', { class: 'rx-steps' });
  el.note = h('div');
  el.stage = h('div', { class: 'rx-stage', tabindex: '0', 'aria-label': 'Rule graph canvas' });
  el.probs = h('div', { class: 'rx-probs' });
  put(el.ed, el.head, el.scope, el.bars, el.dbg, el.out, el.steps, el.note, el.stage, el.probs);
  buildStage();
}

// ------------------------------------------------------------------ test orders
async function loadOrders() {
  const store = S.test.store;
  if (!store) return;
  S.test.loading = true; S.test.err = null; renderDebug();
  try {
    const r = await ui.api('GET', '/tracker/assize/orders?store=' + store);
    if (S.test.store !== store) return;
    S.test.orders = r.orders || []; S.test.details = !!r.details; S.test.lastScan = r.last_scan_at;
    await openInputs();
    if (!S.test.orders.some((o) => o.wo === S.test.wo)) S.test.wo = (S.test.orders[0] || {}).wo || null;
  } catch (e) { S.test.err = e.message; S.test.orders = []; }
  S.test.loading = false;
  if (live()) { runDebug(); renderDebug(); renderCanvas(); renderSide(); renderCompareSoon(); }
}
async function openInputs() {
  const store = S.test.store, open = S.test.details && TK.isUnlocked();
  for (const o of S.test.orders) {
    let sealed = null;
    if (open && o.sealed) { try { sealed = await TK.openSnapshot(store, o.wo, o.sealed); } catch (_) { sealed = null; } }
    o.locked = !!o.sealed && !sealed;
    o.inp = fromSnapshot(o.plain, sealed);
  }
}
function unlockModal() {
  const h = ui.h;
  const close = () => box.remove();
  const after = async () => { close(); S.test.keys = await TK.keyState(ui).catch(() => S.test.keys); await openInputs(); runDebug(); renderDebug(); renderCanvas(); renderSide(); renderCompareSoon(); ui.toast('Unlocked: notes are in the test orders now.'); };
  const card = TK.unlockPrompt(after);
  card.prepend(h('button', { class: 'x', 'aria-label': 'Close', onclick: close }, '×'));
  const box = h('div', { class: 'rx-modal', onclick: (e) => { if (e.target === box) close(); } }, card);
  document.body.append(box);
}

// ------------------------------------------------------------------ render: debug bar, outcome, steps
function renderDebug() {
  if (!live() || !el.dbg || !S.rule) return;
  const h = ui.h, d = S.dbg, t = S.test;
  const storeSel = h('select', { 'aria-label': 'Test store', onchange: (e) => { S.test.store = Number(e.target.value); S.test.wo = null; S.test.orders = []; setHash(); loadOrders(); } },
    S.stores.length ? S.stores.map((s) => h('option', { value: String(s.store) }, 'Store ' + s.store + (s.name ? ' · ' + s.name : ''))) : h('option', { value: '' }, 'No stores'));
  if (t.store) storeSel.value = String(t.store);
  const ordSel = h('select', { class: 'ord', 'aria-label': 'Test order', disabled: !t.orders.length, onchange: (e) => { S.test.wo = Number(e.target.value); S.step = null; stopPlay(); runDebug(); renderDebug(); renderCanvas(); renderSide(); renderCompareMarks(); } },
    t.loading ? h('option', null, 'Loading orders…') : t.orders.length ? t.orders.map((o) => h('option', { value: String(o.wo) }, '#' + o.wo + ' · ' + (o.device || (o.plain && o.plain.workorder && o.plain.workorder.device) || 'device?') + ' · ' + (o.status_name || '?'))) : h('option', null, t.err ? "Couldn't load: " + t.err : 'No open orders'));
  if (t.wo) ordSel.value = String(t.wo);
  const vals = h('label', { class: 'rx-tg' }, h('input', { type: 'checkbox', checked: S.showVals, onchange: (e) => { S.showVals = e.target.checked; renderCanvas(); } }), h('i'), 'Show values on wires');
  const n = maxStep(), playing = !!S.playing;
  const play = h('div', { class: 'rx-play', role: 'group', 'aria-label': 'Step through the run' },
    h('button', { title: 'Show the whole run', 'aria-label': 'Show the whole run', disabled: S.step == null && !playing, onclick: () => { stopPlay(); S.step = null; stepRender(); } }, '⟲'),
    h('button', { title: 'Step back', 'aria-label': 'Step back', disabled: !d || n < 0 || S.step === 0, onclick: () => { stopPlay(); S.step = S.step == null ? n : Math.max(0, S.step - 1); stepRender(); } }, '◀'),
    h('button', { title: playing ? 'Pause' : 'Play the run', 'aria-label': playing ? 'Pause' : 'Play the run', disabled: !d || n < 0, onclick: () => (playing ? stopPlay(true) : startPlay()) }, playing ? '❚❚' : '▶'),
    h('button', { title: 'Step forward', 'aria-label': 'Step forward', disabled: !d || n < 0 || S.step === n, onclick: () => { stopPlay(); S.step = S.step == null ? 0 : Math.min(n, S.step + 1); stepRender(); } }, '▶︎|'));
  put(el.dbg, h('label', { class: 'l' }, 'Test on'), storeSel, ordSel, vals, play);
  // the outcome, finding or not
  const parts = [];
  if (!S.rule.perOrder) parts.push(h('span', { class: 'mut' }, 'Nothing to test: this rule looks across orders.'));
  else if (!d) parts.push(h('span', { class: 'mut' }, t.loading ? 'Loading test orders…' : t.orders.length ? 'Pick an order to test on.' : 'No open orders to test on at this store.'));
  else {
    const raised = d.findings || [];
    parts.push(h('span', { class: 't' }, d.outcome ? d.outcome.text : ''));
    if (raised.length) for (const f of raised.slice(0, 2)) parts.push(h('span', { class: 'pill ' + f.kind }, KIND_NAME[f.kind] || f.kind), h('b', null, f.title), h('span', { class: 'ev mut' }, f.evidence + ' · ' + ((f.who && f.who.name) || 'Unassigned')));
    else parts.push(h('span', { class: 'pill' }, 'No finding'));
    if (d.aborted) parts.push(h('span', { class: 'pill off' }, 'Assize would hit an error here and keep the code rule'));
    if (S.step != null) { const s = d.steps[S.step]; parts.push(h('span', { class: 'mut sm' }, s ? '· step ' + (S.step + 1) + ' of ' + (n + 1) : '· after the flow: findings with no exec wire checked')); }
  }
  put(el.out, ...parts);
  // steps
  if (d && d.steps && d.steps.length) {
    const g = shown(), items = [];
    d.steps.forEach((s, i) => {
      const nd = g.nodes.find((x) => x.id === s.node), nm = nd ? titleOf(nd) : s.node;
      if (i) items.push(h('i', null, '→'));
      items.push(h('button', { class: S.step === i ? 'on' : S.step != null && i < S.step ? 'past' : null, onclick: () => { stopPlay(); S.step = i; stepRender(); } }, (i + 1) + ' ' + nm + (s.pin && s.pin !== 'then' ? ' → ' + s.pin : '') + (s.error ? ' ⚠' : '')));
    });
    if (n === d.steps.length) { items.push(h('i', null, '→')); items.push(h('button', { class: S.step === n ? 'on' : null, onclick: () => { stopPlay(); S.step = n; stepRender(); } }, 'Findings checked')); }
    el.steps.hidden = false; put(el.steps, h('span', { class: 'mut' }, 'Run:'), ...items);
  } else { el.steps.hidden = !d; put(el.steps, d ? h('span', { class: 'mut' }, 'No exec flow: every finding is checked on its own.') : ''); }
  // notes / access notice
  const o = curOrder(), notes = [];
  if (S.rule.perOrder && o && o.inp && o.inp.missing.length) {
    if (!S.test.details) notes.push(h('div', { class: 'rx-note' }, h('span', null, 'Notes aren’t available without customer details access, so note checks can’t be tested. Also missing here: ' + o.inp.missing.filter((x) => x !== 'notes').map((x) => MISSING[x]).join(', ') + '.')));
    else if (o.locked) notes.push(h('div', { class: 'rx-note info' }, h('span', null, 'Notes are locked in this browser, so note checks can’t be tested yet.'), h('button', { class: 'btn sm p', onclick: unlockModal }, 'Unlock with your passphrase')));
    else if (o.inp.missing.includes('notes')) notes.push(h('div', { class: 'rx-note' }, h('span', null, 'This order’s notes weren’t loaded when the tracker saw it, so note checks wait, as they do in Assize.')));
  }
  if (d && d.needsNotes) notes.push(h('div', { class: 'rx-note' }, h('span', null, 'Some nodes on this run read notes this order doesn’t have here; they’re marked “needs notes”.')));
  if (S.ruleId === 'price-off-sheet') notes.push(h('div', { class: 'rx-note info' }, h('span', null, 'The price sheet isn’t on the admin site, so the price-sheet comparison doesn’t run here (the code rule raises nothing without it).')));
  put(el.note, ...notes);
}
const titleOf = (n) => n.label || (n.type === 'macro' ? ((lib().macros[(n.settings || {}).macro] || {}).title || 'Macro') : (RG.NODE_TYPES[n.type] || { title: n.type }).title);
// The last step index: the exec steps, plus one for the data-driven findings checked after the flow.
function maxStep() {
  const d = S.dbg;
  if (!d || !d.steps) return -1;
  const after = Object.entries(d.results || {}).some(([id, r]) => r.reached && !d.steps.some((s) => s.node === id));
  return d.steps.length - 1 + (after ? 1 : 0);
}
function stepRender() { renderDebug(); renderCanvas(); }
function startPlay() {
  const n = maxStep();
  if (n < 0) return;
  if (REDUCED()) { S.step = n; return stepRender(); }
  if (S.step == null || S.step >= n) S.step = 0;
  S.playing = setInterval(() => { if (!live() || S.step >= maxStep()) return stopPlay(true); S.step++; stepRender(); }, 750);
  stepRender();
}
function stopPlay(render) { if (S && S.playing) { clearInterval(S.playing); S.playing = 0; if (render) renderDebug(); } }

// ------------------------------------------------------------------ canvas
function buildStage() {
  const h = ui.h, st = el.stage;
  el.world = h('div', { class: 'rx-world' });
  el.world.innerHTML = '<svg class="rx-wires" width="10" height="10"></svg>';
  el.svg = el.world.firstChild;
  el.nodes = h('div');
  el.world.append(el.nodes);
  el.crumbs = h('div', { class: 'rx-crumbs', hidden: true });
  el.tools = h('div', { class: 'rx-tools' });
  el.legend = h('div', { class: 'rx-legend', 'aria-label': 'Wire types' }, h('span', null, h('i', { class: 'x' }), 'Exec'), ['bool', 'num', 'text', 'lines', 'notes', 'person'].map((t) => h('span', null, h('i', { style: 'background:var(--t-' + t + ')' }), TYPE_NAME[t])));
  el.hint = h('div', { class: 'rx-hint', hidden: true });
  el.pal = h('div', { class: 'rx-pal', hidden: true });
  el.box = h('div', { class: 'rx-box', hidden: true });
  put(st, el.world, el.crumbs, el.tools, el.legend, el.hint, el.pal, el.box);
  wireStage();
}
function applyView() { if (el.world) el.world.style.transform = 'translate(' + S.view.x + 'px,' + S.view.y + 'px) scale(' + S.view.z + ')'; }
function fit() {
  const g = level().g, W = el.stage.clientWidth, H = el.stage.clientHeight;
  if (!g || !g.nodes.length) { S.view = { x: 40, y: 60, z: 0.9 }; return applyView(); }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of g.nodes) { const e = el.nodes.querySelector('[data-node="' + CSS.escape(n.id) + '"]'); const w = e ? e.offsetWidth : 224, hh = e ? e.offsetHeight : 120; x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + w); y1 = Math.max(y1, n.y + hh); }
  const top = 50, bot = 40;
  const z = Math.max(0.25, Math.min(1.1, (W - 40) / (x1 - x0), (H - top - bot) / (y1 - y0)));
  S.view = { z, x: (W - (x1 - x0) * z) / 2 - x0 * z, y: top + Math.max(0, (H - top - bot - (y1 - y0) * z) / 2) - y0 * z };
  applyView();
}
function zoomAt(f, cx, cy) {
  const z = Math.max(0.2, Math.min(2, S.view.z * f));
  S.view.x = cx - (cx - S.view.x) * (z / S.view.z); S.view.y = cy - (cy - S.view.y) * (z / S.view.z); S.view.z = z;
  applyView();
}
// A client point → world coordinates.
function toWorld(cx, cy) { const r = el.stage.getBoundingClientRect(); return { x: (cx - r.left - S.view.x) / S.view.z, y: (cy - r.top - S.view.y) / S.view.z }; }

// State of a node on screen (the debug run, stepped).
function stateOf(key, isExec, id) {
  const d = S.dbg;
  if (!d || !d.nodes) return null;
  const x = d.nodes[key];
  if (!x) return null;
  if (S.step == null || S.step >= d.steps.length) return x.state;
  const cur = d.steps[S.step];
  if (isExec && !key.includes('/')) {
    const idx = d.steps.findIndex((s) => s.node === id);
    if (idx === -1) return x.state === 'ran' ? 'pending' : x.state;
    return idx < S.step ? 'ran' : idx === S.step ? 'cur' : 'pending';
  }
  if (x.state === 'used' || x.state === 'error') return x.order != null && x.order <= cur.at ? x.state : 'pending';
  return x.state;
}
function renderCanvas() {
  if (!live() || !el.stage) return;
  const lv = level(), g = lv.g, h = ui.h;
  if (!S.rule || !S.rule.perOrder || !g) {
    el.nodes.innerHTML = ''; el.svg.innerHTML = '';
    el.hint.hidden = false;
    put(el.hint, h('div', null, h('b', null, S.rule && !S.rule.perOrder ? 'No graph for this rule' : 'Nothing to show'), S.rule && !S.rule.perOrder ? 'It looks across orders. Use the On / Off switch above.' : ''));
    put(el.tools, ); el.crumbs.hidden = true;
    return;
  }
  const L = lib(), bad = levelErrors(), d = S.dbg, edit = lv.edit;
  const wired = new Set([...(g.wires || []).flatMap((w) => [w.from, w.to]), ...(g.flow || []).flatMap((w) => [w.from, w.to])]);
  const trace = (d && d.trace) || {};
  const valOf = (ref) => trace[lv.prefix + ref];
  let html = '';
  for (const n of g.nodes) {
    const def = RG.NODE_TYPES[n.type];
    if (!def) { html += '<div class="rx-node bad" data-node="' + esc(n.id) + '" style="left:' + n.x + 'px;top:' + n.y + 'px"><div class="nh"><b>Unknown node “' + esc(n.type) + '”</b></div></div>'; continue; }
    const pins = RG.pinsOf(n, L, lv.inside) || { inputs: [], outputs: [], exec: null };
    const key = lv.prefix + n.id, x = d && d.nodes ? d.nodes[key] : null;
    const st = stateOf(key, !!def.exec, n.id);
    const cls = ['rx-node', ['finding', 'reminder', 'chooseText', 'template'].includes(n.type) ? 'wide' : '', S.sel.has(n.id) ? 'sel' : '', bad.nodes.has(n.id) ? 'bad' : '',
      st === 'cur' ? 's-ran cur' : st ? 's-' + st : ''].filter(Boolean).join(' ');
    const [catName] = CAT[def.cat] || ['', ''];
    const title = S.renaming === n.id ? '<input data-rename="' + esc(n.id) + '" value="' + esc(n.label || '') + '" placeholder="' + esc(titleOf(Object.assign({}, n, { label: '' }))) + '" maxlength="80" aria-label="Node name">' : '<b title="' + esc(titleOf(n)) + (edit ? ' · double-click to rename' : '') + '">' + esc(titleOf(n)) + '</b>';
    let rows = '';
    // exec pins
    if (def.exec) {
      const outs = def.exec.outs, arrow = '<svg width="13" height="14" viewBox="0 0 13 14"><path d="M1.5 1.5h5.5l4.5 5.5-4.5 5.5H1.5z"/></svg>';
      for (let i = 0; i < Math.max(1, outs.length); i++) {
        const o = outs[i];
        const inPin = i === 0 && def.exec.in ? '<span class="pin x xl' + (wired.has(n.id + '.in') ? ' on' : '') + '" data-pin="' + esc(n.id) + '.in" data-dir="xin" title="Exec in">' + arrow + '</span>' : '';
        const outPin = o ? '<span class="lab" style="margin-left:auto">' + (o === 'then' ? '' : esc(pinLabel(o))) + '</span><span class="pin x xo' + (wired.has(n.id + '.' + o) ? ' on' : '') + '" data-pin="' + esc(n.id) + '.' + esc(o) + '" data-dir="xout" title="Exec out' + (o === 'then' ? '' : ': ' + esc(o)) + '">' + arrow + '</span>' : '';
        rows += '<div class="rw xr">' + inPin + outPin + '</div>';
      }
    }
    for (const p of pins.inputs) {
      const ref = n.id + '.' + p.name, w = (g.wires || []).find((x) => x.to === ref);
      const v = S.showVals && w ? show(valOf(w.from), p.type) : null;
      rows += '<div class="rw i"><span class="pin d' + (w ? ' on' : '') + '" data-pin="' + esc(ref) + '" data-dir="in" data-type="' + p.type + '" style="--pc:var(--t-' + p.type + ')" title="' + esc(TYPE_NAME[p.type] || p.type) + (p.req ? ' · required' : '') + '"></span><span class="lab">' + esc(pinLabel(p.name)) + (p.req && !w ? ' *' : '') + '</span>' + (v ? '<span class="val ' + (v.c || '') + '">' + esc(v.t) + '</span>' : '') + '</div>';
    }
    rows += summary(n, def, lv);
    let outs = pins.outputs;
    const many = outs.length > 8, open = S.morePins.has(key), anyWired = outs.some((p) => wired.has(n.id + '.' + p.name));
    if (many && !open && anyWired) outs = outs.filter((p) => wired.has(n.id + '.' + p.name));
    for (const p of outs) {
      const ref = n.id + '.' + p.name, v = S.showVals ? show(valOf(ref), p.type) : null;
      rows += '<div class="rw o">' + (v ? '<span class="val ' + (v.c || '') + '">' + esc(v.t) + '</span>' : '') + '<span class="lab">' + esc(pinLabel(p.name)) + '</span><span class="pin d' + (wired.has(ref) ? ' on' : '') + '" data-pin="' + esc(ref) + '" data-dir="out" data-type="' + p.type + '" style="--pc:var(--t-' + p.type + ')" title="' + esc(TYPE_NAME[p.type] || p.type) + '"></span></div>';
    }
    if (many && anyWired) rows += '<button class="more" data-more="' + esc(key) + '">' + (open ? 'Hide unwired pins' : 'Show all ' + pins.outputs.length + ' pins') + '</button>';
    if (n.type === 'macro') rows += '<button class="exp" data-expand="' + esc(n.id) + '">Expand ›</button>';
    if ((n.type === 'finding' || n.type === 'reminder') && d && d.results) rows += resultHtml(d.results[n.id], st);
    if (x && x.needsNotes && (Array.isArray(x.needsNotes) ? x.needsNotes.some((k) => wired.has(n.id + '.' + k)) : ['ran', 'used'].includes(x.state))) rows += '<span class="nn" title="Reads notes this order doesn’t have here">needs notes</span>';
    if (x && x.error) rows += '<div class="er">⚠ ' + esc(x.error) + '</div>';
    html += '<div class="' + cls + '" data-node="' + esc(n.id) + '" style="left:' + n.x + 'px;top:' + n.y + 'px"' + (x && x.error ? ' title="' + esc(x.error) + '"' : '') + '><div class="nh"><i class="c" style="background:var(--c-' + def.cat + ')"></i>' + title + '<small>' + esc(CAT[def.cat] ? CAT[def.cat][1] : catName) + '</small></div><div class="nb">' + rows + '</div></div>';
  }
  el.nodes.innerHTML = html;
  measure(); drawWires();
  // the rename box
  const ri = el.nodes.querySelector('[data-rename]');
  if (ri) { ri.focus(); ri.select(); }
  // empty graph hint, macro crumbs, tools
  const empty = !g.nodes.length;
  el.hint.hidden = !empty;
  if (empty) put(el.hint, h('div', null, h('b', null, 'An empty graph'), edit ? 'Start with a Start node: the run begins there. Right-click (or long-press) the canvas, or use + Add node.' : 'Nothing drawn yet.',
    edit && !lv.inside ? h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn sm p', onclick: () => addNode('start', 40, 40) }, 'Add a Start node')) : null));
  el.crumbs.hidden = !S.path.length;
  if (S.path.length) {
    const items = [h('button', { onclick: () => { S.path = []; S.sel = new Set(); S.fitted = ''; renderCanvas(); renderSide(); } }, shown().title || S.rule.title)];
    S.path.forEach((p, i) => { items.push(h('span', { class: 'mut' }, '›')); const m = lib().macros[p.macro] || {}; items.push(i === S.path.length - 1 ? h('b', null, m.title || p.macro) : h('button', { onclick: () => { S.path = S.path.slice(0, i + 1); S.sel = new Set(); S.fitted = ''; renderCanvas(); renderSide(); } }, m.title || p.macro)); });
    items.push(h('span', { class: 'mut sm' }, lv.own ? (lv.edit ? '· this graph’s own macro' : '') : '· built in, read only'));
    put(el.crumbs, ...items);
  }
  const t = (label, attrs) => h('button', attrs, label);
  put(el.tools, 
    edit ? t('+ Add node', { 'aria-expanded': String(!!S.pal), onclick: (e) => { e.stopPropagation(); if (S.pal) closePal(); else { const r = el.stage.getBoundingClientRect(); openPal(r.right - 290, r.top + 46, toWorld(r.left + r.width / 2, r.top + r.height / 2)); } } }) : null,
    edit ? t('Select', { class: S.selectMode ? 'on' : null, title: 'Drag to select a box of nodes (or hold Shift and drag)', 'aria-pressed': String(S.selectMode), onclick: () => { S.selectMode = !S.selectMode; renderCanvas(); } }) : null,
    edit ? t('↶', { title: 'Undo (⌘Z)', 'aria-label': 'Undo', disabled: !S.undo.length, onclick: () => undo(true) }) : null,
    edit ? t('↷', { title: 'Redo (⇧⌘Z)', 'aria-label': 'Redo', disabled: !S.redo.length, onclick: () => undo(false) }) : null,
    t('−', { 'aria-label': 'Zoom out', onclick: () => zoomAt(1 / 1.2, el.stage.clientWidth / 2, el.stage.clientHeight / 2) }),
    t('+', { 'aria-label': 'Zoom in', onclick: () => zoomAt(1.2, el.stage.clientWidth / 2, el.stage.clientHeight / 2) }),
    t('Fit', { onclick: fit }));
  el.stage.classList.toggle('boxing', S.selectMode);
  const fk = S.ruleId + '|' + S.scope + '|' + S.path.map((p) => p.node).join('/') + '|' + (S.hist ? S.hist.id : '');
  if (S.fitted !== fk && el.stage.clientWidth) { S.fitted = fk; fit(); } else applyView();
  renderProblems();
}
function resultHtml(r, st) {
  if (!r) return st === 'notReached' ? '<div class="res off">Not reached</div>' : '';
  const kind = r.kind ? '<span class="pill ' + esc(r.kind) + '">' + esc(KIND_NAME[r.kind] || r.kind) + '</span> ' : '';
  const blame = r.who ? ' · blames ' + esc(r.who.name || r.who.label || 'Unassigned') : '';
  if (r.error) return '<div class="res on"><b>Error:</b> ' + esc(r.error) + '</div>';
  const what = kind + '<b>' + esc(r.title || '') + '</b><br>' + esc(r.evidence || '(no evidence text)') + blame;
  if (r.raised) return '<div class="res on"><b>Raised:</b> ' + what + '</div>';
  if (!r.reached && r.wouldRaise) return '<div class="res would"><b>Not reached — would raise:</b> ' + what + '</div>';
  if (!r.reached) return '<div class="res off"><b>Not reached</b> · When is no, so it wouldn’t raise either<br><span>' + esc(r.evidence || '') + '</span></div>';
  return '<div class="res off"><b>Wouldn’t raise</b> (When is no)<br><span>Evidence it would use: ' + esc(r.evidence || '(none)') + '</span></div>';
}
// A node's settings, shortly, on the node itself.
function summary(n, def, lv) {
  const s = n.settings || {}, g = lv.g;
  const unwired = (k) => !(g.wires || []).some((w) => w.to === n.id + '.' + k);
  const chips = (list, f) => { const a = (list || []).slice(0, 8).map((x) => '<span>' + esc(f ? f(x) : x) + '</span>').join(''); return '<div class="ch">' + (a || '<span>(none)</span>') + ((list || []).length > 8 ? '<span>+' + (list.length - 8) + '</span>' : '') + '</div>'; };
  const box = (x) => '<div class="set">' + x + '</div>';
  switch (n.type) {
    case 'programIs': return box('One of ' + chips(s.programs, (k) => (PROGRAMS.find((p) => p[0] === k) || [k, k])[1]));
    case 'statusIs': return box(((s.statuses || []).length ? 'Status ' + (s.match === 'contains' ? 'contains' : 'is') + ' ' + chips(s.statuses) : 'Any status') + ((s.outcomes || []).length ? 'Outcome ' + chips(s.outcomes) : ''));
    case 'deviceIs': return box('Is a ' + esc(s.kind || 'phone'));
    case 'notesMention': return box('Any of ' + chips(s.words) + (s.skipNegated !== false ? '<span class="mut">Skips negated (“no water”)</span>' : ''));
    case 'matchesPattern': return box(esc(PATTERNS[s.pattern] || s.pattern || 'No pattern') + (s.skipNegated ? '<br><span class="mut">Skips negated</span>' : ''));
    case 'atMost': case 'atLeast': return unwired('limit') ? box((n.type === 'atMost' ? '≤ ' : '≥ ') + esc(s.limit ?? 0)) : '';
    case 'between': return box(esc(unwired('min') ? s.min ?? 0 : 'min') + ' ≤ value ≤ ' + esc(unwired('max') ? s.max ?? 0 : 'max'));
    case 'equals': return unwired('b') ? box('= ' + esc(s.b ?? 0) + (Number(s.tolerance) ? ' ± ' + esc(s.tolerance) : '')) : '';
    case 'subtract': return unwired('b') ? box('− ' + esc(s.b ?? 0)) : '';
    case 'constant': return box((s.type || 'num') === 'text' ? '“' + esc(s.value || '') + '”' : esc(s.value ?? 0));
    case 'template': return box('“' + esc(s.text || '').replace(/\{(\w+)\}/g, '<b>{$1}</b>') + '”');
    case 'chooseText': return box(['then1', 'then2', 'then3', 'else'].filter((k) => unwired(k) && s[k] != null && s[k] !== '').map((k) => esc(pinLabel(k)) + ' → “' + esc(s[k]) + '”').join('<br>') || '<span class="mut">Texts come from the wires</span>');
    case 'filterLines': {
      const bits = ['credit', 'neverFlag', 'deposit'].filter((k) => s[k] && s[k] !== 'any').map((k) => (s[k] === 'drop' ? 'drop ' : 'keep only ') + { credit: 'partner credits', neverFlag: 'misc labor / buybacks', deposit: 'deposits' }[k]);
      if (s.price && s.price !== 'any') bits.push(s.price + ' prices');
      if ((s.skus || []).length || (s.names || []).length) bits.push((s.match === 'drop' ? 'drop ' : 'keep ') + [...(s.skus || []), ...(s.names || [])].join(', '));
      return box(esc(bits.join(' · ') || 'Every line'));
    }
    case 'finding': case 'reminder': {
      const kind = n.type === 'reminder' ? 'remind' : s.kind || 'note';
      return box('<span class="pill ' + kind + '">' + KIND_NAME[kind] + '</span> <b>' + esc(s.title || g.title || '') + '</b><br><span class="mut">' + esc(CHECK_NAME[s.check || (n.type === 'reminder' ? 'remind' : g.check)] || s.check || g.check || 'No section') + (unwired('evidence') && s.evidence ? ' · “' + esc(s.evidence) + '”' : '') + '</span>');
    }
    case 'macro': { const m = lib().macros[s.macro]; return box(m ? (RG.MACROS[s.macro] && !(shown().macros || {})[s.macro] ? 'Built-in macro' : 'This graph’s macro') + ' · ' + plural((m.nodes || []).length, 'node') : 'Unknown macro ' + esc(s.macro || '')); }
    default: return '';
  }
}
// Pin positions relative to their node (world units), measured once per render.
const pinRel = new Map();
function measure() {
  pinRel.clear();
  const z = S.view.z;
  for (const ne of el.nodes.children) {
    const id = ne.dataset.node, r0 = ne.getBoundingClientRect();
    for (const p of ne.querySelectorAll('[data-pin]')) { const r = p.getBoundingClientRect(); pinRel.set(p.dataset.pin, { id, dx: (r.left + r.width / 2 - r0.left) / z, dy: (r.top + r.height / 2 - r0.top) / z }); }
  }
}
function pinAt(ref, g) { const r = pinRel.get(ref); if (!r) return null; const n = nodeById(g, r.id); return n ? { x: n.x + r.dx, y: n.y + r.dy } : null; }
const curve = (a, b) => { const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5); return 'M' + a.x + ' ' + a.y + ' C' + (a.x + dx) + ' ' + a.y + ',' + (b.x - dx) + ' ' + b.y + ',' + b.x + ' ' + b.y; };
function drawWires(tmp) {
  const lv = level(), g = lv.g, d = S.dbg, L = lib();
  if (!g) return;
  const bad = levelErrors().wires, trace = (d && d.trace) || {};
  let vis = '', hit = '', labels = '';
  const stepAt = S.step;
  (g.wires || []).forEach((w, i) => {
    const a = pinAt(w.from, g), b = pinAt(w.to, g);
    if (!a || !b) return;
    const [nid, pn] = split(w.from), n = nodeById(g, nid), pins = n && RG.pinsOf(n, L, lv.inside), o = pins && pins.outputs.find((x) => x.name === pn);
    const type = o ? o.type : 'any';
    const src = d && d.nodes ? stateOf(lv.prefix + nid, false, nid) : null;
    const dim = d && (src === 'idle' || src === 'notReached' || src === 'pending' || !src);
    const path = curve(a, b), sel = S.wire && S.wire.kind === 'd' && S.wire.i === i;
    vis += '<path class="w' + (dim ? ' dim' : '') + (sel ? ' sel' : '') + (bad.has(w.from + '>' + w.to) ? ' bad' : '') + '" d="' + path + '" stroke="var(--t-' + type + ')" stroke-width="' + (sel ? 3.6 : 2.3) + '"/>';
    hit += '<path class="hit" data-w="d:' + i + '" d="' + path + '"><title>' + esc(TYPE_NAME[type] || type) + ': ' + esc(w.from) + ' → ' + esc(w.to) + '</title></path>';
    if (S.showVals && d && (type === 'bool' || type === 'num' || type === 'text' || type === 'person')) {
      const v = show(trace[lv.prefix + w.from], type);
      if (v) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, wd = v.t.length * 6.4 + 12;
        labels += '<g class="wl ' + (v.c || '') + (dim ? ' dim' : '') + '"><rect x="' + (mx - wd / 2) + '" y="' + (my - 9) + '" width="' + wd + '" height="18" rx="9"/><text x="' + mx + '" y="' + (my + 3.6) + '" text-anchor="middle">' + esc(v.t) + '</text></g>';
      }
    }
  });
  if (!lv.inside) {
    const taken = new Map((d && d.execWires ? d.execWires : []).map((w, i) => [w.index, i]));
    (g.flow || []).forEach((w, i) => {
      const a = pinAt(w.from, g), b = pinAt(w.to, g);
      if (!a || !b) return;
      const k = taken.get(i), on = k != null && (stepAt == null || k < stepAt);
      const path = curve(a, b), sel = S.wire && S.wire.kind === 'x' && S.wire.i === i;
      vis += '<path class="w x' + (on ? ' run' : d ? ' dim' : '') + (sel ? ' sel' : '') + (bad.has(w.from + '>' + w.to) ? ' bad' : '') + '" d="' + path + '" stroke-width="' + (sel ? 5 : on ? 4.2 : 3.4) + '"/>';
      hit += '<path class="hit" data-w="x:' + i + '" d="' + path + '"><title>Exec: ' + esc(w.from) + ' → ' + esc(w.to) + '</title></path>';
      if (on) { const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; labels += '<g class="no"><circle cx="' + mx + '" cy="' + my + '" r="9"/><text x="' + mx + '" y="' + (my + 3.8) + '" text-anchor="middle">' + (k + 1) + '</text></g>'; }
    });
  }
  if (tmp) vis += '<path class="tmp" d="' + tmp.path + '" stroke="' + tmp.color + '"/>';
  el.svg.innerHTML = vis + hit + labels;
  // exec pins lit along the run
  if (d && !lv.inside) for (const w of d.execWires.filter((_, i) => stepAt == null || i < stepAt)) for (const ref of [w.from, w.to]) { const p = el.nodes.querySelector('[data-pin="' + CSS.escape(ref) + '"]'); if (p) p.classList.add('run'); }
}
function renderProblems() {
  const h = ui.h, errs = S.errors;
  if (!S.rule || !S.rule.perOrder) { el.probs.hidden = true; return; }
  el.probs.hidden = false;
  el.probs.className = 'rx-probs' + (errs.length ? '' : ' ok');
  if (!errs.length) return put(el.probs, h('b', null, '✓ No problems'), h('span', { class: 'mut sm' }, 'The graph checks out' + (S.hist ? '' : ' and can be published') + '.'));
  put(el.probs, h('b', null, plural(errs.length, 'problem')), ...errs.slice(0, 12).map((e) => h('button', { onclick: () => {
    const m = e.match(/^(?:Macro \S+: )?([A-Za-z0-9_-]+)(?: \(|:)/);
    if (m && level().g.nodes.some((n) => n.id === m[1])) { S.sel = new Set([m[1]]); S.wire = null; renderCanvas(); renderSide(); centerOn(m[1]); }
  } }, e)), errs.length > 12 ? h('span', { class: 'mut sm' }, '+' + (errs.length - 12) + ' more') : null);
}
function centerOn(id) {
  const n = nodeById(level().g, id); if (!n) return;
  S.view.x = el.stage.clientWidth / 2 - (n.x + 110) * S.view.z; S.view.y = el.stage.clientHeight / 2 - (n.y + 40) * S.view.z; applyView();
}

// ------------------------------------------------------------------ canvas input: pan, zoom, select, drag, wire
function wireStage() {
  const st = el.stage, ptrs = new Map();
  let mode = null, lp = 0;
  st.addEventListener('wheel', (e) => {
    if (e.target.closest('.rx-pal')) return;
    e.preventDefault();
    const r = st.getBoundingClientRect();
    // Scrolling pans; a pinch (ctrlKey on a trackpad) or ⌘/Ctrl + wheel zooms.
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; applyView(); }
  }, { passive: false });
  st.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.rx-pal,.rx-tools,.rx-legend,.rx-crumbs') || !level().edit) return;
    e.preventDefault();
    openPal(e.clientX, e.clientY, toWorld(e.clientX, e.clientY));
  });
  st.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.nh b');
    if (!t || !level().edit) return;
    S.renaming = t.closest('[data-node]').dataset.node; renderCanvas();
  });
  st.addEventListener('keydown', (e) => {
    if (e.target.matches('[data-rename]')) {
      if (e.key === 'Enter') e.target.blur();
      if (e.key === 'Escape') { S.renaming = null; renderCanvas(); }
      e.stopPropagation();
    }
  });
  st.addEventListener('focusout', (e) => {
    if (!e.target.matches('[data-rename]')) return;
    const id = e.target.dataset.rename, v = e.target.value.trim().slice(0, 80);
    S.renaming = null;
    const n = nodeById(level().g, id);
    if (n && (n.label || '') !== v) commit((g) => { const x = nodeById(g, id); if (v) x.label = v; else delete x.label; }); else renderCanvas();
  });
  st.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { const k = more.dataset.more; if (S.morePins.has(k)) S.morePins.delete(k); else S.morePins.add(k); return renderCanvas(); }
    const ex = e.target.closest('[data-expand]');
    if (ex) { const n = nodeById(level().g, ex.dataset.expand); if (n) { S.path.push({ node: n.id, macro: (n.settings || {}).macro }); S.sel = new Set(); S.wire = null; S.fitted = ''; renderCanvas(); renderSide(); } }
  });
  st.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.rx-pal,.rx-tools,.rx-legend,.rx-crumbs,.rx-hint>div,input,button')) return;
    if (e.button === 2) return;
    if (S.pal) closePal();
    st.focus({ preventScroll: true });
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { mode && mode.cancel && mode.cancel(); mode = pinch(); return; }
    const lv = level();
    const pin = e.target.closest('[data-pin]'), hitW = e.target.closest('[data-w]'), node = e.target.closest('[data-node]');
    if (pin && lv.edit) {
      if (e.altKey) { const ref = pin.dataset.pin; return commit((g) => { g.wires = g.wires.filter((w) => w.from !== ref && w.to !== ref); if (g.flow) g.flow = g.flow.filter((w) => w.from !== ref && w.to !== ref); }); }
      mode = wireDrag(e, pin); return;
    }
    if (hitW) { const [k, i] = hitW.dataset.w.split(':'); S.wire = { kind: k, i: Number(i) }; S.sel = new Set(); renderCanvas(); renderSide(); return; }
    if (node) {
      const id = node.dataset.node;
      if (e.shiftKey || e.metaKey || e.ctrlKey) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); }
      else if (!S.sel.has(id)) S.sel = new Set([id]);
      S.wire = null;
      for (const ne of el.nodes.children) ne.classList.toggle('sel', S.sel.has(ne.dataset.node));
      renderSide();
      if (lv.edit && S.sel.has(id)) mode = nodeDrag(e);
      return;
    }
    if (e.shiftKey || S.selectMode) { mode = boxSelect(e); return; }
    mode = panDrag(e);
    if (e.pointerType !== 'mouse' && lv.edit) { const x = e.clientX, y = e.clientY; lp = setTimeout(() => { if (mode && !mode.moved) { mode = null; openPal(x, y, toWorld(x, y)); } }, 550); }
  });
  const move = (e) => { if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (mode) mode.move(e); };
  const up = (e) => { if (!ptrs.has(e.pointerId)) return; ptrs.delete(e.pointerId); clearTimeout(lp); if (mode) { const m = mode; mode = null; m.up(e); } };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  function panDrag(e) {
    const sx = e.clientX - S.view.x, sy = e.clientY - S.view.y, x0 = e.clientX, y0 = e.clientY;
    const m = { moved: false, move(ev) { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 6) { m.moved = true; st.classList.add('pan'); } S.view.x = ev.clientX - sx; S.view.y = ev.clientY - sy; applyView(); },
      up() { st.classList.remove('pan'); if (!m.moved && (S.sel.size || S.wire)) { S.sel = new Set(); S.wire = null; renderCanvas(); renderSide(); } } };
    return m;
  }
  function pinch() {
    const pts = () => [...ptrs.values()], dist = () => { const [a, b] = pts(); return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
    let d0 = dist();
    return { moved: true, move() { if (ptrs.size < 2) return; const [a, b] = pts(), r = st.getBoundingClientRect(), d = dist(); zoomAt(d / d0, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); d0 = d; }, up() {} };
  }
  function boxSelect(e) {
    const r = st.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const base = e.shiftKey ? new Set(S.sel) : new Set();
    el.box.hidden = false; Object.assign(el.box.style, { left: x0 + 'px', top: y0 + 'px', width: '0px', height: '0px' });
    return { moved: true, move(ev) {
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top, L = Math.min(x0, x1), T = Math.min(y0, y1), W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
      Object.assign(el.box.style, { left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px' });
      const a = toWorld(r.left + L, r.top + T), b = toWorld(r.left + L + W, r.top + T + H);
      S.sel = new Set(base);
      for (const ne of el.nodes.children) { const n = nodeById(level().g, ne.dataset.node); if (n && n.x < b.x && n.x + ne.offsetWidth > a.x && n.y < b.y && n.y + ne.offsetHeight > a.y) S.sel.add(n.id); ne.classList.toggle('sel', S.sel.has(ne.dataset.node)); }
    }, up() { el.box.hidden = true; S.wire = null; renderSide(); } };
  }
  function nodeDrag(e) {
    const g = level().g, ids = [...S.sel], start = ids.map((id) => { const n = nodeById(g, id); return n && [n, n.x, n.y]; }).filter(Boolean), x0 = e.clientX, y0 = e.clientY;
    let moved = false, before = null;
    return { move(ev) {
      const dx = (ev.clientX - x0) / S.view.z, dy = (ev.clientY - y0) / S.view.z;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      if (!moved) { moved = true; before = JSON.stringify(S.graph); }
      for (const [n, x, y] of start) { n.x = Math.round(x + dx); n.y = Math.round(y + dy); const ne = el.nodes.querySelector('[data-node="' + CSS.escape(n.id) + '"]'); if (ne) { ne.style.left = n.x + 'px'; ne.style.top = n.y + 'px'; } }
      drawWires();
    }, up() { if (moved) { S.undo.push(before); S.redo = []; scheduleSave(); renderCanvasTools(); } } };
  }
  function wireDrag(e, pinEl) {
    const lv = level(), g = lv.g, ref = pinEl.dataset.pin, dir = pinEl.dataset.dir, type = pinEl.dataset.type;
    const [nid] = split(ref), exec = dir === 'xin' || dir === 'xout';
    const from = pinAt(ref, g);
    // mark what fits
    st.classList.add('wiring');
    const verdict = (p) => {
      const d2 = p.dataset.dir, [n2] = split(p.dataset.pin);
      if (n2 === nid) return "A node can't wire to itself";
      if (exec !== (d2 === 'xin' || d2 === 'xout')) return exec ? 'Exec pins only connect to exec pins' : 'Data pins only connect to data pins';
      if (exec) return (dir === 'xout' && d2 === 'xin') || (dir === 'xin' && d2 === 'xout') ? null : 'Connect an exec output to an exec input';
      if (!((dir === 'out' && d2 === 'in') || (dir === 'in' && d2 === 'out'))) return 'Connect an output to an input';
      const a = dir === 'out' ? type : p.dataset.type, b = dir === 'out' ? p.dataset.type : type;
      return fits(a, b) ? null : (TYPE_NAME[a] || a) + ' doesn’t fit ' + (TYPE_NAME[b] || b);
    };
    for (const p of el.nodes.querySelectorAll('[data-pin]')) if (p !== pinEl) p.classList.add(verdict(p) ? 'nofit' : 'fit');
    const color = exec ? 'var(--exec)' : 'var(--t-' + type + ')';
    return { move(ev) {
      const w = toWorld(ev.clientX, ev.clientY);
      const a = dir === 'out' || dir === 'xout' ? from : w, b = dir === 'out' || dir === 'xout' ? w : from;
      drawWires({ path: curve(a, b), color });
    }, up(ev) {
      st.classList.remove('wiring');
      for (const p of el.nodes.querySelectorAll('.fit,.nofit')) p.classList.remove('fit', 'nofit');
      const tgt = document.elementFromPoint(ev.clientX, ev.clientY), p = tgt && tgt.closest('[data-pin]');
      if (!p || p === pinEl) { drawWires(); return; }
      const why = verdict(p);
      if (why) { drawWires(); return ui.toast(why); }
      const other = p.dataset.pin;
      if (exec) {
        const out = dir === 'xout' ? ref : other, into = split(dir === 'xout' ? other : ref)[0] + '.in';
        commit((gg) => { gg.flow = (gg.flow || []).filter((w) => w.from !== out); gg.flow.push({ from: out, to: into }); });
      } else {
        const out = dir === 'out' ? ref : other, into = dir === 'out' ? other : ref;
        commit((gg) => { gg.wires = (gg.wires || []).filter((w) => w.to !== into); gg.wires.push({ from: out, to: into }); });
      }
    } };
  }
}
function renderCanvasTools() { /* undo / redo enable states */ const b = el.tools && el.tools.querySelectorAll('button'); if (!b) return; for (const x of b) { if (x.getAttribute('aria-label') === 'Undo') x.disabled = !S.undo.length; if (x.getAttribute('aria-label') === 'Redo') x.disabled = !S.redo.length; } }

// ------------------------------------------------------------------ palette
function openPal(cx, cy, at) {
  const h = ui.h, lv = level(), r = el.stage.getBoundingClientRect();
  S.pal = { at };
  const q = h('input', { type: 'text', placeholder: 'Find a node', 'aria-label': 'Find a node' });
  const ls = h('div', { class: 'ls' });
  const items = [];
  for (const [type, def] of Object.entries(RG.NODE_TYPES)) {
    if (type === 'macro' || type === 'macroOut') continue;
    if (type === 'macroIn' && !(lv.inside && !lv.g.nodes.some((n) => n.type === 'macroIn'))) continue;
    if (lv.inside && def.exec) continue;
    if (type === 'start' && lv.g.nodes.some((n) => n.type === 'start')) continue;
    items.push({ cat: def.cat, title: def.title, desc: def.desc, add: () => addNode(type, at.x, at.y) });
  }
  for (const [name, m] of Object.entries(lib().macros)) if (!(lv.name && name === lv.name)) items.push({ cat: 'macro', title: m.title || name, desc: (m.desc || '') + ((shown().macros || {})[name] ? ' (this graph’s)' : ' (built in)'), add: () => addNode('macro', at.x, at.y, { macro: name }) });
  const fill = () => {
    const t = q.value.trim().toLowerCase(), out = [];
    for (const c of [...CAT_ORDER, 'macro']) {
      const its = items.filter((x) => x.cat === c && (!t || (x.title + ' ' + x.desc).toLowerCase().includes(t)));
      if (!its.length) continue;
      out.push(h('b', null, c === 'macro' ? 'Macros (collapsed nodes)' : CAT[c][0]));
      for (const x of its) out.push(h('button', { onclick: () => { closePal(); x.add(); } }, h('i', { style: 'background:var(--c-' + (c === 'macro' ? 'logic' : c) + ')' }), h('span', null, x.title, h('small', null, x.desc))));
    }
    put(ls, ...(out.length ? out : [h('p', { class: 'mut sm', style: 'padding:6px 8px' }, 'No node matches.')]));
  };
  q.addEventListener('input', fill);
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePal(); if (e.key === 'Enter') { const b = ls.querySelector('button'); if (b) b.click(); } });
  fill();
  put(el.pal, q, ls);
  el.pal.hidden = false;
  const W = 270, x = Math.max(8, Math.min(cx - r.left, r.width - W - 8)), y = Math.max(8, Math.min(cy - r.top, r.height - 300));
  Object.assign(el.pal.style, { left: x + 'px', top: y + 'px' });
  setTimeout(() => q.focus(), 0);
}
function closePal() { S.pal = null; if (el.pal) el.pal.hidden = true; }

// ------------------------------------------------------------------ keyboard
let keysBound = false;
function bindKeys() {
  if (keysBound) return; keysBound = true;
  document.addEventListener('keydown', (e) => {
    if (!S || !live() || !el.stage) return;
    const t = e.target;
    if (t && (t.matches('input,textarea,select,[contenteditable]') || t.closest('.rx-modal'))) return;
    if (!el.root.contains(t) && t !== document.body) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (k === 'escape') { if (S.pal) closePal(); else if (S.sel.size || S.wire) { S.sel = new Set(); S.wire = null; renderCanvas(); renderSide(); } return; }
    if (!level().edit) return;
    if ((k === 'delete' || k === 'backspace') && (S.sel.size || S.wire)) { e.preventDefault(); removeSelected(); return; }
    if (mod && k === 'z') { e.preventDefault(); undo(!e.shiftKey); return; }
    if (mod && k === 'y') { e.preventDefault(); undo(false); return; }
    if (mod && k === 'c') { if (copySel()) { e.preventDefault(); ui.toast('Copied ' + plural(clip.nodes.nodes.length, 'node')); } return; }
    if (mod && k === 'v') { e.preventDefault(); paste(); return; }
    if (mod && k === 'd') { e.preventDefault(); if (copySel()) paste(); return; }
    if (mod && k === 'a') { e.preventDefault(); S.sel = new Set(level().g.nodes.map((n) => n.id)); renderCanvas(); renderSide(); }
  });
}

// ------------------------------------------------------------------ side: inspector, history, today's orders
function renderSide() {
  if (!live()) return;
  bindKeys();
  const h = ui.h;
  put(el.side, 
    h('div', { class: 'rx-tabs', role: 'tablist' }, [['node', 'Inspector'], ['history', 'History' + (S.rule ? ' (' + S.rule.history.length + ')' : '')]].map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(S.side === k), class: S.side === k ? 'on' : null, onclick: () => { S.side = k; renderSide(); } }, l))),
    el.ins = h('div', { class: 'rx-ins' }),
    h('div', { class: 'rx-hr' }),
    el.cmp = h('div', { class: 'rx-ins rx-cmp' }));
  if (S.side === 'history') renderHistory(); else renderInspector();
  renderCompareView();
  if (S.refocus) { const x = el.side.querySelector(S.refocus); S.refocus = null; if (x) x.focus(); }
}
function renderHistory() {
  const h = ui.h, r = S.rule;
  if (!r) return put(el.ins, );
  const list = r.history;
  put(el.ins, h('h4', null, 'History'), h('p', null, 'Every publish keeps its graph. Restoring copies it into the draft; it doesn’t publish by itself.'),
    list.length ? h('div', { class: 'rx-hist' }, list.map((x) => h('div', { class: S.hist && S.hist.id === x.id ? 'on' : null },
      h('div', null, h('b', null, (ACTION[x.action] || x.action) + (x.version ? ' · v' + x.version : '')), ' ', h('span', { class: 'pill st' }, x.scope === 'all' ? 'All stores' : x.scope)),
      h('div', { class: 'mut sm' }, who(x.by) + ' · ' + ui.fmt(x.at)), x.note ? h('div', { class: 'sm' }, '“' + x.note + '”') : null,
      x.hasGraph ? h('div', { class: 'a' }, h('button', { class: 'btn sm', onclick: () => viewVersion(x) }, 'View'),
        x.action === 'publish' && canEdit(S.scope) && r.perOrder ? h('button', { class: 'btn sm', onclick: () => restore(x) }, 'Restore as draft') : null) : null))) : h('p', null, 'Nothing yet.'));
}
async function viewVersion(x) {
  try {
    const v = await ui.api('GET', '/tracker/assize/rules/' + S.ruleId + '/history/' + x.id);
    S.hist = v; S.path = []; S.sel = new Set(); S.wire = null; S.fitted = '';
    renderAll();
  } catch (e) { ui.toast("Couldn't open that version: " + e.message); }
}
function renderInspector() {
  const h = ui.h, lv = level(), g = lv.g;
  if (!S.rule) return put(el.ins, );
  if (!S.rule.perOrder) return put(el.ins, h('h4', null, S.rule.title), h('p', null, 'Assize checks this one across orders, so it stays in the code. Turn it on or off with the switch above, for all stores or one.'));
  if (!g) return put(el.ins, );
  const edit = lv.edit;
  // a wire
  if (S.wire) {
    const list = S.wire.kind === 'x' ? g.flow : g.wires, w = list && list[S.wire.i];
    if (!w) { S.wire = null; return renderInspector(); }
    const [nid, pn] = split(w.from), n = nodeById(g, nid), pins = n && RG.pinsOf(n, lib(), lv.inside), o = pins && (pins.outputs.find((x) => x.name === pn));
    const type = S.wire.kind === 'x' ? 'exec' : o ? o.type : 'any';
    const v = S.dbg && S.dbg.trace ? S.dbg.trace[lv.prefix + w.from] : undefined;
    const taken = S.wire.kind === 'x' && S.dbg && S.dbg.execWires.find((x) => x.index === S.wire.i);
    return put(el.ins, h('h4', null, S.wire.kind === 'x' ? 'Exec wire' : 'Data wire'),
      h('dl', { class: 'rx-kv' }, h('dt', null, 'From'), h('dd', null, titleOf(n || { type: '?' }) + ' · ' + pinLabel(pn)), h('dt', null, 'To'), h('dd', null, (() => { const t = nodeById(g, split(w.to)[0]); return titleOf(t || { type: '?' }) + ' · ' + pinLabel(split(w.to)[1]); })()),
        h('dt', null, 'Type'), h('dd', null, type === 'exec' ? 'Exec (the order things run in)' : TYPE_NAME[type] || type)),
      S.wire.kind === 'x' ? h('p', null, taken ? 'Taken on this run (step ' + (S.dbg.execWires.indexOf(taken) + 1) + ').' : S.dbg ? 'Not taken on this run.' : '') : h('div', { class: 'rx-fld' }, h('span', null, 'Value on this run'), h('pre', { class: 'rx-pre' }, S.dbg ? full(v) : 'Pick a test order to see it.')),
      edit ? h('button', { class: 'btn sm dg', onclick: removeSelected }, 'Delete wire') : null);
  }
  // several nodes
  if (S.sel.size > 1) {
    return put(el.ins, h('h4', null, plural(S.sel.size, 'node') + ' selected'), h('p', null, 'Drag one to move them all. ⌘C / ⌘V copy and paste, ⌘D duplicates, Delete removes.'),
      edit ? h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, h('button', { class: 'btn sm', onclick: () => { if (copySel()) paste(); } }, 'Duplicate'), !lv.inside ? h('button', { class: 'btn sm', onclick: collapse }, 'Collapse into a node') : null, h('button', { class: 'btn sm dg', onclick: removeSelected }, 'Delete')) : null);
  }
  // one node
  const id = [...S.sel][0], n = id && nodeById(g, id);
  if (!n) return graphInspector(lv);
  const def = RG.NODE_TYPES[n.type];
  if (!def) return put(el.ins, h('h4', null, 'Unknown node “' + n.type + '”'), edit ? h('button', { class: 'btn sm dg', onclick: removeSelected }, 'Delete') : null);
  const key = lv.prefix + n.id, x = S.dbg && S.dbg.nodes ? S.dbg.nodes[key] : null, s = n.settings || {};
  const set = (k, v) => commit((gg) => { const m = nodeById(gg, n.id); m.settings = Object.assign({}, m.settings, { [k]: v }); if (v === undefined) delete m.settings[k]; }, { keepInspector: false });
  const out = [h('div', { class: 'mut sm' }, (CAT[def.cat] || ['', ''])[1] + ' node · ' + def.title), h('h4', null, titleOf(n)), h('p', null, def.desc)];
  const STATE = { ran: 'Ran on this order', used: 'Worked out on this order (something that ran needed it)', idle: 'Not needed on this order (worked out only to show its values)', notReached: 'Execution never reached it on this order', error: 'Failed on this order' };
  if (x) out.push(h('p', null, h('b', null, STATE[x.state] || x.state), x.error ? ': ' + x.error : '', x.needsNotes ? ' · needs notes this order doesn’t have here' : ''));
  if (edit) out.push(h('label', { class: 'rx-fld' }, h('span', null, 'Name on the canvas'), h('input', { type: 'text', value: n.label || '', placeholder: def.title, maxlength: 80, onchange: (e) => commit((gg) => { const m = nodeById(gg, n.id), v = e.target.value.trim(); if (v) m.label = v; else delete m.label; }) })));
  for (const f of def.settings || []) out.push(field(n, f, s, set, edit, lv));
  if (n.type === 'finding' || n.type === 'reminder') {
    const sig = ['sig1', 'sig2', 'sig3'].map((k) => [k, (g.wires || []).find((w) => w.to === n.id + '.' + k)]).filter(([, w]) => w);
    out.push(h('div', { class: 'rx-fld' }, h('span', null, 'Dismissal signature'), h('p', null, sig.length ? 'A dismissal stops applying when any of these change: ' + sig.map(([, w]) => titleOf(nodeById(g, split(w.from)[0]) || { type: '?' }) + ' · ' + pinLabel(split(w.from)[1])).join(', ') + '.' : 'Nothing wired to Signature 1–3: a dismissal keeps applying even when the order’s facts change.')),
      h('p', { class: 'sm' }, 'Raises rule ', h('b', null, S.ruleId), '. When it should match a code rule, the signature must use the same facts in the same order.'));
    const r = S.dbg && S.dbg.results && S.dbg.results[n.id];
    if (r) out.push(h('div', { class: 'rx-fld' }, h('span', null, 'On this order'), h('div', { html: resultHtml(r, x && x.state) })));
  }
  if (n.type === 'macro') {
    const m = lib().macros[s.macro], own = !!(shown().macros || {})[s.macro];
    out.push(h('button', { class: 'btn sm', onclick: () => { S.path.push({ node: n.id, macro: s.macro }); S.sel = new Set(); S.fitted = ''; renderCanvas(); renderSide(); } }, own && edit ? 'Expand and edit' : 'Expand (read only)'));
    if (m && own && edit) out.push(h('label', { class: 'rx-fld' }, h('span', null, 'Macro title'), h('input', { type: 'text', value: m.title || '', onchange: (e) => commit(() => { S.graph.macros[s.macro].title = e.target.value.trim() || s.macro; }) })));
  }
  // values on its pins
  const pins = RG.pinsOf(n, lib(), lv.inside), tr = (S.dbg && S.dbg.trace) || {};
  if (pins && S.dbg && pins.outputs.length) out.push(h('div', { class: 'rx-fld' }, h('span', null, 'Outputs on this order'), h('dl', { class: 'rx-kv' }, pins.outputs.flatMap((p) => [h('dt', null, pinLabel(p.name)), h('dd', { title: full(tr[key + '.' + p.name]) }, (show(tr[key + '.' + p.name], p.type) || { t: '—' }).t)]))));
  if (edit) out.push(h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, n.type !== 'start' ? h('button', { class: 'btn sm', onclick: () => { if (copySel()) paste(); } }, 'Duplicate') : null, h('button', { class: 'btn sm dg', onclick: removeSelected }, 'Delete node')));
  put(el.ins, ...out);
}
function graphInspector(lv) {
  const h = ui.h, g = lv.g, edit = lv.edit, out = [];
  if (lv.inside) {
    const m = g;
    out.push(h('div', { class: 'mut sm' }, 'Macro'), h('h4', null, m.title || lv.name), h('p', null, m.desc || 'A collapsed set of nodes. Its inputs and outputs are the pins on the collapsed node.'));
    if (edit) {
      out.push(h('label', { class: 'rx-fld' }, h('span', null, 'Title'), h('input', { type: 'text', value: m.title || '', onchange: (e) => commit((gg) => { gg.title = e.target.value.trim() || lv.name; }) })));
      for (const side of ['inputs', 'outputs']) {
        out.push(h('div', { class: 'rx-fld' }, h('span', null, side === 'inputs' ? 'Inputs' : 'Outputs'),
          ...(m[side] || []).map((p, i) => h('div', { style: 'display:flex;gap:6px' },
            h('input', { type: 'text', value: p.name, 'aria-label': 'Name', style: 'flex:1', onchange: (e) => { const v = e.target.value.trim().replace(/[^A-Za-z0-9_]/g, ''); if (v) commit((gg) => { const old = gg[side][i].name; gg[side][i].name = v; const port = side === 'inputs' ? 'macroIn' : 'macroOut'; const pn = gg.nodes.find((x) => x.type === port); if (pn) for (const w of gg.wires) { if (side === 'inputs' && w.from === pn.id + '.' + old) w.from = pn.id + '.' + v; if (side === 'outputs' && w.to === pn.id + '.' + old) w.to = pn.id + '.' + v; } }); } }),
            h('select', { 'aria-label': 'Type', onchange: (e) => commit((gg) => { gg[side][i].type = e.target.value; }) }, RG.TYPES.map((t) => { const o = h('option', { value: t }, TYPE_NAME[t]); o.selected = t === p.type; return o; })),
            h('button', { class: 'btn sm', 'aria-label': 'Remove', onclick: () => commit((gg) => { gg[side].splice(i, 1); }) }, '×'))),
          h('button', { class: 'btn sm', onclick: () => commit((gg) => { gg[side] = gg[side] || []; gg[side].push({ name: (side === 'inputs' ? 'in' : 'out') + (gg[side].length + 1), type: 'bool' }); }) }, '+ Add ' + (side === 'inputs' ? 'an input' : 'an output'))));
      }
    } else out.push(h('p', { class: 'sm' }, lv.own ? '' : 'Built into Aethernet: read only. Copy its nodes (⌘C) into your graph to change them.'));
    return put(el.ins, ...out);
  }
  out.push(h('div', { class: 'mut sm' }, 'Graph'), h('h4', null, g.title || S.rule.title),
    h('p', null, 'Click a node to change it. Drag from a pin to another to wire them; right-click the canvas to add a node. Shift-drag selects a box.'));
  out.push(h('label', { class: 'rx-fld' }, h('span', null, 'Title'), h('input', { type: 'text', value: g.title || '', disabled: !edit, maxlength: 80, onchange: (e) => commit((gg) => { gg.title = e.target.value.trim(); }) })),
    h('label', { class: 'rx-fld' }, h('span', null, 'Section'), (() => { const sl = h('select', { disabled: !edit, onchange: (e) => commit((gg) => { gg.check = e.target.value; }) }, R.CHECKS.map(([k, nm]) => h('option', { value: k }, nm))); sl.value = g.check || ''; return sl; })()),
    h('dl', { class: 'rx-kv' }, h('dt', null, 'Rule id'), h('dd', null, S.ruleId), h('dt', null, 'Nodes'), h('dd', null, String(g.nodes.length + Object.values(g.macros || {}).reduce((t, m) => t + (m.nodes || []).length, 0)) + ' of ' + R.MAX_GRAPH_NODES)),
    h('p', { class: 'sm' }, 'Title and section are what a finding uses when its own are blank.'));
  if (readOnlyWhy()) out.push(h('p', { class: 'sm' }, h('b', null, 'Read only: '), readOnlyWhy()));
  put(el.ins, ...out);
}
// One setting's editor.
function field(n, f, s, set, edit, lv) {
  const h = ui.h, v = s[f.name], label = (t) => h('span', null, t);
  const name = { programs: 'Programs', statuses: 'Statuses', outcomes: 'Outcomes', match: 'Match', words: 'Words and phrases', skipNegated: 'Skip negated mentions', pattern: 'Pattern', limit: 'Limit', min: 'Min', max: 'Max', b: 'B', tolerance: 'Tolerance', type: 'Type', value: 'Value',
    text: 'Text', then1: 'Then 1', then2: 'Then 2', then3: 'Then 3', else: 'Else', credit: 'Partner credits', neverFlag: 'Misc labor and buybacks', deposit: 'Deposit offsets', price: 'Price', skus: 'SKUs', names: 'Line names', kind: 'Kind', title: 'Title', check: 'Section', rule: 'Rule', evidence: 'Evidence', macro: 'Macro' }[f.name] || pinLabel(f.name);
  const g = lv.g, wired = (g.wires || []).some((w) => w.to === n.id + '.' + f.name);
  if (f.name === 'rule' && (n.type === 'finding' || n.type === 'reminder')) return null;
  if (wired && ['limit', 'min', 'max', 'b', 'then1', 'then2', 'then3', 'else', 'evidence'].includes(f.name)) return h('div', { class: 'rx-fld' }, label(name), h('p', null, 'Comes from its wire.'));
  if (f.name === 'check' && (n.type === 'finding' || n.type === 'reminder')) {
    const sl = h('select', { disabled: !edit, onchange: (e) => set('check', e.target.value || undefined) }, h('option', { value: '' }, 'The graph’s (' + (CHECK_NAME[n.type === 'reminder' ? 'remind' : g.check] || '?') + ')'), R.CHECKS.map(([k, nm]) => h('option', { value: k }, nm)));
    sl.value = v || ''; return h('label', { class: 'rx-fld' }, label(name), sl);
  }
  if (f.name === 'title' && (n.type === 'finding' || n.type === 'reminder')) return h('label', { class: 'rx-fld' }, label(name), h('input', { type: 'text', value: v || '', placeholder: 'The graph’s: ' + (g.title || ''), disabled: !edit, maxlength: 80, onchange: (e) => set('title', e.target.value.trim() || undefined) }));
  if (f.name === 'kind' && n.type === 'finding') return h('div', { class: 'rx-fld' }, label(name), h('div', { class: 'rx-seg', role: 'group' }, RG.KINDS.map((k) => h('button', { class: (v || 'note') === k ? 'on' : null, disabled: !edit, onclick: () => set('kind', k) }, KIND_NAME[k]))));
  if (f.type === 'list') {
    const list = Array.isArray(v) ? v : [];
    if (f.name === 'programs') return h('div', { class: 'rx-fld' }, label(name), h('div', { class: 'rx-opts' }, PROGRAMS.map(([k, l]) => h('button', { class: list.includes(k) ? 'on' : null, disabled: !edit, title: k, onclick: () => set('programs', list.includes(k) ? list.filter((x) => x !== k) : list.concat(k)) }, l))));
    if (f.name === 'outcomes') return h('div', { class: 'rx-fld' }, label(name + ' (none: any)'), h('div', { class: 'rx-opts' }, OUTCOMES.map((k) => h('button', { class: list.includes(k) ? 'on' : null, disabled: !edit, onclick: () => set('outcomes', list.includes(k) ? list.filter((x) => x !== k) : list.concat(k)) }, k))));
    const dl = f.name === 'statuses' ? 'rx-statuses' : null;
    const add = h('input', { type: 'text', placeholder: edit ? 'Add, then press Enter' : '', disabled: !edit, list: dl, 'data-chip': n.id + '.' + f.name, 'aria-label': 'Add to ' + name,
      onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); const w = e.target.value.trim(); if (!list.some((x) => String(x).toLowerCase() === w.toLowerCase())) { S.refocus = '[data-chip="' + n.id + '.' + f.name + '"]'; set(f.name, list.concat(f.name === 'statuses' ? w.toLowerCase() : w)); } else e.target.value = ''; } else if (e.key === 'Backspace' && !e.target.value && list.length) { S.refocus = '[data-chip="' + n.id + '.' + f.name + '"]'; set(f.name, list.slice(0, -1)); } } });
    return h('div', { class: 'rx-fld' }, label(name + (f.name === 'statuses' ? ' (none: any)' : '')),
      h('div', { class: 'rx-chips' }, list.map((w, i) => h('span', null, String(w), edit ? h('button', { 'aria-label': 'Remove ' + w, onclick: () => set(f.name, list.filter((_, j) => j !== i)) }, '×') : null)), add),
      dl ? h('datalist', { id: dl }, STATUSES.map((x) => h('option', { value: x.toLowerCase() }))) : null,
      f.name === 'words' ? h('p', { class: 'sm' }, 'Whole words, any capitalization. No patterns: each is matched as written.') : null);
  }
  if (f.type === 'enum') {
    const opts = f.options || [], cur = v ?? f.def;
    const lbl = (o) => ({ any: 'Ignore', keep: 'Keep only', drop: 'Drop', exact: 'Whole name', contains: 'Contains', positive: 'Positive', negative: 'Negative', nonzero: 'Not $0', num: 'Number', text: 'Text', bool: 'Yes / no', phone: 'Phone', foldable: 'Foldable', wearable: 'Wearable', tv: 'TV' }[o] || o);
    return h('div', { class: 'rx-fld' }, label(name), h('div', { class: 'rx-seg', role: 'group' }, opts.map((o) => h('button', { class: cur === o ? 'on' : null, disabled: !edit, onclick: () => set(f.name, o) }, lbl(o)))), f.desc ? h('p', { class: 'sm' }, f.desc) : null);
  }
  if (f.type === 'pattern') {
    const sl = h('select', { disabled: !edit, onchange: (e) => set(f.name, e.target.value) }, (f.options || []).map((o) => h('option', { value: o }, PATTERNS[o] || o)));
    sl.value = v || ''; return h('label', { class: 'rx-fld' }, label(name), sl, h('p', { class: 'sm' }, 'Built-in patterns only (the same ones the code uses).'));
  }
  if (f.type === 'macro') {
    const sl = h('select', { disabled: !edit, onchange: (e) => set('macro', e.target.value) }, Object.entries(lib().macros).map(([k, m]) => h('option', { value: k }, m.title || k)));
    sl.value = v || ''; return h('label', { class: 'rx-fld' }, label(name), sl);
  }
  if (f.type === 'bool') return h('label', { class: 'rx-ck' }, h('input', { type: 'checkbox', checked: v === undefined ? !!f.def : !!v, disabled: !edit, onchange: (e) => set(f.name, e.target.checked) }), name);
  if (f.type === 'num') return h('label', { class: 'rx-fld' }, label(name), h('input', { type: 'number', step: 'any', value: v ?? f.def ?? 0, disabled: !edit, onchange: (e) => set(f.name, Number(e.target.value) || 0) }));
  // text
  if (n.type === 'constant' && f.name === 'value' && s.type === 'bool') return h('label', { class: 'rx-ck' }, h('input', { type: 'checkbox', checked: v === true || v === 'true', disabled: !edit, onchange: (e) => set('value', e.target.checked) }), 'Yes');
  const inp = h('input', { type: n.type === 'constant' && (s.type || 'num') === 'num' ? 'number' : 'text', value: v == null ? '' : String(v), disabled: !edit, placeholder: f.desc || '', onchange: (e) => set(f.name, n.type === 'constant' && (s.type || 'num') === 'num' ? Number(e.target.value) || 0 : e.target.value) });
  return h('label', { class: 'rx-fld' }, label(name), inp, n.type === 'template' ? h('p', { class: 'sm' }, 'Each {name} becomes an input pin; its value goes in that spot.') : null);
}

// ------------------------------------------------------------------ Today's orders: this graph next to what runs now
function renderCompareSoon() { clearTimeout(S && S.cmpTimer); if (S) S.cmpTimer = setTimeout(() => { computeCompare(); renderCompareView(); if (S.confirm === 'publish') renderHeader(); }, 350); }
// What Assize runs for this rule at the test store today (the scope being edited): its published graph, else the
// all-stores one (a store without its own), else the code rule, else nothing (a new graph-only rule).
function baseline() {
  const own = scopeRow(S.scope), all = scopeRow('all');
  const g = (own && own.published) || (S.scope !== 'all' && all && all.published) || null;
  if (g) { const c = RG.compile(g); return { label: own && own.published ? 'Published' : 'All stores’ graph', run: (inp, opts) => { const r = RG.run(c, ctxFor(inp, opts), { trace: false }); return r.errors.length ? { error: r.errors[0] } : { list: r.findings.filter((x) => x.rule === S.ruleId).map(brief) }; } }; }
  if (S.rule.code) return { label: 'Code rule', run: (inp, opts) => ({ list: R.audit(inp.row, inp.detail, opts).filter((x) => x.rule === S.ruleId).map((x) => brief(x, true)) }) };
  return { label: 'Nothing yet', run: () => ({ list: [] }) };
}
function brief(x, code) {
  const sig = code ? x.sig : R.sigOf(...(x.sigBasis || []));
  const w = x.who || { key: 'unassigned', name: 'Unassigned' };
  return { key: [x.kind, x.check, x.title, x.evidence, w.key, sig].join(' · '), kind: x.kind, title: x.title, evidence: x.evidence, who: w.name || w.label };
}
function computeCompare() {
  if (!S || !S.rule || !S.rule.perOrder || !S.test.orders.length || !shown()) { if (S) S.cmp = null; return; }
  const now = Date.now(), opts = optsFor(S.test.store, now), base = baseline(), c = RG.compile(shown());
  const rows = [];
  for (const o of S.test.orders) {
    if (!o.inp) continue;
    const a = base.run(o.inp, opts);
    let b;
    if (c.errors && c.errors.length) b = { error: 'The graph has problems' };
    else { const r = RG.run(c, ctxFor(o.inp, opts), { trace: false }); b = r.errors.length ? { error: r.errors[0] } : { list: r.findings.filter((x) => x.rule === S.ruleId).map((x) => brief(x)) }; }
    const ka = a.error ? 'E' : a.list.map((x) => x.key).sort().join('\n'), kb = b.error ? 'E' : b.list.map((x) => x.key).sort().join('\n');
    rows.push({ o, a, b, same: ka === kb });
  }
  const n = rows.length, changed = rows.filter((r) => !r.same).length, found = rows.reduce((t, r) => t + (r.b.list ? r.b.list.length : 0), 0);
  S.cmp = { ok: !(c.errors && c.errors.length), label: base.label, rows, n, changed, found, store: S.test.store };
}
function renderCompareView() {
  if (!live() || !el.cmp) return;
  const h = ui.h, c = S.cmp, t = S.test;
  const head = h('div', { style: 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap' }, h('h4', null, 'Today’s orders'), h('span', { class: 'mut sm' }, t.store ? 'Store ' + t.store + ' · open now' + (t.lastScan ? ' · tracker read ' + ui.fmt(t.lastScan) : '') : ''));
  if (!S.rule || !S.rule.perOrder) return put(el.cmp, head, h('p', null, 'Nothing to compare for this rule.'));
  if (t.loading) return put(el.cmp, head, h('p', null, 'Loading orders…'));
  if (!c) return put(el.cmp, head, h('p', null, t.err ? "Couldn't load orders: " + t.err : 'No open orders at this store.'));
  const what = S.hist ? 'this version' : 'this graph';
  const match = !c.ok ? h('div', { class: 'rx-match na' }, 'Fix the graph’s problems to compare it.')
    : c.changed ? h('div', { class: 'rx-match bad' }, c.changed + ' of ' + c.n + ' orders would change · ' + plural(c.found, 'finding') + ' with ' + what)
      : c.label === 'Nothing yet' ? h('div', { class: 'rx-match ok' }, '✓ Nothing raises this rule yet, and this graph raises nothing on the ' + c.n + ' open orders')
        : h('div', { class: 'rx-match ok' }, '✓ Matches the ' + (c.label === 'Code rule' ? 'code rule' : c.label === 'Published' ? 'published rule' : c.label.toLowerCase()) + ' on all ' + c.n + ' open orders · ' + plural(c.found, 'finding'));
  const cell = (x) => (x.error ? h('span', { class: 'pill off', title: x.error }, 'Error') : x.list.length ? x.list.map((f) => h('div', null, h('span', { class: 'pill ' + f.kind }, KIND_NAME[f.kind] || f.kind), h('div', { class: 'sm' }, f.evidence))) : h('span', { class: 'mut' }, '—'));
  const sorted = c.rows.slice().sort((a, b) => (a.same - b.same) || ((b.b.list || []).length - (a.b.list || []).length) || (a.o.wo - b.o.wo));
  put(el.cmp, head, match,
    h('div', { style: 'overflow-x:auto;max-height:520px;overflow-y:auto' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Work order'), h('th', null, c.label), h('th', null, S.hist ? 'This version' : 'This graph'))),
      h('tbody', null, sorted.map((r) => h('tr', { class: [r.same ? '' : 'diff', r.o.wo === S.test.wo ? 'cur' : ''].join(' ').trim() || null, 'data-wo': String(r.o.wo), onclick: () => { S.test.wo = r.o.wo; S.step = null; stopPlay(); runDebug(); renderDebug(); renderCanvas(); renderSide(); } },
        h('td', null, h('span', { class: 'wo' }, '#' + r.o.wo), h('div', { class: 'sm mut' }, (r.o.device || '') + (r.o.status_name ? ' · ' + r.o.status_name : ''))), h('td', null, cell(r.a)), h('td', null, cell(r.b))))))),
    h('p', { class: 'sm' }, 'Runs ' + what + ' and ' + (c.label === 'Code rule' ? 'the code rule' : c.label === 'Nothing yet' ? 'nothing (a new rule)' : 'the ' + c.label.toLowerCase()) + ' side by side on every open order. Click an order to trace it on the canvas.' + (S.test.details && !TK.isUnlocked() ? ' Locked: note checks see no notes until you unlock.' : !S.test.details ? ' Without customer details, note checks see no notes.' : '')));
}
function renderCompareMarks() { if (el.cmp) for (const tr of el.cmp.querySelectorAll('tbody tr')) tr.classList.toggle('cur', Number(tr.dataset.wo) === S.test.wo); }
