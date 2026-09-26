#!/usr/bin/env python3
"""Bundle src/*.js into dist/stargate.user.js — the one file to install.

Edit the tools in src/ (one file each, loaded in filename order: core,
settings, then tools), bump VERSION, run `python3 build.py`, and paste
dist/stargate.user.js into Tampermonkey.
"""

from pathlib import Path

VERSION = "2.0.0"

HEADER = f"""// ==UserScript==
// @name         Stargate — add-on tools for NextGen Portal
// @namespace    garrett.ubif
// @version      {VERSION}
// @description  Live cleaning rate, one-click cleaning close-out, Galaxy Diagnostics exception filing, and print-all-labels for portal.ubreakifix.net. Settings: avatar menu → Stargate settings.
// @match        https://portal.ubreakifix.net/*
// @match        https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/* Built by build.py from src/ — edit those files, not this one. */
"""

root = Path(__file__).resolve().parent
parts = [HEADER, "(function stargate() {\n'use strict';\n"]
for f in sorted((root / "src").glob("*.js")):
    parts.append(f"\n// ===== {f.name} =====\n")
    parts.append(f.read_text().replace("__VERSION__", VERSION))
parts.append("\nSG.start();\n})();\n")

out = root / "dist" / "stargate.user.js"
out.parent.mkdir(exist_ok=True)
out.write_text("".join(parts))
print(f"Built {out.relative_to(root)} v{VERSION} ({out.stat().st_size:,} bytes)")
