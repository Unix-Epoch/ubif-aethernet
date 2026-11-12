"""Tests for build.py's publish guards. Nothing here can publish: at import, subprocess.run and
urllib's urlopen inside build.py are replaced by fakes that raise on any command not scripted
(so a real `gh gist edit`, `gh api` or network call fails the test), and gist_put is a recorder.

Run: python3 -m unittest test-build/test_build.py   (from the repo root)
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import build  # noqa: E402


class RealCallAttempted(AssertionError):
    pass


class World:
    """What the fake git / node / gh answer. Every call is logged in `calls`."""
    def __init__(self):
        self.branch, self.dirty, self.test_rc, self.test_last = "main", "", 0, "ALL PASS 123 checks"
        self.status = {}    # gist id -> status dict | str (raw) | Exception
        self.versions = {}  # gist id -> script @version
        self.calls = []
        self.gist_puts = []


WORLD = World()


def fake_run(cmd, **kw):
    WORLD.calls.append(list(cmd))
    out = lambda s="", rc=0: subprocess_result(cmd, rc, s)
    if cmd[:3] == ["git", "rev-parse", "--abbrev-ref"]:
        return out(WORLD.branch + "\n")
    if cmd[:3] == ["git", "status", "--porcelain"]:
        return out(WORLD.dirty)
    if cmd[:2] == ["node", "test-client/run.mjs"]:
        return subprocess_result(cmd, WORLD.test_rc, "noise\n" + WORLD.test_last + "\n")
    if cmd[:2] == ["gh", "api"] and cmd[2].startswith("gists/") and "--jq" in cmd:
        gid = cmd[2].split("/")[1]
        jq = cmd[cmd.index("--jq") + 1]
        if "status.json" in jq:
            v = WORLD.status.get(gid, Exception("no such gist"))
            if isinstance(v, Exception):
                return out(rc=1, s="") if False else subprocess_result(cmd, 1, "", str(v))
            return out(v if isinstance(v, str) else json.dumps(v))
        if "aethernet.user.js" in jq:
            return out(f"// @version      {WORLD.versions[gid]}\n")
    raise RealCallAttempted(f"unscripted external call: {cmd}")


def subprocess_result(cmd, rc, stdout, stderr=""):
    import subprocess
    return subprocess.CompletedProcess(cmd, rc, stdout, stderr)


def fake_urlopen(*a, **k):
    raise RealCallAttempted(f"network call attempted: {a}")


def fake_gist_put(path, files, gist_id=build.GIST_ID, as_name=None):
    WORLD.gist_puts.append((as_name or Path(path).name, gist_id))


# Installed for the whole module (never undone): from here on build.py cannot reach gh or the network.
build.subprocess.run = fake_run
build.urllib.request.urlopen = fake_urlopen
build.gist_put = fake_gist_put
build.gist_files = lambda gid: ["status.json", "aethernet.user.js"]
assert build.gist_put is fake_gist_put and build.subprocess.run is fake_run

PUB, DEVG, DEMOG = build.GIST_ID, build.DEV["gist_id"], build.DEMO["gist_id"]
INC = {"id": "2026-10-18-waymark", "severity": "warning", "title": "Waymark slow", "message": "m", "shards": ["waymark"],
       "pause": ["waymark"], "fixedIn": None, "posted": "t", "updated": "t"}


def quiet(fn, *a, **k):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            return fn(*a, **k), buf.getvalue()
        except SystemExit as e:
            return e, buf.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        global WORLD
        WORLD = World()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "src").mkdir()
        (self.root / "src" / "59-spread.js").write_text("AE.spread = (() => 1)();\nAE.shard({\n  id: 'spread',\n  name: 'Spread',\n});\n")
        for gid, f in ((PUB, build.STATUS_FILE), (DEVG, build.DEV["status_file"]), (DEMOG, build.DEMO["status_file"])):
            build.write_status_file(self.root, f, {"latest": {"version": "1.0.0"}, "incident": None})
            WORLD.status[gid] = {"latest": {"version": "1.0.0"}, "incident": None}
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start(); self.addCleanup(env.stop)
        for v in build.ENV_OVERRIDES:
            os.environ.pop(v, None)
        self.addCleanup(self.assert_nothing_real)

    def assert_nothing_real(self):
        bad = [c for c in WORLD.calls if c[:3] == ["gh", "gist", "edit"]]
        self.assertEqual(bad, [])

    def local(self, name):
        return json.loads((self.root / name).read_text())


class ReleaseGate(Base):
    def setUp(self):
        super().setUp()
        self.built, self.released = [], []
        dist = self.root / "dist"; dist.mkdir()
        self.dist = dist
        for n in (build.FILENAME, build.META_FILENAME, build.READABLE_FILENAME):
            (dist / n).write_text("// clean public bundle\n")
        patches = [
            mock.patch.object(build, "check_releasable", lambda: "2.0.0"),
            mock.patch.object(build, "pull_reports", lambda *a: None),
            mock.patch.object(build, "stamp_release_date", lambda *a: None),
            mock.patch.object(build, "build", lambda root: (self.built.append(1), dist / build.FILENAME)[1]),
            mock.patch.object(build, "release", lambda *a: self.released.append(1)),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def refuses(self, needle):
        res, out = quiet(build.do_release, self.root)
        self.assertIsInstance(res, SystemExit, out)
        self.assertIn(needle, str(res.code))
        self.assertEqual(self.built, [], "built before refusing")
        self.assertEqual(self.released, [])
        self.assertEqual(WORLD.gist_puts, [])
        return str(res.code)

    def test_wrong_branch(self):
        for b in ("dev", "demo", "feature/x", "mainline", "release"):
            WORLD.branch = b
            self.refuses("public releases are only cut from")

    def test_dirty_tree(self):
        WORLD.dirty = " M src/00-core.js\n?? new.txt\n"
        msg = self.refuses("working tree isn't clean")
        self.assertIn("src/00-core.js", msg)

    def test_failing_tests(self):
        WORLD.test_rc, WORLD.test_last = 1, "FAIL 3 of 120"
        msg = self.refuses("exited 1")
        self.assertIn("FAIL 3 of 120", msg)

    def test_env_override(self):
        for v in build.ENV_OVERRIDES:
            with mock.patch.dict(os.environ, {v: "http://localhost:8787"}):
                self.refuses(v)

    def test_dev_marker_in_bundle(self):
        for payload in ('x;AE.shard({id:"spread",name:"Spread"})', "// ===== 59-spread.js =====", "AE.spread=(()=>1)()"):
            (self.dist / build.FILENAME).write_text(payload)
            res, out = quiet(build.do_release, self.root)
            self.assertIsInstance(res, SystemExit)
            self.assertIn("dev-channel code", str(res.code))
            self.assertEqual(self.released, [])
            self.assertEqual(WORLD.gist_puts, [])
        self.assertEqual(len(self.built), 3)  # it did build, then refused before publishing

    def test_marker_in_readable_only(self):
        (self.dist / build.READABLE_FILENAME).write_text("\n// ===== 59-spread.js =====\n")
        res, _ = quiet(build.do_release, self.root)
        self.assertIsInstance(res, SystemExit)
        self.assertIn(build.READABLE_FILENAME, str(res.code))

    def test_main_clean_passing_proceeds_to_fake_publish(self):
        for b in ("main", "release-2.24.0"):
            WORLD.branch = b
            self.released.clear()
            res, out = quiet(build.do_release, self.root)
            self.assertNotIsInstance(res, SystemExit, out)
            self.assertEqual(self.released, [1])
            self.assertIn("ALL PASS 123 checks", out)
        self.assertEqual(WORLD.gist_puts, [])

    def test_status_mismatch_stops_release_before_build(self):
        WORLD.status[PUB] = {"latest": None, "incident": INC}
        res, _ = quiet(build.do_release, self.root)
        self.assertIsInstance(res, SystemExit)
        self.assertIn("status base check failed", str(res.code))
        self.assertEqual(self.built, [])

    def test_demo_gate(self):
        WORLD.branch = "main"
        res, _ = quiet(build.release_gate, self.root, "demo")
        self.assertIn("only published from the `demo` branch", str(res.code))
        WORLD.branch = "demo"
        res, out = quiet(build.release_gate, self.root, "demo")
        self.assertNotIsInstance(res, SystemExit)
        WORLD.dirty = "?? x"
        res, _ = quiet(build.release_gate, self.root, "demo")
        self.assertIn("isn't clean", str(res.code))

    def test_markers_derived_from_files(self):
        m = build.dev_only_markers(self.root)
        self.assertEqual(sorted(m), ["59-spread.js AE.spread", "59-spread.js banner", "59-spread.js shard id 'spread'"])


class StatusBase(Base):
    def test_match_proceeds_and_takes_live_latest(self):
        WORLD.status[PUB] = {"latest": {"version": "9.9.9"}, "incident": None}
        res, out = quiet(build.preflight_status, self.root, ("public", "dev", "demo"), None)
        self.assertNotIsInstance(res, SystemExit, out)
        self.assertEqual(self.local("status.json")["latest"], {"version": "9.9.9"})

    def test_differ_stops_with_diff_and_changes_nothing(self):
        WORLD.status[PUB] = {"latest": None, "incident": INC}
        before = self.local("status.json")
        res, _ = quiet(build.preflight_status, self.root, ("public",), None)
        msg = str(res.code)
        self.assertIsInstance(res, SystemExit)
        self.assertIn("Waymark slow", msg)
        self.assertIn("pauses: waymark", msg)
        self.assertIn("--status-base live", msg)
        self.assertIn("--status-base local", msg)
        self.assertEqual(self.local("status.json"), before)

    def test_base_live_adopts_live(self):
        live = {"latest": {"version": "2.0.0"}, "incident": INC}
        WORLD.status[PUB] = live
        res, out = quiet(build.preflight_status, self.root, ("public",), "live")
        self.assertNotIsInstance(res, SystemExit, out)
        self.assertEqual(self.local("status.json"), live)

    def test_base_local_keeps_local_but_live_latest(self):
        WORLD.status[PUB] = {"latest": {"version": "2.0.0"}, "incident": INC}
        res, out = quiet(build.preflight_status, self.root, ("public",), "local")
        self.assertNotIsInstance(res, SystemExit, out)
        got = self.local("status.json")
        self.assertIsNone(got["incident"])
        self.assertEqual(got["latest"], {"version": "2.0.0"})
        self.assertIn("will overwrite the live status", out)

    def test_fetch_failure_stops_unless_local(self):
        for bad in (Exception("HTTP 502"), "not json{"):
            WORLD.status[PUB] = bad
            res, _ = quiet(build.preflight_status, self.root, ("public",), None)
            self.assertIsInstance(res, SystemExit)
            self.assertIn("can't read the live", str(res.code))
            res, _ = quiet(build.preflight_status, self.root, ("public",), "live")
            self.assertIsInstance(res, SystemExit)
            res, out = quiet(build.preflight_status, self.root, ("public",), "local")
            self.assertNotIsInstance(res, SystemExit, out)

    def test_all_checked_before_any_write(self):
        WORLD.status[PUB] = {"latest": None, "incident": INC}
        WORLD.status[DEVG] = Exception("boom")
        before = self.local("status.json")
        res, _ = quiet(build.preflight_status, self.root, ("public", "dev"), "live")
        self.assertIsInstance(res, SystemExit)
        self.assertEqual(self.local("status.json"), before)

    def test_status_command_stops_on_differ_and_publishes_nothing(self):
        WORLD.status[PUB] = {"latest": None, "incident": INC}
        args = mock.Mock(status=None, status_update=None, status_fixed=None, status_clear=True, status_show=False,
                         shard=None, pause=None, mention=None, chip=None, chip_below=None, tag=None, status_base=None)
        res, _ = quiet(build.status_command, self.root, args)
        self.assertIsInstance(res, SystemExit)
        self.assertEqual(WORLD.gist_puts, [])
        args.status_base = "live"
        res, _ = quiet(build.status_command, self.root, args)  # adopts live, clears, publishes via the fake
        self.assertNotIsInstance(res, SystemExit)
        self.assertIsNone(self.local("status.json")["incident"])
        self.assertTrue(WORLD.gist_puts)

    def test_status_show_is_read_only(self):
        WORLD.status[PUB] = {"latest": None, "incident": INC}
        WORLD.status[DEMOG] = Exception("down")
        _, out = quiet(build.status_show, self.root)
        self.assertIn("MATCH (ignoring latest): NO", out)
        self.assertIn("MATCH (ignoring latest): yes", out)
        self.assertIn("MATCH: unknown", out)
        self.assertEqual(WORLD.gist_puts, [])

    def test_dev_publish_matching_works_and_mismatch_stops(self):
        WORLD.versions[DEVG] = "2.24.0.150"
        (self.root / "dev-build.txt").write_text("144\n")
        outdir = self.root / "dist-dev"; outdir.mkdir()
        (outdir / build.FILENAME).write_text("x")
        with mock.patch.object(build, "build", lambda root, v: outdir / build.FILENAME), mock.patch.object(build, "pull_reports", lambda *a: None):
            WORLD.status[PUB] = {"latest": None, "incident": INC}
            res, _ = quiet(build.dev_release, self.root)
            self.assertIsInstance(res, SystemExit)
            self.assertEqual((self.root / "dev-build.txt").read_text(), "144\n")  # nothing bumped
            self.assertEqual(WORLD.gist_puts, [])
            WORLD.status[PUB] = {"latest": None, "incident": None}
            res, out = quiet(build.dev_release, self.root)
            self.assertNotIsInstance(res, SystemExit, out)
            self.assertEqual((self.root / "dev-build.txt").read_text(), "151\n")
            self.assertIn("Published dev v2.24.0.151", out)
            self.assertIn(("status.json", DEVG), WORLD.gist_puts)


class DevVersion(Base):
    def counter(self, n):
        (self.root / "dev-build.txt").write_text(f"{n}\n")

    def test_max_of_local_and_live(self):
        self.counter(144)
        v, _ = quiet(build.dev_version, self.root, True, f"{build.DEV_BASE}.150")
        self.assertEqual(v, f"{build.DEV_BASE}.151")
        self.assertEqual((self.root / "dev-build.txt").read_text(), "151\n")
        self.counter(160)
        v, _ = quiet(build.dev_version, self.root, True, f"{build.DEV_BASE}.150")
        self.assertEqual(v, f"{build.DEV_BASE}.161")

    def test_different_base_keeps_local_with_note(self):
        self.counter(144)
        v, out = quiet(build.dev_version, self.root, True, "2.23.0.999")
        self.assertEqual(v, f"{build.DEV_BASE}.145")
        self.assertIn("different base", out)

    def test_no_bump_is_local_only(self):
        self.counter(144)
        v, _ = quiet(build.dev_version, self.root, False)
        self.assertEqual(v, f"{build.DEV_BASE}.144")
        self.assertEqual((self.root / "dev-build.txt").read_text(), "144\n")


class NoRealCalls(unittest.TestCase):
    def test_guards_installed(self):
        self.assertIs(build.subprocess.run, fake_run)
        with self.assertRaises(RealCallAttempted):
            build.subprocess.run(["gh", "gist", "edit", "x"])
        with self.assertRaises(RealCallAttempted):
            build.urllib.request.urlopen("https://example.com")


if __name__ == "__main__":
    unittest.main()
