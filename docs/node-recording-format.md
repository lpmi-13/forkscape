# Node telemetry recordings

Forkscape reads `forkscape.node.v1` NDJSON files in the same **Replay telemetry** picker as page traces and process captures. It recognizes the first record and opens `/node.html` automatically. A raw Kubelet `/stats/summary` JSON file opens in that view as one sample. For a time series with stepping, use the collector below. The generated demo opens from the picker or at `/node.html?sample=synthetic`.

The node view offers 3D columns and Flat charts for RSS and working set, CPU, page-fault rate, and network throughput. Each metric station in 3D has its own fixed scale; the Flat charts retain their scales too. Previous/next buttons, a slider, chart clicks in Flat view, arrow keys, and Pod lifecycle markers move the selected sample. A Kubelet summary is aggregate node data: its page-fault counter identifies neither copied pages nor processes, and its network counters identify no sockets. A separate in-Pod page trace can show process-level relationships by sampling `/proc`; its copy-on-write classifications are inferred.

## Record from EKS

From the repository root, this read-only command records a known node for 30 seconds. Its output defaults to an ignored `local/captures/node-<timestamp>.ndjson` file. Name the Kubernetes context explicitly:

```bash
npm run record:node -- \
  --context YOUR_TEST_CONTEXT \
  --node YOUR_NODE_NAME \
  --duration 30
```

To follow a Pod, pass `--pod NAMESPACE/NAME` instead of `--node`. The collector waits until Kubernetes assigns a node, then samples that EC2 instance and includes Kubelet's aggregate for the target Pod when available. It records transitions such as Pending, Running, Ready, and Succeeded as markers. The optional `--apply MANIFEST` creates the Pod; it is the only option that changes cluster state. With `--pod` alone, creation happens before node sampling can begin. Supplying both `--node` and `--pod` captures a node baseline before applying the Pod manifest, and the collector stops if the Pod lands on another node. Use `--interval` to change the default 500 ms poll and `--output` to choose a path. The collector stops after 20 seconds by default and writes an `end` record; Ctrl-C writes the samples already collected.

To capture a node baseline before a disposable Pod starts, pass both `--node` and `--pod`, plus the Pod manifest to apply. Save any manifest and output under `local/`:

```bash
npm run record:node -- \
  --context YOUR_TEST_CONTEXT \
  --node YOUR_NODE_NAME \
  --pod YOUR_NAMESPACE/YOUR_POD \
  --apply local/eks-test/YOUR_POD.yaml \
  --duration 20 \
  --output local/captures/node-run.ndjson
npm run validate:capture -- local/captures/node-run.ndjson
```

After saving the Pod log and node file under `local/`, inspect the namespace and remove the disposable resources. Kubelet can repeat a source timestamp across polls; the viewer shows that timestamp and leaves rate gaps for repeated measurements or counter resets.

## Contract and timing

Each line contains `schema`, `runId`, sequential `seq`, UTC collector time `at`, monotonic `elapsedMs`, `type`, and `data`. The first record is `metadata` with environment, Kubernetes context, node, and source; an optional namespace and Pod name identify a target. `sample` records hold nullable CPU, memory, page-fault, pressure, filesystem, process, and network fields for the node, plus optional Pod CPU/memory/network aggregates. `marker` names a Pod or container transition. `end` says whether collection completed or failed. An interrupted file without `end` remains readable and is labelled incomplete. The parser rejects invalid units, skipped sequence numbers, mixed runs, records after `end`, lines over 64 KiB, and files over 10 MiB.

Kubelet refreshes CPU, memory, and network measurements independently. Each sample preserves their separate `sourceTimes`; `at` remains the time the collector received the response. Fault and byte rates divide counter changes by the corresponding **Kubelet measurement-time** difference. When that timestamp repeats or is missing, a counter resets, or a value is missing, the chart leaves a gap. The sample cursor uses collector time so Pod markers and polling remain on one timeline. A node series is therefore useful context for startup, but shared EC2 workloads can move its values independently of the target Pod.
