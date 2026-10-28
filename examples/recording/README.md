# Recording examples

These scripts record the same workload in four styles. Each writes a [Forkscape recording](../../docs/recording-format.md), which the app replays stage by stage through the same scene, flat view, chart, and ledger as its scenarios. Use them as reference points for recording your own workload: copy the closest one and change its command and traffic.

The workload is [`demo_app/`](demo_app): a Django app whose import builds a 150,000-entry catalog, served by Gunicorn with two sync workers and `preload_app`. [`demo_traffic.py`](demo_traffic.py) sends each worker `/ping` and then `/scan`, which reads every catalog entry and so copies the catalog's pages. It then adds a third worker with SIGTTIN and stops the server with SIGTERM.

| Style | Script | Recorder | Workload | Needs |
| --- | --- | --- | --- | --- |
| [1](#style-1-bpftrace-on-the-host) | [`record_host_bpftrace.py`](record_host_bpftrace.py) | bpftrace on the host | on the host | root, bpftrace, BTF |
| [2](#style-2-bpftrace-on-the-host-into-a-container) | [`record_container_bpftrace.py`](record_container_bpftrace.py) | bpftrace on the host | in a Docker container | root on the host; the container stays unprivileged |
| [3](#style-3-the-sampler-on-the-host) | [`record_host_sampler.py`](record_host_sampler.py) | pagemap sampler on the host | on the host, as the same user | nothing |
| [4](#style-4-the-sampler-in-the-container) | [`record_container_sampler.py`](record_container_sampler.py) | pagemap sampler in the container ([`sampled_entrypoint.py`](sampled_entrypoint.py)) | in the same container | nothing inside; Docker to start it |

Use bpftrace where you can be root on the machine: every fault, mapping, and descriptor comes from the kernel as it happens. Use the sampler where you cannot, such as in a Kubernetes pod under the restricted Pod Security Standard. It reads `/proc` every 100 ms and at each marker, and infers the events from what changed.

## The four examples

Each script starts the demo, records it from Gunicorn's exec until Gunicorn exits, with every process it forks, and writes the recording to `-o`. The commands below run from this directory. First create the ignored output directory with `mkdir -p ../../local/captures/recordings`. Open the resulting file with **Choose a recording or capture** in the app, or drop it on the page. Each run takes about 10 seconds. A recording is about 110 bytes per event; `gzip -9` shrinks it ten- to thirtyfold, and the app opens `.json.gz` files directly.

Styles 1 and 3 run the workload with a Python you name, which needs Django and Gunicorn:

```bash
python3 -m venv /tmp/fsenv && /tmp/fsenv/bin/pip install "django==6.1.*" "gunicorn==26.*"
```

Styles 2 and 4 build the [`Dockerfile`](Dockerfile) image, `forkscape-demo`, which has both, and publish the demo on `127.0.0.1:8017`. Their containers run as uid 1001, with every capability dropped and no privilege escalation, as the restricted Pod Security Standard requires. They also have a read-only root filesystem with a `/tmp` tmpfs, and a 512 MiB memory limit.

To record your own workload, copy the closest example and change its workload command, which comes from `demo_traffic.command()`, and its traffic, which comes from `demo_traffic.drive()`. The recorder calls around them stay the same.

### Style 1: bpftrace on the host

[`record_host_bpftrace.py`](record_host_bpftrace.py) traces a workload it starts on the host.

```bash
sudo python3 record_host_bpftrace.py --python /tmp/fsenv/bin/python -o ../../local/captures/recordings/host-bpftrace.json
```

It needs root, bpftrace 0.20 or later, and an x86-64 kernel with BTF (`/sys/kernel/btf/vmlinux`). This is the most complete style, because every fault, mapping, and descriptor comes from the kernel as it happens. Use it when you can be root on the machine the workload runs on.

- `Tracer().run(command, cwd=..., cgroup=True)` forks the command and holds it until bpftrace has attached every probe, then lets it exec. The command runs as the user who ran sudo, in a cgroup of its own, whose `memory.current` the recording charts.
- The script sends the traffic, adds a worker by sending the master SIGTTIN with `os.kill`, and stops it with SIGTERM.
- `tracer.wait()` waits for the master to exit, and `tracer.finish()` returns the events with the markers merged in.

For your own workload, change the command passed to `tracer.run()` and the traffic. `run()` also takes `env`, `user` (instead of the user who ran sudo), and `memory_max`, a limit in bytes for its cgroup.

### Style 2: bpftrace on the host, into a container

[`record_container_bpftrace.py`](record_container_bpftrace.py) traces a Docker container from the host.

```bash
sudo python3 record_container_bpftrace.py -o ../../local/captures/recordings/container-bpftrace.json
```

It needs root on the host, the same bpftrace and kernel as style 1, and Docker. The container stays unprivileged. Use it when you can be root on the host but want the workload to run as it does in production: from its image, with the container's restrictions.

- The script chooses a name, `forkscape-` and eight random hex digits. `tracer.watch_container(name, markers_seen_as=...)` attaches bpftrace first; then the script starts the container with that name as its `--hostname`. Tracing starts at the first exec with that hostname, which is the container's entrypoint, and follows its descendants.
- `tracer.wait_for_root()` waits for that exec and finds the container's cgroup, whose `memory.current` and `memory.max` the recording charts.
- The script bind-mounts the tracer's markers file into the container, and sets `FORKSCAPE_MARKERS` to the path where the container sees it. It reaches the master, the container's PID 1, with `docker kill --signal TTIN` and `docker stop`.
- `tracer.finish()` translates every PID to the container's own (the master is PID 1), so the events match the PIDs the markers carry. Paths are the ones the container sees.

For your own image, change `IMAGE`, the command that follows it in `docker run`, and the traffic. Keep `--hostname` the same as the name passed to `watch_container()`. Mount the markers file only if the workload writes markers; then its Python processes also need [`forkscape_markers.py`](forkscape_markers.py) on their path.

### Style 3: the sampler on the host

[`record_host_sampler.py`](record_host_sampler.py) snapshots a workload it starts on the host, without privileges.

```bash
python3 record_host_sampler.py --python /tmp/fsenv/bin/python -o ../../local/captures/recordings/host-sampler.json
```

It needs no root, capabilities, or eBPF. The sampler and the workload both run as you, which is all `/proc/<pid>/pagemap` requires. Use it when you cannot be root, for example on a shared machine or a CI runner.

- `Sampler(interval_ms=100).launch(command, cwd=...)` starts the command as the sampler's child.
- `sampler.run()` snapshots the command and its descendants every 100 ms, and at each marker, until it exits. It has to run on the main thread, because only the main thread can install the handlers that forward signals to the workload, so the script sends the traffic from a second thread.
- `sampler.finish()` returns the events. The header sets `stage_gap_ms` to 250, two and a half snapshot intervals. The sampler's events arrive in bursts, a snapshot apart, and with the default of 50 ms every snapshot would start a stage.

For your own workload, change the command passed to `launch()` and the traffic thread. On the host the workload has no cgroup of its own, so the recording has no `memory.current` line. To add one, pass `cgroup=`, the cgroup v2 directory the workload already runs in, to `Sampler()`.

### Style 4: the sampler in the container

[`record_container_sampler.py`](record_container_sampler.py) runs the sampler inside the container, as it would run in a Kubernetes pod.

```bash
python3 record_container_sampler.py -o ../../local/captures/recordings/container-sampler.json
```

It needs Docker; membership of the `docker` group is enough, without root. Inside the container nothing is privileged. Use it where bpftrace cannot run, such as a pod under the restricted Pod Security Standard.

- The container's command is [`sampled_entrypoint.py`](sampled_entrypoint.py) followed by Gunicorn's command. The entrypoint is the container's PID 1. It starts Gunicorn under the sampler and forwards the signals it receives, so `docker kill --signal TTIN` and `docker stop` reach the master.
- The sampler reads the container's own cgroup, so the recording charts `memory.current` against the 512 MiB limit.
- When Gunicorn exits, the entrypoint writes the recording and exits with Gunicorn's exit code. The script mounts a directory at `/out`, sets `FORKSCAPE_OUTPUT=/out/recording.json`, and moves the file to `-o` once the container has stopped.

The entrypoint takes its settings from the environment:

| Variable | Setting |
| --- | --- |
| `FORKSCAPE_OUTPUT` | Where to write the recording; the default is `/tmp/forkscape-recording.json`. `-` prints it to the log instead. |
| `FORKSCAPE_INTERVAL_MS` | How often to snapshot between markers; the default is 100. |
| `FORKSCAPE_STOP_AFTER_SECONDS` | Optional timer that sends SIGTERM to the recorded command, then writes the trace after it exits. Useful for a bounded server startup canary. |
| `FORKSCAPE_TITLE`, `FORKSCAPE_NOTES`, `FORKSCAPE_RUNTIME` | Shown with the replay. |

The script stands in for a cluster. **In a Kubernetes pod**, copy `forkscape_markers.py`, `pagemap_sampler.py`, `recording_file.py`, and `sampled_entrypoint.py` into the image, as the Dockerfile does, and put the entrypoint before your command:

```dockerfile
ENTRYPOINT ["python", "/opt/forkscape/sampled_entrypoint.py"]
CMD ["gunicorn", "app.wsgi", "--preload"]
```

The pod needs no privileges, capabilities, or host access. The sampler and the workload run as the same user in the same container, which is all `/proc/<pid>/pagemap` requires. A pod's files are gone once it exits, so set `FORKSCAPE_OUTPUT=-`. The recording is then printed to the log, gzipped and base64-encoded:

```bash
kubectl logs POD | sed -n 's/^FORKSCAPE_RECORDING //p' | base64 -d > ../../local/captures/recordings/pod-sampler.json.gz
```

In a cluster, collect the Pod log into `local/captures/recordings/` and open it from disk. The restricted Pod Security Standard does not require privileged tracing for this sampler.

## Markers

Markers turn a stream of faults into stages a reader recognizes, and all four styles record them. A Gunicorn config needs two lines, as in [`demo_app/gunicorn_conf.py`](demo_app/gunicorn_conf.py). They add a marker for each server hook, a slice for each request, and a slice for each import:

```python
import forkscape_markers
forkscape_markers.gunicorn(globals())
forkscape_markers.trace_imports(depth=3)
```

`marker(name, **args)`, `span(name)` (a context manager), and `phase(label)` add your own. The recorders set `FORKSCAPE_MARKERS` and put [`forkscape_markers.py`](forkscape_markers.py) on the workload's `PYTHONPATH`. Without `FORKSCAPE_MARKERS`, the functions do nothing, so the same config also runs unrecorded. Markers are timed with `CLOCK_MONOTONIC`, as the kernel's events are. Containers share the host's clock unless they use a time namespace, and Docker and Kubernetes do not by default.

## Run all four in a labctl playground

From the repository's root, this starts a fresh `labctl` Docker playground and runs all four there. Replace `<id>` with the playground's ID.

```bash
labctl playground start docker --title forkscape-recording
tar czf /tmp/examples.tgz examples && labctl cp /tmp/examples.tgz <id>:/tmp/examples.tgz
labctl ssh <id> -- 'sudo apt-get install -y -qq bpftrace python3-venv && python3 -m venv /tmp/fsenv && /tmp/fsenv/bin/pip install -q "django==6.1.*" "gunicorn==26.*"'
labctl ssh <id> -- 'cd /tmp && tar xzf examples.tgz && chmod -R a+rX examples && cd examples/recording &&
  sudo python3 record_host_bpftrace.py --python /tmp/fsenv/bin/python -o /tmp/host-bpftrace.json &&
  sudo python3 record_container_bpftrace.py -o /tmp/container-bpftrace.json &&
  python3 record_host_sampler.py --python /tmp/fsenv/bin/python -o /tmp/host-sampler.json &&
  python3 record_container_sampler.py -o /tmp/container-sampler.json'
mkdir -p local/captures/recordings
labctl cp <id>:/tmp/container-sampler.json local/captures/recordings/container-sampler.json
```

## Compare recorder styles

Run all four styles on the same workload and compare event coverage, charted RSS/PSS, and marker timing. Keep run-specific findings and recordings under `local/`.

## How the bpftrace styles work

[`forkscape.bt`](forkscape.bt) prints one tab-separated record per kernel event, and [`bpftrace_tracer.py`](bpftrace_tracer.py) sorts the records by time and converts them.

| Recording event | Kernel source |
| --- | --- |
| `exec` | `sys_enter_execve` and `sched_process_exec`. The mappings the kernel makes during exec are placed after the `exec`, followed by `[stack]`, `[vdso]`, and `[vvar]` from the new `mm`. |
| `fork`, `thread` | `task:task_newtask`; `CLONE_THREAD` makes a thread, and `CLONE_VM` without it marks a `vfork`. |
| `exit`, `oom_kill`, `reap` | `sched_process_exit` once a process's last thread exits; `oom:mark_victim`; `release_task`. |
| `mmap` | `mmap_region` (every mapping, including the program and libraries at exec) and `do_brk_flags` (the heap and bss). File paths come from `security_file_open`, resolved against the traced process's root, so a container's paths are the container's. |
| `munmap`, `madvise`, `mremap` | The system calls, and `brk` shrinking. |
| `fault` | `exceptions:page_fault_user`, and `page_fault_kernel` for user addresses (a `read()` into a fresh buffer). Pages that fault-around maps beside a file fault come from `do_set_pte`, or `set_pte_range` on 6.6 and later, with `around: true`. |
| `open`, `close` | `fd_install` (files, sockets, pipes, eventfds), `close`, and `dup2`/`dup3`. A socket's name gains its port when it listens. |
| PIDs | `wake_up_new_task` and `sched_process_exec` give each task's PID in its own namespace, and the tracer writes those, so a container's events match the PIDs its markers carry. |
| `memory`, `cgroup` | `/proc/<pid>/smaps_rollup` and the cgroup's `memory.current`, read every 50 ms. |

If the kernel cannot trace an optional function, the tracer leaves its probe out and the recording says what it lacks. Without `mmap_region` it stops, because a replay needs mappings. Not recorded: `mprotect` (a write to anonymous memory shows it became writable), descriptors that exec closes with `O_CLOEXEC`, transparent huge pages, swap, and readahead. bpftrace cannot attach probes from inside an unprivileged container, so both bpftrace styles run on the host.

## How the sampler styles work

[`pagemap_sampler.py`](pagemap_sampler.py) starts the workload as its child. It snapshots the workload and every descendant every 100 ms, and whenever a marker asks for a snapshot. Each snapshot reads `/proc/<pid>/maps`, `pagemap`, `fd/`, `task/`, `stat`, and `smaps_rollup`. Without root, `pagemap` still says whether each page is resident, file-backed, and mapped by this process alone; only the frame numbers are hidden. Comparing a snapshot with the one before gives the events:

- A new process is a `fork`, timed from its start time; if its mappings are not its parent's, it has also exec'd. A vanished one is an `exit`, then a `reap`.
- A range new to `maps` is an `mmap`, and a range gone from it is an `munmap`. A permission change alone is neither.
- A page that becomes resident is a read `fault` for a file page or the zero page, and a write `fault` for an anonymous page. A resident page that disappears from a mapping still there is a `madvise` that dropped it.
- A page two processes shared that each now holds alone was copied on write. The copy goes to the process whose minor-fault count rose more; with three or more sharers, the one that holds it alone is the copier. Σ RSS and Σ PSS are the same whichever side copied.
- New descriptors are `open` events, named from `/proc/net` for sockets; vanished ones are `close` events. New threads are `thread` events.

The sampler keeps a model of what the replay will hold, using the replay's own fork and copy-on-write rules, and emits only what moves the replay to what `/proc` shows. Under the sampler, [`forkscape_markers.py`](forkscape_markers.py) waits at each marker while a snapshot is taken (import slices do not wait). The pages a process changed before a marker are therefore placed before it, as they would be with bpftrace.

Limits that come from sampling:
- Order is only known to the snapshot. Changes between two snapshots share a time, so two requests running at once can see their copies split between their stages.
- Memory that is allocated and freed between two snapshots is not seen, and fault-around cannot be told from other file faults.
- Without frame numbers, the model's fork history decides sharing. Two processes that each hold their own copy at the same address look the same as one page they share, if the history does not say otherwise.
- A page both processes map read-only from the zero page looks shared.

## Files

- `record_*.py`: the four examples.
- `sampled_entrypoint.py`: the container entrypoint for style 4.
- `bpftrace_tracer.py` and `forkscape.bt`: the bpftrace tracer (styles 1 and 2).
- `pagemap_sampler.py`: the sampler (styles 3 and 4).
- `recording_file.py`: reads markers and writes recordings.
- `forkscape_markers.py`: markers, for the workload.
- `demo_app/`, `demo_traffic.py`, `Dockerfile`: the demo workload and its traffic.

`python3 -m unittest discover -s examples/recording` tests the bpftrace conversion and the sampler's inference without root, bpftrace, or a workload. `npm test` replays the synthetic page trace and checks parser and model behavior.
