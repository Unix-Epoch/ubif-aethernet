#!/usr/bin/env python3
"""Bundle src/*.js into dist/aethernet.user.js — the one file to install.

Edit the shards in src/ (one file each, loaded in filename order: core,
settings, then shards), then:

  python3 build.py            build dist/ only (for testing): aethernet.user.js
                              (minified), aethernet.meta.js (header only, for
                              update checks), aethernet.readable.js (unminified)
  python3 build.py --release  build, then publish to the Gist so every
                              install auto-updates (also updates status.json's
                              "latest", which drives the in-Portal update pill).
                              Refuses (no override) unless: the branch is `main`
                              or `release-*`, the working tree is clean,
                              `node test-client/run.mjs` passes, WAYMARK_API /
                              TRACKER_API aren't set, the built bundle holds no
                              code from DEV_ONLY_FILES, and every channel's live
                              status.json matches the local one (see below).
  python3 build.py --dev      build the DEV channel (dist-dev/) and publish it to
                              the dev Gist: "Aethernet (dev)", its own install,
                              storage and Worker, plus the dev tools in src/dev/.
                              Every dev publish gets a new build number:
                              DEV_BASE.N (e.g. 2.16.0.3), N = max(dev-build.txt,
                              the live dev Gist's N) + 1.
  python3 build.py --demo     build the DEMO channel (dist-demo/) and publish it
                              to the demo Gist: a cut-down "Aethernet" with only
                              the shards in DEMO["shards"], no patch notes,
                              a minimal About, and no Worker traffic (no store
                              check, feedback, usage or Waymark). Built from the
                              `demo` git branch (and, like --release, only with
                              a clean tree, passing tests and no env overrides);
                              bump DEMO["version"] first.

Workflow (Garrett, Sep 30, 2026): new work goes to the `dev` git branch and
`--dev` straight away; a session is later bundled into one public release
(merge into main, one patch-notes entry, `--release`).

Notices (status.json on the same Gist, read live by every install within
~15 minutes; no release needed):

  python3 build.py --status warning "Title" "Message" [--shard ID]... [--pause ID]... [--tag "Badge text"]
                    [--mention ID]... [--chip ID "Badge text"]... [--chip-below VERSION]
      --shard: "Known issue" badge on every install (all versions understand it)
      --mention: icon + link to Settings in the title, no badge (2.22.0+)
      --chip:    badge only on installs older than --chip-below (default: VERSION, i.e. the version being pushed)
  Master's Mend bulletin rules (2.22.0+ installs, live in ~15 min, no update):
  python3 build.py --bulletins-show | --bulletins-reset
                   --bulletin-page REGEX | --bulletin-unpage REGEX
                   --bulletin-pattern TYPE | --bulletin-selector CSS | --bulletin-unselector CSS | --bulletin-closer CSS
  python3 build.py --status-update "New message"   same notice, new text (re-shows if dismissed)
  python3 build.py --status-fixed 2.10.1           installs at/after 2.10.1 stop showing it
  python3 build.py --status-clear                  remove the notice
  python3 build.py --status-show                   print local vs live, per channel (read-only)

Status base check: every command that publishes a status file (--release,
--dev, --demo, --status*, --bulletin*) first reads that channel's LIVE
status.json (GitHub API) and compares it with the local file, ignoring only
"latest". If they differ, or the live copy can't be read, it stops and prints
the difference; choose with --status-base live (adopt the live copy as the
base, written to the local file) or --status-base local (publish the local
copy over live; also the way past an unreadable live copy). --status-show
prints both for every channel and whether they match, and publishes nothing.

Severity is info, warning or error. --pause is the kill switch: those
shards stop acting everywhere until the notice is cleared or fixed.

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
import urllib.request
from pathlib import Path

VERSION = "2.23.0"   # the public version (bump when bundling a public release)
DEV_BASE = "2.24.0"  # the next public version, being built on dev

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
# The work order tracker Worker (tracker-worker/). Empty = Aethernet leaves the tracker off. On for every store since 2.23.0.
TRACKER_API = "https://aethernet-tracker.ubifaethernet.workers.dev"

# The dev channel: everything that differs from the public build.
DEV = {
    "gist_id": "9ac1e1dbc80caa3dff04afb5b89e90c3",  # secret Gist, account Unix-Epoch
    "name": "Aethernet (dev)",
    "namespace": "garrett.ubif.dev",   # a separate script to Tampermonkey: own install + storage
    "waymark_api": "https://aethernet-waymark-dev.ubifaethernet.workers.dev",
    "tracker_api": "https://aethernet-tracker.ubifaethernet.workers.dev",
    "dist": "dist-dev",
    "status_file": "status-dev.json",
    "counter": "dev-build.txt",       # last dev build number
}
# The demo channel: a cut-down build that must read as the real thing (no
# "demo" anywhere a user can see: name, namespace, Gist, About).
DEMO = {
    "gist_id": "70bd9467c98413dccf10e8d27cdea7ea",  # secret Gist, account Unix-Epoch
    "version": "2.16.1",               # bump for each --demo publish
    "name": "Aethernet",
    "namespace": "garrett.aethernet",  # its own install + storage (can sit beside the public one)
    "dist": "dist-demo",
    "status_file": "status-demo.json",
    # Only these shards (and the files that hold them) go in.
    "shards": ("cleaningRate", "autoClose", "glamour"),
    "icons": ("dualcast", "triplecast"),  # extra icons its shards use (Swiftcast's Dualcast)
    "files": ("00-core.js", "01b-login.js", "02-status.js", "05-settings.js", "10-cleaning-rate.js", "20-auto-close.js", "50-glamour.js"),
    "description": "Shards (add-on tools) for NextGen Portal: live cleaning rate, one-click cleaning close-out and page theming for portal.ubreakifix.net. Settings: avatar menu → Aethernet settings.",
}
CHANNEL = "public"  # set to "dev" / "demo" by --dev / --demo before building
# Minifier, pinned so builds are repeatable; run through npx (no local node_modules).
ESBUILD = ["npx", "--yes", "esbuild@0.28.2"]

def channel_raw() -> str:
    return gist_raw(DEV["gist_id"]) if CHANNEL == "dev" else gist_raw(DEMO["gist_id"]) if CHANNEL == "demo" else GIST_RAW


# Dev builds only: the SharePoint download test in the dev tools (Provoke's sheets, off this Mac).
DEV_GRANTS = """
// @grant        GM_xmlhttpRequest
// @connect      ubreakifix-my.sharepoint.com"""


def header(version: str) -> str:
    dev = CHANNEL == "dev"
    raw = channel_raw()
    if CHANNEL == "demo":
        return f"""// ==UserScript==
// @name         {DEMO["name"]}
// @namespace    {DEMO["namespace"]}
// @version      {version}
// @copyright    2026, Garrett Green. All rights reserved.
// @license      Proprietary — no reproduction, redistribution, or derivative works without written permission.
// @description  {DEMO["description"]}
// @match        https://portal.ubreakifix.net/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @updateURL    {raw}/{META_FILENAME}
// @downloadURL  {raw}/{FILENAME}
// ==/UserScript==
"""
    return f"""// ==UserScript==
// @name         {DEV["name"] if dev else "Aethernet — shards for NextGen Portal"}
// @namespace    {DEV["namespace"] if dev else "garrett.ubif"}
// @version      {version}
// @copyright    2026, Garrett Green. All rights reserved.
// @license      Proprietary — no reproduction, redistribution, or derivative works without written permission.
// @description  Shards (add-on tools) for NextGen Portal: live cleaning rate, one-click cleaning close-out, Galaxy Diagnostics exception filing, print-all-labels and buyback add-all for portal.ubreakifix.net. Settings: avatar menu → Aethernet settings.
// @match        https://portal.ubreakifix.net/*
// @match        https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7*{chr(10) + "// @match        http://localhost:8790/*" if dev else ""}
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand{DEV_GRANTS if dev else ""}
// @run-at       document-start
// @updateURL    {raw}/{META_FILENAME}
// @downloadURL  {raw}/{FILENAME}
// ==/UserScript==

/*
  Aethernet — (c) 2026 Garrett Green. All rights reserved.

  Provided solely for use within authorized uBreakiFix stores, running against
  the author-operated Aethernet backend. No part of this source may be copied,
  redistributed, published, or used to produce derivative or reproduced works --
  in whole or in part, by any person or automated/AI system -- without the
  author's express written permission. Use of the tool grants no right to its
  source. Questions or permission requests: contact the author.
*/
"""


def gist_raw(gist_id: str) -> str:
    return f"https://gist.githubusercontent.com/Unix-Epoch/{gist_id}/raw"


def dev_version(root: Path, bump: bool, live: str | None = None) -> str:
    """DEV_BASE.N. A publish (bump=True) takes N = max(local counter, live dev Gist's N) + 1, so a
    machine with a stale dev-build.txt can't publish a lower version than what's already out.
    `live` is the dev Gist's current @version. A different DEV_BASE there leaves the local counter alone."""
    f = root / DEV["counter"]
    n = int(f.read_text().strip()) if f.exists() else 0
    if bump:
        if live:
            prefix = DEV_BASE + "."
            if live.startswith(prefix) and live[len(prefix):].isdigit():
                lv = int(live[len(prefix):])
                if lv > n:
                    print(f"Note: the live dev Gist is at {live}, ahead of this machine's {DEV['counter']} ({n}); numbering from {lv}.")
                n = max(n, lv)
            else:
                print(f"Note: the live dev Gist is at {live}, a different base than {DEV_BASE}; numbering from the local counter ({n}).")
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
PREBOOT = ("00-core.js", "01-access.js", "01b-login.js")

NOTES_FILE = "patch-notes.json"


def load_notes(root: Path) -> list:
    # Newest first: [{version, date (UTC ISO, stamped at release), notes: [...],
    # credits?: [names whose suggestion shipped], thanks?: ["**Name** at Store, for …"] (both shown with a flair),
    # reports?: [{id, quote, credit, store}] (bug reports fixed in it; pulled from the Worker by pull_reports),
    # updated?: [ids of existing shards it changed → "Updated" sheen]}]
    notes = json.loads((root / NOTES_FILE).read_text())
    known = shard_ids(root)
    for n in notes:
        bad = [c for c in n.get("updated", []) if c not in known]
        if bad:
            sys.exit(f"{NOTES_FILE}: {n['version']} lists unknown shard ids in \"updated\": {bad}")
    return notes


def pull_reports(root: Path, version: str, api: str) -> None:
    """Bug reports marked fixed in `version` (admin panel → Quote in patch notes) go into that
    version's patch notes as "reports": [{id, quote, credit, store}]. Saved in patch-notes.json so
    the release has them; if the Worker can't be reached, what's already there stays."""
    try:
        req = urllib.request.Request(f"{api}/v1/fixed?version={version}", headers={"x-aethernet-key": waymark_key(root), "user-agent": "aethernet-build"})
        rows = json.loads(urllib.request.urlopen(req, timeout=15).read()).get("reports", [])
    except Exception as e:
        print(f"warning: couldn't pull fixed bug reports for {version} ({e}); keeping what's in {NOTES_FILE}")
        return
    notes = json.loads((root / NOTES_FILE).read_text())
    entry = next((n for n in notes if n["version"] == version), None)
    reports = [{k: r.get(k) for k in ("id", "quote", "credit", "store") if r.get(k) is not None} for r in rows if r.get("quote")]
    if not entry:
        if reports:
            print(f"warning: {len(reports)} fixed bug report(s) are marked for {version}, but {NOTES_FILE} has no {version} entry yet")
        return
    if (entry.get("reports") or []) != reports:
        if reports: entry["reports"] = reports
        else: entry.pop("reports", None)
        (root / NOTES_FILE).write_text(json.dumps(notes, indent=2, ensure_ascii=False) + "\n")
        print(f"Patch notes {version}: {len(reports)} fixed bug report(s) quoted")


def stamp_release_date(root: Path) -> None:
    # Patch notes carry the moment each version went out; --release fills it in.
    notes = load_notes(root)
    entry = next((n for n in notes if n["version"] == VERSION), None)
    if not entry:  # a quiet patch (e.g. 2.22.1): no notes, and installs show no "has updated" pill
        print(f"Quiet release: {NOTES_FILE} has no entry for {VERSION}, so no patch notes.")
        return
    if not entry.get("date"):
        entry["date"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        (root / NOTES_FILE).write_text(json.dumps(notes, indent=2, ensure_ascii=False) + "\n")


def tracker_module(root: Path, name: str) -> str:
    # The same file the Worker, the admin site and the import use, minus its ES module syntax.
    src = (root / "tracker-worker" / "src" / name).read_text()
    names = re.findall(r"^export (?:async )?(?:const|function) (\w+)", src, flags=re.M)
    return re.sub(r"^export ", "", src, flags=re.M) + "\nreturn { " + ", ".join(names) + " };\n"


def assize_graphs(root: Path) -> str:
    # { rule: graph } from src/assize-graphs/<rule>.json, as one JS object literal.
    return json.dumps({f.stem: json.loads(f.read_text()) for f in sorted((root / "src" / "assize-graphs").glob("*.json"))}, separators=(",", ":"), ensure_ascii=False)


def waymark_key(root: Path) -> str:
    m = re.search(r'^APP_KEY\s*=\s*"([^"]+)"', (root / "worker" / "wrangler.toml").read_text(), re.M)
    return m.group(1) if m else ""


def action_icons(root: Path) -> str:
    demo = CHANNEL == "demo"
    icons = {
        f.stem: "data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode()
        for f in sorted((root / "assets" / "icons").glob("*.jpg"))
        if not demo or f.stem in DEMO["shards"] or f.stem in DEMO.get("icons", ())
    }
    # FFXIV UI pieces (e.g. the hotbar macro gear), keyed "ui/<name>"
    for f in ([] if demo else sorted((root / "assets" / "ui").glob("*.png"))):
        icons["ui/" + f.stem] = "data:image/png;base64," + base64.b64encode(f.read_bytes()).decode()
    return json.dumps(icons)


DEV_ONLY_FILES = {"59-spread.js"}  # Spread: dev channel only until released (drop it from here, and the AE_DEV guards, to ship it)


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
        "__WAYMARK_API__": os.environ.get("WAYMARK_API", DEV["waymark_api"] if dev else WAYMARK_API),
        "__WAYMARK_KEY__": waymark_key(root),
        "__TRACKER_API__": os.environ.get("TRACKER_API", DEV["tracker_api"] if dev else TRACKER_API),
        # The tracker's encryption and shaping (tracker-worker/src/crypto.js, shape.js), as plain function bodies.
        "/*__TRACKER_CRYPTO__*/": tracker_module(root, "crypto.js"),
        "/*__TRACKER_SHAPE__*/": tracker_module(root, "shape.js"),
        # Retrace's normalization and label parsing (tracker-worker/src/retrace.js), for the collector and the watcher (src/28-retrace-collect.js).
        "/*__RETRACE__*/": tracker_module(root, "retrace.js"),
        # Assize's rule graphs: the interpreter (tracker-worker/src/rulegraph.js) and the built-in graphs (src/assize-graphs/*.json).
        "/*__RULEGRAPH__*/": tracker_module(root, "rulegraph.js"),
        # Assize's rules engine (tracker-worker/src/assize-rules.js), shared with the tracker Worker and the admin site.
        "/*__ASSIZE_RULES__*/": tracker_module(root, "assize-rules.js"),
        "__ASSIZE_GRAPHS__": assize_graphs(root),
        # FFXIV action icons, one per shard (assets/icons/<shardId>.jpg), plus
        # UI pieces (assets/ui/*.png), as data URIs
        "__ACTION_ICONS__": action_icons(root),
        "__PATCH_NOTES__": "[]" if demo else json.dumps(load_notes(root)),
    }
    head = header(version)
    parts = [head, "(function aethernet() {\n'use strict';\n"]
    # src/dev/*.js (dev tools) only go into dev builds; everything sorts by file name.
    files = list((root / "src").glob("*.js")) + (list((root / "src" / "dev").glob("*.js")) if dev else [])
    if not dev:  # shards that exist only in the dev channel until they are released (their Settings text is behind AE_DEV too)
        files = [f for f in files if f.name not in DEV_ONLY_FILES]
    if demo:  # only its shards; no store check (01-access.js), so it boots straight away
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
    parts.append("\nAE.start();\n};\n" + ("AE.whenReady(AE.boot);" if demo else "AE.whenReady(AE.gate);") + "\n})();\n")
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


def gist_version(gist_id: str) -> str | None:
    # Read through the GitHub API, not the raw URL: raw gist URLs sit behind
    # a CDN that served a stale copy right after publishing (seen on the
    # first release), which would let a same-version release slip through.
    content = subprocess.run(
        ["gh", "api", f"gists/{gist_id}", "--jq", f'.files["{FILENAME}"].content // ""'],
        check=True, capture_output=True, text=True,
    ).stdout
    m = re.search(r"^// @version\s+(\S+)", content, re.M)
    return m.group(1) if m else None


def published_version() -> str | None:
    return gist_version(GIST_ID)


STATUS_FILE = "status.json"
SEVERITIES = ("info", "warning", "error")


def now_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def shard_ids(root: Path) -> set:
    return {m for f in (root / "src").glob("*.js") for m in re.findall(r"AE\.shard\(\{\s*id:\s*'(\w+)'", f.read_text())}


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
        dev["bulletins"] = status.get("bulletins")
        publish_dev_status(root, dev)
    # Demo installs only hear about notices that concern their own shards.
    if DEMO["gist_id"]:
        demo = load_channel_status(root, DEMO["status_file"])
        inc = demo_incident(status.get("incident"))
        if demo.get("incident") != inc:
            demo["incident"] = inc
            publish_channel_status(root, DEMO["status_file"], DEMO["gist_id"], demo)


def demo_incident(inc):
    if not inc:
        return None
    ours = set(DEMO["shards"])
    touched = set(inc.get("shards") or []) | set(inc.get("pause") or [])
    if not touched & ours:
        return None
    mine = [c for c in inc.get("shards") or [] if c in ours]
    return {**inc, "shards": mine, "crystals": mine,  # "crystals": old clients (see mirror_legacy_shards)
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


def bulletins_command(root: Path, args) -> None:
    """Master's Mend bulletin rules (status.json "bulletins", 2.22.0+): no update needed."""
    status = load_status(root)
    b = status.get("bulletins") or {}
    if args.bulletins_show:
        print(json.dumps(b, indent=2, ensure_ascii=False))
        return
    preflight_status(root, ("public", "dev", "demo"), args.status_base)  # publish_status also rewrites the dev and demo files
    status = load_status(root)
    b = status.get("bulletins") or {}
    if args.bulletins_reset:
        status["bulletins"] = None
    else:
        for key, vals in (("pages", args.bulletin_page), ("patterns", args.bulletin_pattern), ("selectors", args.bulletin_selector), ("closers", args.bulletin_closer)):
            for v in vals or []:
                if key == "pages":
                    re.compile(v)  # refuse a broken regex here rather than ship it
                if key == "patterns" and not re.fullmatch(r"[a-z-]{1,24}", v):
                    sys.exit(f"Pattern types are lowercase words (e.g. shorty, modal), not {v!r}")
                b.setdefault(key, [])
                if v not in b[key]:
                    b[key].append(v)
        for key, vals in (("pages", args.bulletin_unpage), ("selectors", args.bulletin_unselector)):
            for v in vals or []:
                if v in b.get(key, []):
                    b[key].remove(v)
        status["bulletins"] = {k: v for k, v in b.items() if v} or None
    publish_status(root, status)


def mirror_legacy_shards(inc) -> None:
    """Write the notice's shard list under both "shards" and the old "crystals" key (same list),
    so installs from before the rename (which only read "crystals") still get badges and pauses."""
    if inc:
        inc["shards"] = inc["crystals"] = list(inc.get("shards") or inc.get("crystals") or [])


def apply_notice_extras(inc: dict, args) -> None:
    """--mention / --chip (2.22.0+ installs). A chip shows only on installs older than
    --chip-below, which defaults to VERSION (the version being pushed): the fixed
    version never shows it. Older installs ignore both (they only know shards/tag)."""
    if args.mention:
        inc["mentions"] = args.mention
    if args.chip:
        below = args.chip_below or VERSION
        inc["chips"] = [{"id": cid, "text": text, "below": below} for cid, text in args.chip]


def status_command(root: Path, args) -> None:
    known = shard_ids(root)
    for cid in (args.shard or []) + (args.pause or []) + (args.mention or []) + [c for c, _ in (args.chip or [])]:
        if cid not in known:
            sys.exit(f"Unknown shard id {cid!r}. Known: {', '.join(sorted(known))}")
    if args.status_show:
        status_show(root)
        return
    preflight_status(root, ("public", "dev", "demo"), args.status_base)  # publish_status also rewrites the dev and demo files
    status = load_status(root)
    inc = status.get("incident")
    if args.status:
        severity, title, *rest = args.status
        if severity not in SEVERITIES:
            sys.exit(f"Severity must be one of {', '.join(SEVERITIES)}")
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40]
        t = now_utc()
        status["incident"] = {
            "id": t[:10] + "-" + slug, "severity": severity, "title": title,
            "message": " ".join(rest), "shards": args.shard or [], "pause": args.pause or [],
            "fixedIn": None, "posted": t, "updated": t,
        }
        if args.tag:
            status["incident"]["tag"] = args.tag
        apply_notice_extras(status["incident"], args)
    elif args.status_update is not None:
        if not inc:
            sys.exit("No notice is live to update.")
        inc["message"], inc["updated"] = args.status_update, now_utc()
        if args.shard: inc["shards"] = args.shard
        if args.pause is not None: inc["pause"] = args.pause
        if args.tag: inc["tag"] = args.tag
        apply_notice_extras(inc, args)
    elif args.status_fixed:
        if not inc:
            sys.exit("No notice is live to mark fixed.")
        inc["fixedIn"], inc["updated"] = args.status_fixed, now_utc()
    elif args.status_clear:
        status["incident"] = None
    mirror_legacy_shards(status.get("incident"))
    publish_status(root, status)


# ---------------------------------------------------------------------------
# Safety guards for everything that publishes.
#
# 1. Release gate: --release and --demo refuse unless the checkout is the right
#    branch, clean, passing its tests, free of env overrides, and the built
#    bundle holds no dev-channel code. There is no bypass flag.
# 2. Status base check: a channel's status file is only published after it was
#    compared with the LIVE copy (ignoring "latest"); a difference stops the run
#    until --status-base live|local says which one wins.
# ---------------------------------------------------------------------------

ENV_OVERRIDES = ("WAYMARK_API", "TRACKER_API")  # the env vars build() honours; they redirect a bundle to another Worker
RELEASE_BRANCH_RE = re.compile(r"main|release-.+")
DEMO_BRANCH = "demo"
TEST_CMD = ["node", "test-client/run.mjs"]
SHARD_RE = r"AE\.shard\(\{\s*id:\s*'(\w+)'"


def git_out(root: Path, *args: str) -> str:
    res = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    if res.returncode:
        sys.exit(f"Refusing to publish: `git {' '.join(args)}` failed: {res.stderr.strip() or res.stdout.strip()}")
    return res.stdout


def release_gate(root: Path, channel: str) -> None:
    """Refuse (sys.exit) before anything is built or published unless every condition holds.
    channel is "public" (--release) or "demo" (--demo).

    Dev-only shards (Return, Provoke, Tactician, ...) are NOT in DEV_ONLY_FILES: they are in
    every non-dev bundle built from `dev` and default to on. The branch check below is what keeps
    them out of public releases; which shards go public is the owner's call, so they are not added
    to DEV_ONLY_FILES here."""
    flag = "--release" if channel == "public" else "--demo"
    branch = git_out(root, "rev-parse", "--abbrev-ref", "HEAD").strip()
    if channel == "public":
        if not RELEASE_BRANCH_RE.fullmatch(branch):
            sys.exit(f"Refusing {flag}: the checked-out branch is {branch!r}, but public releases are only cut from `main` or `release-*`. "
                     "Anything on `dev` (Return, Provoke, Tactician and other dev-only shards) would ship to every store.")
    elif branch != DEMO_BRANCH:
        sys.exit(f"Refusing {flag}: the checked-out branch is {branch!r}; the demo is only published from the `{DEMO_BRANCH}` branch.")
    dirty = git_out(root, "status", "--porcelain").strip()
    if dirty:
        shown = "\n".join("  " + l for l in dirty.splitlines()[:15])
        sys.exit(f"Refusing {flag}: the working tree isn't clean ({len(dirty.splitlines())} modified/untracked path(s); git-ignored files don't count). "
                 f"Commit or stash first:\n{shown}")
    set_vars = [v for v in ENV_OVERRIDES if v in os.environ]
    if set_vars:
        sys.exit(f"Refusing {flag}: environment override(s) set: {', '.join(set_vars)}. They would point the published bundle at another Worker. Unset them.")
    res = subprocess.run(TEST_CMD, cwd=root, capture_output=True, text=True)
    lines = [l for l in (res.stdout + res.stderr).strip().splitlines() if l.strip()]
    last = lines[-1] if lines else "(no output)"
    if res.returncode:
        sys.exit(f"Refusing {flag}: `{' '.join(TEST_CMD)}` exited {res.returncode}. Last line: {last}")
    print(f"Tests passed ({' '.join(TEST_CMD)}): {last}")


def dev_only_markers(root: Path) -> dict:
    """label -> regex for code that exists only in DEV_ONLY_FILES, derived from the files themselves:
    the file's banner comment, each shard id it registers, and each AE.<name> it defines."""
    markers = {}
    for name in sorted(DEV_ONLY_FILES):
        f = root / "src" / name
        if not f.exists():
            continue
        text = f.read_text()
        markers[f"{name} banner"] = re.escape(f"// ===== {name} =====")
        for sid in re.findall(SHARD_RE, text):
            markers[f"{name} shard id '{sid}'"] = r"""\bid\s*:\s*['"]""" + re.escape(sid) + r"""['"]"""
        for g in sorted(set(re.findall(r"^\s*AE\.(\w+)\s*=[^=]", text, re.M))):
            markers[f"{name} AE.{g}"] = r"\bAE\." + re.escape(g) + r"\s*=[^=]"
    return markers


def scan_for_dev_code(root: Path, dist: Path) -> None:
    """Fail if a non-dev build (all three published-style files in `dist`) contains dev-only code."""
    markers = dev_only_markers(root)
    hits = []
    for name in (FILENAME, META_FILENAME, READABLE_FILENAME):
        f = dist / name
        if not f.exists():
            continue
        text = f.read_text()
        hits += [f"{name}: {label}" for label, rx in markers.items() if re.search(rx, text)]
    if hits:
        sys.exit("Refusing to publish: the build contains dev-channel code:\n  " + "\n  ".join(hits))
    print(f"Dev-code scan clean ({len(markers)} markers from {', '.join(sorted(DEV_ONLY_FILES)) or 'no files'}).")


class LiveStatusError(Exception):
    pass


STATUS_CHANNELS = {  # name -> (local file, Gist id); every Gist holds the file as status.json
    "public": (STATUS_FILE, GIST_ID),
    "dev": (DEV["status_file"], DEV["gist_id"]),
    "demo": (DEMO["status_file"], DEMO["gist_id"]),
}
# The Gist API marks every file "truncated" once the Gist is large (the bundle is ~900 KB), even a 1 KB status.json. Its
# raw_url is pinned to the file's blob, so unlike the plain raw URL it can't serve a stale copy: read that instead.
_STATUS_RAW = "RAW:"
_STATUS_JQ = ('if .files["status.json"] == null then "" elif .files["status.json"].truncated then "' + _STATUS_RAW + '" + .files["status.json"].raw_url '
              'else .files["status.json"].content end')


def fetch_live_status(gist_id: str) -> dict:
    """The channel's live status.json, read through the GitHub API (same route as gist_version):
    the raw URL can serve a stale copy right after a publish. A Gist with no status.json gives {}."""
    res = subprocess.run(["gh", "api", f"gists/{gist_id}", "--jq", _STATUS_JQ], capture_output=True, text=True)
    if res.returncode:
        raise LiveStatusError((res.stderr or res.stdout).strip() or f"gh exited {res.returncode}")
    if not res.stdout.strip():
        return {}
    text = res.stdout
    if text.startswith(_STATUS_RAW):
        url = text[len(_STATUS_RAW):].strip()
        if not re.match(r"^https://gist\.githubusercontent\.com/[^/]+/" + re.escape(gist_id) + r"/raw/[0-9a-f]{40}/status\.json$", url):
            raise LiveStatusError("unexpected raw_url for status.json")
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                text = r.read().decode("utf-8")
        except Exception as e:  # noqa: BLE001 - any failure means "can't read live"
            raise LiveStatusError(f"couldn't read the pinned status.json ({e})")
    try:
        data = json.loads(text)
    except ValueError as e:
        raise LiveStatusError(f"live status.json isn't valid JSON ({e})")
    if not isinstance(data, dict):
        raise LiveStatusError("live status.json isn't a JSON object")
    return data


def without_latest(status: dict) -> dict:
    return {k: v for k, v in status.items() if k != "latest"}


def read_status_file(root: Path, name: str) -> dict:
    f = root / name
    return json.loads(f.read_text()) if f.exists() else {"latest": None, "incident": None}


def write_status_file(root: Path, name: str, status: dict) -> None:
    (root / name).write_text(json.dumps(status, indent=2, ensure_ascii=False) + "\n")


def status_summary(status: dict) -> list:
    inc, out = status.get("incident"), []
    if inc:
        out.append(f"incident {inc.get('id')!r}: {inc.get('severity')} \"{inc.get('title')}\" updated {inc.get('updated')}")
        out.append(f"  pauses: {', '.join(inc.get('pause') or []) or 'none'}; shards: {', '.join(inc.get('shards') or []) or 'none'}; fixedIn: {inc.get('fixedIn')}")
    else:
        out.append("incident: none")
    b = status.get("bulletins")
    out.append("bulletins: " + (json.dumps(b, ensure_ascii=False) if b else "none"))
    other = sorted(set(status) - {"latest", "incident", "bulletins"})
    if other:
        out.append("other keys: " + ", ".join(other))
    return out


def status_diff(live: dict, local: dict) -> str:
    import difflib
    dump = lambda d: json.dumps(without_latest(d), indent=2, ensure_ascii=False, sort_keys=True).splitlines()
    lines = ["  LIVE:"] + ["    " + l for l in status_summary(live)] + ["  LOCAL:"] + ["    " + l for l in status_summary(local)]
    lines += ["  diff (- live, + local; \"latest\" ignored):"]
    lines += ["    " + l for l in difflib.unified_diff(dump(live), dump(local), "live", "local", lineterm="", n=2)]
    return "\n".join(lines)


def preflight_status(root: Path, names, mode: str | None) -> None:
    """Compare each channel's LIVE status with the local file (ignoring "latest") BEFORE anything is
    modified or published. Equal: carry on (the local file takes the live "latest"). Different, or live
    unreadable: stop, unless `mode` says which copy is the base:
      "live"  adopt the live copy (written to the local file), then apply the change
      "local" publish the local copy over live (also the only way past an unreadable live copy)"""
    fetched, problems = {}, []
    for name in names:
        fname, gid = STATUS_CHANNELS[name]
        local = read_status_file(root, fname)
        try:
            fetched[name] = (fname, local, fetch_live_status(gid))
        except LiveStatusError as e:
            if mode == "local":
                print(f"[{name}] can't read the live status ({e}); publishing the local {fname} because --status-base local was given.")
            else:
                problems.append(f"[{name}] can't read the live {fname} from Gist {gid[:8]}…: {e}\n  Not publishing blind. Retry, or pass --status-base local to publish the local copy anyway.")
    for name, (fname, local, live) in fetched.items():
        if without_latest(live) != without_latest(local) and mode is None:
            problems.append(f"[{name}] live status differs from local {fname}:\n{status_diff(live, local)}")
    if problems:
        sys.exit("Refusing to publish: the status base check failed.\n" + "\n".join(problems) +
                 "\n\nChoose explicitly: --status-base live (adopt the live copy as the base) or --status-base local (publish the local copy, overwriting live).")
    for name, (fname, local, live) in fetched.items():
        if without_latest(live) != without_latest(local):
            if mode == "live":
                write_status_file(root, fname, live)
                print(f"[{name}] --status-base live: {fname} replaced by the live copy.")
                continue
            print(f"[{name}] --status-base local: the local {fname} will overwrite the live status.\n{status_diff(live, local)}")
        if live.get("latest") != local.get("latest"):  # "latest" is only ever set by a release/dev/demo publish, so keep the live one
            write_status_file(root, fname, {**local, "latest": live.get("latest")})


def status_show(root: Path) -> None:
    """Print local and live status for every channel and whether they match. Read-only."""
    for name, (fname, gid) in STATUS_CHANNELS.items():
        local = read_status_file(root, fname)
        print(f"== {name}: {fname} (Gist {gid[:8]}…)\nLOCAL: {json.dumps(local, ensure_ascii=False)}")
        try:
            live = fetch_live_status(gid)
        except LiveStatusError as e:
            print(f"LIVE: can't read ({e})\nMATCH: unknown\n")
            continue
        print(f"LIVE:  {json.dumps(live, ensure_ascii=False)}")
        if without_latest(live) == without_latest(local):
            print("MATCH (ignoring latest): yes\n" + ("" if live.get("latest") == local.get("latest") else f"  (latest differs: live {live.get('latest')}, local {local.get('latest')})\n"))
        else:
            print("MATCH (ignoring latest): NO\n" + status_diff(live, local) + "\n")


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
    # (the status base check already ran in do_release, before anything was published)
    # Tell running installs there's an update (they check status.json every 10 minutes).
    entry = next((n for n in load_notes(root) if n["version"] == VERSION), None)  # none for a quiet patch
    status = load_status(root)
    status["latest"] = {"version": VERSION, "date": entry["date"] if entry else now_utc()}
    publish_status(root, status)


def dev_release(root: Path, status_base: str | None = None) -> None:
    global CHANNEL
    if not DEV["gist_id"]:
        sys.exit("No dev Gist yet: set DEV['gist_id'] in build.py.")
    CHANNEL = "dev"
    # dev's status takes its notice from the public file, so both are checked against live first
    preflight_status(root, ("dev", "public"), status_base)
    try:
        live_dev = gist_version(DEV["gist_id"])
    except subprocess.CalledProcessError as e:
        sys.exit(f"Refusing to publish: can't read the live dev version ({(e.stderr or '').strip() or e}); not numbering a build blind.")
    version = dev_version(root, bump=True, live=live_dev)
    pull_reports(root, DEV_BASE, DEV["waymark_api"])
    out = build(root, version)
    files = gist_files(DEV["gist_id"])
    for name in (FILENAME, META_FILENAME, READABLE_FILENAME):
        gist_put(out.parent / name, files, DEV["gist_id"])
    print(f"Published dev v{version}. Dev install link:\n  {gist_raw(DEV['gist_id'])}/{FILENAME}")
    status = load_dev_status(root)
    status["latest"] = {"version": version, "date": now_utc()}
    status["incident"] = load_status(root).get("incident")  # same notice as the public channel
    publish_dev_status(root, status)


def demo_release(root: Path, status_base: str | None = None) -> None:
    global CHANNEL
    if not DEMO["gist_id"]:
        sys.exit("No demo Gist yet: set DEMO['gist_id'] in build.py.")
    release_gate(root, "demo")
    preflight_status(root, ("demo", "public"), status_base)  # the demo takes its notice from the public file
    content = subprocess.run(["gh", "api", f"gists/{DEMO['gist_id']}", "--jq", f'.files["{FILENAME}"].content // ""'],
                             check=True, capture_output=True, text=True).stdout
    m = re.search(r"^// @version\s+(\S+)", content, re.M)
    if m and as_tuple(DEMO["version"]) <= as_tuple(m.group(1)):
        sys.exit(f"Refusing to publish: DEMO version {DEMO['version']} isn't higher than the published {m.group(1)}.")
    CHANNEL = "demo"
    out = build(root, DEMO["version"])
    scan_for_dev_code(root, out.parent)
    # Nothing that gives it away: the word "demo", or any left-out shard / feature.
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


def do_release(root: Path, status_base: str | None = None) -> None:
    release_gate(root, "public")                                       # branch, clean tree, tests, env: before anything else
    live = check_releasable()                                          # read-only: VERSION must beat the live one
    preflight_status(root, ("public", "dev", "demo"), status_base)     # release() rewrites all three status files
    pull_reports(root, VERSION, WAYMARK_API)  # bug reports quoted as fixed in this version
    stamp_release_date(root)  # before building, so the published file carries it
    out = build(root)
    scan_for_dev_code(root, out.parent)                                # the non-dev bundle must hold no dev-only code
    release(root, out, live)


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
    ap.add_argument("--shard", "--crystal", action="append", dest="shard",  # --crystal: old spelling, still accepted
                     metavar="ID", help="shard the notice is about (repeatable)")
    ap.add_argument("--pause", action="append", metavar="ID", help="shard to pause everywhere (repeatable)")
    ap.add_argument("--pull-reports", metavar="VERSION", help="pull bug reports quoted as fixed in VERSION into patch-notes.json")
    ap.add_argument("--bulletins-show", action="store_true", help="print the live bulletin rules")
    ap.add_argument("--bulletins-reset", action="store_true", help="remove all bulletin rules (built-in ones stay)")
    ap.add_argument("--bulletin-page", action="append", metavar="REGEX", help="a page (path regex) where bulletins get controls; replaces the built-in WO-only list")
    ap.add_argument("--bulletin-unpage", action="append", metavar="REGEX", help="remove a page rule")
    ap.add_argument("--bulletin-pattern", action="append", metavar="TYPE", help="an Appcues data-pattern-type that counts as a bulletin")
    ap.add_argument("--bulletin-selector", action="append", metavar="CSS", help="a CSS selector for a bulletin's box")
    ap.add_argument("--bulletin-unselector", action="append", metavar="CSS", help="remove a selector rule")
    ap.add_argument("--bulletin-closer", action="append", metavar="CSS", help="a close button to hide inside bulletins")
    ap.add_argument("--mention", action="append", metavar="ID", help="shard named in the notice: icon + link, no badge (2.22.0+)")
    ap.add_argument("--chip", action="append", nargs=2, metavar=("ID", "TEXT"), help="badge on a shard's Settings row, only on installs older than --chip-below (2.22.0+)")
    ap.add_argument("--chip-below", metavar="VERSION", help="chips show on installs older than this (default: VERSION, the version being pushed)")
    ap.add_argument("--status-base", choices=("live", "local"), help="when a channel's live status.json differs from the local file (or can't be read): "
                    "'live' adopts the live copy as the base, 'local' publishes the local copy over it. Never chosen for you.")
    ap.add_argument("--tag", metavar="TEXT", help='badge text on the shards\' Settings rows (default "Known issue")')
    args = ap.parse_args()
    root = Path(__file__).resolve().parent
    if args.pull_reports:
        pull_reports(root, args.pull_reports, WAYMARK_API)
        sys.exit(0)
    if (args.bulletins_show or args.bulletins_reset or args.bulletin_page or args.bulletin_unpage or args.bulletin_pattern
            or args.bulletin_selector or args.bulletin_unselector or args.bulletin_closer):
        bulletins_command(root, args)
        sys.exit(0)
    if args.status or args.status_update is not None or args.status_fixed or args.status_clear or args.status_show:
        if args.status and len(args.status) < 2:
            ap.error("--status needs at least SEVERITY and TITLE")
        status_command(root, args)
        sys.exit(0)
    if args.dev:
        dev_release(root, args.status_base)
        sys.exit(0)
    if args.dev_build:
        CHANNEL = "dev"
        build(root, dev_version(root, bump=False))
        sys.exit(0)
    if args.demo:
        demo_release(root, args.status_base)
        sys.exit(0)
    if args.demo_build:
        CHANNEL = "demo"
        build(root, DEMO["version"])
        sys.exit(0)
    if args.release:
        do_release(root, args.status_base)
        sys.exit(0)
    build(root)
