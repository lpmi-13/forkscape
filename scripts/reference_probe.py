"""Small Linux reference probe for Forkscape's teaching model.

Run in a disposable labctl Ubuntu VM. It emits one JSON document to stdout.
The process-wide VmPTE counter is reported alongside mapping-local smaps values.
"""

import ctypes
from datetime import datetime, timezone
import json
import mmap
import os
import platform
import tempfile


PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
MAP_PAGES = 16


def mapping_metrics(pid: int, address: int) -> dict[str, int]:
    metrics: dict[str, int] = {}
    inside = False
    with open(f"/proc/{pid}/smaps", encoding="ascii") as smaps:
        for line in smaps:
            first = line.split(maxsplit=1)[0]
            if "-" in first:
                bounds = first.split("-")
                try:
                    start, end = int(bounds[0], 16), int(bounds[1], 16)
                except ValueError:
                    continue
                inside = start <= address < end
            elif inside and line.startswith(("Rss:", "Pss:", "Shared_Dirty:", "Private_Dirty:")):
                key, amount, _unit = line.split()
                metrics[key[:-1] + "_kib"] = int(amount)
    with open(f"/proc/{pid}/status", encoding="ascii") as status:
        for line in status:
            if line.startswith("VmPTE:"):
                metrics["VmPTE_kib"] = int(line.split()[1])
                break
    return metrics


def send(fd: int, token: bytes) -> None:
    if os.write(fd, token) != 1:
        raise RuntimeError("Pipe write failed")


def receive(fd: int) -> bytes:
    token = os.read(fd, 1)
    if len(token) != 1:
        raise RuntimeError("Pipe closed unexpectedly")
    return token


def anonymous_fork_probe() -> dict[str, dict[str, int]]:
    # PROT_NONE guard pages keep the measured VMA separate from Python's other
    # anonymous mappings, so smaps reports only these MAP_PAGES data pages.
    size = (MAP_PAGES + 2) * PAGE_SIZE
    mapping = mmap.mmap(-1, size, flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS,
                        prot=mmap.PROT_READ | mmap.PROT_WRITE)
    base = ctypes.addressof(ctypes.c_char.from_buffer(mapping))
    libc = ctypes.CDLL(None, use_errno=True)
    for guard in (base, base + (MAP_PAGES + 1) * PAGE_SIZE):
        if libc.mprotect(ctypes.c_void_p(guard), ctypes.c_size_t(PAGE_SIZE), ctypes.c_int(0)) != 0:
            raise OSError(ctypes.get_errno(), "mprotect failed")
    for page in range(MAP_PAGES):
        mapping[(page + 1) * PAGE_SIZE] = 1
    address = base + PAGE_SIZE
    parent_pid = os.getpid()
    readings = {"before_fork_parent": mapping_metrics(parent_pid, address)}
    to_child_r, to_child_w = os.pipe()
    from_child_r, from_child_w = os.pipe()
    child_pid = os.fork()
    if child_pid == 0:
        os.close(to_child_w)
        os.close(from_child_r)
        send(from_child_w, b"r")
        if receive(to_child_r) != b"w":
            os._exit(2)
        mapping[3 * PAGE_SIZE] = 2
        send(from_child_w, b"d")
        if receive(to_child_r) != b"q":
            os._exit(3)
        os._exit(0)
    os.close(to_child_r)
    os.close(from_child_w)
    try:
        if receive(from_child_r) != b"r":
            raise RuntimeError("Child did not become ready")
        readings["after_fork_parent"] = mapping_metrics(parent_pid, address)
        readings["after_fork_child"] = mapping_metrics(child_pid, address)
        send(to_child_w, b"w")
        if receive(from_child_r) != b"d":
            raise RuntimeError("Child did not write")
        readings["after_write_parent"] = mapping_metrics(parent_pid, address)
        readings["after_write_child"] = mapping_metrics(child_pid, address)
        send(to_child_w, b"q")
        waited_pid, status = os.waitpid(child_pid, 0)
        if waited_pid != child_pid or os.waitstatus_to_exitcode(status) != 0:
            raise RuntimeError("Child failed")
    finally:
        os.close(to_child_w)
        os.close(from_child_r)
        mapping.close()
    return readings


def resident(mapping: mmap.mmap) -> bool:
    libc = ctypes.CDLL(None, use_errno=True)
    address = ctypes.addressof(ctypes.c_char.from_buffer(mapping))
    vector = (ctypes.c_ubyte * 1)()
    if libc.mincore(ctypes.c_void_p(address), ctypes.c_size_t(PAGE_SIZE), vector) != 0:
        raise OSError(ctypes.get_errno(), "mincore failed")
    return bool(vector[0] & 1)


def file_cache_probe() -> dict[str, bool]:
    with tempfile.TemporaryDirectory(prefix="forkscape-") as directory:
        path = os.path.join(directory, "page.dat")
        with open(path, "wb") as file:
            file.write(b"x" * PAGE_SIZE)
            file.flush()
            os.fsync(file.fileno())
        with open(path, "r+b") as file:
            mapping = mmap.mmap(file.fileno(), PAGE_SIZE, access=mmap.ACCESS_WRITE)
            mapping[0] = ord("y")
            mapped_resident = resident(mapping)
            mapping.close()
        # There are no mappings or open descriptors when this mapping is created.
        with open(path, "r+b") as file:
            mapping = mmap.mmap(file.fileno(), PAGE_SIZE, access=mmap.ACCESS_WRITE)
            remapped_resident_before_touch = resident(mapping)
            mapping.close()
    return {"mapped_resident": mapped_resident,
            "remapped_resident_before_touch": remapped_resident_before_touch}


if __name__ == "__main__":
    print(json.dumps({
        "schema_version": 1,
        "source": "reference_linux_vm",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "distribution": platform.freedesktop_os_release().get("PRETTY_NAME", "unknown"),
        "kernel": platform.release(),
        "page_size_bytes": PAGE_SIZE,
        "anonymous_mapping_pages": MAP_PAGES,
        "anonymous": anonymous_fork_probe(),
        "file_cache": file_cache_probe(),
    }, indent=2))
