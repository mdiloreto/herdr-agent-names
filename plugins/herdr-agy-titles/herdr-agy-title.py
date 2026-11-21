#!/usr/bin/env python3
"""Publish Antigravity CLI (agy) session titles to Herdr App and Herdr TUI.

Reads AGY's native conversation annotation (`annotations/<conversationId>.pbtxt`)
on lifecycle hooks (SessionStart, PreInvocation, PostInvocation, Stop) and
publishes the session title to:
  - Herdr App (`herdr-core` terminal labels via `hc label`)
  - Herdr TUI (`herdr pane report-metadata`, matching `user:pane-title`)

Strict AGY hook contract:
  - Always writes valid JSON to stdout (`{"decision": "allow"}` on Stop, `{}`
    otherwise) and exits 0.
  - Never prints diagnostics to stdout or lets subprocesses write to stdout.
  - On Turn 1 when `.pbtxt` has not been written yet, flushes stdout first and
    detaches a double-forked background poller that publishes once `.pbtxt`
    appears.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping, Sequence

MAX_TITLE_CHARS = 120
MAX_TUI_TITLE_CHARS = 60
TUI_SOURCE = "user:pane-title"
DEFAULT_POLL_DELAYS = (0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0)
ANTIGRAVITY_NAMES = ("agy", "antigravity")

_TITLE_PREFIX_RE = re.compile(r"(?m)^\s*title\s*:\s*")
_WHITESPACE_CTRL_RE = re.compile(r"[\r\n\t\v\f]+")
_CTRL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]+")
_MULTI_SPACE_RE = re.compile(r"\s+")
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9._-]")

_SIMPLE_ESCAPES = {
    "a": b"\a",
    "b": b"\b",
    "f": b"\f",
    "n": b"\n",
    "r": b"\r",
    "t": b"\t",
    "v": b"\v",
    "\\": b"\\",
    "'": b"'",
    '"': b'"',
    "?": b"?",
}


def hook_response(event_name: str) -> str:
    """Return the required JSON stdout payload for an AGY hook event."""
    if event_name == "Stop":
        return '{"decision": "allow"}'
    return "{}"


def is_valid_conversation_id(conversation_id: Any) -> bool:
    """Reject missing, empty, or path-traversal conversation IDs."""
    if not isinstance(conversation_id, str):
        return False
    cid = conversation_id.strip()
    if not cid or cid != conversation_id:
        return False
    if "/" in cid or "\\" in cid or ".." in cid or "\x00" in cid:
        return False
    return True


def is_headless_agy_argv(argv: Sequence[str]) -> bool:
    """Return True if argv represents a headless/nested `agy` invocation."""
    if not argv:
        return False
    exe = os.path.basename(str(argv[0])).lower()
    if exe not in ANTIGRAVITY_NAMES:
        return False
    rest = list(argv[1:])
    for i, arg in enumerate(rest):
        if arg in ("-p", "--print", "--agent=tab-namer"):
            return True
        if arg == "--agent" and i + 1 < len(rest) and rest[i + 1] == "tab-namer":
            return True
    return False


def _proc_parent_and_argv(pid: int) -> tuple[int | None, list[str]]:
    """Read (ppid, argv) for a PID via Linux /proc or POSIX ps fallback."""
    stat_path = Path(f"/proc/{pid}/stat")
    cmdline_path = Path(f"/proc/{pid}/cmdline")
    if stat_path.exists():
        try:
            stat_text = stat_path.read_text(encoding="utf-8", errors="replace")
            rparen = stat_text.rfind(")")
            ppid: int | None = None
            if rparen != -1:
                fields = stat_text[rparen + 2 :].split()
                if len(fields) >= 2:
                    ppid = int(fields[1])
            argv: list[str] = []
            try:
                raw = cmdline_path.read_bytes()
                if raw:
                    parts = [p.decode("utf-8", errors="replace") for p in raw.split(b"\x00")]
                    while parts and parts[-1] == "":
                        parts.pop()
                    argv = parts
            except OSError:
                argv = []
            return ppid, argv
        except (OSError, ValueError):
            pass

    try:
        res = subprocess.run(
            ["ps", "-o", "ppid=,args=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if res.returncode != 0:
            return None, []
        for line in res.stdout.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            parts = stripped.split(None, 1)
            ppid = int(parts[0])
            cmd = parts[1] if len(parts) > 1 else ""
            try:
                argv = shlex.split(cmd)
            except ValueError:
                argv = cmd.split()
            return ppid, argv
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None, []


def has_headless_agy_ancestor(start_pid: int | None = None, max_depth: int = 64) -> bool:
    """Walk ancestor processes and return True if any is a headless `agy` run."""
    pid: int | None = os.getppid() if start_pid is None else start_pid
    seen: set[int] = set()
    for _ in range(max_depth):
        if pid is None or pid <= 1 or pid in seen:
            break
        seen.add(pid)
        ppid, argv = _proc_parent_and_argv(pid)
        if is_headless_agy_argv(argv):
            return True
        if ppid is None or ppid == pid:
            break
        pid = ppid
    return False


def resolve_app_data_dir(
    payload: Mapping[str, Any],
    env: Mapping[str, str] | None = None,
) -> Path:
    """Resolve AGY's app data directory (parent of `annotations/` and `brain/`)."""
    env_map = os.environ if env is None else env
    override = (env_map.get("ANTIGRAVITY_APP_DATA_DIR") or "").strip()
    if override:
        return Path(override)

    for key in ("artifactDirectoryPath", "transcriptPath"):
        raw = payload.get(key)
        if isinstance(raw, str) and raw.strip():
            path = Path(raw.strip())
            for candidate in (path, *path.parents):
                if candidate.name == "brain" and candidate.parent != candidate:
                    return candidate.parent

    return Path.home() / ".gemini" / "antigravity-cli"


def _unescape_pbtxt_string(raw: str) -> str:
    """Decode protobuf text-format string escapes (octal, hex, unicode, C) to UTF-8."""
    buf = bytearray()
    i = 0
    n = len(raw)
    while i < n:
        ch = raw[i]
        if ch != "\\":
            buf.extend(ch.encode("utf-8"))
            i += 1
            continue
        i += 1
        if i >= n:
            break
        esc = raw[i]
        if esc in "01234567":
            j = i
            while j < n and j < i + 3 and raw[j] in "01234567":
                j += 1
            buf.append(int(raw[i:j], 8) & 0xFF)
            i = j
        elif esc in ("x", "X"):
            i += 1
            j = i
            while j < n and j < i + 2 and raw[j] in "0123456789abcdefABCDEF":
                j += 1
            if j > i:
                buf.append(int(raw[i:j], 16) & 0xFF)
                i = j
            else:
                buf.extend(esc.encode("utf-8"))
        elif esc == "u" and i + 5 <= n and all(c in "0123456789abcdefABCDEF" for c in raw[i + 1 : i + 5]):
            cp = int(raw[i + 1 : i + 5], 16)
            buf.extend(chr(cp).encode("utf-8", errors="replace"))
            i += 5
        elif esc == "U" and i + 9 <= n and all(c in "0123456789abcdefABCDEF" for c in raw[i + 1 : i + 9]):
            cp = int(raw[i + 1 : i + 9], 16)
            if 0 <= cp <= 0x10FFFF:
                buf.extend(chr(cp).encode("utf-8", errors="replace"))
            i += 9
        elif esc in _SIMPLE_ESCAPES:
            buf.extend(_SIMPLE_ESCAPES[esc])
            i += 1
        else:
            buf.extend(esc.encode("utf-8"))
            i += 1
    return buf.decode("utf-8", errors="replace")


def sanitize_title(title: str, max_chars: int = MAX_TITLE_CHARS) -> str | None:
    """Clean control chars, collapse whitespace, and cap title length."""
    if not isinstance(title, str):
        return None
    cleaned = _WHITESPACE_CTRL_RE.sub(" ", title)
    cleaned = _CTRL_CHARS_RE.sub("", cleaned)
    cleaned = _MULTI_SPACE_RE.sub(" ", cleaned).strip()
    if max_chars > 0 and len(cleaned) > max_chars:
        cleaned = cleaned[:max_chars].strip()
    return cleaned or None


def parse_pbtxt_title(text: str) -> str | None:
    """Extract and sanitize the `title` string field from a protobuf text file."""
    if not isinstance(text, str) or not text:
        return None
    match = _TITLE_PREFIX_RE.search(text)
    if not match:
        return None

    pos = match.end()
    n = len(text)
    pieces: list[str] = []

    while pos < n:
        while pos < n and text[pos] in " \t\r\n":
            pos += 1
        if pos < n and text[pos] == "#":
            while pos < n and text[pos] != "\n":
                pos += 1
            continue
        if pos >= n or text[pos] not in ('"', "'"):
            break
        quote = text[pos]
        pos += 1
        start = pos
        while pos < n:
            ch = text[pos]
            if ch == "\\":
                pos += 2
                continue
            if ch == quote:
                break
            pos += 1
        if pos >= n or text[pos] != quote:
            return None
        pieces.append(_unescape_pbtxt_string(text[start:pos]))
        pos += 1

    if not pieces:
        return None
    return sanitize_title("".join(pieces), MAX_TITLE_CHARS)


def read_pbtxt_title(app_data_dir: Path, conversation_id: str) -> str | None:
    """Read `<app_data_dir>/annotations/<conversation_id>.pbtxt` and parse its title."""
    pbtxt_path = app_data_dir / "annotations" / f"{conversation_id}.pbtxt"
    try:
        text = pbtxt_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return parse_pbtxt_title(text)


def is_antigravity_terminal(terminal_info: Any) -> bool:
    """Verify `hc get <id> --json` output belongs to an Antigravity process."""
    if not isinstance(terminal_info, dict):
        return False
    status = terminal_info.get("status")
    if isinstance(status, dict):
        if str(status.get("app") or "").strip().lower() == "antigravity":
            return True
    fg = terminal_info.get("foreground")
    if isinstance(fg, dict):
        if str(fg.get("name") or "").strip().lower() in ANTIGRAVITY_NAMES:
            return True
        argv = fg.get("argv")
        if isinstance(argv, list) and argv and isinstance(argv[0], str):
            if os.path.basename(argv[0]).lower() in ANTIGRAVITY_NAMES:
                return True
    return False


def extract_dirs(payload: Mapping[str, Any]) -> tuple[str, str]:
    """Extract (project_dir, cwd) from an AGY hook payload."""
    project_dir = ""
    ws = payload.get("workspacePaths")
    if isinstance(ws, list):
        for item in ws:
            if isinstance(item, str) and item.strip():
                project_dir = item.strip()
                break
    raw_cwd = payload.get("cwd")
    cwd_val = raw_cwd.strip() if isinstance(raw_cwd, str) and raw_cwd.strip() else ""
    if not project_dir:
        project_dir = cwd_val
    cwd = cwd_val or project_dir
    return project_dir, cwd


def _runtime_dir(env: Mapping[str, str] | None = None) -> Path:
    env_map = os.environ if env is None else env
    base = (env_map.get("XDG_RUNTIME_DIR") or env_map.get("TMPDIR") or "/tmp").strip()
    return Path(base or "/tmp")


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(path.parent),
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as tmp:
            tmp_path = tmp.name
            tmp.write(content)
            tmp.flush()
        os.replace(tmp_path, path)
        tmp_path = None
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def publish_herdr_app(
    terminal_id: str,
    conversation_id: str,
    title: str,
    project_dir: str,
    cwd: str,
    env: Mapping[str, str] | None = None,
) -> bool:
    """Publish `agy.*` labels to Herdr App (`herdr-core`) via `hc`."""
    env_map = os.environ if env is None else env
    hc_bin = shutil.which("hc", path=env_map.get("PATH"))
    if not hc_bin:
        return False

    safe_tid = _SAFE_ID_RE.sub("_", terminal_id)
    cache_path = _runtime_dir(env_map) / f"hc-agy-labels-{safe_tid}.state"
    cache_value = f"{conversation_id}|{title}|{project_dir}|{cwd}"
    try:
        if cache_path.read_text(encoding="utf-8") == cache_value:
            return False
    except OSError:
        pass

    sub_env = dict(env_map)
    try:
        check = subprocess.run(
            [hc_bin, "get", terminal_id, "--json"],
            capture_output=True,
            text=True,
            timeout=3,
            env=sub_env,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if check.returncode != 0:
        return False
    try:
        info = json.loads(check.stdout)
    except ValueError:
        return False
    if not is_antigravity_terminal(info):
        return False

    try:
        res = subprocess.run(
            [
                hc_bin,
                "label",
                terminal_id,
                f"agy.title={title}",
                f"agy.session={conversation_id}",
                f"agy.dir={project_dir}",
                f"agy.cwd={cwd}",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            env=sub_env,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if res.returncode != 0:
        return False

    try:
        _atomic_write_text(cache_path, cache_value)
    except OSError:
        pass
    return True


def publish_herdr_tui(
    pane_id: str,
    conversation_id: str,
    title: str,
    env: Mapping[str, str] | None = None,
) -> bool:
    """Publish pane title metadata to Herdr TUI via `herdr pane report-metadata`."""
    env_map = os.environ if env is None else env
    herdr_bin = shutil.which("herdr", path=env_map.get("PATH"))
    if not herdr_bin:
        return False

    tui_title = sanitize_title(title, MAX_TUI_TITLE_CHARS)
    if not tui_title:
        return False

    state_base = (env_map.get("XDG_STATE_HOME") or "").strip()
    state_dir = (Path(state_base) if state_base else (Path.home() / ".local" / "state")) / "herdr-pane-title"
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False

    socket_path = env_map.get("HERDR_SOCKET_PATH", "")
    key = hashlib.sha1(f"{socket_path}|{pane_id}".encode("utf-8")).hexdigest()[:16]
    state_file = state_dir / f"{key}.json"
    lock_file = state_file.with_suffix(".lock")
    sub_env = dict(env_map)

    try:
        with open(lock_file, "w", encoding="utf-8") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)

            try:
                get_res = subprocess.run(
                    [herdr_bin, "pane", "get", pane_id],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    env=sub_env,
                )
                if get_res.returncode == 0 and get_res.stdout:
                    pane_data = json.loads(get_res.stdout)
                    agent_session = (
                        ((pane_data.get("result") or {}).get("pane") or {}).get("agent_session")
                        or {}
                    )
                    active_session = agent_session.get("value")
                    if (
                        isinstance(active_session, str)
                        and active_session.strip()
                        and active_session.strip() != conversation_id
                    ):
                        return False
            except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
                pass

            try:
                state = json.loads(state_file.read_text(encoding="utf-8"))
                if not isinstance(state, dict):
                    state = {}
            except (OSError, ValueError):
                state = {}

            task = state.get("task")
            was = state.get("was")
            if task == tui_title:
                return False

            new_was = task if task and task != tui_title else was
            args = [
                herdr_bin,
                "pane",
                "report-metadata",
                pane_id,
                "--source",
                TUI_SOURCE,
                "--agent",
                "agy",
                "--seq",
                str(time.time_ns()),
                "--title",
                f"agy · {tui_title}",
                "--token",
                f"task={tui_title}",
            ]
            if new_was:
                args += ["--token", f"was=was: {new_was}"]
            else:
                args += ["--clear-token", "was"]

            rep_res = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=5,
                env=sub_env,
            )
            if rep_res.returncode != 0:
                return False

            try:
                _atomic_write_text(
                    state_file,
                    json.dumps({"task": tui_title, "was": new_was}),
                )
            except OSError:
                pass
            return True
    except (OSError, subprocess.SubprocessError):
        return False


def parse_poll_delays(env: Mapping[str, str] | None = None) -> tuple[float, ...]:
    """Parse poll delay schedule from `HERDR_AGY_TITLE_POLL_DELAYS` or use defaults."""
    env_map = os.environ if env is None else env
    raw = (env_map.get("HERDR_AGY_TITLE_POLL_DELAYS") or "").strip()
    if not raw:
        return DEFAULT_POLL_DELAYS
    delays: list[float] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            val = float(part)
        except ValueError:
            return DEFAULT_POLL_DELAYS
        if val < 0:
            return DEFAULT_POLL_DELAYS
        delays.append(val)
    return tuple(delays) if delays else DEFAULT_POLL_DELAYS


def _publish_targets(
    conversation_id: str,
    title: str,
    project_dir: str,
    cwd: str,
    env: Mapping[str, str],
) -> None:
    hc_tid = (env.get("HC_TERMINAL_ID") or "").strip()
    if hc_tid:
        publish_herdr_app(hc_tid, conversation_id, title, project_dir, cwd, env=env)

    herdr_pane = (env.get("HERDR_PANE_ID") or "").strip()
    if env.get("HERDR_ENV") == "1" and herdr_pane:
        publish_herdr_tui(herdr_pane, conversation_id, title, env=env)


def _spawn_background_poller(
    app_data_dir: Path,
    conversation_id: str,
    project_dir: str,
    cwd: str,
    env: Mapping[str, str],
) -> None:
    """Double-fork a detached child to poll for Turn-1 `.pbtxt` title creation."""
    try:
        pid = os.fork()
    except OSError:
        return
    if pid > 0:
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        return

    try:
        os.setsid()
    except OSError:
        pass

    try:
        devnull = os.open(os.devnull, os.O_RDWR)
        try:
            for fd in (0, 1, 2):
                os.dup2(devnull, fd)
        finally:
            if devnull > 2:
                os.close(devnull)
    except OSError:
        pass

    try:
        pid2 = os.fork()
    except OSError:
        os._exit(0)
    if pid2 > 0:
        os._exit(0)

    try:
        target_id = "|".join(
            [
                (env.get("HC_TERMINAL_ID") or "").strip(),
                (env.get("HERDR_SOCKET_PATH") or "").strip(),
                (env.get("HERDR_PANE_ID") or "").strip(),
            ]
        )
        lock_key = hashlib.sha1(f"{target_id}|{conversation_id}".encode("utf-8")).hexdigest()[:16]
        rdir = _runtime_dir(env)
        rdir.mkdir(parents=True, exist_ok=True)
        lock_path = rdir / f"hc-agy-poll-{lock_key}.lock"
        with open(lock_path, "w", encoding="utf-8") as lock_file:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os._exit(0)

            title = read_pbtxt_title(app_data_dir, conversation_id)
            if title:
                _publish_targets(conversation_id, title, project_dir, cwd, env)
                os._exit(0)

            for delay in parse_poll_delays(env):
                time.sleep(delay)
                title = read_pbtxt_title(app_data_dir, conversation_id)
                if title:
                    _publish_targets(conversation_id, title, project_dir, cwd, env)
                    break
    except Exception:
        pass
    finally:
        os._exit(0)


def _read_payload() -> dict[str, Any]:
    try:
        raw = sys.stdin.read()
        if not raw or not raw.strip():
            return {}
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def main() -> int:
    payload = _read_payload()
    event_name = str(payload.get("hookEventName") or "")
    response = hook_response(event_name)
    responded = False

    def emit_response() -> None:
        nonlocal responded
        if not responded:
            sys.stdout.write(response + "\n")
            sys.stdout.flush()
            responded = True

    try:
        env = dict(os.environ)
        if env.get("HERDR_AGY_TITLE_DISABLE") == "1":
            emit_response()
            return 0

        has_herdr_app = bool((env.get("HC_TERMINAL_ID") or "").strip())
        has_herdr_tui = env.get("HERDR_ENV") == "1" and bool((env.get("HERDR_PANE_ID") or "").strip())
        if not has_herdr_app and not has_herdr_tui:
            emit_response()
            return 0

        conversation_id = payload.get("conversationId")
        if not is_valid_conversation_id(conversation_id):
            emit_response()
            return 0

        if has_headless_agy_ancestor():
            emit_response()
            return 0

        app_data_dir = resolve_app_data_dir(payload, env=env)
        project_dir, cwd = extract_dirs(payload)
        title = read_pbtxt_title(app_data_dir, conversation_id)
        if title:
            _publish_targets(conversation_id, title, project_dir, cwd, env)
            emit_response()
            return 0

        emit_response()
        _spawn_background_poller(app_data_dir, conversation_id, project_dir, cwd, env)
        return 0
    except Exception:
        emit_response()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
