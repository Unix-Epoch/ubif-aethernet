#!/usr/bin/env python3
"""Bundle src/*.js into dist/aethernet.user.js — the one file to install.

Edit the crystals in src/ (one file each, loaded in filename order: core,
settings, then crystals), then:

  python3 build.py            build dist/aethernet.user.js only (for testing)
  python3 build.py --release  build, then publish to the Gist so every
                              install auto-updates (also updates status.json's
                              "latest", which drives the in-Portal update pill)

Notices (status.json on the same Gist, read live by every install within
~15 minutes; no release needed):

  python3 build.py --status warning "Title" "Message" [--crystal ID]... [--pause ID]...
  python3 build.py --status-update "New message"   same notice, new text (re-shows if dismissed)
  python3 build.py --status-fixed 2.10.1           installs at/after 2.10.1 stop showing it
  python3 build.py --status-clear                  remove the notice
  python3 build.py --status-show                   print what's live

Severity is info, warning or error. --pause is the kill switch: those
crystals stop acting everywhere until the notice is cleared or fixed.

Tampermonkey only takes an update whose @version is higher than the one
installed, so --release refuses to publish unless VERSION is higher than
what's currently on the Gist. Bump VERSION first.

Installs pick up a release within Tampermonkey's update interval (daily by
default), or immediately via Tampermonkey → Utilities → Check for userscript
updates. Gist raw URLs can be cached for a few minutes after publishing.
"""

import base64
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

VERSION = "2.11.0"

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


NOTES_FILE = "patch-notes.json"


def load_notes(root: Path) -> list:
    # Newest first: [{version, date (UTC ISO, stamped at release), notes: [...]}]
    return json.loads((root / NOTES_FILE).read_text())


def stamp_release_date(root: Path) -> None:
    # Patch notes carry the moment each version went out; --release fills it in.
    notes = load_notes(root)
    entry = next((n for n in notes if n["version"] == VERSION), None)
    if not entry:
        sys.exit(f"Refusing to publish: {NOTES_FILE} has no entry for {VERSION}. Write the patch notes first.")
    if not entry.get("date"):
        entry["date"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        (root / NOTES_FILE).write_text(json.dumps(notes, indent=2, ensure_ascii=False) + "\n")


def action_icons(root: Path) -> str:
    icons = {
        f.stem: "data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode()
        for f in sorted((root / "assets" / "icons").glob("*.jpg"))
    }
    # FFXIV UI pieces (e.g. the hotbar macro gear), keyed "ui/<name>"
    for f in sorted((root / "assets" / "ui").glob("*.png")):
        icons["ui/" + f.stem] = "data:image/png;base64," + base64.b64encode(f.read_bytes()).decode()
    return json.dumps(icons)


def build(root: Path) -> Path:
    stamps = {
        "__VERSION__": VERSION,
        "__BUILD_TIME__": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "__BUILD_COMMIT__": git_commit(root),
        "__INSTALL_URL__": RAW_URL,
        # FFXIV action icons, one per crystal (assets/icons/<crystalId>.jpg), plus
        # UI pieces (assets/ui/*.png), as data URIs
        "__ACTION_ICONS__": action_icons(root),
        "__PATCH_NOTES__": json.dumps(load_notes(root)),
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


STATUS_FILE = "status.json"
SEVERITIES = ("info", "warning", "error")


def now_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def crystal_ids(root: Path) -> set:
    return {m for f in (root / "src").glob("*.js") for m in re.findall(r"AE\.crystal\(\{\s*id:\s*'(\w+)'", f.read_text())}


def load_status(root: Path) -> dict:
    f = root / STATUS_FILE
    return json.loads(f.read_text()) if f.exists() else {"latest": None, "incident": None}


def publish_status(root: Path, status: dict) -> None:
    f = root / STATUS_FILE
    f.write_text(json.dumps(status, indent=2, ensure_ascii=False) + "\n")
    files = subprocess.run(["gh", "api", f"gists/{GIST_ID}", "--jq", ".files | keys[]"],
                           check=True, capture_output=True, text=True).stdout.split()
    cmd = ["gh", "gist", "edit", GIST_ID] + (["--filename", STATUS_FILE] if STATUS_FILE in files else ["--add"]) + [str(f)]
    subprocess.run(cmd, check=True)
    print(f"Published {STATUS_FILE}: " + json.dumps(status, ensure_ascii=False))


def status_command(root: Path, args) -> None:
    status = load_status(root)
    inc = status.get("incident")
    known = crystal_ids(root)
    for cid in (args.crystal or []) + (args.pause or []):
        if cid not in known:
            sys.exit(f"Unknown crystal id {cid!r}. Known: {', '.join(sorted(known))}")
    if args.status_show:
        print(json.dumps(status, indent=2, ensure_ascii=False))
        return
    if args.status:
        severity, title, *rest = args.status
        if severity not in SEVERITIES:
            sys.exit(f"Severity must be one of {', '.join(SEVERITIES)}")
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40]
        t = now_utc()
        status["incident"] = {
            "id": t[:10] + "-" + slug, "severity": severity, "title": title,
            "message": " ".join(rest), "crystals": args.crystal or [], "pause": args.pause or [],
            "fixedIn": None, "posted": t, "updated": t,
        }
    elif args.status_update is not None:
        if not inc:
            sys.exit("No notice is live to update.")
        inc["message"], inc["updated"] = args.status_update, now_utc()
        if args.crystal: inc["crystals"] = args.crystal
        if args.pause is not None: inc["pause"] = args.pause
    elif args.status_fixed:
        if not inc:
            sys.exit("No notice is live to mark fixed.")
        inc["fixedIn"], inc["updated"] = args.status_fixed, now_utc()
    elif args.status_clear:
        status["incident"] = None
    publish_status(root, status)


def check_releasable() -> str | None:
    live = published_version()
    if live and as_tuple(VERSION) <= as_tuple(live):
        sys.exit(f"Refusing to publish: VERSION {VERSION} isn't higher than the published {live}. "
                 "Bump VERSION in build.py (installs ignore same-or-lower versions).")
    return live


def release(root: Path, out: Path, live: str | None) -> None:
    subprocess.run(["gh", "gist", "edit", GIST_ID, "--filename", FILENAME, str(out)], check=True)
    print(f"Published v{VERSION} (was {live or 'nothing'}). Install/update URL:\n  {RAW_URL}")
    # Tell running installs there's an update (they check status.json every 10 minutes).
    entry = next(n for n in load_notes(root) if n["version"] == VERSION)
    status = load_status(root)
    status["latest"] = {"version": VERSION, "date": entry["date"]}
    publish_status(root, status)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Build / release Aethernet, or post a live notice.")
    ap.add_argument("--release", action="store_true")
    ap.add_argument("--status", nargs="+", metavar=("SEVERITY", "TITLE"), help="post a notice: SEVERITY TITLE [MESSAGE…]")
    ap.add_argument("--status-update", metavar="MESSAGE")
    ap.add_argument("--status-fixed", metavar="VERSION")
    ap.add_argument("--status-clear", action="store_true")
    ap.add_argument("--status-show", action="store_true")
    ap.add_argument("--crystal", action="append", metavar="ID", help="crystal the notice is about (repeatable)")
    ap.add_argument("--pause", action="append", metavar="ID", help="crystal to pause everywhere (repeatable)")
    args = ap.parse_args()
    root = Path(__file__).resolve().parent
    if args.status or args.status_update is not None or args.status_fixed or args.status_clear or args.status_show:
        if args.status and len(args.status) < 2:
            ap.error("--status needs at least SEVERITY and TITLE")
        status_command(root, args)
        sys.exit(0)
    if args.release:
        live = check_releasable()
        stamp_release_date(root)  # before building, so the published file carries it
    out = build(root)
    if args.release:
        release(root, out, live)
