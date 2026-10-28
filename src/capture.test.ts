import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPTURE_SCHEMA, CaptureAccumulator, isCaptureText, parseCapture } from './capture.ts';
import { syntheticProcessCapture } from './synthetic-capture.ts';

const fixture = syntheticProcessCapture();
const lines = fixture.trim().split('\n');

test('the synthetic process capture contains a fork and copy-on-write phase', () => {
  const capture = parseCapture(fixture);
  assert.equal(capture.metadata.environment, 'demo');
  assert.equal(capture.metadata.workload, 'synthetic-prefork');
  assert.equal(capture.metadata.synthetic, true);
  assert.equal(capture.end?.data.status, 'ok');
  assert.equal(capture.samples.length, 4);
  assert.deepEqual(capture.markers.filter(marker => marker.data.name === 'cow_write_complete').map(marker => marker.data.pid), [7]);
  const pss = (index: number) => capture.samples[index].data.processes.reduce((sum, process) => sum + (process.pssKiB ?? 0), 0);
  const rss = (index: number) => capture.samples[index].data.processes.reduce((sum, process) => sum + (process.rssKiB ?? 0), 0);
  assert.equal(pss(2) - pss(1), 8192, 'the modeled writes raise summed PSS');
  assert.equal(rss(2) - rss(1), 0, 'the same writes leave summed RSS unchanged');
});

test('the file and a line-at-a-time stream use the same contract', () => {
  assert.equal(isCaptureText(fixture), true);
  assert.equal(isCaptureText('{"ph":"M","name":"forkscape","pid":0,"args":{"version":1}}'), false);
  const accumulator = new CaptureAccumulator();
  for (const line of lines) accumulator.addLine(line);
  assert.deepEqual(accumulator.snapshot(), parseCapture(fixture));
  const partial = parseCapture(lines.slice(0, -1).join('\n'));
  assert.equal(partial.end, null, 'a disconnected stream remains inspectable');
});

test('a capture from a host, outside any pod, needs no pod fields', () => {
  const metadata = JSON.parse(lines[0]) as { data: Record<string, unknown> };
  for (const key of ['podName', 'podUid', 'namespace', 'imageRef']) delete metadata.data[key];
  metadata.data.host = 'ubuntu-01';
  const capture = parseCapture([JSON.stringify(metadata), ...lines.slice(1)].join('\n'));
  assert.equal(capture.metadata.podName, undefined);
  assert.equal(capture.metadata.host, 'ubuntu-01');
  assert.equal(capture.samples.length, 4);
  metadata.data.podName = '';
  assert.throws(() => parseCapture([JSON.stringify(metadata), ...lines.slice(1)].join('\n')), /metadata\.podName must be a nonempty string/, 'a pod field that is present must say something');
});

test('the reader rejects incompatible or damaged captures before rendering them', () => {
  const changed = (index: number, edit: (record: Record<string, unknown>) => void) => {
    const copy = [...lines];
    const record = JSON.parse(copy[index]) as Record<string, unknown>;
    edit(record);
    copy[index] = JSON.stringify(record);
    return copy.join('\n');
  };
  assert.throws(() => parseCapture(changed(0, record => { record.schema = 'forkscape.capture.v2'; })), /Unsupported capture schema/);
  assert.throws(() => parseCapture(changed(2, record => { record.seq = 99; })), /Expected sequence 2/);
  assert.throws(() => parseCapture(changed(1, record => {
    const data = record.data as Record<string, unknown>;
    const first = (data.processes as Record<string, unknown>[])[0];
    delete first.rssKiB;
  })), /rssKiB/);
  assert.equal(CAPTURE_SCHEMA, 'forkscape.capture.v1');
});
