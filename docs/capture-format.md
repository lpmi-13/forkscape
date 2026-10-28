# Process capture format

Forkscape reads `forkscape.capture.v1` NDJSON files through **Replay telemetry**. The picker opens them at `/capture.html`. Open `/capture.html?sample=synthetic` for a generated example. Flat charts and 3D columns show sampled process RSS, PSS, approximate USS, and cgroup charge over time. Samples do not identify individual pages, physical frames, or exact copy-on-write faults.

Each line has `schema`, `runId`, sequential `seq`, UTC `at`, monotonic `elapsedMs`, `type`, and `data`. The first line is `metadata`. Records use one run ID and increasing sequence numbers; an interrupted file without `end` remains readable and is marked incomplete.

| Type | Data |
| --- | --- |
| `metadata` | Environment, workload, `synthetic` flag, kernel, architecture, Python version, page size, and cgroup version. Pod name, UID, namespace, and image reference are optional; a host capture can use `host`. |
| `marker` | Phase name, PID, and optional worker index or byte count. |
| `sample` | Process list with PID, PPID, start ticks, role, RSS, PSS, approximate USS, private/shared dirty memory, `VmPTE`, and fault counters; missing PIDs; cgroup current/limit/OOM counters; sample duration. Memory fields ending in `KiB` use KiB, and cgroup fields ending in `Bytes` use bytes. Unavailable measurements are `null`. |
| `end` | `ok` or `error`, with an optional message. |

[`src/capture.ts`](../src/capture.ts) defines and validates the complete contract. Its incremental `CaptureAccumulator.addLine` method and the file reader share the same parser. The parser rejects mixed run IDs, skipped sequence numbers, malformed fields, records after `end`, lines over 64 KiB, and files over 10 MiB. Run `npm run validate:capture -- local/captures/your-run.ndjson` to check a local file before opening it. Keep real captures and investigation notes under `local/`, which Git ignores.
