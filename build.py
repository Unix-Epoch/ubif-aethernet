#!/usr/bin/env python3
"""Bundle src/*.js into dist/aethernet.user.js — the one file to install.

Edit the crystals in src/ (one file each, loaded in filename order: core,
settings, then crystals), then:

  python3 build.py            build dist/aethernet.user.js only (for testing)
  python3 build.py --release  build, then publish to the Gist so every
                              install auto-updates

Tampermonkey only takes an update whose @version is higher than the one
installed, so --release refuses to publish unless VERSION is higher than
what's currently on the Gist. Bump VERSION first.

Installs pick up a release within Tampermonkey's update interval (daily by
default), or immediately via Tampermonkey → Utilities → Check for userscript
updates. Gist raw URLs can be cached for a few minutes after publishing.
"""

import datetime
import re
import subprocess
import sys
from pathlib import Path

VERSION = "2.8.2"

# Secret Gist that hosts the published script (account: Unix-Epoch).
# The raw URL has no commit hash, so it always serves the latest revision.
GIST_ID = "0cf4560c4f26d8ff9091a10068fd3464"
FILENAME = "aethernet.user.js"
RAW_URL = f"https://gist.githubusercontent.com/Unix-Epoch/{GIST_ID}/raw/{FILENAME}"

HEADER = f"""// ==UserScript==
// @name         Aethernet — crystals for NextGen Portal
// @namespace    garrett.ubif
// @version      {VERSION}
// @description  Crystals (add-on tools) for NextGen Portal: live cleaning rate, one-click cleaning close-out, Galaxy Diagnostics exception filing, print-all-labels and buyback add-all for portal.ubreakifix.net. Settings: avatar menu → Aethernet settings.
// @match        https://portal.ubreakifix.net/*
// @match        https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @updateURL    {RAW_URL}
// @downloadURL  {RAW_URL}
// ==/UserScript==

/* Built by build.py from src/ — edit those files, not this one. */
"""


def git_commit(root: Path) -> str:
    try:
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "src", "build.py"], cwd=root, capture_output=True, text=True).stdout.strip()
        return sha + ("-dirty" if dirty else "")
    except Exception:
        return "unknown"


def build(root: Path) -> Path:
    stamps = {
        "__VERSION__": VERSION,
        "__BUILD_TIME__": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "__BUILD_COMMIT__": git_commit(root),
        "__INSTALL_URL__": RAW_URL,
    }
    parts = [HEADER, "(function aethernet() {\n'use strict';\n"]
    for f in sorted((root / "src").glob("*.js")):
        parts.append(f"\n// ===== {f.name} =====\n")
        text = f.read_text()
        for k, v in stamps.items():
            text = text.replace(k, v)
        parts.append(text)
    parts.append("\nAE.start();\n})();\n")
    out = root / "dist" / FILENAME
    out.parent.mkdir(exist_ok=True)
    out.write_text("".join(parts))
    print(f"Built {out.relative_to(root)} v{VERSION} ({out.stat().st_size:,} bytes)")
    return out


def as_tuple(v: str) -> tuple:
    return tuple(int(x) for x in v.split("."))


def published_version() -> str | None:
    # Read through the GitHub API, not the raw URL: raw gist URLs sit behind
    # a CDN that served a stale copy right after publishing (seen on the
    # first release), which would let a same-version release slip through.
    content = subprocess.run(
        ["gh", "api", f"gists/{GIST_ID}", "--jq", f'.files["{FILENAME}"].content'],
        check=True, capture_output=True, text=True,
    ).stdout
    m = re.search(r"^// @version\s+(\S+)", content, re.M)
    return m.group(1) if m else None


def release(out: Path) -> None:
    live = published_version()
    if live and as_tuple(VERSION) <= as_tuple(live):
        sys.exit(f"Refusing to publish: VERSION {VERSION} isn't higher than the published {live}. "
                 "Bump VERSION in build.py (installs ignore same-or-lower versions).")
    subprocess.run(["gh", "gist", "edit", GIST_ID, "--filename", FILENAME, str(out)], check=True)
    print(f"Published v{VERSION} (was {live or 'nothing'}). Install/update URL:\n  {RAW_URL}")


if __name__ == "__main__":
    out = build(Path(__file__).resolve().parent)
    if "--release" in sys.argv[1:]:
        release(out)
