"""Style 4 of 4: an unprivileged sampler inside a Docker container snapshots the workload, as it would in a Kubernetes pod.

    python3 examples/recording/record_container_sampler.py -o gunicorn-container-sampler.json

Needs Docker (membership of the docker group is enough), not root. Inside, nothing is privileged: the container runs as
uid 1001 with no capabilities and a read-only root filesystem, like a pod under the restricted Pod Security Standard. Its
entrypoint, sampled_entrypoint.py, starts Gunicorn under the sampler and writes the recording when Gunicorn exits.

This script stands in for the cluster: it builds the image, starts the container, sends the traffic, and stops it. In a
pod, put sampled_entrypoint.py before the command and take the recording from a volume or the pod's log (see that file).
"""

import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile

import demo_traffic
from recording_file import check_writable, say

HERE = Path(__file__).resolve().parent
IMAGE = "forkscape-demo"
# As a restricted pod runs: an unprivileged user, no capabilities, no privilege escalation, a read-only root filesystem.
RESTRICTED = ["--user", "1001:1001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp", "--memory", "512m"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("-o", "--output", required=True)
    options = parser.parse_args()
    check_writable(options.output)
    subprocess.run(["docker", "build", "-q", "-t", IMAGE, str(HERE)], check=True, stdout=subprocess.DEVNULL)
    runtime = demo_traffic.versions(["docker", "run", "--rm", IMAGE, "python"])

    out = Path(tempfile.mkdtemp(prefix="forkscape-out-"))
    os.chmod(out, 0o777)  # The container's user writes the recording here.
    name = f"forkscape-{secrets.token_hex(4)}"
    run = ["docker", "run", "--rm", "--detach", "--name", name, "--hostname", name, *RESTRICTED,
           "--publish", f"127.0.0.1:{demo_traffic.PORT}:{demo_traffic.PORT}", "--volume", f"{out}:/out",
           "--env", "FORKSCAPE_OUTPUT=/out/recording.json", "--env", f"FORKSCAPE_TITLE={demo_traffic.TITLE}",
           "--env", f"FORKSCAPE_NOTES={demo_traffic.NOTES}", "--env", f"FORKSCAPE_RUNTIME={runtime}",
           IMAGE, "python", "/opt/forkscape/sampled_entrypoint.py", *demo_traffic.command(bind=f"0.0.0.0:{demo_traffic.PORT}")]
    subprocess.run(run, check=True, stdout=subprocess.DEVNULL)

    def running() -> bool:
        return subprocess.run(["docker", "inspect", name], capture_output=True).returncode == 0

    try:
        demo_traffic.wait_until_serving(running)
        # The sampler is the container's PID 1 and passes the signal to Gunicorn's master.
        demo_traffic.drive(add_worker=lambda: subprocess.run(["docker", "kill", "--signal", "TTIN", name], check=True, stdout=subprocess.DEVNULL))
    finally:
        subprocess.run(["docker", "stop", "--time", "120", name], stdout=subprocess.DEVNULL)  # SIGTERM, passed on to the master
    recording = out / "recording.json"
    if not recording.exists():
        raise SystemExit("forkscape: the container wrote no recording; see `docker logs` output above")
    shutil.move(recording, options.output)
    shutil.rmtree(out, ignore_errors=True)
    say(f"wrote {options.output}")


if __name__ == "__main__":
    main()
