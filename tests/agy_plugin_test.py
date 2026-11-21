import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "plugins" / "herdr-agy-titles" / "herdr-agy-title.py"


def load_plugin_module():
    spec = importlib.util.spec_from_file_location("herdr_agy_title", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MOD = load_plugin_module()


def write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def make_fake_hc(bin_dir: Path, log_file: Path, get_payload: dict) -> None:
    script = f"""#!{sys.executable}
import json, sys
log_path = {str(log_file)!r}
with open(log_path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({{"bin": "hc", "argv": sys.argv[1:]}}) + "\\n")
if len(sys.argv) >= 2 and sys.argv[1] == "get":
    print(json.dumps({json.dumps(get_payload)}))
sys.exit(0)
"""
    write_executable(bin_dir / "hc", script)


def make_fake_herdr(bin_dir: Path, log_file: Path, pane_payload: dict) -> None:
    script = f"""#!{sys.executable}
import json, sys
log_path = {str(log_file)!r}
with open(log_path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({{"bin": "herdr", "argv": sys.argv[1:]}}) + "\\n")
if len(sys.argv) >= 3 and sys.argv[1] == "pane" and sys.argv[2] == "get":
    print(json.dumps({json.dumps(pane_payload)}))
sys.exit(0)
"""
    write_executable(bin_dir / "herdr", script)


def read_log(log_file: Path) -> list[dict]:
    if not log_file.exists():
        return []
    lines = [ln for ln in log_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
    return [json.loads(ln) for ln in lines]


class PureHelpersTest(unittest.TestCase):
    def test_parse_pbtxt_title_variants(self):
        self.assertEqual(
            MOD.parse_pbtxt_title('title:"Herdr Autotitles Mac Linux SSH"\n'),
            "Herdr Autotitles Mac Linux SSH",
        )
        self.assertEqual(
            MOD.parse_pbtxt_title('title: "Especificación Técnica Dashboard"'),
            "Especificación Técnica Dashboard",
        )
        # Protobuf octal UTF-8 byte escapes: \303\263 = ó, \303\255 = í
        self.assertEqual(
            MOD.parse_pbtxt_title(r'title:"Especificaci\303\263n T\303\251cnica \303\255ndice"'),
            "Especificación Técnica índice",
        )
        # Hex and Unicode escapes
        self.assertEqual(
            MOD.parse_pbtxt_title(r'title:"Caf\xc3\xa9 \u00e9tude"'),
            "Café étude",
        )
        # Escaped quotes, backslashes, and whitespace/control normalization
        self.assertEqual(
            MOD.parse_pbtxt_title(r'title:"Fix \"quoted\" \\path\twith\nnewline"'),
            'Fix "quoted" \\path with newline',
        )
        # Multiline pbtxt with surrounding fields and adjacent concatenated literals
        multiline = (
            'created_at: 1700000000\n'
            'title: "Part one "\n'
            '       "part two"\n'
            'archived: false\n'
        )
        self.assertEqual(MOD.parse_pbtxt_title(multiline), "Part one part two")

        # Cap at 120 chars
        long_title = "a" * 150
        parsed_long = MOD.parse_pbtxt_title(f'title:"{long_title}"')
        self.assertIsNotNone(parsed_long)
        self.assertEqual(len(parsed_long), 120)

        # Empty / missing / invalid
        self.assertIsNone(MOD.parse_pbtxt_title(""))
        self.assertIsNone(MOD.parse_pbtxt_title('title:""'))
        self.assertIsNone(MOD.parse_pbtxt_title('title:"   \\t\\n  "'))
        self.assertIsNone(MOD.parse_pbtxt_title('other_field:"hello"'))
        self.assertIsNone(MOD.parse_pbtxt_title('title:"unterminated'))

    def test_resolve_app_data_dir(self):
        self.assertEqual(
            MOD.resolve_app_data_dir({}, env={"ANTIGRAVITY_APP_DATA_DIR": "/custom/agy"}),
            Path("/custom/agy"),
        )
        self.assertEqual(
            MOD.resolve_app_data_dir(
                {"artifactDirectoryPath": "/home/u/.gemini/antigravity-cli/brain/conv-1"},
                env={},
            ),
            Path("/home/u/.gemini/antigravity-cli"),
        )
        self.assertEqual(
            MOD.resolve_app_data_dir(
                {"transcriptPath": "/srv/data/antigravity-cli/brain/conv-2/transcript.jsonl"},
                env={},
            ),
            Path("/srv/data/antigravity-cli"),
        )
        self.assertEqual(
            MOD.resolve_app_data_dir({}, env={}),
            Path.home() / ".gemini" / "antigravity-cli",
        )

    def test_is_headless_agy_argv(self):
        self.assertTrue(MOD.is_headless_agy_argv(["agy", "-p", "summarize"]))
        self.assertTrue(MOD.is_headless_agy_argv(["/usr/local/bin/agy", "--print", "hi"]))
        self.assertTrue(MOD.is_headless_agy_argv(["antigravity", "--agent", "tab-namer"]))
        self.assertTrue(MOD.is_headless_agy_argv(["agy", "--agent=tab-namer", "--model", "flash"]))

        self.assertFalse(MOD.is_headless_agy_argv(["agy", "--dangerously-skip-permissions"]))
        self.assertFalse(MOD.is_headless_agy_argv(["agy"]))
        self.assertFalse(MOD.is_headless_agy_argv(["claude", "-p", "hello"]))
        self.assertFalse(MOD.is_headless_agy_argv([]))

    def test_is_antigravity_terminal(self):
        self.assertTrue(MOD.is_antigravity_terminal({"status": {"app": "antigravity"}}))
        self.assertTrue(MOD.is_antigravity_terminal({"foreground": {"name": "agy"}}))
        self.assertTrue(MOD.is_antigravity_terminal({"foreground": {"name": "antigravity"}}))
        self.assertTrue(
            MOD.is_antigravity_terminal({"foreground": {"argv": ["/usr/bin/agy", "--resume"]}})
        )

        self.assertFalse(
            MOD.is_antigravity_terminal({"status": {"app": "opencode"}, "foreground": {"name": "opencode"}})
        )
        self.assertFalse(
            MOD.is_antigravity_terminal({"status": {"app": "claude"}, "foreground": {"name": "claude"}})
        )
        self.assertFalse(MOD.is_antigravity_terminal({"foreground": {"name": "zsh"}}))
        self.assertFalse(MOD.is_antigravity_terminal({}))
        self.assertFalse(MOD.is_antigravity_terminal(None))


class HookSubprocessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.app_dir = self.root / "antigravity-cli"
        (self.app_dir / "annotations").mkdir(parents=True)
        self.runtime_dir = self.root / "runtime"
        self.runtime_dir.mkdir()
        self.state_home = self.root / "state"
        self.state_home.mkdir()
        self.log_file = self.root / "calls.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def base_env(self, **extra: str) -> dict[str, str]:
        env = {
            "PATH": f"{self.bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(self.root),
            "XDG_RUNTIME_DIR": str(self.runtime_dir),
            "XDG_STATE_HOME": str(self.state_home),
            "ANTIGRAVITY_APP_DATA_DIR": str(self.app_dir),
        }
        env.update(extra)
        return env

    def run_hook(self, payload: dict | str, env: dict[str, str]) -> subprocess.CompletedProcess:
        stdin_text = payload if isinstance(payload, str) else json.dumps(payload)
        return subprocess.run(
            [sys.executable, str(SCRIPT_PATH)],
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=5,
            env=env,
        )

    def test_pre_invocation_labels_herdr_app_and_caches(self):
        make_fake_hc(
            self.bin_dir,
            self.log_file,
            {"status": {"app": "antigravity"}, "foreground": {"name": "agy"}},
        )
        cid = "11111111-2222-3333-4444-555555555555"
        (self.app_dir / "annotations" / f"{cid}.pbtxt").write_text(
            'title:"Herdr AGY Session Titles"\n', encoding="utf-8"
        )
        payload = {
            "hookEventName": "PreInvocation",
            "conversationId": cid,
            "cwd": "/work/repo/sub",
            "workspacePaths": ["/work/repo"],
        }
        env = self.base_env(HC_TERMINAL_ID="t42")

        res1 = self.run_hook(payload, env)
        self.assertEqual(res1.returncode, 0)
        self.assertEqual(json.loads(res1.stdout), {})

        calls1 = read_log(self.log_file)
        self.assertEqual(len(calls1), 2)
        self.assertEqual(calls1[0]["argv"], ["get", "t42", "--json"])
        self.assertEqual(
            calls1[1]["argv"],
            [
                "label",
                "t42",
                "agy.title=Herdr AGY Session Titles",
                f"agy.session={cid}",
                "agy.dir=/work/repo",
                "agy.cwd=/work/repo/sub",
            ],
        )

        # Second identical call hits cache and does not invoke hc at all
        res2 = self.run_hook(payload, env)
        self.assertEqual(res2.returncode, 0)
        self.assertEqual(json.loads(res2.stdout), {})
        self.assertEqual(len(read_log(self.log_file)), 2)

    def test_stop_emits_allow_decision(self):
        make_fake_hc(self.bin_dir, self.log_file, {"status": {"app": "antigravity"}})
        cid = "stop-conv-1"
        (self.app_dir / "annotations" / f"{cid}.pbtxt").write_text(
            'title:"Finish Stop Test"\n', encoding="utf-8"
        )
        res = self.run_hook(
            {"hookEventName": "Stop", "conversationId": cid, "cwd": "/work"},
            self.base_env(HC_TERMINAL_ID="t7"),
        )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(json.loads(res.stdout), {"decision": "allow"})

    def test_disable_env_skips_publishing(self):
        make_fake_hc(self.bin_dir, self.log_file, {"status": {"app": "antigravity"}})
        make_fake_herdr(self.bin_dir, self.log_file, {"result": {"pane": {}}})
        cid = "disabled-conv"
        (self.app_dir / "annotations" / f"{cid}.pbtxt").write_text(
            'title:"Should Not Publish"\n', encoding="utf-8"
        )
        res = self.run_hook(
            {"hookEventName": "PreInvocation", "conversationId": cid, "cwd": "/work"},
            self.base_env(
                HERDR_AGY_TITLE_DISABLE="1",
                HC_TERMINAL_ID="t1",
                HERDR_ENV="1",
                HERDR_PANE_ID="w1:p1",
            ),
        )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(json.loads(res.stdout), {})
        self.assertEqual(read_log(self.log_file), [])

    def test_non_antigravity_terminal_skips_hc_label(self):
        make_fake_hc(
            self.bin_dir,
            self.log_file,
            {"status": {"app": "opencode"}, "foreground": {"name": "opencode"}},
        )
        cid = "wrong-app-conv"
        (self.app_dir / "annotations" / f"{cid}.pbtxt").write_text(
            'title:"Should Not Clobber Opencode"\n', encoding="utf-8"
        )
        res = self.run_hook(
            {"hookEventName": "PreInvocation", "conversationId": cid, "cwd": "/work"},
            self.base_env(HC_TERMINAL_ID="t9"),
        )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(json.loads(res.stdout), {})
        calls = read_log(self.log_file)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["argv"], ["get", "t9", "--json"])

    def test_herdr_tui_reports_metadata_tracks_was_and_respects_session_guard(self):
        cid = "tui-conv-1"
        make_fake_herdr(
            self.bin_dir,
            self.log_file,
            {"result": {"pane": {"agent_session": {"value": cid}}}},
        )
        pbtxt = self.app_dir / "annotations" / f"{cid}.pbtxt"
        pbtxt.write_text('title:"First AGY Task"\n', encoding="utf-8")
        env = self.base_env(
            HERDR_ENV="1",
            HERDR_PANE_ID="w1:p2",
            HERDR_SOCKET_PATH="/tmp/herdr-test.sock",
        )

        # First title: clears `was`
        res1 = self.run_hook(
            {"hookEventName": "PreInvocation", "conversationId": cid, "cwd": "/work"},
            env,
        )
        self.assertEqual(res1.returncode, 0)
        self.assertEqual(json.loads(res1.stdout), {})
        calls1 = [c for c in read_log(self.log_file) if c["argv"][:2] == ["pane", "report-metadata"]]
        self.assertEqual(len(calls1), 1)
        argv1 = calls1[0]["argv"]
        self.assertIn("--title", argv1)
        self.assertEqual(argv1[argv1.index("--title") + 1], "agy · First AGY Task")
        self.assertIn("task=First AGY Task", argv1)
        self.assertIn("--clear-token", argv1)
        self.assertEqual(argv1[argv1.index("--clear-token") + 1], "was")

        # Same title again: skipped
        self.run_hook(
            {"hookEventName": "PostInvocation", "conversationId": cid, "cwd": "/work"},
            env,
        )
        calls_after_dup = [c for c in read_log(self.log_file) if c["argv"][:2] == ["pane", "report-metadata"]]
        self.assertEqual(len(calls_after_dup), 1)

        # New title: sets `was=was: First AGY Task`
        pbtxt.write_text('title:"Second AGY Task"\n', encoding="utf-8")
        self.run_hook(
            {"hookEventName": "PostInvocation", "conversationId": cid, "cwd": "/work"},
            env,
        )
        calls2 = [c for c in read_log(self.log_file) if c["argv"][:2] == ["pane", "report-metadata"]]
        self.assertEqual(len(calls2), 2)
        argv2 = calls2[1]["argv"]
        self.assertEqual(argv2[argv2.index("--title") + 1], "agy · Second AGY Task")
        self.assertIn("task=Second AGY Task", argv2)
        self.assertIn("was=was: First AGY Task", argv2)

        # Mismatched agent_session on pane: skipped
        other_cid = "different-session-999"
        (self.app_dir / "annotations" / f"{other_cid}.pbtxt").write_text(
            'title:"Nested Session Title"\n', encoding="utf-8"
        )
        self.run_hook(
            {"hookEventName": "PreInvocation", "conversationId": other_cid, "cwd": "/work"},
            env,
        )
        calls3 = [c for c in read_log(self.log_file) if c["argv"][:2] == ["pane", "report-metadata"]]
        self.assertEqual(len(calls3), 2)

    def test_turn1_async_polling_publishes_after_pbtxt_appears(self):
        make_fake_hc(
            self.bin_dir,
            self.log_file,
            {"status": {"app": "antigravity"}, "foreground": {"name": "agy"}},
        )
        cid = "async-turn1-conv"
        pbtxt = self.app_dir / "annotations" / f"{cid}.pbtxt"
        env = self.base_env(
            HC_TERMINAL_ID="t55",
            HERDR_AGY_TITLE_POLL_DELAYS="0.05,0.05,0.1,0.1,0.2",
        )

        start = time.monotonic()
        res = self.run_hook(
            {
                "hookEventName": "PreInvocation",
                "conversationId": cid,
                "cwd": "/work/async",
                "workspacePaths": ["/work/async"],
            },
            env,
        )
        elapsed = time.monotonic() - start
        self.assertEqual(res.returncode, 0)
        self.assertEqual(json.loads(res.stdout), {})
        # Parent must exit promptly without waiting for the poller delays
        self.assertLess(elapsed, 0.5)

        time.sleep(0.08)
        pbtxt.write_text('title:"Async Turn One Title"\n', encoding="utf-8")

        deadline = time.monotonic() + 2.0
        label_calls = []
        while time.monotonic() < deadline:
            label_calls = [c for c in read_log(self.log_file) if c["argv"][:1] == ["label"]]
            if label_calls:
                break
            time.sleep(0.03)

        self.assertEqual(len(label_calls), 1)
        self.assertEqual(
            label_calls[0]["argv"],
            [
                "label",
                "t55",
                "agy.title=Async Turn One Title",
                f"agy.session={cid}",
                "agy.dir=/work/async",
                "agy.cwd=/work/async",
            ],
        )

    def test_malformed_stdin_and_invalid_conversation_id_are_safe(self):
        make_fake_hc(self.bin_dir, self.log_file, {"status": {"app": "antigravity"}})
        env = self.base_env(HC_TERMINAL_ID="t1")

        res_bad_json = self.run_hook("{not valid json", env)
        self.assertEqual(res_bad_json.returncode, 0)
        self.assertEqual(json.loads(res_bad_json.stdout), {})

        res_traversal = self.run_hook(
            {"hookEventName": "PreInvocation", "conversationId": "../escape"},
            env,
        )
        self.assertEqual(res_traversal.returncode, 0)
        self.assertEqual(json.loads(res_traversal.stdout), {})
        self.assertEqual(read_log(self.log_file), [])


if __name__ == "__main__":
    unittest.main()
