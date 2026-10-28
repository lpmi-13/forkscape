/** Sampled EC2/EKS node counters. These never stand for individual pages or sockets. */
export const NODE_SCHEMA = 'forkscape.node.v1';
export const NODE_STORAGE_KEY = 'forkscape-node-capture';
export const MAX_NODE_BYTES = 10 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;

export interface NodeMetadata {
  environment: string;
  context: string;
  node: string;
  source: string;
  namespace?: string;
  podName?: string;
}

export interface NodeMetrics {
  cpuUsageNanoCores: number | null;
  memoryUsageBytes: number | null;
  memoryWorkingSetBytes: number | null;
  memoryRssBytes: number | null;
  memoryAvailableBytes: number | null;
  pageFaults: number | null;
  majorPageFaults: number | null;
  memoryPsiSomeAvg10: number | null;
  memoryPsiFullAvg10: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  fsUsedBytes: number | null;
  processCount: number | null;
  processLimit: number | null;
}

export interface PodMetrics {
  cpuUsageNanoCores: number | null;
  memoryWorkingSetBytes: number | null;
  memoryRssBytes: number | null;
  pageFaults: number | null;
  majorPageFaults: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
}

export interface NodeSample {
  /** Kubelet fields are refreshed independently; `at` on the envelope is the collector time. */
  sourceTimes: { cpu: string | null; memory: string | null; network: string | null };
  node: NodeMetrics;
  pod: PodMetrics | null;
}

export interface NodeMarker { name: string; detail?: string }
export interface NodeEnd { status: 'ok' | 'error'; message?: string }
export interface NodeEnvelope<T extends string, D> {
  schema: typeof NODE_SCHEMA;
  runId: string;
  seq: number;
  at: string;
  elapsedMs: number;
  type: T;
  data: D;
}
export type NodeRecord =
  | NodeEnvelope<'metadata', NodeMetadata>
  | NodeEnvelope<'sample', NodeSample>
  | NodeEnvelope<'marker', NodeMarker>
  | NodeEnvelope<'end', NodeEnd>;

export interface NodeCapture {
  runId: string;
  metadata: NodeMetadata;
  records: NodeRecord[];
  samples: NodeEnvelope<'sample', NodeSample>[];
  markers: NodeEnvelope<'marker', NodeMarker>[];
  end: NodeEnvelope<'end', NodeEnd> | null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function optionalObject(value: unknown, label: string): Record<string, unknown> | null {
  return value === undefined || value === null ? null : object(value, label);
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${label} must be a nonempty string`);
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : string(value, label);
}
function timestamp(value: unknown, label: string): string {
  const result = string(value, label);
  if (!Number.isFinite(Date.parse(result))) throw Error(`${label} must be an ISO timestamp`);
  return result;
}
function optionalTimestamp(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : timestamp(value, label);
}
function number(value: unknown, label: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || integer && !Number.isSafeInteger(value)) {
    throw Error(`${label} must be a nonnegative ${integer ? 'integer' : 'number'}`);
  }
  return value;
}
function nullableNumber(value: unknown, label: string, integer = true): number | null {
  return value === null ? null : number(value, label, integer);
}
function fromKubelet(value: unknown, label: string, integer = true): number | null {
  return value === undefined || value === null ? null : number(value, label, integer);
}

const nodeIntegerKeys = [
  'cpuUsageNanoCores', 'memoryUsageBytes', 'memoryWorkingSetBytes', 'memoryRssBytes', 'memoryAvailableBytes',
  'pageFaults', 'majorPageFaults', 'networkRxBytes', 'networkTxBytes', 'fsUsedBytes', 'processCount', 'processLimit',
] as const;
const podKeys = [
  'cpuUsageNanoCores', 'memoryWorkingSetBytes', 'memoryRssBytes', 'pageFaults', 'majorPageFaults',
  'networkRxBytes', 'networkTxBytes',
] as const;

function metrics(value: unknown): NodeMetrics {
  const raw = object(value, 'sample.node');
  const result = {} as NodeMetrics;
  for (const key of nodeIntegerKeys) result[key] = nullableNumber(raw[key], `sample.node.${key}`);
  result.memoryPsiSomeAvg10 = nullableNumber(raw.memoryPsiSomeAvg10, 'sample.node.memoryPsiSomeAvg10', false);
  result.memoryPsiFullAvg10 = nullableNumber(raw.memoryPsiFullAvg10, 'sample.node.memoryPsiFullAvg10', false);
  if (Object.values(result).every(item => item === null)) throw Error('sample.node has no measurements');
  return result;
}
function podMetrics(value: unknown): PodMetrics | null {
  if (value === null) return null;
  const raw = object(value, 'sample.pod');
  const result = {} as PodMetrics;
  for (const key of podKeys) result[key] = nullableNumber(raw[key], `sample.pod.${key}`);
  return result;
}

/** The first line identifies a node recording without parsing the entire time series. */
export function isNodeCaptureText(text: string): boolean {
  const first = text.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/, 1)[0];
  try {
    const schema = object(JSON.parse(first), 'record').schema;
    return typeof schema === 'string' && schema.startsWith('forkscape.node.');
  }
  catch { return false; }
}

/** A raw Kubelet stats/summary JSON object can be opened as one measured step. */
export function isKubeletSummaryText(text: string): boolean {
  if (!text.trimStart().startsWith('{')) return false;
  try {
    const raw = object(JSON.parse(text), 'summary');
    const node = optionalObject(raw.node, 'summary.node');
    return typeof node?.nodeName === 'string' && (node.cpu !== undefined || node.memory !== undefined);
  } catch { return false; }
}

export function decodeNodeRecord(value: unknown): NodeRecord {
  const raw = object(value, 'record');
  if (raw.schema !== NODE_SCHEMA) throw Error(`Unsupported node recording schema: ${String(raw.schema)}`);
  const base = {
    schema: NODE_SCHEMA as typeof NODE_SCHEMA,
    runId: string(raw.runId, 'runId'),
    seq: number(raw.seq, 'seq', true),
    at: timestamp(raw.at, 'at'),
    elapsedMs: number(raw.elapsedMs, 'elapsedMs'),
  };
  const data = object(raw.data, 'data');
  if (raw.type === 'metadata') {
    const metadata: NodeMetadata = {
      environment: string(data.environment, 'metadata.environment'),
      context: string(data.context, 'metadata.context'),
      node: string(data.node, 'metadata.node'),
      source: string(data.source, 'metadata.source'),
    };
    const namespace = optionalString(data.namespace, 'metadata.namespace');
    const podName = optionalString(data.podName, 'metadata.podName');
    if (Boolean(namespace) !== Boolean(podName)) throw Error('metadata.namespace and metadata.podName must appear together');
    if (namespace) metadata.namespace = namespace;
    if (podName) metadata.podName = podName;
    return { ...base, type: 'metadata', data: metadata };
  }
  if (raw.type === 'sample') {
    const times = object(data.sourceTimes, 'sample.sourceTimes');
    return { ...base, type: 'sample', data: {
      sourceTimes: {
        cpu: optionalTimestamp(times.cpu, 'sample.sourceTimes.cpu'),
        memory: optionalTimestamp(times.memory, 'sample.sourceTimes.memory'),
        network: optionalTimestamp(times.network, 'sample.sourceTimes.network'),
      },
      node: metrics(data.node),
      pod: podMetrics(data.pod),
    } };
  }
  if (raw.type === 'marker') {
    const marker: NodeMarker = { name: string(data.name, 'marker.name') };
    const detail = optionalString(data.detail, 'marker.detail');
    if (detail) marker.detail = detail;
    return { ...base, type: 'marker', data: marker };
  }
  if (raw.type === 'end') {
    if (data.status !== 'ok' && data.status !== 'error') throw Error('end.status must be ok or error');
    const end: NodeEnd = { status: data.status };
    const message = optionalString(data.message, 'end.message');
    if (message) end.message = message;
    return { ...base, type: 'end', data: end };
  }
  throw Error(`Unsupported node record type: ${String(raw.type)}`);
}

export class NodeCaptureAccumulator {
  private records: NodeRecord[] = [];
  private metadata: NodeEnvelope<'metadata', NodeMetadata> | null = null;
  private end: NodeEnvelope<'end', NodeEnd> | null = null;

  addLine(line: string): NodeRecord {
    if (new TextEncoder().encode(line).length > MAX_LINE_BYTES) throw Error('Node recording line exceeds 64 KiB');
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw Error('Node recording line is not JSON'); }
    const record = decodeNodeRecord(value);
    if (this.end) throw Error('Record after end');
    if (record.seq !== this.records.length) throw Error(`Expected sequence ${this.records.length}, got ${record.seq}`);
    if (this.metadata && record.runId !== this.metadata.runId) throw Error('Run ID changed');
    if (this.records.length && record.elapsedMs < this.records.at(-1)!.elapsedMs) throw Error('Elapsed time moved backwards');
    if (!this.metadata && record.type !== 'metadata') throw Error('First record must be metadata');
    if (this.metadata && record.type === 'metadata') throw Error('Duplicate metadata');
    if (record.type === 'metadata') this.metadata = record;
    if (record.type === 'end') this.end = record;
    this.records.push(record);
    return record;
  }

  snapshot(): NodeCapture {
    if (!this.metadata) throw Error('Node recording has no metadata');
    return {
      runId: this.metadata.runId,
      metadata: this.metadata.data,
      records: [...this.records],
      samples: this.records.filter((item): item is NodeEnvelope<'sample', NodeSample> => item.type === 'sample'),
      markers: this.records.filter((item): item is NodeEnvelope<'marker', NodeMarker> => item.type === 'marker'),
      end: this.end,
    };
  }
}

export function parseNodeCapture(text: string): NodeCapture {
  if (new TextEncoder().encode(text).length > MAX_NODE_BYTES) throw Error('Node recording exceeds 10 MiB');
  const accumulator = new NodeCaptureAccumulator();
  let lineNumber = 0;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    lineNumber++;
    if (!line.trim()) continue;
    try { accumulator.addLine(line); }
    catch (error) { throw Error(`Line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const capture = accumulator.snapshot();
  if (!capture.samples.length) throw Error('Node recording has no samples');
  return capture;
}

/** Delta per second; a reset or a missing counter is a gap rather than a negative rate. */
export function counterRate(samples: NodeCapture['samples'], index: number, key: 'pageFaults' | 'majorPageFaults' | 'networkRxBytes' | 'networkTxBytes'): number | null {
  if (index < 1 || index >= samples.length) return null;
  const before = samples[index - 1], after = samples[index];
  const prior = before.data.node[key], current = after.data.node[key];
  const clock = key === 'pageFaults' || key === 'majorPageFaults' ? 'memory' : 'network';
  const priorAt = before.data.sourceTimes[clock], currentAt = after.data.sourceTimes[clock];
  if (priorAt === null || currentAt === null) return null;
  const seconds = (Date.parse(currentAt) - Date.parse(priorAt)) / 1000;
  return prior === null || current === null || current < prior || seconds <= 0 ? null : (current - prior) / seconds;
}

function nested(parent: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return optionalObject(parent?.[key], key);
}

/** Normalize the small, useful subset of a Kubelet summary. No host privilege is required. */
export function sampleFromKubeletSummary(value: unknown, target?: { namespace: string; name: string }): { nodeName: string; sample: NodeSample } {
  const raw = object(value, 'Kubelet summary');
  const node = object(raw.node, 'Kubelet summary.node');
  const cpu = nested(node, 'cpu'), memory = nested(node, 'memory'), network = nested(node, 'network');
  const fs = nested(node, 'fs'), rlimit = nested(node, 'rlimit');
  const psi = nested(memory, 'psi');
  const some = nested(psi, 'some'), full = nested(psi, 'full');
  const nodeMetrics: NodeMetrics = {
    cpuUsageNanoCores: fromKubelet(cpu?.usageNanoCores, 'node.cpu.usageNanoCores'),
    memoryUsageBytes: fromKubelet(memory?.usageBytes, 'node.memory.usageBytes'),
    memoryWorkingSetBytes: fromKubelet(memory?.workingSetBytes, 'node.memory.workingSetBytes'),
    memoryRssBytes: fromKubelet(memory?.rssBytes, 'node.memory.rssBytes'),
    memoryAvailableBytes: fromKubelet(memory?.availableBytes, 'node.memory.availableBytes'),
    pageFaults: fromKubelet(memory?.pageFaults, 'node.memory.pageFaults'),
    majorPageFaults: fromKubelet(memory?.majorPageFaults, 'node.memory.majorPageFaults'),
    memoryPsiSomeAvg10: fromKubelet(some?.avg10, 'node.memory.psi.some.avg10', false),
    memoryPsiFullAvg10: fromKubelet(full?.avg10, 'node.memory.psi.full.avg10', false),
    networkRxBytes: fromKubelet(network?.rxBytes, 'node.network.rxBytes'),
    networkTxBytes: fromKubelet(network?.txBytes, 'node.network.txBytes'),
    fsUsedBytes: fromKubelet(fs?.usedBytes, 'node.fs.usedBytes'),
    processCount: fromKubelet(rlimit?.curproc, 'node.rlimit.curproc'),
    processLimit: fromKubelet(rlimit?.maxpid, 'node.rlimit.maxpid'),
  };
  if (Object.values(nodeMetrics).every(item => item === null)) throw Error('Kubelet summary contains no node measurements');
  let podMetrics: PodMetrics | null = null;
  if (target && Array.isArray(raw.pods)) {
    const pod = raw.pods.map(item => object(item, 'Kubelet summary.pod')).find(item => {
      const ref = optionalObject(item.podRef, 'podRef');
      return ref?.namespace === target.namespace && ref.name === target.name;
    });
    if (pod) {
      const podCpu = nested(pod, 'cpu'), podMemory = nested(pod, 'memory'), podNetwork = nested(pod, 'network');
      podMetrics = {
        cpuUsageNanoCores: fromKubelet(podCpu?.usageNanoCores, 'pod.cpu.usageNanoCores'),
        memoryWorkingSetBytes: fromKubelet(podMemory?.workingSetBytes, 'pod.memory.workingSetBytes'),
        memoryRssBytes: fromKubelet(podMemory?.rssBytes, 'pod.memory.rssBytes'),
        pageFaults: fromKubelet(podMemory?.pageFaults, 'pod.memory.pageFaults'),
        majorPageFaults: fromKubelet(podMemory?.majorPageFaults, 'pod.memory.majorPageFaults'),
        networkRxBytes: fromKubelet(podNetwork?.rxBytes, 'pod.network.rxBytes'),
        networkTxBytes: fromKubelet(podNetwork?.txBytes, 'pod.network.txBytes'),
      };
    }
  }
  return {
    nodeName: string(node.nodeName, 'node.nodeName'),
    sample: { sourceTimes: {
      cpu: optionalTimestamp(cpu?.time, 'node.cpu.time'),
      memory: optionalTimestamp(memory?.time, 'node.memory.time'),
      network: optionalTimestamp(network?.time, 'node.network.time'),
    }, node: nodeMetrics, pod: podMetrics },
  };
}

/** Let a dropped raw stats/summary file use the same view, with an honest one-sample label. */
export function fromRawKubeletSummary(text: string): string {
  const { nodeName, sample } = sampleFromKubeletSummary(JSON.parse(text));
  const now = sample.sourceTimes.memory ?? sample.sourceTimes.cpu ?? new Date().toISOString();
  const runId = `raw-kubelet-${nodeName}-${now}`;
  const base = { schema: NODE_SCHEMA, runId, at: now, elapsedMs: 0 };
  return [
    { ...base, seq: 0, type: 'metadata', data: { environment: 'unknown', context: 'raw Kubelet summary', node: nodeName, source: 'kubelet-summary' } },
    { ...base, seq: 1, type: 'sample', data: sample },
    { ...base, seq: 2, type: 'end', data: { status: 'ok' } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n';
}
