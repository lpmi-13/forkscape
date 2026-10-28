"""A container entrypoint that records its command with the pagemap sampler (style 4 of 4).

Put it before your command, in a Dockerfile or a Kubernetes pod spec:

    ENTRYPOINT ["python", "/opt/forkscape/sampled_entrypoint.py"]
    CMD ["gunicorn", "app.wsgi", "--preload"]

It needs no root or capabilities; the container can run as any user, with a read-only root filesystem. It starts the
command, forwards signals to it (so `docker stop` and `docker kill -s TTIN` reach Gunicorn), and snapshots it and its
descendants until it exits. Then it writes the recording and exits with the command's exit code.

Settings, from the environment:
  FORKSCAPE_OUTPUT       where to write the recording (default /tmp/forkscape-recording.json). "-" prints it to standard
                         output instead, gzipped and base64-encoded on lines that start with FORKSCAPE_RECORDING, which is
                         how to get it out of a pod that is gone once it exits:
                             kubectl logs POD | sed -n 's/^FORKSCAPE_RECORDING //p' | base64 -d > recording.json.gz
  FORKSCAPE_INTERVAL_MS  how often to snapshot between markers (default 100)
  FORKSCAPE_STOP_AFTER_SECONDS  send the command SIGTERM after this many seconds (optional),
                         useful for a bounded startup capture of a server that otherwise keeps running
  FORKSCAPE_TITLE, FORKSCAPE_NOTES, FORKSCAPE_RUNTIME   shown with the replay
"""

import base64
from datetime import datetime, timezone
import gzip
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading

from pagemap_sampler import Sampler
from recording_file import header, say, write


def main() -> int:
    command = sys.argv[1:]
    if not command:
        raise SystemExit("usage: sampled_entrypoint.py COMMAND [ARGS...]")
    output = os.environ.get("FORKSCAPE_OUTPUT", "/tmp/forkscape-recording.json")
    stop_after = float(os.environ.get("FORKSCAPE_STOP_AFTER_SECONDS", "0"))
    cgroup = Path("/sys/fs/cgroup")  # The container's own cgroup, under cgroup v2 with a cgroup namespace.
    sampler = Sampler(interval_ms=float(os.environ.get("FORKSCAPE_INTERVAL_MS", "100")),
                      cgroup=cgroup if (cgroup / "memory.current").exists() else None,
                      markers=Path(tempfile.gettempdir()) / f"forkscape-markers-{os.getpid()}.ndjson")
    sampler.launch(command)
    timer = None
    if stop_after > 0:
        timer = threading.Timer(stop_after, lambda: os.kill(os.getpid(), signal.SIGTERM))
        timer.daemon = True
        timer.start()
    try:
        code = sampler.run()
    finally:
        if timer is not None:
            timer.cancel()
    sampled = sampler.finish()
    fields = header(title=os.environ.get("FORKSCAPE_TITLE") or " ".join(command), source=f"{sampled.source}, inside a container",
                    captured_at=datetime.fromtimestamp(sampler.started, timezone.utc),
                    notes=" ".join(filter(None, [os.environ.get("FORKSCAPE_NOTES"), sampled.summary()])),
                    runtime=os.environ.get("FORKSCAPE_RUNTIME"), config=sampled.config, stage_gap_ms=sampled.stage_gap_ms)
    if output == "-":
        with tempfile.TemporaryDirectory() as directory:
            path = write(Path(directory) / "recording.json", fields, sampled.events, sampled.names, announce=False)
            encoded = base64.b64encode(gzip.compress(path.read_bytes(), 9)).decode()
        for start in range(0, len(encoded), 4000):
            print(f"FORKSCAPE_RECORDING {encoded[start:start + 4000]}", flush=True)
        lines = -(-len(encoded) // 4000)
        say(f"printed the recording ({len(sampled.events):,} events) on {lines} FORKSCAPE_RECORDING line{'' if lines == 1 else 's'}")
    else:
        write(Path(output), fields, sampled.events, sampled.names)
    return code


if __name__ == "__main__":
    sys.exit(main())
