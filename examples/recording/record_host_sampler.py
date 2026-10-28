"""Style 3 of 4: an unprivileged sampler on the host snapshots a workload this script starts on the host.

    python3 examples/recording/record_host_sampler.py --python /path/to/venv/bin/python -o gunicorn-host-sampler.json

Needs no root, capabilities, or eBPF: the sampler runs as you and reads /proc for the workload it starts, which runs as
you too. Snapshots every 100 ms, and at each marker, give the events, so their order between two snapshots is inferred
(see pagemap_sampler.py). The venv needs Django and Gunicorn.

To record your own workload, change the command and the traffic below; keep the Sampler calls.
"""

import argparse
from datetime import datetime, timezone
import os
import signal
import threading

import demo_traffic
from pagemap_sampler import Sampler
from recording_file import check_writable, header, write


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--python", required=True, help="a Python with Django and Gunicorn installed")
    parser.add_argument("-o", "--output", required=True)
    options = parser.parse_args()
    check_writable(options.output)

    sampler = Sampler(interval_ms=100)
    master = sampler.launch(demo_traffic.command(options.python), cwd=demo_traffic.DEMO)

    def traffic() -> None:
        try:
            demo_traffic.wait_until_serving(lambda: sampler.code is None)
            demo_traffic.drive(add_worker=lambda: os.kill(master, signal.SIGTTIN))
        finally:
            os.kill(master, signal.SIGTERM)

    # The sampler snapshots in this thread, which has to be the main one to forward signals; the traffic runs beside it.
    driver = threading.Thread(target=traffic)
    driver.start()
    sampler.run()
    driver.join()
    sampled = sampler.finish()

    fields = header(title=demo_traffic.TITLE, source=f"{sampled.source}, on the host", captured_at=datetime.fromtimestamp(sampler.started, timezone.utc),
                    notes=f"{demo_traffic.NOTES} {sampled.summary()}", runtime=demo_traffic.versions([options.python]),
                    config=sampled.config, stage_gap_ms=sampled.stage_gap_ms)
    write(options.output, fields, sampled.events, sampled.names)


if __name__ == "__main__":
    main()
