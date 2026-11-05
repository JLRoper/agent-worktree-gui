#!/usr/bin/env python3
"""
hermes_matrix_bridge.py — two-way Matrix <-> Hermes Agent bridge.

Incoming Matrix text  ->  local terminal  ->  Hermes (one-shot inference)  ->  Matrix reply

Runs against matrix-nio (E2EE via vodozemac, no libolm build needed).

Quick start (Windows, git-bash):
    cd /c/Users/roper/matrix-hermes-bridge
    ./.venv/Scripts/python.exe hermes_matrix_bridge.py --self-test
    ./.venv/Scripts/python.exe hermes_matrix_bridge.py

Modes:
    (default)      run the bridge
    --self-test    check config / deps / hermes binary, no network
    --rooms        log in and list joined + invited rooms (to find ROOM_ID)
    --once "text"  run one inference locally, no Matrix involved
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import json
import logging
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path


def load_env_file() -> None:
    """Tiny .env loader: KEY=VALUE lines, '#' comments, no shell expansion.

    Runs at import time so the constants below see bridge.env values.
    """
    env_path = Path(__file__).with_name("bridge.env")
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file()

# ─────────────────────────────────────────────────────────────────────────────
# 1. CONFIGURATION — edit these four lines, or set the env vars
#    (a bridge.env file next to this script is loaded automatically)
# ─────────────────────────────────────────────────────────────────────────────
HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "https://matrix.org")
USERNAME   = os.environ.get("MATRIX_USERNAME",   "@wag.bot:matrix.org")
PASSWORD   = os.environ.get("MATRIX_PASSWORD",   "CHANGE_ME")
ROOM_ID    = os.environ.get("MATRIX_ROOM_ID",    "!CHANGE_ME:matrix.org")

# Stable device identity: keep this constant so E2EE keys survive restarts.
DEVICE_ID  = os.environ.get("MATRIX_DEVICE_ID",  "HERMESBRIDGE")
STORE_DIR  = os.environ.get("MATRIX_STORE_DIR",  str(Path.home() / ".hermes-matrix-store"))

# Local Hermes CLI used as the inference backend.
HERMES_BIN      = os.environ.get("HERMES_BIN", "")          # auto-detected if empty
HERMES_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "")      # e.g. "web,terminal"; empty = default
HERMES_TIMEOUT  = float(os.environ.get("HERMES_TIMEOUT", "300"))
TYPING_REFRESH  = float(os.environ.get("TYPING_REFRESH", "20"))   # <30s Matrix expiry
TYPING_TIMEOUT  = int(TYPING_REFRESH * 1500)                      # ms = 1.5x the refresh gap

HISTORY_TURNS   = int(os.environ.get("BRIDGE_HISTORY_TURNS", "12"))
MAX_REPLY_CHARS = 30000          # Matrix event size guard
STARTUP_PING    = "Hermes is online and ready!"
OUTBOX_PATH     = Path(os.environ.get("BRIDGE_OUTBOX", "") or
                       (Path(__file__).resolve().parent / "outbox.txt"))
OUTBOX_DRAIN    = float(os.environ.get("OUTBOX_DRAIN", "5"))   # poll gap, seconds

# The panel that owns the policy and the reminder list. The panel hands this to the child it spawns, derived
# from the port it actually bound; the default is the panel's own default port, for a foreground run. The
# token is ONLY for a panel on another host — a loopback request is the panel's own exemption, so it stays
# empty on the normal install and is never echoed by --self-test.
PANEL_URL       = os.environ.get("WTGUI_PANEL_URL", "http://127.0.0.1:7331").rstrip("/")
PANEL_TOKEN     = os.environ.get("WTGUI_PANEL_TOKEN", "")
PANEL_TIMEOUT   = float(os.environ.get("WTGUI_PANEL_TIMEOUT", "5"))

# ─────────────────────────────────────────────────────────────────────────────

LOG = logging.getLogger("bridge")
SEEN: set[str] = set()
HISTORY: deque[tuple[str, str]] = deque(maxlen=HISTORY_TURNS * 2)
JOB_QUEUE: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
START_MS = int(time.time() * 1000)
READY = False
TARGET_ROOM = ""          # canonical room ID, filled in after join
LAST_DECRYPT_HINT = 0.0


def find_hermes() -> str | None:
    """Locate the Hermes CLI executable (not the .cmd shim)."""
    candidates = [HERMES_BIN] if HERMES_BIN else []
    candidates += [
        shutil.which("hermes.exe") or "",
        shutil.which("hermes") or "",
        str(Path(os.environ.get("LOCALAPPDATA", Path.home())) /
            "hermes" / "hermes-agent" / ".hermes" / "bin" / "hermes.exe"),
        str(Path.home() / ".local" / "bin" / "hermes"),
    ]
    for cand in candidates:
        if cand and Path(cand).exists():
            return cand
    return None


# ─────────────────────────────────────────────────────────────────────────────
# 2. THE PANEL'S POLICY AND REMINDERS — read on EVERY turn, never cached
# ─────────────────────────────────────────────────────────────────────────────
# The reader edits tone, quiet hours and routing in the panel's Bridge tab (POST /api/matrix/policy) and expects
# the next message to obey. So the policy is fetched ONCE PER TURN and appended to that turn's prompt, and no
# copy of it is kept here between turns: a module-level cache would obey words the reader had already changed.
#
# The reminder list (GET /api/matrix/reminders) is the bridge's OWN — not an assistant's watches, and not a task
# queue. It is read the same way, from the same panel, and carried in the same preamble the panel builds. The
# payload also carries the assistants' watches as a READ-ONLY projection; the bridge may mention one, and it has
# no code path that writes one, which is deliberate — a watch is a thread plus a state and wake, and none of
# that is the bridge's to do.
#
# A FAILED FETCH IS NOT SWALLOWED. `fetch_policy` returns `ok: False` with the reason instead of raising, the
# prompt says the policy is missing, and `reply_with_context` puts the failure at the TOP of the reply that goes
# to the phone. Answering on the last policy the process saw would look exactly like obeying the current one.
PANEL_POLICY_ROUTE = "/api/matrix/policy"
PANEL_REMINDERS_ROUTE = "/api/matrix/reminders"


def panel_reason(exc: Exception) -> str:
    """One line naming why a panel fetch failed — safe to put in a chat reply."""
    text = " ".join(f"{type(exc).__name__}: {exc}".split())
    return text[:240] or "no reason given"


def panel_get(route: str) -> dict:
    """One GET against the panel. Raises on any failure; each caller decides what its turn does about it."""
    if not PANEL_URL:
        raise RuntimeError("WTGUI_PANEL_URL is empty — there is no panel to read the policy from")
    url = f"{PANEL_URL}{route}"
    headers = {"Accept": "application/json"}
    if PANEL_TOKEN:
        headers["x-panel-token"] = PANEL_TOKEN
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=PANEL_TIMEOUT) as response:
        status = int(getattr(response, "status", 200) or 200)
        raw = response.read()
    if status != 200:
        raise RuntimeError(f"HTTP {status} from {url}")
    return json.loads(raw.decode("utf-8") or "{}")


def _stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def fetch_policy(opener=None) -> dict:
    """The panel's policy, fetched NOW. `text` is the preamble the panel built, verbatim."""
    get = opener or panel_get
    try:
        payload = get(PANEL_POLICY_ROUTE) or {}
        text = str(payload.get("preamble") or "")
        if not text:
            # An older panel (before `preamble` rode on the payload) still serves `text`. The heading here is
            # the panel's wording; the panel's own build is preferred whenever it is present.
            body = str(payload.get("text") or "").strip()
            if body:
                text = ("## How the reader wants the Matrix bridge to speak to them\n\n"
                        f"{body}\n")
        return {"ok": True, "text": text, "error": None, "source": payload.get("source"),
                "chars": len(text), "at": _stamp()}
    except Exception as exc:                                    # noqa: BLE001 — a turn runs without it
        return {"ok": False, "text": "", "error": panel_reason(exc), "source": None,
                "chars": 0, "at": _stamp()}


def fetch_reminders(opener=None) -> dict:
    """The bridge's own reminders plus the assistants' watches, as the panel projects them."""
    get = opener or panel_get
    try:
        payload = get(PANEL_REMINDERS_ROUTE) or {}
        return {"ok": True, "text": str(payload.get("preamble") or ""), "error": None,
                "reminders": len(payload.get("reminders") or []),
                "watches": len(payload.get("watches") or []),
                "watchesReadOnly": bool(payload.get("watchesReadOnly", True)),
                "at": _stamp()}
    except Exception as exc:                                    # noqa: BLE001 — a turn runs without it
        return {"ok": False, "text": "", "error": panel_reason(exc), "reminders": 0, "watches": 0,
                "watchesReadOnly": True, "at": _stamp()}


def turn_context(opener=None) -> dict:
    """Everything the next turn carries from the panel, read at the moment the turn starts.

    There is no memo and no module-level copy: two calls are two fetches. `opener` is injectable so a test can
    prove that with a counter, and so a caller can hand in its own transport without a second code path.
    """
    return {"policy": fetch_policy(opener), "reminders": fetch_reminders(opener), "at": _stamp()}


def reply_with_context(answer: str, context: dict | None) -> str:
    """The bridge's words around the model's — where a failed fetch becomes visible on the phone."""
    if not context:
        return answer
    policy = context.get("policy") or {}
    reminders = context.get("reminders") or {}
    notes = []
    if policy.get("ok") is False:
        notes.append(
            f"⚠ I could not read the panel policy this turn ({policy.get('error')}) — this answer runs WITHOUT "
            "your tone, quiet-hours and routing instructions. Check that the panel is running, then send again."
        )
    if reminders.get("ok") is False:
        notes.append(f"⚠ I could not read your reminders either ({reminders.get('error')}).")
    if not notes:
        return answer
    return "\n".join(notes) + "\n\n" + answer


# ─────────────────────────────────────────────────────────────────────────────
# 3. CORE INFERENCE — shell out to the local Hermes CLI
# ─────────────────────────────────────────────────────────────────────────────

_SESSION_LINE = re.compile(r"^\s*session_id:\s*\S+\s*$", re.MULTILINE)
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def build_prompt(text: str, history: list[tuple[str, str]], context: dict | None = None) -> str:
    """One-shot Hermes has no memory of prior turns, so replay recent context.

    `context` is THIS turn's panel read (`turn_context`): the policy preamble the reader saved, and the
    reminder/watches preamble the panel built. It is passed in rather than fetched here so the same object can
    be judged afterwards — a failed fetch has to reach the reply, and a function that swallowed its own failure
    could not tell the caller about it.
    """
    parts = [
        "You are Hermes, answering over a Matrix chat bridge from the user's phone (Element X).",
        "Reply conversationally in plain text: no tables, no ANSI, no 'session_id' footer.",
        "Be complete but compact; this is a phone screen. You may use your normal tools.",
        "",
        "Long jobs: before you start anything that will take more than ~30 seconds, write a",
        f"one-line status to {OUTBOX_PATH} (e.g. 'On it — this one's a few minutes, I'll ping",
        "you when it's done.'). The bridge delivers that file to this chat within seconds and",
        "then empties it, so you can reuse it for further progress notes. Do not stop at the",
        f"ack: finish the work and put the full result in your final answer. The bridge waits",
        f"up to {int(HERMES_TIMEOUT // 60)} minutes for that answer and sends it when you exit.",
    ]
    if context:
        policy = context.get("policy") or {}
        reminders = context.get("reminders") or {}
        if policy.get("ok") and str(policy.get("text") or "").strip():
            # The reader's own words, verbatim and ahead of everything else: this is the instruction the panel
            # saved, and it outranks the style lines above wherever they disagree.
            parts += ["", str(policy["text"]).rstrip()]
        elif policy.get("ok") is False:
            parts += [
                "",
                "## THE PANEL POLICY COULD NOT BE READ THIS TURN",
                f"The fetch failed: {policy.get('error')}",
                "Answer WITHOUT the reader's tone, quiet-hours and routing instructions, and SAY SO in your reply "
                "rather than pretending you followed them.",
            ]
        if reminders.get("ok") and str(reminders.get("text") or "").strip():
            parts += ["", str(reminders["text"]).rstrip()]
        elif reminders.get("ok") is False:
            parts += ["", f"(The reminder list and the watches could not be read this turn: {reminders.get('error')}.)"]
    if history:
        parts.append("[recent conversation, oldest first]")
        for role, msg in history:
            parts.append(f"{role}: {msg}")
        parts.append("[end of recent conversation]")
        parts.append("")
    parts.append(f"New message from the user: {text}")
    return "\n".join(parts)


async def ask_hermes(text: str, history: list[tuple[str, str]] | None = None,
                     context: dict | None = None) -> str:
    """Send one prompt to Hermes and return the cleaned answer.

    The panel read rides into the prompt here and the failure notice rides out on the answer: every return path
    below goes through `reply_with_context`, so no answer can quietly omit a policy it could not read.
    """
    binary = find_hermes()
    if not binary:
        raise RuntimeError("Hermes CLI not found; set HERMES_BIN in bridge.env")

    cmd = [binary, "chat", "-q", build_prompt(text, history or [], context), "--oneshot", "-Q"]
    if HERMES_TOOLSETS:
        cmd += ["-t", HERMES_TOOLSETS]

    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        raw_out, raw_err = await asyncio.wait_for(proc.communicate(), timeout=HERMES_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return reply_with_context(
            f"(Hermes hit the {int(HERMES_TIMEOUT)}s wall and was stopped mid-task. "
            "Say 'retry' or tell me to pick it up again.)",
            context,
        )

    out = _ANSI.sub("", raw_out.decode("utf-8", "replace")).strip()
    err = _ANSI.sub("", raw_err.decode("utf-8", "replace")).strip()
    out = _SESSION_LINE.sub("", out).strip()

    if not out:
        tail = "\n".join(err.splitlines()[-6:]) or f"exit code {proc.returncode}"
        return reply_with_context(f"(Hermes returned nothing — {tail})", context)
    return reply_with_context(out, context)


def chunk_text(text: str, limit: int = MAX_REPLY_CHARS) -> list[str]:
    """Split into Matrix-safe chunks, preferring newline boundaries."""
    if len(text) <= limit:
        return [text]
    chunks, buf = [], ""
    for line in text.splitlines(keepends=True):
        while len(line) > limit:
            if buf:
                chunks.append(buf)
                buf = ""
            chunks.append(line[:limit])
            line = line[limit:]
        if len(buf) + len(line) > limit:
            chunks.append(buf)
            buf = ""
        buf += line
    if buf:
        chunks.append(buf)
    return chunks


# ─────────────────────────────────────────────────────────────────────────────
# 4. MATRIX CLIENT
# ─────────────────────────────────────────────────────────────────────────────

def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def acquire_pid_file():
    """Two clients sharing one store corrupt the Olm state and stall sync."""
    lock = Path(STORE_DIR) / "bridge.pid"
    Path(STORE_DIR).mkdir(parents=True, exist_ok=True)
    if lock.exists():
        try:
            pid = int(lock.read_text(encoding="utf-8").strip() or 0)
        except ValueError:
            pid = 0
        if pid and pid != os.getpid() and _pid_alive(pid):
            print(f"Another bridge is already running (pid {pid}). Stop it first.")
            return None
    lock.write_text(str(os.getpid()), encoding="utf-8")
    atexit.register(lambda: lock.unlink(missing_ok=True))
    return lock


def windows_safe_store_class():
    """nio names its trust files '@user:server_DEVICE.ignored_devices'.

    ':' is illegal in a Windows filename, so every trust-DB write dies with
    WinError 123 and the send ack never happens. Subclass the default store and
    sanitize those three filenames (Windows only).
    """
    from nio.store.database import DefaultStore

    class WindowsSafeStore(DefaultStore):
        def __post_init__(self) -> None:
            super().__post_init__()
            for key_store in (self.trust_db, self.blacklist_db, self.ignore_db):
                path = Path(str(key_store._filename))
                key_store._filename = str(path.with_name(path.name.replace(":", "_")))

    return WindowsSafeStore


def make_client():
    from nio import AsyncClient, AsyncClientConfig

    Path(STORE_DIR).mkdir(parents=True, exist_ok=True)
    kwargs = {
        "encryption_enabled": True,
        # Do NOT persist the sync token: every start must re-sync room state,
        # otherwise client.rooms is empty for rooms joined in an earlier run
        # and room_send() fails with "No such room".
        "store_sync_tokens": False,
        # nio defaults the DB name to '<user_id>_<device>.db' — the ':' turns the
        # path into an NTFS alternate data stream on Windows and the store loses
        # the Olm account every restart. Pin a plain filename.
        "store_name": "matrix_store.db",
    }
    if os.name == "nt":
        kwargs["store"] = windows_safe_store_class()
    config = AsyncClientConfig(**kwargs)
    return AsyncClient(
        homeserver=HOMESERVER,
        user=USERNAME,
        device_id=DEVICE_ID,
        store_path=STORE_DIR,
        config=config,
    )


async def send_text(client, room_id: str, text: str, notice: bool = False) -> list[str]:
    """Send text (auto-chunked). Returns the event IDs the server accepted."""
    from nio import RoomSendError

    sent: list[str] = []
    for part in chunk_text(text):
        resp = await client.room_send(
            room_id=room_id,
            message_type="m.room.message",
            content={"msgtype": "m.notice" if notice else "m.text", "body": part},
            ignore_unverified_devices=True,
        )
        if isinstance(resp, RoomSendError):
            LOG.error("send failed: %s", resp.message)
        else:
            sent.append(resp.event_id)
    return sent


async def on_room_message(room, event) -> None:
    """Fires for decrypted m.room.message (m.text) events."""
    if not READY:
        return
    if TARGET_ROOM and room.room_id != TARGET_ROOM:
        return
    if event.sender == client.user_id:
        return
    if event.server_timestamp and event.server_timestamp < START_MS:
        return
    if event.event_id in SEEN:
        return
    body = (event.body or "").strip()
    if not body:
        return

    SEEN.add(event.event_id)
    print(f"\n[{time.strftime('%H:%M:%S')}] <- {room.display_name or room.room_id}: {body}")
    sys.stdout.flush()

    if body.lower() in {"/reset", "reset"}:
        HISTORY.clear()
        await send_text(client, room.room_id, "Conversation history cleared.")
        return

    await JOB_QUEUE.put((room.room_id, body))


async def on_invite(room, event) -> None:
    """Accept an invite only for the configured room; log the rest."""
    from nio import JoinError

    if not (ROOM_ID.startswith("!") and room.room_id == ROOM_ID):
        LOG.info("invited to %s (%s) — ignoring, ROOM_ID is %s",
                 room.room_id, room.display_name, ROOM_ID)
        return
    resp = await client.join(room.room_id)
    if isinstance(resp, JoinError):
        LOG.error("join on invite failed: %s", resp.message)
    else:
        LOG.info("joined on invite: %s", room.room_id)


async def on_undecryptable(room, event) -> None:
    """Megolm event we could not open — usually history from before this device."""
    global LAST_DECRYPT_HINT
    LOG.warning("undecryptable event in %s from %s (%s)",
                room.room_id, event.sender, getattr(event, "event_id", "?"))
    if event.server_timestamp and event.server_timestamp < START_MS:
        return                      # history from before this run — ignore quietly
    now = time.time()
    if now - LAST_DECRYPT_HINT < 600 or not TARGET_ROOM:
        return
    LAST_DECRYPT_HINT = now
    try:
        await send_text(client, TARGET_ROOM,
                        "I got an encrypted message I can't decrypt. New messages work; "
                        "this one was sent before my device had the room keys. Send it again.",
                        notice=True)
    except Exception:                                               # noqa: BLE001
        pass


async def keep_typing(room_id: str, interval: float = TYPING_REFRESH) -> None:
    """Re-send the typing notice for the whole turn.

    Matrix expires a typing notice after ~30s, so the single pre-turn notice
    leaves the phone silent during a long inference. Refresh every `interval`
    seconds until the caller cancels this task.
    """
    while True:
        await asyncio.sleep(interval)
        try:
            await client.room_typing(room_id, True, timeout=TYPING_TIMEOUT)
        except asyncio.CancelledError:
            raise
        except Exception:                                          # noqa: BLE001
            LOG.debug("typing refresh failed", exc_info=True)


async def worker() -> None:
    """Serial inference worker — keeps replies in order, never blocks sync."""
    while True:
        room_id, text = await JOB_QUEUE.get()
        typing_task: asyncio.Task | None = None
        try:
            await client.room_typing(room_id, True, timeout=TYPING_TIMEOUT)
            typing_task = asyncio.create_task(keep_typing(room_id))
            t0 = time.time()
            # Read the panel NOW, once for this turn: the policy the reader may have saved a second ago, and the
            # reminder list it keeps. `turn_context` has no cache, so the next message reads the panel again.
            context = turn_context()
            answer = await ask_hermes(text, list(HISTORY), context)
            elapsed = time.time() - t0
            HISTORY.append(("User", text))
            HISTORY.append(("Hermes", answer))
            print(f"[{time.strftime('%H:%M:%S')}] -> ({elapsed:.1f}s) {answer[:400]}"
                  + ("..." if len(answer) > 400 else ""))
            sys.stdout.flush()
            await send_text(client, room_id, answer)
        except Exception as exc:                                   # noqa: BLE001
            LOG.exception("worker failure")
            await send_text(client, room_id, f"Bridge error: {exc}", notice=True)
        finally:
            if typing_task is not None:
                typing_task.cancel()
                try:
                    await typing_task
                except asyncio.CancelledError:
                    pass
                except Exception:                                   # noqa: BLE001
                    LOG.debug("typing task teardown failed", exc_info=True)
            try:
                await client.room_typing(room_id, False)
            except Exception:                                       # noqa: BLE001
                pass
            JOB_QUEUE.task_done()


_OUTBOX_LOCK = asyncio.Lock()


async def drain_outbox(room_id: str) -> None:
    """Deliver anything parked in outbox.txt, then empty the file.

    Two uses: a restart double-dips as a delivery channel (drop text in the
    file, start the bridge), and a long-running turn posts progress notes while
    the worker is still blocked on inference.
    """
    if not room_id:
        return
    async with _OUTBOX_LOCK:
        if not OUTBOX_PATH.exists():
            return
        try:
            text = OUTBOX_PATH.read_text(encoding="utf-8").strip()
        except OSError:
            LOG.exception("outbox read failed")
            return
        if not text:
            OUTBOX_PATH.unlink(missing_ok=True)
            return
        event_ids = await send_text(client, room_id, text)
        if event_ids:
            OUTBOX_PATH.replace(OUTBOX_PATH.with_suffix(".sent"))
            print(f"[{time.strftime('%H:%M:%S')}] outbox delivered to {room_id} "
                  f"(event {event_ids[0]}, {len(text)} chars)")
        else:
            LOG.error("outbox send failed; file left in place")


async def outbox_loop(room_id: str) -> None:
    """Poll outbox.txt so a busy worker can still talk to the chat."""
    while True:
        await asyncio.sleep(OUTBOX_DRAIN)
        try:
            await drain_outbox(room_id)
        except asyncio.CancelledError:
            raise
        except Exception:                                          # noqa: BLE001
            LOG.debug("outbox drain failed", exc_info=True)


async def send_startup_ping(room_id: str) -> bool:
    """Requirement 5: prove the pipe works the moment we are up."""
    LOG.info("sending startup ping to %s", room_id)
    event_ids = await send_text(client, room_id, STARTUP_PING)
    if event_ids:
        print(f"[{time.strftime('%H:%M:%S')}] startup ping sent to {room_id} "
              f"(event {event_ids[0]})")
        return True
    print("startup ping FAILED — check the log above")
    return False


async def list_rooms() -> int:
    client = make_client()
    from nio import LoginError, SyncError

    resp = await client.login(password=PASSWORD, device_name="Hermes bridge (probe)")
    if isinstance(resp, LoginError):
        print(f"LOGIN FAILED: {resp.message}")
        await client.close()
        return 1
    print(f"logged in as {resp.user_id} on device {resp.device_id}")
    client.load_store()
    sync = await client.sync(timeout=10000, full_state=True)
    if isinstance(sync, SyncError):
        print(f"SYNC FAILED: {sync.message}")
        await client.close()
        return 1
    print("\nJOINED:")
    for room_id, room in client.rooms.items():
        print(f"  {room_id}  {room.display_name}")
    print("\nINVITED:")
    for room_id, room in client.invited_rooms.items():
        print(f"  {room_id}  {room.display_name}")
    print("\nPaste the one you want into ROOM_ID in bridge.env")
    await client.close()
    return 0


async def run_bridge() -> int:
    global READY, client, TARGET_ROOM
    from nio import InviteMemberEvent, LoginError, MegolmEvent, RoomMessageText, SyncError

    if "CHANGE_ME" in ROOM_ID or "CHANGE_ME" in PASSWORD:
        print("Refusing to start: ROOM_ID / PASSWORD still contain CHANGE_ME.")
        print("Fill them in at the top of this script or in bridge.env, then run --rooms to find ROOM_ID.")
        return 2

    if not acquire_pid_file():
        return 1

    Path(STORE_DIR).mkdir(parents=True, exist_ok=True)
    client = make_client()

    resp = await client.login(password=PASSWORD, device_name="Hermes bridge")
    if isinstance(resp, LoginError):
        print(f"LOGIN FAILED: {resp.message} ({resp.status_code})")
        await client.close()
        return 1
    print(f"logged in as {resp.user_id} (device {resp.device_id})")

    client.load_store()
    if client.should_upload_keys:
        await client.keys_upload()
        LOG.info("device keys uploaded")
    if client.should_query_keys:
        await client.keys_query()

    from nio import JoinError
    joined = await client.join(ROOM_ID)
    if isinstance(joined, JoinError):
        print(f"JOIN FAILED for {ROOM_ID}: {joined.message} — invite the bot first, or check --rooms")
        await client.close()
        return 1
    TARGET_ROOM = getattr(joined, "room_id", "") or ROOM_ID
    print(f"joined {ROOM_ID} -> {TARGET_ROOM}")

    # Prime the sync token without answering backlog.
    # full_state=True guarantees client.rooms has the room before we send.
    initial = await client.sync(timeout=5000, full_state=True)
    if isinstance(initial, SyncError):
        print(f"SYNC FAILED: {initial.message}")
        await client.close()
        return 1
    if TARGET_ROOM not in client.rooms:
        print(f"room {TARGET_ROOM} missing from sync — cannot send. Re-run with --rooms.")
        await client.close()
        return 1

    client.add_event_callback(on_room_message, RoomMessageText)
    client.add_event_callback(on_invite, InviteMemberEvent)
    client.add_event_callback(on_undecryptable, MegolmEvent)
    asyncio.create_task(worker())

    READY = True
    await send_startup_ping(TARGET_ROOM)
    await drain_outbox(TARGET_ROOM)
    asyncio.create_task(outbox_loop(TARGET_ROOM))
    print("\nBridge live. Send a message from Element X. Ctrl-C to stop.\n")

    await client.sync_forever(timeout=30000, since=initial.next_batch, set_presence="online")
    return 0


def self_test() -> int:
    ok = True
    print("config:")
    for key, val in (
        ("HOMESERVER", HOMESERVER), ("USERNAME", USERNAME),
        ("PASSWORD", "set" if PASSWORD and "CHANGE_ME" not in PASSWORD else "MISSING"),
        ("ROOM_ID", ROOM_ID), ("DEVICE_ID", DEVICE_ID), ("STORE_DIR", STORE_DIR),
        # The URL only, never the token: this output is pasted into tickets. --self-test still contacts nothing.
        ("PANEL_URL", PANEL_URL or "MISSING — no policy can be read"),
    ):
        print(f"  {key:<11}= {val}")
    if "CHANGE_ME" in PASSWORD:
        ok = False
        print("  ! PASSWORD still CHANGE_ME")

    try:
        import nio
        from nio.crypto import OlmDevice  # noqa: F401
        print(f"matrix-nio: OK ({Path(nio.__file__).parent})")
        print("e2ee:       OK (vodozemac)")
    except Exception as exc:                                        # noqa: BLE001
        ok = False
        print(f"matrix-nio: FAILED — {exc}")

    binary = find_hermes()
    print(f"hermes bin: {binary or 'NOT FOUND'}")
    ok = ok and bool(binary)
    return 0 if ok else 1


async def main_async(args) -> int:
    if args.rooms:
        return await list_rooms()
    if args.once:
        print(await ask_hermes(args.once, []))
        return 0
    return await run_bridge()


def main() -> int:
    load_env_file()
    parser = argparse.ArgumentParser(description="Matrix <-> Hermes bridge")
    parser.add_argument("--self-test", action="store_true", help="check config, deps, hermes binary")
    parser.add_argument("--rooms", action="store_true", help="log in and list rooms")
    parser.add_argument("--once", metavar="TEXT", help="one local inference, no Matrix")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        datefmt="%H:%M:%S")
    # nio is chatty at INFO and emits harmless response-validation warnings
    # ('one_time_key_counts' is a required property) on every keys upload.
    logging.getLogger("nio").setLevel(logging.ERROR)
    try:
        # stdout is block-buffered when redirected to a file; keep the live
        # transcript readable (and survive a hard kill).
        sys.stdout.reconfigure(line_buffering=True, encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\nstopped")
        return 0


if __name__ == "__main__":
    sys.exit(main())
