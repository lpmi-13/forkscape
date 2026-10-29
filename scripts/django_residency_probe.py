"""Django and Gunicorn residency probe for Forkscape's scenarios.

Run in a disposable labctl VM with an interpreter that has Django and Gunicorn
installed. It emits one JSON document to stdout. A small generated project is
served by two sync workers with preload_app, with preload_app and the URLconf
imported in the master, and without preload_app. The probe samples
smaps_rollup and status for the master and each worker at boot, after each
worker's first request, after each worker reads a preloaded catalog, and after
requests that retain new objects.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
import platform
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request


PORT = 8017
WORKERS = 2
ROLLUP_FIELDS = ("Rss", "Pss", "Pss_Anon", "Pss_File", "Shared_Clean", "Shared_Dirty",
                 "Private_Clean", "Private_Dirty", "Anonymous")
STATUS_FIELDS = ("VmSize", "VmRSS", "RssAnon", "RssFile")
PROJECT = {
    "probe_site/__init__.py": "",
    "probe_site/settings.py": '''
SECRET_KEY = "forkscape-probe"
DEBUG = False
ALLOWED_HOSTS = ["*"]
ROOT_URLCONF = "probe_site.urls"
INSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.auth"]
MIDDLEWARE = []
DATABASES = {}
USE_TZ = True
''',
    "probe_site/catalog.py": '''
# Built at import time, like a lookup table loaded by a preloaded app.
CATALOG = [{"id": 1000 + i, "name": f"item-{i}", "price": 3 * i + 1000} for i in range(150_000)]
''',
    "probe_site/wsgi.py": '''
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "probe_site.settings")
from probe_site import catalog  # noqa: F401
from django.core.wsgi import get_wsgi_application
application = get_wsgi_application()
if os.environ.get("FORKSCAPE_WARM_URLCONF"):
    from django.urls import get_resolver
    get_resolver().url_patterns
''',
    "probe_site/urls.py": '''
from django.urls import path
from probe_site import views
urlpatterns = [path("ping", views.ping), path("scan", views.scan), path("retain", views.retain)]
''',
    "probe_site/views.py": '''
import os
from django.http import JsonResponse
from probe_site.catalog import CATALOG

# Created when the URLconf first imports this module.
ROUTE_TABLE = {f"/route/{i}": {"name": f"route-{i}", "weight": i} for i in range(20_000)}
RETAINED = []


def ping(request):
    return JsonResponse({"pid": os.getpid()})


def scan(request):
    total = 0
    for item in CATALOG:
        total += item["price"]
    return JsonResponse({"pid": os.getpid(), "total": total})


def retain(request):
    RETAINED.append(b"x" * (256 * 1024))
    return JsonResponse({"pid": os.getpid(), "retained": len(RETAINED)})
''',
    "gunicorn_conf.py": '''
import json
import os
import sys

LOG = os.environ["FORKSCAPE_HOOK_LOG"]


def _log(event):
    loaded = {name: name in sys.modules for name in ("django", "probe_site.catalog", "probe_site.urls", "probe_site.views")}
    with open(LOG, "a", encoding="utf-8") as log:
        log.write(json.dumps({"event": event, "pid": os.getpid(), "modules": loaded}) + "\\n")


def when_ready(server):
    _log("master_ready")


def post_fork(server, worker):
    _log("post_fork")


def post_worker_init(worker):
    _log("post_worker_init")
''',
}


def fields(path: str, names: tuple[str, ...]) -> dict[str, int]:
    values = {}
    with open(path, encoding="ascii") as source:
        for line in source:
            key, _, rest = line.partition(":")
            if key in names:
                values[key + "_kib"] = int(rest.split()[0])
    return values


def faults(pid: int) -> dict[str, int]:
    with open(f"/proc/{pid}/stat", encoding="ascii") as stat:
        after_name = stat.read().rsplit(")", 1)[1].split()
    return {"minflt": int(after_name[7]), "majflt": int(after_name[9])}


def sample(master: int, workers: list[int]) -> dict:
    processes = {}
    for role, pid in [("master", master)] + [(f"worker_{index + 1}", pid) for index, pid in enumerate(workers)]:
        processes[role] = {"pid": pid, **fields(f"/proc/{pid}/smaps_rollup", ROLLUP_FIELDS),
                           **fields(f"/proc/{pid}/status", STATUS_FIELDS), **faults(pid)}
    totals = {key: sum(row[key] for row in processes.values()) for key in ("Rss_kib", "Pss_kib")}
    return {"processes": processes, "totals": totals}


def hook_events(log: str) -> list[dict]:
    if not os.path.exists(log):
        return []
    with open(log, encoding="utf-8") as source:
        return [json.loads(line) for line in source]


def request(path: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=30) as response:
        return json.load(response)


def until_each_worker(path: str, workers: list[int], rounds: int = 100) -> dict[int, int]:
    """Send concurrent rounds until every worker has served the request; returns requests per worker.

    Sequential requests can all land on one sync worker. Concurrent requests keep
    one worker busy so another must accept.
    """
    served = {pid: 0 for pid in workers}
    with ThreadPoolExecutor(max_workers=len(workers)) as pool:
        for _ in range(rounds):
            for result in pool.map(request, [path] * len(workers)):
                served[result["pid"]] += 1
            if all(served.values()):
                return served
    raise RuntimeError(f"Not every worker served {path}: {served}")


def run(directory: str, preload: bool, warm_urlconf: bool = False) -> dict:
    log = os.path.join(directory, f"hooks-{'preload' if preload else 'no-preload'}{'-warm' if warm_urlconf else ''}.jsonl")
    command = [sys.executable, "-m", "gunicorn", "probe_site.wsgi:application", "-c", "gunicorn_conf.py",
               "--workers", str(WORKERS), "--bind", f"127.0.0.1:{PORT}", "--log-level", "warning"]
    if preload:
        command.append("--preload")
    env = {**os.environ, "FORKSCAPE_HOOK_LOG": log}
    if warm_urlconf:
        env["FORKSCAPE_WARM_URLCONF"] = "1"
    server = subprocess.Popen(command, cwd=directory, env=env)
    try:
        deadline = time.monotonic() + 60
        while sum(event["event"] == "post_worker_init" for event in hook_events(log)) < WORKERS:
            if time.monotonic() > deadline or server.poll() is not None:
                raise RuntimeError("Gunicorn workers did not start")
            time.sleep(0.2)
        time.sleep(1)
        workers = sorted(event["pid"] for event in hook_events(log) if event["event"] == "post_worker_init")
        readings = {"boot": sample(server.pid, workers)}
        readings["first_request"] = {"served": until_each_worker("/ping", workers), **sample(server.pid, workers)}
        readings["catalog_scan"] = {"served": until_each_worker("/scan", workers), **sample(server.pid, workers)}
        retained = {pid: 0 for pid in workers}
        for _ in range(40):
            result = request("/retain")
            retained[result["pid"]] = result["retained"]
        readings["retained_256_kib_objects"] = {"retained": retained, **sample(server.pid, workers)}
        return {"preload_app": preload, "warm_urlconf_in_master": warm_urlconf, "master_pid": server.pid, "worker_pids": workers,
                "hook_events": hook_events(log), "readings": readings}
    finally:
        server.send_signal(signal.SIGTERM)
        server.wait(timeout=30)


if __name__ == "__main__":
    import django
    import gunicorn

    with tempfile.TemporaryDirectory(prefix="forkscape-django-") as directory:
        for name, source in PROJECT.items():
            os.makedirs(os.path.join(directory, os.path.dirname(name)), exist_ok=True)
            with open(os.path.join(directory, name), "w", encoding="utf-8") as file:
                file.write(source.lstrip())
        runs = [run(directory, preload=True), run(directory, preload=True, warm_urlconf=True),
                run(directory, preload=False)]
    print(json.dumps({
        "schema_version": 1,
        "source": "reference_linux_vm",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "distribution": platform.freedesktop_os_release().get("PRETTY_NAME", "unknown"),
        "kernel": platform.release(),
        "python": platform.python_version(),
        "django": django.get_version(),
        "gunicorn": gunicorn.__version__,
        "workers": WORKERS,
        "runs": runs,
    }, indent=2))
