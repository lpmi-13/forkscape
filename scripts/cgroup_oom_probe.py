"""Observe one cgroup-v2 OOM in a disposable Linux VM, as root.

Only two children are moved into a fresh, memory-limited cgroup. The driver
stays outside it. This records a victim, not a universal victim-selection rule.
"""

import json
from datetime import datetime, timezone
import os
from pathlib import Path
import platform
import subprocess
import sys
import time


LIMIT_BYTES = 64 * 1024 * 1024
ALLOCATION_BYTES = 35 * 1024 * 1024
CGROUP_ROOT = Path("/sys/fs/cgroup")


def read_number(path: Path) -> int:
    return int(path.read_text().strip())


def memory_events(group: Path) -> dict[str, int]:
    return {key: int(value) for key, value in
            (line.split() for line in (group / "memory.events").read_text().splitlines())}


def child_mode(score_adjustment: int) -> None:
    Path("/proc/self/oom_score_adj").write_text(str(score_adjustment))
    print("ready", flush=True)
    if sys.stdin.readline().strip() != "allocate":
        return
    allocation = bytearray(ALLOCATION_BYTES)
    for offset in range(0, len(allocation), os.sysconf("SC_PAGE_SIZE")):
        allocation[offset] = 1
    print("allocated", flush=True)
    sys.stdin.readline()  # Keep the allocation resident until the driver records it.


def start_child(group: Path, adjustment: int,
                children: list[subprocess.Popen[str]]) -> subprocess.Popen[str]:
    child = subprocess.Popen(
        [sys.executable, __file__, "--child", str(adjustment)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1,
    )
    children.append(child)
    assert child.stdout and child.stdin
    if child.stdout.readline().strip() != "ready":
        raise RuntimeError("Child did not become ready")
    (group / "cgroup.procs").write_text(str(child.pid))
    return child


def send(child: subprocess.Popen[str], command: str) -> None:
    assert child.stdin
    child.stdin.write(command + "\n")
    child.stdin.flush()


def run_probe() -> dict:
    if os.geteuid() != 0:
        raise RuntimeError("Run this probe as root in the disposable VM")
    if "memory" not in (CGROUP_ROOT / "cgroup.subtree_control").read_text().split():
        raise RuntimeError("Root cgroup has not enabled the memory controller")
    group = CGROUP_ROOT / f"forkscape-oom-{os.getpid()}"
    group.mkdir()
    children: list[subprocess.Popen[str]] = []
    try:
        (group / "memory.max").write_text(str(LIMIT_BYTES))
        (group / "memory.swap.max").write_text("0")
        high_score = start_child(group, 500, children)
        normal_score = start_child(group, 0, children)
        send(high_score, "allocate")
        assert high_score.stdout
        if high_score.stdout.readline().strip() != "allocated":
            raise RuntimeError("First child did not allocate")
        before = {
            "memory_current_bytes": read_number(group / "memory.current"),
            "events": memory_events(group),
            "children": [{"pid": child.pid,
                          "oom_score_adj": read_number(Path(f"/proc/{child.pid}/oom_score_adj")),
                          "oom_score": read_number(Path(f"/proc/{child.pid}/oom_score"))}
                         for child in children],
        }
        send(normal_score, "allocate")
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and memory_events(group)["oom_kill"] == 0:
            time.sleep(0.05)
        time.sleep(0.1)  # Let wait status settle after the cgroup event counter changes.
        after = {"memory_current_bytes": read_number(group / "memory.current"),
                 "events": memory_events(group),
                 "exit_codes_before_cleanup": {str(child.pid): child.poll() for child in children}}
        return {
            "schema_version": 1, "source": "reference_linux_vm",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "distribution": platform.freedesktop_os_release().get("PRETTY_NAME", "unknown"),
            "kernel": platform.release(), "cgroup_version": 2,
            "memory_max_bytes": LIMIT_BYTES, "memory_swap_max_bytes": 0,
            "allocation_per_child_bytes": ALLOCATION_BYTES,
            "memory_oom_group": read_number(group / "memory.oom.group"),
            "before_second_allocation": before, "after_second_allocation": after,
        }
    finally:
        for child in children:
            if child.poll() is None:
                try:
                    send(child, "quit")
                    child.wait(timeout=2)
                except (BrokenPipeError, subprocess.TimeoutExpired):
                    child.kill()
                    child.wait(timeout=2)
            else:
                child.wait()
            if child.stdin:
                child.stdin.close()
            if child.stdout:
                child.stdout.close()
            if child.stderr:
                child.stderr.close()
        group.rmdir()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        child_mode(int(sys.argv[2]))
    else:
        print(json.dumps(run_probe(), indent=2))
