"""Checks what happens when a process running a second thread forks.

For each interpreter given on the command line, the probe forks while an exporter
thread holds a lock: once from __main__, once from an imported module (as
Gunicorn's arbiter does), and once with no other thread. Each runs under the
default warning filters and under -W default. It then runs Gunicorn with
--preload and an app that starts an exporter thread at import time. It reports
whether a DeprecationWarning about forking a multi-threaded process reached
stderr, and whether the child could take the lock the exporter held.

Pass one virtual environment per interpreter, each with Gunicorn installed.
"""

from datetime import datetime, timezone
import json
import os
import platform
import signal
import subprocess
import sys
import tempfile
import textwrap
import time

FORKER = textwrap.dedent('''
    import os
    def fork():
        return os.fork()
''')

CASE = textwrap.dedent('''
    import json, os, sys, threading, time
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import forker
    lock = threading.Lock()
    held = threading.Event()
    def exporter():
        with lock:
            held.set()
            time.sleep(3)
    if sys.argv[1] != "single_thread":
        threading.Thread(target=exporter, daemon=True).start()
        held.wait()
    pid = os.fork() if sys.argv[1] == "fork_in_main" else forker.fork()
    if pid == 0:
        acquired = lock.acquire(timeout=1)
        print(json.dumps({"child_threads": threading.active_count(), "child_acquired_lock": acquired}), flush=True)
        os._exit(0)
    os.waitpid(pid, 0)
''')

APP = textwrap.dedent('''
    import threading, time
    lock = threading.Lock()
    def exporter():
        while True:
            with lock:
                time.sleep(0.05)
            time.sleep(0.05)
    threading.Thread(target=exporter, daemon=True).start()
    def application(environ, start_response):
        start_response("200 OK", [("Content-Type", "text/plain")])
        return [b"ok"]
''')


def warning_lines(stderr: str) -> list[str]:
    return [line.strip() for line in stderr.splitlines() if "DeprecationWarning" in line and "multi-threaded" in line]


def run_case(python: str, directory: str, case: str, warnings: str | None) -> dict:
    env = {key: value for key, value in os.environ.items() if key != "PYTHONWARNINGS"}
    command = [python] + (["-W", warnings] if warnings else []) + [os.path.join(directory, "case.py"), case]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30, env=env)
    child = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else None
    return {"case": case, "warning_filter": warnings or "interpreter default", "warned": bool(warning_lines(result.stderr)),
            "warning": warning_lines(result.stderr), "child": child}


def run_gunicorn(gunicorn: str, directory: str, warnings: str | None) -> dict:
    env = {key: value for key, value in os.environ.items() if key != "PYTHONWARNINGS"}
    if warnings:
        env["PYTHONWARNINGS"] = warnings
    process = subprocess.Popen([gunicorn, "--preload", "--workers", "2", "--bind", "127.0.0.1:0", "--chdir", directory, "app:application"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    time.sleep(4)
    process.send_signal(signal.SIGTERM)
    _, stderr = process.communicate(timeout=30)
    booted = stderr.count("Booting worker with pid")
    return {"preload_app": True, "workers_booted": booted, "PYTHONWARNINGS": warnings or "unset",
            "warned": bool(warning_lines(stderr)), "warning": warning_lines(stderr)}


def main() -> None:
    runs = []
    with tempfile.TemporaryDirectory() as directory:
        for name, source in (("forker.py", FORKER), ("case.py", CASE), ("app.py", APP)):
            with open(os.path.join(directory, name), "w") as handle:
                handle.write(source)
        for venv in sys.argv[1:]:
            python = os.path.join(venv, "bin", "python")
            version = subprocess.run([python, "-c", "import platform; print(platform.python_version())"], capture_output=True, text=True).stdout.strip()
            gunicorn_version = subprocess.run([python, "-c", "import gunicorn; print(gunicorn.__version__)"], capture_output=True, text=True).stdout.strip()
            cases = [run_case(python, directory, case, warnings)
                     for case in ("fork_in_main", "fork_in_module", "single_thread") for warnings in (None, "default")]
            gunicorn = [run_gunicorn(os.path.join(venv, "bin", "gunicorn"), directory, warnings) for warnings in (None, "default")]
            runs.append({"python": version, "gunicorn": gunicorn_version, "direct_fork": cases, "gunicorn_preload": gunicorn})
    print(json.dumps({
        "schema_version": 1,
        "source": "reference_linux_vm",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "distribution": platform.freedesktop_os_release().get("PRETTY_NAME", "unknown"),
        "kernel": platform.release(),
        "runs": runs,
    }, indent=2))


if __name__ == "__main__":
    main()
