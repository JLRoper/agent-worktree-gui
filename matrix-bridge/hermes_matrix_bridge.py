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
import logging
import os
import re
import shutil
import sys
import time
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
# 2. CORE INFERENCE — shell out to the local Hermes CLI
# ─────────────────────────────────────────────────────────────────────────────

_SESSION_LINE = re.compile(r"^\s*session_id:\s*\S+\s*$", re.MULTILINE)
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def build_prompt(text: str, history: list[tuple[str, str]]) -> str:
    """One-shot Hermes has no memory of prior turns, so replay recent context."""
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
    if history:
        parts.append("[recent conversation, oldest first]")
        for role, msg in history:
            parts.append(f"{role}: {msg}")
        parts.append("[end of recent conversation]")
        parts.append("")
    parts.append(f"New message from the user: {text}")
    return "\n".join(parts)


async def ask_hermes(text: str, history: list[tuple[str, str]] | None = None) -> str:
    """Send one prompt to Hermes and return the cleaned answer."""
    binary = find_hermes()
    if not binary:
        raise RuntimeError("Hermes CLI not found; set HERMES_BIN in bridge.env")

    cmd = [binary, "chat", "-q", build_prompt(text, history or []), "--oneshot", "-Q"]
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
        return (f"(Hermes hit the {int(HERMES_TIMEOUT)}s wall and was stopped mid-task. "
                "Say 'retry' or tell me to pick it up again.)")

    out = _ANSI.sub("", raw_out.decode("utf-8", "replace")).strip()
    err = _ANSI.sub("", raw_err.decode("utf-8", "replace")).strip()
    out = _SESSION_LINE.sub("", out).strip()

    if not out:
        tail = "\n".join(err.splitlines()[-6:]) or f"exit code {proc.returncode}"
        return f"(Hermes returned nothing — {tail})"
    return out


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
# 3. MATRIX CLIENT
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
            answer = await ask_hermes(text, list(HISTORY))
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
