/** The file reader and a future live stream use the same incremental contract. */
export const CAPTURE_SCHEMA = 'forkscape.capture.v1';
export const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
export const CAPTURE_STORAGE_KEY = 'forkscape-measured-capture';
const MAX_LINE_BYTES = 64 * 1024;

/** Distinguish a sampled capture from the trace-event recordings loaded by the main app. */
export function isCaptureText(text: string): boolean {
  const firstLine = text.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/, 1)[0];
  try {
    const value: unknown = JSON.parse(firstLine);
    return value !== null && typeof value === 'object' && !Array.isArray(value) && 'schema' in value && value.schema === CAPTURE_SCHEMA;
  } catch { return false; }
}

export interface CaptureEnvelope<T extends string, D> {
  schema: typeof CAPTURE_SCHEMA;
  runId: string;
  seq: number;
  at: string;
  elapsedMs: number;
  type: T;
  data: D;
}

export interface CaptureMetadata {
  environment: string;
  workload: string;
  synthetic: boolean;
  /** A capture from a pod names it; one from a host or a plain container leaves these out and may name its host. */
  podName?: string;
  podUid?: string;
  namespace?: string;
  imageRef?: string;
  host?: string;
  kernel: string;
  architecture: string;
  python: string;
  pageSizeBytes: number;
  cgroupVersion: number;
}

export interface CaptureProcess {
  pid: number;
  ppid: number;
  startTicks: number;
  role: string;
  rssKiB: number | null;
  pssKiB: number | null;
  ussKiB: number | null;
  privateDirtyKiB: number | null;
  sharedDirtyKiB: number | null;
  vmPteKiB: number | null;
  minorFaults: number | null;
  majorFaults: number | null;
}

export interface CaptureSample {
  processes: CaptureProcess[];
  missingPids: number[];
  cgroup: {
    memoryCurrentBytes: number | null;
    memoryMaxBytes: number | null;
    oomCount: number | null;
    oomKillCount: number | null;
  };
  sampleDurationMs: number;
}

export interface CaptureMarker {
  name: string;
  pid: number;
  workerIndex?: number;
  bytes?: number;
}

export interface CaptureEnd {
  status: 'ok' | 'error';
  message?: string;
}

export type CaptureRecord =
  | CaptureEnvelope<'metadata', CaptureMetadata>
  | CaptureEnvelope<'marker', CaptureMarker>
  | CaptureEnvelope<'sample', CaptureSample>
  | CaptureEnvelope<'end', CaptureEnd>;

export interface Capture {
  runId: string;
  metadata: CaptureMetadata;
  records: CaptureRecord[];
  samples: CaptureEnvelope<'sample', CaptureSample>[];
  markers: CaptureEnvelope<'marker', CaptureMarker>[];
  end: CaptureEnvelope<'end', CaptureEnd> | null;
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${context} must be a nonempty string`);
  return value;
}
/** An optional field: absent or null, or else a nonempty string. */
function optionalString(value: unknown, context: string): string | undefined {
  return value === undefined || value === null ? undefined : string(value, context);
}
function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw Error(`${context} must be a boolean`);
  return value;
}
function number(value: unknown, context: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || integer && !Number.isSafeInteger(value)) {
    throw Error(`${context} must be a nonnegative ${integer ? 'integer' : 'number'}`);
  }
  return value;
}
function nullableNumber(value: unknown, context: string): number | null {
  return value === null ? null : number(value, context, true);
}
function process(value: unknown, index: number): CaptureProcess {
  const item = object(value, `process ${index}`);
  const role = string(item.role, `process ${index}.role`);
  return {
    pid: number(item.pid, `process ${index}.pid`, true),
    ppid: number(item.ppid, `process ${index}.ppid`, true),
    startTicks: number(item.startTicks, `process ${index}.startTicks`, true),
    role,
    rssKiB: nullableNumber(item.rssKiB, `process ${index}.rssKiB`),
    pssKiB: nullableNumber(item.pssKiB, `process ${index}.pssKiB`),
    ussKiB: nullableNumber(item.ussKiB, `process ${index}.ussKiB`),
    privateDirtyKiB: nullableNumber(item.privateDirtyKiB, `process ${index}.privateDirtyKiB`),
    sharedDirtyKiB: nullableNumber(item.sharedDirtyKiB, `process ${index}.sharedDirtyKiB`),
    vmPteKiB: nullableNumber(item.vmPteKiB, `process ${index}.vmPteKiB`),
    minorFaults: nullableNumber(item.minorFaults, `process ${index}.minorFaults`),
    majorFaults: nullableNumber(item.majorFaults, `process ${index}.majorFaults`),
  };
}

export function decodeCaptureRecord(value: unknown): CaptureRecord {
  const raw = object(value, 'record');
  if (raw.schema !== CAPTURE_SCHEMA) throw Error(`Unsupported capture schema: ${String(raw.schema)}`);
  const runId = string(raw.runId, 'runId');
  const seq = number(raw.seq, 'seq', true);
  const at = string(raw.at, 'at');
  if (!Number.isFinite(Date.parse(at))) throw Error('at must be an ISO timestamp');
  const elapsedMs = number(raw.elapsedMs, 'elapsedMs');
  const data = object(raw.data, 'data');
  const base = { schema: CAPTURE_SCHEMA as typeof CAPTURE_SCHEMA, runId, seq, at, elapsedMs };
  if (raw.type === 'metadata') {
    const metadata: CaptureMetadata = {
      environment: string(data.environment, 'metadata.environment'),
      workload: string(data.workload, 'metadata.workload'),
      synthetic: boolean(data.synthetic, 'metadata.synthetic'),
      kernel: string(data.kernel, 'metadata.kernel'),
      architecture: string(data.architecture, 'metadata.architecture'),
      python: string(data.python, 'metadata.python'),
      pageSizeBytes: number(data.pageSizeBytes, 'metadata.pageSizeBytes', true),
      cgroupVersion: number(data.cgroupVersion, 'metadata.cgroupVersion', true),
    };
    for (const key of ['podName', 'podUid', 'namespace', 'imageRef', 'host'] as const) {
      const value = optionalString(data[key], `metadata.${key}`);
      if (value !== undefined) metadata[key] = value;
    }
    return { ...base, type: 'metadata', data: metadata };
  }
  if (raw.type === 'marker') {
    const marker: CaptureMarker = { name: string(data.name, 'marker.name'), pid: number(data.pid, 'marker.pid', true) };
    if (data.workerIndex !== undefined) marker.workerIndex = number(data.workerIndex, 'marker.workerIndex', true);
    if (data.bytes !== undefined) marker.bytes = number(data.bytes, 'marker.bytes', true);
    return { ...base, type: 'marker', data: marker };
  }
  if (raw.type === 'sample') {
    if (!Array.isArray(data.processes) || !Array.isArray(data.missingPids)) throw Error('sample process lists must be arrays');
    const processes = data.processes.map(process);
    const identities = new Set(processes.map(item => `${item.pid}/${item.startTicks}`));
    if (identities.size !== processes.length) throw Error('sample contains a duplicate process identity');
    const group = object(data.cgroup, 'sample.cgroup');
    return { ...base, type: 'sample', data: {
      processes,
      missingPids: data.missingPids.map((item, index) => number(item, `missingPids[${index}]`, true)),
      cgroup: {
        memoryCurrentBytes: nullableNumber(group.memoryCurrentBytes, 'cgroup.memoryCurrentBytes'),
        memoryMaxBytes: nullableNumber(group.memoryMaxBytes, 'cgroup.memoryMaxBytes'),
        oomCount: nullableNumber(group.oomCount, 'cgroup.oomCount'),
        oomKillCount: nullableNumber(group.oomKillCount, 'cgroup.oomKillCount'),
      },
      sampleDurationMs: number(data.sampleDurationMs, 'sample.sampleDurationMs'),
    } };
  }
  if (raw.type === 'end') {
    if (data.status !== 'ok' && data.status !== 'error') throw Error('end.status must be ok or error');
    const end: CaptureEnd = { status: data.status };
    if (data.message !== undefined) end.message = string(data.message, 'end.message');
    return { ...base, type: 'end', data: end };
  }
  throw Error(`Unsupported capture record type: ${String(raw.type)}`);
}

/** Add one JSON line at a time; the same method works for file replay and SSE. */
export class CaptureAccumulator {
  private records: CaptureRecord[] = [];
  private metadata: CaptureEnvelope<'metadata', CaptureMetadata> | null = null;
  private end: CaptureEnvelope<'end', CaptureEnd> | null = null;

  addLine(line: string): CaptureRecord {
    if (new TextEncoder().encode(line).length > MAX_LINE_BYTES) throw Error('Capture line exceeds 64 KiB');
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw Error('Capture line is not JSON'); }
    const record = decodeCaptureRecord(value);
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

  snapshot(): Capture {
    if (!this.metadata) throw Error('Capture has no metadata');
    return {
      runId: this.metadata.runId,
      metadata: this.metadata.data,
      records: [...this.records],
      samples: this.records.filter((item): item is CaptureEnvelope<'sample', CaptureSample> => item.type === 'sample'),
      markers: this.records.filter((item): item is CaptureEnvelope<'marker', CaptureMarker> => item.type === 'marker'),
      end: this.end,
    };
  }
}

export function parseCapture(text: string): Capture {
  if (new TextEncoder().encode(text).length > MAX_CAPTURE_BYTES) throw Error('Capture exceeds 10 MiB');
  const accumulator = new CaptureAccumulator();
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { accumulator.addLine(line); } catch (error) {
      throw Error(`Line ${++count}: ${error instanceof Error ? error.message : String(error)}`);
    }
    count++;
  }
  const capture = accumulator.snapshot();
  if (!capture.samples.length) throw Error('Capture has no samples');
  return capture;
}
