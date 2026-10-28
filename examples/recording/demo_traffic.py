"""The demo workload all four examples record, and the traffic that drives it.

The workload is demo_app/: a Django app whose import builds a 150,000-entry catalog, under Gunicorn with two sync workers
and preload_app. The traffic:
  1. /ping, served by each worker, which imports the URLconf there (Django imports it on a worker's first request);
  2. /scan in each worker, which reads every catalog entry and so copies the catalog's pages (reference counts are writes);
  3. SIGTTIN, so the master forks a third worker after the others have copied the catalog, and a /ping it serves;
then the example stops the server with SIGTERM, a graceful shutdown: the workers exit and the master reaps them and exits.
"""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import time
from typing import Callable
import urllib.request

DEMO = Path(__file__).resolve().parent / "demo_app"
PORT = 8017
TITLE = "Gunicorn with preload_app: boot, first requests, catalog scans, a third worker, shutdown"
NOTES = ("A Django app whose import builds a 150,000-entry catalog, served by two sync workers. Each worker serves /ping, "
         "which imports the URLconf, then /scan, which reads every catalog entry. SIGTTIN adds a third worker; SIGTERM stops the server.")


def command(python: str = "python", bind: str = f"127.0.0.1:{PORT}") -> list[str]:
    return [python, "-m", "gunicorn", "demo_site.wsgi:application", "-c", "gunicorn_conf.py",
            "--workers", "2", "--bind", bind, "--log-level", "warning", "--preload"]


def versions(python: list[str]) -> str:
    """The runtime's versions, for the recording's header. `python` is how to run that Python, such as inside a container."""
    return subprocess.run([*python, "-c", "import platform, django, gunicorn; "
                           "print(f'Python {platform.python_version()}, Django {django.get_version()}, Gunicorn {gunicorn.__version__}')"],
                          capture_output=True, text=True, check=True).stdout.strip()


def request(path: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=60) as response:
        return json.load(response)


def wait_until_serving(running: Callable[[], bool], timeout: float = 120) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            request("/ping")
            return
        except OSError:
            if not running() or time.monotonic() > deadline:
                raise RuntimeError("Gunicorn did not start")
            time.sleep(0.25)


def until_served(path: str, workers: int, pids: set[int] | None = None, rounds: int = 200) -> set[int]:
    """Sends concurrent rounds until `workers` distinct workers (or each of `pids`) have served the path."""
    served: set[int] = set()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for _ in range(rounds):
            served.update(result["pid"] for result in pool.map(request, [path] * workers))
            if (pids and pids <= served) or (not pids and len(served) >= workers):
                return served
            time.sleep(0.05)
    raise RuntimeError(f"only {sorted(served)} served {path}")


def drive(add_worker: Callable[[], None]) -> None:
    """Steps 1 to 3. `add_worker` sends the master SIGTTIN, however the example reaches it."""
    time.sleep(1)
    first = until_served("/ping", 2)
    time.sleep(0.5)
    until_served("/scan", 2, first)
    time.sleep(0.5)
    add_worker()
    time.sleep(1.5)
    until_served("/ping", 3)
    time.sleep(0.5)
