"""Traces a process tree's memory events with bpftrace and turns them into a Forkscape recording's events.

Used by record_host_bpftrace.py and record_container_bpftrace.py. It needs root, bpftrace 0.20 or later, and a Linux kernel
with BTF on x86-64, and it runs on the host: bpftrace cannot attach probes from an unprivileged container.

Two ways to choose what is traced, from the exec that starts it until it exits, with every process it forks:
  - Tracer.run() forks a command, holds it until every probe is attached, and lets it exec. The command runs as the user
    who ran sudo, optionally in a cgroup of its own.
  - Tracer.watch_container() attaches first and then waits for the first exec in a task with a given hostname, which is a
    container's entrypoint when the container is started with that --hostname. PIDs are translated to the container's own,
    which are the PIDs its processes write in their markers.

While the tree runs, smaps_rollup is read for each process (and memory.current for its cgroup), so the recording also
carries measured RSS and PSS to compare with the replay.
"""

from dataclasses import dataclass, field
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time

from recording_file import PAGE, operating_system, read_markers, say

HERE = Path(__file__).resolve().parent
STACK_BYTES = 8 * 1024 * 1024
CLONE_VM = 0x100
VM_READ, VM_WRITE, VM_EXEC, VM_MAYSHARE = 0x1, 0x2, 0x4, 0x80
ADVICE = {4: "dontneed", 8: "free", 9: "remove"}
ROLLUP = {"Rss": "rss_kib", "Pss": "pss_kib", "Pss_Anon": "pss_anon_kib", "Pss_File": "pss_file_kib", "Private_Dirty": "private_dirty_kib"}
CGROUP_ROOT = Path("/sys/fs/cgroup")

# Kernel functions the program traces, what is lost without each, and whether recording can go on without it.
KFUNCS = {
    "mmap_region": ("mappings", True),
    "do_brk_flags": ("the bss mapped at exec (brk growth still comes from the brk system call)", False),
    "do_set_pte": ("fault-around, the pages a file fault maps around it", False),
    "release_task": ("reaps, so exited workers are removed as they exit", False),
    "fd_install": ("descriptors", False),
    "security_file_open": ("full paths of mapped and opened files (names come from the file alone)", False),
    "inet_listen": ("the port of a listening socket", False),
    "wake_up_new_task": ("a container's own PIDs (its processes keep their host PIDs, which its markers do not use)", False),
}


def page_up(value: int) -> int:
    return -(-value // PAGE) * PAGE


def page_down(value: int) -> int:
    return value - value % PAGE


def hexa(value: int) -> str:
    return f"0x{value:x}"


def available(name: str) -> bool:
    try:
        with open("/sys/kernel/tracing/available_filter_functions", encoding="ascii") as functions:
            return any(line.split(" ", 1)[0].strip() == name for line in functions)
    except OSError:
        return False


def program() -> tuple[str, list[str]]:
    """The bpftrace program for this kernel, and what it cannot record here."""
    text = (HERE / "forkscape.bt").read_text()
    if not available("do_set_pte") and available("set_pte_range"):
        text = re.sub(r"kfunc:do_set_pte\n.*?\n}\n", "kfunc:set_pte_range\n/@t[pid]/\n{\n"
                      "  printf(\"A\\t%llu\\t%d\\t%lx\\t%u\\t%lx\\n\", nsecs, pid, args->addr, args->nr, args->vmf->address);\n}\n",
                      text, flags=re.S)
    missing = []
    for name, (what, required) in KFUNCS.items():
        if name == "do_set_pte" and "kfunc:set_pte_range" in text:
            name = "set_pte_range"
        if available(name):
            continue
        if required:
            raise SystemExit(f"forkscape: this kernel cannot trace {name}, which recording {what} needs")
        text = re.sub(rf"kr?etfunc:{name}\n.*?\n}}\n|kfunc:{name}\n.*?\n}}\n", "", text, flags=re.S)
        missing.append(what)
    return text, missing


@dataclass
class Traced:
    """What a finished trace produced: events with the PIDs the workload sees, names by PID, and counts for the notes."""
    events: list[dict]
    names: dict[int, str]
    counts: dict[str, int]
    missing: list[str]
    source: str
    config: dict = field(default_factory=dict)

    def summary(self) -> str:
        """A sentence for the recording's notes."""
        counts = self.counts
        return " ".join([f"{counts['fault']:,} faults, {counts['around']:,} pages mapped by fault-around, {counts['mmap']:,} mappings, "
                         f"{counts['fork']:,} forks, {counts['lost']:,} events lost.", *(f"This kernel could not trace {what}." for what in self.missing)])


class Tracer:
    """Runs bpftrace, samples memory while the traced tree runs, and converts what bpftrace prints."""

    def __init__(self, sample_ms: float = 50):
        if os.geteuid() != 0:
            raise SystemExit("forkscape: bpftrace needs root: run this with sudo")
        if not shutil.which("bpftrace"):
            raise SystemExit("forkscape: bpftrace is not installed (apt install bpftrace)")
        if not Path("/sys/kernel/btf/vmlinux").exists():
            raise SystemExit("forkscape: this kernel has no BTF (/sys/kernel/btf/vmlinux), which the probes need")
        self.sample_ms = sample_ms
        self.directory = Path(tempfile.mkdtemp(prefix="forkscape-trace-"))
        os.chmod(self.directory, 0o755)
        self.markers = self.directory / "markers.ndjson"
        self.markers.touch()
        os.chmod(self.markers, 0o666)
        self.markers_seen_as = str(self.markers)
        self.raw: list[str] = []
        self.errors: list[str] = []
        self.lost: list[tuple[int, int]] = []
        self.samples: list[dict] = []
        self.live: set[int] = set()
        self.synced, self.rooted, self.ended, self.done = threading.Event(), threading.Event(), threading.Event(), threading.Event()
        self.root: int | None = None
        self.root_code: int | None = None
        self.cgroup: Path | None = None
        self.own_cgroup = False
        self.memory_max: int | None = None
        self.child = 0
        self.config: dict = {}

    # ——— Choosing what is traced ———

    def run(self, command: list[str], *, cwd: Path, env: dict[str, str] | None = None, user: str | None = None,
            cgroup: bool = False, memory_max: int | None = None) -> int:
        """Starts `command` traced from its exec, as `user` (default: the user who ran sudo). Returns its PID."""
        account = self._account(user or os.environ.get("SUDO_USER"))
        environment = {key: value for key, value in os.environ.items() if not key.startswith("SUDO_")}
        if account:
            environment.update(HOME=account.pw_dir, USER=account.pw_name, LOGNAME=account.pw_name)
        environment.update(env or {})
        environment["FORKSCAPE_MARKERS"] = str(self.markers)
        environment["PYTHONPATH"] = os.pathsep.join(filter(None, [str(HERE), environment.get("PYTHONPATH")]))
        executable = shutil.which(command[0], path=environment.get("PATH")) or command[0]
        if not os.access(executable, os.X_OK):
            raise SystemExit(f"forkscape: cannot run {command[0]}")
        if cgroup:
            self._make_cgroup(memory_max)
        ready, release = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(release)
                if self.cgroup:
                    (self.cgroup / "cgroup.procs").write_text("0")
                if account:
                    os.initgroups(account.pw_name, account.pw_gid)
                    os.setgid(account.pw_gid)
                    os.setuid(account.pw_uid)
                os.chdir(cwd)
                if os.read(ready, 1) != b"g":
                    os._exit(0)
                os.execve(executable, command, environment)
            except BaseException as error:  # noqa: BLE001 - report anything, then leave without running Python cleanup twice
                print(f"forkscape: could not start {command[0]}: {error}", flush=True)
            os._exit(127)
        os.close(ready)
        self.child = pid
        self.config["command"] = " ".join(command)[:200]
        self._start_bpftrace(str(pid), "")
        os.write(release, b"g")
        os.close(release)
        return pid

    def watch_container(self, hostname: str, markers_seen_as: str) -> None:
        """Attaches, then traces the first process to exec with this hostname: start the container with --hostname after this.

        `markers_seen_as` is where the container sees the markers file, which is bind-mounted from `self.markers`.
        """
        self.markers_seen_as = markers_seen_as
        self.config["container_hostname"] = hostname
        self._start_bpftrace("0", hostname)

    def wait_for_root(self, timeout: float = 120) -> int:
        """The traced tree's first process, as a host PID, once it has exec'd."""
        if not self.rooted.wait(timeout):
            raise SystemExit("forkscape: nothing exec'd with that hostname")
        if self.cgroup is None and self.root:
            self._find_cgroup(self.root)
        return self.root

    def wait(self, timeout: float | None = None) -> int | None:
        """Waits for the traced tree's first process to exit and returns its exit code."""
        if self.child:
            _, status = os.waitpid(self.child, 0)
            self.root_code = os.waitstatus_to_exitcode(status)
        elif not self.ended.wait(timeout):
            return None
        return self.root_code

    # ——— Tracing ———

    def _account(self, name: str | None) -> pwd.struct_passwd | None:
        if not name or name == "root":
            return None
        try:
            return pwd.getpwnam(name)
        except KeyError:
            raise SystemExit(f"forkscape: there is no user {name}")

    def _make_cgroup(self, memory_max: int | None) -> None:
        if not (CGROUP_ROOT / "cgroup.controllers").exists():
            raise SystemExit("forkscape: a cgroup needs cgroup v2 at /sys/fs/cgroup")
        if "memory" not in (CGROUP_ROOT / "cgroup.subtree_control").read_text().split():
            (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory")
        self.cgroup = CGROUP_ROOT / f"forkscape-{os.getpid()}"
        self.cgroup.mkdir()
        self.own_cgroup = True
        if memory_max:
            (self.cgroup / "memory.max").write_text(str(memory_max))
            self.memory_max = memory_max
        self.config["cgroup"] = f"memory.max {memory_max}" if memory_max else "own cgroup, no limit"

    def _find_cgroup(self, pid: int) -> None:
        """A container's cgroup, as its runtime made it, and the memory limit it set."""
        try:
            relative = Path(f"/proc/{pid}/cgroup").read_text().strip().split("::", 1)[1]
            cgroup = CGROUP_ROOT / relative.lstrip("/")
            limit = (cgroup / "memory.max").read_text().strip()
        except (OSError, IndexError):
            return
        self.cgroup = cgroup
        self.memory_max = int(limit) if limit.isdigit() else None
        self.config["cgroup"] = f"the container's, memory.max {limit}"

    def _start_bpftrace(self, root: str, hostname: str) -> None:
        text, self.missing = program()
        self.brk_growth = "kfunc:do_brk_flags" not in text
        script = self.directory / "forkscape.bt"
        script.write_text(text)
        for what in self.missing:
            say(f"this kernel cannot trace it, so the recording leaves out {what}")
        env = {**os.environ, "BPFTRACE_MAX_STRLEN": "200", "BPFTRACE_STRLEN": "200", "BPFTRACE_PERF_RB_PAGES": "4096"}
        self.tracer = subprocess.Popen(["bpftrace", "-B", "line", str(script), root, str(os.getpid()), hostname],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, bufsize=1)
        self.readers = [threading.Thread(target=self._read_output, args=(self.tracer.stdout,), daemon=True),
                        threading.Thread(target=self._read_errors, args=(self.tracer.stderr,), daemon=True)]
        for reader in self.readers:
            reader.start()
        deadline = time.monotonic() + 120
        while not self.synced.is_set():
            if self.tracer.poll() is not None or time.monotonic() > deadline:
                if self.child:
                    os.kill(self.child, signal.SIGKILL)
                    os.waitpid(self.child, 0)
                time.sleep(0.2)
                raise SystemExit("forkscape: bpftrace did not start:\n" + "\n".join(self.errors[-20:]))
            os.getppid()
            self.synced.wait(0.05)
        time.sleep(0.25)  # Probes attach in order and the sync probe is last; this covers any stragglers.
        self.started = time.time()
        self.sampler = threading.Thread(target=self._sample, daemon=True)
        if self.sample_ms > 0:
            self.sampler.start()

    def _read_output(self, stream) -> None:
        for line in stream:
            self.raw.append(line)
            kind = line[:2].rstrip("\t\n")
            if kind == "S":
                self.synced.set()
            elif kind == "B" and self.root is None:
                self.root = int(line.split("\t", 3)[2])
            elif kind == "X":
                pid = int(line.split("\t", 3)[2])
                self.live.add(pid)
                if pid == self.root:
                    self.rooted.set()
            elif kind == "F":
                self.live.add(int(line.split("\t", 5)[4]))
            elif kind == "E":
                fields = line.split("\t")
                self.live.discard(int(fields[2]))
                if int(fields[2]) == self.root:
                    self.root_code = int(fields[3]) >> 8
                    self.ended.set()
            elif "Lost" in line:
                self._note_lost(line)

    def _read_errors(self, stream) -> None:
        for line in stream:
            if "Lost" in line:
                self._note_lost(line)
            elif "BPFTRACE_STRLEN" not in line:
                self.errors.append(line.rstrip())

    def _note_lost(self, line: str) -> None:
        found = re.search(r"Lost (\d+) events", line)
        if found:
            self.lost.append((time.monotonic_ns(), int(found.group(1))))

    def _sample(self) -> None:
        interval = self.sample_ms / 1000
        while not self.done.wait(interval):
            for pid in sorted(self.live):
                values = {}
                try:
                    with open(f"/proc/{pid}/smaps_rollup", encoding="ascii") as rollup:
                        stamp = time.monotonic_ns()
                        for line in rollup:
                            key, _, rest = line.partition(":")
                            if key in ROLLUP:
                                values[ROLLUP[key]] = int(rest.split()[0])
                except (OSError, ValueError, IndexError):
                    continue
                if "rss_kib" in values:
                    self.samples.append({"ph": "C", "name": "memory", "pid": pid, "ts": stamp / 1000, "args": values})
            if self.cgroup:
                try:
                    current = int((self.cgroup / "memory.current").read_text())
                    self.samples.append({"ph": "C", "name": "cgroup", "pid": 0, "ts": time.monotonic_ns() / 1000,
                                         "args": {"memory_current_kib": current // 1024}})
                except (OSError, ValueError):
                    pass

    def problems(self) -> list[str]:
        """bpftrace's errors, without its compile warnings and their context lines, which it prints even when all is well."""
        kept, skip = [], 0
        for line in self.errors:
            if "WARNING:" in line:
                skip = 2
            elif skip:
                skip -= 1
            elif line.strip() and not line.startswith("Attach"):
                kept.append(line)
        return kept

    # ——— Finishing ———

    def finish(self, keep_raw: Path | None = None) -> Traced:
        """Stops bpftrace and returns the trace's events, with markers and measurements merged in."""
        time.sleep(0.5)  # Let the last exits and reaps reach bpftrace's buffers.
        self.done.set()
        self.tracer.send_signal(signal.SIGINT)
        try:
            self.tracer.wait(timeout=60)
        except subprocess.TimeoutExpired:
            self.tracer.kill()
        for reader in self.readers:
            reader.join(timeout=10)
        if self.sampler.is_alive():
            self.sampler.join(timeout=5)
        if self.own_cgroup:
            try:
                self.cgroup.rmdir()
            except OSError:
                pass
        if keep_raw:
            Path(keep_raw).write_text("".join(self.raw))
        if self.root is None:
            raise SystemExit("forkscape: nothing was traced")
        events, names, counts = convert(self.raw, self.root, self.markers_seen_as, brk_growth=self.brk_growth)
        counts["lost"] = sum(count for _, count in self.lost)
        events += [{"ph": "i", "name": "lost", "pid": 0, "ts": stamp / 1000, "args": {"count": count}} for stamp, count in self.lost]
        if self.memory_max and events:
            events.append({"ph": "i", "name": "limit", "pid": 0, "ts": events[0]["ts"], "args": {"bytes": self.memory_max}})
        events += self.samples
        mapping = namespace_pids(self.raw)
        events, names = translate(events, names, mapping)
        if any(host != own for host, own in mapping.items()):
            self.config["pids"] = "the container's own"
        markers = read_markers(self.markers)
        counts["markers"] = len(markers)
        events += markers
        shutil.rmtree(self.directory, ignore_errors=True)
        for line in self.problems()[-10:]:
            say(f"bpftrace: {line}")
        tool = subprocess.run(["bpftrace", "--version"], capture_output=True, text=True).stdout.strip()
        self.config["smaps_rollup_every_ms"] = self.sample_ms
        if self.root_code is not None:
            self.config["exit_code"] = self.root_code
        return Traced(events, names, counts, self.missing, f"{tool} on {operating_system()}, Linux {platform.release()}", self.config)


def namespace_pids(raw: list[str]) -> dict[int, int]:
    """Each traced task's host PID or TID, mapped to the one it has in its own PID namespace, from the NS records."""
    mapping = {}
    for line in raw:
        if line.startswith("NS\t"):
            fields = line.rstrip("\n").split("\t")
            if len(fields) >= 4:
                mapping[int(fields[2])] = int(fields[3])
    return mapping


def translate(events: list[dict], names: dict[int, str], mapping: dict[int, int]) -> tuple[list[dict], dict[int, str]]:
    """Rewrites host PIDs and TIDs as the workload's own, so they match its markers. Unknown IDs are kept."""
    if all(host == own for host, own in mapping.items()):
        return events, names
    for event in events:
        if event.get("pid"):
            event["pid"] = mapping.get(event["pid"], event["pid"])
        if isinstance(event.get("tid"), int):
            event["tid"] = mapping.get(event["tid"], event["tid"])
        args = event.get("args") or {}
        for key in ("child", "new_tid"):
            if isinstance(args.get(key), int):
                args[key] = mapping.get(args[key], args[key])
        if event["name"] == "exec" and isinstance(args.get("ppid"), int):
            args["ppid"] = mapping.get(args["ppid"], 0)
    return events, {mapping.get(pid, pid): name for pid, name in names.items()}


def convert(raw: list[str], root: int, markers_path: str, brk_growth: bool = False) -> tuple[list[dict], dict[int, str], dict[str, int]]:
    """Turns bpftrace's records into Forkscape events, in time order. brk_growth takes heap growth from the brk system call,
    for kernels where do_brk_flags cannot be traced."""
    records, paths, listening = [], {}, {}
    for line in raw:
        fields = line.rstrip("\n").split("\t")
        if len(fields) < 2 or not fields[1].isdigit():
            continue
        if fields[0] == "P" and len(fields) >= 5:
            paths[(fields[2], fields[3])] = fields[4]
        elif fields[0] == "L" and len(fields) >= 5:
            listening[fields[3]] = fields[4]
        records.append((int(fields[1]), fields))
    records.sort(key=lambda record: record[0])

    out: list[dict] = []
    names: dict[int, str] = {}
    counts = {"fault": 0, "around": 0, "mmap": 0, "fork": 0}
    tracked: set[int] = set()
    pending: dict[int, dict] = {}
    descriptors: dict[int, dict[int, dict]] = {}
    objects: dict[str, dict] = {}
    skipped_fds: set[tuple[int, int]] = set()
    oom: set[int] = set()
    sequence = {"file": 0, "socket": 0, "pipe": 0}

    def emit(name: str, pid: int, ns: int, args: dict, tid: int | None = None) -> dict:
        event = {"ph": "i", "name": name, "pid": pid, "tid": tid or pid, "ts": ns / 1000, "args": args}
        if pid in pending:
            pending[pid]["events"].append(event)
        elif pid in tracked:
            out.append(event)
        return event

    def open_fd(pid: int, ns: int, fd: int, item: dict) -> None:
        table = descriptors.setdefault(pid, {})
        if fd in table:
            close_fd(pid, ns, fd)
        item["refs"] += 1
        table[fd] = item
        item["opens"].append(emit("open", pid, ns, {"fd": fd, "object": item["id"], "kind": item["kind"], "name": item["name"]}))

    def close_fd(pid: int, ns: int, fd: int) -> None:
        item = descriptors.get(pid, {}).pop(fd, None)
        if item:
            item["refs"] -= 1
            emit("close", pid, ns, {"fd": fd})

    def file_name(dev: str, ino: str, base: str) -> str:
        return paths.get((dev, ino)) or base or f"inode {ino}"

    for ns, fields in records:
        kind = fields[0]
        if kind in ("P", "L", "S", "NS"):
            continue
        pid = int(fields[2])
        if kind == "B":
            if pid == root or pid in tracked:
                pending[pid] = {"ns": ns, "events": []}
        elif kind == "BF":
            pending.pop(pid, None)
        elif kind == "X":
            parent, stack, env_end, brk, vdso, comm = int(fields[3]), int(fields[4], 16), int(fields[5], 16), int(fields[6], 16), int(fields[7], 16), fields[8]
            started = pending.pop(pid, {"ns": ns, "events": []})
            if pid != root and pid not in tracked:
                continue
            tracked.add(pid)
            names[pid] = comm
            at = started["ns"]
            out.append({"ph": "i", "name": "exec", "pid": pid, "tid": pid, "ts": at / 1000, "args": {"comm": comm, "ppid": parent}})
            top = page_up(env_end) + 2 * PAGE
            out.append({"ph": "i", "name": "mmap", "pid": pid, "tid": pid, "ts": at / 1000,
                        "args": {"addr": hexa(top - STACK_BYTES), "len": STACK_BYTES, "name": "[stack]", "perms": "rw-p"}})
            if vdso:
                out.append({"ph": "i", "name": "mmap", "pid": pid, "tid": pid, "ts": at / 1000,
                            "args": {"addr": hexa(vdso - 4 * PAGE), "len": 4 * PAGE, "file": "[vvar]", "name": "[vvar]", "perms": "r--p"}})
                out.append({"ph": "i", "name": "mmap", "pid": pid, "tid": pid, "ts": at / 1000,
                            "args": {"addr": hexa(vdso), "len": 2 * PAGE, "file": "[vdso]", "name": "[vdso]", "perms": "r-xp"}})
            for event in started["events"]:
                event["ts"] = max(event["ts"], at / 1000)
                out.append(event)
        elif kind == "F":
            child, flags = int(fields[4]), int(fields[5], 16)
            if pid not in tracked:
                continue
            counts["fork"] += 1
            args = {"child": child, **({"vfork": True} if flags & CLONE_VM else {})}
            emit("fork", pid, ns, args, int(fields[3]))
            tracked.add(child)
            names[child] = names.get(pid, "")
            table = {fd: item for fd, item in descriptors.get(pid, {}).items()}
            for item in table.values():
                item["refs"] += 1
            descriptors[child] = table
            skipped_fds.update((child, fd) for owner, fd in list(skipped_fds) if owner == pid)
        elif kind == "T":
            emit("thread", pid, ns, {"new_tid": int(fields[4])}, int(fields[3]))
        elif kind == "N":
            if pid in tracked:
                names[pid] = fields[3]
        elif kind == "O":
            oom.add(pid)
        elif kind == "E":
            for fd in list(descriptors.get(pid, {})):
                descriptors[pid][fd]["refs"] -= 1
            descriptors.pop(pid, None)
            emit("oom_kill" if pid in oom else "exit", pid, ns, {"code": int(fields[3])})
            tracked.discard(pid)
            pending.pop(pid, None)
        elif kind == "R":
            child = int(fields[3])
            if child != root:
                out.append({"ph": "i", "name": "reap", "pid": pid, "tid": pid, "ts": ns / 1000, "args": {"child": child}})
        elif kind == "M":
            addr, length, flags, pgoff, dev, ino, base = int(fields[3], 16), int(fields[4]), int(fields[5], 16), int(fields[6]), fields[7], fields[8], fields[9]
            perms = ("r" if flags & VM_READ else "-") + ("w" if flags & VM_WRITE else "-") + ("x" if flags & VM_EXEC else "-") + ("s" if flags & VM_MAYSHARE else "p")
            args = {"addr": hexa(addr), "len": page_up(length), "perms": perms}
            if ino != "0":
                args.update(file=file_name(dev, ino, base), offset=pgoff * PAGE)
            counts["mmap"] += pid in tracked or pid in pending
            emit("mmap", pid, ns, args)
        elif kind == "H":
            addr, length = int(fields[3], 16), int(fields[4])
            if length:
                emit("mmap", pid, ns, {"addr": hexa(addr), "len": page_up(length), "name": "bss" if pid in pending else "[heap]", "perms": "rw-p"})
        elif kind == "HB":
            old, new = page_up(int(fields[3], 16)), page_up(int(fields[4], 16))
            if old > new:
                emit("munmap", pid, ns, {"addr": hexa(new), "len": old - new})
            elif new > old and brk_growth and old:
                emit("mmap", pid, ns, {"addr": hexa(old), "len": new - old, "name": "[heap]", "perms": "rw-p"})
        elif kind == "Z":
            emit("munmap", pid, ns, {"addr": hexa(int(fields[3], 16)), "len": int(fields[4])})
        elif kind == "V":
            emit("madvise", pid, ns, {"addr": hexa(int(fields[3], 16)), "len": int(fields[4]), "advice": ADVICE.get(int(fields[5]), fields[5])})
        elif kind == "Q":
            emit("mremap", pid, ns, {"addr": hexa(int(fields[3], 16)), "old_len": int(fields[4]), "new_len": int(fields[5]), "new_addr": hexa(int(fields[6], 16))})
        elif kind in ("U", "K"):
            address, code = int(fields[3], 16), int(fields[4], 16)
            if address >= 0x800000000000:  # The legacy vsyscall page, outside every mapping.
                continue
            counts["fault"] += pid in tracked or pid in pending
            emit("fault", pid, ns, {"addr": hexa(address), "write": bool(code & 2), **({"kernel": True} if kind == "K" else {})})
        elif kind == "A":
            start, number, faulting = int(fields[3], 16), int(fields[4]), page_down(int(fields[5], 16))
            for index in range(number):
                address = start + index * PAGE
                if address != faulting:
                    counts["around"] += pid in tracked or pid in pending
                    emit("fault", pid, ns, {"addr": hexa(address), "write": False, "around": True})
        elif kind == "I":
            fd, pointer, dev, ino, mode = int(fields[3]), fields[4], fields[5], fields[6], int(fields[7], 16)
            if pid not in tracked and pid not in pending:
                continue
            if mode == 0xC000:
                family, state, port = int(fields[9]), int(fields[10]), int(fields[11])
                name = ("unix socket" if family == 1 else f"listening socket :{port}" if state == 10
                        else f"connection on :{port}" if port and family in (2, 10) else "socket")
                item_kind, label = "socket", "socket"
            elif mode == 0x1000:
                name, item_kind, label = f"pipe:[{ino}]", "file", "pipe"
            elif mode == 0:
                name, item_kind, label = f"anon_inode:{fields[8]}", "file", "file"
            else:
                name, item_kind, label = file_name(dev, ino, fields[8]), "file", "file"
            if name == markers_path:
                skipped_fds.add((pid, fd))
                continue
            item = objects.get(pointer)
            if not item or item["refs"] <= 0:
                sequence[label] += 1
                item = {"id": f"{label}#{sequence[label]}", "kind": item_kind, "name": name, "refs": 0, "opens": []}
                objects[pointer] = item
            if pointer in listening and item_kind == "socket":
                item["name"] = f"listening socket :{listening[pointer]}"
            open_fd(pid, ns, fd, item)
        elif kind == "C":
            fd = int(fields[3])
            if (pid, fd) in skipped_fds:
                skipped_fds.discard((pid, fd))
            else:
                close_fd(pid, ns, fd)
        elif kind == "D":
            old, new = int(fields[3]), int(fields[4])
            item = descriptors.get(pid, {}).get(old)
            if item and old != new:
                open_fd(pid, ns, new, item)

    # A socket is named when it listens, after it was opened, so its opens take the name it ends with.
    for pointer, port in listening.items():
        item = objects.get(pointer)
        if item and item["kind"] == "socket":
            for event in item["opens"]:
                event["args"]["name"] = f"listening socket :{port}"
    return out, names, counts
