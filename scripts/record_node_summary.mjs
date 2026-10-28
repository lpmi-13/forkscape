/** Poll Kubelet stats/summary through kubectl and write a step-through Forkscape node recording. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { NODE_SCHEMA, sampleFromKubeletSummary } from '../src/node-capture.ts';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const usage = `Usage: npm run record:node -- --context CONTEXT [--pod NAMESPACE/NAME | --node NODE] [options]

Options:
  --pod NAMESPACE/NAME  Follow this Pod and include its Kubelet aggregates and phase markers
  --node NODE           Sample a known EC2 node; with --pod, capture a baseline before Pod creation
  --apply MANIFEST      Apply one Pod manifest after the first node sample (requires --pod)
  --duration SECONDS    Recording duration after the node is known (default: 20)
  --interval MS         Sampling interval (default: 500; minimum: 100)
  --environment NAME    Label for the recording (default: test)
  --output FILE         NDJSON output (default: local/captures/node-<timestamp>.ndjson)

Without --node, the collector waits for --pod to be scheduled, then samples its node.
It reads Kubelet data through the named Kubernetes context. Only --apply changes cluster state.`;

function options(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
  const allowed = new Set(['--context', '--pod', '--node', '--apply', '--duration', '--interval', '--environment', '--output']);
  const found = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || !value || value.startsWith('--') || found[key] !== undefined) throw Error(`Invalid or duplicate option ${key ?? '(missing)'}\n${usage}`);
    found[key] = value;
  }
  if (!found['--context'] || !found['--pod'] && !found['--node']) throw Error(`--context and either --pod or --node are required\n${usage}`);
  if (found['--apply'] && !found['--pod']) throw Error('--apply requires --pod');
  const pod = found['--pod']?.split('/');
  if (pod && (pod.length !== 2 || !pod[0] || !pod[1])) throw Error('--pod must be NAMESPACE/NAME');
  const duration = Number(found['--duration'] ?? 20);
  const interval = Number(found['--interval'] ?? 500);
  if (!Number.isFinite(duration) || duration < 1 || duration > 300) throw Error('--duration must be 1–300 seconds');
  if (!Number.isFinite(interval) || interval < 100 || interval > 10000) throw Error('--interval must be 100–10000 milliseconds');
  const output = found['--output'] ?? `local/captures/node-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`;
  return { context: found['--context'], pod: pod ? { namespace: pod[0], name: pod[1] } : null,
    node: found['--node'] ?? null, apply: found['--apply'] ?? null, duration, interval,
    environment: found['--environment'] ?? 'test', output };
}

async function kubectl(context, args) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await exec('kubectl', ['--context', context, ...args], { maxBuffer: 20 * 1024 * 1024, timeout: 20000 });
      return stdout;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(200 * (attempt + 1));
    }
  }
  throw lastError;
}

async function podState(config) {
  if (!config.pod) return null;
  try {
    return JSON.parse(await kubectl(config.context, ['-n', config.pod.namespace, 'get', 'pod', config.pod.name, '-o', 'json']));
  } catch (error) {
    if (/NotFound|not found/i.test(String(error.stderr ?? error.message))) return null;
    throw error;
  }
}

async function nodeForPod(config) {
  const deadline = performance.now() + 60000;
  while (performance.now() < deadline) {
    const pod = await podState(config);
    if (pod?.spec?.nodeName) return pod.spec.nodeName;
    await sleep(250);
  }
  throw Error(`Pod ${config.pod.namespace}/${config.pod.name} was not scheduled within 60 seconds`);
}

function containerState(pod) {
  const state = pod?.status?.containerStatuses?.[0]?.state;
  return state ? Object.keys(state)[0] : null;
}

async function run() {
  const config = options(process.argv.slice(2));
  let node = config.node;
  if (!node && config.apply) {
    console.log(`Applying ${config.apply} in ${config.context}`);
    await kubectl(config.context, ['apply', '-f', config.apply]);
  }
  if (!node) node = await nodeForPod(config);
  const runId = randomUUID(), started = performance.now();
  let seq = 0, samples = 0, stopped = false, lastPhase = null, lastContainer = null, lastReady = false;
  mkdirSync(dirname(config.output), { recursive: true });
  const fd = openSync(config.output, 'wx');
  const writeRecord = (type, data) => {
    const record = { schema: NODE_SCHEMA, runId, seq: seq++, at: new Date().toISOString(), elapsedMs: Math.round((performance.now() - started) * 1000) / 1000, type, data };
    writeSync(fd, JSON.stringify(record) + '\n');
  };
  const onSignal = () => { stopped = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    writeRecord('metadata', { environment: config.environment, context: config.context, node, source: 'Kubelet stats/summary',
      ...(config.pod ? { namespace: config.pod.namespace, podName: config.pod.name } : {}) });
    const takeSample = async () => {
      const [summaryText, pod] = await Promise.all([
        kubectl(config.context, ['get', '--raw', `/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`]),
        podState(config),
      ]);
      if (pod?.spec?.nodeName && pod.spec.nodeName !== node) throw Error(`Target Pod is on ${pod.spec.nodeName}, but this recording samples ${node}`);
      const phase = pod?.status?.phase ?? null, state = containerState(pod);
      const ready = pod?.status?.conditions?.some(item => item.type === 'Ready' && item.status === 'True') ?? false;
      if (phase && phase !== lastPhase) { writeRecord('marker', { name: `Pod ${phase.toLowerCase()}` }); lastPhase = phase; }
      if (state && state !== lastContainer) { writeRecord('marker', { name: `Container ${state}` }); lastContainer = state; }
      if (ready && !lastReady) writeRecord('marker', { name: 'Pod ready' });
      lastReady = ready;
      const normalized = sampleFromKubeletSummary(JSON.parse(summaryText), config.pod ?? undefined);
      if (normalized.nodeName !== node) throw Error(`Kubelet answered for ${normalized.nodeName}, expected ${node}`);
      writeRecord('sample', normalized.sample);
      samples++;
    };
    // With a known node, capture a baseline before creating the Pod.
    await takeSample();
    if (config.apply && config.node) {
      console.log(`Applying ${config.apply} in ${config.context}`);
      await kubectl(config.context, ['apply', '-f', config.apply]);
    }
    const deadline = started + config.duration * 1000;
    while (!stopped && performance.now() < deadline) {
      const next = performance.now() + config.interval;
      await sleep(Math.max(0, next - performance.now()));
      if (!stopped) await takeSample();
    }
    writeRecord('end', { status: 'ok', ...(stopped ? { message: 'Stopped by signal' } : {}) });
    console.log(`Saved ${samples} node samples from ${node} to ${config.output}`);
  } catch (error) {
    writeRecord('end', { status: 'error', message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    closeSync(fd);
  }
}

try { await run(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
