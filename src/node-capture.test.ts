import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_SCHEMA, NodeCaptureAccumulator, counterRate, fromRawKubeletSummary, isKubeletSummaryText, isNodeCaptureText, parseNodeCapture, sampleFromKubeletSummary } from './node-capture.ts';
import { syntheticNodeRecording } from './synthetic-node.ts';

const summary = {
  node: {
    nodeName: 'ip-10-0-0-1.example.internal',
    cpu: { time: '2026-11-05T14:00:00Z', usageNanoCores: 120000000 },
    memory: { time: '2026-11-05T14:00:00Z', rssBytes: 1000000000, workingSetBytes: 1300000000, pageFaults: 1000, majorPageFaults: 10,
      psi: { some: { avg10: 0.12 }, full: { avg10: 0 } } },
    network: { time: '2026-11-05T14:00:00Z', rxBytes: 2000, txBytes: 3000 },
    fs: { usedBytes: 4000 }, rlimit: { curproc: 12, maxpid: 100 },
  },
  pods: [{ podRef: { namespace: 'lab', name: 'probe' }, cpu: { usageNanoCores: 10000000 },
    memory: { rssBytes: 1000000, pageFaults: 4 } }],
};

function recordedSamples() {
  const first = sampleFromKubeletSummary(summary, { namespace: 'lab', name: 'probe' }).sample;
  const second = structuredClone(first);
  second.sourceTimes.memory = '2026-11-05T14:00:10Z';
  second.sourceTimes.network = '2026-11-05T14:00:02Z';
  second.node.pageFaults = 2000;
  second.node.majorPageFaults = 20;
  second.node.networkRxBytes = 3000;
  const third = structuredClone(second);
  third.node.pageFaults = 2500;
  third.node.networkRxBytes = 4000;
  const fourth = structuredClone(third);
  fourth.sourceTimes.memory = '2026-11-05T14:00:20Z';
  fourth.node.pageFaults = 100;
  return [first, second, third, fourth];
}

function lines() {
  const runId = 'test-node-run', at = '2026-11-05T14:00:00Z';
  const data = recordedSamples();
  const values = [
    { type: 'metadata', data: { environment: 'test', context: 'test-context', node: summary.node.nodeName, source: 'Kubelet stats/summary', namespace: 'lab', podName: 'probe' }, elapsedMs: 0 },
    { type: 'sample', data: data[0], elapsedMs: 100 },
    { type: 'marker', data: { name: 'Pod running' }, elapsedMs: 300 },
    { type: 'sample', data: data[1], elapsedMs: 600 },
    { type: 'sample', data: data[2], elapsedMs: 1100 },
    { type: 'sample', data: data[3], elapsedMs: 1600 },
    { type: 'end', data: { status: 'ok' }, elapsedMs: 1601 },
  ];
  return values.map((item, seq) => JSON.stringify({ schema: NODE_SCHEMA, runId, seq, at, ...item }));
}

test('a raw Kubelet summary opens as a clearly identified single node sample', () => {
  const raw = JSON.stringify(summary);
  assert.equal(isKubeletSummaryText(raw), true);
  const text = fromRawKubeletSummary(raw);
  assert.equal(isNodeCaptureText(text), true);
  const capture = parseNodeCapture(text);
  assert.equal(capture.metadata.node, summary.node.nodeName);
  assert.equal(capture.metadata.source, 'kubelet-summary');
  assert.equal(capture.samples.length, 1);
  assert.equal(capture.samples[0].data.node.memoryPsiSomeAvg10, 0.12);
  assert.equal(capture.samples[0].data.pod, null);
});

test('a target Pod is included when Kubelet reports it, and a time series preserves markers', () => {
  const normalized = sampleFromKubeletSummary(summary, { namespace: 'lab', name: 'probe' });
  assert.equal(normalized.sample.pod?.memoryRssBytes, 1000000);
  const capture = parseNodeCapture(lines().join('\n'));
  assert.equal(capture.samples.length, 4);
  assert.equal(capture.markers[0].data.name, 'Pod running');
  const accumulator = new NodeCaptureAccumulator();
  lines().forEach(line => accumulator.addLine(line));
  assert.deepEqual(accumulator.snapshot(), capture);
});

test('rates use the Kubelet measurement clock and leave gaps for stale or reset counters', () => {
  const samples = parseNodeCapture(lines().join('\n')).samples;
  assert.equal(counterRate(samples, 0, 'pageFaults'), null);
  assert.equal(counterRate(samples, 1, 'pageFaults'), 100);
  assert.equal(counterRate(samples, 1, 'networkRxBytes'), 500);
  assert.equal(counterRate(samples, 2, 'pageFaults'), null, 'repeated Kubelet time is not a zero-fault interval');
  assert.equal(counterRate(samples, 3, 'pageFaults'), null, 'counter reset is not a negative rate');
  samples[1].data.sourceTimes.network = null;
  assert.equal(counterRate(samples, 1, 'networkRxBytes'), null, 'missing source time is not replaced with collector time');
});

test('node validation identifies incompatible schemas and malformed measurements', () => {
  const changed = (index: number, edit: (record: Record<string, unknown>) => void) => {
    const copy = lines();
    const record = JSON.parse(copy[index]) as Record<string, unknown>;
    edit(record);
    copy[index] = JSON.stringify(record);
    return copy.join('\n');
  };
  const unsupported = changed(0, item => { item.schema = 'forkscape.node.v2'; });
  assert.equal(isNodeCaptureText(unsupported), true);
  assert.throws(() => parseNodeCapture(unsupported), /Unsupported node recording schema/);
  assert.throws(() => parseNodeCapture(changed(1, item => { item.seq = 9; })), /Expected sequence 1/);
  assert.throws(() => parseNodeCapture(changed(1, item => {
    const node = (item.data as Record<string, unknown>).node as Record<string, unknown>;
    node.memoryRssBytes = -1;
  })), /memoryRssBytes must be a nonnegative integer/);
  assert.throws(() => parseNodeCapture(changed(1, item => {
    const times = (item.data as Record<string, unknown>).sourceTimes as Record<string, unknown>;
    times.memory = 'yesterday';
  })), /sourceTimes.memory must be an ISO timestamp/);
});

test('the synthetic node demo has startup markers and changing counters', () => {
  const capture = parseNodeCapture(syntheticNodeRecording());
  assert.equal(capture.metadata.node, 'demo-node');
  assert.equal(capture.metadata.podName, 'prefork-example');
  assert.match(capture.metadata.source, /synthetic/);
  assert.equal(capture.end?.data.status, 'ok');
  assert.equal(capture.samples.length, 6);
  assert.ok(capture.samples.some(item => item.data.pod?.memoryRssBytes !== null && item.data.pod !== null));
  assert.ok(capture.markers.some(item => item.data.name === 'Pod running'));
  assert.ok(capture.markers.some(item => item.data.name === 'Pod succeeded'));
  assert.ok(capture.samples.some((_, index) => counterRate(capture.samples, index, 'pageFaults') !== null));
});
