// Admin site, the Assize rules editor (rules-ui.js): the editor's stylesheet (added to the page once by draw).
// Served at /rules-ui.js?part=style.

export const STYLE = `
.rx{--muted:#7c7b80;--grid:#dedce4;--canvas:#f1f0f4;--exec:#3a3940;--run:#8223d2;--errs:#fde8eb;--yes:#0b7f2a;--yess:#dff7e3;--no:#6c6b71;--nos:#efeef2;
  --c-fact:#2a78d6;--c-check:#6250d6;--c-logic:#6c6b71;--c-assize:#8223d2;--c-text:#b8336f;--c-num:#0b7f57;--c-people:#0a7d8c;--c-time:#b5531c;--c-out:#b97700;
  --t-bool:#d03b3b;--t-num:#14a06d;--t-text:#d9549a;--t-lines:#2a78d6;--t-notes:#0f8fa3;--t-textList:#6a5bd6;--t-person:#c77700;--t-any:#8b8a90;
  --shadow:0 1px 2px rgba(20,10,40,.06),0 4px 14px rgba(20,10,40,.07)}
@media (prefers-color-scheme:dark){.rx{--muted:#8b8a90;--grid:#2a292f;--canvas:#17161a;--exec:#e6e6ea;--run:#b88af2;--errs:#3a1a20;--yes:#5fd27a;--yess:#16361d;--no:#9a99a0;--nos:#26252a;--err:#ef6b7e;
  --c-fact:#4b93ea;--c-check:#8d80ee;--c-logic:#8b8a90;--c-assize:#a66cf0;--c-text:#e0679e;--c-num:#2fbf88;--c-people:#3cc4d6;--c-time:#ef8a52;--c-out:#e0a020;
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
