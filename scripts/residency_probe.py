"""Residency reference probe for Forkscape's teaching model.

Run in a disposable labctl VM. It emits one JSON document to stdout.
Each case reads one VMA's smaps fields in a parent and a forked child to show
which pages count in RSS after mmap, reads, writes, and fork.
"""

import ctypes
from datetime import datetime, timezone
import json
import mmap
import os
import platform
import tempfile


PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
PAGES = 64
FIELDS = ("Rss", "Pss", "Shared_Clean", "Shared_Dirty", "Private_Clean", "Private_Dirty", "Anonymous")
libc = ctypes.CDLL(None, use_errno=True)


def vma_metrics(pid: int, path: str | None = None, address: int | None = None) -> dict[str, int]:
    """smaps fields for the VMA containing address, or the first VMA backed by path."""
    metrics: dict[str, int] = {}
    inside = False
    with open(f"/proc/{pid}/smaps", encoding="utf-8") as smaps:
        for line in smaps:
            first = line.split(maxsplit=1)[0]
            if "-" in first and not first.endswith(":"):
                if inside:
                    break
                start, end = (int(part, 16) for part in first.split("-"))
                inside = start <= address < end if address is not None else line.rstrip().endswith(path)
            elif inside and first[:-1] in FIELDS:
                metrics[first[:-1] + "_kib"] = int(line.split()[1])
    if not metrics:
        raise RuntimeError(f"VMA not found in PID {pid}")
    return metrics


def faults(pid: int) -> dict[str, int]:
    with open(f"/proc/{pid}/stat", encoding="ascii") as stat:
        fields = stat.read().rsplit(")", 1)[1].split()
    # Fields after the command name start at field 3 (state); minflt is 10, majflt is 12.
    return {"minflt": int(fields[7]), "majflt": int(fields[9])}


def sample(pid: int, **where) -> dict:
    return {**vma_metrics(pid, **where), **faults(pid)}


def send(fd: int, value) -> None:
    data = json.dumps(value).encode()
    os.write(fd, len(data).to_bytes(4, "big") + data)


def receive(fd: int):
    def exact(count: int) -> bytes:
        data = b""
        while len(data) < count:
            chunk = os.read(fd, count - len(data))
            if not chunk:
                raise RuntimeError("Pipe closed unexpectedly")
            data += chunk
        return data
    return json.loads(exact(int.from_bytes(exact(4), "big")))


def read_pages(mapping: mmap.mmap, pages) -> None:
    for page in pages:
        mapping[page * PAGE_SIZE]


def write_pages(mapping: mmap.mmap, pages) -> None:
    for page in pages:
        mapping[page * PAGE_SIZE] = 7


def with_child(mapping: mmap.mmap, where: dict, script: list[str]) -> dict:
    """Fork; the child runs each command in script and samples itself after each one."""
    to_child_r, to_child_w = os.pipe()
    from_child_r, from_child_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(to_child_w)
        os.close(from_child_r)
        commands = {
            "sample": lambda: None,
            "read_first": lambda: read_pages(mapping, [0]),
            "read_all": lambda: read_pages(mapping, range(PAGES)),
            "write_first": lambda: write_pages(mapping, [0]),
        }
        while (command := receive(to_child_r)) != "quit":
            commands[command]()
            send(from_child_w, sample(os.getpid(), **where))
        os._exit(0)
    os.close(to_child_r)
    os.close(from_child_w)
    readings = {}
    try:
        for command in script:
            send(to_child_w, command)
            readings[f"child_after_{command}"] = receive(from_child_r)
            readings[f"parent_after_child_{command}"] = sample(os.getpid(), **where)
        send(to_child_w, "quit")
        _, status = os.waitpid(pid, 0)
        if os.waitstatus_to_exitcode(status) != 0:
            raise RuntimeError("Child failed")
    finally:
        os.close(to_child_w)
        os.close(from_child_r)
    return readings


def anonymous_private() -> dict:
    # PROT_NONE guard pages keep this VMA separate from Python's other anonymous mappings.
    mapping = mmap.mmap(-1, (PAGES + 2) * PAGE_SIZE, flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS)
    base = ctypes.addressof(ctypes.c_char.from_buffer(mapping))
    for guard in (base, base + (PAGES + 1) * PAGE_SIZE):
        if libc.mprotect(ctypes.c_void_p(guard), ctypes.c_size_t(PAGE_SIZE), 0) != 0:
            raise OSError(ctypes.get_errno(), "mprotect failed")
    view = memoryview(mapping)[PAGE_SIZE:(PAGES + 1) * PAGE_SIZE]
    where = {"address": base + PAGE_SIZE}

    class Pages:
        def __getitem__(self, offset): return view[offset]
        def __setitem__(self, offset, value): view[offset] = value

    pages = Pages()
    readings = {"after_mmap": sample(os.getpid(), **where)}
    read_pages(pages, range(PAGES))
    readings["after_parent_reads_untouched"] = sample(os.getpid(), **where)
    write_pages(pages, range(PAGES))
    readings["after_parent_writes_all"] = sample(os.getpid(), **where)
    readings.update(with_child(pages, where, ["sample", "write_first"]))
    view.release()
    mapping.close()
    return readings


def file_case(directory: str, name: str, *, shared: bool, writable: bool, parent_writes: bool, evict: bool) -> dict:
    path = os.path.join(directory, name)
    with open(path, "wb") as file:
        file.write(os.urandom(PAGES * PAGE_SIZE))
        file.flush()
        os.fsync(file.fileno())
    fd = os.open(path, os.O_RDWR)
    if evict:
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
    flags = mmap.MAP_SHARED if shared else mmap.MAP_PRIVATE
    prot = mmap.PROT_READ | (mmap.PROT_WRITE if writable else 0)
    mapping = mmap.mmap(fd, PAGES * PAGE_SIZE, flags=flags, prot=prot)
    os.close(fd)
    where = {"path": path}
    readings = {"after_mmap": sample(os.getpid(), **where)}
    read_pages(mapping, range(PAGES))
    readings["after_parent_reads_all"] = sample(os.getpid(), **where)
    if parent_writes:
        write_pages(mapping, [0])
        readings["after_parent_writes_first"] = sample(os.getpid(), **where)
    readings.update(with_child(mapping, where, ["sample", "read_first", "read_all"]))
    mapping.close()
    return readings


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="forkscape-residency-") as directory:
        cases = {
            "anonymous_private": anonymous_private(),
            "file_private_readonly_cold_cache": file_case(directory, "code.bin", shared=False, writable=False, parent_writes=False, evict=True),
            "file_private_parent_wrote_one_page": file_case(directory, "data.bin", shared=False, writable=True, parent_writes=True, evict=False),
            "file_shared": file_case(directory, "shared.bin", shared=True, writable=True, parent_writes=False, evict=False),
        }
    print(json.dumps({
        "schema_version": 1,
        "source": "reference_linux_vm",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "distribution": platform.freedesktop_os_release().get("PRETTY_NAME", "unknown"),
        "kernel": platform.release(),
        "page_size_bytes": PAGE_SIZE,
        "pages_per_mapping": PAGES,
        "cases": cases,
    }, indent=2))
