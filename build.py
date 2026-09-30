#!/usr/bin/env python3
"""Bundle src/*.js into dist/aethernet.user.js — the one file to install.

Edit the crystals in src/ (one file each, loaded in filename order: core,
settings, then crystals), then:

  python3 build.py            build dist/ only (for testing): aethernet.user.js
                              (minified), aethernet.meta.js (header only, for
                              update checks), aethernet.readable.js (unminified)
  python3 build.py --release  build, then publish to the Gist so every
                              install auto-updates (also updates status.json's
                              "latest", which drives the in-Portal update pill)
  python3 build.py --dev      build the DEV channel (dist-dev/) and publish it to
                              the dev Gist: "Aethernet (dev)", its own install,
                              storage and Worker, plus the dev tools in src/dev/.
                              Every dev publish gets a new build number:
                              DEV_BASE.N (e.g. 2.16.0.3).
  python3 build.py --demo     build the DEMO channel (dist-demo/) and publish it
                              to the demo Gist: a cut-down "Aethernet" with only
                              the crystals in DEMO["crystals"], no patch notes,
                              a minimal About, and no Worker traffic (no store
                              check, feedback, usage or Waymark). Built from the
                              `demo` git branch; bump DEMO["version"] first.

Workflow (Garrett, Sep 30, 2026): new work goes to the `dev` git branch and
`--dev` straight away; a session is later bundled into one public release
(merge into main, one patch-notes entry, `--release`).

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
import os
import re
import subprocess
import sys
from pathlib import Path

VERSION = "2.16.0"   # the public version (bump when bundling a public release)
DEV_BASE = "2.17.0"  # the next public version, being built on dev

# Secret Gist that hosts the published script (account: Unix-Epoch).
# The raw URL has no commit hash, so it always serves the latest revision.
GIST_ID = "0cf4560c4f26d8ff9091a10068fd3464"
FILENAME = "aethernet.user.js"          # minified; what installs run
META_FILENAME = "aethernet.meta.js"     # header only; what update checks download (~1 KB)
READABLE_FILENAME = "aethernet.readable.js"  # the same build, unminified, for reading/auditing
GIST_RAW = f"https://gist.githubusercontent.com/Unix-Epoch/{GIST_ID}/raw"
RAW_URL = f"{GIST_RAW}/{FILENAME}"
META_URL = f"{GIST_RAW}/{META_FILENAME}"
READABLE_URL = f"{GIST_RAW}/{READABLE_FILENAME}"
# Waymark (work-order tags) API: the Cloudflare Worker in worker/. Empty until
# deployed; WAYMARK_API in the environment overrides it (e.g. a local
# `wrangler dev` for testing). The app key is read from worker/wrangler.toml.
WAYMARK_API = "https://aethernet-waymark.ubifaethernet.workers.dev"

# The dev channel: everything that differs from the public build.
DEV = {
    "gist_id": "9ac1e1dbc80caa3dff04afb5b89e90c3",  # secret Gist, account Unix-Epoch
    "name": "Aethernet (dev)",
    "namespace": "garrett.ubif.dev",   # a separate script to Tampermonkey: own install + storage
    "waymark_api": "https://aethernet-waymark-dev.ubifaethernet.workers.dev",
    "dist": "dist-dev",
    "status_file": "status-dev.json",
    "counter": "dev-build.txt",       # last dev build number
}
# The demo channel: a cut-down build that must read as the real thing (no
# "demo" anywhere a user can see: name, namespace, Gist, About).
DEMO = {
    "gist_id": "",                     # secret Gist, account Unix-Epoch
    "version": "2.16.0",               # bump for each --demo publish
    "name": "Aethernet",
    "namespace": "garrett.aethernet",  # its own install + storage (can sit beside the public one)
    "dist": "dist-demo",
    "status_file": "status-demo.json",
    # Only these crystals (and the files that hold them) go in.
    "crystals": ("cleaningRate", "autoClose", "glamour"),
    "files": ("00-core.js", "02-status.js", "05-settings.js", "10-cleaning-rate.js", "20-auto-close.js", "50-glamour.js"),
    "description": "Crystals (add-on tools) for NextGen Portal: live cleaning rate, one-click cleaning close-out and page theming for portal.ubreakifix.net. Settings: avatar menu → Aethernet settings.",
}
CHANNEL = "public"  # set to "dev" / "demo" by --dev / --demo before building
# Minifier, pinned so builds are repeatable; run through npx (no local node_modules).
ESBUILD = ["npx", "--yes", "esbuild@0.28.2"]

def channel_raw() -> str:
    return gist_raw(DEV["gist_id"]) if CHANNEL == "dev" else gist_raw(DEMO["gist_id"]) if CHANNEL == "demo" else GIST_RAW


def header(version: str) -> str:
    dev = CHANNEL == "dev"
    raw = channel_raw()
    if CHANNEL == "demo":
        return f"""// ==UserScript==
// @name         {DEMO["name"]}
// @namespace    {DEMO["namespace"]}
// @version      {version}
// @description  {DEMO["description"]}
// @match        https://portal.ubreakifix.net/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @updateURL    {raw}/{META_FILENAME}
// @downloadURL  {raw}/{FILENAME}
// ==/UserScript==
"""
    return f"""// ==UserScript==
// @name         {DEV["name"] if dev else "Aethernet — crystals for NextGen Portal"}
// @namespace    {DEV["namespace"] if dev else "garrett.ubif"}
// @version      {version}
// @description  Crystals (add-on tools) for NextGen Portal: live cleaning rate, one-click cleaning close-out, Galaxy Diagnostics exception filing, print-all-labels and buyback add-all for portal.ubreakifix.net. Settings: avatar menu → Aethernet settings.
// @match        https://portal.ubreakifix.net/*
// @match        https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @updateURL    {raw}/{META_FILENAME}
// @downloadURL  {raw}/{FILENAME}
// ==/UserScript==

/* Built by build.py from src/ — edit those files, not this one. */
"""


def gist_raw(gist_id: str) -> str:
    return f"https://gist.githubusercontent.com/Unix-Epoch/{gist_id}/raw"


def dev_version(root: Path, bump: bool) -> str:
    f = root / DEV["counter"]
    n = int(f.read_text().strip()) if f.exists() else 0
    if bump:
        n += 1
        f.write_text(f"{n}\n")
    return f"{DEV_BASE}.{max(n, 1)}"


def git_commit(root: Path) -> str:
    try:
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "src", "build.py"], cwd=root, capture_output=True, text=True).stdout.strip()
        return sha + ("-dirty" if dirty else "")
    except Exception:
        return "unknown"


# Files that run before the store-access check (the rest wait for it).
PREBOOT = ("00-core.js", "01-access.js")

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


def waymark_key(root: Path) -> str:
    m = re.search(r'^APP_KEY\s*=\s*"([^"]+)"', (root / "worker" / "wrangler.toml").read_text(), re.M)
    return m.group(1) if m else ""


def action_icons(root: Path) -> str:
    demo = CHANNEL == "demo"
    icons = {
        f.stem: "data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode()
        for f in sorted((root / "assets" / "icons").glob("*.jpg"))
        if not demo or f.stem in DEMO["crystals"]
    }
    # FFXIV UI pieces (e.g. the hotbar macro gear), keyed "ui/<name>"
    for f in ([] if demo else sorted((root / "assets" / "ui").glob("*.png"))):
        icons["ui/" + f.stem] = "data:image/png;base64," + base64.b64encode(f.read_bytes()).decode()
    return json.dumps(icons)


def build(root: Path, version: str = VERSION) -> Path:
    dev, demo = CHANNEL == "dev", CHANNEL == "demo"
    raw = channel_raw()
    stamps = {
        "__VERSION__": version,
        "__DEV__": "true" if dev else "false",
        # AE_DEMO is written bare in src/ and swapped for a literal here, so the
        # minifier drops the other channel's branches (and their text) entirely.
        "AE_DEMO": "true" if demo else "false",
        "__BUILD_TIME__": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "__BUILD_COMMIT__": git_commit(root),
        "__INSTALL_URL__": f"{raw}/{FILENAME}",
        "__READABLE_URL__": f"{raw}/{READABLE_FILENAME}",
        "__WAYMARK_API__": os.environ.get("WAYMARK_API", DEV["waymark_api"] if dev else WAYMARK_API),
        "__WAYMARK_KEY__": waymark_key(root),
        # FFXIV action icons, one per crystal (assets/icons/<crystalId>.jpg), plus
        # UI pieces (assets/ui/*.png), as data URIs
        "__ACTION_ICONS__": action_icons(root),
        "__PATCH_NOTES__": "[]" if demo else json.dumps(load_notes(root)),
    }
    head = header(version)
    parts = [head, "(function aethernet() {\n'use strict';\n"]
    # src/dev/*.js (dev tools) only go into dev builds; everything sorts by file name.
    files = list((root / "src").glob("*.js")) + (list((root / "src" / "dev").glob("*.js")) if dev else [])
    if demo:  # only its crystals; no store check (01-access.js), so it boots straight away
        files = [f for f in files if f.name in DEMO["files"]]
    # Core + the store-access gate load first; everything else sits in AE.boot,
    # which the gate calls only once the store is allowed (01-access.js).
    booting = False
    for f in sorted(files, key=lambda f: f.name):
        if f.name not in PREBOOT and not booting:
            parts.append("\nAE.boot = function aethernetBoot() {\n")
            booting = True
        parts.append(f"\n// ===== {f.name} =====\n")
        text = f.read_text()
        for k, v in stamps.items():
            text = text.replace(k, v)
        parts.append(text)
    parts.append("\nAE.start();\n};\n" + ("AE.boot();" if demo else "AE.gate();") + "\n})();\n")
    dist = root / (DEV["dist"] if dev else DEMO["dist"] if demo else "dist")
    dist.mkdir(exist_ok=True)
    readable = "".join(parts)
    body = readable[len(head):]
    (dist / READABLE_FILENAME).write_text(readable)
    (dist / META_FILENAME).write_text(head.split("// ==/UserScript==")[0] + "// ==/UserScript==\n")
    out = dist / FILENAME
    out.write_text(head + minify(body))
    print(f"Built {out.relative_to(root)} v{version}{' (dev)' if dev else ' (demo)' if demo else ''}: {out.stat().st_size:,} bytes "
          f"(readable {len(readable.encode()):,}, meta {(dist / META_FILENAME).stat().st_size:,})")
    return out


def minify(js: str) -> str:
    # --keep-names: function names survive, so errors from stores still say where.
    res = subprocess.run(ESBUILD + ["--minify", "--keep-names", "--format=iife", "--target=es2020", "--loader=js", "--log-level=warning"],
                         input=js, capture_output=True, text=True)
    if res.returncode:
        sys.exit("esbuild failed:\n" + res.stderr)
    return squash_css(res.stdout)


def squash_css(js: str) -> str:
    # esbuild leaves template literals alone, and nearly every one in src/ is a CSS
    # block, sometimes with ${id} placeholders. Collapse the whitespace in the
    # literal text between placeholders; text templates (no "{" outside
    # placeholders, e.g. the Recitation note) are left untouched.
    placeholder = re.compile(r"(\$\{[^{}`]*\})")
    def squash(m):
        chunks = placeholder.split(m.group(0))
        if not any("{" in c for c in chunks[::2]):
            return m.group(0)
        def tidy(c):
            c = re.sub(r"/\*.*?\*/", "", c, flags=re.S)
            c = re.sub(r"\s+", " ", c)
            return re.sub(r"\s*([{};>])\s*", r"\1", c)
        return "".join(tidy(c) if i % 2 == 0 else c for i, c in enumerate(chunks))
    return re.sub(r"`[^`]*`", squash, js)


def as_tuple(v: str) -> tuple:  # "2.16.0.3" works too
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
    gist_put(f, gist_files(GIST_ID))
    print(f"Published {STATUS_FILE}: " + json.dumps(status, ensure_ascii=False))
    # Dev installs read the dev Gist's status.json: same notice, their own "latest".
    if DEV["gist_id"]:
        dev = load_dev_status(root)
        dev["incident"] = status.get("incident")
        publish_dev_status(root, dev)
    # Demo installs only hear about notices that concern their own crystals.
    if DEMO["gist_id"]:
        demo = load_channel_status(root, DEMO["status_file"])
        inc = demo_incident(status.get("incident"))
        if demo.get("incident") != inc:
            demo["incident"] = inc
            publish_channel_status(root, DEMO["status_file"], DEMO["gist_id"], demo)


def demo_incident(inc):
    if not inc:
        return None
    ours = set(DEMO["crystals"])
    touched = set(inc.get("crystals") or []) | set(inc.get("pause") or [])
    if not touched & ours:
        return None
    return {**inc, "crystals": [c for c in inc.get("crystals") or [] if c in ours],
            "pause": [c for c in inc.get("pause") or [] if c in ours]}


def load_channel_status(root: Path, name: str) -> dict:
    f = root / name
    return json.loads(f.read_text()) if f.exists() else {"latest": None, "incident": None}


def publish_channel_status(root: Path, name: str, gist_id: str, status: dict) -> None:
    f = root / name
    f.write_text(json.dumps(status, indent=2, ensure_ascii=False) + "\n")
    gist_put(f, gist_files(gist_id), gist_id, as_name=STATUS_FILE)
    print(f"Published {name} → status.json: " + json.dumps(status, ensure_ascii=False))


def load_dev_status(root: Path) -> dict:
    f = root / DEV["status_file"]
    return json.loads(f.read_text()) if f.exists() else {"latest": None, "incident": None}


def publish_dev_status(root: Path, status: dict) -> None:
    f = root / DEV["status_file"]
    f.write_text(json.dumps(status, indent=2, ensure_ascii=False) + "\n")
    gist_put(f, gist_files(DEV["gist_id"]), DEV["gist_id"], as_name=STATUS_FILE)
    print("Published dev status.json: " + json.dumps(status, ensure_ascii=False))


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


def gist_files(gist_id: str) -> list:
    return subprocess.run(["gh", "api", f"gists/{gist_id}", "--jq", ".files | keys[]"],
                          check=True, capture_output=True, text=True).stdout.split()


def gist_put(path: Path, files: list, gist_id: str = GIST_ID, as_name: str | None = None) -> None:
    """Upload `path` to the Gist as `as_name` (default: its own name), adding it if new."""
    import tempfile
    name = as_name or path.name
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / name          # `gh gist edit --add` names the file after the path
        src.write_bytes(path.read_bytes())
        opts = ["--filename", name] if name in files else ["--add"]
        subprocess.run(["gh", "gist", "edit", gist_id, *opts, str(src)], check=True)


def release(root: Path, out: Path, live: str | None) -> None:
    files = gist_files(GIST_ID)
    # Script first, then the meta file (so an update check never sees a
    # version whose script isn't up yet), then the readable copy.
    for name in (FILENAME, META_FILENAME, READABLE_FILENAME):
        gist_put(out.parent / name, files)
    print(f"Published v{VERSION} (was {live or 'nothing'}). Install/update URL:\n  {RAW_URL}")
    # Tell running installs there's an update (they check status.json every 10 minutes).
    entry = next(n for n in load_notes(root) if n["version"] == VERSION)
    status = load_status(root)
    status["latest"] = {"version": VERSION, "date": entry["date"]}
    publish_status(root, status)


def dev_release(root: Path) -> None:
    global CHANNEL
    if not DEV["gist_id"]:
        sys.exit("No dev Gist yet: set DEV['gist_id'] in build.py.")
    CHANNEL = "dev"
    version = dev_version(root, bump=True)
    out = build(root, version)
    files = gist_files(DEV["gist_id"])
    for name in (FILENAME, META_FILENAME, READABLE_FILENAME):
        gist_put(out.parent / name, files, DEV["gist_id"])
    print(f"Published dev v{version}. Dev install link:\n  {gist_raw(DEV['gist_id'])}/{FILENAME}")
    status = load_dev_status(root)
    status["latest"] = {"version": version, "date": now_utc()}
    status["incident"] = load_status(root).get("incident")  # same notice as the public channel
    publish_dev_status(root, status)


def demo_release(root: Path) -> None:
    global CHANNEL
    if not DEMO["gist_id"]:
        sys.exit("No demo Gist yet: set DEMO['gist_id'] in build.py.")
    content = subprocess.run(["gh", "api", f"gists/{DEMO['gist_id']}", "--jq", f'.files["{FILENAME}"].content // ""'],
                             check=True, capture_output=True, text=True).stdout
    m = re.search(r"^// @version\s+(\S+)", content, re.M)
    if m and as_tuple(DEMO["version"]) <= as_tuple(m.group(1)):
        sys.exit(f"Refusing to publish: DEMO version {DEMO['version']} isn't higher than the published {m.group(1)}.")
    CHANNEL = "demo"
    out = build(root, DEMO["version"])
    # Nothing that gives it away: the word "demo", or any left-out crystal / feature.
    leaks = sorted(set(re.findall(r"(?i)\bdemo\b|patch notes|waymark|macrocosmos|esuna|recitation|bountiful|quick synthesis|lay of the land|"
                                  r"send feedback|workers\.dev|ae_usage", out.read_text())))
    if leaks:
        sys.exit(f"Refusing to publish: the demo build contains {leaks}.")
    files = gist_files(DEMO["gist_id"])
    for name in (FILENAME, META_FILENAME):  # no readable copy: About doesn't link one
        gist_put(out.parent / name, files, DEMO["gist_id"])
    print(f"Published demo v{DEMO['version']}. Install link:\n  {gist_raw(DEMO['gist_id'])}/{FILENAME}")
    status = load_channel_status(root, DEMO["status_file"])
    status["latest"] = {"version": DEMO["version"], "date": now_utc()}
    status["incident"] = demo_incident(load_status(root).get("incident"))
    publish_channel_status(root, DEMO["status_file"], DEMO["gist_id"], status)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Build / release Aethernet, or post a live notice.")
    ap.add_argument("--release", action="store_true")
    ap.add_argument("--dev", action="store_true", help="build + publish the dev channel")
    ap.add_argument("--dev-build", action="store_true", help="build the dev channel only (no publish)")
    ap.add_argument("--demo", action="store_true", help="build + publish the demo channel")
    ap.add_argument("--demo-build", action="store_true", help="build the demo channel only (no publish)")
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
    if args.dev:
        dev_release(root)
        sys.exit(0)
    if args.dev_build:
        CHANNEL = "dev"
        build(root, dev_version(root, bump=False))
        sys.exit(0)
    if args.demo:
        demo_release(root)
        sys.exit(0)
    if args.demo_build:
        CHANNEL = "demo"
        build(root, DEMO["version"])
        sys.exit(0)
    if args.release:
        live = check_releasable()
        stamp_release_date(root)  # before building, so the published file carries it
    out = build(root)
    if args.release:
        release(root, out, live)
