"""Style 1 of 4: bpftrace on the host traces a workload this script starts on the host.

    sudo python3 examples/recording/record_host_bpftrace.py --python /path/to/venv/bin/python -o gunicorn-host-bpftrace.json

Needs root on the machine, bpftrace 0.20 or later, and a kernel with BTF (/sys/kernel/btf/vmlinux) on x86-64. The workload
runs as the user who ran sudo, in a cgroup of its own, from its exec until it exits. The venv needs Django and Gunicorn.
This is the most complete style: every fault, mapping, and descriptor comes from the kernel as it happens.

To record your own workload, change the command and the traffic below; keep the Tracer calls.
"""

import argparse
from datetime import datetime, timezone
import os
import signal

from bpftrace_tracer import Tracer
import demo_traffic
from recording_file import check_writable, header, write


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--python", required=True, help="a Python with Django and Gunicorn installed")
    parser.add_argument("-o", "--output", required=True)
    options = parser.parse_args()
    check_writable(options.output)

    tracer = Tracer()
    master = tracer.run(demo_traffic.command(options.python), cwd=demo_traffic.DEMO, cgroup=True)
    try:
        demo_traffic.wait_until_serving(lambda: os.waitpid(master, os.WNOHANG) == (0, 0))
        demo_traffic.drive(add_worker=lambda: os.kill(master, signal.SIGTTIN))
    finally:
        os.kill(master, signal.SIGTERM)
    tracer.wait()
    traced = tracer.finish()

    fields = header(title=demo_traffic.TITLE, source=f"{traced.source}, traced on the host", captured_at=datetime.fromtimestamp(tracer.started, timezone.utc),
                    notes=f"{demo_traffic.NOTES} {traced.summary()}", runtime=demo_traffic.versions([options.python]), config=traced.config)
    write(options.output, fields, traced.events, traced.names)


if __name__ == "__main__":
    main()
