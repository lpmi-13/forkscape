"""Records a process tree's memory without root, from /proc snapshots, as a Forkscape recording's events.

Used by record_host_sampler.py and, inside a container, by sampled_entrypoint.py. It needs no root, capabilities, or eBPF:
a process may read /proc/<pid>/pagemap for processes that run as the same user, and an unprivileged container or
Kubernetes pod allows that. The sampler starts the workload as its child, so the workload and its descendants are the
sampler's own processes.

Each snapshot reads, for every process in the tree, its mappings (/proc/<pid>/maps), whether each page is resident,
file-backed, and mapped only by this process (/proc/<pid>/pagemap), its descriptors and threads, and smaps_rollup.
Comparing a snapshot with the one before gives the recording's events:
  - a new process is a fork (or a fork and an exec), timed from its start time; a vanished one is an exit and a reap;
  - a new or removed range in maps is an mmap or munmap; a resident page that disappears is a madvise(DONTNEED);
  - a page that becomes resident is a read fault (a file page, or the zero page for anonymous memory) or a write fault;
  - a page two processes shared that becomes exclusive is a copy-on-write fault. Both sides look exclusive afterwards,
    so the copy goes to the process whose minor-fault count rose more. The figures are the same whichever side copied.
The sampler keeps a model of what the replay will hold, and emits only what moves the replay to what /proc shows.

Snapshots run every `interval_ms` and whenever a marker asks for one (forkscape_markers.py waits on FORKSCAPE_SYNC), so a
process's changes land before its markers. Between two snapshots the order of events is inferred, and memory that is
allocated and freed between them is not seen. Without root, pagemap hides page frame numbers, so two processes that hold
copies of a page at the same address cannot be told from two that share one; the model's fork history decides.
"""

from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass, field, replace
import json
import os
from pathlib import Path
import platform
import secrets
import select
import signal
import socket
import time

from recording_file import PAGE, operating_system, read_markers, say

HERE = Path(__file__).resolve().parent
PRESENT, SWAPPED, FILE_PAGE, EXCLUSIVE = 1 << 63, 1 << 62, 1 << 61, 1 << 56
TOP = 0x800000000000  # Above this is the legacy vsyscall page, outside every process's own memory.
SPECIAL = ("[vdso]", "[vvar]", "[vvar_vclock]")
BLOCK = 512  # Pagemap entries compared at once before looking at each one.
ROLLUP = {"Rss": "rss_kib", "Pss": "pss_kib", "Pss_Anon": "pss_anon_kib", "Pss_File": "pss_file_kib", "Private_Dirty": "private_dirty_kib"}
FORWARDED = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT, signal.SIGTTIN, signal.SIGTTOU, signal.SIGUSR1, signal.SIGUSR2, signal.SIGWINCH)
TCP_STATES = {"0A": "listening socket", "01": "connection"}
SYNC_SOCKET = "forkscape sync"  # A marker waiting for a snapshot, which is not the workload's descriptor.


def monotonic_us() -> float:
    return time.monotonic_ns() / 1000


def hexa(value: int) -> str:
    return f"0x{value:x}"


# ——— What /proc shows ———

@dataclass(frozen=True)
class Area:
    """One line of /proc/<pid>/maps."""
    start: int
    end: int
    perms: str
    offset: int
    dev: str
    inode: int
    path: str

    @property
    def kind(self) -> str:
        """anon (private anonymous memory), shmem (shared anonymous memory), special ([vdso] and [vvar]), or file."""
        if self.path in SPECIAL:
            return "special"
        if self.path.startswith(("/dev/zero", "/SYSV")) and self.perms[3] == "s":
            return "shmem"
        return "file" if self.inode else "anon"

    @property
    def private(self) -> bool:
        return self.perms[3] == "p"

    def continues(self, other: "Area") -> bool:
        """Whether `other` maps the same memory at the same addresses, as a mapping that changed only its permissions does."""
        if self.kind != other.kind:
            return False
        if self.kind in ("file", "shmem"):
            return self.dev == other.dev and self.inode == other.inode and self.offset - self.start == other.offset - other.start
        return self.path == other.path and self.perms[3] == other.perms[3]

    def part(self, start: int, end: int) -> "Area":
        return replace(self, start=start, end=end, offset=self.offset + (start - self.start))


def parse_maps(text: str) -> list[Area]:
    areas = []
    for line in text.splitlines():
        fields = line.split(None, 5)
        if len(fields) < 5:
            continue
        start, end = (int(value, 16) for value in fields[0].split("-"))
        if start >= TOP:
            continue
        areas.append(Area(start, end, fields[1], int(fields[2], 16), fields[3], int(fields[4]), fields[5].strip() if len(fields) > 5 else ""))
    return areas


def observe(entry: int, area: Area) -> str:
    """A pagemap entry as A (not resident), C (a page-cache page), X (an anonymous page only this process maps), or S (an
    anonymous page shared with another process, or the zero page)."""
    if not entry & PRESENT:
        return "A"
    if area.kind in ("special", "shmem") or entry & FILE_PAGE:
        return "C"
    return "X" if entry & EXCLUSIVE else "S"


@dataclass
class Seen:
    """One process in one snapshot."""
    pid: int
    ppid: int
    start: int  # In clock ticks since boot, which with the PID identifies the process.
    comm: str
    minflt: int
    image: tuple  # Where exec put the stack and arguments, which changes when the process execs.
    at: float
    areas: list[Area]
    entries: dict[tuple[int, int], bytes]
    fds: dict[int, str] = field(default_factory=dict)
    tids: set[int] = field(default_factory=set)
    rollup: dict | None = None


def subtract(areas: list[Area], others: list[Area]) -> list[Area]:
    """The parts of `areas` that no area in `others` continues."""
    starts = [other.start for other in others]
    parts = []
    for area in areas:
        pieces = [(area.start, area.end)]
        index = max(0, bisect_right(starts, area.start) - 1)
        while index < len(others) and others[index].start < area.end:
            other = others[index]
            index += 1
            if other.end <= area.start or not area.continues(other):
                continue
            pieces = [piece for low, high in pieces for piece in ((low, min(high, other.start)), (max(low, other.end), high)) if piece[0] < piece[1]]
        parts += [area.part(low, high) for low, high in pieces]
    return parts


def area_at(areas: list[Area], address: int) -> Area | None:
    index = bisect_right([area.start for area in areas], address) - 1
    return areas[index] if index >= 0 and areas[index].end > address else None


def cover(areas: list[Area], others: list[Area]) -> list[Area]:
    """The parts of `areas` that some area in `others` continues."""
    missing = subtract(areas, others)
    return subtract(areas, missing) if missing else list(areas)


# ——— The model of what the replay holds ———

@dataclass
class Proc:
    pid: int
    ppid: int
    start: int
    comm: str
    image: tuple = ()
    areas: list[Area] = field(default_factory=list)
    pages: dict[int, object] = field(default_factory=dict)  # address -> "c" (page cache), "z" (zero page), or a frame number
    units: list[list] = field(default_factory=list)  # [start, end, writable] for each private file mapping the replay holds
    raw: dict[tuple[int, int], bytes] = field(default_factory=dict)
    fds: dict[int, tuple[str, str]] = field(default_factory=dict)  # fd -> (what it names, object id)
    tids: set[int] = field(default_factory=set)
    minflt: int = 0
    last: float = 0.0
    fresh: bool = True
    exited: bool = False
    reaped: bool = False



class Inference:
    """Turns snapshots into events. It keeps no I/O, so tests can feed it snapshots."""

    def __init__(self, skip_paths: tuple[str, ...] = ()):
        self.procs: dict[int, Proc] = {}
        self.frames: dict[int, set[tuple[int, int]]] = {}
        self.next_frame = 1
        self.events: list[dict] = []
        self.names: dict[int, str] = {}
        self.objects: dict[str, dict] = {}
        self.sequence = Counter()
        self.counts = Counter()
        self.skip_paths = set(skip_paths)
        self.previous = 0.0

    # ——— Events ———

    def emit(self, name: str, pid: int, ts: float, args: dict) -> dict:
        event = {"ph": "i", "name": name, "pid": pid, "tid": pid, "ts": round(ts, 3), "args": args}
        self.events.append(event)
        return event

    def new_frame(self, pid: int, address: int) -> int:
        number = self.next_frame
        self.next_frame += 1
        self.frames[number] = {(pid, address)}
        return number

    def release(self, pid: int, address: int, state) -> None:
        if isinstance(state, int):
            holders = self.frames.get(state)
            if holders is not None:
                holders.discard((pid, address))
                if not holders:
                    del self.frames[state]

    def fault(self, proc: Proc, address: int, write: bool, area: Area, ts: float) -> None:
        """A fault, and its effect as the replay applies it: a zero page or a new page for anonymous memory, the page cache
        for a file, or a private copy for a write to a private mapping."""
        self.emit("fault", proc.pid, ts, {"addr": hexa(address), "write": write})
        self.counts["fault"] += 1
        state = proc.pages.get(address)
        if area.kind == "anon":
            if not write:
                if state is None:
                    proc.pages[address] = "z"
                return
        elif not write or not area.private:
            if not isinstance(state, int):
                proc.pages[address] = "c"
            return
        self.release(proc.pid, address, state)
        proc.pages[address] = self.new_frame(proc.pid, address)

    def drop(self, proc: Proc, runs: list[tuple[int, int]], ts: float) -> None:
        """Pages that stopped being resident in a mapping that is still there, as madvise(MADV_DONTNEED) drops them."""
        for low, high in runs:
            self.emit("madvise", proc.pid, ts, {"addr": hexa(low), "len": high - low, "advice": "dontneed"})
            for address in range(low, high, PAGE):
                self.release(proc.pid, address, proc.pages.pop(address, None))

    def unmap(self, proc: Proc, low: int, high: int) -> None:
        for address in [address for address in proc.pages if low <= address < high]:
            self.release(proc.pid, address, proc.pages.pop(address))
        units = []
        for start, end, writable in proc.units:
            units += [[a, b, writable] for a, b in ((start, min(end, low)), (max(start, high), end)) if a < b]
        proc.units = units
        for key in [key for key in proc.raw if key[0] < high and key[1] > low]:
            del proc.raw[key]

    def forget(self, proc: Proc) -> None:
        for address, state in proc.pages.items():
            self.release(proc.pid, address, state)
        proc.pages, proc.units, proc.areas, proc.raw = {}, [], [], {}

    # ——— Processes ———

    def exec(self, pid: int, ts: float, comm: str, ppid: int = 0) -> Proc:
        """The recording's first process, once it has exec'd. Its first snapshot follows."""
        proc = Proc(pid, ppid, 0, comm, last=ts)
        self.procs[pid] = proc
        self.names[pid] = comm
        self.emit("exec", pid, ts, {"comm": comm, "ppid": ppid})
        self.previous = ts
        return proc

    def stamp(self, proc: Proc, seen: Seen, sync: dict[int, float]) -> float:
        """When this snapshot's changes to a process are placed: just before the marker that asked for it, if one did."""
        base = sync[proc.pid] - 1 if proc.pid in sync else seen.at
        return max(base, proc.last + 0.001)

    def fork(self, parent: Proc, seen: Seen, everything: dict[int, Seen], sync: dict[int, float], boot_offset_us: float, hz: int) -> Proc:
        child = Proc(seen.pid, parent.pid, seen.start, seen.comm, image=seen.image, minflt=0)
        late = max(self.stamp(child, seen, sync) - 0.002, parent.last + 0.002)
        began = seen.start * 1_000_000 / hz - boot_offset_us
        ts = min(max(began, parent.last + 0.002, self.previous + 0.002), late)
        # A child that has already exec'd shares no memory with its parent.
        inherited = {(area.inode, area.offset - area.start) for area in parent.areas if area.inode}
        files = [area for area in seen.areas if area.inode]
        execd = bool(files) and sum((area.inode, area.offset - area.start) in inherited for area in files) < len(files) / 2
        if not execd:
            self.before_fork(parent, seen, everything.get(parent.pid), ts - 0.001)
        self.emit("fork", parent.pid, ts, {"child": child.pid})
        parent.last = ts  # The parent's own changes in this snapshot come after the fork.
        self.counts["fork"] += 1
        self.procs[child.pid] = child
        self.names[child.pid] = seen.comm
        child.last = ts
        child.tids = {child.pid}
        child.fds = dict(parent.fds)
        if execd:
            self.emit("exec", child.pid, ts + 0.001, {"comm": seen.comm, "ppid": parent.pid})
            child.last = ts + 0.001
            return child
        # The replay copies a parent's page-table entries for private mappings that hold anonymous pages, as the kernel does
        # for mappings with an anon_vma; others fault back in from the page cache.
        child.areas = list(parent.areas)
        child.units = [list(unit) for unit in parent.units]
        holding = [any(isinstance(parent.pages.get(a), int) for a in range(unit[0], unit[1], PAGE)) for unit in parent.units]
        area_starts, unit_starts = [area.start for area in parent.areas], [unit[0] for unit in parent.units]
        for address, state in parent.pages.items():
            index = bisect_right(area_starts, address) - 1
            if index < 0 or parent.areas[index].end <= address:
                continue
            area = parent.areas[index]
            if not area.private:
                continue
            if area.kind == "anon":
                if state == "z" or isinstance(state, int):
                    child.pages[address] = state
            elif area.kind == "file":
                unit = bisect_right(unit_starts, address) - 1
                if unit >= 0 and parent.units[unit][1] > address and holding[unit]:
                    child.pages[address] = state
            if isinstance(state, int) and address in child.pages:
                self.frames[state].add((child.pid, address))
        return child

    def before_fork(self, parent: Proc, child: Seen, now: Seen | None, ts: float) -> None:
        """What the parent changed between its last snapshot and the fork, as the child's inherited memory shows it."""
        if now is None:
            return
        mapped = subtract(cover(child.areas, now.areas), parent.areas)
        gone = subtract(subtract(parent.areas, child.areas), now.areas)
        if mapped or gone:
            self.apply_areas(parent, subtract(parent.areas, gone) + mapped, ts, removed=gone, added=mapped, seen=child)
        for area in child.areas:
            raw = child.entries.get((area.start, area.end))
            if raw is None or area.kind not in ("anon", "file") or not area.private:
                continue
            values = memoryview(raw).cast("Q")
            for index, entry in enumerate(values):
                if not entry & PRESENT or entry & FILE_PAGE or entry & EXCLUSIVE:
                    continue
                address = area.start + index * PAGE
                # Shared with someone: the parent held this anonymous page at the fork, unless both map the zero page.
                state = parent.pages.get(address)
                if state is None or state == "c":
                    if area_at(parent.areas, address) is not None:
                        self.fault(parent, address, True, area, ts)

    # ——— Snapshots ———

    def step(self, seen: dict[int, Seen], exited: set[int], gone: set[int], sync: dict[int, float], *, at: float,
             socket_names: dict[str, str] | None = None, skip_sockets: set[str] = frozenset(),
             boot_offset_us: float = 0, hz: int = 100) -> None:
        """Applies one snapshot: `seen` has every live process in the tree, `exited` the zombies, and `gone` the processes
        that no longer exist, which their parent reaped."""
        socket_names = socket_names or {}
        for pid in sorted(exited | gone):
            proc = self.procs.get(pid)
            if proc and not proc.exited:
                ts = max(at, proc.last + 0.001)
                self.emit("exit", pid, ts, {})
                self.forget(proc)
                proc.exited, proc.last = True, ts
        new = sorted((item for item in seen.values() if item.pid not in self.procs or self.procs[item.pid].exited), key=lambda item: (item.start, item.pid))
        for item in new:
            parent = self.procs.get(item.ppid)
            if parent is None or parent.exited:
                continue
            self.fork(parent, item, seen, sync, boot_offset_us, hz)
        live = sorted((self.procs[pid] for pid in seen if pid in self.procs and not self.procs[pid].exited), key=lambda proc: (proc.start, proc.pid))
        stamps = {proc.pid: self.stamp(proc, seen[proc.pid], sync) for proc in live}
        for proc in live:
            item = seen[proc.pid]
            if proc.image and item.image != proc.image:
                self.emit("exec", proc.pid, stamps[proc.pid], {"comm": item.comm})
                self.forget(proc)
                proc.fresh = True
            proc.image = item.image
            if item.comm != self.names.get(proc.pid):
                self.names[proc.pid] = item.comm
            self.apply_areas(proc, item.areas, stamps[proc.pid], seen=item)
        candidates: dict[int, list[tuple[int, int, Area]]] = {}
        for proc in live:
            self.apply_pages(proc, seen[proc.pid], stamps[proc.pid], candidates)
        self.copies(candidates, seen, stamps)
        for proc in live:
            item = seen[proc.pid]
            self.apply_threads(proc, item, stamps[proc.pid])
            self.apply_fds(proc, item, stamps[proc.pid], socket_names, skip_sockets)
            proc.minflt = item.minflt
            proc.last = stamps[proc.pid]
            if item.rollup:
                self.events.append({"ph": "C", "name": "memory", "pid": proc.pid, "ts": round(item.at, 3), "args": item.rollup})
        for pid in sorted(gone):
            proc = self.procs.get(pid)
            if proc and proc.exited and not proc.reaped and pid not in seen:
                proc.reaped = True
                parent = self.procs.get(proc.ppid)
                if parent and not parent.exited:
                    self.emit("reap", parent.pid, max(at, proc.last + 0.001, parent.last + 0.001), {"child": pid})
        self.previous = max([at, *stamps.values()])

    def apply_areas(self, proc: Proc, areas: list[Area], ts: float, *, removed: list[Area] | None = None,
                    added: list[Area] | None = None, seen: Seen | None = None) -> None:
        removed = subtract(proc.areas, areas) if removed is None else removed
        added = subtract(areas, proc.areas) if added is None else added
        for area in removed:
            self.emit("munmap", proc.pid, ts, {"addr": hexa(area.start), "len": area.end - area.start})
            self.unmap(proc, area.start, area.end)
        for area in added:
            self.emit("mmap", proc.pid, ts, self.mmap_args(area, seen))
            self.counts["mmap"] += 1
            self.unmap(proc, area.start, area.end)
            if area.kind == "file" and area.private:
                proc.units.append([area.start, area.end, "w" in self.mmap_args(area, seen)["perms"]])
                proc.units.sort(key=lambda unit: unit[0])
        proc.areas = sorted(areas, key=lambda area: area.start)

    def mmap_args(self, area: Area, seen: Seen | None) -> dict:
        args = {"addr": hexa(area.start), "len": area.end - area.start, "perms": area.perms}
        if area.kind == "file":
            args.update(file=area.path, offset=area.offset)
            # A private file mapping already holding copies was writable when they were made (relocations, before
            # mprotect made the range read-only), so the replay should copy on write there too.
            if area.private and area.perms[1] != "w" and seen and self.holds_copies(area, seen):
                args["perms"] = area.perms[0] + "w" + area.perms[2:]
        elif area.kind == "special":
            args.update(file=area.path, name=area.path)
        elif area.kind == "shmem":
            args["name"] = "shared memory"
        elif area.path:
            args["name"] = area.path
        return args

    @staticmethod
    def holds_copies(area: Area, seen: Seen) -> bool:
        raw = seen.entries.get((area.start, area.end))
        if raw is None:
            for (start, end), value in seen.entries.items():
                if start <= area.start and area.end <= end:
                    first = (area.start - start) // PAGE * 8
                    raw = value[first:first + (area.end - area.start) // PAGE * 8]
                    break
        return bool(raw) and any(entry & PRESENT and not entry & FILE_PAGE for entry in memoryview(raw).cast("Q"))

    def apply_pages(self, proc: Proc, seen: Seen, ts: float, candidates: dict) -> None:
        drops: list[tuple[int, int]] = []
        for area in seen.areas:
            key = (area.start, area.end)
            raw = seen.entries.get(key)
            if raw is None:
                continue
            previous = None if proc.fresh else proc.raw.get(key)
            if previous == raw:
                continue
            values = memoryview(raw).cast("Q")
            before = memoryview(previous).cast("Q") if previous is not None and len(previous) == len(raw) else None
            for block in range(0, len(values), BLOCK):
                if before is not None and raw[block * 8:(block + BLOCK) * 8] == previous[block * 8:(block + BLOCK) * 8]:
                    continue
                for index in range(block, min(len(values), block + BLOCK)):
                    entry = values[index]
                    if before is not None and entry == before[index]:
                        continue
                    address = area.start + index * PAGE
                    self.transition(proc, address, proc.pages.get(address), observe(entry, area), area, ts, drops, candidates)
        if drops:
            self.drop(proc, merge_runs(drops), ts)
        proc.raw = dict(seen.entries)
        proc.fresh = False

    def transition(self, proc: Proc, address: int, state, seen: str, area: Area, ts: float, drops: list, candidates: dict) -> None:
        if seen == "A":
            if isinstance(state, int) or state == "c":
                drops.append((address, address + PAGE))
            elif state == "z":
                del proc.pages[address]
        elif seen == "C":
            if state == "c":
                return
            if isinstance(state, int):
                self.drop(proc, [(address, address + PAGE)], ts)
            self.fault(proc, address, False, area, ts)
        elif seen == "X":
            if isinstance(state, int):
                holders = self.frames.get(state, ())
                if len(holders) > 1:
                    candidates.setdefault(state, []).append((proc.pid, address, area))
                return
            self.fault(proc, address, True, area, ts)
        else:  # S: shared, or the zero page
            if isinstance(state, int) or state == "z":
                return
            # Not shared in the model: a read of untouched anonymous memory maps the zero page; elsewhere, a copy.
            self.fault(proc, address, state is not None or area.kind != "anon", area, ts)

    def copies(self, candidates: dict, seen: dict[int, Seen], stamps: dict[int, float]) -> None:
        """Pages that were shared and now look exclusive: someone copied. One write per holder beyond the last explains it."""
        for frame, wanting in candidates.items():
            holders = self.frames.get(frame, set())
            wanting = [item for item in wanting if (item[0], item[1]) in holders]

            def evidence(item):
                proc = self.procs[item[0]]
                return (seen[item[0]].minflt - proc.minflt, proc.start, item[0])

            wanting.sort(key=evidence)
            while len(self.frames.get(frame, ())) > 1 and wanting:
                pid, address, area = wanting.pop()
                self.fault(self.procs[pid], address, True, area, stamps[pid])
                self.counts["cow"] += 1

    def apply_threads(self, proc: Proc, seen: Seen, ts: float) -> None:
        for tid in sorted(seen.tids - proc.tids - {proc.pid}):
            self.emit("thread", proc.pid, ts, {"new_tid": tid})
        proc.tids |= seen.tids

    def apply_fds(self, proc: Proc, seen: Seen, ts: float, socket_names: dict[str, str], skip_sockets: set[str]) -> None:
        current = {fd: target for fd, target in seen.fds.items() if fd > 2 and target not in self.skip_paths and target not in skip_sockets
                   and socket_names.get(target) != SYNC_SOCKET}
        for fd in sorted(proc.fds):
            if current.get(fd) != proc.fds[fd][0]:
                self.emit("close", proc.pid, ts, {"fd": fd})
                del proc.fds[fd]
        for fd in sorted(current):
            if fd in proc.fds:
                continue
            target = current[fd]
            shared = target.startswith(("socket:[", "pipe:["))
            key = target if shared else f"{proc.pid}:{fd}:{target}:{self.counts['opens']}"
            self.counts["opens"] += 1
            item = self.objects.get(key)
            if item is None:
                label = "socket" if target.startswith("socket:[") else "pipe" if target.startswith("pipe:[") else "file"
                self.sequence[label] += 1
                name = socket_names.get(target, "socket") if label == "socket" else target
                item = {"id": f"{label}#{self.sequence[label]}", "kind": "socket" if label == "socket" else "file", "name": name, "opens": [], "target": target}
                self.objects[key] = item
            proc.fds[fd] = (target, item["id"])
            item["opens"].append(self.emit("open", proc.pid, ts, {"fd": fd, "object": item["id"], "kind": item["kind"], "name": item["name"]}))

    def name_sockets(self, socket_names: dict[str, str]) -> None:
        """A socket is named by what it ends as, such as a listening socket, though it was seen before it listened."""
        for item in self.objects.values():
            name = socket_names.get(item["target"])
            if item["kind"] == "socket" and name and name != item["name"]:
                for event in item["opens"]:
                    event["args"]["name"] = name


def merge_runs(runs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[list[int]] = []
    for low, high in sorted(runs):
        if merged and merged[-1][1] == low:
            merged[-1][1] = high
        else:
            merged.append([low, high])
    return [(low, high) for low, high in merged]


# ——— Reading /proc and running the workload ———

@dataclass
class Sampled:
    events: list[dict]
    names: dict[int, str]
    counts: dict[str, int]
    source: str
    config: dict
    stage_gap_ms: float

    def summary(self) -> str:
        """A sentence for the recording's notes."""
        counts = self.counts
        return (f"Inferred from {counts.get('snapshots', 0):,} snapshots, {counts.get('synced', 0):,} of them at markers: "
                f"{counts.get('fault', 0):,} faults ({counts.get('cow', 0):,} copy-on-write), {counts.get('mmap', 0):,} mappings, "
                f"{counts.get('fork', 0):,} forks.")


class Sampler:
    """Runs a command as its child and snapshots the command's process tree until the command exits."""

    def __init__(self, interval_ms: float = 100, cgroup: Path | None = None, markers: Path | None = None):
        self.interval = interval_ms / 1000
        self.interval_ms = interval_ms
        self.cgroup = cgroup
        self.markers = Path(markers) if markers else Path(f"/tmp/forkscape-markers-{os.getpid()}.ndjson")
        self.markers.write_text("")
        self.inference = Inference(skip_paths=(str(self.markers.resolve()),))
        self.channel_name = f"forkscape-{os.getpid()}-{secrets.token_hex(4)}"
        self.channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC)
        self.channel.bind("\0" + self.channel_name)
        self.channel.listen(64)
        self.hz = os.sysconf("SC_CLK_TCK")
        self.boot_offset_us = (time.clock_gettime_ns(time.CLOCK_BOOTTIME) - time.monotonic_ns()) / 1000
        self.root = 0
        self.code: int | None = None
        self.snapshots = Counter()
        self.socket_names: dict[str, str] = {}
        self.children_files = True
        self.limit: int | None = None

    def launch(self, command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> int:
        """Starts the command, which is recorded from its exec. Returns its PID."""
        environment = dict(os.environ)
        environment.update(env or {})
        environment["FORKSCAPE_MARKERS"] = str(self.markers)
        environment["FORKSCAPE_SYNC"] = self.channel_name
        environment["PYTHONPATH"] = os.pathsep.join(filter(None, [str(HERE), environment.get("PYTHONPATH")]))
        failed, report = os.pipe2(os.O_CLOEXEC)
        pid = os.fork()
        if pid == 0:
            try:
                os.close(failed)
                if cwd:
                    os.chdir(cwd)
                os.execvpe(command[0], command, environment)
            except BaseException as error:  # noqa: BLE001 - report anything, then leave without running Python cleanup twice
                os.write(report, str(error).encode())
            os._exit(127)
        os.close(report)
        problem = os.read(failed, 4096)  # The pipe closes on a successful exec, or carries why it failed.
        os.close(failed)
        if problem:
            raise SystemExit(f"forkscape: could not start {command[0]}: {problem.decode()}")
        self.root = pid
        self.started = time.time()
        self.config = {"command": " ".join(command)[:200], "snapshot_every_ms": self.interval_ms, "uid": os.getuid()}
        if self.cgroup:
            try:
                limit = (self.cgroup / "memory.max").read_text().strip()
                self.limit = int(limit) if limit.isdigit() else None
                self.config["cgroup"] = f"memory.max {limit}"
            except OSError:
                self.cgroup = None
        comm = Path(f"/proc/{pid}/comm").read_text().strip() if Path(f"/proc/{pid}/comm").exists() else Path(command[0]).name
        self.inference.exec(pid, monotonic_us(), comm)
        if self.limit:
            self.inference.events.append({"ph": "i", "name": "limit", "pid": 0, "ts": monotonic_us(), "args": {"bytes": self.limit}})
        self.snapshot([])
        return pid

    def run(self, forward_signals: bool = True) -> int:
        """Snapshots until the command exits, then returns its exit code. Signals the sampler gets go to the command."""
        if forward_signals:
            for number in FORWARDED:
                signal.signal(number, lambda received, _frame: self._forward(received))
        due = time.monotonic() + self.interval
        while self.code is None:
            self._reap()
            if self.code is not None:
                break
            select.select([self.channel], [], [], max(0.0, due - time.monotonic()))
            requests = self._accept()
            started = time.monotonic()
            self.snapshot(requests)
            if not requests or started >= due:
                due = started + self.interval
        self.snapshot([])
        return self.code

    def finish(self) -> Sampled:
        self.inference.name_sockets(self.socket_names)
        markers = read_markers(self.markers)
        try:
            self.markers.unlink()
        except OSError:
            pass
        events = self.inference.events + markers
        counts = dict(self.inference.counts, markers=len(markers), snapshots=self.snapshots["all"], synced=self.snapshots["synced"])
        self.config["exit_code"] = self.code
        source = (f"pagemap snapshots every {self.interval_ms:g} ms and at markers, as uid {os.getuid()}, Python {platform.python_version()} "
                  f"on {operating_system()}, Linux {platform.release()}")
        return Sampled(events, dict(self.inference.names), counts, source, self.config, max(50.0, 2.5 * self.interval_ms))

    def _forward(self, number: int) -> None:
        if self.root and self.code is None:
            try:
                os.kill(self.root, number)
            except ProcessLookupError:
                pass

    def _reap(self) -> None:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return
            if pid == self.root:
                self.code = os.waitstatus_to_exitcode(status)

    def _accept(self) -> list[tuple[socket.socket, dict]]:
        """Every marker waiting for a snapshot; one snapshot answers them all."""
        requests = []
        self.channel.setblocking(False)
        try:
            while True:
                try:
                    connection, _ = self.channel.accept()
                except BlockingIOError:
                    break
                connection.settimeout(1)
                try:
                    message = json.loads(connection.recv(4096).decode())
                except (OSError, ValueError):
                    connection.close()
                    continue
                requests.append((connection, message))
        finally:
            self.channel.setblocking(True)
        return requests

    def snapshot(self, requests: list[tuple[socket.socket, dict]]) -> None:
        at = monotonic_us()
        sync = {int(message["pid"]): float(message["ts"]) for _, message in requests if "pid" in message and "ts" in message}
        skip = {f"socket:[{message['socket']}]" for _, message in requests if message.get("socket")}
        seen, exited, gone = {}, set(), set()
        for pid in self._tree():
            item = self._read(pid)
            if item == "zombie":
                exited.add(pid)
            elif item is None:
                gone.add(pid)
            else:
                seen[pid] = item
        for pid, proc in self.inference.procs.items():
            if proc.exited and not proc.reaped and pid not in exited and not self._zombie(pid, proc.start):
                gone.add(pid)
        self._name_sockets(seen)
        self.inference.step(seen, exited, gone, sync, at=at, socket_names=self.socket_names, skip_sockets=skip,
                            boot_offset_us=self.boot_offset_us, hz=self.hz)
        if self.cgroup:
            try:
                current = int((self.cgroup / "memory.current").read_text())
                self.inference.events.append({"ph": "C", "name": "cgroup", "pid": 0, "ts": round(at, 3), "args": {"memory_current_kib": current // 1024}})
            except (OSError, ValueError):
                pass
        self.snapshots["all"] += 1
        self.snapshots["synced"] += bool(requests)
        for connection, _ in requests:
            try:
                connection.sendall(b"k")
            except OSError:
                pass
            connection.close()

    def _tree(self) -> list[int]:
        """The live processes descended from the command, including any new since the last snapshot."""
        known = [pid for pid, proc in self.inference.procs.items() if not proc.exited]
        found, queue = set(known), list(known)
        if self.children_files:
            while queue:
                pid = queue.pop()
                try:
                    tasks = os.listdir(f"/proc/{pid}/task")
                except OSError:
                    continue
                for tid in tasks:
                    try:
                        children = Path(f"/proc/{pid}/task/{tid}/children").read_text().split()
                    except FileNotFoundError:
                        self.children_files = False
                        return self._tree()
                    except OSError:
                        continue
                    for child in map(int, children):
                        if child not in found:
                            found.add(child)
                            queue.append(child)
            return sorted(found)
        parents = {}
        for name in os.listdir("/proc"):
            if name.isdigit():
                try:
                    parents[int(name)] = int(Path(f"/proc/{name}/stat").read_text().rsplit(")", 1)[1].split()[1])
                except (OSError, IndexError, ValueError):
                    continue
        changed = True
        while changed:
            changed = False
            for pid, ppid in parents.items():
                if ppid in found and pid not in found:
                    found.add(pid)
                    changed = True
        return sorted(found)

    @staticmethod
    def _zombie(pid: int, start: int) -> bool:
        """Whether an exited process is still there to be reaped."""
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            return False
        return fields[0] in ("Z", "X") and (not start or int(fields[19]) == start)

    def _read(self, pid: int) -> "Seen | str | None":
        """A live process's snapshot, "zombie" for one that exited and waits to be reaped, or None if it is gone."""
        try:
            text = Path(f"/proc/{pid}/stat").read_text()
            comm = text[text.index("(") + 1:text.rindex(")")]
            fields = text[text.rindex(")") + 2:].split()
            start = int(fields[19])
            known = self.inference.procs.get(pid)
            if known and known.start and known.start != start and not known.exited:
                return None  # The PID was reused.
            if fields[0] in ("Z", "X"):
                return "zombie"
            at = monotonic_us()
            areas = parse_maps(Path(f"/proc/{pid}/maps").read_text())
            entries = {}
            descriptor = os.open(f"/proc/{pid}/pagemap", os.O_RDONLY | os.O_CLOEXEC)
            try:
                for area in areas:
                    if area.perms[:3] == "---":
                        continue
                    size = (area.end - area.start) // PAGE * 8
                    chunks, offset = [], area.start // PAGE * 8
                    while size:
                        chunk = os.pread(descriptor, min(size, 1 << 22), offset)
                        if not chunk:
                            break
                        chunks.append(chunk)
                        size -= len(chunk)
                        offset += len(chunk)
                    entries[(area.start, area.end)] = b"".join(chunks).ljust((area.end - area.start) // PAGE * 8, b"\0")
            finally:
                os.close(descriptor)
            item = Seen(pid, int(fields[1]), start, comm, int(fields[7]), (int(fields[25]), int(fields[45]), int(fields[47])), at, areas, entries)
            for name in os.listdir(f"/proc/{pid}/fd"):
                try:
                    item.fds[int(name)] = os.readlink(f"/proc/{pid}/fd/{name}")
                except OSError:
                    continue
            item.tids = {int(tid) for tid in os.listdir(f"/proc/{pid}/task")}
            item.rollup = self._rollup(pid)
            if known and not known.start:
                known.start = start
            return item
        except (OSError, ValueError, IndexError):
            return None

    @staticmethod
    def _rollup(pid: int) -> dict | None:
        values = {}
        try:
            with open(f"/proc/{pid}/smaps_rollup", encoding="ascii") as rollup:
                for line in rollup:
                    key, _, rest = line.partition(":")
                    if key in ROLLUP:
                        values[ROLLUP[key]] = int(rest.split()[0])
        except (OSError, ValueError, IndexError):
            return None
        return values or None

    def _name_sockets(self, seen: dict[int, Seen]) -> None:
        """Names sockets from the network tables of the command's network namespace: a listening TCP socket by its port."""
        wanted = {target for item in seen.values() for target in item.fds.values()
                  if target.startswith("socket:[") and self.socket_names.get(target, "socket") == "socket"}
        if not wanted or not self.root:
            return
        base = Path(f"/proc/{self.root}/net") if Path(f"/proc/{self.root}/net").exists() else Path("/proc/net")
        for table in ("tcp", "tcp6", "udp", "udp6"):
            try:
                lines = (base / table).read_text().splitlines()[1:]
            except OSError:
                continue
            for line in lines:
                fields = line.split()
                if len(fields) < 10 or f"socket:[{fields[9]}]" not in wanted:
                    continue
                port = int(fields[1].rsplit(":", 1)[1], 16)
                state = TCP_STATES.get(fields[3]) if table.startswith("tcp") else None
                name = (f"listening socket :{port}" if state == "listening socket" else f"connection on :{port}" if state else "socket")
                self.socket_names[f"socket:[{fields[9]}]"] = name
        try:
            for line in (base / "unix").read_text().splitlines()[1:]:
                fields = line.split()
                if len(fields) >= 7 and f"socket:[{fields[6]}]" in wanted:
                    ours = len(fields) >= 8 and fields[7].startswith(f"@{self.channel_name}")
                    self.socket_names[f"socket:[{fields[6]}]"] = SYNC_SOCKET if ours else "unix socket"
        except OSError:
            pass
