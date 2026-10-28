import { readFile } from 'node:fs/promises';
import { parseCapture } from '../src/capture.ts';
import { fromRawKubeletSummary, isKubeletSummaryText, isNodeCaptureText, parseNodeCapture } from '../src/node-capture.ts';

const path = process.argv[2];
if (!path) {
  console.error('Usage: npm run validate:capture -- <process-capture.ndjson | node-capture.ndjson | kubelet-summary.json>');
  process.exit(2);
}

try {
  const text = await readFile(path, 'utf8');
  if (isNodeCaptureText(text) || isKubeletSummaryText(text)) {
    const capture = parseNodeCapture(isKubeletSummaryText(text) ? fromRawKubeletSummary(text) : text);
    console.log(JSON.stringify({
      schema: 'forkscape.node.v1',
      type: 'node telemetry',
      runId: capture.runId,
      node: capture.metadata.node,
      targetPod: capture.metadata.namespace && capture.metadata.podName ? `${capture.metadata.namespace}/${capture.metadata.podName}` : null,
      samples: capture.samples.length,
      markers: capture.markers.length,
      complete: capture.end?.data.status === 'ok',
      lastElapsedMs: capture.records.at(-1)?.elapsedMs,
    }, null, 2));
    if (capture.end?.data.status !== 'ok') process.exitCode = 1;
  } else {
    const capture = parseCapture(text);
    console.log(JSON.stringify({
      schema: 'forkscape.capture.v1',
      type: 'process and cgroup telemetry',
      runId: capture.runId,
      environment: capture.metadata.environment,
      workload: capture.metadata.workload,
      samples: capture.samples.length,
      markers: capture.markers.length,
      complete: capture.end?.data.status === 'ok',
      lastElapsedMs: capture.records.at(-1)?.elapsedMs,
    }, null, 2));
    if (capture.end?.data.status !== 'ok') process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
