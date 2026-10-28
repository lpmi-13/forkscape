"""Style 2 of 4: bpftrace on the host traces a workload in a Docker container.

    sudo python3 examples/recording/record_container_bpftrace.py -o gunicorn-container-bpftrace.json

Needs root on the host, bpftrace 0.20 or later, a kernel with BTF on x86-64, and Docker. The container itself stays
unprivileged: it runs as uid 1001 with no capabilities and a read-only root filesystem, as a restricted Kubernetes pod does.

bpftrace attaches before the container starts and waits for the first exec in a task whose hostname is a token this script
chooses; `docker run --hostname` gives the container that hostname, so tracing starts at the container's entrypoint and
follows its descendants. The recording uses the container's own PIDs (the master is PID 1), which are the PIDs its markers
carry, and paths as the container sees them. The markers file is bind-mounted into the container.

To record your own image, change the image and the traffic below. Its Python processes need forkscape_markers.py on their
path only if they write markers.
"""

import argparse
from datetime import datetime, timezone
from pathlib import Path
import secrets
import subprocess

from bpftrace_tracer import Tracer
import demo_traffic
from recording_file import check_writable, header, write

HERE = Path(__file__).resolve().parent
IMAGE = "forkscape-demo"
# As a restricted pod runs: an unprivileged user, no capabilities, no privilege escalation, a read-only root filesystem.
RESTRICTED = ["--user", "1001:1001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp", "--memory", "512m"]
MARKERS = "/forkscape/markers.ndjson"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("-o", "--output", required=True)
    options = parser.parse_args()
    check_writable(options.output)
    subprocess.run(["docker", "build", "-q", "-t", IMAGE, str(HERE)], check=True, stdout=subprocess.DEVNULL)

    tracer = Tracer()
    name = f"forkscape-{secrets.token_hex(4)}"
    tracer.watch_container(name, markers_seen_as=MARKERS)
    run = ["docker", "run", "--rm", "--detach", "--name", name, "--hostname", name, *RESTRICTED,
           "--publish", f"127.0.0.1:{demo_traffic.PORT}:{demo_traffic.PORT}",
           "--volume", f"{tracer.markers}:{MARKERS}", "--env", f"FORKSCAPE_MARKERS={MARKERS}",
           IMAGE, *demo_traffic.command(bind=f"0.0.0.0:{demo_traffic.PORT}")]
    subprocess.run(run, check=True, stdout=subprocess.DEVNULL)
    tracer.config["command"] = " ".join(["docker", "run", *RESTRICTED, IMAGE])[:200]
    try:
        tracer.wait_for_root()
        demo_traffic.wait_until_serving(lambda: not tracer.ended.is_set())
        demo_traffic.drive(add_worker=lambda: subprocess.run(["docker", "kill", "--signal", "TTIN", name], check=True, stdout=subprocess.DEVNULL))
    finally:
        subprocess.run(["docker", "stop", "--time", "60", name], stdout=subprocess.DEVNULL)  # SIGTERM to PID 1, the master
    tracer.wait(timeout=120)
    traced = tracer.finish()

    fields = header(title=demo_traffic.TITLE, source=f"{traced.source}, traced from the host into a Docker container",
                    captured_at=datetime.fromtimestamp(tracer.started, timezone.utc), notes=f"{demo_traffic.NOTES} {traced.summary()}",
                    runtime=demo_traffic.versions(["docker", "run", "--rm", IMAGE, "python"]), config=traced.config)
    write(options.output, fields, traced.events, traced.names)


if __name__ == "__main__":
    main()
