"""Markers for Forkscape recordings: Gunicorn hooks, requests, imports, and moments of your own.

The recording examples set FORKSCAPE_MARKERS to a file and put this module on the workload's PYTHONPATH. Markers are trace
events timed with CLOCK_MONOTONIC, the clock bpftrace uses, so they merge with the kernel's events. Without FORKSCAPE_MARKERS,
every function here does nothing, so a config that uses it also runs unrecorded.

Under the pagemap sampler, FORKSCAPE_SYNC also names the sampler's socket. Each marker then waits while the sampler takes a
snapshot, so the pages a process changed before a marker are placed before it in the replay. Import slices do not wait.

In a Gunicorn config file:

    import forkscape_markers
    forkscape_markers.gunicorn(globals())       # a marker for each server hook, and a slice for each request
    forkscape_markers.trace_imports(depth=3)    # a slice for each import up to three deep, such as a preloaded app's

Anywhere else:

    forkscape_markers.marker("cache warmed", entries=1200)
    with forkscape_markers.span("load catalog"):
        ...
    forkscape_markers.phase("Serving traffic")  # phases replace Forkscape's automatic ones
"""

import json
import os
import threading
import time

_PATH = os.environ.get("FORKSCAPE_MARKERS")
_SYNC = os.environ.get("FORKSCAPE_SYNC")
_fd = None
_syncs = 0


def _now() -> float:
    return time.monotonic_ns() / 1000


def _write(event: dict, sync: bool = True) -> None:
    global _fd
    if not _PATH:
        return
    event.setdefault("pid", os.getpid())
    event.setdefault("tid", threading.get_native_id())
    if _fd is None:
        # One descriptor, opened once and inherited by forked workers. O_APPEND keeps each process's lines whole.
        _fd = os.open(_PATH, os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC)
    os.write(_fd, (json.dumps(event, separators=(",", ":"), default=str) + "\n").encode())
    if sync:
        _sync(event["ts"] + event.get("dur", 0))


def _sync(at: float) -> None:
    """Waits while the sampler snapshots memory. `at` is when the moment happened; this process's changes go just before it."""
    if not _SYNC:
        return
    import socket

    global _syncs
    _syncs += 1
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC) as channel:
            channel.settimeout(5)
            # A name under the sampler's own tells it this descriptor is not the workload's.
            try:
                channel.bind(f"\0{_SYNC}.{os.getpid()}.{threading.get_native_id()}.{_syncs}")
            except OSError:
                pass
            channel.connect("\0" + _SYNC)
            # The sampler leaves this socket out of the descriptors it sees open.
            channel.sendall(json.dumps({"pid": os.getpid(), "ts": at, "socket": os.fstat(channel.fileno()).st_ino}).encode() + b"\n")
            channel.recv(1)
    except OSError:
        pass


def marker(name: str, cat: str = "app", **args) -> None:
    """A moment, which starts a stage in the replay."""
    _write({"ph": "i", "name": name, "cat": cat, "ts": _now(), "args": args})


def phase(label: str) -> None:
    """Starts a phase. A recording with any phase markers uses only those, instead of Forkscape's automatic phases."""
    _write({"ph": "i", "name": "phase", "cat": "app", "ts": _now(), "args": {"label": label}})


class span:
    """A slice from entering to leaving. An outermost slice starts a stage; one inside another annotates it."""

    def __init__(self, name: str, cat: str = "app", **args):
        self.name, self.cat, self.args = name, cat, args

    def __enter__(self):
        self.start = _now()
        return self

    def __exit__(self, *_):
        _write({"ph": "X", "name": self.name, "cat": self.cat, "ts": self.start, "dur": _now() - self.start, "args": self.args})
        return False


def trace_imports(depth: int = 3) -> None:
    """Records a slice for each module imported from now on, for imports up to `depth` levels deep."""
    if not _PATH:
        return
    import _frozen_importlib as bootstrap  # The import system calls its _find_and_load for every module not yet loaded.

    original = bootstrap._find_and_load
    if getattr(original, "_forkscape", False):
        return
    level = threading.local()

    def _find_and_load(name, import_):
        current = getattr(level, "value", 0)
        level.value = current + 1
        start = _now()
        try:
            return original(name, import_)
        finally:
            level.value = current
            if current < depth:
                _write({"ph": "X", "name": "import", "cat": "python", "ts": start, "dur": _now() - start, "args": {"module": name}}, sync=False)

    _find_and_load._forkscape = True
    bootstrap._find_and_load = _find_and_load


def gunicorn(namespace: dict) -> None:
    """Adds Gunicorn server hooks to a config module's namespace, keeping any hooks it already defines.

    Gunicorn checks each hook's number of arguments, so each one is written out.
    """
    def chained(name, hook):
        earlier = namespace.get(name)
        namespace[name] = hook if not callable(earlier) else _chain(hook, earlier)

    def when_ready(server):
        marker("when_ready", "gunicorn", workers=server.num_workers)

    def post_fork(server, worker):
        marker("post_fork", "gunicorn", age=worker.age)

    def post_worker_init(worker):
        marker("post_worker_init", "gunicorn")

    def pre_request(worker, req):
        _sync(_now())  # Separates what changed before the request from what it changes.
        worker._forkscape_request = _now()

    def post_request(worker, req, environ, resp):
        start = getattr(worker, "_forkscape_request", None)
        if start is None:
            return
        status = getattr(resp, "status", None)
        _write({"ph": "X", "name": "request", "cat": "gunicorn", "ts": start, "dur": _now() - start,
                "args": {"method": req.method, "path": req.path, "status": str(status).split(" ")[0] if status else None, "served": worker.nr}})

    def worker_exit(server, worker):
        marker("worker_exit", "gunicorn", served=worker.nr)

    def child_exit(server, worker):
        marker("child_exit", "gunicorn", worker=worker.pid)

    def nworkers_changed(server, new_value, old_value):
        marker("nworkers_changed", "gunicorn", workers=new_value, was=old_value)

    def on_exit(server):
        marker("on_exit", "gunicorn")

    for hook in (when_ready, post_fork, post_worker_init, pre_request, post_request, worker_exit, child_exit, nworkers_changed, on_exit):
        chained(hook.__name__, hook)


def _chain(first, second):
    """Calls both hooks with Gunicorn's arguments, keeping the arity Gunicorn checks."""
    import inspect

    count = len(inspect.signature(second).parameters)
    if count == 1:
        return lambda a: (first(a), second(a))[1]
    if count == 2:
        return lambda a, b: (first(a, b), second(a, b))[1]
    if count == 3:
        return lambda a, b, c: (first(a, b, c), second(a, b, c))[1]
    return lambda a, b, c, d: (first(a, b, c, d), second(a, b, c, d))[1]
