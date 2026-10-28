"""Reads markers and writes Forkscape recordings, for both the bpftrace tracer and the pagemap sampler.

A recording is a Trace Event Format file whose first event is a `forkscape` header (docs/recording-format.md). Forkscape
sorts events by time itself, but a sorted file is easier to read and to diff.
"""

from datetime import datetime
import json
import os
from pathlib import Path
import platform
import socket
import sys

PAGE = os.sysconf("SC_PAGE_SIZE")


def say(message: str) -> None:
    print(f"forkscape: {message}", file=sys.stderr, flush=True)


def read_markers(path: Path) -> list[dict]:
    """The markers forkscape_markers.py appended to `path`, skipping any line that is not a whole event."""
    markers = []
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return markers
    for number, line in enumerate(text.splitlines(), 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            say(f"skipped marker line {number}, which is not JSON")
            continue
        if isinstance(event, dict) and "ts" in event and "pid" in event:
            markers.append(event)
    return markers


def operating_system() -> str:
    try:
        return platform.freedesktop_os_release().get("PRETTY_NAME", "Linux")
    except OSError:
        return "Linux"


def header(*, title: str, source: str, captured_at: datetime, notes: str = "", runtime: str | None = None,
           config: dict | None = None, host: str | None = None, stage_gap_ms: float | None = None) -> dict:
    """The recording's header, shown with the replay. `source` says how the events were collected."""
    fields = {
        "version": 1, "page_size": PAGE, "title": title[:160], "source": source[:160],
        "captured_at": captured_at.isoformat(timespec="seconds"), "kernel": platform.release(), "host": host or socket.gethostname(),
    }
    if runtime:
        fields["runtime"] = runtime
    if config:
        fields["config"] = config
    if notes:
        fields["notes"] = notes
    if stage_gap_ms:
        fields["stage_gap_ms"] = stage_gap_ms
    return fields


def write(path: Path, fields: dict, events: list[dict], names: dict[int, str], announce: bool = True) -> Path:
    """Writes the recording to `path`, one event per line. Under sudo, the file is given to the user who ran sudo.

    The file is written beside `path` and renamed over it, which also replaces a file another user owns in /tmp, where
    fs.protected_regular stops root from opening it for writing.
    """
    path = Path(path).resolve()
    partial = path.with_name(f".{path.name}.{os.getpid()}.partial")
    events = sorted(events, key=lambda event: event["ts"])
    metadata = [{"ph": "M", "name": "forkscape", "pid": 0, "args": fields}]
    metadata += [{"ph": "M", "name": "process_name", "pid": pid, "args": {"name": name}} for pid, name in sorted(names.items())]
    with partial.open("w", encoding="utf-8") as out:
        out.write('{"traceEvents":[\n')
        out.write(",\n".join(json.dumps(event, separators=(",", ":")) for event in metadata + events))
        out.write("\n]}\n")
    if os.geteuid() == 0 and os.environ.get("SUDO_UID"):
        os.chown(partial, int(os.environ["SUDO_UID"]), int(os.environ.get("SUDO_GID", os.environ["SUDO_UID"])))
    os.replace(partial, path)
    if announce:
        say(f"wrote {path} ({path.stat().st_size / 1048576:.1f} MiB, {len(events):,} events)")
    return path


def check_writable(path: Path) -> None:
    """Fails before recording, not after, if the recording could not be written."""
    probe = Path(path).resolve().with_name(f".{Path(path).name}.{os.getpid()}.check")
    try:
        probe.write_text("")
        probe.unlink()
    except OSError as error:
        raise SystemExit(f"forkscape: cannot write next to {path}: {error.strerror}")
